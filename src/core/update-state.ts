import type { DatabaseService } from './cache/index.ts';

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

/** The sync_state rows this module owns -- one per field of IUpdateState, since the table is a flat key/number store. */
export class SyncStateKeys {
  static readonly PTS = 'pts';
  static readonly QTS = 'qts';
  static readonly DATE = 'date';
  static readonly SEQ = 'seq';
}

/**
 * Every read and write of the `sync_state` rows, in one module rather than on
 * one service, because two different paths consume the update stream and both
 * have to record what they consumed: DifferenceService recovers the gap at
 * startup, and UpdateService receives everything after it. Making either one
 * ask the other would mean a constructor cycle (DifferenceService already
 * injects UpdateService); making only one of them write meant, in practice,
 * that pts moved once per launch and the next launch replayed the whole
 * session in between.
 */

/** null only on the very first run: with no stored pts there is no gap to reason about, just a starting point to record. */
export const readUpdateState = (opts: { database: DatabaseService }): IUpdateState | null => {
  const { database } = opts;
  const pts = database.getSyncState({ key: SyncStateKeys.PTS });
  if (pts === null) {
    return null;
  }

  // pts is the one field that decides whether a stored state exists at all;
  // the other three default rather than veto, so a row lost to a partial
  // write degrades to a wider difference request, never to no request.
  return {
    pts,
    qts: database.getSyncState({ key: SyncStateKeys.QTS }) ?? 0,
    date: database.getSyncState({ key: SyncStateKeys.DATE }) ?? 0,
    seq: database.getSyncState({ key: SyncStateKeys.SEQ }) ?? 0,
  };
};

export const writeUpdateState = (opts: { database: DatabaseService; state: IUpdateState }): void => {
  const { database, state } = opts;
  database.setSyncState({ key: SyncStateKeys.PTS, value: state.pts });
  database.setSyncState({ key: SyncStateKeys.QTS, value: state.qts });
  database.setSyncState({ key: SyncStateKeys.DATE, value: state.date });
  database.setSyncState({ key: SyncStateKeys.SEQ, value: state.seq });
};

/**
 * Records a single live update as consumed. Three refusals, each of which
 * would otherwise cost messages:
 *
 * - No stored state at all means catch-up has never established a baseline.
 *   Writing one here would assert that everything below this pts had already
 *   been applied, when nothing has been.
 * - A pts at or behind the stored one is a repeat or an out-of-order arrival.
 *   Writing it back would re-request what was already applied, or worse, sit
 *   behind a higher pts that had genuinely been consumed.
 * - qts and seq are left alone: a new message advances neither (qts counts
 *   secret-chat updates, seq counts `Updates` containers), and defaulting
 *   them to a message's own numbers would corrupt both.
 *
 * Returns whether the stored state actually moved, so a caller can tell
 * "recorded" from "ignored" without reading the rows back.
 */
export const advanceUpdateState = (opts: { database: DatabaseService; pts: number; date: number }): boolean => {
  const { database, pts, date } = opts;
  const stored = readUpdateState({ database });
  if (!stored || pts <= stored.pts) {
    return false;
  }

  database.setSyncState({ key: SyncStateKeys.PTS, value: pts });
  // Monotonic like pts: a message dated before the stored state (a clock skew,
  // or an edit of something old) must not drag the difference window backward.
  if (date > stored.date) {
    database.setSyncState({ key: SyncStateKeys.DATE, value: date });
  }
  return true;
};
