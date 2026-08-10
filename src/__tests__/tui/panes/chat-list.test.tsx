import { test, expect } from 'bun:test';

import { rgbToHex } from '@opentui/core';
import type { TestRendererSetup } from '@opentui/core/testing';

import type { IDialogRow } from '../../../core/cache/index.ts';
import { renderWithKeys } from '../../helpers/render.tsx';
import { PresenceKinds, type IPresence, type TPresenceKind } from '../../../core/presence.ts';
import { buildTokens } from '../../../tui/theme/index.ts';
import { measureTextWidth } from '../../../tui/text-width.ts';
import { ChatList, type IChatListProps } from '../../../tui/panes/chat-list.tsx';

const tokens = buildTokens({ paletteName: 'sage' });
/** Mirrors chat-list.tsx's own ROWS_PER_CHAT. */
const ROWS_PER_CHAT = 2;

const dialogs: IDialogRow[] = [
  { peerId: 'u1', title: 'Alice', pinned: 0, unreadCount: 2, lastMessageAt: 300, topMessageId: 9, readOutboxMaxId: 0, readInboxMaxId: 0, preview: null },
  { peerId: 'u2', title: 'Bob', pinned: 0, unreadCount: 0, lastMessageAt: 200, topMessageId: 4, readOutboxMaxId: 0, readInboxMaxId: 0, preview: null },
  { peerId: 'c1', title: 'devs', pinned: 0, unreadCount: 7, lastMessageAt: 100, topMessageId: 2, readOutboxMaxId: 0, readInboxMaxId: 0, preview: null },
];

const toHex = (colour: Parameters<typeof rgbToHex>[0]): string => rgbToHex(colour).toLowerCase();

interface ISpan {
  text: string;
  foreground: string;
  background: string;
  width: number;
}

const readSpans = (renderer: TestRendererSetup, row: number): ISpan[] =>
  (renderer.captureSpans().lines[row]?.spans ?? []).map(span => ({
    text: span.text,
    foreground: toHex(span.fg),
    background: toHex(span.bg),
    width: span.width,
  }));

const readRows = (renderer: TestRendererSetup): string[] => {
  const lines = renderer.captureCharFrame().split('\n');
  return lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;
};

const render = async (
  overrides: Partial<IChatListProps> & { terminalWidth?: number; terminalHeight?: number } = {},
): Promise<TestRendererSetup> => {
  const { terminalWidth, terminalHeight, ...props } = overrides;
  const resolved: IChatListProps = {
    dialogs, cursor: 0, focused: true, tokens, width: 20, height: 10, activePeerId: null, ...props,
  };
  const renderer = await renderWithKeys(<ChatList {...resolved} />, {
    width: terminalWidth ?? resolved.width,
    height: terminalHeight ?? resolved.height,
  });
  await renderer.flush();
  return renderer;
};

test('lists every chat', async () => {
  const frame = (await render()).captureCharFrame();
  expect(frame).toContain('Alice');
  expect(frame).toContain('Bob');
  expect(frame).toContain('devs');
});

// Two rows per chat now: a name and a time, then the preview and the badge.
// A name row is `index * 2`, its second row one below.
const NAME_ROW = (index: number): number => index * ROWS_PER_CHAT;
const PREVIEW_ROW = (index: number): number => index * ROWS_PER_CHAT + 1;

test('each chat takes a name row and a preview row', async () => {
  const rows = readRows(await render());
  expect(rows[NAME_ROW(0)]!).toContain('Alice');
  expect(rows[NAME_ROW(1)]!).toContain('Bob');
  expect(rows[NAME_ROW(2)]!).toContain('devs');
});

test('shows unread counts on the preview row, right-aligned, and nothing at all when zero', async () => {
  const rows = readRows(await render());
  expect(rows[PREVIEW_ROW(0)]!.trimEnd().endsWith('2')).toBe(true);
  expect(rows[PREVIEW_ROW(1)]!.trim()).toBe('');
  expect(rows[PREVIEW_ROW(2)]!.trimEnd().endsWith('7')).toBe(true);
});

test('an unread count is drawn in the unread colour', async () => {
  const spans = readSpans(await render(), PREVIEW_ROW(0));
  const badge = spans[spans.length - 1]!;
  expect(badge.text.trim()).toBe('2');
  expect(badge.foreground).toBe(tokens.chatUnread.toLowerCase());
});

