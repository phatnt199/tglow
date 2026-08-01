/** Every dependency-injection key in the application. Format: `@tglow/[component]/[feature]`. */
export class BindingKeys {
  static readonly CONFIGURATION = '@tglow/core/configuration';
  static readonly LOGGER_PROVIDER = '@tglow/core/logger-provider';
  static readonly SESSION_STORE = '@tglow/core/session-store';
  static readonly DATABASE = '@tglow/core/database';
  static readonly APPLICATION_STORE = '@tglow/core/application-store';
  static readonly TELEGRAM_CLIENT = '@tglow/core/telegram-client';
  static readonly AUTHENTICATION = '@tglow/core/authentication';
  static readonly DIALOG_SERVICE = '@tglow/core/dialog-service';
  static readonly MESSAGE_SERVICE = '@tglow/core/message-service';
  static readonly DIALOG_ADAPTER = '@tglow/core/dialog-adapter';
  static readonly MESSAGE_ADAPTER = '@tglow/core/message-adapter';

  static readonly KEY_NORMALIZER = '@tglow/keys/key-normalizer';
  static readonly VIM_ENGINE = '@tglow/keys/vim-engine';
  static readonly KEYMAP = '@tglow/keys/keymap';
}
