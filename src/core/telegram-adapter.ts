import { Api, utils } from 'telegram';
import type { TelegramClient } from 'telegram';
import { NewMessage } from 'telegram/events';
import type { NewMessageEvent } from 'telegram/events';

import { EntityKinds, type ITelegramEntity, type TEntityKind } from './common/index.ts';
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

// Class names read from node_modules/telegram/tl/api.d.ts rather than
// guessed -- an unrecognised name must map to EntityKinds.UNKNOWN, never
// throw, since a future GramJS version can add entity classes tglow has
// never seen.
const toEntityKind = (opts: { className: string }): TEntityKind => {
  switch (opts.className) {
    case 'MessageEntityBold': { return EntityKinds.BOLD; }
    case 'MessageEntityItalic': { return EntityKinds.ITALIC; }
    case 'MessageEntityUnderline': { return EntityKinds.UNDERLINE; }
    case 'MessageEntityStrike': { return EntityKinds.STRIKE; }
    case 'MessageEntityCode': { return EntityKinds.CODE; }
    case 'MessageEntityPre': { return EntityKinds.PRE; }
    case 'MessageEntitySpoiler': { return EntityKinds.SPOILER; }
    case 'MessageEntityUrl': { return EntityKinds.URL; }
    case 'MessageEntityTextUrl': { return EntityKinds.TEXT_URL; }
    case 'MessageEntityMention': { return EntityKinds.MENTION; }
    case 'MessageEntityHashtag': { return EntityKinds.HASHTAG; }
    default: { return EntityKinds.UNKNOWN; }
  }
};

/** Every MessageEntity* class shares offset/length; only MessageEntityTextUrl also carries a url. */
const toEntity = (opts: { entity: Api.TypeMessageEntity }): ITelegramEntity => {
  const { entity } = opts;
  const kind = toEntityKind({ className: entity.className });
  if ('url' in entity) {
    return { kind, offset: entity.offset, length: entity.length, url: entity.url };
  }
  return { kind, offset: entity.offset, length: entity.length };
};

/**
 * The one place a GramJS Api.Message -- fetched, just sent, or arrived live --
 * becomes an IRawMessage. fetchHistory, send and subscribeToNewMessages all
 * hand their message here rather than building the shape themselves:
 * peerId in particular is derived identically for all three, where before
 * fetchHistory and send trusted their caller's peerId argument and only the
 * live path derived one from the message -- two paths that could silently
 * drift apart from a single edit to either.
 */
const toRawMessage = (opts: { message: Api.Message }): IRawMessage => {
  const { message } = opts;

  // buildDialogAdapter derives a chat's peerId as `String(entity.id)` -- the
  // raw, unmarked id GramJS puts on every User/Chat/Channel entity.
  // utils.getPeerId(peer, false) computes that same unmarked id from a Peer
  // union (PeerUser/PeerChat/PeerChannel), so this always lines up with the
  // peerId buildDialogAdapter produced for the same chat. addMark defaults to
  // true and would instead produce Bot-API-style marked ids (negative for
  // chats, -100-prefixed for channels/supergroups) that never match an entity
  // id -- confirmed by reading node_modules/telegram/Utils.js's getPeerId.
  const peerId = utils.getPeerId(message.peerId, false);

  return {
    id: message.id,
    peerId,
    // fromId is 'me' for anything out, otherwise the chat's own peerId rather
    // than the individual sender -- none of the three call sites has a
    // per-message sender to hand over instead.
    fromId: message.out ? 'me' : peerId,
    date: message.date,
    text: message.message ?? '',
    out: message.out ? 1 : 0,
    entities: (message.entities ?? []).map(entity => toEntity({ entity })),
    replyToMessageId: message.replyTo?.replyToMsgId ?? null,
  };
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
      .map(message => toRawMessage({ message }));
  },

  // GramJS's own SendMessageParams names this `replyTo`, not `replyToMessageId`
  // -- read from node_modules/telegram/client/messages.d.ts rather than
  // guessed, since a wrong name here sends an ordinary message with no error
  // at all, silently dropping the reply.
  send: async (sendOpts: { peerId: string; text: string; replyToMessageId?: number }): Promise<IRawMessage> => {
    const sent = await opts.client.sendMessage(sendOpts.peerId, {
      message: sendOpts.text,
      replyTo: sendOpts.replyToMessageId,
    });
    return toRawMessage({ message: sent });
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
      subscribeOpts.onMessage(toRawMessage({ message: event.message }));
    };

    opts.client.addEventHandler(handleEvent, eventBuilder);
    return (): void => {
      opts.client.removeEventHandler(handleEvent, eventBuilder);
    };
  },
});