// Replaces the old `▸ Bob` assertion. The owner's neovim sets
// cursorlineopt="both", so position is a background across the row, and the
// column-zero glyph is reserved for something the old build could not express
// at all: which chat is *open*, as distinct from which one the cursor is on.
// The cursorline covers BOTH of a chat's rows: highlighting only the name
// would split one chat visually in half.
test('marks the cursor chat with a cursorline across both its rows, not an arrow', async () => {
  const renderer = await render({ cursor: 1 });
  for (const row of [NAME_ROW(1), PREVIEW_ROW(1)]) {
    const spans = readSpans(renderer, row);
    expect(spans.map(span => span.background), `row ${row}`)
      .toEqual(spans.map(() => tokens.messageCursor.toLowerCase()));
    expect(spans.reduce((total, span) => total + span.width, 0), `row ${row}`).toBe(20);
  }
  expect(renderer.captureCharFrame()).not.toContain('▸');
  expect(readSpans(renderer, NAME_ROW(0)).every(span => span.background !== tokens.messageCursor.toLowerCase()))
    .toBe(true);
});

test('does not mark the cursor row when unfocused', async () => {
  const renderer = await render({ cursor: 1, focused: false });
  expect(readSpans(renderer, 1).every(span => span.background !== tokens.messageCursor.toLowerCase())).toBe(true);
  expect(renderer.captureCharFrame()).not.toContain('▸');
});

// The old build could not tell "cursor is here" from "this chat is open" at
// all -- both were the same arrow, and moving the cursor made the open chat
// unidentifiable.
test('the open chat carries a bar in column zero, wherever the cursor is', async () => {
  const renderer = await render({ cursor: 2, activePeerId: 'u1' });
  const rows = readRows(renderer);
  expect(rows[0]![0]).toBe('▎');
  expect(rows[1]![0]).toBe(' ');
  expect(rows[2]![0]).toBe(' ');
  expect(readSpans(renderer, 0)[0]!.foreground).toBe(tokens.chatActive.toLowerCase());
});

test('no bar at all when no chat is open', async () => {
  expect((await render({ activePeerId: null })).captureCharFrame()).not.toContain('▎');
});

// Final review, Critical 2: the pane rendered every dialog regardless of the
// rows it had, so a chat list longer than the sidebar could not be scrolled
// to -- the cursor moved onto rows that were never drawn.
test('the visible window follows the cursor through a long chat list', async () => {
  const many: IDialogRow[] = Array.from({ length: 40 }, (unused, index) => ({
    peerId: `p${index}`,
    title: `chat${String(index).padStart(2, '0')}`,
    pinned: 0,
    unreadCount: 0,
    lastMessageAt: index,
    topMessageId: index,
    readOutboxMaxId: 0, readInboxMaxId: 0,
    preview: null,
  }));
  const frame = (await render({ dialogs: many, cursor: 39, height: 6, terminalHeight: 10 })).captureCharFrame();
  expect(frame).toContain('chat39');
  expect(frame).not.toContain('chat00');
});

test('renders an empty list without crashing', async () => {
  expect((await render({ dialogs: [] })).captureCharFrame()).toContain('No chats');
});

// The owner's own chat list. Measured with .length these names are two to four
// columns short of what they draw, which slides the unread badge off the pane
// and leaves the column ragged.
test('Vietnamese and CJK names are truncated by column, not by code point', async () => {
  const wide: IDialogRow[] = [
    { peerId: 'v1', title: 'Nguyễn Tấn Phát', pinned: 0, unreadCount: 3, lastMessageAt: 5, topMessageId: 1, readOutboxMaxId: 0, readInboxMaxId: 0, preview: null },
    { peerId: 'v2', title: 'Em Việt Tú'.normalize('NFD'), pinned: 0, unreadCount: 0, lastMessageAt: 4, topMessageId: 1, readOutboxMaxId: 0, readInboxMaxId: 0, preview: null },
    { peerId: 'c2', title: '张伟同学的群聊天室', pinned: 0, unreadCount: 12, lastMessageAt: 3, topMessageId: 1, readOutboxMaxId: 0, readInboxMaxId: 0, preview: null },
    { peerId: 'e1', title: '🔥🔥🔥 hot takes only, no exceptions', pinned: 0, unreadCount: 0, lastMessageAt: 2, topMessageId: 1, readOutboxMaxId: 0, readInboxMaxId: 0, preview: null },
  ];
  const PANE_WIDTH = 22;
  const renderer = await render({
    dialogs: wide, cursor: 0, width: PANE_WIDTH, terminalWidth: PANE_WIDTH, terminalHeight: 10,
  });

  // span.width is the renderer's own column count -- the authority here, and
  // not recoverable from the captured text, which drops trailing cells once a
  // row carries combining marks. Every row of every chat, name and preview
  // alike: a wide name that overflowed would push the time off its own row.
  for (let index = 0; index < wide.length; index += 1) {
    for (const row of [NAME_ROW(index), PREVIEW_ROW(index)]) {
      const spans = readSpans(renderer, row);
      expect({ row, total: spans.reduce((sum, span) => sum + span.width, 0) })
        .toEqual({ row, total: PANE_WIDTH });
    }
  }

  // And the names themselves are what a naive .length would have mismeasured.
  expect(measureTextWidth({ text: wide[2]!.title })).toBe(18);
  expect(renderer.captureCharFrame()).toContain('12');
});

