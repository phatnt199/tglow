import { test, expect } from 'bun:test';

import {
  FloodWaitRegistry,
  describeTelegramError,
  formatWait,
  parseFloodWaitSeconds,
} from '../../core/telegram-errors.ts';

// ── reading the wait ──────────────────────────────────────────────────────

test('a flood wait yields its seconds, wherever it appears in the message', () => {
  expect(parseFloodWaitSeconds({ message: 'FLOOD_WAIT_30' })).toBe(30);
  expect(parseFloodWaitSeconds({ message: 'RPCError 420: FLOOD_WAIT_420 (caused by SendMessage)' })).toBe(420);
  expect(parseFloodWaitSeconds({ message: 'FLOOD_PREMIUM_WAIT_5' })).toBe(5);
});

test('anything that is not a flood wait yields nothing', () => {
  for (const message of ['CHAT_WRITE_FORBIDDEN', 'FLOOD_WAIT', 'FLOOD_WAIT_x', '', 'network down']) {
    expect(parseFloodWaitSeconds({ message })).toBeNull();
  }
});

// ── saying it ─────────────────────────────────────────────────────────────

test('a wait reads as a duration, rounded up so it never promises too little', () => {
  expect(formatWait({ seconds: 0.2 })).toBe('1s');
  expect(formatWait({ seconds: 30 })).toBe('30s');
  expect(formatWait({ seconds: 59 })).toBe('59s');
  expect(formatWait({ seconds: 90 })).toBe('2m');
  expect(formatWait({ seconds: 3_600 })).toBe('1h');
  expect(formatWait({ seconds: 7_000 })).toBe('2h');
});

// The whole point. "Send failed" invites pressing Enter again, and retrying
// inside the window is what extends it. The message has to say wait.
test('a flood wait is named as a rate limit and tells the user to wait, not retry', () => {
  const message = describeTelegramError({ action: 'Send', message: 'FLOOD_WAIT_30' });

  expect(message).toContain('Rate limited');
  expect(message).toContain('30s');
  expect(message).not.toContain('Send failed');
});

test('the errors a user can act on are said in words', () => {
  expect(describeTelegramError({ action: 'Send', message: 'CHAT_WRITE_FORBIDDEN' }))
    .toBe('Send failed: you cannot write in this chat');
  expect(describeTelegramError({ action: 'Edit', message: 'MESSAGE_EDIT_TIME_EXPIRED' }))
    .toBe('Edit failed: that message is too old to edit');
});

// Anything unrecognised keeps its raw text: a wrong guess about what an error
// means is worse than the error itself.
test('an unknown error keeps its own words', () => {
  expect(describeTelegramError({ action: 'Send', message: 'SOMETHING_NEW_42' }))
    .toBe('Send failed: SOMETHING_NEW_42');
});

// ── holding the next attempt back ─────────────────────────────────────────

const registry = (): FloodWaitRegistry => new FloodWaitRegistry();

test('a flood wait is recorded and reported until it expires', () => {
  const waits = registry();
  expect(waits.record({ peerId: 'p1', message: 'FLOOD_WAIT_30', now: 0 })).toBe(30);

  expect(waits.remaining({ peerId: 'p1', now: 0 })).toBe(30);
  expect(waits.remaining({ peerId: 'p1', now: 29_000 })).toBe(1);
  expect(waits.remaining({ peerId: 'p1', now: 30_000 })).toBeNull();
});

test('an error that is not a flood wait records nothing', () => {
  const waits = registry();
  expect(waits.record({ peerId: 'p1', message: 'CHAT_WRITE_FORBIDDEN', now: 0 })).toBeNull();
  expect(waits.remaining({ peerId: 'p1', now: 0 })).toBeNull();
});

// Conservative on purpose: Telegram reports the wait against the one request
// tglow made, so only that chat is held back.
test('one chat being rate limited does not block another', () => {
  const waits = registry();
  waits.record({ peerId: 'p1', message: 'FLOOD_WAIT_30', now: 0 });

  expect(waits.remaining({ peerId: 'p2', now: 0 })).toBeNull();
});

test('a later, longer wait replaces an earlier one', () => {
  const waits = registry();
  waits.record({ peerId: 'p1', message: 'FLOOD_WAIT_10', now: 0 });
  waits.record({ peerId: 'p1', message: 'FLOOD_WAIT_60', now: 0 });

  expect(waits.remaining({ peerId: 'p1', now: 0 })).toBe(60);
});

test('a success clears the wait', () => {
  const waits = registry();
  waits.record({ peerId: 'p1', message: 'FLOOD_WAIT_30', now: 0 });
  waits.clear({ peerId: 'p1' });

  expect(waits.remaining({ peerId: 'p1', now: 0 })).toBeNull();
});

// Expired entries are forgotten rather than accumulating a row per chat ever
// rate limited in a session.
test('an expired wait is dropped rather than kept', () => {
  const waits = registry();
  waits.record({ peerId: 'p1', message: 'FLOOD_WAIT_1', now: 0 });

  expect(waits.remaining({ peerId: 'p1', now: 5_000 })).toBeNull();
  expect((waits as unknown as { _until: Map<string, number> })._until.size).toBe(0);
});
