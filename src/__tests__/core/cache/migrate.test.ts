import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';

import { DatabaseService } from '../../../core/cache/database.ts';
import { runMigrations } from '../../../core/cache/migrate.ts';
import { EMBEDDED_MIGRATIONS } from '../../../core/cache/migrations.generated.ts';

const buildPath = (): string => join(mkdtempSync(join(tmpdir(), 'tglow-db-')), 'cache.sqlite');

const MIGRATIONS_FOLDER = new URL('../../../../drizzle', import.meta.url).pathname;

interface IBookkeepingRow {
  hash: string;
  created_at: number;
}

const readBookkeeping = (opts: { filePath: string }): IBookkeepingRow[] => {
  const connection = new Database(opts.filePath, { readonly: true });
  const rows = connection.query('SELECT hash, created_at FROM __drizzle_migrations').all() as IBookkeepingRow[];
  connection.close();
  return rows;
};

const readTableDefinition = (opts: { filePath: string; name: string }): string => {
  const connection = new Database(opts.filePath, { readonly: true });
  const row = connection.query('SELECT sql FROM sqlite_master WHERE name = ?').get(opts.name) as { sql: string };
  connection.close();
  return row.sql;
};

/** A database created the way the owner's was, before tglow ever opens it. */
const buildDrizzleMigratedDatabase = (): string => {
  const filePath = buildPath();
  const connection = new Database(filePath);
  connection.run('PRAGMA journal_mode = WAL');
  connection.run('PRAGMA foreign_keys = ON');
  migrate(drizzle(connection), { migrationsFolder: MIGRATIONS_FOLDER });
  connection.close();
  return filePath;
};

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
  first.upsertDialog({ peerId: 'u1', pinned: 0, unreadCount: 3, lastMessageAt: 100, topMessageId: 5, readOutboxMaxId: 0 });
  first.insertMessages({
    messages: [{ peerId: 'u1', id: 1, fromId: 'u1', date: 100, text: 'morning!', out: 0, entities: [], replyToMessageId: null }],
  });
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

// The whole point of copying drizzle's hash: the owner already has a cache that
// drizzle-kit migrated and that holds their real messages. If our bookkeeping
// disagreed with drizzle's by so much as a byte, opening it would re-run the
// DDL over live data.
test('a database drizzle migrated is left alone', () => {
  const filePath = buildDrizzleMigratedDatabase();

  const seeded = new DatabaseService();
  seeded.open({ filePath });
  seeded.upsertPeer({ id: 'u1', type: 'user', accessHash: 'h', title: 'Alice', username: null });
  seeded.insertMessages({
    messages: [{ peerId: 'u1', id: 1, fromId: 'u1', date: 100, text: 'kept', out: 0, entities: [], replyToMessageId: null }],
  });
  seeded.close();

  const before = readBookkeeping({ filePath });

  const reopened = new DatabaseService();
  reopened.open({ filePath });
  expect(reopened.listMessages({ peerId: 'u1', limit: 10 }).map(message => message.text)).toEqual(['kept']);
  reopened.close();

  expect(readBookkeeping({ filePath })).toEqual(before);
  expect(before).toEqual(
    EMBEDDED_MIGRATIONS.map(migration => ({ hash: migration.hash, created_at: migration.createdAt })),
  );
});

test('a database tglow migrated is left alone by drizzle', () => {
  const filePath = buildPath();

  const database = new DatabaseService();
  database.open({ filePath });
  database.close();

  const before = readBookkeeping({ filePath });

  const connection = new Database(filePath);
  migrate(drizzle(connection), { migrationsFolder: MIGRATIONS_FOLDER });
  connection.close();

  expect(readBookkeeping({ filePath })).toEqual(before);
});

// A migration that records itself but did not fully apply is the worst outcome
// available: every later start would skip it, and the schema would be wrong for
// ever. The transaction around each migration is what prevents that, so it is
// worth an actual failed migration to prove it holds.
test('a migration that fails part way records nothing', () => {
  const filePath = buildPath();
  const connection = new Database(filePath);
  // Collides with the migration's own CREATE TABLE `peers`, part way through.
  connection.run('CREATE TABLE `peers` (placeholder integer)');

  expect(() => runMigrations({ database: drizzle(connection) })).toThrow();

  const rows = connection.query('SELECT count(*) AS total FROM __drizzle_migrations').get() as { total: number };
  expect(rows.total).toBe(0);
  // The statements before the collision were rolled back with it.
  expect(connection.query(`SELECT name FROM sqlite_master WHERE name = 'dialogs'`).get()).toBeNull();
  connection.close();
});

test('the bookkeeping table tglow creates is the one drizzle creates', () => {
  const ours = buildPath();
  const database = new DatabaseService();
  database.open({ filePath: ours });
  database.close();

  const theirs = buildDrizzleMigratedDatabase();

  expect(readTableDefinition({ filePath: ours, name: '__drizzle_migrations' })).toBe(
    readTableDefinition({ filePath: theirs, name: '__drizzle_migrations' }),
  );
  for (const name of ['peers', 'dialogs', 'messages', 'sync_state']) {
    expect(readTableDefinition({ filePath: ours, name })).toBe(readTableDefinition({ filePath: theirs, name }));
  }
});
