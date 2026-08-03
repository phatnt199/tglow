import { getError, inject } from '@venizia/ignis-inversion';

import { BindingKeys } from '../common/index.ts';
import { ActionTypes, VimModes } from './common/index.ts';
import type {
  IEngineState,
  IKey,
  IKeyBinding,
  IResolveResult,
  TVimContext,
  TVimMode,
} from './common/index.ts';
import { parseKeySequence, type KeyNormalizerService } from './key-normalizer.ts';

const DIGIT_PATTERN = /^[0-9]$/;

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

    return { state: { ...state, pending: [], count: null }, actions: [], status: 'unmapped' };
  };
}
