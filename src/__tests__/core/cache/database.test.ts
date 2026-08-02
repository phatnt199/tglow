import { test, expect } from 'bun:test';

import { DatabaseService } from '../../../core/cache/database.ts';

const buildDatabase = (): DatabaseService => {
  const database = new DatabaseService();
  database.open({ filePath: ':memory:' });
  database.upsertPeer({ id: 'u1', type: 'user', accessHash: 'h1', title: 'Alice', username: 'alice' });
  database.upsertPeer({ id: 'u2', type: 'user', accessHash: 'h2', title: 'Bob', username: null });
  return database;
};

test('peers and dialogs round-trip', () => {
  const database = buildDatabase();
  database.upsertDialog({ peerId: 'u1', pinned: 0, unreadCount: 2, lastMessageAt: 100, topMessageId: 5, readOutboxMaxId: 0 });
  expect(database.listDialogs()[0]!.title).toBe('Alice');
  database.close();
});

// read_outbox_max_id existed in the schema unused before Task 9 -- this is
// what proves upsertDialog actually writes it and listDialogs reads it back,
// which is what the tick in message-view.tsx depends on end to end.
test("a dialog's readOutboxMaxId round-trips through the cache", () => {
  const database = buildDatabase();
  database.upsertDialog({ peerId: 'u1', pinned: 0, unreadCount: 0, lastMessageAt: 100, topMessageId: 5, readOutboxMaxId: 17 });
  expect(database.listDialogs()[0]!.readOutboxMaxId).toBe(17);
  database.close();
});

test('upsertPeer updates rather than duplicating', () => {
  const database = buildDatabase();
  database.upsertPeer({ id: 'u1', type: 'user', accessHash: 'h1', title: 'Alice Smith', username: 'alice' });
  database.upsertDialog({ peerId: 'u1', pinned: 0, unreadCount: 0, lastMessageAt: 1, topMessageId: 1, readOutboxMaxId: 0 });
  const dialogs = database.listDialogs();
  expect(dialogs).toHaveLength(1);
  expect(dialogs[0]!.title).toBe('Alice Smith');
  database.close();
});

test('dialogs sort pinned first, then by recency', () => {
  const database = buildDatabase();
  database.upsertDialog({ peerId: 'u1', pinned: 0, unreadCount: 0, lastMessageAt: 300, topMessageId: 9, readOutboxMaxId: 0 });
  database.upsertDialog({ peerId: 'u2', pinned: 1, unreadCount: 0, lastMessageAt: 100, topMessageId: 4, readOutboxMaxId: 0 });
  expect(database.listDialogs().map(dialog => dialog.peerId)).toEqual(['u2', 'u1']);
  database.close();
});

test('messages are read back newest-first', () => {
  const database = buildDatabase();
  database.insertMessages({
    messages: [
      { peerId: 'u1', id: 1, fromId: 'u1', date: 100, text: 'morning!', out: 0, entities: [], replyToMessageId: null },
      { peerId: 'u1', id: 2, fromId: 'u1', date: 200, text: 'ok ping me', out: 0, entities: [], replyToMessageId: null },
      { peerId: 'u1', id: 3, fromId: 'me', date: 300, text: 'not yet', out: 1, entities: [], replyToMessageId: null },
    ],
  });
  expect(database.listMessages({ peerId: 'u1', limit: 10 }).map(message => message.text))
    .toEqual(['not yet', 'ok ping me', 'morning!']);
  database.close();
});

// Telegram routinely delivers more than one message within the same second,
// so `date` alone cannot order them — this is what `id DESC` is for.
test('listMessages breaks a same-date tie by id, highest first', () => {
  const database = buildDatabase();
  database.insertMessages({
    messages: [
      { peerId: 'u1', id: 5, fromId: 'u1', date: 100, text: 'sent first', out: 0, entities: [], replyToMessageId: null },
      { peerId: 'u1', id: 7, fromId: 'u1', date: 100, text: 'sent second', out: 0, entities: [], replyToMessageId: null },
    ],
  });
  expect(database.listMessages({ peerId: 'u1', limit: 10 }).map(message => message.id)).toEqual([7, 5]);
  database.close();
});

test('inserting the same message twice updates it', () => {
  const database = buildDatabase();
  const message = { peerId: 'u1', id: 1, fromId: 'u1', date: 100, text: 'hi', out: 0, entities: [], replyToMessageId: null };
  database.insertMessages({ messages: [message] });
  database.insertMessages({ messages: [{ ...message, text: 'hi (edited)' }] });
  const rows = database.listMessages({ peerId: 'u1', limit: 10 });
  expect(rows).toHaveLength(1);
  expect(rows[0]!.text).toBe('hi (edited)');
  database.close();
});

test('listMessages honours its limit and scopes to one peer', () => {
  const database = buildDatabase();
  database.insertMessages({
    messages: [
      { peerId: 'u1', id: 1, fromId: 'u1', date: 100, text: 'a', out: 0, entities: [], replyToMessageId: null },
      { peerId: 'u1', id: 2, fromId: 'u1', date: 200, text: 'b', out: 0, entities: [], replyToMessageId: null },
      { peerId: 'u2', id: 1, fromId: 'u2', date: 150, text: 'other', out: 0, entities: [], replyToMessageId: null },
    ],
  });
  expect(database.listMessages({ peerId: 'u1', limit: 1 }).map(message => message.text)).toEqual(['b']);
  expect(database.listMessages({ peerId: 'u2', limit: 10 }).map(message => message.text)).toEqual(['other']);
  database.close();
});