test('a name too long for the pane is ellipsised rather than clipped silently', async () => {
  const rows = readRows(await render({
    dialogs: [{ peerId: 'x', title: 'a name far too long for this sidebar', pinned: 0, unreadCount: 0, lastMessageAt: 1, topMessageId: 1, readOutboxMaxId: 0, readInboxMaxId: 0, preview: null }],
    width: 20,
  }));
  expect(rows[NAME_ROW(0)]!).toContain('…');
  expect(rows[NAME_ROW(0)]!).not.toContain('sidebar');
});

test('an unread count past four digits is abbreviated so the column holds', async () => {
  const rows = readRows(await render({
    dialogs: [{ peerId: 'x', title: 'busy channel', pinned: 0, unreadCount: 12_034, lastMessageAt: 1, topMessageId: 1, readOutboxMaxId: 0, readInboxMaxId: 0, preview: null }],
    width: 20,
  }));
  expect(rows[PREVIEW_ROW(0)]!.trimEnd().endsWith('999+')).toBe(true);
});

// ── the preview row ───────────────────────────────────────────────────────

test('the preview row shows the last thing said', async () => {
  const rows = readRows(await render({
    dialogs: [{ ...dialogs[0]!, preview: 'morning — spec is up' }],
  }));
  expect(rows[PREVIEW_ROW(0)]!).toContain('morning');
});

// A chat the cache has no history for -- most of the list on a first run --
// shows an empty line rather than a placeholder making a claim tglow cannot.
test('a chat with no cached history leaves the preview row blank', async () => {
  const rows = readRows(await render({ dialogs: [{ ...dialogs[1]!, preview: null }] }));
  expect(rows[PREVIEW_ROW(0)]!.trim()).toBe('');
});

// One row per chat, always: a multi-line message must not push the next chat
// down and desynchronise every row index below it.
test('a multi-line message previews only its first line', async () => {
  const rows = readRows(await render({
    dialogs: [{ ...dialogs[0]!, preview: 'first line\nsecond line' }],
  }));
  expect(rows[PREVIEW_ROW(0)]!).toContain('first line');
  expect(rows[PREVIEW_ROW(0)]!).not.toContain('second line');
});

test('the name row carries the time the chat was last spoken in', async () => {
  const at = new Date(2026, 0, 2, 9, 5).getTime() / 1000;
  const rows = readRows(await render({ dialogs: [{ ...dialogs[0]!, lastMessageAt: at }] }));
  expect(rows[NAME_ROW(0)]!).toContain('09:05');
});

test('a chat that has never been spoken in shows no time', async () => {
  const rows = readRows(await render({ dialogs: [{ ...dialogs[0]!, lastMessageAt: 0 }] }));
  expect(rows[NAME_ROW(0)]!).not.toMatch(/\d\d:\d\d/);
});

// The preview is history; a live action is the present, and displaces it.
test('a live typing status displaces the preview', async () => {
  const rows = readRows(await render({
    dialogs: [{ ...dialogs[0]!, preview: 'said this earlier' }],
    typingByPeer: new Map([['u1', { actorId: 'u1', phrase: 'typing…', expiresAt: 5_000 }]]),
    now: 1_000,
  }));
  expect(rows[PREVIEW_ROW(0)]!).toContain('typing…');
  expect(rows[PREVIEW_ROW(0)]!).not.toContain('said this earlier');
});

