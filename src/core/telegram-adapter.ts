import { getError } from '@venizia/ignis-inversion';
import { Api, utils } from 'teleproto';
import type { TelegramClient } from 'teleproto';
import { NewMessage, Raw } from 'teleproto/events';
import type { NewMessageEvent } from 'teleproto/events';

import { EntityKinds, type ITelegramEntity, type TEntityKind } from './common/index.ts';
import type { IDialogAdapter, IRawDialog } from './dialog-service.ts';
import type { IDifferenceAdapter, IDifferenceResult } from './difference-service.ts';
import type { ILiveMessage, IMessageAdapter, IRawMessage, IReadReceipt } from './message-service.ts';
import type { IUpdateState } from './update-state.ts';

const DIALOG_FETCH_LIMIT = 100;

// A slice means "there is more", so following one is a loop, and a loop over a
// server-controlled condition needs a bound. Reaching it is not an error and
// not a loss: getDifference returns the last intermediate state it actually
// reached, so the next catch-up resumes from exactly there.
const MAXIMUM_DIFFERENCE_SLICES = 100;

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

/** newMessages is TypeMessage -- Message, MessageEmpty and MessageService all -- and only a real Message has text to cache, the same filter fetchHistory applies. */
const toRawMessages = (opts: { messages: Api.TypeMessage[] }): IRawMessage[] => {
  return opts.messages
    .filter((message): message is Api.Message => message.className === 'Message')
    .map(message => toRawMessage({ message }));
};

/**
 * The update classes whose `pts` counts the **account-wide** sequence, read
 * from node_modules/telegram/tl/api.d.ts rather than guessed
 * (`UpdateNewMessage` 3177, `UpdateShortMessage` 5114, `UpdateShortChatMessage`
 * 5142) and cross-checked against the only three branches
 * `NewMessage.build()` can produce a message from (telegram/events/NewMessage.js).
 *
 * `UpdateNewChannelMessage` is the fourth branch and is deliberately absent:
 * its pts numbers that one channel's own sequence, so storing it in the
 * account-wide `sync_state` row would send the next `updates.getDifference` to
 * a position that account never reached. Channels need
 * `updates.getChannelDifference` and a per-channel row, which tglow does not
 * have yet -- so their pts is reported as null and nothing is written, which
 * costs a re-delivery rather than a corrupted state.
 */
const COMMON_PTS_UPDATE_CLASSES: readonly string[] = [
  'UpdateNewMessage',
  'UpdateShortMessage',
  'UpdateShortChatMessage',
];

const toCommonPts = (opts: { update: { className: string } }): number | null => {
  if (!COMMON_PTS_UPDATE_CLASSES.includes(opts.update.className)) {
    return null;
  }
  const { pts } = opts.update as { pts?: number };
  return typeof pts === 'number' ? pts : null;
};

