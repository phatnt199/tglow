import 'reflect-metadata';

import { createElement } from 'react';

import { createCliRenderer } from '@opentui/core';
import { AppContext, createRoot } from '@opentui/react';
import { isApplicationError } from '@venizia/ignis-inversion';

import { BindingKeys } from './common/index.ts';
import { buildContainer } from './container.ts';
import {
  ApplicationStoreService,
  ConfigurationService,
  DatabaseService,
  DialogService,
  MessageService,
  SessionStoreService,
  TelegramClientService,
  installFileLogger,
  type IApplicationConfiguration,
} from './core/index.ts';
import { KeyNormalizerService, KeymapService, VimEngineService } from './keys/index.ts';
import { App } from './tui/app.tsx';
import { buildTokens } from './tui/theme/index.ts';

const HISTORY_LIMIT = 200;

const main = async (): Promise<void> => {
  const configurationService = new ConfigurationService();

  let configuration: IApplicationConfiguration;
  try {
    configuration = configurationService.load();
  } catch (error) {
    process.stderr.write(`${isApplicationError(error) ? error.message : String(error)}\n`);
    process.exit(1);
  }

  // Before anything can log: winston would otherwise claim stdout and corrupt
  // the alternate screen on the first logged error.
  installFileLogger({ filePath: configuration.logPath });

  const clientService = new TelegramClientService(new SessionStoreService());
  const client = clientService.build({ configuration });
  await client.connect();

  if (!(await client.isUserAuthorized())) {
    process.stderr.write(
      [
        'Not logged in.',
        '',
        'M1a does not include the interactive login interface — that lands with',
        'the auth panes in plan M1b. Authorise once with:',
        '',
        '  bun run scripts/login.ts',
        '',
      ].join('\n'),
    );
    process.exit(1);
  }

  clientService.persistSession({ client, configuration });

  const database = new DatabaseService();
  database.open({ filePath: configuration.cachePath });

  const container = buildContainer({ configuration, client, database });
  const store = container.get<ApplicationStoreService>({ key: BindingKeys.APPLICATION_STORE });
  const dialogService = container.get<DialogService>({ key: BindingKeys.DIALOG_SERVICE });
  const messageService = container.get<MessageService>({ key: BindingKeys.MESSAGE_SERVICE });

  store.setState({ patch: { connection: 'connected' } });
  await dialogService.sync();

  const firstDialog = store.getState().dialogs[0];
  if (firstDialog) {
    await messageService.loadHistory({ peerId: firstDialog.peerId, limit: HISTORY_LIMIT });
  }

  const renderer = await createCliRenderer({});
  const root = createRoot(renderer);

  const quit = (): void => {
    renderer.destroy();
    database.close();
    void client.destroy();
    process.exit(0);
  };

  root.render(
    createElement(
      AppContext.Provider,
      { value: { keyHandler: renderer.keyInput, renderer } },
      createElement(App, {
        store,
        engine: container.get<VimEngineService>({ key: BindingKeys.VIM_ENGINE }),
        keymapService: container.get<KeymapService>({ key: BindingKeys.KEYMAP }),
        keyNormalizer: container.get<KeyNormalizerService>({ key: BindingKeys.KEY_NORMALIZER }),
        tokens: buildTokens({ paletteName: configuration.palette }),
        resolveSenderName: (opts: { fromId: string | null }): string =>
          opts.fromId === 'me' ? 'me' : (firstDialog?.title ?? 'them'),
        onSend: async (text: string): Promise<void> => {
          const peerId = store.getState().activePeerId;
          if (peerId) {
            await messageService.send({ peerId, text });
          }
        },
        onQuit: quit,
        onOpenChat: async (opts: { peerId: string }): Promise<void> => {
          await messageService.loadHistory({ peerId: opts.peerId, limit: HISTORY_LIMIT });
        },
      }),
    ),
  );
};

await main();
