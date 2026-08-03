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
  DARK_00: '#0D0D0B',
  DARK_01: '#1A1917',
  DARK_02: '#2E2C28',
  DARK_03: '#3A3835',
  DARK_04: '#78716C',
};

/** Honey, parchment, warm sienna — fossilized sunlight. One for the golden hour. */
const AMBER: IPalette = {
  FOREGROUND: '#EDE5D8',
  BACKGROUND: '#0D0B08',
  RED: '#B86B5A',
  GREEN: '#8A9A78',
  BLUE: '#7A8B98',
  ORANGE: '#C48A5A',
  YELLOW: '#D4A855',
  PINK: '#C4897A',
  GOLD: '#DEAD6A',
  TEAL: '#7A9A88',
  SKY: '#8A9EB0',
  WINE: '#8A5040',
  DARK_00: '#0F0D0A',
  DARK_01: '#1A1814',
  DARK_02: '#2A2820',
  DARK_03: '#3A3830',
  DARK_04: '#7A7468',
};

/** Graphite, smoke, bone-white. Near-monochrome. One for the blank page. */
const ASH: IPalette = {
  FOREGROUND: '#DADAD6',
  BACKGROUND: '#0B0B0A',
  RED: '#B08078',
  GREEN: '#9AA396',
  BLUE: '#8C96A0',
  ORANGE: '#BFA088',
  YELLOW: '#C0BCA0',
  PINK: '#AE9AA0',
  GOLD: '#C8BC9E',
  TEAL: '#94A6A2',
  SKY: '#98A2AC',
  WINE: '#6E6066',
  DARK_00: '#0D0D0C',
  DARK_01: '#181817',
  DARK_02: '#262625',
  DARK_03: '#363635',
  DARK_04: '#6E6E6A',
};

/** Rose gold on velvet black, coral on cream. One for the tender night. */
const BLUSH: IPalette = {
  FOREGROUND: '#E8DDD5',
  BACKGROUND: '#0C0A0A',
  RED: '#C47070',
  GREEN: '#8BA89A',
  BLUE: '#7E8BA8',
  ORANGE: '#C4917A',
  YELLOW: '#D4B483',
  PINK: '#D4889A',
  GOLD: '#CCA88A',
  TEAL: '#8AA09A',
  SKY: '#9AAABF',
  WINE: '#944E63',
  DARK_00: '#100E0E',
  DARK_01: '#1A1717',
  DARK_02: '#2A2626',
  DARK_03: '#3A3535',
  DARK_04: '#7A7070',
};

/** Crimson bleeding into plum, sunset fading into indigo. One for the fading light. */
const DUSK: IPalette = {
  FOREGROUND: '#E5E0EA',
  BACKGROUND: '#0A090D',
  RED: '#CC6070',
  GREEN: '#7AA8A0',
  BLUE: '#7080A8',
  ORANGE: '#C88060',
  YELLOW: '#D4A870',
  PINK: '#C878A0',
  GOLD: '#D0A878',
  TEAL: '#709898',
  SKY: '#8090B8',
  WINE: '#8A4068',
  DARK_00: '#0E0D10',
  DARK_01: '#181620',
  DARK_02: '#282530',
  DARK_03: '#383540',
  DARK_04: '#787080',
};

/** Espresso and steamed milk, caramel, cocoa, warm crema. One for the late café. */
const MOCHA: IPalette = {
  FOREGROUND: '#E8DCCB',
  BACKGROUND: '#0E0A07',
  RED: '#BC6A55',
  GREEN: '#9CA876',
  BLUE: '#7E8794',
  ORANGE: '#CE9560',
  YELLOW: '#D4B173',
  PINK: '#C99488',
  GOLD: '#DDB87A',
  TEAL: '#8AA896',
  SKY: '#9398A6',
  WINE: '#7A4838',
  DARK_00: '#100C09',
  DARK_01: '#1C1611',
  DARK_02: '#2C231B',
  DARK_03: '#3C3228',
  DARK_04: '#786A5C',
};

