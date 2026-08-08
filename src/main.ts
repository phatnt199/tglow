import 'reflect-metadata';

import { rmSync } from 'node:fs';

import { createElement } from 'react';

import { createCliRenderer } from '@opentui/core';
import { AppContext, createRoot } from '@opentui/react';
import { ApplicationLogger, toError } from '@venizia/ignis-helpers';
import { isApplicationError } from '@venizia/ignis-inversion';
import { Api } from 'teleproto';

import { readLine, runInteractiveLogin } from './cli/index.ts';
import { BindingKeys } from './common/index.ts';
import { buildContainer } from './container.ts';
import {
  ApplicationStoreService,
  AuthenticationService,
  ConfigurationService,
  DatabaseService,
  DialogService,
  DifferenceService,
  FolderService,
  HISTORY_PAGE_SIZE,
  MessageSearchService,
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
import { buildTokens, loadTheme, DEFAULT_PALETTE_NAME, ThemeSources } from './tui/theme/index.ts';

// One page. MessageService owns the number and what it means -- opening a chat
// loads this many and reaching the top of them loads another -- so main.ts
// passes it on rather than keeping a second copy that could drift.
const HISTORY_LIMIT = HISTORY_PAGE_SIZE;

const main = async (): Promise<void> => {
  const configurationService = new ConfigurationService();

  let configuration: IApplicationConfiguration;
  try {
    configuration = configurationService.load();
  } catch (error) {
    process.stderr.write(`${isApplicationError(error) ? error.message : String(error)}\n`);
    process.exit(1);
  }

  // Resolved before the renderer exists, so the first frame already carries
  // the right colours. A theme that does not resolve reports itself further
  // down, once there is a store to report into.
  const theme = loadTheme({
    name: configuration.palette,
    userThemeDirectory: configuration.themeDirectory,
  });

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
  const messageSearchService = container.get<MessageSearchService>({ key: BindingKeys.MESSAGE_SEARCH_SERVICE });
  const updateService = container.get<UpdateService>({ key: BindingKeys.UPDATE_SERVICE });
  const differenceService = container.get<DifferenceService>({ key: BindingKeys.DIFFERENCE_SERVICE });

  store.setState({ patch: { connection: 'connected' } });
  await dialogService.sync();

  // After the dialogs, because folder membership is resolved against them and
  // a rail published first would show every folder holding nothing.
  await container.get<FolderService>({ key: BindingKeys.FOLDER_SERVICE }).sync();

  // After dialogService.sync(), because a recovered message can only be
  // cached once its chat has a peers row, and sync() is what writes those.
  // Before firstDialog is read and before the first loadHistory() call below
  // -- catch-up hands every message it recovers to the same
  // UpdateService.apply a live event goes through, and that also touches
  // this chat's dialog row (touchDialog), so a chat catch-up just heard from
  // can still be the one firstDialog picks below, and opens already
  // containing what was missed rather than needing a second fetch.
  //
  // Awaited, and unguarded: catchUp() does not reject. Running here rather
  // than last used to cost the user its integrity warnings -- loadHistory()'s
  // success patch below clears statusMessage unconditionally, so "some missed
  // messages could not be saved" was erased before the first frame. Those
  // warnings now go to IApplicationState.integrityWarning, which nothing but
  // the user's own <C-l> clears, so this ordering costs nothing.
  await differenceService.catchUp();

  const firstDialog = store.getState().dialogs[0];
  if (firstDialog) {
    await messageService.loadHistory({ peerId: firstDialog.peerId, limit: HISTORY_LIMIT });
  }

  // Started only after the initial sync and history load have landed, so the
  // first live message to arrive republishes against a cache and a store
  // that already reflect a full loadHistory rather than racing it from zero.
  const stopReceivingUpdates = updateService.start();

  // Silently drawing sage when the user asked for something else is the
  // confusing failure: they edit the theme file, see no change, and cannot
  // tell whether tglow read it. Reported through integrityWarning rather than
  // statusMessage for the same reason catchUp's warnings are -- only the
  // user's own <C-l> clears it, so the first loadHistory cannot erase it.
  if (theme.source === ThemeSources.FALLBACK) {
    store.setState({ patch: { integrityWarning: `Theme: ${theme.reason} -- drawing ${DEFAULT_PALETTE_NAME}` } });
  }

  // Ctrl-C is a binding, not an exit: the renderer's own handler tears itself
  // down and leaves the database and the client open, and in INSERT it would
  // fire on a keystroke that is meant to reach the composer. quit() below is
  // the only way out, so it always runs.
  const renderer = await createCliRenderer({ exitOnCtrlC: false, useMouse: configuration.mouse });
  const root = createRoot(renderer);

  const quit = (): void => {
    stopReceivingUpdates();
    renderer.destroy();
    database.close();
    void client.destroy();
    process.exit(0);
  };

  /**
   * `:logout`, once the y/n has been answered yes.
   *
   * Three things, in this order, because each is worth less than the one
   * before it and the order is what makes a partial failure safe:
   *
   * 1. `auth.logOut` on the server, which is the only step that actually ends
   *    the session -- deleting the local file alone leaves tglow listed and
   *    authorised under Telegram's own Active Sessions, which is the opposite
   *    of what someone typing "logout" wants.
   * 2. The session file, which is the credential. Deleted even when step 1
   *    failed: an unreachable server must not leave a session key sitting on
   *    disk after the user asked for it to be gone. Telegram invalidates the
   *    key on its side when it eventually hears, and the user can revoke it
   *    from another device meanwhile -- both better than keeping it.
   * 3. The cache, which is message content. Erased because "log out" plainly
   *    means "leave nothing of my account on this machine", and a readable
   *    history after logging out would surprise anyone who meant it.
   *
   * Never rejects: it always reaches the exit.
   */
  const logger = ApplicationLogger.get('logout');
  const logout = async (): Promise<void> => {
    try {
      await client.invoke(new Api.auth.LogOut());
    } catch (error) {
      // Logged, not surfaced: the window is about to close, and there is
      // nothing the user could do with the message except read it going.
      logger.error('Could not sign out on Telegram | Reason: %s', toError(error).message);
    }

    stopReceivingUpdates();
    database.close();

    for (const path of [configuration.sessionPath, configuration.cachePath]) {
      try {
        rmSync(path, { force: true });
      } catch (error) {
        logger.error('Could not erase %s | Reason: %s', path, toError(error).message);
      }
    }

    renderer.destroy();
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
        messageSearchService,
        timeoutMilliseconds: configuration.timeoutMilliseconds,
        tokens: buildTokens({ palette: theme.palette }),
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
          // Read alongside activePeerId rather than threaded through
          // IAppProps.onSend's own signature: App already hands MessageService
          // the composer text it owns, and the reply target is the same kind
          // of App-level state (IApplicationState, not IEngineState) -- the
          // store already closed over here is the natural place to read it.
          const { activePeerId, replyToMessageId } = store.getState();
          if (activePeerId) {
            await messageService.send({ peerId: activePeerId, text, replyToMessageId: replyToMessageId ?? undefined });
          }
        },
        // Same reasoning as onSend above: activePeerId is App-level state
        // read off the same store closure rather than threaded through
        // IAppProps.onEdit's own signature.
        onEdit: async (opts: { messageId: number; text: string }): Promise<void> => {
          const { activePeerId } = store.getState();
          if (activePeerId) {
            await messageService.edit({ peerId: activePeerId, messageId: opts.messageId, text: opts.text });
          }
        },
        // Same reasoning as onSend/onEdit above: activePeerId is App-level
        // state read off the same store closure rather than threaded through
        // IAppProps.onDelete's own signature.
        onPin: async (opts: { peerId: string; messageId: number }): Promise<void> => {
          await messageService.pin(opts);
        },
        onDelete: async (opts: { messageIds: number[] }): Promise<void> => {
          const { activePeerId } = store.getState();
          if (activePeerId) {
            await messageService.delete({ peerId: activePeerId, messageIds: opts.messageIds });
          }
        },
        onQuit: quit,
        onOpenChat: async (opts: { peerId: string }): Promise<void> => {
          await messageService.loadHistory({ peerId: opts.peerId, limit: HISTORY_LIMIT });
        },
        // A pass-through, like onMarkRead: App decides *when* to ask for the
        // page behind the one on screen; every guard on whether to actually
        // fetch it lives in the service.
        onLoadOlder: async (opts: { peerId: string }): Promise<void> => {
          await messageService.loadOlder({ peerId: opts.peerId });
        },
        onLogout: logout,
        // A direct pass-through: App already decides *when* a chat has been
        // read (opening one, or the cursor reaching its newest message) and
        // hands over exactly the peerId/maxId markRead needs -- there is
        // nothing left here for main.ts to resolve off the store closure the
        // way onSend/onEdit/onDelete do above.
        onMarkRead: async (opts: { peerId: string; maxId: number }): Promise<void> => {
          await messageService.markRead(opts);
        },
      }),
    ),
  );
};

await main();
