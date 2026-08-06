import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { ConfigurationService } from '../../core/configuration.ts';

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

// vim's own timeoutlen default -- see src/tui/app.tsx, which owns the timer
// this value governs.
test('timeoutMilliseconds defaults to 400', () => {
  const filePath = writeConfiguration('api_id = 1\napi_hash = "x"\n');
  expect(service.load({ filePath }).timeoutMilliseconds).toBe(400);
});

test('timeoutMilliseconds can be overridden', () => {
  const filePath = writeConfiguration('api_id = 1\napi_hash = "x"\ntimeout_milliseconds = 250\n');
  expect(service.load({ filePath }).timeoutMilliseconds).toBe(250);
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

// Beside the config file rather than under the data directory: themes are
// hand-edited input like config.toml itself, not state tglow writes. Deriving
// it from the config file's own directory is what keeps a config loaded from
// somewhere else -- a test, a second profile -- reading its themes from beside
// itself instead of reaching back into ~/.config.
test('the theme directory sits beside the config file that named it', () => {
  const filePath = writeConfiguration('api_id = 1\napi_hash = "x"\n');
  expect(service.load({ filePath }).themeDirectory).toBe(join(dirname(filePath), 'themes'));
});

test('the theme directory does not move when a palette is chosen', () => {
  const filePath = writeConfiguration('api_id = 1\napi_hash = "x"\npalette = "mine"\n');
  const configuration = service.load({ filePath });
  expect(configuration.palette).toBe('mine');
  expect(configuration.themeDirectory).toBe(join(dirname(filePath), 'themes'));
});

// Default true because that is what already happened: OpenTUI resolves
// useMouse ?? true, so reporting was on from M1a while nothing handled an
// event. The key exists to turn it OFF, for anyone who would rather keep their
// terminal's own selection unconditionally.
test('the mouse is on unless the config explicitly turns it off', () => {
  expect(service.load({ filePath: writeConfiguration('api_id = 1\napi_hash = "x"\n') }).mouse).toBe(true);
  expect(service.load({ filePath: writeConfiguration('api_id = 1\napi_hash = "x"\nmouse = true\n') }).mouse).toBe(true);
});

test('mouse = false hands the mouse back to the terminal', () => {
  expect(service.load({ filePath: writeConfiguration('api_id = 1\napi_hash = "x"\nmouse = false\n') }).mouse).toBe(false);
});

// A typo must not silently disable the mouse -- the failure would be invisible,
// since a mouse that does nothing looks exactly like one that is not supported.
test('a value that is neither true nor false leaves the mouse on', () => {
  expect(service.load({ filePath: writeConfiguration('api_id = 1\napi_hash = "x"\nmouse = yes\n') }).mouse).toBe(true);
});
