import { test, expect } from 'bun:test';

import { describePresence, formatSince, PresenceKinds, presenceMark, type TPresenceKind } from '../../core/presence.ts';

const NOW = 1_700_000_000;

// The coarsest unit that is still true: "3h ago" is what a person wants,
// "187m ago" is the same fact, harder to read.
test('elapsed time reads in the coarsest unit that is still true', () => {
  expect(formatSince({ seconds: 5 })).toBe('just now');
  expect(formatSince({ seconds: 59 })).toBe('just now');
  expect(formatSince({ seconds: 60 })).toBe('1m ago');
  expect(formatSince({ seconds: 3599 })).toBe('59m ago');
  expect(formatSince({ seconds: 3600 })).toBe('1h ago');
  expect(formatSince({ seconds: 90000 })).toBe('1d ago');
});

// Rounds down: claiming more elapsed time than has passed is the wrong
// direction to be wrong in.
test('elapsed time rounds down rather than up', () => {
  expect(formatSince({ seconds: 7140 })).toBe('1h ago');
  expect(formatSince({ seconds: 119 })).toBe('1m ago');
});

test('a nonsense duration says nothing rather than something wrong', () => {
  expect(formatSince({ seconds: -1 })).toBe('');
  expect(formatSince({ seconds: Number.NaN })).toBe('');
});

// Telegram is deliberately vague for anyone who hides their exact last-seen
// time, and tglow does not sharpen it -- inventing a time from "recently"
// would be making it up.
test('a vague status stays vague', () => {
  const at = (kind: Parameters<typeof describePresence>[0]['presence']['kind']): string =>
    describePresence({ presence: { kind, seenAt: null }, now: NOW });

  expect(at(PresenceKinds.RECENTLY)).toBe('last seen recently');
  expect(at(PresenceKinds.LAST_WEEK)).toBe('last seen within a week');
  expect(at(PresenceKinds.LAST_MONTH)).toBe('last seen within a month');
  expect(at(PresenceKinds.LONG_AGO)).toBe('last seen a long time ago');
});

test('online says so, and offline says when', () => {
  expect(describePresence({ presence: { kind: PresenceKinds.ONLINE, seenAt: null }, now: NOW })).toBe('online');
  expect(describePresence({ presence: { kind: PresenceKinds.OFFLINE, seenAt: NOW - 7200 }, now: NOW }))
    .toBe('last seen 2h ago');
});

// A group and a channel have no such thing, and neither does someone tglow
// has never seen a status for. Saying nothing is right; saying "offline"
// would be a claim.
test('a peer with no status says nothing at all', () => {
  expect(describePresence({ presence: { kind: PresenceKinds.UNKNOWN, seenAt: null }, now: NOW })).toBe('');
});

// A clock that disagrees with the server's must not produce "last seen -3m".
test('a last-seen time in the future reads as just now', () => {
  expect(describePresence({ presence: { kind: PresenceKinds.OFFLINE, seenAt: NOW + 500 }, now: NOW }))
    .toBe('last seen just now');
});

// Only the certain case gets a mark. A dot for "recently" would read as a
// weaker online rather than as "we are not being told".
test('only a certain online state is marked', () => {
  expect(presenceMark({ presence: { kind: PresenceKinds.ONLINE, seenAt: null } })).toBe('●');
  const quiet: TPresenceKind[] = [PresenceKinds.RECENTLY, PresenceKinds.OFFLINE, PresenceKinds.UNKNOWN];
  for (const kind of quiet) {
    expect(presenceMark({ presence: { kind, seenAt: null } })).toBe(' ');
  }
});

// One column, always: a mark that changed width would shift every name beside
// it as people come and go.
test('every mark is one column wide', () => {
  const kinds = Object.values(PresenceKinds).filter((kind): kind is TPresenceKind => typeof kind === 'string');
  expect(kinds.length).toBeGreaterThan(0);
  for (const kind of kinds) {
    expect([...presenceMark({ presence: { kind, seenAt: null } })]).toHaveLength(1);
  }
});
