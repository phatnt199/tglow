import { parseKeySequence } from './key-normalizer.ts';

/**
 * What the which-key popup should show, given what has been typed so far.
 *
 * The popup listed all forty-five bindings whatever was pending, which is the
 * one thing which-key exists not to do -- and in practice it could not even be
 * *reached* with a prefix pending, because `\` after `<C-w>` completes
 * `<C-w>\` and after `g` or `z` it is unmapped and clears the prefix. So this
 * pairs with App opening the popup by itself once a prefix has sat unfinished
 * for timeoutlen; without that, filtering here would be unreachable code.
 *
 * Pure, and in the keys layer rather than the component, because deciding
 * which bindings continue `<C-w>` is a fact about the keymap and not about
 * how it is drawn.
 */

export interface IWhichKeyEntry {
  /** What is left to press, with the part already typed removed. */
  keys: string;
  description: string;
}

export interface IWhichKeyMenu {
  /** What has been typed, as it should be shown. Empty when nothing is pending. */
  prefix: string;
  entries: IWhichKeyEntry[];
}

/**
 * Whether `tokens` begins with `prefix`, compared token by token.
 *
 * Never as strings: `<escape>` is one token however many characters it takes
 * to write, and a typed `<` is a different token that string comparison would
 * happily call a prefix of it. The same trap key-normalizer's own
 * parseKeySequence exists to avoid.
 */
const startsWith = (opts: { tokens: readonly string[]; prefix: readonly string[] }): boolean =>
  opts.prefix.every((token, index) => opts.tokens[index] === token);

export const resolveWhichKeyMenu = (opts: {
  bindings: readonly IWhichKeyEntry[];
  /** IEngineState.pending: canonical tokens, in order. */
  pending: readonly string[];
}): IWhichKeyMenu => {
  const prefix = opts.pending;
  if (prefix.length === 0) {
    return { prefix: '', entries: [...opts.bindings] };
  }

  const entries = opts.bindings.flatMap(binding => {
    const tokens = parseKeySequence(binding.keys);
    // Strictly longer: a binding equal to the prefix has nothing left to
    // press, so listing it would offer a key that completes nothing.
    if (tokens.length <= prefix.length || !startsWith({ tokens, prefix })) {
      return [];
    }
    return [{ keys: tokens.slice(prefix.length).join(''), description: binding.description }];
  });

  return { prefix: prefix.join(''), entries };
};

/**
 * What to say when a prefix leads nowhere.
 *
 * An empty popup is worse than no popup: it looks like a rendering fault
 * rather than an answer. This cannot happen for a prefix the engine is holding
 * -- it only holds one that some binding continues -- but the popup is also
 * opened by hand, and a keymap edit could leave a dangling prefix behind.
 */
export const NO_CONTINUATION_MESSAGE = 'nothing continues this';
