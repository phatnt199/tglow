import { test, expect } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { SessionStoreService } from './session-store.ts';

const service = new SessionStoreService();
const buildPath = (): string => join(mkdtempSync(join(tmpdir(), 'tglow-')), 'nested', 'session');

test('a missing session file reads as an empty string', () => {
  expect(service.load({ filePath: buildPath() })).toBe('');
});

test('a saved session round-trips', () => {
  const filePath = buildPath();
  service.save({ filePath, value: '1BQANOTEuMTA4LjU2' });
  expect(service.load({ filePath })).toBe('1BQANOTEuMTA4LjU2');
});

// The session string is equivalent to a logged-in device on the account.
test('the session file is created mode 0600', () => {
  const filePath = buildPath();
  service.save({ filePath, value: 'secret' });
  expect(statSync(filePath).mode & 0o777).toBe(0o600);
});

test('saving creates missing parent directories', () => {
  const filePath = buildPath();
  service.save({ filePath, value: 'x' });
  expect(existsSync(filePath)).toBe(true);
});

test('clear removes the file and reads back empty', () => {
  const filePath = buildPath();
  service.save({ filePath, value: 'x' });
  service.clear({ filePath });
  expect(existsSync(filePath)).toBe(false);
  expect(service.load({ filePath })).toBe('');
});

test('clearing a missing file is not an error', () => {
  expect(() => service.clear({ filePath: buildPath() })).not.toThrow();
});

test('surrounding whitespace is stripped on load', () => {
  const filePath = buildPath();
  service.save({ filePath, value: '  padded  ' });
  expect(service.load({ filePath })).toBe('padded');
});

// writeFileSync's mode is honoured only on creation, so overwriting a file that
// already exists with looser permissions would silently leave it world-readable.
test('saving over an existing loose-permission file tightens it to 0600', () => {
  const filePath = buildPath();
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, 'stale', { mode: 0o644 });
  expect(statSync(filePath).mode & 0o777).toBe(0o644);

  service.save({ filePath, value: 'fresh' });
  expect(statSync(filePath).mode & 0o777).toBe(0o600);
  expect(service.load({ filePath })).toBe('fresh');
});
