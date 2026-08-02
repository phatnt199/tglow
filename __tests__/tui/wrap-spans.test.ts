import { test, expect } from 'bun:test';

import { EntityKinds } from '../../src/core/common/index.ts';
import { wrapSpans } from '../../src/tui/wrap-spans.ts';

const plain = (text: string) => ({ text, kinds: [], url: null });

test('spans that fit stay on one row', () => {
  expect(wrapSpans({ spans: [plain('hello')], width: 10 })).toEqual([[plain('hello')]]);
});

test('wrapping breaks on spaces', () => {
  const rows = wrapSpans({ spans: [plain('one two three')], width: 7 });
  expect(rows.map(row => row.map(span => span.text).join(''))).toEqual(['one two', 'three']);
});

// The point of the module: a style must not be lost at a row boundary.
test('a style spanning a wrap survives on both rows', () => {
  const rows = wrapSpans({
    spans: [{ text: 'aaa bbb', kinds: [EntityKinds.BOLD], url: null }],
    width: 4,
  });
  expect(rows).toHaveLength(2);
  for (const row of rows) {
    expect(row[0]!.kinds).toEqual([EntityKinds.BOLD]);
  }
  expect(rows.map(row => row.map(span => span.text).join(''))).toEqual(['aaa', 'bbb']);
});

test('a row can carry several spans with different styles', () => {
  const rows = wrapSpans({
    spans: [plain('see '), { text: 'here', kinds: [EntityKinds.TEXT_URL], url: 'https://example.com' }],
    width: 20,
  });
  expect(rows).toHaveLength(1);
  expect(rows[0]!.map(span => span.text)).toEqual(['see ', 'here']);
  expect(rows[0]![1]!.url).toBe('https://example.com');
});

test('a word longer than the width is hard-split rather than overflowing', () => {
  const rows = wrapSpans({ spans: [plain('abcdefghij')], width: 4 });
  for (const row of rows) {
    expect(row.map(span => span.text).join('').length).toBeLessThanOrEqual(4);
  }
  expect(rows.map(row => row.map(span => span.text).join('')).join('')).toBe('abcdefghij');
});

test('wide characters count as two columns', () => {
  const rows = wrapSpans({ spans: [plain('日本語です')], width: 4 });
  expect(rows.length).toBeGreaterThan(1);
});

test('width of zero or less returns a single row rather than looping', () => {
  expect(wrapSpans({ spans: [plain('hi')], width: 0 })).toEqual([[plain('hi')]]);
});

test('empty spans still produce one row so the message occupies a line', () => {
  expect(wrapSpans({ spans: [plain('')], width: 10 })).toEqual([[plain('')]]);
});

test('the concatenated rows reconstruct the original text', () => {
  const text = 'Chào bạn, đây là một tin nhắn dài để kiểm tra xuống dòng';
  const rows = wrapSpans({ spans: [plain(text)], width: 12 });
  expect(rows.map(row => row.map(span => span.text).join('')).join(' ')).toBe(text);
});
