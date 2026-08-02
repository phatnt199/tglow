import { test, expect } from 'bun:test';

import { rgbToHex } from '@opentui/core';
import type { TestRendererSetup } from '@opentui/core/testing';

import type { IDialogRow } from '../../../core/cache/index.ts';
import { renderWithKeys } from '../../helpers/render.tsx';
import { buildTokens } from '../../../tui/theme/index.ts';
import { measureTextWidth } from '../../../tui/text-width.ts';
import { ChatList, type IChatListProps } from '../../../tui/panes/chat-list.tsx';

const tokens = buildTokens({ paletteName: 'sage' });

const dialogs: IDialogRow[] = [
  { peerId: 'u1', title: 'Alice', pinned: 0, unreadCount: 2, lastMessageAt: 300, topMessageId: 9 },
  { peerId: 'u2', title: 'Bob', pinned: 0, unreadCount: 0, lastMessageAt: 200, topMessageId: 4 },
  { peerId: 'c1', title: 'devs', pinned: 0, unreadCount: 7, lastMessageAt: 100, topMessageId: 2 },
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

test('shows unread counts, right-aligned, and nothing at all when zero', async () => {
  const rows = readRows(await render());
  expect(rows[0]!).toBe(` Alice${' '.repeat(13)}2`);
  expect(rows[1]!.trimEnd()).toBe(' Bob');
  expect(rows[2]!).toBe(` devs${' '.repeat(14)}7`);
});

test('an unread count is drawn in the unread colour', async () => {
  const spans = readSpans(await render(), 0);
  const badge = spans[spans.length - 1]!;
  expect(badge.text.trim()).toBe('2');
  expect(badge.foreground).toBe(tokens.chatUnread.toLowerCase());
});

// Replaces the old `▸ Bob` assertion. The owner's neovim sets
// cursorlineopt="both", so position is a background across the row, and the
// column-zero glyph is reserved for something the old build could not express
// at all: which chat is *open*, as distinct from which one the cursor is on.
test('marks the cursor row with a cursorline, not an arrow', async () => {
  const renderer = await render({ cursor: 1 });
  const spans = readSpans(renderer, 1);
  expect(spans.map(span => span.background)).toEqual(spans.map(() => tokens.messageCursor.toLowerCase()));
  expect(spans.reduce((total, span) => total + span.width, 0)).toBe(20);
  expect(renderer.captureCharFrame()).not.toContain('▸');
  expect(readSpans(renderer, 0).every(span => span.background !== tokens.messageCursor.toLowerCase())).toBe(true);
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
    { peerId: 'v1', title: 'Đức anh hoàng', pinned: 0, unreadCount: 3, lastMessageAt: 5, topMessageId: 1 },
    { peerId: 'v2', title: 'Em Việt Tú'.normalize('NFD'), pinned: 0, unreadCount: 0, lastMessageAt: 4, topMessageId: 1 },
    { peerId: 'c2', title: '张伟同学的群聊天室', pinned: 0, unreadCount: 12, lastMessageAt: 3, topMessageId: 1 },
    { peerId: 'e1', title: '🔥🔥🔥 hot takes only, no exceptions', pinned: 0, unreadCount: 0, lastMessageAt: 2, topMessageId: 1 },
  ];
  const PANE_WIDTH = 22;
  const BADGE_COLUMNS = 4;
  const renderer = await render({ dialogs: wide, cursor: 0, width: PANE_WIDTH, terminalWidth: PANE_WIDTH });

  // span.width is the renderer's own column count -- the authority here, and
  // not recoverable from the captured text, which drops trailing cells once a
  // row carries combining marks.
  for (let row = 0; row < wide.length; row += 1) {
    const spans = readSpans(renderer, row);
    expect({
      row,
      total: spans.reduce((sum, span) => sum + span.width, 0),
      badge: spans[spans.length - 1]!.width,
    }).toEqual({ row, total: PANE_WIDTH, badge: BADGE_COLUMNS });
  }

  // And the names themselves are what a naive .length would have mismeasured.
  expect(measureTextWidth({ text: wide[2]!.title })).toBe(18);
  expect(renderer.captureCharFrame()).toContain('12');
});

test('a name too long for the pane is ellipsised rather than clipped silently', async () => {
  const rows = readRows(await render({
    dialogs: [{ peerId: 'x', title: 'a name far too long for this sidebar', pinned: 0, unreadCount: 0, lastMessageAt: 1, topMessageId: 1 }],
    width: 20,
  }));
  expect(rows[0]!.trimEnd()).toBe(' a name far to…');
});

test('an unread count past four digits is abbreviated so the column holds', async () => {
  const rows = readRows(await render({
    dialogs: [{ peerId: 'x', title: 'busy channel', pinned: 0, unreadCount: 12_034, lastMessageAt: 1, topMessageId: 1 }],
    width: 20,
  }));
  expect(rows[0]!).toBe(' busy channel   999+');
});
