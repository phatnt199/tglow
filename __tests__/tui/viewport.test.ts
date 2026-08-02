import { test, expect } from 'bun:test';

import { resolveVisibleRange } from '../../src/tui/viewport.ts';

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
