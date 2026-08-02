import { test, expect } from 'bun:test';

import { Glob } from 'bun';

interface IImportRecord {
  file: string;
  specifier: string;
}

const collectImports = async (directory: string): Promise<IImportRecord[]> => {
  const records: IImportRecord[] = [];
  const glob = new Glob('**/*.{ts,tsx}');

  try {
    for await (const file of glob.scan({ cwd: directory, absolute: true })) {
      if (file.includes('.test.')) {
        continue;
      }
      const source = await Bun.file(file).text();
      const pattern = /^\s*(?:import|export)[^'"]*from\s+["']([^"']+)["']/gm;
      for (const match of source.matchAll(pattern)) {
        records.push({ file, specifier: match[1]! });
      }
    }
  } catch (error) {
    // A directory that does not exist yet has no imports to offend with. Later
    // tasks create src/core and src/tui, and git cannot track empty directories,
    // so a clean checkout must not fail here before those tasks land.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return records;
    }
    throw error;
  }

  return records;
};

test('keys/ imports only ignis-inversion and relative paths', async () => {
  const offenders = (await collectImports('src/keys')).filter(record => {
    if (record.specifier.startsWith('.')) {
      return false;
    }
    return record.specifier !== '@venizia/ignis-inversion';
  });
  expect(offenders).toEqual([]);
});

test('core/ never imports React or OpenTUI', async () => {
  const offenders = (await collectImports('src/core')).filter(
    record => record.specifier === 'react' || record.specifier.startsWith('@opentui/'),
  );
  expect(offenders).toEqual([]);
});

test('tui/ never imports telegram', async () => {
  const offenders = (await collectImports('src/tui')).filter(record =>
    record.specifier.startsWith('telegram'),
  );
  expect(offenders).toEqual([]);
});
