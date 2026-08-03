import { getError, inject } from '@venizia/ignis-inversion';

import { BindingKeys } from '../common/index.ts';
import { ActionTypes, Operators, VimContexts, VimModes } from './common/index.ts';
import type {
  IEngineState,
  IKey,
  IKeyBinding,
  IResolveResult,
  TCursorUnit,
  TOperator,
  TVimContext,
  TVimMode,
} from './common/index.ts';
import { parseKeySequence, type KeyNormalizerService } from './key-normalizer.ts';

const DIGIT_PATTERN = /^[0-9]$/;

/**
 * `d`/`y`/`c` are operator triggers in their own right, exactly like
 * DIGIT_PATTERN above: engine-intrinsic, needing no keymap entry, so a real
 * `dd` binding still makes a bare `d` genuinely ambiguous (resolve()'s own
 * operator branches below) the same way any two competing keymap entries
 * would -- no special-casing of keymap.ts required.
 */
const OPERATOR_TRIGGERS: Readonly<Record<string, TOperator>> = {
  d: Operators.DELETE,
  y: Operators.YANK,
  c: Operators.CHANGE,
};

/**
 * The vim layer, expressed as a deterministic fold over key presses. No I/O, no
 * clock, no mutation: the same state and key always produce the same actions,
 * which is what makes counts, prefixes and mode transitions exhaustively testable.
 */
export class VimEngineService {
  constructor(
    @inject({ key: BindingKeys.KEY_NORMALIZER })
    private readonly _keyNormalizer: KeyNormalizerService,
  ) {}

  private matchesMode = (opts: { binding: IKeyBinding; mode: TVimMode }): boolean => {
    const { binding, mode } = opts;
    if (Array.isArray(binding.mode)) {
      return binding.mode.includes(mode);
    }
    return binding.mode === mode;
  };

  private matchesContext = (opts: { binding: IKeyBinding; context: TVimContext }): boolean => {
    return opts.binding.context === '*' || opts.binding.context === opts.context;
  };

  private tokensMatch = (opts: { bindingTokens: string[]; sequence: string[] }): boolean => {
    const { bindingTokens, sequence } = opts;
    return bindingTokens.length === sequence.length && bindingTokens.every((token, index) => token === sequence[index]);
  };

  private isPrefixOfBinding = (opts: { bindingTokens: string[]; sequence: string[] }): boolean => {
    const { bindingTokens, sequence } = opts;
    return bindingTokens.length > sequence.length && sequence.every((token, index) => token === bindingTokens[index]);
  };

  private accumulateCount = (opts: { state: IEngineState; token: string }): IEngineState | null => {
    const { state, token } = opts;

    const countable = state.mode === VimModes.NORMAL || state.mode === VimModes.VISUAL;
    if (!countable || state.pending.length !== 0) {
      return null;
    }
    if (!DIGIT_PATTERN.test(token)) {
      return null;
    }
    // A leading 0 is the line-start motion in vim, never the start of a count.
    if (token === '0' && state.count === null) {
      return null;
    }

    return { ...state, count: (state.count ?? 0) * 10 + Number(token) };
  };

  private applyStateActions = (opts: { state: IEngineState; binding: IKeyBinding; count: number }): {
    state: IEngineState;
    actions: IResolveResult['actions'];
  } => {
    const { binding, count } = opts;
    const actions = binding.action(count);
    let state: IEngineState = { ...opts.state, pending: [], count: null };

    for (const action of actions) {
      switch (action.type) {
        case ActionTypes.MODE_SET: {
          state = { ...state, mode: action.mode };
          break;
        }
        case ActionTypes.FOCUS_SET: {
          state = { ...state, context: action.context };
          break;
        }
        default: {
          // Every other action is state the reducer owns, not the engine.
          break;
        }
      }
    }

    return { state, actions };
  };

  private findCandidates = (opts: { state: IEngineState; keymap: IKeyBinding[] }): IKeyBinding[] => {
    const { state, keymap } = opts;
    return keymap.filter(binding => {
      return (
        this.matchesMode({ binding, mode: state.mode }) &&
        this.matchesContext({ binding, context: state.context })
      );
    });
  };

  // A context-specific binding beats a wildcard one for the same keys, so
  // `j` in the chat list moves the chat cursor rather than the message cursor.
  // Without this, resolution depends on keymap declaration order.
  //
  // Matching compares whole token sequences, not raw strings: a binding's
  // `keys` field is authored as a compact string ("gg", "<escape>") but
  // parseKeySequence splits it back into the tokens it represents first.
  // A typed "<" is one token; "<escape>" parses to one different token; the
  // two can never equal or prefix each other regardless of which
  // characters either contains. Comparing raw strings instead (as this did
  // before) makes "<" a string-level prefix of every bracketed binding.
  //
  // Shared by resolve (sequence = pending + the just-typed token) and
  // flushPending (sequence = pending alone, since no key arrived) so the two
  // can never disagree about what counts as an exact match.
  private findExactMatch = (opts: { candidates: IKeyBinding[]; sequence: string[] }): IKeyBinding | undefined => {
    const { candidates, sequence } = opts;
    return (
      candidates.find(binding => {
        return this.tokensMatch({ bindingTokens: parseKeySequence(binding.keys), sequence }) && binding.context !== '*';
      }) ??
      candidates.find(binding => this.tokensMatch({ bindingTokens: parseKeySequence(binding.keys), sequence }))
    );
  };

