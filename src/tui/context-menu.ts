import type { IDialogRow, IMessageRow } from '../core/cache/index.ts';
import { extractLinkUrls } from './entities.ts';

/**
 * What a right click offers, and on what.
 *
 * Every item dispatches exactly what its key already dispatches -- the menu is
 * another way to reach an action, never a second implementation of one, and
 * never a way around a confirmation. Choosing Delete still asks y/n, because
 * it goes through the same DELETE_REQUEST `dd` does.
 *
 * Items that do not apply are left out rather than shown greyed. Edit never
 * appears on someone else's message, matching `e`'s own refusal; Copy link
 * appears only when the message actually carries one.
 */
export class MenuActions {
  static readonly REPLY = 'reply';
  static readonly EDIT = 'edit';
  static readonly DELETE = 'delete';
  static readonly YANK = 'yank';
  static readonly COPY_LINK = 'copy-link';
  static readonly OPEN = 'open';
  static readonly MARK_READ = 'mark-read';
}

export type TMenuAction = (typeof MenuActions)[Exclude<keyof typeof MenuActions, 'prototype'>];

export interface IMenuItem {
  action: TMenuAction;
  label: string;
  /** The key that does the same thing, shown beside the label so the menu teaches its own shortcuts. */
  key: string;
}

export const buildMessageMenu = (opts: { message: IMessageRow | undefined }): IMenuItem[] => {
  const { message } = opts;
  if (!message) {
    return [];
  }

  const items: IMenuItem[] = [
    { action: MenuActions.REPLY, label: 'Reply', key: 'r' },
  ];

  // Telegram refuses to edit someone else's message, and EDIT_START refuses
  // too -- offering it here would be offering a refusal.
  if (message.out === 1) {
    items.push({ action: MenuActions.EDIT, label: 'Edit', key: 'e' });
  }

  items.push({ action: MenuActions.YANK, label: 'Yank', key: 'yy' });

  if (extractLinkUrls({ text: message.text, entities: message.entities }).length > 0) {
    items.push({ action: MenuActions.COPY_LINK, label: 'Copy link', key: 'K' });
  }

  // Last, and separated by being last: the only irreversible one.
  items.push({ action: MenuActions.DELETE, label: 'Delete', key: 'dd' });

  return items;
};

export const buildChatMenu = (opts: { dialog: IDialogRow | undefined }): IMenuItem[] => {
  const { dialog } = opts;
  if (!dialog) {
    return [];
  }

  const items: IMenuItem[] = [
    { action: MenuActions.OPEN, label: 'Open', key: '⏎' },
  ];

  // Nothing to mark read in a chat with nothing unread, and offering it would
  // suggest there were.
  if (dialog.unreadCount > 0) {
    items.push({ action: MenuActions.MARK_READ, label: 'Mark read', key: '' });
  }

  return items;
};

/**
 * Where the menu is drawn, kept inside the window.
 *
 * A menu opened near the right edge would otherwise run off it, and one opened
 * near the bottom would be cut short -- so both are pulled back just far
 * enough to fit, which is what every graphical menu does rather than clipping
 * itself.
 */
export const resolveMenuPosition = (opts: {
  x: number;
  y: number;
  width: number;
  height: number;
  windowWidth: number;
  windowHeight: number;
}): { x: number; y: number } => {
  const { x, y, width, height, windowWidth, windowHeight } = opts;
  return {
    x: Math.max(0, Math.min(x, windowWidth - width)),
    y: Math.max(0, Math.min(y, windowHeight - height)),
  };
};

/** The widest label plus its key, plus the padding either side. */
export const resolveMenuWidth = (opts: { items: IMenuItem[] }): number => {
  const widest = opts.items.reduce(
    (widestSoFar, item) => Math.max(widestSoFar, item.label.length + item.key.length),
    0,
  );
  // label + gap + key, inside one column of padding on each side.
  return widest + 4;
};
