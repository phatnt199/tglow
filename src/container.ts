import { BindingScopes, Container } from '@venizia/ignis-inversion';
import type { TelegramClient } from 'telegram';

import { BindingKeys } from './common/index.ts';
import {
  ApplicationStoreService,
  DatabaseService,
  DialogService,
  DifferenceService,
  MessageSearchService,
  MessageService,
  SessionStoreService,
  UpdateService,
  type IApplicationConfiguration,
} from './core/index.ts';
import { buildDialogAdapter, buildDifferenceAdapter, buildMessageAdapter } from './core/telegram-adapter.ts';
import { KeyNormalizerService, KeymapService, VimEngineService } from './keys/index.ts';

/** Wires every DI binding `main.ts` resolves. The client and database are built by the caller, since both need async setup this container's synchronous bindings cannot express. */
export const buildContainer = (opts: {
  configuration: IApplicationConfiguration;
  client: TelegramClient;
  database: DatabaseService;
}): Container => {
  const container = new Container({ scope: 'TglowContainer' });

  container.bind({ key: BindingKeys.CONFIGURATION }).toValue(opts.configuration);
  container.bind({ key: BindingKeys.DATABASE }).toValue(opts.database);
  container.bind({ key: BindingKeys.DIALOG_ADAPTER }).toValue(buildDialogAdapter({ client: opts.client }));
  container.bind({ key: BindingKeys.MESSAGE_ADAPTER }).toValue(buildMessageAdapter({ client: opts.client }));
  container.bind({ key: BindingKeys.DIFFERENCE_ADAPTER }).toValue(buildDifferenceAdapter({ client: opts.client }));

  container.bind({ key: BindingKeys.SESSION_STORE }).toClass(SessionStoreService).setScope(BindingScopes.SINGLETON);
  container.bind({ key: BindingKeys.APPLICATION_STORE }).toClass(ApplicationStoreService).setScope(BindingScopes.SINGLETON);
  container.bind({ key: BindingKeys.DIALOG_SERVICE }).toClass(DialogService).setScope(BindingScopes.SINGLETON);
  container.bind({ key: BindingKeys.MESSAGE_SERVICE }).toClass(MessageService).setScope(BindingScopes.SINGLETON);
  container.bind({ key: BindingKeys.MESSAGE_SEARCH_SERVICE }).toClass(MessageSearchService).setScope(BindingScopes.SINGLETON);
  container.bind({ key: BindingKeys.UPDATE_SERVICE }).toClass(UpdateService).setScope(BindingScopes.SINGLETON);
  container.bind({ key: BindingKeys.DIFFERENCE_SERVICE }).toClass(DifferenceService).setScope(BindingScopes.SINGLETON);

  container.bind({ key: BindingKeys.KEY_NORMALIZER }).toClass(KeyNormalizerService).setScope(BindingScopes.SINGLETON);
  container.bind({ key: BindingKeys.VIM_ENGINE }).toClass(VimEngineService).setScope(BindingScopes.SINGLETON);
  container.bind({ key: BindingKeys.KEYMAP }).toClass(KeymapService).setScope(BindingScopes.SINGLETON);

  return container;
};
