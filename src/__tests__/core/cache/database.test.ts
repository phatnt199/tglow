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

// Gap 4d (task-11-report.md): markRead writes nowhere -- this is the write
// side of clearing a dialog's badge (spec §3.3: "clears locally and in the
// chat list"). A direct UPDATE rather than a read-modify-write through
// upsertDialog: MessageService.markRead has no reason to know or preserve
// pinned/lastMessageAt/topMessageId/readOutboxMaxId just to zero one column.
test("clearUnreadCount zeroes a dialog's unread count without touching its other fields", () => {
  const database = buildDatabase();
  database.upsertDialog({ peerId: 'u1', pinned: 1, unreadCount: 7, lastMessageAt: 500, topMessageId: 12, readOutboxMaxId: 3 });
  database.clearUnreadCount({ peerId: 'u1' });
  const dialog = database.listDialogs().find(row => row.peerId === 'u1');
  expect(dialog?.unreadCount).toBe(0);
  expect(dialog?.pinned).toBe(1);
  expect(dialog?.lastMessageAt).toBe(500);
  expect(dialog?.topMessageId).toBe(12);
  expect(dialog?.readOutboxMaxId).toBe(3);
  database.close();
});

test('clearUnreadCount only affects the named peer', () => {
  const database = buildDatabase();
  database.upsertDialog({ peerId: 'u1', pinned: 0, unreadCount: 3, lastMessageAt: 100, topMessageId: 1, readOutboxMaxId: 0 });
  database.upsertDialog({ peerId: 'u2', pinned: 0, unreadCount: 4, lastMessageAt: 200, topMessageId: 2, readOutboxMaxId: 0 });
  database.clearUnreadCount({ peerId: 'u1' });
  const dialogs = database.listDialogs();
  expect(dialogs.find(row => row.peerId === 'u1')?.unreadCount).toBe(0);
  expect(dialogs.find(row => row.peerId === 'u2')?.unreadCount).toBe(4);
  database.close();
});

