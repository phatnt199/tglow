import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

import { parseTomlPairs } from '../../core/configuration.ts';
import { DEFAULT_PALETTE_NAME, PALETTES, type IPalette } from './palettes.ts';

/**
 * The seventeen devglow roles, in the order the README documents them. The
 * loader validates a user theme against exactly this list, which is what lets
 * buildTokens derive the same semantic tokens from a user theme as from a
 * built-in: a theme cannot break the interface by leaving a role out, because
 * one missing key rejects the whole file.
 */
export const PALETTE_KEYS: Array<keyof IPalette> = [
  'FOREGROUND', 'BACKGROUND', 'RED', 'GREEN', 'BLUE', 'ORANGE', 'YELLOW',
  'PINK', 'GOLD', 'TEAL', 'SKY', 'WINE',
  'DARK_00', 'DARK_01', 'DARK_02', 'DARK_03', 'DARK_04',
];

export class ThemeSources {
  /** One of the twelve devglow palettes compiled into the binary. */
  static readonly BUILTIN = 'builtin';
  /** A .toml the user dropped into their theme directory. */
  static readonly USER = 'user';
  /** Nothing usable was found under that name, so sage is being drawn instead. */
  static readonly FALLBACK = 'fallback';
}

export type TThemeSource = (typeof ThemeSources)[Exclude<keyof typeof ThemeSources, 'prototype'>];

export interface ILoadedTheme {
  palette: IPalette;
  source: TThemeSource;
  /** Why the fallback happened, for the status line. Null unless source is FALLBACK. */
  reason: string | null;
}

const HEX_COLOUR_PATTERN = /^#[0-9A-Fa-f]{6}$/;

export const getDefaultThemeDirectory = (): string => {
  return join(homedir(), '.config', 'tglow', 'themes');
};

/**
 * A theme name becomes a path, so it must not be able to point outside the
 * theme directory. Rather than resolve-and-compare, the name has to survive
 * basename() unchanged: that rejects every separator and `..` in one check,
 * on both path flavours, with nothing to get subtly wrong.
 */
const isSafeThemeName = (opts: { name: string }): boolean => {
  const { name } = opts;
  return name !== '' && name !== '.' && name !== '..'
    && !name.includes('/') && !name.includes('\\')
    && basename(name) === name;
};

/**
 * Every key present and every value a six-digit hex colour, or nothing. A
 * partially-applied theme is worse than no theme: some text draws in the new
 * colours and some draws with `undefined`, which the renderer resolves to the
 * background, so parts of the interface simply vanish.
 */
const toPalette = (opts: { pairs: Record<string, string | number> }): { palette: IPalette | null; reason: string | null } => {
  const { pairs } = opts;
  const palette: Record<string, string> = {};

  for (const key of PALETTE_KEYS) {
    const value = pairs[key];
    if (typeof value !== 'string') {
      return { palette: null, reason: `missing ${key}` };
    }
    if (!HEX_COLOUR_PATTERN.test(value)) {
      return { palette: null, reason: `${key} is not a #RRGGBB colour` };
    }
    palette[key] = value;
  }

  return { palette: palette as unknown as IPalette, reason: null };
};

/**
 * Resolves a palette name to the colours to draw with.
 *
 * User themes shadow built-ins deliberately: dropping `sage.toml` into the
 * theme directory overrides the compiled sage, the same way a colorscheme in
 * ~/.config/nvim/colors wins over one from a plugin. It is the only way to
 * adjust a shipped palette without rebuilding.
 *
 * Never throws. A theme file is edited by hand, so a typo in one is ordinary,
 * and refusing to start a chat client over a wrong colour would be absurd --
 * every failure resolves to sage and reports itself through `source` and
 * `reason` so the caller can say what happened.
 */
export const loadTheme = (opts: { name: string; userThemeDirectory: string }): ILoadedTheme => {
  const { name, userThemeDirectory } = opts;

  const fallback = (reason: string): ILoadedTheme => ({
    palette: PALETTES[DEFAULT_PALETTE_NAME]!,
    source: ThemeSources.FALLBACK,
    reason,
  });

  if (!isSafeThemeName({ name })) {
    return fallback(`"${name}" is not a valid theme name`);
  }

  const themePath = join(userThemeDirectory, `${name}.toml`);
  if (existsSync(themePath)) {
    try {
      const { palette, reason } = toPalette({ pairs: parseTomlPairs({ source: readFileSync(themePath, 'utf-8') }) });
      if (palette !== null) {
        return { palette, source: ThemeSources.USER, reason: null };
      }
      return fallback(`${name}.toml: ${reason}`);
    } catch (error) {
      // Unreadable, a directory, invalid UTF-8 -- all the same to the reader,
      // and none of them a reason to fail to start.
      return fallback(`${name}.toml could not be read (${String(error)})`);
    }
  }

  const builtin = PALETTES[name];
  if (builtin !== undefined) {
    return { palette: builtin, source: ThemeSources.BUILTIN, reason: null };
  }

  return fallback(`no built-in or user theme named "${name}"`);
};
