import { ApplicationLogger, type ILogger } from '@venizia/ignis-helpers';
import { getError } from '@venizia/ignis-inversion';
import { Api, type TelegramClient } from 'teleproto';
import { computeCheck } from 'teleproto/Password';

import type { IAuthenticationGateway } from './authentication.ts';

const SESSION_PASSWORD_NEEDED = 'SESSION_PASSWORD_NEEDED';

/** Every field GramJS puts on an RPC failure that we are allowed to read. */
interface IRpcError {
  errorMessage?: string;
  message?: string;
}

const isPasswordRequired = (error: IRpcError): boolean => {
  return error.errorMessage === SESSION_PASSWORD_NEEDED || (error.message ?? '').includes(SESSION_PASSWORD_NEEDED);
};

/**
 * `AuthenticationService` on top of GramJS, following the same request sequence
 * as GramJS's own `signInUser`/`signInWithPassword` (`client/auth.js`) without
 * its prompting: tglow owns the terminal, so the prompts have to stay outside.
 *
 * Nothing here logs the phone number, the code, the password or the resulting
 * session — an error's own message is the most that ever reaches the log.
 */
export class TelegramAuthenticationGateway implements IAuthenticationGateway {
  private readonly _logger: ILogger = ApplicationLogger.get(TelegramAuthenticationGateway.name);
  private _phoneNumber: string | null = null;
  private _phoneCodeHash: string | null = null;

  constructor(private readonly _client: TelegramClient) {}

  sendCode = async (opts: { phone: string }): Promise<void> => {
    try {
      const { phoneCodeHash } = await this._client.sendCode(
        { apiId: this._client.apiId, apiHash: this._client.apiHash },
        opts.phone,
      );
      this._phoneNumber = opts.phone;
      this._phoneCodeHash = phoneCodeHash;
    } catch (error) {
      this._logger.for(this.sendCode.name).error('Could not request a code | Reason: %s', error);
      throw error;
    }
  };

  signIn = async (opts: { code: string }): Promise<'ok' | 'needPassword'> => {
    const phoneNumber = this._phoneNumber;
    const phoneCodeHash = this._phoneCodeHash;
    if (!phoneNumber || !phoneCodeHash) {
      throw getError({ message: '[TelegramAuthenticationGateway][signIn] No code has been requested' });
    }

    let result: Api.auth.TypeAuthorization;
    try {
      result = await this._client.invoke(new Api.auth.SignIn({ phoneNumber, phoneCodeHash, phoneCode: opts.code }));
    } catch (error) {
      // Not a failure: an account with two-factor enabled always answers a
      // correct code this way, which is the branch AuthenticationService exists
      // to model.
      if (isPasswordRequired(error as IRpcError)) {
        return 'needPassword';
      }
      this._logger.for(this.signIn.name).warn('Sign-in rejected | Reason: %s', error);
      throw error;
    }

    // Telegram answers a code for an unregistered number with this instead of
    // an authorisation. tglow signs in to an existing account only.
    if (result instanceof Api.auth.AuthorizationSignUpRequired) {
      throw getError({
        message: '[TelegramAuthenticationGateway][signIn] That number has no Telegram account yet',
      });
    }

    return 'ok';
  };

  checkPassword = async (opts: { password: string }): Promise<void> => {
    try {
      const passwordInformation = await this._client.invoke(new Api.account.GetPassword());
      const check = await computeCheck(passwordInformation, opts.password);
      await this._client.invoke(new Api.auth.CheckPassword({ password: check }));
    } catch (error) {
      this._logger.for(this.checkPassword.name).warn('Password rejected | Reason: %s', error);
      throw error;
    }
  };
}
