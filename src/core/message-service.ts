import { inject } from '@venizia/ignis-inversion';
import { ApplicationLogger, type ILogger } from '@venizia/ignis-helpers';

import { BindingKeys } from '../common/index.ts';
import type { ApplicationStoreService } from './application-store.ts';
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
}

export class MessageService {
  private readonly _logger: ILogger = ApplicationLogger.get(MessageService.name);

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
      // Offline is not an error state for reading — show what we already have.
      this._store.setState({
        patch: {
          messages: this.forDisplay({ rows: this._database.listMessages({ peerId, limit }) }),
          activePeerId: peerId,
          statusMessage: `Could not load history: ${(error as Error).message}`,
        },
      });
    }
  };

  send = async (opts: { peerId: string; text: string }): Promise<void> => {
    const { peerId, text } = opts;

    if (text.trim() === '') {
      return;
    }

    try {
      const sent = await this._adapter.send({ peerId, text });
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
      this._store.setState({
        patch: {
          messages: this.forDisplay({
            rows: this._database.listMessages({ peerId, limit: SEND_REFRESH_LIMIT }),
          }),
          composerText: '',
          statusMessage: null,
        },
      });
    } catch (error) {
      this._logger.for(this.send.name).error('Send failed | Reason: %s', error);
      this._store.setState({ patch: { statusMessage: `Send failed: ${(error as Error).message}` } });
    }
  };
}
