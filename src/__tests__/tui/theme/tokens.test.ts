import { test, expect } from 'bun:test';

import { PALETTES, type IPalette } from '../../../tui/theme/palettes.ts';
import { buildTokens } from '../../../tui/theme/tokens.ts';

const PALETTE_KEYS: Array<keyof IPalette> = [
  'FOREGROUND', 'BACKGROUND', 'RED', 'GREEN', 'BLUE', 'ORANGE', 'YELLOW',
  'PINK', 'GOLD', 'TEAL', 'SKY', 'WINE',
  'DARK_00', 'DARK_01', 'DARK_02', 'DARK_03', 'DARK_04',
];

test('every palette has all seventeen devglow keys', () => {
  for (const [name, palette] of Object.entries(PALETTES)) {
    for (const key of PALETTE_KEYS) {
      expect(palette[key], `${name}.${key}`).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  }
});

// These values come from devglow/lua/devglow/palettes/sage.lua and must match.
test('sage matches the upstream devglow palette exactly', () => {
  const sage = PALETTES.sage!;
  expect(sage.FOREGROUND).toBe('#E6E6E6');
  expect(sage.BACKGROUND).toBe('#080808');
  expect(sage.GOLD).toBe('#EBC17A');
  expect(sage.TEAL).toBe('#7DB9B6');
  expect(sage.PINK).toBe('#D68C8C');
  expect(sage.DARK_03).toBe('#383838');
});

// From devglow/lua/devglow/palettes/ember.lua. The shades were once
// transcribed wrongly -- the whole DARK_* ramp was off by one position --
// and nothing caught it, because no test asserted ember's values.
test('ember matches the upstream devglow palette exactly', () => {
  const ember = PALETTES.ember!;
  expect(ember.FOREGROUND).toBe('#F5F0EB');
  expect(ember.BACKGROUND).toBe('#141311');
  expect(ember.GOLD).toBe('#EACA80');
  expect(ember.TEAL).toBe('#7BBDBD');
  expect(ember.WINE).toBe('#B45A42');
  expect(ember.DARK_00).toBe('#0D0D0B');
  expect(ember.DARK_01).toBe('#1A1917');
  expect(ember.DARK_02).toBe('#2E2C28');
  expect(ember.DARK_03).toBe('#3A3835');
  expect(ember.DARK_04).toBe('#78716C');
});

test('an unknown palette falls back to sage', () => {
  expect(buildTokens({ paletteName: 'nonexistent' })).toEqual(buildTokens({ paletteName: 'sage' }));
});

test('mode colours differ so the status bar reads at a glance', () => {
  const tokens = buildTokens({ paletteName: 'sage' });
  expect(tokens.modeNormal).toBe('#7DB9B6');
  expect(tokens.modeInsert).toBe('#EBC17A');
  expect(tokens.modeVisual).toBe('#D68C8C');
  expect(new Set([tokens.modeNormal, tokens.modeInsert, tokens.modeVisual]).size).toBe(3);
});

test('tokens resolve against whichever palette is chosen', () => {
  expect(buildTokens({ paletteName: 'ember' }).modeInsert).toBe(PALETTES.ember!.GOLD);
  expect(buildTokens({ paletteName: 'sage' }).modeInsert).toBe(PALETTES.sage!.GOLD);
});

// M1 spec §6 names both textCode and textLink; neither existed before the
// message view had entities to render.
test('textCode and textLink are derived from GREEN and SKY, for both shipped palettes', () => {
  const sage = buildTokens({ paletteName: 'sage' });
  expect(sage.textCode).toBe(PALETTES.sage!.GREEN);
  expect(sage.textLink).toBe(PALETTES.sage!.SKY);

  const ember = buildTokens({ paletteName: 'ember' });
  expect(ember.textCode).toBe(PALETTES.ember!.GREEN);
  expect(ember.textLink).toBe(PALETTES.ember!.SKY);
});
