import { test, expect } from 'bun:test';

import { resolveVisibleRange, resolveVisibleRowRange } from '../../src/tui/viewport.ts';

// resolveVisibleRange had no direct test before this file: both panes drive
// it indirectly through a rendered frame, and all four of those tests passed
// just as well against a hypothetical `start = cursor` implementation as
// against the real one -- neither the scrolloff margin nor the
// `total - height` clamp was pinned by anything.

test('cursor at the start of the list keeps the range pinned to zero', () => {
  const range = resolveVisibleRange({ total: 200, cursor: 0, height: 10 });
  expect(range.start).toBe(0);
});

test('cursor at the end of the list keeps the last row inside the range', () => {
  const total = 200;
  const cursor = total - 1;
  const range = resolveVisibleRange({ total, cursor, height: 10 });
  expect(cursor).toBeGreaterThanOrEqual(range.start);
  expect(cursor).toBeLessThan(range.end);
});

test('a list shorter than the pane is shown in full, unclipped', () => {
  const range = resolveVisibleRange({ total: 5, cursor: 2, height: 10 });
  expect(range).toEqual({ start: 0, end: 5 });
});

// Mirrors the unexported SCROLLOFF_ROWS in src/tui/viewport.ts -- if that
// constant ever changes, the numbers below have to change with it.
const SCROLLOFF_ROWS = 8;

// The one case the other tests here cannot tell apart from a broken
// `start = cursor`: at both edges of the list the `[0, total - height]` clamp
// forces the same start either implementation would produce, which is why
// neither edge case above catches it. Only a cursor well inside a long list
// exposes the margin, so `start !== cursor` is the assertion that actually
// distinguishes the two.
test('a cursor well inside a long list keeps a scrolloff margin on both sides', () => {
  const cursor = 100;
  const range = resolveVisibleRange({ total: 200, cursor, height: 20 });
  expect(range.start).not.toBe(cursor);
  expect(cursor - range.start).toBeGreaterThanOrEqual(SCROLLOFF_ROWS);
  expect(range.end - cursor).toBeGreaterThan(SCROLLOFF_ROWS);
});

test('a height of zero or less degrades to a single row instead of throwing or going negative', () => {
  for (const height of [0, -5]) {
    const range = resolveVisibleRange({ total: 200, cursor: 50, height });
    expect(range.start).toBeGreaterThanOrEqual(0);
    expect(range.end - range.start).toBe(1);
  }
});

// Once a message wraps, one message is no longer one row, and a range measured
// in messages puts more rows into the pane than it has -- which is what let
// two messages overdraw each other into one unreadable line. These pin the
// same window logic in the unit the message view now counts in.

test('a row range is measured in rows, so a tall item does not overfill the pane', () => {
  // Ten messages of three rows each: a message-counted range would hand the
  // pane thirty rows for ten.
  const range = resolveVisibleRowRange({ totalRows: 30, cursorRowStart: 0, cursorRowSpan: 3, height: 10 });
  expect(range.end - range.start).toBe(10);
});

test('every row of the cursor item is on screen when it fits', () => {
  const range = resolveVisibleRowRange({ totalRows: 100, cursorRowStart: 50, cursorRowSpan: 4, height: 20 });
  expect(range.start).toBeLessThanOrEqual(50);
  expect(range.end).toBeGreaterThanOrEqual(54);
});

// The failure this replaces the message-index range to prevent: a cursor
// message taller than the pane. Anchoring on its first row is what keeps it
// readable -- scrolling to its last row would show only its tail.
test('an item taller than the pane is anchored at its first row', () => {
  const range = resolveVisibleRowRange({ totalRows: 200, cursorRowStart: 80, cursorRowSpan: 40, height: 10 });
  expect(range).toEqual({ start: 80, end: 90 });
});

test('the row range keeps the same scrolloff margin as the message range', () => {
  const cursorRowStart = 100;
  const range = resolveVisibleRowRange({ totalRows: 400, cursorRowStart, cursorRowSpan: 1, height: 20 });
  expect(range.start).not.toBe(cursorRowStart);
  expect(cursorRowStart - range.start).toBeGreaterThanOrEqual(SCROLLOFF_ROWS);
  expect(range.end - cursorRowStart).toBeGreaterThan(SCROLLOFF_ROWS);
});

test('the first and last rows stay reachable', () => {
  expect(resolveVisibleRowRange({ totalRows: 200, cursorRowStart: 0, cursorRowSpan: 1, height: 10 }).start).toBe(0);
  expect(resolveVisibleRowRange({ totalRows: 200, cursorRowStart: 199, cursorRowSpan: 1, height: 10 })).toEqual({
    start: 190,
    end: 200,
  });
});

test('fewer rows than the pane are shown in full, unclipped', () => {
  expect(resolveVisibleRowRange({ totalRows: 5, cursorRowStart: 2, cursorRowSpan: 1, height: 10 })).toEqual({
    start: 0,
    end: 5,
  });
});

test('a row range never runs past either end of the rows it was given', () => {
  for (const cursorRowStart of [0, 1, 7, 99, 150, 199]) {
    for (const cursorRowSpan of [1, 2, 9, 30]) {
      for (const height of [0, 1, 4, 10, 25, 400]) {
        const range = resolveVisibleRowRange({ totalRows: 200, cursorRowStart, cursorRowSpan, height });
        expect({ cursorRowStart, cursorRowSpan, height, ...range }).toEqual({
          cursorRowStart,
          cursorRowSpan,
          height,
          start: Math.max(0, Math.min(range.start, 200)),
          end: Math.min(200, range.end),
        });
        expect(range.start).toBeLessThanOrEqual(cursorRowStart);
        expect(range.end).toBeGreaterThan(cursorRowStart);
      }
    }
  }
});
