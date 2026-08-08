import { test, expect } from 'bun:test';

import { INITIAL_ENGINE_STATE } from '../../keys/common/index.ts';
import type { IEngineState } from '../../keys/common/index.ts';
import { Operators } from '../../keys/common/index.ts';
import {
  buildShowcmd, fitGroups, formatConnection, formatPeerKind, formatProgress, joinSegments,
  PHRASE_SEPARATOR, READOUT_SEPARATOR, StatusTones, type IStatusSegment,
} from '../../tui/status-segments.ts';

const engine = (overrides: Partial<IEngineState> = {}): IEngineState => ({
  ...INITIAL_ENGINE_STATE, ...overrides,
});

const segment = (text: string, priority: number): IStatusSegment =>
  ({ text, priority, tone: StatusTones.DIM });

// ── showcmd ───────────────────────────────────────────────────────────────

// vim's own order, and the reason the field exists: a `d` waiting for a motion
// and a `"` waiting for a register name both look, from the outside, exactly
// like a key that was ignored.
test('showcmd reads register, count, operator and pending keys, in that order', () => {
  expect(buildShowcmd({ engine: engine() })).toBe('');
  expect(buildShowcmd({ engine: engine({ pending: ['g'] }) })).toBe('g');
  expect(buildShowcmd({ engine: engine({ count: 12 }) })).toBe('12');
  expect(buildShowcmd({ engine: engine({ operator: Operators.DELETE }) })).toBe('d');
  expect(buildShowcmd({
    engine: engine({ register: 'a', operatorCount: 2, operator: Operators.DELETE, count: 3 }),
  })).toBe('"a3d');
});

// A multi-character token is one token however many characters it takes to
// write, and pending holds tokens -- joining them with anything between would
// show a sequence the user never typed.
test('showcmd joins pending tokens with nothing between them', () => {
  expect(buildShowcmd({ engine: engine({ pending: ['<escape>', 'g'] }) })).toBe('<escape>g');
});

// ── progress ──────────────────────────────────────────────────────────────

test('progress reads as vim\'s ruler does', () => {
  expect(formatProgress({ position: 0, total: 0 })).toBe('');
  expect(formatProgress({ position: 1, total: 1 })).toBe('All');
  expect(formatProgress({ position: 1, total: 200 })).toBe('Top');
  expect(formatProgress({ position: 200, total: 200 })).toBe('Bot');
  expect(formatProgress({ position: 100, total: 199 })).toBe('50%');
});

// A cursor one message past the end (or before the start) is a bug elsewhere,
// but it must not print "104%" while that bug is being found.
test('progress stays inside its own scale', () => {
  expect(formatProgress({ position: 400, total: 200 })).toBe('Bot');
  expect(formatProgress({ position: -3, total: 200 })).toBe('Top');
});

// ── connection ────────────────────────────────────────────────────────────

// The good case must not draw the eye, and a mark that is always there draws
// it every time while saying nothing -- so the healthy connection shows
// nothing at all. It also has to: the online dot is the same glyph and sits
// right after it, and `● ● Alice` is two identical marks meaning unrelated
// things.
test('a healthy connection is not marked at all', () => {
  expect(formatConnection({ connection: 'connected' }).text).toBe('');
});

test('only a connection worth noticing is coloured to be noticed', () => {
  expect(formatConnection({ connection: 'connecting' }).tone).toBe(StatusTones.ACCENT);
  expect(formatConnection({ connection: 'offline' }).tone).toBe(StatusTones.ALERT);
});

// One column each, or the field would shift the title as the state changed.
test('every connection mark that is drawn is one column wide', () => {
  for (const connection of ['connecting', 'offline'] as const) {
    expect([...formatConnection({ connection }).text]).toHaveLength(1);
  }
});

// ── peer kind ─────────────────────────────────────────────────────────────

// A DM is the unremarkable case, and tagging it says nothing while costing
// columns. Bot is checked before type, because a bot is also a user.
test('only a chat that is not an ordinary DM is tagged', () => {
  expect(formatPeerKind({ kind: undefined })).toBe('');
  expect(formatPeerKind({ kind: { type: 'user', isBot: false } })).toBe('');
  expect(formatPeerKind({ kind: { type: 'user', isBot: true } })).toBe('bot');
  expect(formatPeerKind({ kind: { type: 'channel', isBot: false } })).toBe('channel');
  expect(formatPeerKind({ kind: { type: 'group', isBot: false } })).toBe('group');
});

