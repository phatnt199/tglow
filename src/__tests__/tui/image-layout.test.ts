import { test, expect } from 'bun:test';

import {
  IMAGE_RAIL_ALLOWANCE,
  MAXIMUM_STICKER_COLUMNS,
  imageCacheKey,
  planImageFetches,
  resolveImageRows,
  resolveImageWidth,
  resolvePaneOrigin,
  toTerminalImageId,
  type IDrawableMessage,
} from '../../tui/image-layout.ts';
import { createPane, type TPaneGrid } from '../../core/conversation-panes.ts';

const gridOf = (columns: string[][]): TPaneGrid =>
  columns.map(column => column.map(peerId => createPane({ peerId })));

const photo = (id: number): IDrawableMessage => ({ id, sticker: false });
const sticker = (id: number): IDrawableMessage => ({ id, sticker: true });

// ── the cache key ─────────────────────────────────────────────────────────

// The bug this exists for: chafa renders to a fixed number of cells, so a
// photograph at 40 columns and the same one at 80 are two different results.
// Keyed by message id alone, splitting the screen -- which halves every pane
// -- left the pre-split cells in the cache and drew them into a pane half
// their size.
test('the same message at two widths is two different cache entries', () => {
  expect(imageCacheKey({ messageId: 7, width: 40 }))
    .not.toBe(imageCacheKey({ messageId: 7, width: 80 }));
});

test('the same message at the same width is one entry', () => {
  expect(imageCacheKey({ messageId: 7, width: 40 })).toBe(imageCacheKey({ messageId: 7, width: 40 }));
});

// ── sizing ────────────────────────────────────────────────────────────────

// The size must come from the pane, not from the conversation area the panes
// share. Two columns across 120 gives each 60, and a photo drawn for 120 has
// nowhere to go.
test('a picture is sized to its own pane, leaving room for the rail', () => {
  expect(resolveImageWidth({ paneWidth: 100, sticker: false })).toBe(100 - IMAGE_RAIL_ALLOWANCE);
  expect(resolveImageWidth({ paneWidth: 60, sticker: false })).toBe(60 - IMAGE_RAIL_ALLOWANCE);
});

test('a stickers stays small however wide the pane is', () => {
  expect(resolveImageWidth({ paneWidth: 200, sticker: true })).toBe(MAXIMUM_STICKER_COLUMNS);
});

// A pane narrower than the rail must still ask for something drawable rather
// than zero or a negative width.
test('a pane narrower than the rail still asks for at least one column', () => {
  expect(resolveImageWidth({ paneWidth: 10, sticker: false })).toBe(1);
  expect(resolveImageWidth({ paneWidth: 0, sticker: false })).toBe(1);
});

test('stickers are shorter than photographs', () => {
  expect(resolveImageRows({ sticker: true })).toBeLessThan(resolveImageRows({ sticker: false }));
});

// ── planning across panes ─────────────────────────────────────────────────

// The bug: pictures were fetched for the focused conversation alone, so a
// split pane showed none at all.
test('every pane gets its pictures, not only the focused one', () => {
  const drawables: Record<string, IDrawableMessage[]> = { a: [photo(1)], b: [photo(2)] };
  const requests = planImageFetches({
    grid: gridOf([['a'], ['b']]),
    widths: [60, 60],
    drawableOf: pane => drawables[pane.peerId ?? ''] ?? [],
  });

  expect(requests.map(request => request.messageId).sort()).toEqual([1, 2]);
  expect(requests.map(request => request.peerId).sort()).toEqual(['a', 'b']);
});

test('a stacked pane is planned for too', () => {
  const drawables: Record<string, IDrawableMessage[]> = { a: [photo(1)], b: [photo(2)], c: [photo(3)] };
  const requests = planImageFetches({
    grid: gridOf([['a', 'b'], ['c']]),
    widths: [60, 60],
    drawableOf: pane => drawables[pane.peerId ?? ''] ?? [],
  });

  expect(requests.map(request => request.messageId).sort()).toEqual([1, 2, 3]);
});

// Each pane's request carries *its* width, which is the whole correction.
test('each pane asks at its own width', () => {
  const drawables: Record<string, IDrawableMessage[]> = { a: [photo(1)], b: [photo(2)] };
  const requests = planImageFetches({
    grid: gridOf([['a'], ['b']]),
    widths: [80, 40],
    drawableOf: pane => drawables[pane.peerId ?? ''] ?? [],
  });

  const byMessage = new Map(requests.map(request => [request.messageId, request]));
  expect(byMessage.get(1)!.maximumColumns).toBe(80 - IMAGE_RAIL_ALLOWANCE);
  expect(byMessage.get(2)!.maximumColumns).toBe(40 - IMAGE_RAIL_ALLOWANCE);
});

