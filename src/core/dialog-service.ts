import { inject } from '@venizia/ignis-inversion';
import { ApplicationLogger, toError, type ILogger } from '@venizia/ignis-helpers';

import { BindingKeys } from '../common/index.ts';
import type { ApplicationStoreService } from './application-store.ts';
import type { DatabaseService, IDialogRow } from './cache/index.ts';
import type { IPresence } from './presence.ts';

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
  /** See IDialogInput.readOutboxMaxId (src/core/cache/database.ts). */
  readOutboxMaxId: number;
  /** See IDialogInput.readInboxMaxId (src/core/cache/database.ts). */
  readInboxMaxId: number;
  /** Whether the other person is online, and when they were last seen. UNKNOWN for a group or a channel, which have no such thing. */
  presence: IPresence;
}

export interface IDialogAdapter {
  fetchDialogs(): Promise<IRawDialog[]>;
  /** Pin or unpin a chat in the sidebar, on Telegram, so every device agrees. */
  pinDialog(opts: { peerId: string; pinned: boolean }): Promise<void>;
}

export class DialogService {
  private readonly _logger: ILogger = ApplicationLogger.get(DialogService.name);

  constructor(
    @inject({ key: BindingKeys.DIALOG_ADAPTER }) private readonly _adapter: IDialogAdapter,
    @inject({ key: BindingKeys.DATABASE }) private readonly _database: DatabaseService,
    @inject({ key: BindingKeys.APPLICATION_STORE }) private readonly _store: ApplicationStoreService,
  ) {}

  /**
   * Pin or unpin a chat, toggled from what is cached.
   *
   * Server first, cache second -- the same order MessageService.pin uses, and
   * for the same reason: a sidebar that reorders itself and then silently
   * disagrees with every other device is worse than one that does not move.
   *
   * Telegram caps how many chats can be pinned at once and refuses past it, so
   * the failure here is ordinary rather than exceptional and says what the
   * server said.
   */
  togglePin = async (opts: { peerId: string }): Promise<void> => {
    const dialog = this._store.getState().dialogs.find(row => row.peerId === opts.peerId);
    if (!dialog) {
      return;
    }
    const pinned = dialog.pinned !== 1;

    try {
      await this._adapter.pinDialog({ peerId: opts.peerId, pinned });
    } catch (error) {
      this._logger.for(this.togglePin.name).error('Pin failed | Reason: %s', error);
      this._store.setState({ patch: { statusMessage: `Pin failed: ${toError(error).message}` } });
      return;
    }

    try {
      this._database.setDialogPinned({ peerId: opts.peerId, pinned: pinned ? 1 : 0 });
      this._store.setState({
        patch: { dialogs: this._database.listDialogs(), statusMessage: pinned ? 'Chat pinned' : 'Chat unpinned' },
      });
    } catch (error) {
      this._logger.for(this.togglePin.name).error('Pinned but could not update the cache | Reason: %s', error);
      this._store.setState({
        patch: { statusMessage: `Pinned, but could not update the local cache: ${toError(error).message}` },
      });
    }
  };

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
          presence: dialog.presence,
        });
        this._database.upsertDialog({
          peerId: dialog.peerId,
          pinned: dialog.pinned,
          unreadCount: dialog.unreadCount,
          lastMessageAt: dialog.lastMessageAt,
          topMessageId: dialog.topMessageId,
          readOutboxMaxId: dialog.readOutboxMaxId,
          readInboxMaxId: dialog.readInboxMaxId,
        });
      }

      this._store.setState({
        patch: {
          dialogs: this._database.listDialogs(),
          presenceByPeer: this._database.listPresence(),
          statusMessage: null,
        },
      });
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
