import { inject } from '@venizia/ignis-inversion';
import { ApplicationLogger, type ILogger } from '@venizia/ignis-helpers';

import { BindingKeys } from '../common/index.ts';
import type { ApplicationStoreService } from './application-store.ts';
import type { DatabaseService } from './cache/index.ts';
import type { IMessageAdapter, IRawMessage } from './message-service.ts';
import { readUpdateState, writeUpdateState, type IUpdateState } from './update-state.ts';
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
  catchUp = async (): Promise<void> => {
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
      this._logger.for(this.catchUp.name).error('Could not recover the update difference | Reason: %s', error);
    }
  };
}
