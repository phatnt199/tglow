import { test, expect } from 'bun:test';

import { resolveNextUnread } from '../../core/unread-navigation.ts';
import type { IDialogRow } from '../../core/cache/index.ts';

/** `a2` is a chat named a with two unread; `b` has none. */
const chats = (spec: string): IDialogRow[] =>
  spec.split(' ').filter(Boolean).map(entry => ({
    peerId: entry[0]!,
    title: entry[0]!.toUpperCase(),
    pinned: 0,
    unreadCount: Number(entry.slice(1) || 0),
    lastMessageAt: 0,
    topMessageId: 0,
    readOutboxMaxId: 0,
    readInboxMaxId: 0,
    preview: null,
  }));

const next = (opts: { spec: string; from: number; delta?: number; skipPeerId?: string | null }): number | null =>
  resolveNextUnread({
    dialogs: chats(opts.spec),
    from: opts.from,
    delta: opts.delta ?? 1,
    skipPeerId: opts.skipPeerId ?? null,
  });

test('it finds the next chat with something in it', () => {
  expect(next({ spec: 'a0 b0 c3 d0', from: 0 })).toBe(2);
});

test('it skips over the chats with nothing', () => {
  expect(next({ spec: 'a0 b0 b0 c1', from: 0 })).toBe(3);
});

// Held down, so it has to come round rather than stop at an edge the chat
// list does not really have.
test('it wraps', () => {
  expect(next({ spec: 'a2 b0 c0', from: 2 })).toBe(0);
  expect(next({ spec: 'a2 b0 c0', from: 1 })).toBe(0);
});

test('backwards works the same way', () => {
  expect(next({ spec: 'a1 b0 c0 d1', from: 3, delta: -1 })).toBe(0);
  expect(next({ spec: 'a1 b0 c0 d1', from: 0, delta: -1 })).toBe(3);
});

// Its badge may still say unread -- marking read is a round trip that may not
// have landed -- and taking you back where you already are is never useful.
test('the chat you are already reading is not a destination', () => {
  expect(next({ spec: 'a5 b0 c0', from: 1, skipPeerId: 'a' })).toBeNull();
  expect(next({ spec: 'a5 b0 c2', from: 0, skipPeerId: 'a' })).toBe(2);
});

test('nothing unread anywhere means nowhere to go', () => {
  expect(next({ spec: 'a0 b0 c0', from: 0 })).toBeNull();
});

test('an empty list means nowhere to go', () => {
  expect(next({ spec: '', from: 0 })).toBeNull();
});

// The cursor at the only unread chat, with nothing else: it must not report
// its own position and leave the key doing nothing visible.
test('the only unread chat, already under the cursor, is reported once', () => {
  expect(next({ spec: 'a0 b4 c0', from: 1 })).toBe(1);
  expect(next({ spec: 'a0 b4 c0', from: 1, skipPeerId: 'b' })).toBeNull();
});

// A cursor left pointing past a list that has since shrunk must still start
// somewhere real, rather than wrapping from an imaginary position.
test('a cursor past the end still searches the real list', () => {
  expect(next({ spec: 'a3 b0', from: 99 })).toBe(0);
  expect(next({ spec: 'a3 b0', from: -5 })).toBe(0);
});

test('every chat unread still advances by one', () => {
  expect(next({ spec: 'a1 b1 c1', from: 0 })).toBe(1);
  expect(next({ spec: 'a1 b1 c1', from: 2 })).toBe(0);
});
