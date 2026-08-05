import { test, expect, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PALETTES } from '../../../tui/theme/palettes.ts';
import { ThemeSources, loadTheme, PALETTE_KEYS } from '../../../tui/theme/theme-loader.ts';

const directories: string[] = [];

const buildThemeDirectory = (): string => {
  const directory = mkdtempSync(join(tmpdir(), 'tglow-themes-'));
  directories.push(directory);
  return directory;
};

/** A complete, valid theme file body -- the baseline each malformed case spoils exactly one way. */
const buildThemeSource = (overrides: Partial<Record<string, string>> = {}): string => {
  const values: Record<string, string> = {};
  for (const key of PALETTE_KEYS) {
    values[key] = '#123456';
  }
  return Object.entries({ ...values, ...overrides })
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key} = "${value}"`)
    .join('\n');
};

const writeTheme = (opts: { directory: string; name: string; source: string }): void => {
  writeFileSync(join(opts.directory, `${opts.name}.toml`), opts.source, 'utf-8');
};

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a built-in name resolves to the built-in palette', () => {
  const result = loadTheme({ name: 'ember', userThemeDirectory: buildThemeDirectory() });
  expect(result.source).toBe(ThemeSources.BUILTIN);
  expect(result.palette).toEqual(PALETTES.ember!);
});

test('a .toml in the user directory resolves to it', () => {
  const directory = buildThemeDirectory();
  writeTheme({ directory, name: 'midnight', source: buildThemeSource({ RED: '#AABBCC' }) });

  const result = loadTheme({ name: 'midnight', userThemeDirectory: directory });

  expect(result.source).toBe(ThemeSources.USER);
  expect(result.palette.RED).toBe('#AABBCC');
});

// The point of a user theme directory: you can iterate on `sage` without
// editing the binary, exactly as dropping a colorscheme of the same name into
// ~/.config/nvim/colors shadows one from a plugin.
test('a user theme shadows a built-in of the same name', () => {
  const directory = buildThemeDirectory();
  writeTheme({ directory, name: 'sage', source: buildThemeSource({ RED: '#0F0F0F' }) });

  const result = loadTheme({ name: 'sage', userThemeDirectory: directory });

  expect(result.source).toBe(ThemeSources.USER);
  expect(result.palette.RED).toBe('#0F0F0F');
  expect(result.palette.RED).not.toBe(PALETTES.sage!.RED);
});

test('an unknown name falls back to sage and says so', () => {
  const result = loadTheme({ name: 'nonexistent', userThemeDirectory: buildThemeDirectory() });
  expect(result.source).toBe(ThemeSources.FALLBACK);
  expect(result.palette).toEqual(PALETTES.sage!);
});

test('a missing theme directory is not an error', () => {
  const result = loadTheme({ name: 'sage', userThemeDirectory: '/nonexistent/tglow/themes' });
  expect(result.source).toBe(ThemeSources.BUILTIN);
  expect(result.palette).toEqual(PALETTES.sage!);
});

// Rendering with `undefined` in a colour slot is how a theme half-applies:
// some text draws, some vanishes into the background. Better to say the theme
// is incomplete and draw something legible.
test('a theme missing one key falls back rather than rendering undefined', () => {
  const directory = buildThemeDirectory();
  writeTheme({ directory, name: 'partial', source: buildThemeSource({ WINE: undefined }) });

  const result = loadTheme({ name: 'partial', userThemeDirectory: directory });

  expect(result.source).toBe(ThemeSources.FALLBACK);
  expect(result.palette).toEqual(PALETTES.sage!);
});

test('a value that is not a hex colour falls back', () => {
  const directory = buildThemeDirectory();
  writeTheme({ directory, name: 'bad-value', source: buildThemeSource({ GOLD: 'goldenrod' }) });

  const result = loadTheme({ name: 'bad-value', userThemeDirectory: directory });

  expect(result.source).toBe(ThemeSources.FALLBACK);
});

test('a three-digit hex shorthand is rejected -- the renderer wants six', () => {
  const directory = buildThemeDirectory();
  writeTheme({ directory, name: 'short-hex', source: buildThemeSource({ SKY: '#ABC' }) });

  expect(loadTheme({ name: 'short-hex', userThemeDirectory: directory }).source).toBe(ThemeSources.FALLBACK);
});

// A typo in a theme file is a typo, not a reason to refuse to start.
test('a malformed file falls back and does not throw', () => {
  const directory = buildThemeDirectory();
  writeTheme({ directory, name: 'broken', source: '<<<not toml at all>>>\n\0\0' });

  expect(() => loadTheme({ name: 'broken', userThemeDirectory: directory })).not.toThrow();
  expect(loadTheme({ name: 'broken', userThemeDirectory: directory }).source).toBe(ThemeSources.FALLBACK);
});

test('an empty file falls back', () => {
  const directory = buildThemeDirectory();
  writeTheme({ directory, name: 'empty', source: '' });

  expect(loadTheme({ name: 'empty', userThemeDirectory: directory }).source).toBe(ThemeSources.FALLBACK);
});

test('comments and blank lines in a theme file are ignored, not treated as damage', () => {
  const directory = buildThemeDirectory();
  writeTheme({
    directory,
    name: 'commented',
    source: `# my theme\n\n${buildThemeSource({ TEAL: '#010203' })}\n\n# end\n`,
  });

  const result = loadTheme({ name: 'commented', userThemeDirectory: directory });

  expect(result.source).toBe(ThemeSources.USER);
  expect(result.palette.TEAL).toBe('#010203');
});

