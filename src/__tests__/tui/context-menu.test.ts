import { test, expect } from 'bun:test';

import type { IDialogRow, IMessageRow } from '../../core/cache/index.ts';
import { EntityKinds } from '../../core/common/index.ts';
import type { IMenuItem } from '../../tui/context-menu.ts';
import { buildChatMenu, buildMessageMenu, MenuActions, resolveMenuPosition, resolveMenuWidth } from '../../tui/context-menu.ts';

const message = (overrides: Partial<IMessageRow> = {}): IMessageRow => ({
  peerId: 'u1', id: 1, fromId: 'u1', date: 100, text: 'hello', out: 0,
  entities: [], replyToMessageId: null, ...overrides,
});

const dialog = (overrides: Partial<IDialogRow> = {}): IDialogRow => ({
  peerId: 'u1', title: 'Alice', pinned: 0, unreadCount: 0, lastMessageAt: 100,
  topMessageId: 1, readOutboxMaxId: 0, readInboxMaxId: 0, preview: null, ...overrides,
});

const actionsOf = (items: { action: string }[]): string[] => items.map(item => item.action);

// Right-clicking nothing offers nothing. A menu with no target would otherwise
// draw an empty box, or worse, act on whatever the cursor happened to be on.
test('no target means no menu', () => {
  expect(buildMessageMenu({ message: undefined })).toEqual([]);
  expect(buildChatMenu({ dialog: undefined })).toEqual([]);
});

// Every item must dispatch what its key already dispatches, so the key shown
// beside each label is part of the contract, not decoration.
test('every item names the key that does the same thing', () => {
  const items = buildMessageMenu({ message: message({ out: 1 }) });
  expect(items.every(item => item.label.length > 0)).toBe(true);
  expect(items.find(item => item.action === MenuActions.REPLY)?.key).toBe('r');
  expect(items.find(item => item.action === MenuActions.PIN)?.key).toBe('P');
  expect(items.find(item => item.action === MenuActions.DELETE)?.key).toBe('dd');
});

// Telegram refuses to edit someone else's message and EDIT_START refuses too,
// so offering it would be offering a refusal.
test('edit appears only on your own message', () => {
  expect(actionsOf(buildMessageMenu({ message: message({ out: 0 }) }))).not.toContain(MenuActions.EDIT);
  expect(actionsOf(buildMessageMenu({ message: message({ out: 1 }) }))).toContain(MenuActions.EDIT);
});

// Nothing to copy in a message with no link, and offering it would suggest
// there were one.
test('copy link appears only when the message carries one', () => {
  const linked = message({
    text: 'see https://tglow.dev',
    entities: [{ kind: EntityKinds.URL, offset: 4, length: 17 }],
  });
  expect(actionsOf(buildMessageMenu({ message: message() }))).not.toContain(MenuActions.COPY_LINK);
  expect(actionsOf(buildMessageMenu({ message: linked }))).toContain(MenuActions.COPY_LINK);
});

// The one item that cannot be taken back, kept last and alone there -- a
// mis-aimed click lands on something reversible.
test('delete is last', () => {
  const items = buildMessageMenu({ message: message({ out: 1 }) });
  expect(items[items.length - 1]!.action).toBe(MenuActions.DELETE);
});

// The label says what choosing it will do, not what the message currently is.
// "Pin" on an already-pinned message would unpin it while promising the
// opposite.
test('pin reads as unpin once the message is pinned', () => {
  const find = (row: IMessageRow): string | undefined =>
    buildMessageMenu({ message: row }).find(item => item.action === MenuActions.PIN)?.label;

  expect(find(message({ pinned: 0 }))).toBe('Pin');
  expect(find(message())).toBe('Pin');
  expect(find(message({ pinned: 1 }))).toBe('Unpin');
});

// Nothing to mark read in a chat with nothing unread.
test('mark read appears only on a chat with something unread', () => {
  expect(actionsOf(buildChatMenu({ dialog: dialog({ unreadCount: 0 }) }))).not.toContain(MenuActions.MARK_READ);
  expect(actionsOf(buildChatMenu({ dialog: dialog({ unreadCount: 3 }) }))).toContain(MenuActions.MARK_READ);
});

// A menu opened near an edge is pulled back to fit rather than clipped, which
// is what every graphical menu does.
test('a menu near an edge is pulled inside the window', () => {
  const at = (x: number, y: number): { x: number; y: number } =>
    resolveMenuPosition({ x, y, width: 12, height: 6, windowWidth: 80, windowHeight: 24 });

  expect(at(10, 5)).toEqual({ x: 10, y: 5 });
  expect(at(78, 5)).toEqual({ x: 68, y: 5 });
  expect(at(10, 22)).toEqual({ x: 10, y: 18 });
});

// A window smaller than the menu would otherwise place it at a negative
// coordinate, which draws off the left of the screen rather than clipped at
// its edge.
test('a menu wider than the window starts at the edge, not before it', () => {
  expect(resolveMenuPosition({ x: 4, y: 4, width: 30, height: 20, windowWidth: 10, windowHeight: 8 }))
    .toEqual({ x: 0, y: 0 });
});

// Every row is label + gap + key inside one column of padding either side, so
// the width must come from the widest *pair*, not the widest label.
test('the width fits the widest label and key together', () => {
  const items: IMenuItem[] = [
    { action: MenuActions.REPLY, label: 'Reply', key: 'r' },
    { action: MenuActions.DELETE, label: 'Delete', key: 'dd' },
  ];
  expect(resolveMenuWidth({ items })).toBe('Delete'.length + 'dd'.length + 4);
});
