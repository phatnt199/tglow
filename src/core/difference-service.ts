import { inject } from '@venizia/ignis-inversion';
import { ApplicationLogger, type ILogger } from '@venizia/ignis-helpers';

import { BindingKeys } from '../common/index.ts';
import type { ApplicationStoreService } from './application-store.ts';
import type { DatabaseService } from './cache/index.ts';
import type { IRawMessage } from './message-service.ts';
import type { UpdateService } from './update-service.ts';

/**
 * The four numbers Telegram addresses its update stream by. Kept and stored
 * whole: `updates.getDifference` takes pts, date and qts together, and asking
 * for a pts with the wrong date is not a supported request.
 */
export interface IUpdateState {
  pts: number;
  qts: number;
  date: number;
  seq: number;
}

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

/** The sync_state rows this service owns -- one per field of IUpdateState, since the table is a flat key/number store. */
class SyncStateKeys {
  static readonly PTS = 'pts';
  static readonly QTS = 'qts';
  static readonly DATE = 'date';
  static readonly SEQ = 'seq';
}

/**
 * Recovers the messages that arrived while tglow was closed. Everything it
 * recovers is handed to `UpdateService.apply` -- the same method a live event
 * goes through -- so a backfilled message and a live one are the same message
 * downstream, cached identically and published identically.
 */
export class DifferenceService {
  private readonly _logger: ILogger = ApplicationLogger.get(DifferenceService.name);

  constructor(
    @inject({ key: BindingKeys.DIFFERENCE_ADAPTER }) private readonly _adapter: IDifferenceAdapter,
    @inject({ key: BindingKeys.DATABASE }) private readonly _database: DatabaseService,
    @inject({ key: BindingKeys.APPLICATION_STORE }) private readonly _store: ApplicationStoreService,
    @inject({ key: BindingKeys.UPDATE_SERVICE }) private readonly _updateService: UpdateService,
  ) {}

  /** null only on the very first run: with no stored pts there is no gap to reason about, just a starting point to record. */
  private readStoredState = (): IUpdateState | null => {
    const pts = this._database.getSyncState({ key: SyncStateKeys.PTS });
    if (pts === null) {
      return null;
    }

    // pts is the one field that decides whether a stored state exists at all;
    // the other three default rather than veto, so a row lost to a partial
    // write degrades to a wider difference request, never to no request.
    return {
      pts,
      qts: this._database.getSyncState({ key: SyncStateKeys.QTS }) ?? 0,
      date: this._database.getSyncState({ key: SyncStateKeys.DATE }) ?? 0,
      seq: this._database.getSyncState({ key: SyncStateKeys.SEQ }) ?? 0,
    };
  };

  private writeState = (state: IUpdateState): void => {
    this._database.setSyncState({ key: SyncStateKeys.PTS, value: state.pts });
    this._database.setSyncState({ key: SyncStateKeys.QTS, value: state.qts });
    this._database.setSyncState({ key: SyncStateKeys.DATE, value: state.date });
    this._database.setSyncState({ key: SyncStateKeys.SEQ, value: state.seq });
  };

  /**
   * Never rejects. A catch-up that fails must degrade to "no backfill", which
   * the next run retries from the same stored state -- so every exit path
   * either stores a state whose messages are already written, or stores
   * nothing at all.
   */
  catchUp = async (): Promise<void> => {
    try {
      const stored = this.readStoredState();

      if (!stored) {
        // Nothing to recover, because there is no earlier point to recover
        // from. The server's state becomes the mark the *next* run measures
        // its gap against.
        this.writeState(await this._adapter.getState());
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
        if (!this._updateService.apply(message)) {
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
        this._store.setState({
          patch: { statusMessage: 'Some missed messages could not be saved; tglow will try again next time' },
        });
        return;
      }

      this.writeState(difference.state);

      if (difference.isTooLong) {
        // Deliberately after writeState and deliberately not silent: the state
        // is the server's own and is correct to store, but the messages it
        // skips over were never sent, so the ordinary history fetch is the
        // only thing that will fill them in -- and the user is owed the fact
        // that it might not reach all of them.
        this._store.setState({
          patch: { statusMessage: 'Too much happened while tglow was closed; some history may be missing' },
        });
      }
    } catch (error) {
      this._logger.for(this.catchUp.name).error('Could not recover the update difference | Reason: %s', error);
    }
  };
}
