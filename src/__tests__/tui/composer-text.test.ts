import { test, expect } from 'bun:test';

import {
  clampCursor,
  deleteAfter,
  deleteBefore,
  deleteWordBefore,
  insertAt,
  moveCursor,
  toCodeUnitOffset,
  toGraphemes,
  wordStartBefore,
} from '../../tui/composer-text.ts';

// Vietnamese is the reason every position here counts graphemes rather than
// code units: `ế` can arrive decomposed, and a caret counting code units lands
// inside the letter -- so a backspace there removes half of one and leaves a
// diacritic stuck to whatever came before.
const DECOMPOSED = 'quế';  // "quế", e + circumflex + acute
const FAMILY = '👨‍👩‍👧';                    // one grapheme, several code points

test('a decomposed Vietnamese word is counted by its letters', () => {
  expect(toGraphemes({ text: DECOMPOSED })).toEqual(['q', 'u', 'ế'.normalize('NFD')]);
  expect(toGraphemes({ text: DECOMPOSED })).toHaveLength(3);
});

test('an emoji made of several code points is one position', () => {
  expect(toGraphemes({ text: FAMILY })).toHaveLength(1);
});

// ── typing ────────────────────────────────────────────────────────────────

test('typing goes in at the caret, which then follows it', () => {
  expect(insertAt({ text: 'helo', cursor: 3, insert: 'l' })).toEqual({ text: 'hello', cursor: 4 });
});

test('typing at the start and at the end both work', () => {
  expect(insertAt({ text: 'ello', cursor: 0, insert: 'h' })).toEqual({ text: 'hello', cursor: 1 });
  expect(insertAt({ text: 'hell', cursor: 4, insert: 'o' })).toEqual({ text: 'hello', cursor: 5 });
});

test('typing several graphemes moves the caret past all of them', () => {
  expect(insertAt({ text: '', cursor: 0, insert: FAMILY })).toEqual({ text: FAMILY, cursor: 1 });
});

// ── deleting ──────────────────────────────────────────────────────────────

test('backspace removes the letter before the caret, not the last one', () => {
  expect(deleteBefore({ text: 'hello', cursor: 3 })).toEqual({ text: 'helo', cursor: 2 });
});

// The bug this whole module exists for: a caret counting code units would take
// the acute off and leave "quê".
test('backspace removes a decomposed letter whole', () => {
  const result = deleteBefore({ text: DECOMPOSED, cursor: 3 });

  expect(toGraphemes({ text: result.text })).toEqual(['q', 'u']);
  expect(result.text).toBe('qu');
});

test('backspace removes a multi-code-point emoji whole', () => {
  expect(deleteBefore({ text: `a${FAMILY}`, cursor: 2 })).toEqual({ text: 'a', cursor: 1 });
});

test('backspace at the very start does nothing rather than throwing', () => {
  expect(deleteBefore({ text: 'hello', cursor: 0 })).toEqual({ text: 'hello', cursor: 0 });
});

test('delete removes the letter after the caret and stays put', () => {
  expect(deleteAfter({ text: 'hello', cursor: 1 })).toEqual({ text: 'hllo', cursor: 1 });
});

test('delete at the very end does nothing', () => {
  expect(deleteAfter({ text: 'hello', cursor: 5 })).toEqual({ text: 'hello', cursor: 5 });
});

// ── moving ────────────────────────────────────────────────────────────────

test('the caret moves by whole letters', () => {
  expect(moveCursor({ text: DECOMPOSED, cursor: 3, delta: -1 })).toBe(2);
  expect(moveCursor({ text: DECOMPOSED, cursor: 0, delta: 1 })).toBe(1);
});

test('the caret stops at both ends rather than wrapping', () => {
  expect(moveCursor({ text: 'hi', cursor: 0, delta: -1 })).toBe(0);
  expect(moveCursor({ text: 'hi', cursor: 2, delta: 1 })).toBe(2);
});

test('a caret left past the end of shorter text is pulled back in', () => {
  expect(clampCursor({ text: 'hi', cursor: 99 })).toBe(2);
  expect(clampCursor({ text: 'hi', cursor: -4 })).toBe(0);
});

// ── words ─────────────────────────────────────────────────────────────────

test('deleting a word takes the whole word', () => {
  expect(deleteWordBefore({ text: 'hello world', cursor: 11 })).toEqual({ text: 'hello ', cursor: 6 });
});