// A theme name is used to build a path. Without this, `palette = "../../etc/passwd"`
// in config.toml reads outside the theme directory entirely.
test('a name containing a path separator is refused rather than escaping the directory', () => {
  const directory = buildThemeDirectory();
  mkdirSync(join(directory, 'nested'), { recursive: true });
  writeTheme({ directory: join(directory, 'nested'), source: buildThemeSource(), name: 'escaped' });

  for (const name of ['../nested/escaped', 'nested/escaped', '/etc/passwd', '..']) {
    expect(loadTheme({ name, userThemeDirectory: directory }).source, name).toBe(ThemeSources.FALLBACK);
  }
});

test('a loaded user theme carries every palette key, so semantic tokens derive identically', () => {
  const directory = buildThemeDirectory();
  writeTheme({ directory, name: 'complete', source: buildThemeSource() });

  const result = loadTheme({ name: 'complete', userThemeDirectory: directory });

  expect(result.source).toBe(ThemeSources.USER);
  for (const key of PALETTE_KEYS) {
    expect(result.palette[key], key).toMatch(/^#[0-9A-Fa-f]{6}$/);
  }
});

// PALETTE_KEYS is what the loader validates against and what the README
// documents. If IPalette grows a key and this list does not, a theme missing
// the new key would load with it undefined.
test('PALETTE_KEYS covers exactly the keys a built-in palette has', () => {
  expect(new Set<string>(PALETTE_KEYS)).toEqual(new Set<string>(Object.keys(PALETTES.sage!)));
});

// ---------------------------------------------------------------------------
// The README's worked example is a copy of sage, offered for people to edit.
// A wrong value there is a wrong theme for whoever copies it -- and three of
// the seventeen WERE wrong when this block was first written, the same
// transcription failure that put ember's whole ramp one position off in M1a.
// This reads both sides mechanically so the two cannot share a mistake.
// ---------------------------------------------------------------------------
test("the README's worked example matches sage exactly, key for key", () => {
  const readme = readFileSync(join(import.meta.dir, '../../../../README.md'), 'utf-8');

  for (const [key, value] of Object.entries(PALETTES.sage!)) {
    const match = new RegExp(`^${key}\\s*=\\s*"(#[0-9A-Fa-f]{6})"`, 'm').exec(readme);
    expect(match, `README documents ${key}`).not.toBeNull();
    expect(match![1], `README ${key}`).toBe(value);
  }
});

// A theme file copied straight out of the README must actually load. If the
// documented example were rejected, every user's first theme would fall back.
test("a theme file copied from the README's example loads as a user theme", () => {
  const readme = readFileSync(join(import.meta.dir, '../../../../README.md'), 'utf-8');
  const lines = PALETTE_KEYS.map(key => {
    const match = new RegExp(`^${key}\\s*=\\s*"(#[0-9A-Fa-f]{6})"`, 'm').exec(readme);
    return `${key} = "${match![1]}"`;
  });

  const directory = buildThemeDirectory();
  writeTheme({ directory, name: 'from-readme', source: lines.join('\n') });

  const result = loadTheme({ name: 'from-readme', userThemeDirectory: directory });

  expect(result.source).toBe(ThemeSources.USER);
  expect(result.palette).toEqual(PALETTES.sage!);
});
