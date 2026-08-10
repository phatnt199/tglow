import { test, expect } from 'bun:test';

import {
  MAXIMUM_PANES,
  MINIMUM_CONVERSATION_WIDTH,
  capture,
  closePane,
  createPane,
  cyclePane,
  paneCapacity,
  splitConversationWidth,
  restore,
  splitPane,
  stepPane,
  withActive,
  type IConversationPane,
  type IConversationState,
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
  replyToMessageId: null,
  editingMessageId: null,
  composerTextBeforeEdit: null,
  ...opts,
});

// ── capture and restore ───────────────────────────────────────────────────

// The pair that makes the whole design work: the focused pane's conversation
// stays in the flat state everything already reads, and only moves into a pane
// when the focus leaves it.
test('what is captured from the flat state restores to the same thing', () => {
  const before = conversation({ composerText: 'half a sentence', replyToMessageId: 7 });

  expect(restore({ pane: capture({ conversation: before }) })).toEqual(before);
});

test('a fresh pane holds nothing, and can be pointed at a chat', () => {
  expect(createPane()).toEqual({
    peerId: null, messages: [], messageCursor: 0, composerText: '',
    replyToMessageId: null, editingMessageId: null, composerTextBeforeEdit: null,
  });
  expect(createPane({ peerId: 'p9' }).peerId).toBe('p9');
});

// The focused pane's own slot is stale by construction. Anything drawing every
// pane has to see the live conversation there instead, or the pane you are
// looking at is the one that stops updating.
test('the focused slot is filled in from the flat state, the others left alone', () => {
  const panes: IConversationPane[] = [createPane({ peerId: 'old' }), createPane({ peerId: 'other' })];
  const merged = withActive({ panes, activeIndex: 0, conversation: conversation({ activePeerId: 'live' }) });

  expect(merged[0]!.peerId).toBe('live');
  expect(merged[0]!.messages).toHaveLength(2);
  expect(merged[1]).toBe(panes[1]!);
});

// ── splitting ─────────────────────────────────────────────────────────────

test('splitting opens a second view of the same conversation, to the right and focused', () => {
  const result = splitPane({
    panes: [createPane({ peerId: 'p1' })], activeIndex: 0, capacity: 3, conversation: conversation(),
  });

  expect(result.split).toBe(true);
  expect(result.panes).toHaveLength(2);
  expect(result.activeIndex).toBe(1);
  expect(result.panes[1]!.peerId).toBe('p1');
  expect(result.panes[1]!.messageCursor).toBe(1);
});

test('the new pane lands beside the one that was split, not at the end', () => {
  const panes = [createPane({ peerId: 'a' }), createPane({ peerId: 'b' }), createPane({ peerId: 'c' })];
  const result = splitPane({
    panes, activeIndex: 0, capacity: 4, conversation: conversation({ activePeerId: 'a' }),
  });

  expect(result.panes.map(p => p.peerId)).toEqual(['a', 'a', 'b', 'c']);
});

// Refused rather than silently ignored, so the caller has something to say.
test('splitting past what the width allows is refused, and says so', () => {
  const panes = [createPane(), createPane()];
  const result = splitPane({ panes, activeIndex: 0, capacity: 2, conversation: conversation() });

  expect(result.split).toBe(false);
  expect(result.panes).toHaveLength(2);
  expect(result.activeIndex).toBe(0);
});

test('the hard ceiling holds even when the terminal claims room for more', () => {
  const panes = Array.from({ length: MAXIMUM_PANES }, () => createPane());
  const result = splitPane({ panes, activeIndex: 0, capacity: 99, conversation: conversation() });

  expect(result.split).toBe(false);
  expect(result.panes).toHaveLength(MAXIMUM_PANES);
});

