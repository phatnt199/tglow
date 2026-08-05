import { DEFAULT_PALETTE_NAME, PALETTES, type IPalette } from './palettes.ts';

/** Semantic roles, so components never name a colour and palettes stay swappable. */
export interface ITokens {
  background: string;
  foreground: string;
  border: string;
  dim: string;
  modeNormal: string;
  modeInsert: string;
  modeVisual: string;
  chatUnread: string;
  chatActive: string;
  messageOwn: string;
  messageOther: string;
  messageCursor: string;
  /** `code`/`pre` entities. */
  textCode: string;
  /** `url`/`textUrl`/`mention`/`hashtag` entities. */
  textLink: string;
  error: string;
}

/**
 * Semantic tokens from a palette, whatever produced it. A user theme reaches
 * this with the same seventeen keys a built-in has -- that is what
 * theme-loader validates -- so both derive an identical token set and nothing
 * downstream can tell them apart.
 */
export const buildTokens = (opts: { paletteName: string } | { palette: IPalette }): ITokens => {
  const palette: IPalette = 'palette' in opts
    ? opts.palette
    : PALETTES[opts.paletteName] ?? PALETTES[DEFAULT_PALETTE_NAME]!;

  return {
    background: palette.BACKGROUND,
    foreground: palette.FOREGROUND,
    border: palette.DARK_02,
    dim: palette.DARK_04,
    modeNormal: palette.TEAL,
    modeInsert: palette.GOLD,
    modeVisual: palette.PINK,
    chatUnread: palette.GOLD,
    chatActive: palette.TEAL,
    messageOwn: palette.TEAL,
    messageOther: palette.FOREGROUND,
    messageCursor: palette.DARK_03,
    textCode: palette.GREEN,
    textLink: palette.SKY,
    error: palette.RED,
  };
};
