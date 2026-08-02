import { test, expect } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DatabaseService } from '../../../src/core/cache/database.ts';

const buildPath = (): string => join(mkdtempSync(join(tmpdir(), 'tglow-db-')), 'cache.sqlite');

test('migrations create the schema on a fresh database', () => {
  const database = new DatabaseService();
  database.open({ filePath: buildPath() });
  expect(database.listDialogs()).toEqual([]);
  database.close();
});

// The reason this task exists: CREATE TABLE IF NOT EXISTS never reaches an
// existing database, so a column added in a later milestone would silently
// never arrive.
test('reopening an existing database preserves its rows and re-applies cleanly', () => {
  const filePath = buildPath();

  const first = new DatabaseService();
  first.open({ filePath });
  first.upsertPeer({ id: 'u1', type: 'user', accessHash: 'h', title: 'Alice', username: null });
  first.upsertDialog({ peerId: 'u1', pinned: 0, unreadCount: 3, lastMessageAt: 100, topMessageId: 5 });
  first.insertMessages({ messages: [{ peerId: 'u1', id: 1, fromId: 'u1', date: 100, text: 'morning!', out: 0 }] });
  first.close();

  const second = new DatabaseService();
  second.open({ filePath });
  expect(second.listDialogs().map(dialog => dialog.title)).toEqual(['Alice']);
  expect(second.listMessages({ peerId: 'u1', limit: 10 }).map(message => message.text)).toEqual(['morning!']);
  second.close();
});

test('migrations are idempotent across many opens', () => {
  const filePath = buildPath();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const database = new DatabaseService();
    database.open({ filePath });
    database.close();
  }
  const database = new DatabaseService();
  database.open({ filePath });
  expect(database.listDialogs()).toEqual([]);
  database.close();
});
