import { test, expect } from 'bun:test';

import { AuthenticationService, type IAuthenticationGateway } from './authentication.ts';

const buildGateway = (overrides: Partial<IAuthenticationGateway> = {}): IAuthenticationGateway => ({
  sendCode: async () => {},
  signIn: async () => 'ok',
  checkPassword: async () => {},
  ...overrides,
});

test('starts at the phone step', () => {
  expect(new AuthenticationService(buildGateway()).getStep()).toBe('phone');
});

test('a valid phone advances to the code step', async () => {
  const service = new AuthenticationService(buildGateway());
  expect(await service.submitPhone({ phone: '+84900000000' })).toBe('code');
});

test('a correct code with no two-factor reaches ready', async () => {
  const service = new AuthenticationService(buildGateway());
  await service.submitPhone({ phone: '+84900000000' });
  expect(await service.submitCode({ code: '12345' })).toBe('ready');
});

test('an account with two-factor is routed to the password step', async () => {
  const service = new AuthenticationService(buildGateway({ signIn: async () => 'needPassword' }));
  await service.submitPhone({ phone: '+84900000000' });
  expect(await service.submitCode({ code: '12345' })).toBe('password');
  expect(await service.submitPassword({ password: 'hunter2' })).toBe('ready');
});

test('submitting out of order is rejected with the class and method', async () => {
  const service = new AuthenticationService(buildGateway());
  await expect(service.submitCode({ code: '12345' })).rejects.toThrow(/\[AuthenticationService\]\[submitCode\]/);
});

test('a wrong code keeps us on the code step', async () => {
  const service = new AuthenticationService(
    buildGateway({ signIn: async () => { throw new Error('PHONE_CODE_INVALID'); } }),
  );
  await service.submitPhone({ phone: '+84900000000' });
  await expect(service.submitCode({ code: '00000' })).rejects.toThrow(/PHONE_CODE_INVALID/);
  expect(service.getStep()).toBe('code');
});

test('a wrong password keeps us on the password step', async () => {
  const service = new AuthenticationService(
    buildGateway({
      signIn: async () => 'needPassword',
      checkPassword: async () => { throw new Error('PASSWORD_HASH_INVALID'); },
    }),
  );
  await service.submitPhone({ phone: '+84900000000' });
  await service.submitCode({ code: '12345' });
  await expect(service.submitPassword({ password: 'wrong' })).rejects.toThrow(/PASSWORD_HASH_INVALID/);
  expect(service.getStep()).toBe('password');
});

test('an empty phone is rejected before any network call', async () => {
  let called = false;
  const service = new AuthenticationService(buildGateway({ sendCode: async () => { called = true; } }));
  await expect(service.submitPhone({ phone: '   ' })).rejects.toThrow(/phone/i);
  expect(called).toBe(false);
});