// A long action is truncated to the pane like any other second-row text,
// rather than pushing the badge off the edge.
test('a long action is truncated to the pane, badge intact', async () => {
  const rows = readRows(await render({
    dialogs: [{ ...dialogs[0]!, preview: null }],
    typingByPeer: new Map([['u1', { actorId: 'u1', phrase: 'recording a voice message', expiresAt: 5_000 }]]),
    now: 1_000,
  }));
  expect(rows[PREVIEW_ROW(0)]!).toContain('recording a');
  expect(rows[PREVIEW_ROW(0)]!).toContain('…');
  expect(rows[PREVIEW_ROW(0)]!.trimEnd().endsWith('2')).toBe(true);
});

test('an expired typing status leaves the preview alone', async () => {
  const rows = readRows(await render({
    dialogs: [{ ...dialogs[0]!, preview: 'said this earlier' }],
    typingByPeer: new Map([['u1', { actorId: 'u1', phrase: 'recording', expiresAt: 1_000 }]]),
    now: 5_000,
  }));
  expect(rows[PREVIEW_ROW(0)]!).toContain('said this');
  expect(rows[PREVIEW_ROW(0)]!).not.toContain('recording');
});

// Two rows per chat means the window holds half as many. Scrolling in
// half-chat steps would strand one row of a chat at the pane's edge.
test('the visible window is measured in chats, not rows', async () => {
  const many: IDialogRow[] = Array.from({ length: 40 }, (unused, index) => ({
    peerId: `p${index}`, title: `chat${String(index).padStart(2, '0')}`, pinned: 0,
    unreadCount: 0, lastMessageAt: index, topMessageId: index, readOutboxMaxId: 0, readInboxMaxId: 0, preview: null,
  }));
  const renderer = await render({ dialogs: many, cursor: 39, height: 6, terminalHeight: 10 });
  const rows = readRows(renderer);

  expect(renderer.captureCharFrame()).toContain('chat39');
  // Six rows hold three chats, not six -- so the row above the last chat's
  // name belongs to the chat before it, never to a chat half off the pane.
  expect(rows[NAME_ROW(0)]!).toContain('chat37');
  expect(rows[NAME_ROW(1)]!).toContain('chat38');
  expect(rows[NAME_ROW(2)]!).toContain('chat39');
});

// ── presence ──────────────────────────────────────────────────────────────

// Before the name, where every client puts it -- next to who the person is,
// not next to when they last spoke.
test('an online chat carries a green dot before its name', async () => {
  const presenceByPeer = new Map<string, IPresence>([['u1', { kind: PresenceKinds.ONLINE, seenAt: null }]]);
  const renderer = await render({ presenceByPeer });
  const row = renderer.captureCharFrame().split('\n').find(line => line.includes('Alice'))!;

  expect(row).toContain('●');
  expect(row.indexOf('●')).toBeLessThan(row.indexOf('Alice'));

  const dot = renderer.captureSpans().lines
    .flatMap(line => line.spans)
    .find(span => span.text.includes('●'));
  expect(rgbToHex(dot!.fg).toLowerCase()).toBe(tokens.presenceOnline.toLowerCase());
});

// Only the certain case. A dot for "recently" would read as a weaker online
// rather than as "we are not being told".
test('a vague or absent status carries no dot', async () => {
  const quiet: TPresenceKind[] = [PresenceKinds.RECENTLY, PresenceKinds.OFFLINE, PresenceKinds.UNKNOWN];
  for (const kind of quiet) {
    const renderer = await render({ presenceByPeer: new Map<string, IPresence>([['u1', { kind, seenAt: null }]]) });
    expect(renderer.captureCharFrame()).not.toContain('●');
  }
  expect((await render({})).captureCharFrame()).not.toContain('●');
});

// The column is always spent: one that appeared and disappeared would shift
// every name in the list as people came and went.
test('names line up whether or not anyone is online', async () => {
  const columnOf = (frame: string): number =>
    frame.split('\n').find(line => line.includes('Alice'))!.indexOf('Alice');

  const quiet = columnOf((await render({})).captureCharFrame());
  const busy = columnOf((await render({
    presenceByPeer: new Map<string, IPresence>([['u1', { kind: PresenceKinds.ONLINE, seenAt: null }]]),
  })).captureCharFrame());

  expect(busy).toBe(quiet);
});
