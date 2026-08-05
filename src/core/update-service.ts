import { inject } from '@venizia/ignis-inversion';
import { ApplicationLogger, type ILogger } from '@venizia/ignis-helpers';

import { BindingKeys } from '../common/index.ts';
import type { ApplicationStoreService, IApplicationState } from './application-store.ts';
import type { DatabaseService, IMessageRow } from './cache/index.ts';
import { ReadDirections, type ILiveMessage, type IMessageAdapter, type IRawMessage, type IReadReceipt } from './message-service.ts';
import { advanceUpdateState } from './update-state.ts';

// Mirrors MessageService's SEND_REFRESH_LIMIT and main.ts's HISTORY_LIMIT: the
// page size a live republish shows. UpdateService cannot see the limit
// MessageService's own loadHistory() was last called with -- that is private
// state on a different instance -- so it keeps its own, generous enough for a
// single screen of history.
const MESSAGE_REFRESH_LIMIT = 200;

/**
 * Where a message reached `apply` from. The two are identical downstream --
 * same cache write, same republish -- with exactly one exception, which is why
 * this exists at all: the server's own `unreadCount`, fetched by
 * DialogService.sync() before catch-up runs, already counts every message the
 * difference is about to replay. Counting a backfill again inflates the badge
 * on every launch, and nothing but a later sync ever writes it back down.
 */
export class MessageOrigins {
  static readonly LIVE = 'live';
  static readonly BACKFILL = 'backfill';
}

export type TMessageOrigin = (typeof MessageOrigins)[Exclude<keyof typeof MessageOrigins, 'prototype'>];

export class UpdateService {
  private readonly _logger: ILogger = ApplicationLogger.get(UpdateService.name);

  constructor(
    @inject({ key: BindingKeys.MESSAGE_ADAPTER }) private readonly _adapter: IMessageAdapter,
    @inject({ key: BindingKeys.DATABASE }) private readonly _database: DatabaseService,
    @inject({ key: BindingKeys.APPLICATION_STORE }) private readonly _store: ApplicationStoreService,
  ) {}

  /** The cache returns newest-first; a chat reads oldest-first -- same convention as MessageService.forDisplay. */
  private forDisplay = (opts: { rows: IMessageRow[] }): IMessageRow[] => {
    return [...opts.rows].reverse();
  };

  /**
   * Bumps the message's chat to the top of the dialog list and reflects it in
   * the unread count, using whatever dialog row is already cached (or the
   * zero-valued defaults a chat that has never had a dialogs row would have)
   * as the baseline. Own messages -- out, whether sent from this device or
   * another -- never count as unread, matching Telegram's own convention.
   * readOutboxMaxId is carried over unchanged: a live message event carries no
   * read-receipt information of its own (that is a distinct update type this
   * task does not subscribe to), so only DialogService.sync's own server
   * fetch ever advances it -- same reasoning as pinned, just preserved rather
   * than defaulted forward.
   *
   * A backfill carries the count over untouched for the same reason `out`
   * does: it is already counted. DialogService.sync() writes the server's
   * authoritative unreadCount immediately before catch-up runs (main.ts), and
   * that figure was computed by the server over exactly the messages the
   * difference is now replaying. The ordering fields still move -- a chat that
   * was spoken to while tglow was closed genuinely belongs at the top of the
   * list with that message on it.
   */
  private touchDialog = (opts: { message: IRawMessage; origin: TMessageOrigin }): void => {
    const { message, origin } = opts;
    const existing = this._database.listDialogs().find(dialog => dialog.peerId === message.peerId);
    const carriedOver = existing?.unreadCount ?? 0;
    this._database.upsertDialog({
      peerId: message.peerId,
      pinned: existing?.pinned ?? 0,
      unreadCount: message.out || origin === MessageOrigins.BACKFILL ? carriedOver : carriedOver + 1,
      lastMessageAt: message.date,
      topMessageId: message.id,
      readOutboxMaxId: existing?.readOutboxMaxId ?? 0,
    });
  };

