import { toError } from '@venizia/ignis-helpers';
import { getError } from '@venizia/ignis-inversion';

import type { AuthenticationService, TAuthenticationStep } from '../core/authentication.ts';

import type { TReadLine } from './prompt.ts';

const PHONE_LABEL = 'Phone number (with country code): ';
const CODE_LABEL = 'Code you just received: ';
const PASSWORD_LABEL = 'Two-factor password: ';

/**
 * Per step, reset once a step is behind us. Telegram invalidates the code after
 * a handful of wrong guesses anyway, and an unbounded loop in a terminal that is
 * about to be handed to OpenTUI is worse than an early exit.
 */
const MAX_ATTEMPTS_PER_STEP = 3;

export interface IInteractiveLoginOptions {
  service: AuthenticationService;
  readLine: TReadLine;
  write: (text: string) => void;
}

const submitCurrentStep = async (opts: {
  service: AuthenticationService;
  readLine: TReadLine;
}): Promise<TAuthenticationStep> => {
  const { service, readLine } = opts;
  const step = service.getStep();

  switch (step) {
    case 'phone': {
      return service.submitPhone({ phone: await readLine({ label: PHONE_LABEL, secret: false }) });
    }
    case 'code': {
      // Secret: a code read aloud off a phone and then left in the scrollback
      // is a code anyone reading over a shoulder can still use.
      return service.submitCode({ code: await readLine({ label: CODE_LABEL, secret: true }) });
    }
    case 'password': {
      return service.submitPassword({ password: await readLine({ label: PASSWORD_LABEL, secret: true }) });
    }
    case 'ready': {
      return step;
    }
    default: {
      throw getError({ message: `[interactive-login][submitCurrentStep] Unknown step | Step: ${step}` });
    }
  }
};

/**
 * Runs the tested login state machine against a terminal. Prompts are the only
 * thing added here: every transition, every rejection and every re-prompt is
 * `AuthenticationService`'s, which is why a wrong code simply asks again.
 *
 * Nothing typed at these prompts is ever written back out, logged, or included
 * in the error thrown on failure.
 */
export const runInteractiveLogin = async (opts: IInteractiveLoginOptions): Promise<void> => {
  const { service, readLine, write } = opts;
  let attemptsLeft = MAX_ATTEMPTS_PER_STEP;

  while (service.getStep() !== 'ready') {
    try {
      // A submit that does not throw always advances the step, so this cannot
      // loop for ever on a reset budget.
      await submitCurrentStep({ service, readLine });
      attemptsLeft = MAX_ATTEMPTS_PER_STEP;
      continue;
    } catch (error) {
      attemptsLeft -= 1;
      if (attemptsLeft <= 0) {
        throw getError({
          message: `[interactive-login][runInteractiveLogin] Login failed | Reason: ${toError(error).message}`,
        });
      }
      write(`${toError(error).message}\n`);
    }
  }
};