const toUpdateState = (opts: { state: Api.updates.State }): IUpdateState => {
  const { state } = opts;
  return { pts: state.pts, qts: state.qts, date: state.date, seq: state.seq };
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
        // readOutboxMaxId lives only on the raw TL object GramJS's own Dialog
        // wrapper carries at `.dialog` -- unlike pinned/unreadCount/message,
        // it is not promoted onto the wrapper itself (confirmed against
        // node_modules/telegram/tl/custom/dialog.d.ts's own property list,
        // which has no such field, versus node_modules/telegram/tl/api.d.ts's
        // `class Dialog`, which declares `readOutboxMaxId: int` at line 2455).
        readOutboxMaxId: dialog.dialog.readOutboxMaxId ?? 0,
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

  // GramJS's own EditMessageParams names the target `message`, not
  // `messageId` -- read from node_modules/telegram/client/messages.d.ts
  // (interface EditMessageParams, `message: Api.Message | number`, line 176;
  // TelegramClient.editMessage's own declaration at
  // node_modules/telegram/client/TelegramClient.d.ts:563) rather than
  // guessed, the same discipline send's own replyTo comment above follows.
  edit: async (editOpts: { peerId: string; messageId: number; text: string }): Promise<IRawMessage> => {
    const edited = await opts.client.editMessage(editOpts.peerId, {
      message: editOpts.messageId,
      text: editOpts.text,
    });
    return toRawMessage({ message: edited });
  },

  // GramJS's own signature (client.deleteMessages, declared at
  // node_modules/telegram/client/TelegramClient.d.ts:586, backed by the free
  // function at node_modules/telegram/client/messages.d.ts:243-245) takes an
  // array of ids -- `messageIds`, not a single `messageId` -- and expresses
  // "for everyone" through a `revoke` option, not `forEveryone`. Read rather
  // than guessed, the same discipline send's replyTo and edit's message
  // follow above. TelegramClient.d.ts's own doc comment on the declaration
  // (directly above line 586) is explicit that omitting revoke already
  // deletes for everyone by default -- the opposite of the official
  // clients -- and that revoke:false has no effect at all in channels or
  // megagroups, which delete for everyone unconditionally regardless of what
  // is passed. Passing the flag explicitly either way, rather than relying
  // on that default, is what MessageService.delete's own forEveryone decides.
  delete: async (deleteOpts: { peerId: string; messageIds: number[]; forEveryone: boolean }): Promise<void> => {
    // deleteMessages has always taken an array (messages.d.ts declares
    // `messageIds: MessageIDLike[]`); until ranged delete existed this only
    // ever passed one. A `3dd` is one round trip, not three.
    await opts.client.deleteMessages(deleteOpts.peerId, deleteOpts.messageIds, { revoke: deleteOpts.forEveryone });
  },

  // GramJS's own signature (client.markAsRead, declared at
  // node_modules/telegram/client/TelegramClient.d.ts:658, backed by the free
  // function at node_modules/telegram/client/messages.d.ts:253) takes a
  // **max id**, not a set of ids the way delete's messageIds is: the third
  // parameter is MarkAsReadParams (messages.d.ts:213-225), whose `maxId` field
  // is documented right there as "Until which message should the read
  // acknowledge be sent for. This has priority over the `message` parameter" --
  // read from the .d.ts rather than guessed, the same discipline send's
  // replyTo, edit's message and delete's messageIds above each followed.
  // `message` itself is left undefined so maxId is the only thing deciding how
  // far the receipt reaches, matching IMessageAdapter.markRead's own opts.maxId
  // exactly. Confirmed at the implementation too (messages.js:760-787): with
  // markAsReadParams.maxId set, GramJS skips the mention-clearing branch
  // entirely and calls Api.channels.ReadHistory (channels) or
  // Api.messages.ReadHistory (everything else) with that maxId directly.
  markRead: async (markReadOpts: { peerId: string; maxId: number }): Promise<void> => {
    await opts.client.markAsRead(markReadOpts.peerId, undefined, { maxId: markReadOpts.maxId });
  },

  subscribeToNewMessages: (subscribeOpts: { onMessage: (live: ILiveMessage) => void }): (() => void) => {
    // The same builder instance is used to register and unregister: GramJS's
    // removeEventHandler matches on `===` against either the event builder or
    // the callback, and a fresh `new NewMessage({})` would still match on the
    // callback -- but reusing one instance keeps that from being a fact this
    // file has to rely on. No filter options: incoming and outgoing (message.out
    // true, e.g. sent from another device) must both come through.
    const eventBuilder = new NewMessage({});

    // originalUpdate is the update GramJS built this event from -- the only
    // place the account's new pts is carried, since Api.Message itself has no
    // such field. Declared on NewMessageEvent at
    // node_modules/telegram/events/NewMessage.d.ts.
    const handleEvent = (event: NewMessageEvent): void => {
      subscribeOpts.onMessage({
        message: toRawMessage({ message: event.message }),
        pts: toCommonPts({ update: event.originalUpdate }),
      });
    };

    opts.client.addEventHandler(handleEvent, eventBuilder);
    return (): void => {
      opts.client.removeEventHandler(handleEvent, eventBuilder);
    };
  },

  // Raw rather than a typed builder: teleproto ships no event class for a read
  // receipt, so these arrive only on the raw update stream. Registered with a
  // Raw instance for the same reason subscribeToNewMessages reuses its builder
  // -- removeEventHandler matches on `===`.
  //
  // The two classes are NOT interchangeable, which is the whole reason this
  // reads both rather than one (property names read back off constructed
  // instances, not guessed):
  //
  // - UpdateReadHistoryOutbox { peer, maxId, pts, ptsCount } -- users and basic
  //   groups. `peer` is a Peer union, so the unmarked id comes from
  //   utils.getPeerId(peer, false), the same derivation toRawMessage uses.
  // - UpdateReadChannelOutbox { channelId, maxId } -- channels and supergroups.
  //   It carries a bare channelId and NO peer and NO pts. That id is already
  //   unmarked, matching `String(entity.id)` in buildDialogAdapter, so passing
  //   it through getPeerId would be wrong twice over.
  subscribeToReadReceipts: (subscribeOpts: { onReadReceipt: (receipt: IReadReceipt) => void }): (() => void) => {
    const eventBuilder = new Raw({});

    const handleUpdate = (update: Api.TypeUpdate): void => {
      if (update instanceof Api.UpdateReadHistoryOutbox) {
        subscribeOpts.onReadReceipt({
          peerId: utils.getPeerId(update.peer, false),
          maxId: update.maxId,
        });
        return;
      }

      if (update instanceof Api.UpdateReadChannelOutbox) {
        subscribeOpts.onReadReceipt({
          peerId: String(update.channelId),
          maxId: update.maxId,
        });
      }
    };

    opts.client.addEventHandler(handleUpdate, eventBuilder);
    return (): void => {
      opts.client.removeEventHandler(handleUpdate, eventBuilder);
    };
  },
});