/** Damp forest floor — pine, lichen, wet bark underfoot. One for the deep wood. */
const MOSS: IPalette = {
  FOREGROUND: '#DDE3D2',
  BACKGROUND: '#0A0C08',
  RED: '#C16B5A',
  GREEN: '#8FB07A',
  BLUE: '#6E8A82',
  ORANGE: '#C8945E',
  YELLOW: '#C2B070',
  PINK: '#B98A86',
  GOLD: '#D2B878',
  TEAL: '#7AA890',
  SKY: '#88A0A0',
  WINE: '#6E5040',
  DARK_00: '#0C0E0A',
  DARK_01: '#161A12',
  DARK_02: '#242A1E',
  DARK_03: '#343A2C',
  DARK_04: '#6A7060',
};

/** Deep indigo and ink blue, moonlit silver, distant stars. One for the midnight watch. */
const NOCTURNE: IPalette = {
  FOREGROUND: '#DCE0EC',
  BACKGROUND: '#08090F',
  RED: '#C66B74',
  GREEN: '#7FA8A0',
  BLUE: '#7E92C4',
  ORANGE: '#C68E6E',
  YELLOW: '#CBBE82',
  PINK: '#B084B8',
  GOLD: '#D0B884',
  TEAL: '#74A6B4',
  SKY: '#8EA4D0',
  WINE: '#5A4E84',
  DARK_00: '#0A0B12',
  DARK_01: '#14161F',
  DARK_02: '#20232E',
  DARK_03: '#30343F',
  DARK_04: '#6A6E80',
};

/** Aubergine and mauve, ripe plum, a breath of lavender. One for the violet hour. */
const PLUM: IPalette = {
  FOREGROUND: '#E4DCE8',
  BACKGROUND: '#0B080D',
  RED: '#C46A86',
  GREEN: '#88AC98',
  BLUE: '#8088C0',
  ORANGE: '#C68C72',
  YELLOW: '#CBB078',
  PINK: '#C285B8',
  GOLD: '#D2AC84',
  TEAL: '#80AAB0',
  SKY: '#9A92C8',
  WINE: '#8A4A78',
  DARK_00: '#0D0A10',
  DARK_01: '#181420',
  DARK_02: '#272030',
  DARK_03: '#373040',
  DARK_04: '#756C80',
};

/** Sea-glass and fog over deep water, weathered driftwood. One for the still water. */
const TIDE: IPalette = {
  FOREGROUND: '#D5DEE0',
  BACKGROUND: '#07090B',
  RED: '#C0707A',
  GREEN: '#7FB0A6',
  BLUE: '#6F92B0',
  ORANGE: '#C28E6E',
  YELLOW: '#C4B58C',
  PINK: '#B189A0',
  GOLD: '#D0BC88',
  TEAL: '#6FB0AE',
  SKY: '#88A8C2',
  WINE: '#5E6E80',
  DARK_00: '#090C0E',
  DARK_01: '#121820',
  DARK_02: '#1E2630',
  DARK_03: '#2E3742',
  DARK_04: '#66727C',
};

/** Peppermint and burnt orange on near-black. Two embers, nothing more. One for the evening star. */
const VESPER: IPalette = {
  FOREGROUND: '#FFFFFF',
  BACKGROUND: '#101010',
  RED: '#FF8080',
  GREEN: '#FFC799',
  BLUE: '#65737E',
  ORANGE: '#FFC799',
  YELLOW: '#99FFE4',
  PINK: '#A0A0A0',
  GOLD: '#FFCFA8',
  TEAL: '#7FD8C0',
  SKY: '#82929E',
  WINE: '#A65D6E',
  DARK_00: '#161616',
  DARK_01: '#1C1C1C',
  DARK_02: '#232323',
  DARK_03: '#343434',
  DARK_04: '#5C5C5C',
};

export const PALETTES: Record<string, IPalette> = {
  sage: SAGE,
  ember: EMBER,
  amber: AMBER,
  ash: ASH,
  blush: BLUSH,
  dusk: DUSK,
  mocha: MOCHA,
  moss: MOSS,
  nocturne: NOCTURNE,
  plum: PLUM,
  tide: TIDE,
  vesper: VESPER,
};
export const DEFAULT_PALETTE_NAME = 'sage';
