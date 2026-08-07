import { inject } from '@venizia/ignis-inversion';
import { ApplicationLogger, toError, type ILogger } from '@venizia/ignis-helpers';

import { BindingKeys } from '../common/index.ts';
import type { ApplicationStoreService, IApplicationState } from './application-store.ts';
import type { DatabaseService, IMessageRow } from './cache/index.ts';
import type { ITelegramEntity } from './common/index.ts';
import type { ITypingStatus } from './typing-status.ts';

const REPUBLISH_LIMIT = 200;
// Telegram rate-limits ReadHistory the same as everything else; a cursor
// resting on the newest message would otherwise call markRead on every
// keystroke and earn a self-inflicted FLOOD_WAIT.
const MARK_READ_DEBOUNCE_MILLISECONDS = 2000;

export interface IRawMessage {
  id: number;
  peerId: string;
  fromId: string | null;
  date: number;
  text: string;
  out: number;
  entities: ITelegramEntity[];
  replyToMessageId: number | null;
  /** 1 when pinned in its chat. */
  pinned?: number;
}

/**
 * A message as the live update stream| null;
}

/**
 * A message as the live update stream delivers it: the message itself, and the
 * account-wide `pts` the delivering update carried. The pts rides along rather
 * than living on IRawMessage because it belongs to the update, not the
 * message -- a message fetched by `fetchHistory` or returned by `send` has no
 * pts at all.
 *
 * null means "this update carried no pts this account can store": a channel
 * update numbers its own sequence, so writing its pts into the account-wide
 * row would send the next `updates.getDifference` to a position that does not
 * exist there.
 */
export interface ILiveMessage {
  message: IRawMessage;
  pts: number | null;
}

export class ReadDirections {
  /**
   * The other side read this chat up to `maxId`. Every own message at or below
   * it has been seen -- exactly what MessageView's second tick means (see
   * resolveTick in tui/panes/message-view.tsx).
   */
  static readonly OUTBOX = 'outbox';
  /**
   * *This* account read the chat up to `maxId`, somewhere else -- the phone,
   * the desktop app, another terminal. Nothing about the messages changed; what
   * changed is how many of them are still unread, so tglow's badge has to
   * follow or it keeps advertising messages the user has already read.
   */
  static readonly INBOX = 'inbox';
}

export type TReadDirection = (typeof ReadDirections)[Exclude<keyof typeof ReadDirections, 'prototype'>];

export interface IReadReceipt {
  peerId: string;
  maxId: number;
  direction: TReadDirection;
  /**
   * The server's own count of what is still unread, carried only by an inbox
   * update (`UpdateReadHistoryInbox.stillUnreadCount`). Authoritative, and
   * better than subtracting locally: tglow cannot know how many of the
   * messages below `maxId` it had actually counted. Null on the outbox
   * direction, which says nothing about unread state.
   */
  stillUnreadCount: number | null;
}

export interface IMessageAdapter {
  fetchHistory(opts: { peerId: string; limit: number }): Promise<IRawMessage[]>;
  send(opts: { peerId: string; text: string; replyToMessageId?: number }): Promise<IRawMessage>;
  edit(opts: { peerId: string; messageId: number; text: string }): Promise<IRawMessage>;
  delete(opts: { peerId: string; messageIds: number[]; forEveryone: boolean }): Promise<void>;
  markRead(opts: { peerId: string; maxId: number }): Promise<void>;
  pinMessage(opts: { peerId: string; messageId: number; unpin: boolean }): Promise<void>;
  subscribeToNewMessages(opts: { onMessage: (live: ILiveMessage) => void }): () => void;
  subscribeToReadReceipts(opts: { onReadReceipt: (receipt: IReadReceipt) => void }): () => void;
  subscribeToTyping(opts: { onTyping: (status: ITypingStatus) => void }): () => void;
}

export class MessageService {
  private readonly _logger: ILogger = ApplicationLogger.get(MessageService.name);
  // The limit the view is currently displaying, so a republish after send()
  // or edit() shows the same page size loadHistory() last asked for rather
  // than a hardcoded one -- see REPUBLISH_LIMIT, its fallback before
  // loadHistory has ever run.
  private _historyLimit: number | null = null;
  // When markRead last ran for a given peer, keyed so reading one chat can
  // never suppress a mark-read for a different one landing in the same
  // window. Set before the adapter call, not after it resolves: two overlapping
  // calls for the same peer must both see the timestamp already claimed, or
  // both would slip past the check before either finishes.
  private readonly _lastMarkReadAt = new Map<string, number>();