  /**
   * Whether `token` may start an operator right now -- NORMAL mode, and the
   * messages pane, only. Visual-mode operators act on the selection
   * directly in real vim rather than waiting for a motion, and this engine
   * has no selection state to act on, so operator entry does not extend
   * accumulateCount's own NORMAL-or-VISUAL gate above.
   *
   * The context half is M1b-1's Minor finding, closed here: `d`/`y`/`c`
   * commit with no keymap entry of their own (OPERATOR_TRIGGERS below), so
   * unlike an ordinary binding there is no `context` field anywhere else
   * that could filter them by pane. Without this gate, `dd` while focused on
   * the chat list asked to delete a message in the messages pane the cursor
   * was not even in -- exactly the bug the doubled forms this task adds make
   * more reachable, not less.
   */
  private operatorForToken = (opts: { state: IEngineState; token: string }): TOperator | null => {
    const { state, token } = opts;
    if (state.mode !== VimModes.NORMAL || state.context !== VimContexts.MESSAGES) {
      return null;
    }
    return OPERATOR_TRIGGERS[token] ?? null;
  };

  /**
   * Whether `token`, alone, is bound to a single ordinary CURSOR_MOVE --
   * the only shape this engine accepts as an operator's motion. Anything
   * else (unbound, a compound action, CURSOR_EDGE, mode changes, ...) is
   * not a motion as far as an operator is concerned, deliberately: `from`/
   * `to` are relative to a cursor position the engine itself never sees
   * (IApplicationState.messageCursor, not IEngineState), which a linear
   * delta can express and an absolute edge like "last message" cannot.
   */
  private resolveMotion = (opts: {
    state: IEngineState; token: string; keymap: IKeyBinding[]; count: number;
  }): { delta: number; unit: TCursorUnit } | null => {
    const { state, token, keymap, count } = opts;
    const candidates = this.findCandidates({ state, keymap });
    const exact = this.findExactMatch({ candidates, sequence: [token] });
    if (!exact) {
      return null;
    }

    const actions = exact.action(count);
    if (actions.length !== 1) {
      return null;
    }

    const [action] = actions;
    if (action.type !== ActionTypes.CURSOR_MOVE) {
      return null;
    }

    return { delta: action.delta, unit: action.unit };
  };

  /**
   * `state.operator` is already committed; `token` is whatever key arrived
   * next. A motion converts it into a single OPERATOR_APPLY and clears the
   * operator; anything else -- escape, an unbound key, one bound to
   * something that is not a plain motion -- cancels it instead of acting,
   * vim's own rule for operator-pending.
   */
  private resolveUnderOperator = (opts: {
    state: IEngineState; operator: TOperator; token: string; keymap: IKeyBinding[];
  }): IResolveResult => {
    const { state, operator, token, keymap } = opts;
    const count = (state.operatorCount ?? 1) * (state.count ?? 1);

    // The doubled form (dd/yy/cc): the operator's own trigger, typed again,
    // names no motion at all -- vim's own idiom for "count whole messages
    // starting at the cursor". Checked ahead of resolveMotion, which could
    // never find it anyway: d/y/c are engine-intrinsic (OPERATOR_TRIGGERS),
    // not a keymap entry resolveMotion's single-token lookup could match.
    // `count` is spent once, directly, exactly as an ordinary motion spends
    // it -- multiplying it again here is the trap that would make 2dd
    // delete four messages instead of two.
    if (OPERATOR_TRIGGERS[token] === operator) {
      return {
        state: { ...state, operator: null, operatorCount: null, pending: [], count: null },
        actions: [{ type: ActionTypes.OPERATOR_APPLY, operator, unit: 'message', from: 0, to: count - 1 }],
        status: 'resolved',
      };
    }

    const motion = this.resolveMotion({ state, token, keymap, count });

    if (!motion) {
      return {
        state: { ...state, operator: null, operatorCount: null, pending: [], count: null },
        actions: [],
        status: 'unmapped',
      };
    }

    // Relative to the cursor, which the engine does not itself know -- the
    // same reason CURSOR_MOVE carries a delta rather than a destination.
    // `to` is the motion's own delta; `from` is 0 unless the motion runs
    // backward (k), in which case the range spans the message above
    // through the cursor rather than the cursor down to nothing.
    const from = Math.min(0, motion.delta);
    const to = Math.max(0, motion.delta);
    return {
      state: { ...state, operator: null, operatorCount: null, pending: [], count: null },
      actions: [{ type: ActionTypes.OPERATOR_APPLY, operator, unit: motion.unit, from, to }],
      status: 'resolved',
    };
  };

