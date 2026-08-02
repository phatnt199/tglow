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
  error: string;
}

export const buildTokens = (opts: { paletteName: string }): ITokens => {
  const palette: IPalette = PALETTES[opts.paletteName] ?? PALETTES[DEFAULT_PALETTE_NAME]!;

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
    error: palette.RED,
  };
};