  constructor(
    @inject({ key: BindingKeys.MESSAGE_ADAPTER }) private readonly _adapter: IMessageAdapter,
    @inject({ key: BindingKeys.DATABASE }) private readonly _database: DatabaseService,
    @inject({ key: BindingKeys.APPLICATION_STORE }) private readonly _store: ApplicationStoreService,
  ) {}

  /** The cache returns newest-first; a chat reads oldest-first. */
  private forDisplay = (opts: { rows: IMessageRow[] }): IMessageRow[] => {
    return [...opts.rows].reverse();
  };

  /**
   * Where the cursor goes when a chat opens: the newest message.
   *
   * Which is what "scrolled to the bottom" means here -- the cursor drives the
   * viewport (src/tui/viewport.ts), so there is no separate scroll offset to
   * set. It is also where the unread messages are, and where every other chat
   * client puts you.
   *
   * Set on open rather than left alone, because leaving it alone was worse
   * than merely starting at the top: the cursor carried over from the previous
   * chat, so switching from a long history to a short one left it past the end
   * of the new one, pointing at a message that does not exist. Zero for an
   * empty chat -- a -1 would index before the start of the list everywhere it
   * is read.
   */
  private cursorAtNewest = (opts: { messages: IMessageRow[] }): number =>
    Math.max(0, opts.messages.length - 1);

  loadHistory = async (opts: { peerId: string; limit: number }): Promise<void> => {
    const { peerId, limit } = opts;
    this._historyLimit = limit;

    try {
      const fetched = await this._adapter.fetchHistory({ peerId, limit });
      this._database.insertMessages({
        messages: fetched.map(message => ({
          peerId: message.peerId,
          id: message.id,
          fromId: message.fromId,
          date: message.date,
          text: message.text,
          out: message.out,
          entities: message.entities,
          replyToMessageId: message.replyToMessageId,
          pinned: message.pinned,
        })),
      });
      const messages = this.forDisplay({ rows: this._database.listMessages({ peerId, limit }) });
      this._store.setState({
        patch: {
          messages,
          messageCursor: this.cursorAtNewest({ messages }),
          activePeerId: peerId,
          statusMessage: null,
        },
      });
    } catch (error) {
      this._logger.for(this.loadHistory.name).error('Could not load history | Reason: %s', error);

      // The fallback read must not be able to throw: this catch is the last
      // line of defence, and the caller invokes loadHistory() fire-and-forget,
      // so an escaping error becomes an unhandled rejection rather than a
      // message on screen.
      let cached: IMessageRow[] = this._store.getState().messages;
      try {
        cached = this.forDisplay({ rows: this._database.listMessages({ peerId, limit }) });
      } catch (cacheError) {
        this._logger.for(this.loadHistory.name).error('Cache unreadable | Reason: %s', cacheError);
      }

      // Offline is not an error state for reading — show what we already have,
      // at the bottom of it, exactly as a successful open would.
      this._store.setState({
        patch: {
          messages: cached,
          messageCursor: this.cursorAtNewest({ messages: cached }),
          activePeerId: peerId,
          statusMessage: `Could not load history: ${toError(error).message}`,
        },
      });
    }
  };

