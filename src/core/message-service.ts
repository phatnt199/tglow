import { inject } from '@venizia/ignis-inversion';
import { ApplicationLogger, toError, type ILogger } from '@venizia/ignis-helpers';

import { BindingKeys } from '../common/index.ts';
import type { ApplicationStoreService, IApplicationState } from './application-store.ts';
import type { DatabaseService, IMessageRow } from './cache/index.ts';
import type { ITelegramEntity } from './common/index.ts';

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
}

export interface IMessageAdapter {
  fetchHistory(opts: { peerId: string; limit: number }): Promise<IRawMessage[]>;
  send(opts: { peerId: string; text: string; replyToMessageId?: number }): Promise<IRawMessage>;
  edit(opts: { peerId: string; messageId: number; text: string }): Promise<IRawMessage>;
  delete(opts: { peerId: string; messageId: number; forEveryone: boolean }): Promise<void>;
  markRead(opts: { peerId: string; maxId: number }): Promise<void>;
  subscribeToNewMessages(opts: { onMessage: (message: IRawMessage) => void }): () => void;
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
        })),
      });
      this._store.setState({
        patch: {
          messages: this.forDisplay({ rows: this._database.listMessages({ peerId, limit }) }),
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

      // Offline is not an error state for reading — show what we already have.
      this._store.setState({
        patch: {
          messages: cached,
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
  delete = async (opts: { peerId: string; messageId: number }): Promise<void> => {
    const { peerId, messageId } = opts;
    const target = this._store.getState().messages.find(message => message.id === messageId);
    const forEveryone = target?.out === 1;

    try {
      await this._adapter.delete({ peerId, messageId, forEveryone });
    } catch (error) {
      this._logger.for(this.delete.name).error('Delete failed | Reason: %s', error);
      this._store.setState({ patch: { statusMessage: `Delete failed: ${toError(error).message}` } });
      return;
    }

    try {
      this._database.deleteMessage({ peerId, id: messageId });
      this._store.setState({
        patch: {
          messages: this.forDisplay({
            rows: this._database.listMessages({ peerId, limit: this._historyLimit ?? REPUBLISH_LIMIT }),
          }),
          activePeerId: peerId,
          statusMessage: forEveryone ? 'Deleted for everyone' : 'Deleted for you',
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
   * A courtesy call to the server, not a local state change -- markRead
   * writes no row and publishes no patch; the tick shown for an already-sent
   * own message comes from the dialog's readOutboxMaxId, refreshed the next
   * time DialogService.sync() runs.
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
   * cannot hammer the server on every keystroke.
   */
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
      // take that down.
      this._logger.for(this.markRead.name).error('Could not mark read | Reason: %s', error);
    }
  };
}
