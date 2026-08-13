/**
 * A caret in the composer, and the edits that move around it.
 *
 * Until now `composerText` was a bare string that could only be appended to
 * and trimmed from the end: typing put a character after the last one, and
 * backspace removed the last one. Fixing a typo in the middle of a message
 * meant deleting everything after it and typing that again.
 *
 * ## Graphemes, not characters
 *
 * Every position here counts *graphemes*. Vietnamese is the reason and it is
 * not hypothetical: `ế` may arrive decomposed as two code points, and an emoji
 * as several, so a caret counting code units lands inside a letter -- and a
 * backspace there removes half of one, leaving a diacritic attached to
 * whatever was before it. This project has already fixed one bug of exactly
 * that shape, where a printable-character check counted code points and
 * dropped composed emoji and decomposed Vietnamese alike.
 *
 * Pure and free of React, so every one of these is checkable without a
 * terminal -- which matters more here than usual, because the failure mode is
 * a message that goes out with a mangled word in it.
 */

const SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** The text split where a caret may legally sit. */
export const toGraphemes = (opts: { text: string }): string[] =>
  [...SEGMENTER.segment(opts.text)].map(segment => segment.segment);

/** A caret pulled inside the text, in graphemes. */
export const clampCursor = (opts: { text: string; cursor: number }): number =>
  Math.max(0, Math.min(toGraphemes({ text: opts.text }).length, opts.cursor));

export interface IComposerEdit {
  text: string;
  cursor: number;
}

/**
 * Type at the caret, and leave the caret after what was typed.
 *
 * The caret is recounted from the joined text rather than added up as
 * `at + inserted.length`, because what is typed can *merge* with the grapheme
 * already to its left instead of becoming a grapheme of its own -- and that is
 * not an exotic case, it is Vietnamese. A terminal delivers a decomposed `ế`
 * as three key presses, so typing it mid-draft calls this three times, twice
 * with a bare combining mark that joins the letter before it. Counting the
 * insert in isolation then advanced the caret past a letter the text never
 * grew by: `hoc` + a dot below at 2 gives `học`, three graphemes, and the
 * caret landed at 3 rather than 2 -- so the *next* mark of the same letter
 * attached to the `c`. Typing `ế` into `abcd` produced `abêćd`, a mangled
 * word one Enter away from being sent.
 */
export const insertAt = (opts: { text: string; cursor: number; insert: string }): IComposerEdit => {
  const graphemes = toGraphemes({ text: opts.text });
  const at = clampCursor({ text: opts.text, cursor: opts.cursor });
  const before = `${graphemes.slice(0, at).join('')}${opts.insert}`;
  return {
    text: `${before}${graphemes.slice(at).join('')}`,
    cursor: toGraphemes({ text: before }).length,
  };
};

/** Backspace: remove the grapheme before the caret, whole. */
export const deleteBefore = (opts: { text: string; cursor: number }): IComposerEdit => {
  const graphemes = toGraphemes({ text: opts.text });
  const at = clampCursor({ text: opts.text, cursor: opts.cursor });
  if (at === 0) {
    return { text: opts.text, cursor: 0 };
  }
  return {
    text: [...graphemes.slice(0, at - 1), ...graphemes.slice(at)].join(''),
    cursor: at - 1,
  };
};

/** Delete: remove the grapheme after the caret, leaving the caret where it is. */
export const deleteAfter = (opts: { text: string; cursor: number }): IComposerEdit => {
  const graphemes = toGraphemes({ text: opts.text });
  const at = clampCursor({ text: opts.text, cursor: opts.cursor });
  if (at >= graphemes.length) {
    return { text: opts.text, cursor: at };
  }
  return {
    text: [...graphemes.slice(0, at), ...graphemes.slice(at + 1)].join(''),
    cursor: at,
  };
};

/** Move by whole graphemes, stopping at either end rather than wrapping. */
export const moveCursor = (opts: { text: string; cursor: number; delta: number }): number =>
  clampCursor({ text: opts.text, cursor: clampCursor({ text: opts.text, cursor: opts.cursor }) + opts.delta });

/**
 * The start of the word before the caret.
 *
 * Whitespace-delimited, which is what `<C-w>` means in a shell and in vim's
 * own insert mode -- not vim's *normal*-mode `b`, which stops at punctuation.
 * A message is prose, and someone deleting back through `don't` means the
 * whole word.
 */
export const wordStartBefore = (opts: { text: string; cursor: number }): number => {
  const graphemes = toGraphemes({ text: opts.text });
  let at = clampCursor({ text: opts.text, cursor: opts.cursor });
  // Any whitespace immediately behind belongs to the deletion too, or
  // <C-w> at the end of "hello " would leave the space and feel like it missed.
  while (at > 0 && graphemes[at - 1]!.trim() === '') {
    at -= 1;
  }
  while (at > 0 && graphemes[at - 1]!.trim() !== '') {
    at -= 1;
  }
  return at;
};

/** `<C-w>`: remove the word before the caret. */
export const deleteWordBefore = (opts: { text: string; cursor: number }): IComposerEdit => {
  const graphemes = toGraphemes({ text: opts.text });
  const at = clampCursor({ text: opts.text, cursor: opts.cursor });
  const start = wordStartBefore(opts);
  return {
    text: [...graphemes.slice(0, start), ...graphemes.slice(at)].join(''),
    cursor: start,
  };
};

/** The caret's position in *code units*, which is what a terminal cursor needs. */
export const toCodeUnitOffset = (opts: { text: string; cursor: number }): number =>
  toGraphemes({ text: opts.text })
    .slice(0, clampCursor({ text: opts.text, cursor: opts.cursor }))
    .join('')
    .length;