  send = async (opts: { peerId: string; text: string; replyToMessageId?: number }): Promise<void> => {
    const { peerId, text, replyToMessageId } = opts;

    if (text.trim() === '') {
      return;
    }

    let sent: IRawMessage;
    try {
      sent = await this._adapter.send({ peerId, text, replyToMessageId });
    } catch (error) {
      this._logger.for(this.send.name).error('Send failed | Reason: %s', error);
      this._store.setState({ patch: { statusMessage: `Send failed: ${toError(error).message}` } });
      return;
    }

    // Snapshotted right after the network round-trip, the only await in this
    // method: only clear the composer if the user has not since typed
    // something new. Losing what they typed next would be exactly the failure
    // this service exists to avoid, even though this particular send succeeded.
    const stillUnchanged = this._store.getState().composerText === text;

    try {
      this._database.insertMessages({
        messages: [{
          peerId: sent.peerId,
          id: sent.id,
          fromId: sent.fromId,
          date: sent.date,
          text: sent.text,
          out: sent.out,
          entities: sent.entities,
          replyToMessageId: sent.replyToMessageId,
        }],
      });

      const patch: Partial<IApplicationState> = {
        messages: this.forDisplay({
          rows: this._database.listMessages({ peerId, limit: this._historyLimit ?? REPUBLISH_LIMIT }),
        }),
        activePeerId: peerId,
        statusMessage: null,
      };
      if (stillUnchanged) {
        patch.composerText = '';
        patch.replyToMessageId = null;
      }
      this._store.setState({ patch });
    } catch (error) {
      // The message already reached Telegram; only the local copy is
      // missing. Reporting this as a send failure would invite the caller to
      // retry, sending a message that already arrived a second time — losing
      // the cache row is recoverable, a duplicate send is not.
      this._logger.for(this.send.name).error('Sent but could not cache | Reason: %s', error);

      const patch: Partial<IApplicationState> = {
        statusMessage: `Sent, but could not save it locally: ${toError(error).message}`,
      };
      if (stillUnchanged) {
        patch.composerText = '';
        patch.replyToMessageId = null;
      }
      this._store.setState({ patch });
    }
  };

  /**
   * Mirrors send() exactly: the adapter call in its own try, the cache write
   * in another, the composer (and the editing state riding alongside it)
   * cleared only on success and only if the user has not since typed
   * something new. insertMessages() upserts on (peerId, id), so writing the
   * edited row back under the same messageId updates it in place rather than
   * appending a second one.
   */
  edit = async (opts: { peerId: string; messageId: number; text: string }): Promise<void> => {
    const { peerId, messageId, text } = opts;

    let edited: IRawMessage;
    try {
      edited = await this._adapter.edit({ peerId, messageId, text });
    } catch (error) {
      this._logger.for(this.edit.name).error('Edit failed | Reason: %s', error);
      this._store.setState({ patch: { statusMessage: `Edit failed: ${toError(error).message}` } });
      return;
    }

    // Same snapshot-after-the-only-await rule as send(): only clear the
    // composer if the user has not since typed something new.
    const stillUnchanged = this._store.getState().composerText === text;

    try {
      this._database.insertMessages({
        messages: [{
          peerId: edited.peerId,
          id: edited.id,
          fromId: edited.fromId,
          date: edited.date,
          text: edited.text,
          out: edited.out,
          entities: edited.entities,
          replyToMessageId: edited.replyToMessageId,
        }],
      });

      const patch: Partial<IApplicationState> = {
        messages: this.forDisplay({
          rows: this._database.listMessages({ peerId, limit: this._historyLimit ?? REPUBLISH_LIMIT }),
        }),
        activePeerId: peerId,
        statusMessage: null,
      };
      if (stillUnchanged) {
        patch.composerText = '';
        patch.editingMessageId = null;
        patch.composerTextBeforeEdit = null;
      }
      this._store.setState({ patch });
    } catch (error) {
      // The edit already reached Telegram; only the local copy is stale.
      // Reporting this as a failed edit would invite a retry -- harmless
      // here (re-editing to the same text is idempotent, unlike a duplicate
      // send) but still not what "failed" should tell the user happened.
      this._logger.for(this.edit.name).error('Edited but could not cache | Reason: %s', error);

      const patch: Partial<IApplicationState> = {
        statusMessage: `Edited, but could not save it locally: ${toError(error).message}`,
      };
      if (stillUnchanged) {
        patch.composerText = '';
        patch.editingMessageId = null;
        patch.composerTextBeforeEdit = null;
      }
      this._store.setState({ patch });
    }
  };

