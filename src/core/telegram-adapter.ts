import { getError } from '@venizia/ignis-inversion';
import { Api, utils } from 'teleproto';
import type { TelegramClient } from 'teleproto';
import { NewMessage, Raw } from 'teleproto/events';
import type { NewMessageEvent } from 'teleproto/events';

import { EntityKinds, type ITelegramEntity, type TEntityKind } from './common/index.ts';
import type { IDialogAdapter, IRawDialog } from './dialog-service.ts';
import type { IChannelDifferenceResult, IDifferenceAdapter, IDifferenceResult } from './difference-service.ts';
import { ReadDirections, type ILiveMessage, type IMessageAdapter, type IRawMessage, type IReadReceipt } from './message-service.ts';
import type { IFolderAdapter, IRawFolder } from './folder-service.ts';
import { MediaKinds, type IMessageMedia } from './media.ts';
import { PresenceKinds, type IPresence } from './presence.ts';
import { CUSTOM_REACTION_PLACEHOLDER, type IMessageReaction } from './reactions.ts';
import { resolveTypingPhrase, type ITypingStatus } from './typing-status.ts';
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
/**
 * The largest size Telegram offers for a photo, for its dimensions alone.
 *
 * `sizes` is a mixed union -- PhotoSize, PhotoSizeProgressive, PhotoStrippedSize
 * and PhotoCachedSize -- and only some members carry `w`/`h`. Filtered by the
 * presence of the fields rather than by className, so a size type added in a
 * later layer contributes if it has dimensions and is ignored if it does not,
 * instead of being a crash or a silent zero.
 */
const largestPhotoSize = (opts: { photo: Api.TypePhoto | undefined }): { width: number; height: number } | null => {
  const { photo } = opts;
  if (!photo || photo.className !== 'Photo') {
    return null;
  }
  const sized = photo.sizes
    .map(size => size as unknown as { w?: number; h?: number })
    .filter((size): size is { w: number; h: number } => typeof size.w === 'number' && typeof size.h === 'number');
  const largest = sized.reduce<{ w: number; h: number } | null>(
    (best, size) => (best === null || size.w * size.h > best.w * best.h ? size : best),
    null,
  );
  return largest === null ? null : { width: largest.w, height: largest.h };
};

/**
 * A document's kind, from its attributes.
 *
 * Order matters and is not arbitrary: a sticker is also a file, a GIF carries
 * both Animated and Video, and a voice message is an Audio with `voice` set.
 * Checking generic before specific would label every one of them "File".
 */
const toDocumentMedia = (opts: { document: Api.TypeDocument }): IMessageMedia => {
  const { document } = opts;
  if (document.className !== 'Document') {
    return { kind: MediaKinds.UNSUPPORTED };
  }

  const attributes = document.attributes;
  const find = <T extends Api.TypeDocumentAttribute['className']>(className: T) =>
    attributes.find(attribute => attribute.className === className);

  const size = typeof document.size === 'number' ? document.size : Number(document.size);
  const fileName = find('DocumentAttributeFilename');
  const named = fileName?.className === 'DocumentAttributeFilename' ? fileName.fileName : undefined;

  const sticker = find('DocumentAttributeSticker');
  if (sticker?.className === 'DocumentAttributeSticker') {
    return { kind: MediaKinds.STICKER, emoji: sticker.alt };
  }

  const video = find('DocumentAttributeVideo');
  const videoDuration = video?.className === 'DocumentAttributeVideo' ? video.duration : undefined;

  if (find('DocumentAttributeAnimated')) {
    return { kind: MediaKinds.ANIMATION, duration: videoDuration, size };
  }

  const audio = find('DocumentAttributeAudio');
  if (audio?.className === 'DocumentAttributeAudio') {
    return audio.voice
      ? { kind: MediaKinds.VOICE, duration: audio.duration, size }
      : {
        kind: MediaKinds.AUDIO,
        duration: audio.duration,
        size,
        // A track with a performer reads as "Artist — Title", which is how
        // every player names one; either alone is still better than the file
        // name, and the file name is still better than nothing.
        title: audio.title && audio.performer
          ? `${audio.performer} — ${audio.title}`
          : audio.title ?? audio.performer ?? named,
      };
  }

  if (video?.className === 'DocumentAttributeVideo') {
    return { kind: MediaKinds.VIDEO, duration: video.duration, width: video.w, height: video.h, size };
  }

  return { kind: MediaKinds.DOCUMENT, title: named, size };
};

