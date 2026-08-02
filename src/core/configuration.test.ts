import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigurationService } from './configuration.ts';

const writeConfiguration = (body: string): string => {
  const filePath = join(mkdtempSync(join(tmpdir(), 'tglow-')), 'config.toml');
  writeFileSync(filePath, body);
  return filePath;
};

const service = new ConfigurationService();

test('loads api credentials', () => {
  const filePath = writeConfiguration('api_id = 12345\napi_hash = "abc123"\n');
  const configuration = service.load({ filePath });
  expect(configuration.apiId).toBe(12345);
  expect(configuration.apiHash).toBe('abc123');
});

test('palette defaults to sage', () => {
  const filePath = writeConfiguration('api_id = 1\napi_hash = "x"\n');
  expect(service.load({ filePath }).palette).toBe('sage');
});

test('palette can be overridden', () => {
  const filePath = writeConfiguration('api_id = 1\napi_hash = "x"\npalette = "ember"\n');
  expect(service.load({ filePath }).palette).toBe('ember');
});

test('comments and blank lines are ignored', () => {
  const filePath = writeConfiguration('# a comment\n\napi_id = 7\napi_hash = "y"\n');
  expect(service.load({ filePath }).apiId).toBe(7);
});

test('a missing file explains where to get credentials', () => {
  expect(() => service.load({ filePath: '/nonexistent/config.toml' })).toThrow(/my\.telegram\.org/);
});

test('a missing api_id is reported with the class and method', () => {
  const filePath = writeConfiguration('api_hash = "x"\n');
  expect(() => service.load({ filePath })).toThrow(/\[ConfigurationService\]\[load\]/);
  expect(() => service.load({ filePath })).toThrow(/api_id/);
});

test('a non-numeric api_id is rejected', () => {
  const filePath = writeConfiguration('api_id = "nope"\napi_hash = "x"\n');
  expect(() => service.load({ filePath })).toThrow(/api_id/);
});

test('an empty api_hash is rejected', () => {
  const filePath = writeConfiguration('api_id = 1\napi_hash = ""\n');
  expect(() => service.load({ filePath })).toThrow(/api_hash/);
});

test('derived paths sit under the data directory', () => {
  const filePath = writeConfiguration('api_id = 1\napi_hash = "x"\n');
  const configuration = service.load({ filePath });
  expect(configuration.sessionPath).toContain('tglow');
  expect(configuration.cachePath).toContain('tglow');
  expect(configuration.logPath).toContain('tglow');
});
