import { test, expect } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { IApplicationConfiguration } from '../../core/common/index.ts';
import { SessionStoreService } from '../../core/session-store.ts';
import { TelegramClientService } from '../../core/telegram-client.ts';

const buildConfiguration = (): IApplicationConfiguration => {
  const directory = mkdtempSync(join(tmpdir(), 'tglow-client-'));
  return {
    apiId: 1234,
    apiHash: 'hash',
    palette: 'sage',
    timeoutMilliseconds: 400,
    sessionPath: join(directory, 'session'),
    cachePath: join(directory, 'cache.sqlite'),
    logPath: join(directory, 'tglow.log'),
    themeDirectory: join(directory, 'themes'),
    mouse: true,
  };
};

// GramJS parses a sent message as Markdown by default -- `__init__.py` would
// arrive as bold "init" plus ".py" with nothing on screen to show the text had
// been rewritten. build() constructs the client only -- it never connects --
// so this needs no account and no network.
test('the built client has no parse mode, so it cannot silently rewrite the composer text', () => {
  const service = new TelegramClientService(new SessionStoreService());
  const client = service.build({ configuration: buildConfiguration() });
  expect(client.parseMode).toBeUndefined();
});
