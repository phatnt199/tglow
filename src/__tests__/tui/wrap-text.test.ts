import { test, expect } from 'bun:test';

import { measureTextWidth } from '../../tui/text-width.ts';
import { wrapText } from '../../tui/wrap-text.ts';

const widthsOf = (lines: string[]): number[] => lines.map(line => measureTextWidth({ text: line }));

test('text that already fits comes back as a single line', () => {
  expect(wrapText({ text: 'morning!', width: 20 })).toEqual(['morning!']);
});

test('text exactly the width is not split', () => {
  expect(wrapText({ text: 'twelve chars', width: 12 })).toEqual(['twelve chars']);
});

test('breaks on spaces rather than mid-word', () => {
  expect(wrapText({ text: 'the quick brown fox jumps', width: 10 })).toEqual([
    'the quick',
    'brown fox',
    'jumps',
  ]);
});

test('a word longer than the width is hard-split rather than left to overflow', () => {
  expect(wrapText({ text: 'supercalifragilistic', width: 7 })).toEqual([
    'superca',
    'lifragi',
    'listic',
  ]);
});

test('a long word after a short one starts on its own line', () => {
  expect(wrapText({ text: 'hi supercalifragilistic', width: 7 })).toEqual([
    'hi',
    'superca',
    'lifragi',
    'listic',
  ]);
});

// Guard clause, not an aesthetic choice: the wrapping loop consumes `width`
// columns per pass, so a non-positive width would never make progress.
test('a width of zero or less returns the text whole instead of looping forever', () => {
  for (const width of [0, -1, -80]) {
    expect(wrapText({ text: 'anything at all', width })).toEqual(['anything at all']);
  }
});

// One row per message is the invariant the message view rests on. An empty
// message that produced no lines would silently cost that message its row and
// shift every gutter number below it by one.
test('an empty string still produces one row', () => {
  expect(wrapText({ text: '', width: 20 })).toEqual(['']);
});

test('a string of only spaces still produces one row, and no blank extras', () => {
  expect(wrapText({ text: '     ', width: 20 })).toEqual(['']);
});

test('runs of spaces do not become blank rows', () => {
  expect(wrapText({ text: 'a       b', width: 4 })).toEqual(['a b']);
});

// Telegram messages carry newlines, and a newline inside a single <text> makes
// OpenTUI render two rows for one child -- which is exactly the overflow that
// made the pane overdraw itself. Splitting here is what keeps one wrapped line
// equal to one rendered row.
test('an embedded newline starts a new row', () => {
  expect(wrapText({ text: 'first\nsecond', width: 20 })).toEqual(['first', 'second']);
});

test('a blank line between paragraphs is kept as an empty row', () => {
  expect(wrapText({ text: 'one\n\ntwo', width: 20 })).toEqual(['one', '', 'two']);
});

test('carriage returns and tabs do not survive into a row', () => {
  const lines = wrapText({ text: 'a\r\nb\tc', width: 20 });
  expect(lines).toEqual(['a', 'b c']);
  for (const line of lines) {
    expect(line).not.toContain('\t');
    expect(line).not.toContain('\r');
  }
});

const PARAGRAPH =
  'This code can be used to log in to your Telegram account. Do not give it to anyone, ' +
  'even if they say they are from Telegram — nobody there will ever ask you for it. ' +
  'Xin chào, đây là một tin nhắn tiếng Việt. 你好世界，这是一条中文消息。🔥🔥 ' +
  'supercalifragilisticexpialidociousandthensomemoreforgoodmeasure';

test('no wrapped line is ever wider than the width it was given', () => {
  for (const width of [2, 3, 5, 8, 13, 21, 34, 55, 89]) {
    const lines = wrapText({ text: PARAGRAPH, width });
    expect({ width, over: widthsOf(lines).filter(value => value > width) }).toEqual({ width, over: [] });
  }
});

test('wrapping loses no words', () => {
  for (const width of [5, 13, 34, 89]) {
    const lines = wrapText({ text: PARAGRAPH, width });
    expect({ width, text: lines.join('').replace(/ /g, '') }).toEqual({
      width,
      text: PARAGRAPH.replace(/\s/g, ''),
    });
  }
});

// The message view's regression test identifies a corrupted row by checking it
// against the message it came from, which only works while a wrapped line is a
// verbatim run of the original.
test('a wrapped line is a verbatim slice of the text it came from', () => {
  const text = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet';
  for (const line of wrapText({ text, width: 17 })) {
    expect(text).toContain(line);
  }
});

// A two-column glyph cannot be halved without corrupting the row, so the break
// has to land between graphemes and the line comes up a column short instead.
test('a wide glyph is never split down the middle', () => {
  const lines = wrapText({ text: '你好世界你好世界', width: 5 });
  expect(lines).toEqual(['你好', '世界', '你好', '世界']);
  expect(widthsOf(lines)).toEqual([4, 4, 4, 4]);
});

test('a decomposed Vietnamese name is measured and split by grapheme', () => {
  const decomposed = 'Nguyễn Tấn Phát'.normalize('NFD');
  const lines = wrapText({ text: decomposed, width: 8 });
  expect(widthsOf(lines)).toEqual([6, 8]);
  expect(lines.map(line => line.normalize('NFC'))).toEqual(['Nguyễn', 'Tấn Phát']);
});

test('an emoji sequence stays whole', () => {
  expect(wrapText({ text: '👨‍👩‍👧 👨‍👩‍👧 👨‍👩‍👧', width: 5 })).toEqual(['👨‍👩‍👧 👨‍👩‍👧', '👨‍👩‍👧']);
});

// The one case where the stated invariant cannot hold: a single glyph two
// columns wide, in a field one column wide. Dropping it would lose content
// silently and returning nothing would not terminate, so it is emitted whole
// and the caller keeps content columns above this degenerate width.
test('a glyph wider than the whole field is emitted rather than dropped or looped on', () => {
  expect(wrapText({ text: '你好', width: 1 })).toEqual(['你', '好']);
});