  /**
   * The one path a message takes into the cache and the store, whether it
   * arrived live or was recovered by DifferenceService.catchUp() -- the same
   * reasoning that made toRawMessage the one place a GramJS message becomes an
   * IRawMessage. Two paths would let the same message be cached twice in two
   * shapes.
   *
   * Returns whether the message actually landed. Catch-up needs that answer:
   * it must not advance its stored pts past a message this swallowed, or that
   * message is lost permanently. A live caller has nothing to do with the
   * answer and ignores it.
   */
  apply = (opts: { message: IRawMessage; origin: TMessageOrigin }): boolean => {
    const { message, origin } = opts;
    try {
      // Always, whatever chat it belongs to -- the cache is the only place
      // de-duplication happens, and the chat-list refresh below depends on
      // this having already run.
      this._database.insertMessages({
        messages: [{
          peerId: message.peerId,
          id: message.id,
          fromId: message.fromId,
          date: message.date,
          text: message.text,
          out: message.out,
          entities: message.entities,
          replyToMessageId: message.replyToMessageId,
        }],
      });
      this.touchDialog({ message, origin });

      const state = this._store.getState();
      const patch: Partial<IApplicationState> = { dialogs: this._database.listDialogs() };

      if (message.peerId === state.activePeerId) {
        // Republished from the cache rather than appended to state.messages:
        // a message can arrive mid-loadHistory, and only a cache read keeps
        // ordering and de-duplication correct in that race.
        const nextMessages = this.forDisplay({
          rows: this._database.listMessages({ peerId: message.peerId, limit: MESSAGE_REFRESH_LIMIT }),
        });

        // Follow-if-at-newest: a cursor already on the last message is being
        // used to read live, like a tailing log, so it moves to keep showing
        // the newest arrival. Any other position means the user is reading
        // back through history; the new message is appended after the
        // cursor, so leaving the index untouched leaves it on the same
        // message it was on. `>=` (not `===`) also covers the empty-history
        // case -- messageCursor's initial 0 with zero messages should still
        // count as "at the newest" and follow.
        const wasAtNewest = state.messageCursor >= state.messages.length - 1;
        patch.messages = nextMessages;
        patch.messageCursor = wasAtNewest ? Math.max(nextMessages.length - 1, 0) : state.messageCursor;
      }

      this._store.setState({ patch });
      return true;
    } catch (error) {
      // On the live path this runs on GramJS's event loop, invoked outside any
      // promise chain tglow controls. An error escaping here is not caught by
      // anything upstream -- it becomes an unhandled rejection and ends the
      // process, the same failure mode App's `void onSend(...).catch(...)`
      // exists to avoid on the send path.
      this._logger.for(this.apply.name).error('Could not apply message | Reason: %s', error);
      return false;
    }
  };

  /**
   * The live half of `sync_state`. Before this existed, pts was written only
   * by DifferenceService.catchUp() -- once, at startup -- so it never moved
   * during a session, and the next launch asked for the difference from before
   * the previous session began. Everything received live was re-delivered:
   * messages already read, already acked, each one counted into an unread
   * badge a second time.
   *
   * Gated on apply() having actually returned true, the same invariant
   * catchUp holds for a backfill: advancing past a message the cache refused
   * loses it permanently, because a difference only ever runs forward.
   */
  private receive = (live: ILiveMessage): void => {
    const applied = this.apply({ message: live.message, origin: MessageOrigins.LIVE });
    if (!applied || live.pts === null) {
      return;
    }

    try {
      advanceUpdateState({ database: this._database, pts: live.pts, date: live.message.date });
    } catch (error) {
      // Same reasoning as apply()'s own catch: this runs on GramJS's event
      // loop, so an escaping error is an unhandled rejection. A pts that
      // failed to record costs a re-delivery next launch, not a lost message.
      this._logger.for(this.receive.name).error('Could not record the live update state | Reason: %s', error);
    }
  };

  /**
   * The other side read the chat: every own message at or below `maxId` now
   * shows the read tick instead of the sent tick.
   *
   * Before this existed, readOutboxMaxId was written only by
   * DialogService.sync() at startup, so a tick was frozen at whatever it had
   * been the moment tglow launched -- a message sent and read while you watched
   * kept its single tick until the next launch.
   *
   * No pts is advanced here. UpdateReadChannelOutbox carries none at all, and
   * for the private-chat case the account-wide pts belongs to the update
   * stream, which teleproto is already tracking; writing it from this path
   * would move the stored position for a receipt whose loss costs a stale tick,
   * not a lost message.
   */
  private readReceipt = (receipt: IReadReceipt): void => {
    try {
      if (receipt.direction === ReadDirections.INBOX) {
        // Read somewhere else -- the phone, the desktop app. Nothing about the
        // messages changed; the badge did, and a badge still advertising
        // messages the user already read on their phone is the whole reason
        // this exists.
        this._database.advanceReadInboxMaxId({
          peerId: receipt.peerId,
          maxId: receipt.maxId,
          unreadCount: receipt.stillUnreadCount ?? 0,
        });
        this._store.setState({ patch: { dialogs: this._database.listDialogs() } });
        return;
      }

      this._database.advanceReadOutboxMaxId({ peerId: receipt.peerId, maxId: receipt.maxId });
      // The ticks read from the dialog row (app.tsx passes activeDialog's
      // readOutboxMaxId into MessageView), so republishing the dialog list is
      // what actually redraws them. state.messages is untouched -- no message
      // changed, only what is known about who has seen it.
      this._store.setState({ patch: { dialogs: this._database.listDialogs() } });
    } catch (error) {
      // Same reasoning as apply()'s catch: this runs on teleproto's event loop,
      // where an escaping error becomes an unhandled rejection.
      this._logger.for(this.readReceipt.name).error('Could not apply the read receipt | Reason: %s', error);
    }
  };

  start = (): (() => void) => {
    const stopMessages = this._adapter.subscribeToNewMessages({ onMessage: this.receive });
    const stopReceipts = this._adapter.subscribeToReadReceipts({ onReadReceipt: this.readReceipt });
    return (): void => {
      stopMessages();
      stopReceipts();
    };
  };
}
