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
    // not literal text". Without the wrap, a named key with no modifiers
    // would canonicalize to its bare English name (e.g. "escape"), which is a
    // string-level prefix of nothing a human types except by coincidence --
    // except vim-engine's prefix search cannot tell the difference, so typing
    // the single letter "e" would register as a pending prefix of "escape"
    // and vanish rather than reach the composer. Verified empirically.
    if (modifiers.length === 0 && key.name.length === 1) {
      return key.name;
    }
    if (modifiers.length === 0) {
      return `<${key.name}>`;
    }

    return `<${modifiers.join('-')}-${key.name}>`;
  };
}