// Otherwise <C-w> at the end of "hello " leaves the space and feels like it
// missed.
test('deleting a word takes the space behind it too', () => {
  expect(deleteWordBefore({ text: 'hello world ', cursor: 12 })).toEqual({ text: 'hello ', cursor: 6 });
});

// Both spaces survive, because only the word was deleted -- which is what
// <C-w> does in a shell, and what "delete the word before the caret" means
// literally. Anything cleverer would be guessing at intent.
test('deleting a word from the middle leaves what is after the caret', () => {
  expect(deleteWordBefore({ text: 'one two three', cursor: 7 })).toEqual({ text: 'one  three', cursor: 4 });
});

test('deleting a word at the start does nothing', () => {
  expect(deleteWordBefore({ text: 'hello', cursor: 0 })).toEqual({ text: 'hello', cursor: 0 });
});

// Prose, not code: someone deleting back through "don't" means the word.
test('punctuation inside a word does not split it', () => {
  expect(wordStartBefore({ text: "I don't", cursor: 7 })).toBe(2);
});

// ── the terminal cursor ───────────────────────────────────────────────────

// The IME draws its half-typed word at the *terminal* cursor, which counts
// code units -- so a grapheme caret has to be converted, not handed over.
test('the caret converts to a code-unit offset for the terminal', () => {
  expect(toCodeUnitOffset({ text: 'hello', cursor: 3 })).toBe(3);
  expect(toCodeUnitOffset({ text: DECOMPOSED, cursor: 3 })).toBe(DECOMPOSED.length);
  expect(toCodeUnitOffset({ text: FAMILY, cursor: 1 })).toBe(FAMILY.length);
});

// ── typing that merges with the letter before it ──────────────────────────

/**
 * A terminal delivers a decomposed Vietnamese letter one code point per key
 * press, so typing `ế` mid-draft calls insertAt three times -- twice with a
 * bare combining mark that joins the grapheme already to its left. The text
 * does not grow by a grapheme when that happens, so a caret advanced by the
 * insert's own length ran ahead of it, and the next mark of the same letter
 * landed on the wrong base character. `abcd` with the caret at 2, typing `ế`,
 * gave `abêćd`.
 */
test('the caret lands after a letter the insert completed, not past it', () => {
  // hoc + a dot below at 2 is "học": three graphemes, caret belongs after "ọ".
  expect(insertAt({ text: 'hoc', cursor: 2, insert: '\u0323' }))
    .toEqual({ text: 'ho\u0323c', cursor: 2 });
  expect(insertAt({ text: 'ex', cursor: 1, insert: '\u0301' }))
    .toEqual({ text: 'e\u0301x', cursor: 1 });
});

test('a skin tone and a regional indicator join what is before them too', () => {
  expect(insertAt({ text: 'a\u{1F44D}b', cursor: 2, insert: '\u{1F3FD}' }).cursor).toBe(2);
  // Two regional indicators are one flag, so the text is one grapheme long
  // and the caret cannot be at 2.
  expect(insertAt({ text: '\u{1F1FB}', cursor: 1, insert: '\u{1F1F3}' }))
    .toEqual({ text: '\u{1F1FB}\u{1F1F3}', cursor: 1 });
});

// The ordinary case must not have moved.
test('an insert that stands on its own still advances by its own length', () => {
  expect(insertAt({ text: 'helo', cursor: 3, insert: 'l' })).toEqual({ text: 'hello', cursor: 4 });
  expect(insertAt({ text: 'ab', cursor: 1, insert: 'xyz' })).toEqual({ text: 'axyzb', cursor: 4 });
});

// Building a letter one mark at a time leaves the caret where the next mark
// has to land -- which is the whole reason the above matters.
test('typing a decomposed letter one mark at a time builds one letter', () => {
  let edit = { text: 'abcd', cursor: 2 };
  for (const mark of ['e', '\u0302', '\u0301']) {
    edit = insertAt({ ...edit, insert: mark });
  }

  // Still decomposed -- nothing here normalises, and nothing should: what the
  // user typed is what gets sent. What matters is that the three marks are
  // *one* grapheme, so the caret can only be before or after the whole letter.
  expect(edit.text.normalize('NFC')).toBe('ab\u1EBFcd');
  expect(toGraphemes({ text: edit.text })).toHaveLength(5);
  expect(toGraphemes({ text: edit.text })[2]!.normalize('NFC')).toBe('\u1EBF');
  expect(edit.cursor).toBe(3);
});
