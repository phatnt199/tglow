import { test, expect } from 'bun:test';

import {
  MAXIMUM_PANES,
  MINIMUM_CONVERSATION_HEIGHT,
  MINIMUM_CONVERSATION_WIDTH,
  capture,
  clampPosition,
  closePane,
  countPanes,
  createGrid,
  createPane,
  cyclePane,
  move,
  paneAt,
  restore,
  shareEvenly,
  splitHorizontal,
  splitVertical,
  withActive,
  type IConversationState,
  type TPaneGrid,
} from '../../core/conversation-panes.ts';
import type { IMessageRow } from '../../core/cache/index.ts';

const message = (id: number): IMessageRow => ({
  id, peerId: 'p1', fromId: 'u1', date: id, text: `m${id}`, out: 0,
  entities: [], replyToMessageId: null, pinned: 0, media: null, reactions: [],
} as unknown as IMessageRow);

const conversation = (opts: Partial<IConversationState> = {}): IConversationState => ({
  activePeerId: 'p1',
  messages: [message(1), message(2)],
  messageCursor: 1,
  composerText: '',
  composerCursor: 0,
  replyToMessageId: null,
  editingMessageId: null,
  composerTextBeforeEdit: null,
  ...opts,
});

/** A grid written the way it looks on screen: one array per column. */
const gridOf = (columns: string[][]): TPaneGrid =>
  columns.map(column => column.map(peerId => createPane({ peerId })));

const shapeOf = (grid: TPaneGrid): string[][] =>
  grid.map(column => column.map(pane => pane.peerId ?? '-'));

const ROOMY = { width: 400, height: 100 };

// ── capture and restore ───────────────────────────────────────────────────

// The pair that makes the whole design work: the focused pane's conversation
// stays in the flat state everything already reads, and only moves into a pane
// when the focus leaves it.
test('what is captured from the flat state restores to the same thing', () => {
  const before = conversation({ composerText: 'half a sentence', replyToMessageId: 7 });

  expect(restore({ pane: capture({ conversation: before }) })).toEqual(before);
});

test('a fresh grid is one conversation, which is what tglow always was', () => {
  const grid = createGrid();

  expect(countPanes({ grid })).toBe(1);
  expect(paneAt({ grid, at: { column: 0, row: 0 } })?.peerId).toBeNull();
});

// The focused pane's own slot is stale by construction. Anything drawing every
// pane has to see the live conversation there instead, or the pane you are
// looking at is the one that stops updating.
test('the focused slot is filled in from the flat state, the others left alone', () => {
  const grid = gridOf([['old'], ['other']]);
  const merged = withActive({
    grid, active: { column: 0, row: 0 }, conversation: conversation({ activePeerId: 'live' }),
  });

  expect(merged[0]![0]!.peerId).toBe('live');
  expect(merged[0]![0]!.messages).toHaveLength(2);
  expect(merged[1]![0]).toBe(grid[1]![0]!);
});

// ── splitting into columns ────────────────────────────────────────────────

test('a vertical split adds a column beside the focused one, and focuses it', () => {
  const result = splitVertical({
    grid: gridOf([['a'], ['b']]), active: { column: 0, row: 0 },
    conversation: conversation({ activePeerId: 'a' }), width: ROOMY.width,
  });

  expect(result.split).toBe(true);
  expect(shapeOf(result.grid)).toEqual([['a'], ['a'], ['b']]);
  expect(result.active).toEqual({ column: 1, row: 0 });
});

// Refused rather than silently ignored, so the caller has something to say.
test('a vertical split with no room for another column is refused', () => {
  const result = splitVertical({
    grid: gridOf([['a'], ['b']]), active: { column: 0, row: 0 },
    conversation: conversation(), width: MINIMUM_CONVERSATION_WIDTH * 2,
  });

  expect(result.split).toBe(false);
  expect(result.grid).toHaveLength(2);
});

// ── splitting into rows ───────────────────────────────────────────────────

test('a horizontal split stacks a row inside the focused column only', () => {
  const result = splitHorizontal({
    grid: gridOf([['a'], ['b']]), active: { column: 0, row: 0 },
    conversation: conversation({ activePeerId: 'a' }), height: ROOMY.height,
  });

  expect(result.split).toBe(true);
  expect(shapeOf(result.grid)).toEqual([['a', 'a'], ['b']]);
  expect(result.active).toEqual({ column: 0, row: 1 });
});

// The limit that actually bites: a terminal is far wider than it is tall, so a
// second row runs out of room long before a second column does.
test('a horizontal split with no room for another row is refused', () => {
  const result = splitHorizontal({
    grid: gridOf([['a']]), active: { column: 0, row: 0 },
    conversation: conversation(), height: MINIMUM_CONVERSATION_HEIGHT,
  });

  expect(result.split).toBe(false);
  // The shape is what must not change. The pane itself still comes back with
  // the live conversation merged into it, because every one of these returns
  // the grid through withActive -- refusing to split is not a reason to hand
  // back a stale slot.
  expect(countPanes({ grid: result.grid })).toBe(1);
  expect(result.grid).toHaveLength(1);
});

test('the ceiling counts the whole grid, not one column of it', () => {
  const full = gridOf([['a', 'b'], ['c', 'd']]);
  expect(countPanes({ grid: full })).toBe(MAXIMUM_PANES);

  expect(splitVertical({
    grid: full, active: { column: 0, row: 0 }, conversation: conversation(), width: ROOMY.width,
  }).split).toBe(false);
  expect(splitHorizontal({
    grid: full, active: { column: 0, row: 0 }, conversation: conversation(), height: ROOMY.height,
  }).split).toBe(false);
});