  /**
   * The only irreversible operation in this file. forEveryone is decided
   * here, from state.messages -- the same array DELETE_REQUEST itself
   * resolved messageId from, so the confirmation the user answered and the
   * delete this performs can never disagree about whose message it is.
   * GramJS ignores the flag in channels and megagroups regardless, deleting
   * for everyone unconditionally there.
   *
   * Mirrors send()/edit(): the adapter call in its own try, the cache write
   * in another. Unlike them there is no composerText to protect, so there is
   * no "still unchanged?" guard -- App clears pendingConfirmation the instant
   * CONFIRM is dispatched, before this ever runs, so nothing here depends on
   * whether the network call has resolved yet.
   */
  delete = async (opts: { peerId: string; messageIds: number[] }): Promise<void> => {
    const { peerId, messageIds } = opts;
    if (messageIds.length === 0) {
      return;
    }

    // `revoke` is one flag per API call, but whether a delete can reach the
    // other side is a fact about each message. A range covering both your
    // messages and theirs cannot be sent under either flag honestly, so it
    // goes as two calls -- at most two round trips, never one per message.
    const messages = this._store.getState().messages;
    const own = messageIds.filter(id => messages.find(message => message.id === id)?.out === 1);
    const theirs = messageIds.filter(id => !own.includes(id));

    const deleted: number[] = [];
    let failure: string | null = null;

    for (const batch of [{ ids: own, forEveryone: true }, { ids: theirs, forEveryone: false }]) {
      if (batch.ids.length === 0) {
        continue;
      }
      try {
        await this._adapter.delete({ peerId, messageIds: batch.ids, forEveryone: batch.forEveryone });
        deleted.push(...batch.ids);
      } catch (error) {
        // Recorded rather than rethrown: if your own messages went and theirs
        // did not, the cache still has to lose the ones that actually went, or
        // the view shows messages the server no longer has.
        this._logger.for(this.delete.name).error('Delete failed | Reason: %s', error);
        failure = toError(error).message;
      }
    }

    if (deleted.length === 0) {
      this._store.setState({ patch: { statusMessage: `Delete failed: ${failure}` } });
      return;
    }

    try {
      for (const id of deleted) {
        this._database.deleteMessage({ peerId, id });
      }
      this._store.setState({
        patch: {
          messages: this.forDisplay({
            rows: this._database.listMessages({ peerId, limit: this._historyLimit ?? REPUBLISH_LIMIT }),
          }),
          activePeerId: peerId,
          statusMessage: this.describeDeletion({
            deleted, requested: messageIds.length, own: own.length, failure,
          }),
        },
      });
    } catch (error) {
      // The delete already reached Telegram; only the local copy is stale --
      // the same split send() and edit() draw between a network call that
      // failed and one that succeeded but failed only to cache.
      this._logger.for(this.delete.name).error('Deleted but could not update the cache | Reason: %s', error);
      this._store.setState({
        patch: { statusMessage: `Deleted, but could not update the local cache: ${toError(error).message}` },
      });
    }
  };

  /**
   * What the status line says after a delete. A partial success has to say so:
   * "Deleted for everyone" after two of three went is the status line lying
   * about the one action in tglow that cannot be undone.
   */
  private describeDeletion = (
    opts: { deleted: number[]; requested: number; own: number; failure: string | null },
  ): string => {
    const { deleted, requested, own, failure } = opts;

    if (failure !== null) {
      return `Deleted ${deleted.length} of ${requested}: ${failure}`;
    }
    if (deleted.length === 1) {
      // The wording M1b-1 shipped, kept for the overwhelmingly common case.
      return own === 1 ? 'Deleted for everyone' : 'Deleted for you';
    }
    if (own === deleted.length) {
      return `Deleted ${deleted.length} for everyone`;
    }
    if (own === 0) {
      return `Deleted ${deleted.length} for you`;
    }
    // Mixed: some reached the other side and some did not, so neither phrase
    // is true of the whole set and claiming either would overstate.
    return `Deleted ${deleted.length} messages`;
  };

