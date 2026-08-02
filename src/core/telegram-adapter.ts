import type { TelegramClient } from 'telegram';

import type { IDialogAdapter, IRawDialog } from './dialog-service.ts';
import type { IMessageAdapter, IRawMessage } from './message-service.ts';

const DIALOG_FETCH_LIMIT = 100;

const resolvePeerType = (opts: { className: string }): IRawDialog['type'] => {
  switch (opts.className) {
    case 'Channel': {
      return 'channel';
    }
    case 'Chat': {
      return 'chat';
    }
    default: {
      return 'user';
    }
  }
};

/**
 * The only file that knows GramJS object shapes. Every other service depends
 * on `IDialogAdapter`/`IMessageAdapter`, so Tasks 13 and 16 could be tested
 * without a network, and a future transport swap would touch only this file.
 */
export const buildDialogAdapter = (opts: { client: TelegramClient }): IDialogAdapter => ({
  fetchDialogs: async (): Promise<IRawDialog[]> => {
    const dialogs = await opts.client.getDialogs({ limit: DIALOG_FETCH_LIMIT });

    return dialogs.map(dialog => {
      const entity = dialog.entity as { id: unknown; accessHash?: unknown; className: string };
      return {
        peerId: String(entity.id),
        type: resolvePeerType({ className: entity.className }),
        accessHash: entity.accessHash != null ? String(entity.accessHash) : null,
        title: dialog.title ?? dialog.name ?? '(no title)',
        username: null,
        pinned: dialog.pinned ? 1 : 0,
        unreadCount: dialog.unreadCount ?? 0,
        lastMessageAt: dialog.message?.date ?? 0,
        topMessageId: dialog.message?.id ?? 0,
      };
    });
  },
});

export const buildMessageAdapter = (opts: { client: TelegramClient }): IMessageAdapter => ({
  fetchHistory: async (historyOpts: { peerId: string; limit: number }): Promise<IRawMessage[]> => {
    const messages = await opts.client.getMessages(historyOpts.peerId, { limit: historyOpts.limit });

    return messages
      .filter(message => message.className === 'Message')
      .map(message => ({
        id: message.id,
        peerId: historyOpts.peerId,
        fromId: message.out ? 'me' : historyOpts.peerId,
        date: message.date,
        text: message.message ?? '',
        out: message.out ? 1 : 0,
      }));
  },

  send: async (sendOpts: { peerId: string; text: string }): Promise<IRawMessage> => {
    const sent = await opts.client.sendMessage(sendOpts.peerId, { message: sendOpts.text });
    return {
      id: sent.id,
      peerId: sendOpts.peerId,
      fromId: 'me',
      date: sent.date,
      text: sendOpts.text,
      out: 1,
    };
  },
});
