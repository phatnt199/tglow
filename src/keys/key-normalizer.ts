import type { IKey, IRawKeyEvent } from './common/index.ts';

/** Translates terminal key events into the canonical form the keymap matches against. */
export class KeyNormalizerService {
  /** OpenTUI reports Alt as `option` (macOS) or `meta` (Linux); both mean alt here. */
  normalize = (opts: { event: IRawKeyEvent }): IKey => {
    const { event } = opts;
    return {
      name: event.name,
      ctrl: event.ctrl,
      alt: event.option || event.meta,
      shift: event.shift,
    };
  };

  /**
   * Canonical string form. Modifier order is fixed (C then A then S) so that a
   * binding string can only ever match one key combination.
   */
  toCanonicalString = (opts: { key: IKey }): string => {
    const { key } = opts;
    const modifiers: string[] = [];

    if (key.ctrl) {
      modifiers.push('C');
    }
    if (key.alt) {
      modifiers.push('A');
    }
    // Shift is only notated where it is not already implied by the key name.
    if (key.shift && key.name.length === 1) {
      modifiers.push('S');
    }

    // A bare single character is exactly what a human typed, and stays
    // unwrapped so it matches the letter keys of the keymap directly. Every
    // other key -- a named key like "escape", or any modifier combination --
    // is wrapped in angle brackets, vim's own notation for "this is a key,
    // not literal text". The wrap alone is not sufficient, though: a typed
    // "<" is itself a bare single character, so vim-engine must compare
    // whole tokens (see parseKeySequence below), not raw strings, or "<" ends
    // up a string-level prefix of every bracketed binding instead.
    if (modifiers.length === 0 && key.name.length === 1) {
      return key.name;
    }
    if (modifiers.length === 0) {
      return `<${key.name}>`;
    }

    return `<${modifiers.join('-')}-${key.name}>`;
  };
}

/**
 * Splits a binding's authored `keys` string ("gg", "jk", "<escape>",
 * "<C-p>") into the token sequence it represents: a bracketed group is
 * exactly one physical key press, no matter how many characters it takes to
 * write, so it must parse to one token, not one token per character.
 *
 * This is what makes vim-engine's matching safe: comparing sequences as
 * token arrays means a typed "<" (one token, itself) can never be a prefix
 * of "<escape>" (a different, single token) -- unlike the raw-string
 * `startsWith` this replaces, where "<escape>".startsWith("<") is true.
 *
 * A total function: an unmatched "<" (no closing ">" anywhere after it)
 * falls back to one literal-character token, the same way vim itself treats
 * unbalanced angle brackets in a mapping's left-hand side as plain text
 * rather than a malformed special key. Scanning resumes right after it, so a
 * genuine bracketed group later in the same string still parses correctly.
 *
 * A free function, not a KeyNormalizerService method: it parses an authored
 * binding string, not a live key press, so it has no use for the service's
 * instance state.
 */
export const parseKeySequence = (keys: string): string[] => {
  const tokens: string[] = [];
  let index = 0;

  while (index < keys.length) {
    if (keys[index] === '<') {
      const end = keys.indexOf('>', index + 1);
      if (end !== -1) {
        tokens.push(keys.slice(index, end + 1));
        index = end + 1;
        continue;
      }
    }

    tokens.push(keys[index]);
    index += 1;
  }

  return tokens;
};
