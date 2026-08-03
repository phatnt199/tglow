import { inject } from '@venizia/ignis-inversion';

import { BindingKeys } from '../common/index.ts';
import type { DatabaseService, IMessageRow } from './cache/index.ts';

/**
 * `/`, M1b-2 Task 9: the seam between the search overlay and the cache. A
 * thin wrapper over DatabaseService.searchMessages rather than App reaching
 * into the database directly -- the same reason MessageService sits between
 * App and the adapter/cache. Search is synchronous and local (bun:sqlite has
 * no async path, unlike the Telegram-network-bound methods on MessageService),
 * so App calls it directly rather than through a callback prop the way
 * onSend/onEdit/onOpenChat are wrapped -- the same treatment
 * VimEngineService/KeymapService already get.
 */
export class MessageSearchService {
  constructor(
    @inject({ key: BindingKeys.DATABASE }) private readonly _database: DatabaseService,
  ) {}

  /**
   * A blank (or whitespace-only) query is refused here rather than passed
   * through to the cache: SQLite's LIKE treats "" as a substring of every
   * row, so an unguarded call would return the newest `limit` cached messages
   * for a search the user has not actually typed anything into yet. Mirrors
   * MessageService.send's own trim-and-refuse-blank rule.
   */
  search = (opts: { peerId: string; query: string; limit: number }): IMessageRow[] => {
    if (opts.query.trim() === '') {
      return [];
    }
    return this._database.searchMessages(opts);
  };
}
