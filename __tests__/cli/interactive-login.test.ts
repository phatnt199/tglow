import { test, expect } from 'bun:test';

import { runInteractiveLogin } from '../../src/cli/interactive-login.ts';
import type { TReadLine } from '../../src/cli/prompt.ts';
import { AuthenticationService, type IAuthenticationGateway } from '../../src/core/authentication.ts';

interface IPromptRecord {
  label: string;
  secret: boolean;
}

const buildGateway = (overrides: Partial<IAuthenticationGateway> = {}): IAuthenticationGateway => ({
  sendCode: async () => {},
  signIn: async () => 'ok',
  checkPassword: async () => {},
  ...overrides,
});

const buildReadLine = (opts: {
  answers: string[];
  prompts: IPromptRecord[];
}): TReadLine => {
  let index = 0;
  return async (prompt: { label: string; secret: boolean }): Promise<string> => {
    opts.prompts.push({ label: prompt.label, secret: prompt.secret });
    const answer = opts.answers[index];
    index += 1;
    if (answer === undefined) {
      throw new Error('the flow asked for more input than the test supplied');
    }
    return answer;
  };
};

test('a plain login walks phone then code and ends ready', async () => {
  const prompts: IPromptRecord[] = [];
  const service = new AuthenticationService(buildGateway());

  await runInteractiveLogin({
    service,
    readLine: buildReadLine({ answers: ['+84900000000', '12345'], prompts }),
    write: () => {},
  });

  expect(service.getStep()).toBe('ready');
  expect(prompts.map(prompt => prompt.label)).toEqual([
    'Phone number (with country code): ',
    'Code you just received: ',
  ]);
});

// The reason readLine takes a `secret` flag at all: echoing either of these
// leaves it in the terminal's scrollback in cleartext.
test('the code and the password are read without echo, the phone number with', async () => {
  const prompts: IPromptRecord[] = [];

  await runInteractiveLogin({
    service: new AuthenticationService(buildGateway({ signIn: async () => 'needPassword' })),
    readLine: buildReadLine({ answers: ['+84900000000', '12345', 'hunter2'], prompts }),
    write: () => {},
  });

  expect(prompts.map(prompt => prompt.secret)).toEqual([false, true, true]);
});

test('two-factor accounts are carried through the password step', async () => {
  const service = new AuthenticationService(buildGateway({ signIn: async () => 'needPassword' }));

  await runInteractiveLogin({
    service,
    readLine: buildReadLine({ answers: ['+84900000000', '12345', 'hunter2'], prompts: [] }),
    write: () => {},
  });

  expect(service.getStep()).toBe('ready');
});

test('a wrong code re-prompts rather than giving up', async () => {
  const prompts: IPromptRecord[] = [];
  let attempt = 0;
  const service = new AuthenticationService(
    buildGateway({
      signIn: async () => {
        attempt += 1;
        if (attempt === 1) {
          throw new Error('PHONE_CODE_INVALID');
        }
        return 'ok';
      },
    }),
  );

  await runInteractiveLogin({
    service,
    readLine: buildReadLine({ answers: ['+84900000000', '00000', '12345'], prompts }),
    write: () => {},
  });

  expect(service.getStep()).toBe('ready');
  expect(prompts.map(prompt => prompt.label)).toEqual([
    'Phone number (with country code): ',
    'Code you just received: ',
    'Code you just received: ',
  ]);
});

test('a repeatedly wrong code fails instead of prompting for ever', async () => {
  const prompts: IPromptRecord[] = [];
  const service = new AuthenticationService(
    buildGateway({
      signIn: async () => {
        throw new Error('PHONE_CODE_INVALID');
      },
    }),
  );

  await expect(
    runInteractiveLogin({
      service,
      readLine: buildReadLine({ answers: ['+84900000000', '1', '2', '3'], prompts }),
      write: () => {},
    }),
  ).rejects.toThrow(/PHONE_CODE_INVALID/);

  expect(prompts.filter(prompt => prompt.secret)).toHaveLength(3);
});

test('nothing typed at a prompt is echoed back or put in the failure', async () => {
  const written: string[] = [];
  const secret = 'sup3rs3cr3t-code';

  await expect(
    runInteractiveLogin({
      service: new AuthenticationService(
        buildGateway({
          signIn: async () => {
            throw new Error('PHONE_CODE_INVALID');
          },
        }),
      ),
      readLine: buildReadLine({ answers: ['+84900000000', secret, secret, secret], prompts: [] }),
      write: (text: string) => {
        written.push(text);
      },
    }),
  ).rejects.toThrow(/PHONE_CODE_INVALID/);

  expect(written.join('').includes(secret)).toBe(false);
  expect(written.join('').includes('+84900000000')).toBe(false);
});

// A mistyped code should not eat the password's attempts: the two are typed by
// different halves of the brain and a shared budget punishes the second for the
// first.
test('each step gets its own attempts', async () => {
  const prompts: IPromptRecord[] = [];
  let passwordAttempt = 0;
  const service = new AuthenticationService(
    buildGateway({
      signIn: async () => 'needPassword',
      checkPassword: async () => {
        passwordAttempt += 1;
        if (passwordAttempt < 3) {
          throw new Error('PASSWORD_HASH_INVALID');
        }
      },
    }),
  );

  await runInteractiveLogin({
    service,
    readLine: buildReadLine({ answers: ['+84900000000', '12345', 'a', 'b', 'hunter2'], prompts }),
    write: () => {},
  });

  expect(service.getStep()).toBe('ready');
  expect(prompts.filter(prompt => prompt.label.startsWith('Two-factor'))).toHaveLength(3);
});

test('an already-authenticated service asks for nothing', async () => {
  const service = new AuthenticationService(buildGateway());
  await service.submitPhone({ phone: '+84900000000' });
  await service.submitCode({ code: '12345' });

  const prompts: IPromptRecord[] = [];
  await runInteractiveLogin({
    service,
    readLine: buildReadLine({ answers: [], prompts }),
    write: () => {},
  });

  expect(prompts).toEqual([]);
});