test('sync state round-trips', () => {
  const database = buildDatabase();
  expect(database.getSyncState({ key: 'pts' })).toBeNull();
  database.setSyncState({ key: 'pts', value: 4242 });
  expect(database.getSyncState({ key: 'pts' })).toBe(4242);
  database.close();
});

test('calling open twice does not leak the first handle and leaves a working database', () => {
  const database = new DatabaseService();
  database.open({ filePath: ':memory:' });
  database.open({ filePath: ':memory:' });
  expect(() => {
    database.upsertPeer({ id: 'u1', type: 'user', accessHash: null, title: 'Alice', username: null });
    database.upsertDialog({ peerId: 'u1', pinned: 0, unreadCount: 0, lastMessageAt: 1, topMessageId: 1, readOutboxMaxId: 0 });
  }).not.toThrow();
  expect(database.listDialogs()).toHaveLength(1);
  database.close();
});

test('entities and reply id round-trip through the cache', () => {
  const database = buildDatabase();
  database.insertMessages({
    messages: [{
      peerId: 'u1', id: 1, fromId: 'u1', date: 100, text: 'see docs', out: 0,
      entities: [{ kind: 'textUrl', offset: 4, length: 4, url: 'https://example.com' }],
      replyToMessageId: 7,
    }],
  });
  const [row] = database.listMessages({ peerId: 'u1', limit: 10 });
  expect(row!.entities).toEqual([{ kind: 'textUrl', offset: 4, length: 4, url: 'https://example.com' }]);
  expect(row!.replyToMessageId).toBe(7);
  database.close();
});

test('a message with no entities reads back as an empty array, not null', () => {
  const database = buildDatabase();
  database.insertMessages({
    messages: [{ peerId: 'u1', id: 1, fromId: 'u1', date: 100, text: 'plain', out: 0, entities: [], replyToMessageId: null }],
  });
  const [row] = database.listMessages({ peerId: 'u1', limit: 10 });
  expect(row!.entities).toEqual([]);
  expect(row!.replyToMessageId).toBeNull();
  database.close();
});

test('every method rejects use before open, naming itself in the error', () => {
  const database = new DatabaseService();
  const attempts: Array<{ method: string; call: () => unknown }> = [
    { method: 'upsertPeer', call: () => database.upsertPeer({ id: 'u1', type: 'user', accessHash: null, title: 'A', username: null }) },
    { method: 'upsertDialog', call: () => database.upsertDialog({ peerId: 'u1', pinned: 0, unreadCount: 0, lastMessageAt: 1, topMessageId: 1, readOutboxMaxId: 0 }) },
    { method: 'listDialogs', call: () => database.listDialogs() },
    { method: 'insertMessages', call: () => database.insertMessages({ messages: [] }) },
    { method: 'listMessages', call: () => database.listMessages({ peerId: 'u1', limit: 1 }) },
    { method: 'deleteMessage', call: () => database.deleteMessage({ peerId: 'u1', id: 1 }) },
    { method: 'getSyncState', call: () => database.getSyncState({ key: 'pts' }) },
    { method: 'setSyncState', call: () => database.setSyncState({ key: 'pts', value: 1 }) },
  ];

  for (const attempt of attempts) {
    expect(attempt.call, attempt.method).toThrow(`[DatabaseService][${attempt.method}]`);
  }
});

test('deleteMessage removes the row from listMessages without disturbing others', () => {
  const database = buildDatabase();
  database.insertMessages({
    messages: [
      { peerId: 'u1', id: 1, fromId: 'u1', date: 100, text: 'keep', out: 0, entities: [], replyToMessageId: null },
      { peerId: 'u1', id: 2, fromId: 'u1', date: 200, text: 'gone', out: 0, entities: [], replyToMessageId: null },
    ],
  });
  database.deleteMessage({ peerId: 'u1', id: 2 });
  expect(database.listMessages({ peerId: 'u1', limit: 10 }).map(message => message.text)).toEqual(['keep']);
  database.close();
});

// The behaviour Task 8 actually depends on: a hole in the id range would
// confuse history paging, so the row must still exist afterward, only
// flagged. insertMessages upserts on (peerId, id) -- if deleteMessage had
// removed the row instead of marking it, this re-insert would silently
// create a fresh one with `deleted` defaulting back to 0, undoing the delete.
test('deleteMessage marks the row deleted rather than removing it', () => {
  const database = buildDatabase();
  const message = { peerId: 'u1', id: 2, fromId: 'u1', date: 200, text: 'gone', out: 0, entities: [], replyToMessageId: null };
  database.insertMessages({ messages: [message] });
  database.deleteMessage({ peerId: 'u1', id: 2 });
  expect(database.listMessages({ peerId: 'u1', limit: 10 })).toEqual([]);

  database.insertMessages({ messages: [message] });
  expect(database.listMessages({ peerId: 'u1', limit: 10 })).toEqual([]);
  database.close();
});
