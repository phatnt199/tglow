import { inject } from '@venizia/ignis-inversion';
import { ApplicationLogger, type ILogger } from '@venizia/ignis-helpers';

import { BindingKeys } from '../common/index.ts';
import type { ApplicationStoreService, IApplicationState } from './application-store.ts';
import type { DatabaseService, IMessageRow } from './cache/index.ts';
import { HISTORY_PAGE_SIZE, ReadDirections, type ILiveMessage, type IMessageAdapter, type IRawMessage, type IReadReceipt } from './message-service.ts';
import type { IPresence } from './presence.ts';
import type { IMessageReaction } from './reactions.ts';
import { TYPING_STATUS_TTL_MS, type ITypingStatus } from './typing-status.ts';
import { advanceChannelPts, advanceUpdateState } from './update-state.ts';

/**
 * How much of the chat a live arrival republishes: everything already on
 * screen, plus room for the arrival itself.
 *
 * Taken from the store rather than a constant of its own. UpdateService cannot
 * see MessageService's private window size, but both write to the same
 * `messages` array, and its length *is* that window -- so this cannot drift
 * from it the way a second hardcoded number did.
 *
 * A fixed limit is actively wrong now the conversation pages: 200 would expand
 * a freshly opened 50-message window to 200 on the first message anyone sends,
 * and would silently truncate a window the user had scrolled back further than
 * that -- leaving messageCursor pointing past the end of the list it indexes.
 */