/**
 * What a message carries besides its text, or null when it carries nothing.
 *
 * A web page preview returns null on purpose: the link it previews is already
 * in the message text and already rendered as a link, so announcing it again
 * would put "🔗 Web page" under every URL anyone sends.
 */
const toMedia = (opts: { media: Api.TypeMessageMedia | undefined }): IMessageMedia | null => {
  const { media } = opts;
  if (!media) {
    return null;
  }

  switch (media.className) {
    case 'MessageMediaPhoto': {
      return { kind: MediaKinds.PHOTO, ...largestPhotoSize({ photo: media.photo }) };
    }
    case 'MessageMediaDocument': {
      return media.document ? toDocumentMedia({ document: media.document }) : { kind: MediaKinds.UNSUPPORTED };
    }
    case 'MessageMediaWebPage': {
      return null;
    }
    case 'MessageMediaGeo':
    case 'MessageMediaGeoLive': {
      return { kind: MediaKinds.LOCATION };
    }
    case 'MessageMediaVenue': {
      return { kind: MediaKinds.LOCATION, title: media.title };
    }
    case 'MessageMediaContact': {
      return { kind: MediaKinds.CONTACT, title: `${media.firstName} ${media.lastName}`.trim() };
    }
    case 'MessageMediaPoll': {
      // `question` became a TextWithEntities in a later layer -- read from
      // teleproto's own Poll rather than assumed to still be a string.
      return { kind: MediaKinds.POLL, title: media.poll.question.text };
    }
    default: {
      return { kind: MediaKinds.UNSUPPORTED };
    }
  }
};

/**
 * The reaction tallies on a message, newest layer's shape.
 *
 * `chosenOrder` is how Telegram says "you reacted with this one" -- it is the
 * position among your own reactions, so zero is a real value and `undefined`
 * is the absent one. `!== undefined` rather than a truthiness check, which
 * would read your first reaction as not yours.
 */
const toReactions = (opts: { reactions: Api.MessageReactions | undefined }): IMessageReaction[] => {
  const { reactions } = opts;
  if (!reactions) {
    return [];
  }
  return reactions.results.map(result => ({
    emoji: result.reaction.className === 'ReactionEmoji'
      ? result.reaction.emoticon
      : CUSTOM_REACTION_PLACEHOLDER,
    count: result.count,
    chosen: result.chosenOrder !== undefined,
  }));
};

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
    // A flag on the message itself, so it arrives with every fetch and every
    // live delivery -- no separate lookup, and the marker cannot disagree with
    // the server about a message already on screen.
    pinned: message.pinned ? 1 : 0,
    media: toMedia({ media: message.media }),
    reactions: toReactions({ reactions: message.reactions }),
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
 * a position that account never reached. It is reported separately, as
 * ILiveMessage.channelPts, and stored in a row of that channel's own --
 * see toChannelPts below and DifferenceService.catchUpChannels.
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

/**
 * A channel message's own pts, paired with the channel it counts for.
 *
 * `UpdateNewChannelMessage` is the only class here: the short forms above are
 * account-wide by construction, and a channel's sequence only ever advances
 * through its own updates.
 */
const toChannelPts = (opts: { update: { className: string }; peerId: string }): { peerId: string; pts: number } | null => {
  if (opts.update.className !== 'UpdateNewChannelMessage') {
    return null;
  }
  const { pts } = opts.update as { pts?: number };
  return typeof pts === 'number' ? { peerId: opts.peerId, pts } : null;
};

/**
 * The messages a channel difference carries, whichever shape it came back in.
 *
 * ChannelDifferenceTooLong has no newMessages at all -- it carries a Dialog
 * and the channel's newest messages instead -- so it reports `tooLong` and
 * lets the caller refetch rather than pretending to have recovered a range.
 */
const toChannelDifferenceResult = (
  opts: { difference: Api.updates.TypeChannelDifference },
): IChannelDifferenceResult => {
  const { difference } = opts;
  switch (difference.className) {
    case 'updates.ChannelDifference': {
      return {
        messages: toRawMessages({ messages: difference.newMessages }),
        pts: difference.pts,
        final: difference.final ?? true,
        tooLong: false,
      };
    }
    case 'updates.ChannelDifferenceTooLong': {
      // `dialog` carries the channel's current pts; a Dialog (not
      // DialogFolder) is the only member that has one.
      const pts = difference.dialog.className === 'Dialog' ? difference.dialog.pts ?? 0 : 0;
      return { messages: [], pts, final: true, tooLong: true };
    }
    default: {
      return { messages: [], pts: difference.pts, final: true, tooLong: false };
    }
  }
};

