import { test, expect } from 'bun:test';

import { resolvePlatformDirectories } from '../../core/platform-paths.ts';

// Every branch here is about a platform the machine running these tests is
// not, which is exactly why resolvePlatformDirectories is told its platform
// rather than reading process.platform itself. Paths are compared with join()
// rather than written out, so the separator is the host's and the assertion
// stays true wherever the suite runs.
const join = (...parts: string[]): string => parts.join(require('node:path').sep);

// ── Linux ─────────────────────────────────────────────────────────────────

test('Linux uses XDG, defaulting to ~/.config and ~/.local/share', () => {
  expect(resolvePlatformDirectories({
    platform: 'linux', homeDirectory: '/home/ada', environment: {},
  })).toEqual({
    configDirectory: join('/home/ada', '.config', 'tglow'),
    dataDirectory: join('/home/ada', '.local', 'share', 'tglow'),
  });
});

test('XDG_CONFIG_HOME and XDG_DATA_HOME are honoured when set', () => {
  expect(resolvePlatformDirectories({
    platform: 'linux',
    homeDirectory: '/home/ada',
    environment: { XDG_CONFIG_HOME: '/cfg', XDG_DATA_HOME: '/dat' },
  })).toEqual({
    configDirectory: join('/cfg', 'tglow'),
    dataDirectory: join('/dat', 'tglow'),
  });
});

// An exported-but-empty variable is a common way for a shell profile to be
// subtly wrong, and treating '' as "set" puts tglow's files at /tglow.
test('an empty XDG variable falls back rather than being taken literally', () => {
  expect(resolvePlatformDirectories({
    platform: 'linux', homeDirectory: '/home/ada',
    environment: { XDG_CONFIG_HOME: '', XDG_DATA_HOME: '   ' },
  })).toEqual({
    configDirectory: join('/home/ada', '.config', 'tglow'),
    dataDirectory: join('/home/ada', '.local', 'share', 'tglow'),
  });
});

// ── macOS ─────────────────────────────────────────────────────────────────

// Deliberately XDG rather than ~/Library/Application Support. tglow is a
// terminal program configured by hand-editing a file, and every neighbour it
// has on a Mac -- nvim, git, tmux -- keeps that file in ~/.config.
test('macOS gets the same XDG layout as Linux, not Application Support', () => {
  const directories = resolvePlatformDirectories({
    platform: 'darwin', homeDirectory: '/Users/ada', environment: {},
  });

  expect(directories).toEqual({
    configDirectory: join('/Users/ada', '.config', 'tglow'),
    dataDirectory: join('/Users/ada', '.local', 'share', 'tglow'),
  });
  expect(directories.configDirectory).not.toContain('Library');
});

// ── Windows ───────────────────────────────────────────────────────────────

// Roaming for what the user edits, local for what tglow writes -- which is
// the distinction Windows has both for. A thumbnail cache is not something to
// synchronise between machines.
test('Windows splits the roaming config from the local state', () => {
  expect(resolvePlatformDirectories({
    platform: 'win32',
    homeDirectory: 'C:\\Users\\Ada',
    environment: { APPDATA: 'C:\\Users\\Ada\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\Ada\\AppData\\Local' },
  })).toEqual({
    configDirectory: join('C:\\Users\\Ada\\AppData\\Roaming', 'tglow'),
    dataDirectory: join('C:\\Users\\Ada\\AppData\\Local', 'tglow'),
  });
});

test('Windows without those variables falls back under the profile, not to XDG', () => {
  const directories = resolvePlatformDirectories({
    platform: 'win32', homeDirectory: 'C:\\Users\\Ada', environment: {},
  });

  expect(directories).toEqual({
    configDirectory: join('C:\\Users\\Ada', 'AppData', 'Roaming', 'tglow'),
    dataDirectory: join('C:\\Users\\Ada', 'AppData', 'Local', 'tglow'),
  });
  expect(directories.configDirectory).not.toContain('.config');
});

// The one thing that must never differ: config and state are separate
// directories on every platform, because one is hand-edited input and the
// other is a cache that can be deleted.
test('config and state never land in the same directory', () => {
  for (const platform of ['linux', 'darwin', 'win32']) {
    const directories = resolvePlatformDirectories({
      platform, homeDirectory: '/home/ada', environment: {},
    });
    expect(directories.configDirectory).not.toBe(directories.dataDirectory);
  }
});
