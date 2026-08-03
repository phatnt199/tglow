import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { getError } from '@venizia/ignis-inversion';

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

export class ConfigurationService {
  getDefaultPath = (): string => {
    return join(homedir(), '.config', 'tglow', 'config.toml');
  };

  /** Minimal TOML reader: bare `key = value` pairs, strings and integers only. */
  private parse = (opts: { source: string }): Record<string, string | number> => {
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

    const dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share');

    return {
      apiId: raw.api_id,
      apiHash: raw.api_hash,
      palette: typeof raw.palette === 'string' ? raw.palette : DEFAULT_PALETTE,
      timeoutMilliseconds: typeof raw.timeout_milliseconds === 'number'
        ? raw.timeout_milliseconds
        : DEFAULT_TIMEOUT_MILLISECONDS,
      sessionPath: join(dataHome, 'tglow', 'session'),
      cachePath: join(dataHome, 'tglow', 'cache.sqlite'),
      logPath: join(dataHome, 'tglow', 'tglow.log'),
    };
  };
}