const resolveRefreshLimit = (opts: { loaded: number }): number =>
  Math.max(opts.loaded + 1, HISTORY_PAGE_SIZE);

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
  /** Per-peer expiry timers for typing statuses, replaced on every renewal. */
  private readonly _typingTimers = new Map<string, ReturnType<typeof setTimeout>>();

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
  private touchDialog = (opts: { message: IRawMessage; origin: TMessageOrigin; reading: boolean }): void => {
    const { message, origin, reading } = opts;
    const existing = this._database.listDialogs().find(dialog => dialog.peerId === message.peerId);
    const carriedOver = existing?.unreadCount ?? 0;
    // `reading` is the third thing that does not count, alongside a message
    // the user sent and one a backfill is replaying: it arrived in the chat
    // they have open, at the bottom, where the cursor is following. Counting
    // that was why the badge climbed on the one chat they were demonstrably
    // reading -- which is what "it does not mark as read" looked like from
    // the outside.
    const counted = !message.out && origin !== MessageOrigins.BACKFILL && !reading;
    this._database.upsertDialog({
      peerId: message.peerId,
      pinned: existing?.pinned ?? 0,
      unreadCount: counted ? carriedOver + 1 : reading ? 0 : carriedOver,
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
      // Read before touchDialog, because whether this counts as unread
      // depends on where the cursor was *before* the message arrived.
      const state = this._store.getState();
      const atNewest = state.messageCursor >= state.messages.length - 1;
      const reading = origin === MessageOrigins.LIVE
        && message.peerId === state.activePeerId
        && atNewest
        && !message.out;

      this.touchDialog({ message, origin, reading });

      // Told to Telegram too, or the chat stays unread on every other device
      // and the next launch's sync puts the badge straight back.
      if (reading) {
        void this._adapter.markRead({ peerId: message.peerId, maxId: message.id })
          .catch(error => {
            this._logger.for('apply').error('Could not mark the open chat read | Reason: %s', error);
          });
      }

      const patch: Partial<IApplicationState> = { dialogs: this._database.listDialogs() };

      if (message.peerId === state.activePeerId) {
        // Republished from the cache rather than appended to state.messages:
        // a message can arrive mid-loadHistory, and only a cache read keeps
        // ordering and de-duplication correct in that race.
        const nextMessages = this.forDisplay({
          rows: this._database.listMessages({
            peerId: message.peerId,
            limit: resolveRefreshLimit({ loaded: state.messages.length }),
          }),
        });

        // Follow-if-at-newest: a cursor already on the last message is being
        // used to read live, like a tailing log, so it moves to keep showing
        // the newest arrival. Any other position means the user is reading
        // back through history; the new message is appended after the
        // cursor, so leaving the index untouched leaves it on the same
        // message it was on. `>=` (not `===`) also covers the empty-history
        // case -- messageCursor's initial 0 with zero messages should still
        // count as "at the newest" and follow.
        patch.messages = nextMessages;
        patch.messageCursor = atNewest ? Math.max(nextMessages.length - 1, 0) : state.messageCursor;
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
    if (!applied) {
      return;
    }

    // A channel's own pts, in its own row. This is what lets the next launch
    // ask updates.getChannelDifference where it left off rather than never
    // backfilling that channel at all.
    if (live.channelPts !== null) {
      try {
        advanceChannelPts({ database: this._database, ...live.channelPts });
      } catch (error) {
        this._logger.for(this.receive.name).error('Could not record the channel pts | Reason: %s', error);
      }
    }

    if (live.pts === null) {
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

  /**
   * "typing…", "choosing a sticker", "recording a voice message".
   *
   * Each status carries its own expiry and is also cleared by a timer, because
   * Telegram sends no "still typing" heartbeat this could count on and no stop
   * signal it could rely on arriving. A status left behind by someone who
   * closed their app would otherwise sit there permanently -- a claim about the
   * present that has quietly become false, which is worse than never showing
   * one at all.
   *
   * The timer is keyed per peer and replaced on every renewal, so someone
   * typing continuously stays "typing…" rather than flickering every six
   * seconds as an older timer fires under a newer status.
   */
  private typing = (status: ITypingStatus): void => {
    try {
      const existing = this._typingTimers.get(status.peerId);
      if (existing !== undefined) {
        clearTimeout(existing);
        this._typingTimers.delete(status.peerId);
      }

      const typingByPeer = new Map(this._store.getState().typingByPeer);

      // A cancel is a stop signal, not an activity: it clears rather than
      // announcing itself.
      if (status.phrase === null) {
        typingByPeer.delete(status.peerId);
        this._store.setState({ patch: { typingByPeer } });
        return;
      }

      typingByPeer.set(status.peerId, {
        actorId: status.actorId,
        phrase: status.phrase,
        expiresAt: Date.now() + TYPING_STATUS_TTL_MS,
      });
      this._store.setState({ patch: { typingByPeer } });

      const timer = setTimeout(() => {
        this._typingTimers.delete(status.peerId);
        const current = new Map(this._store.getState().typingByPeer);
        // Only if nothing newer replaced it. Without this check a renewal that
        // landed a moment ago would be cleared by the previous status's timer.
        if ((current.get(status.peerId)?.expiresAt ?? 0) <= Date.now()) {
          current.delete(status.peerId);
          this._store.setState({ patch: { typingByPeer: current } });
        }
      }, TYPING_STATUS_TTL_MS);
      // Never keep the process alive for a status nobody is waiting on.
      timer.unref?.();
      this._typingTimers.set(status.peerId, timer);
    } catch (error) {
      // Same reasoning as apply()'s catch: this runs on teleproto's event loop.
      this._logger.for(this.typing.name).error('Could not apply the typing status | Reason: %s', error);
    }
  };

  /**
   * Someone's online state changed.
   *
   * Cached as well as published: presence is the one thing a restart should
   * not forget entirely -- "last seen 2h ago" stays true across a restart,
   * where showing nothing would read as "we have never heard of them".
   *
   * No expiry timer, unlike typing. An online state is replaced by the next
   * update rather than going stale on its own, and "last seen 3m ago" simply
   * becomes "last seen 4m ago" as the clock moves -- the render computes the
   * difference, so it ages correctly with no timer at all.
   */
  /**
   * A reaction tally changed, by anyone.
   *
   * Republished only when it is the open chat: a reaction on a message in some
   * other conversation still belongs in the cache -- it will be right when
   * that chat is opened -- but redrawing the one on screen for it would be
   * redrawing something that has not changed.
   */
  private reactions = (change: { peerId: string; messageId: number; reactions: IMessageReaction[] }): void => {
    try {
      this._database.setMessageReactions({
        peerId: change.peerId, id: change.messageId, reactions: change.reactions,
      });
      const state = this._store.getState();
      if (change.peerId !== state.activePeerId) {
        return;
      }
      this._store.setState({
        patch: {
          messages: this.forDisplay({
            rows: this._database.listMessages({
              peerId: change.peerId,
              limit: resolveRefreshLimit({ loaded: state.messages.length }),
            }),
          }),
        },
      });
    } catch (error) {
      this._logger.for('reactions').error('Could not record a reaction change | Reason: %s', error);
    }
  };

  private presence = (change: { peerId: string; presence: IPresence }): void => {
    try {
      this._database.setPeerPresence(change);
      const next = new Map(this._store.getState().presenceByPeer);
      next.set(change.peerId, change.presence);
      this._store.setState({ patch: { presenceByPeer: next } });
    } catch (error) {
      this._logger.for('presence').error('Could not record a presence change | Reason: %s', error);
    }
  };

  start = (): (() => void) => {
    const stopMessages = this._adapter.subscribeToNewMessages({ onMessage: this.receive });
    const stopReceipts = this._adapter.subscribeToReadReceipts({ onReadReceipt: this.readReceipt });
    const stopTyping = this._adapter.subscribeToTyping({ onTyping: this.typing });
    const stopPresence = this._adapter.subscribeToPresence({ onPresence: this.presence });
    const stopReactions = this._adapter.subscribeToReactions({ onReactions: this.reactions });
    return (): void => {
      stopMessages();
      stopReceipts();
      stopTyping();
      stopPresence();
      stopReactions();
      for (const timer of this._typingTimers.values()) {
        clearTimeout(timer);
      }
      this._typingTimers.clear();
    };
  };
}
