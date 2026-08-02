import { inject } from '@venizia/ignis-inversion';
import { ApplicationLogger, toError, type ILogger } from '@venizia/ignis-helpers';

import { BindingKeys } from '../common/index.ts';
import type { ApplicationStoreService, IApplicationState } from './application-store.ts';
import type { DatabaseService, IMessageRow } from './cache/index.ts';

const SEND_REFRESH_LIMIT = 200;

export interface IRawMessage {
  id: number;
  peerId: string;
  fromId: string | null;
  date: number;
  text: string;
  out: number;
}

export interface IMessageAdapter {
  fetchHistory(opts: { peerId: string; limit: number }): Promise<IRawMessage[]>;
  send(opts: { peerId: string; text: string }): Promise<IRawMessage>;
  subscribeToNewMessages(opts: { onMessage: (message: IRawMessage) => void }): () => void;
}

export class MessageService {
  private readonly _logger: ILogger = ApplicationLogger.get(MessageService.name);
  // The limit the view is currently displaying, so a republish after send()
  // shows the same page size loadHistory() last asked for rather than a
  // hardcoded one -- see SEND_REFRESH_LIMIT, its fallback before loadHistory
  // has ever run.
  private _historyLimit: number | null = null;

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

  send = async (opts: { peerId: string; text: string }): Promise<void> => {
    const { peerId, text } = opts;

    if (text.trim() === '') {
      return;
    }

    let sent: IRawMessage;
    try {
      sent = await this._adapter.send({ peerId, text });
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
        }],
      });

      const patch: Partial<IApplicationState> = {
        messages: this.forDisplay({
          rows: this._database.listMessages({ peerId, limit: this._historyLimit ?? SEND_REFRESH_LIMIT }),
        }),
        activePeerId: peerId,
        statusMessage: null,
      };
      if (stillUnchanged) {
        patch.composerText = '';
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
      }
      this._store.setState({ patch });
    }
  };
}
