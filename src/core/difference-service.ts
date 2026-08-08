import { inject } from '@venizia/ignis-inversion';
import { ApplicationLogger, type ILogger } from '@venizia/ignis-helpers';

import { BindingKeys } from '../common/index.ts';
import type { ApplicationStoreService } from './application-store.ts';
import type { DatabaseService } from './cache/index.ts';
import type { IMessageAdapter, IRawMessage } from './message-service.ts';
import { advanceChannelPts, readChannelPts, readUpdateState, writeUpdateState, type IUpdateState } from './update-state.ts';
import { MessageOrigins, type UpdateService } from './update-service.ts';

export interface IDifferenceResult {
  messages: IRawMessage[];
  state: IUpdateState;
  /**
   * The server refused to enumerate the gap (`updates.differenceTooLong`). The
   * state is still safe to store -- it is the server's own -- but the messages
   * in between were never sent, so this is emphatically not "caught up".
   */
  isTooLong: boolean;
}

export interface IDifferenceAdapter {
  getState(): Promise<IUpdateState>;
  getDifference(opts: { state: IUpdateState }): Promise<IDifferenceResult>;
  /**
   * One channel's own difference, from its own pts.
   *
   * `tooLong` means the gap is past what a difference can express; the caller
   * refetches that channel's recent history instead. `final` false means the
   * server has more to give and the call should be repeated from the returned
   * pts.
   */
  getChannelDifference(opts: { peerId: string; pts: number }): Promise<IChannelDifferenceResult>;
}

export interface IChannelDifferenceResult {
  messages: IRawMessage[];
  pts: number;
  final: boolean;
  tooLong: boolean;
}

/**
 * How many chats a too-long recovery re-fetches, and how deep. Bounded on
 * purpose: `listDialogs` is ordered pinned-first then most-recent-first, so
 * these are the chats the user is about to look at, and the rest re-fetch for
 * free the moment they are opened (MessageService.loadHistory always asks the
 * server first). An unbounded sweep would put a hundred round trips in front
 * of the first frame.
 */
const TOO_LONG_REFETCH_CHATS = 20;
/**
 * How many times one channel's difference is asked for before giving up.
 *
 * A difference can come back short of the gap, and the only way to the rest is
 * to ask again from where it stopped. Bounded so a channel that never reports
 * `final` cannot hold the launch open indefinitely -- what is left recovers on
 * the next run, or the moment the chat is opened.
 */
const CHANNEL_DIFFERENCE_ROUNDS = 5;

const TOO_LONG_REFETCH_LIMIT = 50;

/**
 * Recovers the messages that arrived while tglow was closed. Everything it
 * recovers is handed to `UpdateService.apply` -- the same method a live event
 * goes through -- so a backfilled message and a live one are the same message
 * downstream, cached identically and published identically. The one difference
 * it declares is `MessageOrigins.BACKFILL`, which keeps the replay out of the
 * unread counts DialogService.sync() has just fetched from the server.
 */
export class DifferenceService {
  private readonly _logger: ILogger = ApplicationLogger.get(DifferenceService.name);

  constructor(
    @inject({ key: BindingKeys.DIFFERENCE_ADAPTER }) private readonly _adapter: IDifferenceAdapter,
    @inject({ key: BindingKeys.MESSAGE_ADAPTER }) private readonly _messageAdapter: IMessageAdapter,
    @inject({ key: BindingKeys.DATABASE }) private readonly _database: DatabaseService,
    @inject({ key: BindingKeys.APPLICATION_STORE }) private readonly _store: ApplicationStoreService,
    @inject({ key: BindingKeys.UPDATE_SERVICE }) private readonly _updateService: UpdateService,
  ) {}