// Two views of one chat at the same width are one picture, not two fetches.
test('the same chat shown twice at the same width is fetched once', () => {
  const requests = planImageFetches({
    grid: gridOf([['a'], ['a']]),
    widths: [60, 60],
    drawableOf: () => [photo(1)],
  });

  expect(requests).toHaveLength(1);
});

// ...but at different widths it genuinely is two pictures.
test('the same chat at two different widths is two pictures', () => {
  const requests = planImageFetches({
    grid: gridOf([['a'], ['a']]),
    widths: [80, 40],
    drawableOf: () => [photo(1)],
  });

  expect(requests).toHaveLength(2);
  expect(new Set(requests.map(request => request.key)).size).toBe(2);
});

test('a pane with no chat in it asks for nothing', () => {
  expect(planImageFetches({
    grid: [[createPane()]], widths: [60], drawableOf: () => [photo(1)],
  })).toEqual([]);
});

test('a sticker and a photo in one pane are planned separately', () => {
  const requests = planImageFetches({
    grid: gridOf([['a']]), widths: [100],
    drawableOf: () => [photo(1), sticker(2)],
  });

  expect(requests.find(request => request.messageId === 1)!.maximumColumns).toBe(100 - IMAGE_RAIL_ALLOWANCE);
  expect(requests.find(request => request.messageId === 2)!.maximumColumns).toBe(MAXIMUM_STICKER_COLUMNS);
});

// ── where a picture lands on screen ───────────────────────────────────────

// The bug that put one pane's photographs on top of another's: every
// placement was measured from the first conversation column's left edge,
// whatever pane it actually belonged to.
test('each column starts after the columns and dividers before it', () => {
  const widths = [40, 30, 20];
  const at = (column: number): number =>
    resolvePaneOrigin({ conversationLeft: 25, widths, column, dividerColumns: 1 });

  expect(at(0)).toBe(25);
  expect(at(1)).toBe(25 + 40 + 1);
  expect(at(2)).toBe(25 + 40 + 1 + 30 + 1);
});

test('with one column the origin is just the conversation area', () => {
  expect(resolvePaneOrigin({ conversationLeft: 25, widths: [80], column: 0, dividerColumns: 1 })).toBe(25);
});

// Panes never overlap: each one starts at or after where the previous ended.
test('no two columns claim the same screen column', () => {
  const widths = [40, 30, 20];
  for (let column = 1; column < widths.length; column += 1) {
    const previousEnd = resolvePaneOrigin({ conversationLeft: 0, widths, column: column - 1, dividerColumns: 1 })
      + widths[column - 1]!;
    expect(resolvePaneOrigin({ conversationLeft: 0, widths, column, dividerColumns: 1 }))
      .toBeGreaterThanOrEqual(previousEnd);
  }
});

// ── the terminal's own image ids ──────────────────────────────────────────

// The protocol names images with a number, and the obvious number -- the
// message id -- collides the moment the same photograph is on screen at two
// widths: the second transmission replaces the first, and one pane draws the
// other pane's size.
test('the same message at two widths gets two terminal ids', () => {
  const left = toTerminalImageId({ key: imageCacheKey({ messageId: 7, width: 40 }) });
  const right = toTerminalImageId({ key: imageCacheKey({ messageId: 7, width: 80 }) });

  expect(left).not.toBe(right);
});

test('the same key always gets the same id', () => {
  const key = imageCacheKey({ messageId: 7, width: 40 });
  expect(toTerminalImageId({ key })).toBe(toTerminalImageId({ key }));
});

// The protocol's id is a positive 32-bit number, and zero means "none".
test('an id is positive and fits where the protocol puts it', () => {
  for (let messageId = 1; messageId < 400; messageId += 1) {
    for (const width of [12, 40, 80]) {
      const id = toTerminalImageId({ key: imageCacheKey({ messageId, width }) });
      expect(id).toBeGreaterThan(0);
      expect(id).toBeLessThanOrEqual(2_147_483_647);
      expect(Number.isInteger(id)).toBe(true);
    }
  }
});

// Not proof against all collisions -- no hash is -- but a sweep of realistic
// keys must not produce one, or two pictures share an id on a real screen.
test('realistic keys do not collide', () => {
  const seen = new Map<number, string>();
  for (let messageId = 1; messageId <= 2_000; messageId += 1) {
    for (const width of [12, 18, 26, 40, 52, 80, 112]) {
      const key = imageCacheKey({ messageId, width });
      const id = toTerminalImageId({ key });
      expect(seen.get(id) ?? key).toBe(key);
      seen.set(id, key);
    }
  }
});