/** How many messages one channel difference call asks for. Telegram's own cap for a non-bot account. */
const CHANNEL_DIFFERENCE_LIMIT = 100;

/** Telegram counts in seconds; JavaScript counts in milliseconds. */
const MILLISECONDS_PER_SECOND = 1000;

/**
 * A user's status, as tglow stores it.
 *
 * `UserStatusOnline.expires` is when the online state runs out, not when it
 * began -- so an "online" whose expiry is already past is really offline, and
 * saying otherwise would leave a green dot beside someone who left. Read from
 * teleproto's own UserStatusOnline rather than assumed to be a "since".
 */
const toPresence = (opts: { status: Api.TypeUserStatus | undefined; now: number }): IPresence => {
  const { status, now } = opts;
  switch (status?.className) {
    case 'UserStatusOnline': {
      return status.expires > now
        ? { kind: PresenceKinds.ONLINE, seenAt: null }
        : { kind: PresenceKinds.OFFLINE, seenAt: status.expires };
    }
    case 'UserStatusOffline': {
      return { kind: PresenceKinds.OFFLINE, seenAt: status.wasOnline };
    }
    case 'UserStatusRecently': {
      return { kind: PresenceKinds.RECENTLY, seenAt: null };
    }
    case 'UserStatusLastWeek': {
      return { kind: PresenceKinds.LAST_WEEK, seenAt: null };
    }
    case 'UserStatusLastMonth': {
      return { kind: PresenceKinds.LAST_MONTH, seenAt: null };
    }
    case 'UserStatusEmpty': {
      return { kind: PresenceKinds.LONG_AGO, seenAt: null };
    }
    default: {
      return { kind: PresenceKinds.UNKNOWN, seenAt: null };
    }
  }
};

const toUpdateState = (opts: { state: Api.updates.State }): IUpdateState => {
  const { state } = opts;
  return { pts: state.pts, qts: state.qts, date: state.date, seq: state.seq };
};

/**
 * A folder's peer lists arrive as InputPeer unions, which carry the raw id on a
 * different field per variant. `utils.getPeerId(peer, false)` resolves all of
 * them to the same unmarked id `buildDialogAdapter` produces from an entity, so
 * membership can be decided by string comparison against a cached dialog.
 */
const toFolderPeerIds = (opts: { peers: Api.TypeInputPeer[] }): string[] => {
  return opts.peers
    .map(peer => {
      try {
        return utils.getPeerId(peer, false);
      } catch {
        // InputPeerEmpty, InputPeerSelf and the from-message variants carry no
        // id this can resolve. Dropping one costs that peer its place in the
        // folder; throwing would cost the whole rail.
        return null;
      }
    })
    .filter((id): id is string => id !== null);
};

/**
 * The only file that knows GramJS object shapes. Every other service depends
 * on `IDialogAdapter`/`IMessageAdapter`, so Tasks 13 and 16 could be tested
 * without a network, and a future transport swap would touch only this file.
 */
export const buildDialogAdapter = (opts: { client: TelegramClient }): IDialogAdapter => ({
  // `pinned` is a plain flag rather than a position: Telegram keeps the order
  // of pinned chats separately (ReorderPinnedDialogs), and pinning appends.
  //
  // The peer goes in as an entity, not wrapped in an InputDialogPeer. The TL
  // schema says InputDialogPeer -- this call can also pin a folder, which is
  // another member of that union -- but GramJS types the argument as
  // EntityLike and does the wrapping itself, so passing the wrapper is a type
  // error rather than the faithful thing it looks like.
  pinDialog: async (pinOpts: { peerId: string; pinned: boolean }): Promise<void> => {
    await opts.client.invoke(new Api.messages.ToggleDialogPin({
      peer: pinOpts.peerId,
      pinned: pinOpts.pinned,
    }));
  },

  fetchDialogs: async (): Promise<IRawDialog[]> => {
    const dialogs = await opts.client.getDialogs({ limit: DIALOG_FETCH_LIMIT });
    // One clock for the whole batch: an "online" that expires mid-loop would
    // otherwise read differently for two chats fetched in the same call.
    const now = Math.floor(Date.now() / MILLISECONDS_PER_SECOND);

    return dialogs.map(dialog => {
      const entity = dialog.entity as {
        id: unknown; accessHash?: unknown; className: string; status?: Api.TypeUserStatus;
      };
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
        presence: toPresence({ status: entity.status, now }),
      };
    });
  },
});

