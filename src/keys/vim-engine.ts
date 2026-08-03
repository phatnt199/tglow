import { getError, inject } from '@venizia/ignis-inversion';

import { BindingKeys } from '../common/index.ts';
import { ActionTypes, Operators, UNNAMED_REGISTER, VimContexts, VimModes } from './common/index.ts';
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
/** A register name (M1b-2 Task 5): a single lowercase letter, or `+` for the system clipboard (Task 6's write). */
const REGISTER_NAME_PATTERN = /^[a-z+]$/;

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
    // Resolving any binding consumes whatever sequence was being assembled
    // toward it -- pending/count already worked this way; register (M1b-2
    // Task 5) joins them for the same reason: a name survives only through
    // to the operation it names, not into whatever ordinary key happens to
    // resolve next. dd is the one binding here that actually reads it
    // (action-reducer.ts, via state.engine.register, read from the store
    // snapshot captured before this reset lands -- see app.tsx's
    // commitResolution) -- every other binding simply abandons an
    // unconsumed one.
    let state: IEngineState = { ...opts.state, pending: [], count: null, register: null };

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
   * NORMAL mode, the messages pane, only -- the one gate every
   * engine-intrinsic trigger shares: `d`/`y`/`c` (operatorForToken below)
   * and, as of M1b-2 Task 5, `"` (register-pending, in resolve() itself).
   * None of them has a keymap entry of its own with a `context` field to
   * filter by pane, so resolve() has to do the filtering here or a trigger
   * commits from a pane its cursor is not even in -- M1b-1's Minor finding
   * on `dd`, which the doubled forms and now registers make more reachable,
   * not less. NORMAL only, not VISUAL: real vim's visual-mode operators act
   * on the selection directly rather than waiting for a motion, and this
   * engine has no selection state to act on, so this does not extend
   * accumulateCount's own NORMAL-or-VISUAL gate above.
   */
  private isMessagesNormalMode = (opts: { state: IEngineState }): boolean => {
    const { state } = opts;
    return state.mode === VimModes.NORMAL && state.context === VimContexts.MESSAGES;
  };

  /** The operator `token` triggers right now, or null outside isMessagesNormalMode's gate above. */
  private operatorForToken = (opts: { state: IEngineState; token: string }): TOperator | null => {
    const { state, token } = opts;
    if (!this.isMessagesNormalMode({ state })) {
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
    // Every branch below is where an operator's operation actually commits
    // or is abandoned, so register (M1b-2 Task 5) resets alongside
    // operator/operatorCount/pending/count in all three: a name is spent
    // the instant the operator it was naming either applies or cancels, not
    // carried into whatever comes next. action-reducer.ts reads
    // state.engine.register from the store snapshot captured before this
    // reset lands (app.tsx's commitResolution), so clearing it here does not
    // race the read.
    if (OPERATOR_TRIGGERS[token] === operator) {
      return {
        state: { ...state, operator: null, operatorCount: null, pending: [], count: null, register: null },
        actions: [{ type: ActionTypes.OPERATOR_APPLY, operator, unit: 'message', from: 0, to: count - 1 }],
        status: 'resolved',
      };
    }

    const motion = this.resolveMotion({ state, token, keymap, count });

    if (!motion) {
      return {
        state: { ...state, operator: null, operatorCount: null, pending: [], count: null, register: null },
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
      state: { ...state, operator: null, operatorCount: null, pending: [], count: null, register: null },
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

    if (state.pending.length === 1 && !isPrefix) {
      // The register's own name key (M1b-2 Task 5), consumed the instant it
      // arrives: the previous key was `"` (its own pending-entry branch
      // below), so this one names the register rather than meaning whatever
      // it ordinarily would (a bare `a` otherwise opens the composer). No
      // keymap binding starts with `"`, so exact/isPrefix above can never
      // fire for this sequence regardless of what token is -- unlike the
      // deferred-operator case just below, there is no real binding this
      // could still turn out to be, so there is nothing to defer to.
      // 'resolved', not 'pending': REGISTER_SET is a real action, and
      // app.tsx only ever runs a result's actions when status is 'resolved'
      // (commitResolution) -- 'pending' would silently drop it.
      if (state.pending[0] === UNNAMED_REGISTER) {
        if (REGISTER_NAME_PATTERN.test(token)) {
          return {
            state: { ...state, register: token, pending: [] },
            actions: [{ type: ActionTypes.REGISTER_SET, name: token }],
            status: 'resolved',
          };
        }
        // Reject rather than store under a junk name (the brief's own
        // words) -- and unlike the deferred-operator recursion below, this
        // key is not replayed as anything else either: real vim's register
        // prefix commits the very next keystroke to naming a register,
        // valid or not, so a digit or <escape> here cancels the whole
        // attempt instead of also being read as a fresh count or command.
        return { state: { ...state, pending: [], count: null, register: null }, actions: [], status: 'unmapped' };
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

      // `"`, register-pending's own trigger (M1b-2 Task 5): engine-intrinsic
      // and gated by the same isMessagesNormalMode check operatorForToken
      // uses, but unlike d/y/c, no keymap binding anywhere starts with `"` --
      // entering register-pending can never be ambiguous the way a bare `d`
      // is against a real `dd`, so this always goes straight to 'pending',
      // with nothing to defer to and no timeout race to report.
      if (token === UNNAMED_REGISTER && this.isMessagesNormalMode({ state })) {
        return { state: { ...state, pending: sequence }, actions: [], status: 'pending' };
      }
    }

    if (isPrefix) {
      return { state: { ...state, pending: sequence }, actions: [], status: 'pending' };
    }

    return { state: { ...state, pending: [], count: null, register: null }, actions: [], status: 'unmapped' };
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

    return { state: { ...state, pending: [], count: null, register: null }, actions: [], status: 'unmapped' };
  };
}
