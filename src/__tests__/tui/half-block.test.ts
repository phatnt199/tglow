import { test, expect } from 'bun:test';

import { resolveImageSize } from '../../tui/half-block.ts';

// ── sizing ────────────────────────────────────────────────────────────────

// One column per pixel across, one row per two pixels down: that is what
// drawing with an upper half block buys.
test('an image that fits keeps its natural size', () => {
  expect(resolveImageSize({ width: 40, height: 20, maximumColumns: 80, maximumRows: 40 }))
    .toEqual({ columns: 40, rows: 10 });
});

test('a wide image is scaled by the columns it has', () => {
  const size = resolveImageSize({ width: 200, height: 100, maximumColumns: 50, maximumRows: 40 });
  expect(size.columns).toBe(50);
  // Half the width, so half the rows: 100/2 natural rows, scaled by 50/200.
  expect(size.rows).toBe(12);
});

test('a tall image is scaled by the rows it has', () => {
  const size = resolveImageSize({ width: 100, height: 400, maximumColumns: 200, maximumRows: 20 });
  expect(size.rows).toBe(20);
  expect(size.columns).toBe(10);
});

// A twelve-pixel thumbnail blown up to fill the pane is a wall of colour, and
// the point of drawing it is to recognise what it is.
test('a small image is never enlarged', () => {
  expect(resolveImageSize({ width: 8, height: 8, maximumColumns: 200, maximumRows: 100 }))
    .toEqual({ columns: 8, rows: 4 });
});

// An image scaled to nothing is an image that silently disappears, which is
// the failure this whole feature exists to remove.
test('an image squeezed hard still gets a cell', () => {
  const size = resolveImageSize({ width: 4000, height: 3000, maximumColumns: 1, maximumRows: 1 });
  expect(size.columns).toBeGreaterThanOrEqual(1);
  expect(size.rows).toBeGreaterThanOrEqual(1);
});

test('a nonsense size draws nothing rather than something wrong', () => {
  expect(resolveImageSize({ width: 0, height: 10, maximumColumns: 10, maximumRows: 10 })).toEqual({ columns: 0, rows: 0 });
  expect(resolveImageSize({ width: 10, height: 10, maximumColumns: 0, maximumRows: 10 })).toEqual({ columns: 0, rows: 0 });
});
