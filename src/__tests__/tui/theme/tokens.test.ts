import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';

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

// ---------------------------------------------------------------------------
// Every palette against its own devglow .lua source, key for key.
//
// In M1a, ember's five DARK_* shades were transcribed from memory instead of
// read from the file, and the whole ramp landed one position off (DARK_00
// held what is actually DARK_01). Nothing caught it: only sage had
// assertions, and they covered six keys, not seventeen.
//
// These tests parse each .lua file fresh, at run time, with a small regex --
// they do not compare against hex values typed by hand into this file, which
// is exactly the step that produced the ember mistake. So even if a value
// were mistyped while transcribing palettes.ts, that same mistake cannot also
// land on the expected side here: the implementation was written by reading
// the .lua files once by eye; this parser reads the same files again, on
// every run, mechanically -- the two never share a transcription step.
// ---------------------------------------------------------------------------
const DEVGLOW_PALETTES_DIRECTORY = '/home/tanphat199/Workspace/save/tanphat199/devglow/lua/devglow/palettes';

const PALETTE_NAMES = [
  'sage', 'ember', 'amber', 'ash', 'blush', 'dusk', 'mocha', 'moss',
  'nocturne', 'plum', 'tide', 'vesper',
];

const extractHexValue = (opts: { source: string; key: keyof IPalette; paletteName: string }): string => {
  const match = new RegExp(`^\\s*${opts.key}\\s*=\\s*"(#[0-9A-Fa-f]{6})"`, 'm').exec(opts.source);
  if (match === null) {
    throw new Error(`[tokens.test][extractHexValue] ${opts.paletteName}.lua has no ${opts.key} entry`);
  }
  return match[1]!;
};

test('PALETTES ships exactly the twelve devglow palettes', () => {
  expect(new Set(Object.keys(PALETTES))).toEqual(new Set(PALETTE_NAMES));
});

for (const name of PALETTE_NAMES) {
  test(`${name} matches devglow/lua/devglow/palettes/${name}.lua, key for key`, () => {
    const source = readFileSync(`${DEVGLOW_PALETTES_DIRECTORY}/${name}.lua`, 'utf-8');
    const palette = PALETTES[name]!;
    for (const key of PALETTE_KEYS) {
      expect(palette[key], `${name}.${key}`).toBe(extractHexValue({ source, key, paletteName: name }));
    }
  });
}

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

// A palette that is correctly transcribed can still be unusable: if dim
// collides with the background or foreground it disappears entirely, and if
// the three mode colours collide the status line stops telling normal from
// insert from visual apart. Every palette must clear that bar, not only the
// two shipped so far.
test('every palette yields a legible token set', () => {
  for (const name of PALETTE_NAMES) {
    const tokens = buildTokens({ paletteName: name });
    expect(tokens.dim, `${name}: dim vs background`).not.toBe(tokens.background);
    expect(tokens.dim, `${name}: dim vs foreground`).not.toBe(tokens.foreground);
    expect(
      new Set([tokens.modeNormal, tokens.modeInsert, tokens.modeVisual]).size,
      `${name}: modeNormal/modeInsert/modeVisual all distinct`,
    ).toBe(3);
  }
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
