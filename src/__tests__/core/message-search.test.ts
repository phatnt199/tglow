import { test, expect } from 'bun:test';

import { DatabaseService } from '../../core/cache/index.ts';
import { MessageSearchService } from '../../core/message-search.ts';

const buildService = (): { service: MessageSearchService; database: DatabaseService } => {
  const database = new DatabaseService();
  database.open({ filePath: ':memory:' });
  database.upsertPeer({ id: 'u1', type: 'user', accessHash: 'h', title: 'Alice', username: null });
  return { service: new MessageSearchService(database), database };
};

test('search forwards to the cache, scoped and limited exactly as asked', () => {
  const { service, database } = buildService();
  database.insertMessages({
    messages: [
      { peerId: 'u1', id: 1, fromId: 'u1', date: 100, text: 'find me', out: 0, entities: [], replyToMessageId: null },
      { peerId: 'u1', id: 2, fromId: 'u1', date: 200, text: 'unrelated', out: 0, entities: [], replyToMessageId: null },
    ],
  });
  expect(service.search({ peerId: 'u1', query: 'find', limit: 10 }).map(row => row.id)).toEqual([1]);
  database.close();
});

// A blank query has nothing to search for; matching it against every row
// (SQLite's LIKE treats "" as a substring of everything) would jump `/<CR>`
// straight to the newest cached message with no query typed at all, which
// reads as broken rather than as "nothing to find yet". Whitespace-only
// counts as blank too, the same rule MessageService.send already applies to
// composerText.
test('a blank (or whitespace-only) query returns nothing, even though the cache holds a matching message', () => {
  const { service, database } = buildService();
  database.insertMessages({
    messages: [{ peerId: 'u1', id: 1, fromId: 'u1', date: 100, text: 'anything at all', out: 0, entities: [], replyToMessageId: null }],
  });
  expect(service.search({ peerId: 'u1', query: '', limit: 10 })).toEqual([]);
  expect(service.search({ peerId: 'u1', query: '   ', limit: 10 })).toEqual([]);
  database.close();
});
