import 'reflect-metadata';

import { createElement } from 'react';

import { createCliRenderer } from '@opentui/core';
import { AppContext, createRoot } from '@opentui/react';
import { toError } from '@venizia/ignis-helpers';
import { isApplicationError } from '@venizia/ignis-inversion';

import { readLine, runInteractiveLogin } from './cli/index.ts';
import { BindingKeys } from './common/index.ts';
import { buildContainer } from './container.ts';
import {
  ApplicationStoreService,
  AuthenticationService,
  ConfigurationService,
  DatabaseService,
  DialogService,
  MessageService,
  SessionStoreService,
  TelegramAuthenticationGateway,
  TelegramClientService,
  UpdateService,
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

  // Both calls reach the network, and both run before createCliRenderer takes
  // the screen. Unguarded, a machine with no route to Telegram spent several
  // seconds inside GramJS's retries and was then handed its stack trace; the
  // services' cached-fallback paths cannot soften that, because none of them
  // have been constructed yet. M1a does not start without a connection, so
  // fail the way a bad configuration does: one line, and a non-zero exit.
  let authorized: boolean;
  try {
    await client.connect();
    authorized = await client.isUserAuthorized();
  } catch (error) {
    process.stderr.write(
      [
        `Could not reach Telegram: ${toError(error).message}`,
        '',
        'Check your network connection and try again.',
        '',
      ].join('\n'),
    );
    process.exit(1);
  }

  // Before createCliRenderer on purpose: the prompts need a cooked terminal and
  // the scrollback, neither of which survives the alternate screen. On success
  // this falls straight through into the interface — no second launch.
  if (!authorized) {
    if (!process.stdin.isTTY) {
      process.stderr.write('Not logged in, and logging in needs an interactive terminal.\n');
      process.exit(1);
    }

    process.stdout.write('Not logged in. Log in to Telegram to continue.\n\n');

    try {
      await runInteractiveLogin({
        service: new AuthenticationService(new TelegramAuthenticationGateway(client)),
        readLine,
        write: (text: string): void => {
          process.stdout.write(text);
        },
      });
    } catch (error) {
      process.stderr.write(`\nCould not log in: ${toError(error).message}\n`);
      process.exit(1);
    }
  }

  clientService.persistSession({ client, configuration });

  const database = new DatabaseService();
  database.open({ filePath: configuration.cachePath });

  const container = buildContainer({ configuration, client, database });
  const store = container.get<ApplicationStoreService>({ key: BindingKeys.APPLICATION_STORE });
  const dialogService = container.get<DialogService>({ key: BindingKeys.DIALOG_SERVICE });
  const messageService = container.get<MessageService>({ key: BindingKeys.MESSAGE_SERVICE });
  const updateService = container.get<UpdateService>({ key: BindingKeys.UPDATE_SERVICE });

  store.setState({ patch: { connection: 'connected' } });
  await dialogService.sync();

  const firstDialog = store.getState().dialogs[0];
  if (firstDialog) {
    await messageService.loadHistory({ peerId: firstDialog.peerId, limit: HISTORY_LIMIT });
  }

  // Started only after the initial sync and history load have landed, so the
  // first live message to arrive republishes against a cache and a store
  // that already reflect a full loadHistory rather than racing it from zero.
  const stopReceivingUpdates = updateService.start();

  // Ctrl-C is a binding, not an exit: the renderer's own handler tears itself
  // down and leaves the database and the client open, and in INSERT it would
  // fire on a keystroke that is meant to reach the composer. quit() below is
  // the only way out, so it always runs.
  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  const root = createRoot(renderer);

  const quit = (): void => {
    stopReceivingUpdates();
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
        // Resolved from the store on every call, not from the dialog that
        // happened to be open at startup: closing over firstDialog labelled
        // every message in every other chat with the first chat's title.
        resolveSenderName: (opts: { fromId: string | null }): string => {
          if (opts.fromId === 'me') {
            return 'me';
          }
          const { dialogs, activePeerId } = store.getState();
          return dialogs.find(dialog => dialog.peerId === activePeerId)?.title ?? 'them';
        },
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