/**
 * `updates.getDifference` returns one of four distinct classes, read from
 * node_modules/telegram/tl/api.d.ts (lines 18586-18647) rather than guessed,
 * and three of the four are easy to mistake for each other:
 *
 * - `updates.difference` (18598) carries `newMessages` and a final `state`.
 *   The whole gap fitted in one response; this is the only "done, everything
 *   is here" answer.
 * - `updates.differenceSlice` (18618) carries the same `newMessages` but an
 *   `intermediateState`, not a `state`. It means "there is more" -- ask again
 *   from that intermediate state. Returning here instead of looping would
 *   silently truncate a backfill, and re-asking with the *original* state
 *   would spin on the same slice forever.
 * - `updates.differenceEmpty` (18586) carries only `date` and `seq`. It has no
 *   pts and no qts, so those must be carried over from the request rather than
 *   defaulted -- writing a zero pts here would send the next catch-up back to
 *   the beginning of the account.
 * - `updates.differenceTooLong` (18638) carries only `pts`. The gap was too
 *   large to enumerate; qts/date/seq are likewise carried over, and isTooLong
 *   tells DifferenceService this is not a caught-up state.
 */
export const buildDifferenceAdapter = (opts: { client: TelegramClient }): IDifferenceAdapter => ({
  getState: async (): Promise<IUpdateState> => {
    return toUpdateState({ state: await opts.client.invoke(new Api.updates.GetState()) });
  },

  getDifference: async (differenceOpts: { state: IUpdateState }): Promise<IDifferenceResult> => {
    const messages: IRawMessage[] = [];
    let state = differenceOpts.state;

    for (let attempt = 0; attempt < MAXIMUM_DIFFERENCE_SLICES; attempt += 1) {
      // seq is not a getDifference parameter -- it is carried in IUpdateState
      // only so the stored state stays whole for `updates.getState`'s sake.
      const result = await opts.client.invoke(
        new Api.updates.GetDifference({ pts: state.pts, date: state.date, qts: state.qts }),
      );

      switch (result.className) {
        case 'updates.Difference': {
          messages.push(...toRawMessages({ messages: result.newMessages }));
          return { messages, state: toUpdateState({ state: result.state }), isTooLong: false };
        }
        case 'updates.DifferenceSlice': {
          messages.push(...toRawMessages({ messages: result.newMessages }));
          state = toUpdateState({ state: result.intermediateState });
          break;
        }
        case 'updates.DifferenceEmpty': {
          return { messages, state: { ...state, date: result.date, seq: result.seq }, isTooLong: false };
        }
        case 'updates.DifferenceTooLong': {
          return { messages, state: { ...state, pts: result.pts }, isTooLong: true };
        }
        default: {
          throw getError({ message: '[buildDifferenceAdapter][getDifference] Unrecognised difference result' });
        }
      }
    }

    return { messages, state, isTooLong: false };
  },
});