// markRead can race a dialog row that has not been synced yet (a chat opened
// before DialogService.sync() has ever populated it) -- this must not throw,
// the same tolerance an UPDATE matching zero rows already has in SQL itself.
test('clearUnreadCount on a peer with no dialog row is a harmless no-op', () => {
  const database = buildDatabase();
  expect(() => database.clearUnreadCount({ peerId: 'u1' })).not.toThrow();
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
    { method: 'searchMessages', call: () => database.searchMessages({ peerId: 'u1', query: 'hi', limit: 1 }) },
    { method: 'deleteMessage', call: () => database.deleteMessage({ peerId: 'u1', id: 1 }) },
    { method: 'getSyncState', call: () => database.getSyncState({ key: 'pts' }) },
    { method: 'setSyncState', call: () => database.setSyncState({ key: 'pts', value: 1 }) },
    { method: 'clearUnreadCount', call: () => database.clearUnreadCount({ peerId: 'u1' }) },
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

// M1b-2 Task 9: `/` search. Scoped to one peer, case-insensitive substring,
// excluding deleted rows -- the same three cache-reading rules listMessages
// already follows, now behind a LIKE instead of an exact peer/deleted match.
test('searchMessages finds a case-insensitive substring match', () => {
  const database = buildDatabase();
  database.insertMessages({
    messages: [
      { peerId: 'u1', id: 1, fromId: 'u1', date: 100, text: 'Meet at the Cafe tomorrow', out: 0, entities: [], replyToMessageId: null },
      { peerId: 'u1', id: 2, fromId: 'u1', date: 200, text: 'unrelated message', out: 0, entities: [], replyToMessageId: null },
    ],
  });
  expect(database.searchMessages({ peerId: 'u1', query: 'CAFE', limit: 10 }).map(row => row.id)).toEqual([1]);
  database.close();
});

test('searchMessages is scoped to one peer', () => {
  const database = buildDatabase();
  database.insertMessages({
    messages: [
      { peerId: 'u1', id: 1, fromId: 'u1', date: 100, text: 'find me', out: 0, entities: [], replyToMessageId: null },
      { peerId: 'u2', id: 1, fromId: 'u2', date: 100, text: 'find me too', out: 0, entities: [], replyToMessageId: null },
    ],
  });
  const rows = database.searchMessages({ peerId: 'u1', query: 'find', limit: 10 });
  expect(rows).toHaveLength(1);
  expect(rows[0]!.peerId).toBe('u1');
  database.close();
});

test('searchMessages excludes deleted messages', () => {
  const database = buildDatabase();
  database.insertMessages({
    messages: [{ peerId: 'u1', id: 1, fromId: 'u1', date: 100, text: 'gone but findable', out: 0, entities: [], replyToMessageId: null }],
  });
  database.deleteMessage({ peerId: 'u1', id: 1 });
  expect(database.searchMessages({ peerId: 'u1', query: 'findable', limit: 10 })).toEqual([]);
  database.close();
});

test('searchMessages honours its limit', () => {
  const database = buildDatabase();
  database.insertMessages({
    messages: [1, 2, 3].map(id => ({
      peerId: 'u1', id, fromId: 'u1', date: id * 100, text: `ping ${id}`, out: 0, entities: [], replyToMessageId: null,
    })),
  });
  expect(database.searchMessages({ peerId: 'u1', query: 'ping', limit: 2 })).toHaveLength(2);
  database.close();
});

// Same newest-first order as listMessages, so a caller that reconciles a
// match against a limited, newest-first-loaded state.messages window (app.tsx,
// M1b-2 Task 9) sees the matches most likely to actually be in that window
// first, rather than the oldest ones if the true match count exceeds `limit`.
test('searchMessages reads back newest-first, like listMessages', () => {
  const database = buildDatabase();
  database.insertMessages({
    messages: [1, 2, 3].map(id => ({
      peerId: 'u1', id, fromId: 'u1', date: id * 100, text: `ping ${id}`, out: 0, entities: [], replyToMessageId: null,
    })),
  });
  expect(database.searchMessages({ peerId: 'u1', query: 'ping', limit: 10 }).map(row => row.id)).toEqual([3, 2, 1]);
  database.close();
});

test('searchMessages returns nothing when nothing matches', () => {
  const database = buildDatabase();
  database.insertMessages({
    messages: [{ peerId: 'u1', id: 1, fromId: 'u1', date: 100, text: 'hello', out: 0, entities: [], replyToMessageId: null }],
  });
  expect(database.searchMessages({ peerId: 'u1', query: 'goodbye', limit: 10 })).toEqual([]);
  database.close();
});

// The bug a naive LIKE ships: SQLite treats `%` as "any run of characters",
// so a user searching for a literal percent sign must not have it silently
// widen into a wildcard -- id 2 contains the substring "50" but no literal
// "50%", and must NOT come back for a query of "50%" the way it would if `%`
// were passed straight into the pattern unescaped.
test('% in the query is escaped, so it matches a literal percent sign rather than acting as a wildcard', () => {
  const database = buildDatabase();
  database.insertMessages({
    messages: [
      { peerId: 'u1', id: 1, fromId: 'u1', date: 100, text: 'Discount: 50% today', out: 0, entities: [], replyToMessageId: null },
      { peerId: 'u1', id: 2, fromId: 'u1', date: 200, text: 'Only 50 seats left', out: 0, entities: [], replyToMessageId: null },
    ],
  });
  expect(database.searchMessages({ peerId: 'u1', query: '50%', limit: 10 }).map(row => row.id)).toEqual([1]);
  database.close();
});

// Same defect, for `_` -- SQLite's other LIKE wildcard, matching any single
// character. Unescaped, a query of "a_b" would also match "axb".
test('_ in the query is escaped, so it matches a literal underscore rather than acting as a single-character wildcard', () => {
  const database = buildDatabase();
  database.insertMessages({
    messages: [
      { peerId: 'u1', id: 1, fromId: 'u1', date: 100, text: 'code a_b works', out: 0, entities: [], replyToMessageId: null },
      { peerId: 'u1', id: 2, fromId: 'u1', date: 200, text: 'code axb is different', out: 0, entities: [], replyToMessageId: null },
    ],
  });
  expect(database.searchMessages({ peerId: 'u1', query: 'a_b', limit: 10 }).map(row => row.id)).toEqual([1]);
  database.close();
});

// A literal backslash in the query is the same defect class again: it is the
// character this file uses as the LIKE ESCAPE, so a query containing one must
// not corrupt the escaping of the % or _ that happens to follow it.
test('a literal backslash in the query still matches literally', () => {
  const database = buildDatabase();
  database.insertMessages({
    messages: [
      { peerId: 'u1', id: 1, fromId: 'u1', date: 100, text: 'path is C:\\Users\\a_b', out: 0, entities: [], replyToMessageId: null },
    ],
  });
  expect(database.searchMessages({ peerId: 'u1', query: '\\a_b', limit: 10 }).map(row => row.id)).toEqual([1]);
  database.close();
});

// The owner's own chat list is mostly Vietnamese (task-8-brief.md) -- this is
// the same reason that task tested against real Vietnamese text rather than
// an all-ASCII stand-in.
test('searchMessages matches a real Vietnamese string', () => {
  const database = buildDatabase();
  database.insertMessages({
    messages: [
      { peerId: 'u1', id: 1, fromId: 'u1', date: 100, text: 'Chào bạn, khỏe không?', out: 0, entities: [], replyToMessageId: null },
      { peerId: 'u1', id: 2, fromId: 'u1', date: 200, text: 'unrelated message', out: 0, entities: [], replyToMessageId: null },
    ],
  });
  expect(database.searchMessages({ peerId: 'u1', query: 'khỏe', limit: 10 }).map(row => row.id)).toEqual([1]);
  database.close();
});

// ── the sidebar preview line ──────────────────────────────────────────────

test('a dialog carries the text of its newest cached message', () => {
  const database = new DatabaseService();
  database.open({ filePath: ':memory:' });
  database.upsertPeer({ id: 'u1', type: 'user', accessHash: 'h', title: 'Alice', username: null });
  database.upsertDialog({ peerId: 'u1', pinned: 0, unreadCount: 0, lastMessageAt: 300, topMessageId: 2, readOutboxMaxId: 0 });
  database.insertMessages({
    messages: [
      { peerId: 'u1', id: 1, fromId: 'u1', date: 100, text: 'older one', out: 0, entities: [], replyToMessageId: null },
      { peerId: 'u1', id: 2, fromId: 'u1', date: 200, text: 'the newest message', out: 0, entities: [], replyToMessageId: null },
    ],
  });

  expect(database.listDialogs()[0]!.preview).toBe('the newest message');
  database.close();
});

// A deleted message stays cached -- removing it would leave a hole in the id
// range history paging reasons about -- so it has to be filtered here, or it
// goes on previewing itself in the sidebar after the user deleted it.
test('a deleted message stops previewing itself, falling back to the one before', () => {
  const database = new DatabaseService();
  database.open({ filePath: ':memory:' });
  database.upsertPeer({ id: 'u1', type: 'user', accessHash: 'h', title: 'Alice', username: null });
  database.upsertDialog({ peerId: 'u1', pinned: 0, unreadCount: 0, lastMessageAt: 300, topMessageId: 2, readOutboxMaxId: 0 });
  database.insertMessages({
    messages: [
      { peerId: 'u1', id: 1, fromId: 'u1', date: 100, text: 'older one', out: 0, entities: [], replyToMessageId: null },
      { peerId: 'u1', id: 2, fromId: 'u1', date: 200, text: 'the newest message', out: 0, entities: [], replyToMessageId: null },
    ],
  });

  database.deleteMessage({ peerId: 'u1', id: 2 });

  expect(database.listDialogs()[0]!.preview).toBe('older one');
  database.close();
});

// Most of the list on a first run: DialogService.sync() knows every chat, and
// the cache has history for none of them until one is opened.
test('a chat with no cached history has no preview rather than a placeholder', () => {
  const database = new DatabaseService();
  database.open({ filePath: ':memory:' });
  database.upsertPeer({ id: 'u1', type: 'user', accessHash: 'h', title: 'Alice', username: null });
  database.upsertDialog({ peerId: 'u1', pinned: 0, unreadCount: 0, lastMessageAt: 300, topMessageId: 2, readOutboxMaxId: 0 });

  expect(database.listDialogs()[0]!.preview).toBeNull();
  database.close();
});

// One row per dialog, whatever the message count. A join to `messages` would
// multiply each dialog by its history instead of collapsing to one preview.
test('a chat with many messages still yields exactly one row', () => {
  const database = new DatabaseService();
  database.open({ filePath: ':memory:' });
  database.upsertPeer({ id: 'u1', type: 'user', accessHash: 'h', title: 'Alice', username: null });
  database.upsertDialog({ peerId: 'u1', pinned: 0, unreadCount: 0, lastMessageAt: 300, topMessageId: 5, readOutboxMaxId: 0 });
  database.insertMessages({
    messages: Array.from({ length: 25 }, (unused, index) => ({
      peerId: 'u1', id: index + 1, fromId: 'u1', date: (index + 1) * 10,
      text: `m${index + 1}`, out: 0 as const, entities: [], replyToMessageId: null,
    })),
  });

  const rows = database.listDialogs();
  expect(rows).toHaveLength(1);
  expect(rows[0]!.preview).toBe('m25');
  database.close();
});