  /**
   * Spec §3.4's answer to `updates.differenceTooLong`: "drop cached state for
   * that peer and re-fetch history rather than trying to reconcile."
   *
   * The common-space too-long carries no peer -- only a new account-wide pts --
   * so the peers whose history is now suspect are all of them, and the cache's
   * own dialog ordering decides which ones are worth the round trip now. The
   * fetch is authoritative: `fetchHistory` reads the server, and
   * `insertMessages` upserts on (peerId, id), so a range the difference skipped
   * over is filled in rather than reconciled. Nothing is deleted -- the gap is
   * a missing range, not wrong rows, and deleting would leave a user whose
   * network then failed with less than they started with.
   *
   * Cache-only, deliberately: nothing here publishes to the store. main.ts
   * calls loadHistory() straight after catchUp(), and opening any other chat
   * calls it too, so the store is filled from the cache this just refreshed by
   * the paths that already own that job.
   *
   * Never rejects, and never skips a chat because an earlier one failed: each
   * peer's fetch is independent, and a partial recovery is strictly better
   * than none.
   */
  private refetchHistoryAfterTooLong = async (): Promise<void> => {
    const chats = this._database.listDialogs().slice(0, TOO_LONG_REFETCH_CHATS);

    for (const chat of chats) {
      try {
        const fetched = await this._messageAdapter.fetchHistory({
          peerId: chat.peerId,
          limit: TOO_LONG_REFETCH_LIMIT,
        });
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
          })),
        });
      } catch (error) {
        this._logger
          .for(this.refetchHistoryAfterTooLong.name)
          .error('Could not re-fetch history after a too-long difference | Peer: %s | Reason: %s', chat.peerId, error);
      }
    }
  };

  /**
   * Never rejects. A catch-up that fails must degrade to "no backfill", which
   * the next run retries from the same stored state -- so every exit path
   * either stores a state whose messages are already written, or stores
   * nothing at all.
   */
  /**
   * Every channel this account has heard from, recovered from its own pts.
   *
   * Channels are why `updates.getDifference` alone was never enough: each one
   * numbers its own sequence, so the account-wide difference does not carry
   * their messages at all and a channel was simply never backfilled -- close
   * tglow, and whatever a channel posted while it was shut was missing until
   * something else happened to refetch that chat.
   *
   * Only channels with a stored pts are asked about. Without one there is no
   * gap to reason about, and asking from zero would replay the channel's
   * entire history; the first live message from it records the mark that
   * makes the *next* launch recoverable, exactly as the account-wide state
   * bootstraps itself.
   *
   * Never rejects, and never lets one channel's failure stop the next: a
   * partial recovery is strictly better than none, which is the same rule
   * refetchHistoryAfterTooLong already follows.
   */
  private catchUpChannels = async (): Promise<number> => {
    const channels = [...this._database.listPeerKinds()]
      .filter(([, kind]) => kind.type === 'channel')
      .map(([peerId]) => peerId);

    let missed = 0;
    for (const peerId of channels) {
      const stored = readChannelPts({ database: this._database, peerId });
      if (stored === null) {
        continue;
      }

      try {
        let pts = stored;
        // A difference can come back short of the gap ("final: false"), and
        // the only way to the rest is to ask again from where it stopped.
        // Bounded so a channel that never reports final cannot spin here.
        for (let round = 0; round < CHANNEL_DIFFERENCE_ROUNDS; round += 1) {
          const result = await this._adapter.getChannelDifference({ peerId, pts });

          if (result.tooLong) {
            // Past what a difference can express. The channel's recent history
            // is refetched instead, and its pts moves to the server's so the
            // next launch measures from there rather than from a mark that is
            // now meaningless.
            missed += await this.refetchChannel({ peerId });
            advanceChannelPts({ database: this._database, peerId, pts: result.pts });
            break;
          }

          for (const message of result.messages) {
            if (!this._updateService.apply({ message, origin: MessageOrigins.BACKFILL })) {
              missed += 1;
            }
          }

          // Only past what actually landed: advancing over a message the cache
          // refused loses it permanently, since a difference runs forward only.
          if (missed === 0) {
            advanceChannelPts({ database: this._database, peerId, pts: result.pts });
          }
          pts = result.pts;

          if (result.final) {
            break;
          }
        }
      } catch (error) {
        this._logger.for('catchUpChannels').error('Channel %s could not be recovered | Reason: %s', peerId, error);
      }
    }
    return missed;
  };

  /** One channel's recent history, straight from the server, after a too-long gap. */
  private refetchChannel = async (opts: { peerId: string }): Promise<number> => {
    try {
      const fetched = await this._messageAdapter.fetchHistory({
        peerId: opts.peerId,
        limit: TOO_LONG_REFETCH_LIMIT,
      });
      return fetched.reduce(
        (lost, message) =>
          lost + (this._updateService.apply({ message, origin: MessageOrigins.BACKFILL }) ? 0 : 1),
        0,
      );
    } catch (error) {
      this._logger.for('refetchChannel').error('Channel %s could not be refetched | Reason: %s', opts.peerId, error);
      return 0;
    }
  };

  /**
   * The account-wide difference: everything that is not a channel.
   *
   * Split out from catchUp so the channel pass below cannot be skipped. It
   * returns early on several paths -- no stored state, nothing missed, a
   * cache that refused a message -- and a call placed after its try block ran
   * on none of them.
   */
  private catchUpCommon = async (): Promise<void> => {
    try {
      const stored = readUpdateState({ database: this._database });

      if (!stored) {
        // Nothing to recover, because there is no earlier point to recover
        // from. The server's state becomes the mark the *next* run measures
        // its gap against.
        writeUpdateState({ database: this._database, state: await this._adapter.getState() });
        return;
      }

      const difference = await this._adapter.getDifference({ state: stored });

      // Ascending id. The cache is keyed (peerId, id) and upserts, so order
      // cannot change what ends up stored -- but touchDialog takes each
      // message as its chat's new top message and the store's cursor follows
      // the last one applied, so applying newest-first would leave the chat
      // list and the cursor pointing at the wrong message.
      const ordered = [...difference.messages].sort((left, right) => left.id - right.id);

      let appliedEverything = true;
      for (const message of ordered) {
        if (!this._updateService.apply({ message, origin: MessageOrigins.BACKFILL })) {
          appliedEverything = false;
        }
      }

      if (!appliedEverything) {
        // The one thing this service must never do. Storing the server's new
        // state here would start the next catch-up *after* a message that was
        // never written, and a difference only ever runs forward -- that
        // message would be gone for good, with nothing to report it and
        // nothing to recover it. Leaving the state alone costs a repeated
        // fetch; insertMessages upserts, so re-applying what did land is free.
        this._logger
          .for(this.catchUp.name)
          .error('Could not apply every missed message, so pts stays put | From pts: %s', stored.pts);
        // integrityWarning, not statusMessage: this says messages were lost,
        // and statusMessage is cleared as a matter of course by the very next
        // loadHistory() -- which main.ts calls immediately after this returns,
        // so the user never saw it.
        this._store.setState({
          patch: { integrityWarning: 'Some missed messages could not be saved; tglow will try again next time' },
        });
        return;
      }

      if (difference.isTooLong) {
        // Spec §3.4. The server refused to enumerate the gap, so the messages
        // inside it were never sent and no pts arithmetic can recover them --
        // re-fetching each chat's history from the server is the only thing
        // that can. Run *before* the new state is stored, so a recovery that
        // is interrupted leaves the old pts in place and the next launch tries
        // again from the same point.
        await this.refetchHistoryAfterTooLong();
      }

      writeUpdateState({ database: this._database, state: difference.state });

      if (difference.isTooLong) {
        // Storing the state is what makes this terminate: the next
        // getDifference asks from a pts the server can still serve, so the
        // same too-long gap is never requested twice. Refusing to store it
        // would loop forever on a difference the server will not enumerate.
        // The refetch above covers the chats worth covering now, and the user
        // is owed the fact that it might not have reached everything.
        this._store.setState({
          patch: { integrityWarning: 'Too much happened while tglow was closed; some history may be missing' },
        });
      }
    } catch (error) {
      this._logger.for('catchUpCommon').error('Could not recover the update difference | Reason: %s', error);
    }
  };

  /**
   * Everything missed while tglow was closed: the account-wide difference,
   * then every channel from its own pts.
   *
   * Both run whatever the other did. A channel is recovered from a mark of its
   * own and does not depend on the account-wide pass having succeeded, so a
   * network failure that lost the common difference should still let every
   * channel try.
   */
  catchUp = async (): Promise<void> => {
    await this.catchUpCommon();

    const missedInChannels = await this.catchUpChannels();
    if (missedInChannels > 0) {
      this._store.setState({
        patch: { integrityWarning: 'Some missed messages could not be saved; tglow will try again next time' },
      });
    }
  };
}