  /**
   * A call to the server that, once it actually succeeds, also clears the
   * dialog's unread badge locally (spec §3.3: "clears locally and in the chat
   * list") -- the tick shown for an already-sent own message is a separate
   * fact, still driven by the dialog's readOutboxMaxId and still only ever
   * refreshed by DialogService.sync().
   *
   * The clear is unconditional (zero, not a decrement), and it only ever runs
   * after this method's own adapter call resolves -- never from a cursor
   * merely passing over a chat in the list, since nothing but this method and
   * DialogService.sync() ever calls clearUnreadCount/upsertDialog with an
   * unread figure that moves backward. That keeps a message arriving mid-read
   * correct rather than resurrecting whatever the count was before the clear:
   * UpdateService.touchDialog increments from whatever clearUnreadCount just
   * wrote, a real re-read of the cache, not a stale in-memory figure, so a
   * live arrival after the badge clears becomes a fresh, accurate 1 rather
   * than the old count coming back.
   *
   * Deliberately not called from loadHistory(): fetching a chat's history is
   * not the same fact as the user having read it, and the two must stay
   * decoupled so a caller has to ask for this separately, on purpose, once it
   * actually knows the user reached the newest message. See app.tsx's
   * CHAT_OPEN/CURSOR_MOVE/CURSOR_EDGE handling for the two moments that
   * qualify.
   *
   * Debounced per peer rather than per call: App fires this on every
   * qualifying cursor move with no debounce of its own (see app.tsx), relying
   * entirely on this one window so a cursor resting on the newest message
   * cannot hammer the server on every keystroke. A debounced-away call skips
   * both the network round trip and the clear below -- the prior successful
   * call already cleared the count, so there is nothing left to do.
   */
  /**
   * Pin or unpin a message, toggled from whatever tglow currently believes.
   *
   * Unlike delete this asks nothing first: pinning is reversible by the same
   * key that did it, and a confirmation on a reversible action is friction
   * without a purpose. The confirmation exists for the one thing that cannot
   * be taken back.
   *
   * The cache is written only after the server agrees. Marking it pinned
   * optimistically would leave a pin on screen that no other device shows,
   * and the flag arrives on the message itself from then on, so a wrong local
   * value would persist until that chat's history was fetched again.
   */
  pin = async (opts: { peerId: string; messageId: number }): Promise<void> => {
    const { peerId, messageId } = opts;
    const target = this._store.getState().messages.find(message => message.id === messageId);
    const unpin = target?.pinned === 1;

    try {
      await this._adapter.pinMessage({ peerId, messageId, unpin });
    } catch (error) {
      this._logger.for(this.pin.name).error('Pin failed | Reason: %s', error);
      this._store.setState({ patch: { statusMessage: `Pin failed: ${toError(error).message}` } });
      return;
    }

    try {
      this._database.setMessagePinned({ peerId, id: messageId, pinned: unpin ? 0 : 1 });
      this._store.setState({
        patch: {
          messages: this.forDisplay({
            rows: this._database.listMessages({ peerId, limit: this._historyLimit ?? REPUBLISH_LIMIT }),
          }),
          statusMessage: unpin ? 'Unpinned' : 'Pinned',
        },
      });
    } catch (error) {
      // The pin already reached Telegram; only the local copy is stale -- the
      // same split send, edit and delete all draw.
      this._logger.for(this.pin.name).error('Pinned but could not update the cache | Reason: %s', error);
      this._store.setState({
        patch: { statusMessage: `Pinned, but could not update the local cache: ${toError(error).message}` },
      });
    }
  };

  markRead = async (opts: { peerId: string; maxId: number }): Promise<void> => {
    const { peerId, maxId } = opts;
    const now = Date.now();
    const last = this._lastMarkReadAt.get(peerId);
    if (last !== undefined && now - last < MARK_READ_DEBOUNCE_MILLISECONDS) {
      return;
    }
    this._lastMarkReadAt.set(peerId, now);

    try {
      await this._adapter.markRead({ peerId, maxId });
    } catch (error) {
      // Never rethrown: this is attached to whatever read path called it
      // (opening a chat, moving the cursor), and a flaky mark-read must not
      // take that down. The badge stays as it was -- nothing was actually
      // read as far as the server is concerned.
      this._logger.for(this.markRead.name).error('Could not mark read | Reason: %s', error);
      return;
    }

    try {
      this._database.clearUnreadCount({ peerId });
      this._store.setState({ patch: { dialogs: this._database.listDialogs() } });
    } catch (error) {
      // The server has already marked this read; only the local mirror of
      // that fact failed to update. Not rethrown, same reasoning as above.
      this._logger.for(this.markRead.name).error('Could not clear the local unread count | Reason: %s', error);
    }
  };
}