// Splitting has to commit the live conversation into the pane it came from,
// or the original half of the split shows a conversation frozen at whatever it
// held last time focus left it.
test('splitting writes the live conversation into the pane it split from', () => {
  const result = splitPane({
    panes: [createPane({ peerId: 'stale' })], activeIndex: 0, capacity: 3,
    conversation: conversation({ activePeerId: 'live', composerText: 'draft' }),
  });

  expect(result.panes[0]!.peerId).toBe('live');
  expect(result.panes[0]!.composerText).toBe('draft');
});

// ── closing ───────────────────────────────────────────────────────────────

test('closing removes the focused pane and focuses the one on its left', () => {
  const panes = [createPane({ peerId: 'a' }), createPane({ peerId: 'b' }), createPane({ peerId: 'c' })];
  const result = closePane({ panes, activeIndex: 1, conversation: conversation({ activePeerId: 'b' }) });

  expect(result.closed).toBe(true);
  expect(result.panes.map(p => p.peerId)).toEqual(['a', 'c']);
  expect(result.activeIndex).toBe(0);
});

// vim refuses to close the last window, and a chat client with no conversation
// on screen is a chat list and nothing else.
test('the last pane does not close', () => {
  const result = closePane({ panes: [createPane()], activeIndex: 0, conversation: conversation() });

  expect(result.closed).toBe(false);
  expect(result.panes).toHaveLength(1);
});

test('closing the leftmost pane keeps the focus at the left edge', () => {
  const panes = [createPane({ peerId: 'a' }), createPane({ peerId: 'b' })];
  const result = closePane({ panes, activeIndex: 0, conversation: conversation() });

  expect(result.panes.map(p => p.peerId)).toEqual(['b']);
  expect(result.activeIndex).toBe(0);
});

// ── moving between panes ──────────────────────────────────────────────────

test('cycling wraps, which is what makes one key enough to go back and forth', () => {
  expect(cyclePane({ count: 2, activeIndex: 0, delta: 1 })).toBe(1);
  expect(cyclePane({ count: 2, activeIndex: 1, delta: 1 })).toBe(0);
  expect(cyclePane({ count: 3, activeIndex: 0, delta: -1 })).toBe(2);
});

// A left that wraps to the far right is how you lose track of which pane you
// are in -- and stopping is what lets the keymap read "already leftmost" as
// "they meant the sidebar".
test('stepping stops at the ends rather than wrapping', () => {
  expect(stepPane({ count: 3, activeIndex: 0, delta: -1 })).toBe(0);
  expect(stepPane({ count: 3, activeIndex: 2, delta: 1 })).toBe(2);
  expect(stepPane({ count: 3, activeIndex: 1, delta: 1 })).toBe(2);
});

// ── width ─────────────────────────────────────────────────────────────────

test('the width decides how many panes fit, up to the ceiling', () => {
  expect(paneCapacity({ width: MINIMUM_CONVERSATION_WIDTH * 3 })).toBe(3);
  expect(paneCapacity({ width: MINIMUM_CONVERSATION_WIDTH * 2 - 1 })).toBe(1);
  expect(paneCapacity({ width: MINIMUM_CONVERSATION_WIDTH * 99 })).toBe(MAXIMUM_PANES);
});

// A terminal too narrow for the minimum still has to show the conversation.
test('a terminal narrower than one pane still gets one', () => {
  expect(paneCapacity({ width: 10 })).toBe(1);
  expect(paneCapacity({ width: 0 })).toBe(1);
});

// Every column accounted for: a remainder left over is a stripe of unpainted
// frame down the right-hand side.
test('the panes share the width exactly, remainder to the left', () => {
  expect(splitConversationWidth({ width: 100, count: 3 })).toEqual([34, 33, 33]);
  expect(splitConversationWidth({ width: 100, count: 1 })).toEqual([100]);
  for (const count of [1, 2, 3, 4]) {
    const widths = splitConversationWidth({ width: 137, count });
    expect(widths.reduce((total, width) => total + width, 0)).toBe(137);
  }
});
