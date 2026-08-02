import { getError } from '@venizia/ignis-inversion';
import { ApplicationLogger, type ILogger } from '@venizia/ignis-helpers';

export type TAuthenticationStep = 'phone' | 'code' | 'password' | 'ready';

export interface IAuthenticationGateway {
  sendCode(opts: { phone: string }): Promise<void>;
  signIn(opts: { code: string }): Promise<'ok' | 'needPassword'>;
  checkPassword(opts: { password: string }): Promise<void>;
}

/**
 * Login as an explicit state machine. On failure the step is deliberately left
 * unchanged so the interface can simply re-prompt.
 */
export class AuthenticationService {
  private readonly _logger: ILogger = ApplicationLogger.get(AuthenticationService.name);
  private _step: TAuthenticationStep = 'phone';

  constructor(private readonly _gateway: IAuthenticationGateway) {}

  getStep = (): TAuthenticationStep => {
    return this._step;
  };

  submitPhone = async (opts: { phone: string }): Promise<TAuthenticationStep> => {
    if (this._step !== 'phone') {
      throw getError({
        message: `[AuthenticationService][submitPhone] Wrong step | Step: ${this._step}`,
      });
    }

    const phone = opts.phone.trim();
    if (phone === '') {
      throw getError({ message: '[AuthenticationService][submitPhone] A phone number is required' });
    }

    // The phone number is never logged.
    await this._gateway.sendCode({ phone });
    this._step = 'code';
    return this._step;
  };

  submitCode = async (opts: { code: string }): Promise<TAuthenticationStep> => {
    if (this._step !== 'code') {
      throw getError({
        message: `[AuthenticationService][submitCode] Submit a phone number first | Step: ${this._step}`,
      });
    }

    try {
      const result = await this._gateway.signIn({ code: opts.code.trim() });
      this._step = result === 'needPassword' ? 'password' : 'ready';
      return this._step;
    } catch (error) {
      this._logger.for(this.submitCode.name).warn('Sign-in rejected | Reason: %s', error);
      throw error;
    }
  };

  submitPassword = async (opts: { password: string }): Promise<TAuthenticationStep> => {
    if (this._step !== 'password') {
      throw getError({
        message: `[AuthenticationService][submitPassword] No two-factor password was requested | Step: ${this._step}`,
      });
    }

    try {
      await this._gateway.checkPassword({ password: opts.password });
      this._step = 'ready';
      return this._step;
    } catch (error) {
      this._logger.for(this.submitPassword.name).warn('Password rejected | Reason: %s', error);
      throw error;
    }
  };
}
