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
