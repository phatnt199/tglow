import { test, expect } from 'bun:test';

import { Api } from 'telegram';

import { TelegramAuthenticationGateway } from '../../src/core/authentication-gateway.ts';

interface IFakeClient {
  apiId: number;
  apiHash: string;
  sentCodeFor: string[];
  invoked: Api.AnyRequest[];
  sendCode: (credentials: { apiId: number; apiHash: string }, phoneNumber: string) => Promise<{ phoneCodeHash: string }>;
  invoke: (request: Api.AnyRequest) => Promise<unknown>;
}

const buildClient = (opts: { invoke?: (request: Api.AnyRequest) => Promise<unknown> } = {}): IFakeClient => {
  const client: IFakeClient = {
    apiId: 1234,
    apiHash: 'hash',
    sentCodeFor: [],
    invoked: [],
    sendCode: async (_credentials, phoneNumber) => {
      client.sentCodeFor.push(phoneNumber);
      return { phoneCodeHash: 'code-hash' };
    },
    invoke: async request => {
      client.invoked.push(request);
      // GramJS ids are big-integer instances, which this test has no use for;
      // the gateway only ever asks the result what type it is.
      return opts.invoke ? opts.invoke(request) : new Api.auth.Authorization({ user: new Api.UserEmpty({ id: 1 as any }) });
    },
  };
  return client;
};

const buildRpcError = (errorMessage: string): Error => {
  const error = new Error(errorMessage);
  (error as any).errorMessage = errorMessage;
  return error;
};

test('sendCode asks Telegram for a code for that number', async () => {
  const client = buildClient();
  await new TelegramAuthenticationGateway(client as any).sendCode({ phone: '+84900000000' });
  expect(client.sentCodeFor).toEqual(['+84900000000']);
});

// Without a phone code hash the SignIn request is meaningless, so the gateway
// must refuse rather than send a request that cannot succeed.
test('signing in before a code was requested is refused by class and method', async () => {
  const gateway = new TelegramAuthenticationGateway(buildClient() as any);
  await expect(gateway.signIn({ code: '12345' })).rejects.toThrow(
    /\[TelegramAuthenticationGateway\]\[signIn\]/,
  );
});

test('signIn carries the number and hash from sendCode into the request', async () => {
  const client = buildClient();
  const gateway = new TelegramAuthenticationGateway(client as any);

  await gateway.sendCode({ phone: '+84900000000' });
  expect(await gateway.signIn({ code: '12345' })).toBe('ok');

  const request = client.invoked[0] as Api.auth.SignIn;
  expect(request).toBeInstanceOf(Api.auth.SignIn);
  expect(request.phoneNumber).toBe('+84900000000');
  expect(request.phoneCodeHash).toBe('code-hash');
  expect(request.phoneCode).toBe('12345');
});

// This is the whole reason IAuthenticationGateway#signIn returns a union rather
// than throwing: a two-factor account is a normal outcome, not a failure.
test('SESSION_PASSWORD_NEEDED becomes needPassword rather than an error', async () => {
  const client = buildClient({
    invoke: async () => {
      throw buildRpcError('SESSION_PASSWORD_NEEDED');
    },
  });
  const gateway = new TelegramAuthenticationGateway(client as any);

  await gateway.sendCode({ phone: '+84900000000' });
  expect(await gateway.signIn({ code: '12345' })).toBe('needPassword');
});

test('a rejected code is passed through so the prompt can ask again', async () => {
  const client = buildClient({
    invoke: async () => {
      throw buildRpcError('PHONE_CODE_INVALID');
    },
  });
  const gateway = new TelegramAuthenticationGateway(client as any);

  await gateway.sendCode({ phone: '+84900000000' });
  await expect(gateway.signIn({ code: '00000' })).rejects.toThrow(/PHONE_CODE_INVALID/);
});

test('a number with no account is rejected rather than signed up', async () => {
  const client = buildClient({
    invoke: async () => new Api.auth.AuthorizationSignUpRequired({}),
  });
  const gateway = new TelegramAuthenticationGateway(client as any);

  await gateway.sendCode({ phone: '+84900000000' });
  await expect(gateway.signIn({ code: '12345' })).rejects.toThrow(/no Telegram account/);
});

test('checkPassword fetches the SRP parameters before checking anything', async () => {
  const client = buildClient({
    invoke: async request => {
      if (request instanceof Api.account.GetPassword) {
        throw buildRpcError('PASSWORD_TOO_FRESH');
      }
      return undefined;
    },
  });
  const gateway = new TelegramAuthenticationGateway(client as any);

  await expect(gateway.checkPassword({ password: 'hunter2' })).rejects.toThrow(/PASSWORD_TOO_FRESH/);
  expect(client.invoked[0]).toBeInstanceOf(Api.account.GetPassword);
});
