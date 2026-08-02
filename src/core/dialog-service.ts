import { inject } from '@venizia/ignis-inversion';
import { ApplicationLogger, toError, type ILogger } from '@venizia/ignis-helpers';

import { BindingKeys } from '../common/index.ts';
import type { ApplicationStoreService } from './application-store.ts';
import type { DatabaseService, IDialogRow } from './cache/index.ts';

export interface IRawDialog {
  peerId: string;
  type: 'user' | 'chat' | 'channel';
  accessHash: string | null;
  title: string;
  username: string | null;
  pinned: number;
  unreadCount: number;
  lastMessageAt: number;
  topMessageId: number;
}

export interface IDialogAdapter {
  fetchDialogs(): Promise<IRawDialog[]>;
}

export class DialogService {
  private readonly _logger: ILogger = ApplicationLogger.get(DialogService.name);

  constructor(
    @inject({ key: BindingKeys.DIALOG_ADAPTER }) private readonly _adapter: IDialogAdapter,
    @inject({ key: BindingKeys.DATABASE }) private readonly _database: DatabaseService,
    @inject({ key: BindingKeys.APPLICATION_STORE }) private readonly _store: ApplicationStoreService,
  ) {}

  /** Refresh the chat list. On failure the cached list stays on screen. */
  sync = async (): Promise<void> => {
    try {
      const dialogs = await this._adapter.fetchDialogs();

      for (const dialog of dialogs) {
        this._database.upsertPeer({
          id: dialog.peerId,
          type: dialog.type,
          accessHash: dialog.accessHash,
          title: dialog.title,
          username: dialog.username,
        });
        this._database.upsertDialog({
          peerId: dialog.peerId,
          pinned: dialog.pinned,
          unreadCount: dialog.unreadCount,
          lastMessageAt: dialog.lastMessageAt,
          topMessageId: dialog.topMessageId,
        });
      }

      this._store.setState({ patch: { dialogs: this._database.listDialogs(), statusMessage: null } });
    } catch (error) {
      this._logger.for(this.sync.name).error('Could not refresh chats | Reason: %s', error);

      // The fallback read must not be able to throw: this catch is the last
      // line of defence, and the caller invokes sync() fire-and-forget, so an
      // escaping error becomes an unhandled rejection rather than a message
      // on screen.
      let cached: IDialogRow[] = this._store.getState().dialogs;
      try {
        cached = this._database.listDialogs();
      } catch (cacheError) {
        this._logger.for(this.sync.name).error('Cache unreadable | Reason: %s', cacheError);
      }

      this._store.setState({
        patch: { dialogs: cached, statusMessage: `Could not refresh chats: ${toError(error).message}` },
      });
    }
  };
}