export const buildMessageAdapter = (opts: { client: TelegramClient }): IMessageAdapter => ({
  // `offsetId` is GramJS's own name for "only messages older than this one",
  // and it is exclusive -- read from node_modules/teleproto/client/messages.d.ts
  // (IterMessagesParams: "Offset message ID (only messages previous to the
  // given ID will be retrieved). Exclusive."), not guessed. Zero means no
  // offset, which is what the newest-page call wants, and is also GramJS's own
  // default -- so the two cases differ only in the number.
  fetchHistory: async (historyOpts: { peerId: string; limit: number; beforeId?: number }): Promise<IRawMessage[]> => {
    const messages = await opts.client.getMessages(historyOpts.peerId, {
      limit: historyOpts.limit,
      offsetId: historyOpts.beforeId ?? 0,
    });

    return messages
      .filter(message => message.className === 'Message')
      .map(message => toRawMessage({ message }));
  },

  /**
   * One reaction at a time, replacing whatever this account had on the message
   * -- which is what `reaction: []` means and what taking one back looks like.
   *
   * The reply is an Updates, and the tallies come back inside an
   * UpdateMessageReactions in it. Read from the reply rather than assumed:
   * other people react between the press and its answer, so echoing back what
   * was sent would show a count that was already stale. A reply that carries
   * no such update leaves the tallies alone rather than clearing them.
   */
  react: async (reactOpts: { peerId: string; messageId: number; emoji: string }): Promise<IMessageReaction[]> => {
    const result = await opts.client.invoke(new Api.messages.SendReaction({
      peer: reactOpts.peerId,
      msgId: reactOpts.messageId,
      reaction: reactOpts.emoji === ''
        ? []
        : [new Api.ReactionEmoji({ emoticon: reactOpts.emoji })],
    }));

    const updates = 'updates' in result && Array.isArray(result.updates) ? result.updates : [];
    const changed = updates.find(
      (update): update is Api.UpdateMessageReactions => update.className === 'UpdateMessageReactions',
    );
    return changed ? toReactions({ reactions: changed.reactions }) : [];
  },

  /**
   * GramJS's forwardMessages takes the target first and the source in the
   * options, which is the opposite order to the TL call it builds -- read
   * from node_modules/teleproto/client/messages.d.ts rather than guessed,
   * since the two peers are the same type and swapping them would forward the
   * wrong way with no error at all.
   */
  forward: async (forwardOpts: { fromPeerId: string; toPeerId: string; messageIds: number[] }): Promise<void> => {
    await opts.client.forwardMessages(forwardOpts.toPeerId, {
      messages: forwardOpts.messageIds,
      fromPeer: forwardOpts.fromPeerId,
    });
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

  /**
   * A file from disk. GramJS decides photo-or-document from the extension
   * unless forceDocument is set, which is why a .jpg arrives as a picture and
   * a .pdf as an attachment -- read from
   * node_modules/teleproto/client/uploads.d.ts (SendFileInterface).
   *
   * An empty caption is passed as undefined rather than '': GramJS sends the
   * empty string as a caption, which Telegram then stores, and a photo with a
   * zero-length caption is not the same thing as a photo with none.
   */
  sendFile: async (
    fileOpts: { peerId: string; path: string; caption: string; replyToMessageId?: number },
  ): Promise<IRawMessage> => {
    const sent = await opts.client.sendFile(fileOpts.peerId, {
      file: fileOpts.path,
      caption: fileOpts.caption === '' ? undefined : fileOpts.caption,
      replyTo: fileOpts.replyToMessageId,
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
  /**
   * Pin or unpin a message. `unpin` is a flag on the same request rather than a
   * second method, which is how Telegram models it -- and `silent` is left off
   * so pinning notifies the chat the way it does everywhere else.
   */
  pinMessage: async (pinOpts: { peerId: string; messageId: number; unpin: boolean }): Promise<void> => {
    await opts.client.invoke(new Api.messages.UpdatePinnedMessage({
      peer: pinOpts.peerId,
      id: pinOpts.messageId,
      unpin: pinOpts.unpin,
    }));
  },

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
      const message = toRawMessage({ message: event.message });
      subscribeOpts.onMessage({
        message,
        pts: toCommonPts({ update: event.originalUpdate }),
        channelPts: toChannelPts({ update: event.originalUpdate, peerId: message.peerId }),
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
          direction: ReadDirections.OUTBOX,
          stillUnreadCount: null,
        });
        return;
      }

      if (update instanceof Api.UpdateReadChannelOutbox) {
        subscribeOpts.onReadReceipt({
          peerId: String(update.channelId),
          maxId: update.maxId,
          direction: ReadDirections.OUTBOX,
          stillUnreadCount: null,
        });
        return;
      }

      // The inbox pair: this account read the chat somewhere else. Both carry
      // the server's own stillUnreadCount, which is what the badge becomes --
      // tglow cannot compute it locally, since it does not know how many of
      // the messages below maxId it had counted in the first place.
      if (update instanceof Api.UpdateReadHistoryInbox) {
        subscribeOpts.onReadReceipt({
          peerId: utils.getPeerId(update.peer, false),
          maxId: update.maxId,
          direction: ReadDirections.INBOX,
          stillUnreadCount: update.stillUnreadCount,
        });
        return;
      }

      if (update instanceof Api.UpdateReadChannelInbox) {
        subscribeOpts.onReadReceipt({
          peerId: String(update.channelId),
          maxId: update.maxId,
          direction: ReadDirections.INBOX,
          stillUnreadCount: update.stillUnreadCount,
        });
      }
    };

    opts.client.addEventHandler(handleUpdate, eventBuilder);
    return (): void => {
      opts.client.removeEventHandler(handleUpdate, eventBuilder);
    };
  },

  // "typing…", "choosing a sticker", "recording a voice message". Three update
  // classes, and the peer is derived differently from each -- read off
  // constructed instances rather than guessed:
  //
  // - UpdateUserTyping    { userId, action }              a private chat: the
  //   actor IS the chat, so peerId and actorId are the same id.
  // - UpdateChatUserTyping    { chatId, fromId, action }  a basic group.
  // - UpdateChannelUserTyping { channelId, fromId, action } a channel or
  //   supergroup.
  //
  // The last two carry the chat and the actor separately, which is what lets a
  // group say *who* is typing rather than just that someone is.
  /**
   * Online-state changes, which Telegram pushes unprompted for anyone in the
   * chat list.
   *
   * `now` is read per update rather than once: these arrive minutes apart, and
   * an UserStatusOnline whose expiry has already passed by the time it lands
   * is genuinely someone who has left.
   */
  /**
   * Reaction tallies, as anyone changes them.
   *
   * The whole set arrives every time rather than a delta, which is why the
   * cache replaces wholesale -- and why a message whose last reaction was
   * removed arrives with an empty results list rather than not arriving.
   */
  subscribeToReactions: (
    subscribeOpts: {
      onReactions: (change: { peerId: string; messageId: number; reactions: IMessageReaction[] }) => void;
    },
  ): (() => void) => {
    const eventBuilder = new Raw({});
    const handleUpdate = (update: Api.TypeUpdate): void => {
      if (!(update instanceof Api.UpdateMessageReactions)) {
        return;
      }
      subscribeOpts.onReactions({
        peerId: utils.getPeerId(update.peer, false),
        messageId: update.msgId,
        reactions: toReactions({ reactions: update.reactions }),
      });
    };

    opts.client.addEventHandler(handleUpdate, eventBuilder);
    return (): void => {
      opts.client.removeEventHandler(handleUpdate, eventBuilder);
    };
  },

  subscribeToPresence: (
    subscribeOpts: { onPresence: (change: { peerId: string; presence: IPresence }) => void },
  ): (() => void) => {
    const eventBuilder = new Raw({});
    const handleUpdate = (update: Api.TypeUpdate): void => {
      if (!(update instanceof Api.UpdateUserStatus)) {
        return;
      }
      subscribeOpts.onPresence({
        peerId: String(update.userId),
        presence: toPresence({
          status: update.status,
          now: Math.floor(Date.now() / MILLISECONDS_PER_SECOND),
        }),
      });
    };

    opts.client.addEventHandler(handleUpdate, eventBuilder);
    return (): void => {
      opts.client.removeEventHandler(handleUpdate, eventBuilder);
    };
  },

  subscribeToTyping: (subscribeOpts: { onTyping: (status: ITypingStatus) => void }): (() => void) => {
    const eventBuilder = new Raw({});

    const resolveActor = (fromId: Api.TypePeer | undefined, fallback: string): string => {
      if (!fromId) {
        return fallback;
      }
      try {
        return utils.getPeerId(fromId, false);
      } catch {
        return fallback;
      }
    };

    const handleUpdate = (update: Api.TypeUpdate): void => {
      if (update instanceof Api.UpdateUserTyping) {
        const peerId = String(update.userId);
        subscribeOpts.onTyping({
          peerId,
          actorId: peerId,
          phrase: resolveTypingPhrase({ className: update.action.className }),
        });
        return;
      }

      if (update instanceof Api.UpdateChatUserTyping) {
        const peerId = String(update.chatId);
        subscribeOpts.onTyping({
          peerId,
          actorId: resolveActor(update.fromId, peerId),
          phrase: resolveTypingPhrase({ className: update.action.className }),
        });
        return;
      }

      if (update instanceof Api.UpdateChannelUserTyping) {
        const peerId = String(update.channelId);
        subscribeOpts.onTyping({
          peerId,
          actorId: resolveActor(update.fromId, peerId),
          phrase: resolveTypingPhrase({ className: update.action.className }),
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
  /**
   * One channel's difference, from that channel's own pts.
   *
   * ChannelMessagesFilterEmpty asks for everything: tglow caches a channel's
   * messages the same way it caches any other chat's, so filtering here would
   * mean a cache that silently disagrees with the server about what the
   * channel contains.
   */
  getChannelDifference: async (
    channelOpts: { peerId: string; pts: number },
  ): Promise<IChannelDifferenceResult> => {
    const difference = await opts.client.invoke(new Api.updates.GetChannelDifference({
      channel: await opts.client.getInputEntity(channelOpts.peerId),
      filter: new Api.ChannelMessagesFilterEmpty(),
      pts: channelOpts.pts,
      limit: CHANNEL_DIFFERENCE_LIMIT,
    }));
    return toChannelDifferenceResult({ difference });
  },

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

/**
 * The account's chat folders.
 *
 * `messages.getDialogFilters` returns a `messages.DialogFilters` whose
 * `filters` is a union: `DialogFilter` (an ordinary folder),
 * `DialogFilterDefault` (the "All chats" entry, carrying no fields at all) and
 * `DialogFilterChatlist` (a shared folder link). Only the first is turned into
 * a row -- FolderService synthesises "All" itself, and a chatlist folder has no
 * local membership rules to evaluate.
 *
 * `title` is a `TextWithEntities`, not a string: read from the constructed
 * object rather than guessed, the same discipline send's replyTo and delete's
 * messageIds followed.
 */
export const buildFolderAdapter = (opts: { client: TelegramClient }): IFolderAdapter => ({
  fetchFolders: async (): Promise<IRawFolder[]> => {
    const result = await opts.client.invoke(new Api.messages.GetDialogFilters());
    const filters = (result as unknown as { filters?: Api.TypeDialogFilter[] }).filters ?? [];

    return filters
      .filter((filter): filter is Api.DialogFilter => filter instanceof Api.DialogFilter)
      .map((filter, index) => ({
        id: filter.id,
        title: (filter.title as unknown as { text?: string }).text ?? String(filter.id),
        emoticon: filter.emoticon ?? null,
        // Telegram's own order, kept: the arrangement is the user's, and
        // sorting by id would scramble it.
        ord: index,
        pinnedPeers: toFolderPeerIds({ peers: filter.pinnedPeers ?? [] }),
        includePeers: toFolderPeerIds({ peers: filter.includePeers ?? [] }),
        excludePeers: toFolderPeerIds({ peers: filter.excludePeers ?? [] }),
        contacts: filter.contacts === true,
        nonContacts: filter.nonContacts === true,
        groups: filter.groups === true,
        broadcasts: filter.broadcasts === true,
        bots: filter.bots === true,
        excludeMuted: filter.excludeMuted === true,
        excludeRead: filter.excludeRead === true,
        excludeArchived: filter.excludeArchived === true,
      }));
  },
});
