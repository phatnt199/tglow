export interface IPalette {
  FOREGROUND: string;
  BACKGROUND: string;
  RED: string;
  GREEN: string;
  BLUE: string;
  ORANGE: string;
  YELLOW: string;
  PINK: string;
  GOLD: string;
  TEAL: string;
  SKY: string;
  WINE: string;
  DARK_00: string;
  DARK_01: string;
  DARK_02: string;
  DARK_03: string;
  DARK_04: string;
}

/** Muted, grey-tinted, calm. One for the quiet night. */
const SAGE: IPalette = {
  FOREGROUND: '#E6E6E6',
  BACKGROUND: '#080808',
  RED: '#AF5F5F',
  GREEN: '#87AFAF',
  BLUE: '#7590AF',
  ORANGE: '#D59572',
  YELLOW: '#E5B567',
  PINK: '#D68C8C',
  GOLD: '#EBC17A',
  TEAL: '#7DB9B6',
  SKY: '#7EAAC7',
  WINE: '#924653',
  DARK_00: '#111111',
  DARK_01: '#181818',
  DARK_02: '#282828',
  DARK_03: '#383838',
  DARK_04: '#797979',
};

/** Not the flame itself, but the glowing coals underneath. */
const EMBER: IPalette = {
  FOREGROUND: '#F5F0EB',
  BACKGROUND: '#141311',
  RED: '#D06060',
  GREEN: '#6AADAD',
  BLUE: '#5A9D9D',
  ORANGE: '#D4785E',
  YELLOW: '#E0BA6A',
  PINK: '#E08B72',
  GOLD: '#EACA80',
  TEAL: '#7BBDBD',
  SKY: '#6AADAD',
  WINE: '#B45A42',
  DARK_00: '#1A1917',
  DARK_01: '#211F1D',
  DARK_02: '#2E2B28',
  DARK_03: '#3D3935',
  DARK_04: '#847C74',
};

export const PALETTES: Record<string, IPalette> = { sage: SAGE, ember: EMBER };
export const DEFAULT_PALETTE_NAME = 'sage';
