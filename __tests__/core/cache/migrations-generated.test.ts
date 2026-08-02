import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';

import { readMigrationFiles } from 'drizzle-orm/migrator';

import {
  GENERATED_PATH,
  MIGRATIONS_FOLDER,
  buildMigrationsModuleSource,
} from '../../../scripts/build-migrations.ts';
import { EMBEDDED_MIGRATIONS } from '../../../src/core/cache/migrations.generated.ts';

// The obvious way this breaks: someone runs `drizzle-kit generate`, commits the
// new .sql, and forgets that the binary reads the generated module rather than
// drizzle/. `bun run build` regenerates first, so the normal path cannot drift;
// this catches the abnormal one.
test('migrations.generated.ts is up to date with drizzle/', () => {
  expect(readFileSync(GENERATED_PATH, 'utf8')).toBe(
    buildMigrationsModuleSource({ migrationsFolder: MIGRATIONS_FOLDER }),
  );
});

// The hash is what a migrated database records, so a hash that drifts from
// drizzle's would make the owner's cache look unmigrated and re-run DDL over
// live data. Comparing against drizzle's own reader is the only check that
// actually proves they agree.
test('every embedded hash and statement matches drizzle readMigrationFiles', () => {
  const fromDrizzle = readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER });

  expect(EMBEDDED_MIGRATIONS.map(migration => migration.hash)).toEqual(
    fromDrizzle.map(migration => migration.hash),
  );
  expect(EMBEDDED_MIGRATIONS.map(migration => migration.createdAt)).toEqual(
    fromDrizzle.map(migration => migration.folderMillis),
  );
  expect(EMBEDDED_MIGRATIONS.map(migration => migration.sql)).toEqual(fromDrizzle.map(migration => migration.sql));
});

test('migrations are embedded in journal order', () => {
  const tags = EMBEDDED_MIGRATIONS.map(migration => migration.tag);
  expect(tags).toEqual([...tags].sort());
  expect(tags.length).toBeGreaterThan(0);
});
