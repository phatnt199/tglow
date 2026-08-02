import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { Logger } from 'telegram/extensions/Logger';

import type { IApplicationConfiguration } from './common/index.ts';
import type { SessionStoreService } from './session-store.ts';

const CONNECTION_RETRIES = 5;
const RETRY_DELAY_MILLISECONDS = 1000;

export class TelegramClientService {
  constructor(private readonly _sessionStore: SessionStoreService) {}

  /**
   * Device fields are truthful on purpose: misrepresenting the client is one of
   * the behaviours that attracts account restrictions.
   */
  build = (opts: { configuration: IApplicationConfiguration }): TelegramClient => {
    const { configuration } = opts;
    const session = new StringSession(this._sessionStore.load({ filePath: configuration.sessionPath }));

    const client = new TelegramClient(session, configuration.apiId, configuration.apiHash, {
      connectionRetries: CONNECTION_RETRIES,
      retryDelay: RETRY_DELAY_MILLISECONDS,
      autoReconnect: true,
      deviceModel: 'tglow',
      systemVersion: process.platform,
      appVersion: '0.1.0',
      baseLogger: new Logger('error' as never),
    });

    // GramJS parses the message as Markdown by default, so `__init__.py` would
    // send as bold "init" plus ".py" with nothing on screen to show it happened.
    // The composer is plain text and what you type is what you send; composing
    // formatting is a deliberate feature, not a side effect.
    client.setParseMode(undefined);

    return client;
  };

  persistSession = (opts: { client: TelegramClient; configuration: IApplicationConfiguration }): void => {
    // GramJS types Session#save() as `void` on the abstract base even though
    // StringSession overrides it to return the session string at runtime, so
    // the cast is unavoidable; the typeof check guards the mismatch for real.
    const value = opts.client.session.save() as any;
    if (typeof value !== 'string' || value === '') {
      return;
    }
    this._sessionStore.save({ filePath: opts.configuration.sessionPath, value });
  };
}