  resolve = (opts: { state: IEngineState; key: IKey; keymap: IKeyBinding[] }): IResolveResult => {
    const { state, key, keymap } = opts;

    if (keymap.length === 0) {
      throw getError({ message: '[VimEngineService][resolve] Empty keymap provided' });
    }

    const token = this._keyNormalizer.toCanonicalString({ key });

    const counted = this.accumulateCount({ state, token });
    if (counted) {
      return { state: counted, actions: [], status: 'pending' };
    }

    // A live operator waits for a motion, not for the ordinary keymap
    // resolution below -- a key that is not a motion cancels it
    // (resolveUnderOperator), it does not run whatever it would otherwise.
    if (state.operator !== null) {
      return this.resolveUnderOperator({ state, operator: state.operator, token, keymap });
    }

    const candidates = this.findCandidates({ state, keymap });
    const sequence: string[] = [...state.pending, token];

    const exact = this.findExactMatch({ candidates, sequence });
    const isPrefix = candidates.some(binding => {
      return this.isPrefixOfBinding({ bindingTokens: parseKeySequence(binding.keys), sequence });
    });

    // Both true means this sequence is a live binding in its own right *and*
    // the start of a longer one -- vim's own operator-pending case (`d` vs
    // `dd`). Resolving early here is what made the longer binding
    // unreachable; reporting the ambiguity and keeping the tokens pending
    // lets the next key complete `dd` while flushPending stays able to
    // resolve the shorter `d` if nothing more comes.
    if (exact && isPrefix) {
      return { state: { ...state, pending: sequence }, actions: [], status: 'ambiguous' };
    }

    if (exact) {
      const applied = this.applyStateActions({ state, binding: exact, count: state.count ?? 1 });
      return { state: applied.state, actions: applied.actions, status: 'resolved' };
    }

    // A deferred operator: the previous key was a trigger sitting next to a
    // real binding that could still have completed (`d` beside a real `dd`,
    // the case just above). The search above, over the combined sequence,
    // found neither an exact match nor a prefix, so that real binding did
    // not extend -- the operator commits now, and this same key is
    // re-resolved under it. Recursing rather than calling
    // resolveUnderOperator directly so a digit here still goes through
    // accumulateCount above instead of being treated as a bogus motion (the
    // `d3j`/`3dj` tests below must reach the same range either way).
    if (state.pending.length === 1 && !isPrefix) {
      const deferredOperator = this.operatorForToken({ state, token: state.pending[0] });
      if (deferredOperator) {
        return this.resolve({
          state: { ...state, operator: deferredOperator, operatorCount: state.count, count: null, pending: [] },
          key,
          keymap,
        });
      }
    }

    // A fresh operator trigger (`d`/`y`/`c`): engine-intrinsic, like a digit
    // above, so it needs no keymap entry of its own. isPrefix already
    // covers a real binding that also starts with this token (a real `dd`)
    // -- that case defers exactly like the ambiguous branch above, not
    // committing until the next key or a timeout settles it. Any count
    // already typed (the 2 in 2d3j) becomes the operator's own count,
    // remembered in operatorCount rather than count so a motion's own count
    // multiplies against it instead of the two colliding in one field.
    if (state.pending.length === 0) {
      const freshOperator = this.operatorForToken({ state, token });
      if (freshOperator) {
        if (isPrefix) {
          return { state: { ...state, pending: sequence }, actions: [], status: 'ambiguous' };
        }
        return {
          state: { ...state, operator: freshOperator, operatorCount: state.count, count: null },
          actions: [],
          status: 'pending',
        };
      }
    }

    if (isPrefix) {
      return { state: { ...state, pending: sequence }, actions: [], status: 'pending' };
    }

    return { state: { ...state, pending: [], count: null }, actions: [], status: 'unmapped' };
  };

  /**
   * The timer's way of saying "nothing more is coming" -- called on
   * `timeoutlen` expiry, never on a key press, so it takes no `key` and
   * consults only `state.pending`. Resolves the shorter binding an
   * `ambiguous` result left pending, or clears a prefix that never became
   * one. Pure like `resolve`: no timer lives here, only the decision of what
   * a timeout means once App's has already fired.
   */
  flushPending = (opts: { state: IEngineState; keymap: IKeyBinding[] }): IResolveResult => {
    const { state, keymap } = opts;

    if (state.pending.length === 0) {
      return { state, actions: [], status: 'unmapped' };
    }

    const candidates = this.findCandidates({ state, keymap });
    const exact = this.findExactMatch({ candidates, sequence: state.pending });

    if (exact) {
      const applied = this.applyStateActions({ state, binding: exact, count: state.count ?? 1 });
      return { state: applied.state, actions: applied.actions, status: 'resolved' };
    }

    // The same deferred-operator fallback resolve() applies above: no real
    // binding completed, but the sole pending token may still be an
    // operator trigger in its own right. The timer carries no key to feed
    // it as a motion the way resolve() can -- it commits the operator and
    // goes on waiting, exactly as "d alone" does in real vim.
    if (state.pending.length === 1) {
      const operator = this.operatorForToken({ state, token: state.pending[0] });
      if (operator) {
        return {
          state: { ...state, operator, operatorCount: state.count, count: null, pending: [] },
          actions: [],
          status: 'pending',
        };
      }
    }

    return { state: { ...state, pending: [], count: null }, actions: [], status: 'unmapped' };
  };
}