// ── fitting ───────────────────────────────────────────────────────────────

/** One group, the common case, with no join to charge for. */
const fitOne = (segments: IStatusSegment[], width: number): { texts: string[]; width: number } => {
  const fitted = fitGroups({
    groups: [{ segments, separator: PHRASE_SEPARATOR, joinWidth: 0 }], width,
  });
  return { texts: fitted.groups[0]!.segments.map(item => item.text), width: fitted.width };
};

test('everything stays when everything fits', () => {
  const fitted = fitOne([segment('one', 10), segment('two', 20)], 40);
  expect(fitted.texts).toEqual(['one', 'two']);
  // 3 + 3 + one separator.
  expect(fitted.width).toBe(9);
});

// An empty segment is an absent one, not a zero-width one -- otherwise it
// still charges for the separator that would have joined it.
test('empty segments are dropped before anything is measured', () => {
  const fitted = fitOne([segment('', 10), segment('kept', 20)], 40);
  expect(fitted.texts).toEqual(['kept']);
  expect(fitted.width).toBe(4);
});

// One at a time, lowest first: dropping a whole priority band would throw away
// a one-column segment to save a ten-column one it happened to share a number
// with.
test('the cheapest goes first, and only as many as it takes', () => {
  expect(fitOne([segment('keep', 90), segment('drop', 10), segment('also', 50)], 12).texts)
    .toEqual(['keep', 'also']);
});

test('a width too small for even one segment leaves nothing', () => {
  const fitted = fitOne([segment('wide', 90)], 2);
  expect(fitted.texts).toEqual([]);
  expect(fitted.width).toBe(0);
});

// Ties break toward the later segment, so a group written in reading order
// loses its tail first -- the same way the eye gives it up.
test('a tie is broken toward the end of the group', () => {
  expect(fitOne([segment('aa', 50), segment('bb', 50)], 2).texts).toEqual(['aa']);
});

// The bug this API exists to fix: fitting one group first and giving the rest
// what remained let the line's cheapest segment outlive an expensive one in
// another group, purely by being measured earlier.
test('priority holds across groups, not only within one', () => {
  // Five columns: room for one of them, and the two together want nine.
  const fitted = fitGroups({
    width: 5,
    groups: [
      { segments: [segment('cheap', 10)], separator: PHRASE_SEPARATOR, joinWidth: 0 },
      { segments: [segment('dear', 90)], separator: READOUT_SEPARATOR, joinWidth: 0 },
    ],
  });

  expect(fitted.groups[0]!.segments).toEqual([]);
  expect(fitted.groups[1]!.segments.map(item => item.text)).toEqual(['dear']);
});

// A group that loses its last member gives back the separator that joined it
// to the title, or the line pays for a dot it never draws.
test('a group that empties stops charging for its join', () => {
  const groups = [{ segments: [segment('gone', 10)], separator: PHRASE_SEPARATOR, joinWidth: 3 }];

  expect(fitGroups({ groups, width: 7 }).width).toBe(7);
  expect(fitGroups({ groups, width: 6 }).width).toBe(0);
});

// ── joining ───────────────────────────────────────────────────────────────

// Separators come out as their own spans rather than folded into the text
// beside them, so a red over-limit count cannot drag the dot in front of it
// red as well.
test('separators are spans of their own, between neighbours only', () => {
  const joined = joinSegments({
    segments: [
      { text: 'Alice', tone: StatusTones.PLAIN, priority: 1 },
      { text: '2 unread', tone: StatusTones.ACCENT, priority: 1 },
    ],
    separator: PHRASE_SEPARATOR,
  });

  expect(joined).toEqual([
    { text: 'Alice', tone: StatusTones.PLAIN },
    { text: PHRASE_SEPARATOR, tone: StatusTones.DIM },
    { text: '2 unread', tone: StatusTones.ACCENT },
  ]);
});

test('one segment joins to nothing', () => {
  const joined = joinSegments({
    segments: [{ text: 'Alice', tone: StatusTones.PLAIN, priority: 1 }],
    separator: PHRASE_SEPARATOR,
  });
  expect(joined).toHaveLength(1);
});
