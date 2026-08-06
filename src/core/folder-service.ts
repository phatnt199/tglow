import { inject } from '@venizia/ignis-inversion';
import { ApplicationLogger, type ILogger } from '@venizia/ignis-helpers';

import { BindingKeys } from '../common/index.ts';
import type { ApplicationStoreService } from './application-store.ts';
import type { DatabaseService, IDialogRow, IFolderRow } from './cache/index.ts';

/** The id of the synthetic "All chats" folder, which Telegram does not send. */
export const ALL_CHATS_FOLDER_ID = 0;
export const ALL_CHATS_FOLDER_TITLE = 'All';

export interface IRawFolder {
  id: number;
  title: string;
  emoticon: string | null;
  ord: number;
  pinnedPeers: string[];
  includePeers: string[];
  excludePeers: string[];
  contacts: boolean;
  nonContacts: boolean;
  groups: boolean;
  broadcasts: boolean;
  bots: boolean;
  excludeMuted: boolean;
  excludeRead: boolean;
  excludeArchived: boolean;
}

export interface IFolderAdapter {
  fetchFolders(opts?: Record<string, never>): Promise<IRawFolder[]>;
}

/**
 * Which chats a folder holds.
 *
 * A folder selects two ways at once, and both are honoured: an explicit
 * `includePeers` list, and category flags like "every group". A chat is in the
 * folder if it is explicitly included OR matches an enabled category -- and
 * never if it is explicitly excluded, which wins over both.
 *
 * **Only the flags tglow can honestly evaluate are acted on.** `groups`,
 * `broadcasts` and `bots` come from the cached peer's own `type`/`isBot`;
 * `excludeRead` from its unread count. `contacts`, `nonContacts`,
 * `excludeMuted` and `excludeArchived` need contact, notification and archive
 * state tglow does not cache, so a folder relying on one of those shows fewer
 * chats here than in the official client rather than guessing at membership.
 * The columns are stored regardless, so honouring them later needs no second
 * migration.
 */
export const resolveFolderMembership = (opts: {
  folder: IFolderRow;
  dialogs: IDialogRow[];
  peerKinds: Map<string, { type: string; isBot: boolean }>;
}): IDialogRow[] => {
  const { folder, dialogs, peerKinds } = opts;

  if (folder.id === ALL_CHATS_FOLDER_ID) {
    return dialogs;
  }

  const included = new Set(folder.includePeers);
  const pinned = new Set(folder.pinnedPeers);
  const excluded = new Set(folder.excludePeers);

  const matches = (dialog: IDialogRow): boolean => {
    if (excluded.has(dialog.peerId)) {
      return false;
    }
    if (included.has(dialog.peerId) || pinned.has(dialog.peerId)) {
      return true;
    }

    const kind = peerKinds.get(dialog.peerId);
    if (!kind) {
      return false;
    }
    // A category match still has to survive excludeRead: the flag narrows the
    // categories, it does not narrow the explicit list above.
    if (folder.excludeRead && dialog.unreadCount === 0) {
      return false;
    }
    if (folder.bots && kind.isBot) {
      return true;
    }
    if (folder.groups && kind.type === 'chat') {
      return true;
    }
    if (folder.broadcasts && kind.type === 'channel') {
      return true;
    }
    return false;
  };

  // Pinned peers first, in the folder's own order -- that arrangement is the
  // user's, and re-sorting it by recency would throw it away.
  const members = dialogs.filter(matches);
  const rank = (dialog: IDialogRow): number => {
    const position = folder.pinnedPeers.indexOf(dialog.peerId);
    return position === -1 ? Number.MAX_SAFE_INTEGER : position;
  };
  return [...members].sort((left, right) => rank(left) - rank(right));
};

export class FolderService {
  private readonly _logger: ILogger = ApplicationLogger.get(FolderService.name);

  constructor(
    @inject({ key: BindingKeys.FOLDER_ADAPTER }) private readonly _adapter: IFolderAdapter,
    @inject({ key: BindingKeys.DATABASE }) private readonly _database: DatabaseService,
    @inject({ key: BindingKeys.APPLICATION_STORE }) private readonly _store: ApplicationStoreService,
  ) {}

  /**
   * Fetches the account's folders and publishes them, falling back to whatever
   * is cached when the network refuses -- the same posture DialogService.sync
   * takes, and for the same reason: a folder rail drawn from yesterday's cache
   * is worth more than an empty one.
   */
  sync = async (): Promise<void> => {
    try {
      const fetched = await this._adapter.fetchFolders();
      this._database.replaceFolders({ folders: fetched });
    } catch (error) {
      this._logger.for(this.sync.name).error('Could not fetch folders | Reason: %s', error);
    }

    this._store.setState({
      patch: {
        folders: this.listWithAllChats(),
        peerKinds: this._database.listPeerKinds(),
      },
    });
  };

  /**
   * The cached folders, with "All chats" in front. Telegram does not send that
   * one -- it is the absence of a filter -- but every client shows it, and
   * without it there would be no way back to the unfiltered list.
   */
  listWithAllChats = (): IFolderRow[] => {
    return [
      {
        id: ALL_CHATS_FOLDER_ID,
        title: ALL_CHATS_FOLDER_TITLE,
        emoticon: null,
        ord: -1,
        pinnedPeers: [],
        includePeers: [],
        excludePeers: [],
        contacts: false,
        nonContacts: false,
        groups: false,
        broadcasts: false,
        bots: false,
        excludeMuted: false,
        excludeRead: false,
        excludeArchived: false,
      },
      ...this._database.listFolders(),
    ];
  };
}
