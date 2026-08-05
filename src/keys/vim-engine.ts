import { getError, inject } from '@venizia/ignis-inversion';

import { BindingKeys } from '../common/index.ts';
import { ActionTypes, Operators, UNNAMED_REGISTER, VimContexts, VimModes } from './common/index.ts';
import type {
  IEngineState,
  IKey,
  IKeyBinding,
  IResolveResult,
  TAction,
  TCursorUnit,
  TOperator,
  TVimContext,
  TVimMode,
} from './common/index.ts';
import { parseKeySequence, type KeyNormalizerService } from './key-normalizer.ts';

const DIGIT_PATTERN = /^[0-9]$/;
/** A register name (M1b-2 Task 5): a single lowercase letter, or `+` for the system clipboard (Task 6's write). */
const REGISTER_NAME_PATTERN = /^[a-z+]$/;
/** `.`, vim's own repeat key (M1b-2 Task 7) -- re-emits `state.lastChange`. */
const REPEAT_TRIGGER = '.';

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

  /**
   * `state.lastChange`, updated whenever `actions` contains an OPERATOR_APPLY
   * -- an operator actually applying, whatever produced it: a literal keymap
   * binding (dd, via applyStateActions below), the doubled-trigger branch, or
   * a motion (both in resolveUnderOperator, further down). A motion alone
   * never reaches here carrying such an action -- CURSOR_MOVE/CURSOR_EDGE are
   * never bundled with an OPERATOR_APPLY -- which is what keeps `.` (M1b-2
   * Task 7) from repeating mere cursor movement. Shared by all three commit
   * points so they cannot drift on what "an operator applied" means, the same
   * reason isMessagesNormalMode is shared rather than copied per Task 5.
   */
  private recordChange = (opts: { state: IEngineState; actions: TAction[]; step?: number }): IEngineState => {
    const { state, actions, step } = opts;
    const applied = actions.some(action => action.type === ActionTypes.OPERATOR_APPLY);
    // Defaults to 0 -- the doubled form's own meaning -- for the keymap-driven
    // commit point (dd via applyStateActions), which names no motion.
    return applied ? { ...state, lastChange: { actions, step: step ?? 0 } } : state;
  };

  private applyStateActions = (opts: { state: IEngineState; binding: IKeyBinding; count: number }): {
    state: IEngineState;
    actions: IResolveResult['actions'];
  } => {
    const { binding, count } = opts;
    // A binding's own action() knows nothing about registers, so the pending
    // name is stamped on here. Without it `dd` -- which is a real keymap
    // binding, not the intrinsic doubled form the engine's own branch handles
    // -- would record a lastChange carrying no register, and `"add` then `.`
    // would fall back to the unnamed one. The original `"add` still worked
    // either way, because the reducer can read the name off ambient engine
    // state; only the repeat, which has nothing typed before it, could not.
    const actions = binding.action(count).map(action => (
      action.type === ActionTypes.OPERATOR_APPLY ? { ...action, register: opts.state.register } : action
    ));
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

    // M1b-2 Task 7: dd is the one binding in the real keymap whose action()
    // includes an OPERATOR_APPLY, so this is where its own lastChange gets
    // recorded; recordChange itself is shared with resolveUnderOperator's two
    // OPERATOR_APPLY branches below, so a future binding that also resolves
    // through here picks up dot-repeat for free rather than needing its own copy.
    state = this.recordChange({ state, actions });

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
      const actions: TAction[] = [{
        type: ActionTypes.OPERATOR_APPLY, operator, unit: 'message', from: 0, to: count - 1,
        register: state.register,
      }];
      return {
        // step 0: dd's count is a message total, so `3.` spans three.
        state: this.recordChange({
          state: { ...state, operator: null, operatorCount: null, pending: [], count: null, register: null },
          actions,
          step: 0,
        }),
        actions,
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
    const actions: TAction[] = [{
      type: ActionTypes.OPERATOR_APPLY, operator, unit: motion.unit, from, to,
      register: state.register,
    }];
    return {
      // The motion's direction, not its magnitude: d2j and dj both step +1, so
      // `3.` after either is 3dj. The count is replaced, the motion kept.
      state: this.recordChange({
        state: { ...state, operator: null, operatorCount: null, pending: [], count: null, register: null },
        actions,
        step: Math.sign(motion.delta),
      }),
      actions,
      status: 'resolved',
    };
  };

  /**
   * A freshly typed count replaces whatever count produced the recorded
   * OPERATOR_APPLY, rather than multiplying against it (M1b-2 Task 7's own
   * headline: 2dd then 3. repeats as 3dd, not 6dd). Expressed the same way
   * the doubled trigger itself computes an unqualified count's extent
   * (resolveUnderOperator's own OPERATOR_TRIGGERS[token] === operator branch
   * above: from 0, to count - 1) -- "count whole messages from the cursor" --
   * since that is the only shape a bare count-and-repeat can unambiguously
   * mean once whatever motion (if any) produced the original range is gone.
   * Only from/to change: a motion's own direction (dk's upward range, say)
   * is not reconstructed, deliberately -- see task-7-report.md.
   */
  private substituteCount = (opts: { actions: TAction[]; count: number; step: number }): TAction[] => {
    const { actions, count, step } = opts;
    return actions.map(action => {
      if (action.type !== ActionTypes.OPERATOR_APPLY) {
        return action;
      }
      // Upward: the range runs from `count` above the cursor down to it, so
      // `3.` after dk spans four messages the way nvim's own 3dk does.
      if (step < 0) {
        return { ...action, from: -count, to: 0 };
      }
      // Downward: the cursor plus `count` more, mirroring the above.
      if (step > 0) {
        return { ...action, from: 0, to: count };
      }
      // The doubled form: count is the message total itself.
      return { ...action, from: 0, to: count - 1 };
    });
  };

  /**
   * `.`, vim's own repeat (M1b-2 Task 7): re-emits `state.lastChange`
   * verbatim, or with a freshly typed count substituted in. `state.lastChange`
   * is only ever the actions from a resolved OPERATOR_APPLY (recordChange's
   * own gate above), and OPERATOR_APPLY's own from/to are already
   * cursor-relative deltas -- the same reason a motion's own delta is (see
   * resolveMotion's doc comment) -- so replaying them unchanged is what makes
   * `.` act on the message now under the cursor rather than the one the
   * original operator targeted, with no special handling needed here for
   * that alone.
   *
   * Always 'resolved', never 'pending': there is no further key to wait for,
   * and app.tsx's commitResolution only ever runs a result's actions when
   * status is 'resolved' -- M1b-2 Task 5 found this the hard way for
   * REGISTER_SET, and the same trap applies here.
   */
  private resolveRepeat = (opts: { state: IEngineState }): IResolveResult => {
    const { state } = opts;
    const resetState: IEngineState = { ...state, pending: [], count: null, register: null };

    if (state.lastChange === null) {
      return { state: resetState, actions: [], status: 'resolved' };
    }

    const { actions: recorded, step } = state.lastChange;
    const counted = state.count === null
      ? recorded
      : this.substituteCount({ actions: recorded, count: state.count, step });

    // A register named for the repeat itself wins: `"b.` is a new
    // specification, not a replay of the old one. With none typed, the
    // recorded name rides along on the action -- nvim replays it, so `"add`
    // then `.` writes to a again rather than falling back to the unnamed
    // register.
    const actions = state.register === null
      ? counted
      : counted.map(action => (
        action.type === ActionTypes.OPERATOR_APPLY ? { ...action, register: state.register } : action
      ));

    return { state: { ...resetState, lastChange: { actions, step } }, actions, status: 'resolved' };
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

      // `.`, repeat's own trigger (M1b-2 Task 7): engine-intrinsic and gated
      // the same way, for the same two reasons -- messages-pane-only so `.`
      // cannot act on a cursor it does not share (M1b-1's own rule, which
      // operators and registers already preserve), and NORMAL-mode-only so a
      // literal "." typed at the end of a composed message still reaches
      // app.tsx's ordinary printable-character flushing instead of being
      // swallowed here. Unlike `"`, this resolves immediately rather than
      // entering pending -- there is no name to wait for, only lastChange to
      // (maybe) re-emit -- so it delegates straight to resolveRepeat.
      if (token === REPEAT_TRIGGER && this.isMessagesNormalMode({ state })) {
        return this.resolveRepeat({ state });
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
