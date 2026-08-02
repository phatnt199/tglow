import { migrate } from 'drizzle-orm/bun-sqlite/migrator';

import type { TDrizzleDatabase } from './database.ts';

const MIGRATIONS_FOLDER = new URL('../../../drizzle', import.meta.url).pathname;

/**
 * Applies any migration the database has not seen. Drizzle records what it has
 * run, so this is safe to call on every start and is what lets a column added
 * in a later milestone reach a database that already exists.
 */
export const runMigrations = (opts: { database: TDrizzleDatabase }): void => {
  migrate(opts.database, { migrationsFolder: MIGRATIONS_FOLDER });
};
