import { utils } from 'telegram';
import type { TelegramClient } from 'telegram';
import { NewMessage } from 'telegram/events';
import type { NewMessageEvent } from 'telegram/events';

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

  subscribeToNewMessages: (subscribeOpts: { onMessage: (message: IRawMessage) => void }): (() => void) => {
    // The same builder instance is used to register and unregister: GramJS's
    // removeEventHandler matches on `===` against either the event builder or
    // the callback, and a fresh `new NewMessage({})` would still match on the
    // callback -- but reusing one instance keeps that from being a fact this
    // file has to rely on. No filter options: incoming and outgoing (message.out
    // true, e.g. sent from another device) must both come through.
    const eventBuilder = new NewMessage({});

    const handleEvent = (event: NewMessageEvent): void => {
      const { message } = event;

      // buildDialogAdapter derives a chat's peerId as `String(entity.id)` --
      // the raw, unmarked id GramJS puts on every User/Chat/Channel entity.
      // utils.getPeerId(peer, false) computes that same unmarked id from a
      // Peer union (PeerUser/PeerChat/PeerChannel), so a live message's
      // peerId lines up with the peerId fetchHistory was called with for the
      // same chat. addMark defaults to true and would instead produce
      // Bot-API-style marked ids (negative for chats, -100-prefixed for
      // channels/supergroups) that never match an entity id -- confirmed by
      // reading node_modules/telegram/Utils.js's getPeerId.
      const peerId = utils.getPeerId(message.peerId, false);

      subscribeOpts.onMessage({
        id: message.id,
        peerId,
        // Mirrors fetchHistory's derivation exactly (see buildMessageAdapter
        // above): fromId is 'me' for anything out, otherwise the chat's own
        // peerId rather than the individual sender -- fetchHistory has no
        // per-message sender either, and disagreeing here would make a live
        // and a fetched copy of the same message look like different people.
        fromId: message.out ? 'me' : peerId,
        date: message.date,
        text: message.message ?? '',
        out: message.out ? 1 : 0,
      });
    };

    opts.client.addEventHandler(handleEvent, eventBuilder);
    return (): void => {
      opts.client.removeEventHandler(handleEvent, eventBuilder);
    };
  },
});
