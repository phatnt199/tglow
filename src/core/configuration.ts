import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { getError } from '@venizia/ignis-inversion';

import { resolvePlatformDirectories, APPLICATION_DIRECTORY, type IPlatformDirectories } from './platform-paths.ts';

import type { IApplicationConfiguration } from './common/index.ts';

const DEFAULT_PALETTE = 'sage';
/** vim's own `timeoutlen` default. */
const DEFAULT_TIMEOUT_MILLISECONDS = 400;

const SETUP_HINT = [
  'Create it with:',
  '',
  '  mkdir -p ~/.config/tglow',
  '  printf \'api_id = 0\\napi_hash = ""\\n\' > ~/.config/tglow/config.toml',
  '',
  'Get api_id and api_hash from https://my.telegram.org (log in, API development tools).',
].join('\n');

/**
 * Minimal TOML reader: bare `key = value` pairs, strings and integers only.
 *
 * A free function rather than a private method because theme files are read
 * with exactly this grammar -- seventeen quoted hex strings -- and the plan
 * asks for the reader to be reused rather than for a TOML dependency to be
 * added for the sake of one more file. Nothing about it is configuration
 * specific; the key names it does not know about are the caller's business.
 *
 * A line it cannot parse is skipped, not an error. That is the right shape for
 * both callers: a config file with a stray line still yields its api_id, and a
 * theme file with one is caught by the caller's own key check, which reports
 * what is actually missing instead of a parse position.
 */
export const parseTomlPairs = (opts: { source: string }): Record<string, string | number> => {
  const parsed: Record<string, string | number> = {};

  for (const line of opts.source.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }

    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/.exec(trimmed);
    if (!match) {
      continue;
    }

    const key = match[1]!;
    const value = match[2]!.trim();

    if (/^".*"$/.test(value)) {
      parsed[key] = value.slice(1, -1);
      continue;
    }
    if (/^-?\d+$/.test(value)) {
      parsed[key] = Number(value);
      continue;
    }
    parsed[key] = value;
  }

  return parsed;
};

export class ConfigurationService {
  /** Where the platform expects tglow's files to live. See platform-paths.ts. */
  private directories = (): IPlatformDirectories => resolvePlatformDirectories({
    platform: process.platform,
    homeDirectory: homedir(),
    environment: process.env,
  });

  getDefaultPath = (opts: {
    platform?: string;
    homeDirectory?: string;
    environment?: Record<string, string | undefined>;
    fileExists?: (path: string) => boolean;
  } = {}): string => {
    const platform = opts.platform ?? process.platform;
    const homeDirectory = opts.homeDirectory ?? homedir();
    const environment = opts.environment ?? process.env;
    const fileExists = opts.fileExists ?? existsSync;

    if (platform === 'win32') {
      const dotConfigPath = join(homeDirectory, '.config', APPLICATION_DIRECTORY, 'config.toml');
      if (fileExists(dotConfigPath)) {
        return dotConfigPath;
      }
    }

    const { configDirectory } = resolvePlatformDirectories({
      platform,
      homeDirectory,
      environment,
    });
    return join(configDirectory, 'config.toml');
  };

  private parse = parseTomlPairs;

  load = (opts: { filePath?: string } = {}): IApplicationConfiguration => {
    const filePath = opts.filePath ?? this.getDefaultPath();

    if (!existsSync(filePath)) {
      throw getError({
        message: `[ConfigurationService][load] No config file | Path: ${filePath}\n\n${SETUP_HINT}`,
      });
    }

    const raw = this.parse({ source: readFileSync(filePath, 'utf8') });

    if (typeof raw.api_id !== 'number') {
      throw getError({
        message: `[ConfigurationService][load] api_id missing or not a number | Path: ${filePath}\n\n${SETUP_HINT}`,
      });
    }
    if (typeof raw.api_hash !== 'string' || raw.api_hash === '') {
      throw getError({
        message: `[ConfigurationService][load] api_hash missing or empty | Path: ${filePath}\n\n${SETUP_HINT}`,
      });
    }

    const { dataDirectory } = this.directories();

    return {
      apiId: raw.api_id,
      apiHash: raw.api_hash,
      palette: typeof raw.palette === 'string' ? raw.palette : DEFAULT_PALETTE,
      timeoutMilliseconds: typeof raw.timeout_milliseconds === 'number'
        ? raw.timeout_milliseconds
        : DEFAULT_TIMEOUT_MILLISECONDS,
      sessionPath: join(dataDirectory, 'session'),
      cachePath: join(dataDirectory, 'cache.sqlite'),
      thumbnailDirectory: join(dataDirectory, 'thumbnails'),
      logPath: join(dataDirectory, 'tglow.log'),
      // Beside the config file, not under dataHome: themes are hand-edited
      // input like config.toml, not state tglow writes. Derived from the
      // config file's own directory so a --config elsewhere keeps its themes
      // next to it rather than reaching back into ~/.config.
      themeDirectory: join(dirname(filePath), 'themes'),
      // Only an explicit `mouse = false` turns it off. Anything else -- absent,
      // misspelled, a number -- leaves it on, which is what the renderer
      // already did before this key existed.
      mouse: raw.mouse !== 'false' && raw.mouse !== 0,
      // Only an explicit `update_check = false` turns it off, matching how
      // `mouse` above reads: a misspelling leaves the default in place rather
      // than silently disabling something.
      updateCheck: raw.update_check !== 'false' && raw.update_check !== 0,
    };
  };
}