// Splitting has to commit the live conversation into the pane it came from, or
// the original half shows a conversation frozen at whatever it held last time
// focus left it.
test('splitting writes the live conversation into the pane it split from', () => {
  const result = splitHorizontal({
    grid: gridOf([['stale']]), active: { column: 0, row: 0 },
    conversation: conversation({ activePeerId: 'live', composerText: 'draft' }), height: ROOMY.height,
  });

  expect(result.grid[0]![0]!.peerId).toBe('live');
  expect(result.grid[0]![0]!.composerText).toBe('draft');
});

// ── moving ────────────────────────────────────────────────────────────────

test('left and right change column; up and down move within one', () => {
  const grid = gridOf([['a', 'b'], ['c', 'd']]);
  const at = { column: 0, row: 0 };

  expect(move({ grid, active: at, direction: 'right' })).toEqual({ column: 1, row: 0 });
  expect(move({ grid, active: at, direction: 'down' })).toEqual({ column: 0, row: 1 });
  expect(move({ grid, active: { column: 1, row: 1 }, direction: 'up' })).toEqual({ column: 1, row: 0 });
  expect(move({ grid, active: { column: 1, row: 1 }, direction: 'left' })).toEqual({ column: 0, row: 1 });
});

// Stopping rather than wrapping: a left that reappears on the far right is how
// you lose track of which pane you are in -- and it is what lets the reducer
// read "already leftmost, asked to go left" as "they meant the chat list".
test('moving stops at the edges rather than wrapping', () => {
  const grid = gridOf([['a', 'b'], ['c']]);

  expect(move({ grid, active: { column: 0, row: 0 }, direction: 'left' })).toEqual({ column: 0, row: 0 });
  expect(move({ grid, active: { column: 0, row: 0 }, direction: 'up' })).toEqual({ column: 0, row: 0 });
  expect(move({ grid, active: { column: 1, row: 0 }, direction: 'right' })).toEqual({ column: 1, row: 0 });
});

// Columns hold different numbers of rows, so the row has to come along clamped
// -- stepping right from row 1 into a one-row column must land on something.
test('moving between columns of different heights lands on a real pane', () => {
  const grid = gridOf([['a', 'b'], ['c']]);

  expect(move({ grid, active: { column: 0, row: 1 }, direction: 'right' })).toEqual({ column: 1, row: 0 });
});

test('a position outside the grid is pulled back inside it', () => {
  const grid = gridOf([['a', 'b'], ['c']]);

  expect(clampPosition({ grid, at: { column: 9, row: 9 } })).toEqual({ column: 1, row: 0 });
  expect(clampPosition({ grid, at: { column: -3, row: -3 } })).toEqual({ column: 0, row: 0 });
});

// One key reaches every conversation however the grid is arranged.
test('cycling walks the whole grid in reading order and wraps', () => {
  const grid = gridOf([['a', 'b'], ['c']]);
  const visited = [{ column: 0, row: 0 }];
  for (let step = 0; step < 3; step += 1) {
    visited.push(cyclePane({ grid, active: visited[visited.length - 1]!, delta: 1 }));
  }

  expect(visited).toEqual([
    { column: 0, row: 0 }, { column: 0, row: 1 }, { column: 1, row: 0 }, { column: 0, row: 0 },
  ]);
});

// ── closing ───────────────────────────────────────────────────────────────

test('closing a stacked pane leaves the column standing', () => {
  const result = closePane({
    grid: gridOf([['a', 'b'], ['c']]), active: { column: 0, row: 1 }, conversation: conversation(),
  });

  expect(result.closed).toBe(true);
  expect(shapeOf(result.grid)).toEqual([['a'], ['c']]);
  expect(result.active).toEqual({ column: 0, row: 0 });
});

test('closing the last pane in a column takes the column with it', () => {
  const result = closePane({
    grid: gridOf([['a'], ['b']]), active: { column: 1, row: 0 }, conversation: conversation(),
  });

  expect(shapeOf(result.grid)).toEqual([['a']]);
  expect(result.active).toEqual({ column: 0, row: 0 });
});

// vim refuses to close the last window, and a chat client with no conversation
// on screen is a chat list and nothing else.
test('the last pane does not close', () => {
  const result = closePane({ grid: createGrid(), active: { column: 0, row: 0 }, conversation: conversation() });

  expect(result.closed).toBe(false);
  expect(countPanes({ grid: result.grid })).toBe(1);
});

test('closing never leaves the focus pointing at nothing', () => {
  const result = closePane({
    grid: gridOf([['a'], ['b', 'c']]), active: { column: 0, row: 0 }, conversation: conversation(),
  });

  expect(paneAt({ grid: result.grid, at: result.active })).not.toBeNull();
});

// ── sizing ────────────────────────────────────────────────────────────────

// Every cell accounted for: a remainder left over is a stripe of unpainted
// frame down the right-hand side.
test('space is shared exactly, remainder to the first slots', () => {
  expect(shareEvenly({ total: 100, count: 3 })).toEqual([34, 33, 33]);
  expect(shareEvenly({ total: 100, count: 1 })).toEqual([100]);
  for (const count of [1, 2, 3, 4]) {
    expect(shareEvenly({ total: 137, count }).reduce((sum, part) => sum + part, 0)).toBe(137);
  }
});
