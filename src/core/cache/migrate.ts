import { sql } from 'drizzle-orm';

import type { TDrizzleDatabase } from './database.ts';
import { EMBEDDED_MIGRATIONS } from './migrations.generated.ts';

const MIGRATIONS_TABLE = '__drizzle_migrations';

/**
 * Verbatim from `SQLiteSyncDialect.migrate` in
 * `node_modules/drizzle-orm/sqlite-core/dialect.js`, tab indentation included:
 * SQLite stores the statement text in `sqlite_master`, so keeping it byte for
 * byte means a cache created here and one created by drizzle-kit are the same
 * database. `IF NOT EXISTS` is what leaves an existing one untouched.
 */
const CREATE_MIGRATIONS_TABLE = [
  `CREATE TABLE IF NOT EXISTS "${MIGRATIONS_TABLE}" (`,
  '\t\t\t\tid SERIAL PRIMARY KEY,',
  '\t\t\t\thash text NOT NULL,',
  '\t\t\t\tcreated_at numeric',
  '\t\t\t)',
].join('\n');

const readAppliedHashes = (opts: { database: TDrizzleDatabase }): Set<string> => {
  const rows = opts.database.values<[string]>(sql.raw(`SELECT hash FROM "${MIGRATIONS_TABLE}"`));
  return new Set(rows.map(row => row[0]));
};

/**
 * Applies any migration the database has not seen, recording each one in
 * drizzle's own `__drizzle_migrations` table with the hash drizzle-kit would
 * have written. That is what lets a column added in a later milestone reach a
 * database that already exists, and what makes a cache migrated by
 * `drizzle-kit migrate` and one migrated here interchangeable.
 *
 * Drizzle's `migrate()` reads `drizzle/` off disk, which a compiled binary does
 * not have; `EMBEDDED_MIGRATIONS` is the same content compiled in.
 */
export const runMigrations = (opts: { database: TDrizzleDatabase }): void => {
  const { database } = opts;

  database.run(sql.raw(CREATE_MIGRATIONS_TABLE));
  const applied = readAppliedHashes({ database });

  for (const migration of EMBEDDED_MIGRATIONS) {
    if (applied.has(migration.hash)) {
      continue;
    }

    database.transaction(transaction => {
      for (const statement of migration.sql) {
        // The statements are drizzle's own split, kept unmodified so the two
        // agree byte for byte. A trailing breakpoint would leave an empty chunk
        // that SQLite rejects; drizzle never emits one, and skipping it here
        // executes nothing either way.
        if (statement.trim() === '') {
          continue;
        }
        transaction.run(sql.raw(statement));
      }
      transaction.run(
        sql`INSERT INTO ${sql.identifier(MIGRATIONS_TABLE)} ("hash", "created_at") VALUES(${migration.hash}, ${migration.createdAt})`,
      );
    });
  }
};
