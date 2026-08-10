import { test, expect } from 'bun:test';
import { decode } from 'sixel';

import { drawImage, resolveCellSize, scaleRgba, supportsSixel } from '../../tui/sixel-graphics.ts';

/** Built rather than typed, so the file stays free of raw control characters. */
const ESC = String.fromCharCode(27);

/** A picture with a recognisable shape in it: a red block on a blue field. */
const swatch = (opts: { width: number; height: number }): { width: number; height: number; data: Uint8Array } => {
  const { width, height } = opts;
  const data = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const offset = (row * width + column) * 4;
      const inside = column < width / 2;
      data[offset] = inside ? 220 : 20;
      data[offset + 1] = 30;
      data[offset + 2] = inside ? 40 : 200;
      data[offset + 3] = 255;
    }
  }
  return { width, height, data };
};

// ── scaling ───────────────────────────────────────────────────────────────

test('an image scales to exactly the pixels asked for', () => {
  const scaled = scaleRgba({ image: swatch({ width: 40, height: 20 }), width: 12, height: 6 });

  expect(scaled.width).toBe(12);
  expect(scaled.height).toBe(6);
  expect(scaled.data.length).toBe(12 * 6 * 4);
});

// Nearest neighbour keeps the colours that were there rather than inventing
// averages between them, which is what keeps a screenshot's thin strokes from
// turning to mush.
test('scaling keeps the original colours rather than blending them', () => {
  const scaled = scaleRgba({ image: swatch({ width: 40, height: 20 }), width: 10, height: 4 });
  const colours = new Set<string>();
  for (let index = 0; index < scaled.data.length; index += 4) {
    colours.add(`${scaled.data[index]},${scaled.data[index + 1]},${scaled.data[index + 2]}`);
  }

  expect(colours).toEqual(new Set(['220,30,40', '20,30,200']));
});

test('the left half stays on the left', () => {
  const scaled = scaleRgba({ image: swatch({ width: 40, height: 20 }), width: 10, height: 4 });
  const at = (column: number): string =>
    `${scaled.data[column * 4]},${scaled.data[column * 4 + 1]},${scaled.data[column * 4 + 2]}`;

  expect(at(0)).toBe('220,30,40');
  expect(at(9)).toBe('20,30,200');
});

test('a nonsense size produces nothing rather than something wrong', () => {
  expect(scaleRgba({ image: swatch({ width: 4, height: 4 }), width: 0, height: 4 }).width).toBe(0);
});

// ── the sequence ──────────────────────────────────────────────────────────

// Sixel draws wherever the cursor is and leaves it somewhere else, and the
// renderer owns that cursor -- so it is saved and put back. Without this the
// conversation starts drawing itself sideways after the first picture.
test('the cursor is moved, then restored around the picture', () => {
  const sequence = drawImage({
    image: swatch({ width: 8, height: 8 }),
    row: 4, column: 12, columns: 6, rows: 3, cell: { width: 10, height: 20 },
  });

  expect(sequence.startsWith(`${ESC}7`)).toBe(true);
  expect(sequence).toContain(`${ESC}[4;12H`);
  expect(sequence.endsWith(`${ESC}8`)).toBe(true);
});

// The decisive check, short of a terminal: the library's own decoder reads
// back what the encoder wrote, and it fits inside the cells it was given.
//
// Height is checked as a bound rather than an equality because Sixel draws in
// bands of six pixel rows and pads the last one. Asking for exactly 80 came
// back as 83 -- three pixels into the row below, which is why the encoder now
// rounds down to a whole number of bands.
test('what is encoded decodes back, and fits inside the cells it was given', () => {
  const cell = { width: 10, height: 20 };
  const sequence = drawImage({
    image: swatch({ width: 64, height: 64 }),
    row: 1, column: 1, columns: 8, rows: 4, cell,
  });

  const sixel = sequence.slice(sequence.indexOf(`${ESC}P`), sequence.lastIndexOf(`${ESC}8`));
  const decoded = decode(sixel);

  expect(decoded.width).toBe(8 * cell.width);
  expect(decoded.height).toBeLessThanOrEqual(4 * cell.height);
  // And not so short that rounding threw a row away.
  expect(decoded.height).toBeGreaterThan(4 * cell.height - 6);
});

// And that it is a picture rather than a field of one colour, which is what a
// broken palette or a mis-sized band would produce.
test('the decoded picture still has both colours in it', () => {
  const sequence = drawImage({
    image: swatch({ width: 64, height: 64 }),
    row: 1, column: 1, columns: 8, rows: 4, cell: { width: 10, height: 20 },
  });
  const decoded = decode(sequence.slice(sequence.indexOf(`${ESC}P`), sequence.lastIndexOf(`${ESC}8`)));

  const colours = new Set<number>();
  for (let index = 0; index < decoded.data32.length; index += 1) {
    colours.add(decoded.data32[index]!);
  }
  expect(colours.size).toBeGreaterThan(1);
});

// ── cell size ─────────────────────────────────────────────────────────────

// Sixel measures in pixels where the conversation measures in cells, and the
// only way to ask the terminal is an escape sequence whose reply lands on the
// key handler's stdin. So it is assumed, and overridable.
test('the cell size is assumed, and can be overridden', () => {
  expect(resolveCellSize({ environment: {} })).toEqual({ width: 10, height: 20 });
  expect(resolveCellSize({ environment: { TGLOW_CELL_SIZE: '8x16' } })).toEqual({ width: 8, height: 16 });
});

test('a nonsense override falls back rather than drawing at zero', () => {
  for (const raw of ['', 'wide', '0x16', '8x', '-4x-8']) {
    expect(resolveCellSize({ environment: { TGLOW_CELL_SIZE: raw } })).toEqual({ width: 10, height: 20 });
  }
});

// ── detection ─────────────────────────────────────────────────────────────

// VTE is the interesting one: GNOME Terminal and GNOME Console both use it,
// and it has carried Sixel since 0.78 -- which it reports as 7800.
test('VTE from 0.78 onward is recognised, and older is not', () => {
  expect(supportsSixel({ environment: { VTE_VERSION: '8402' } })).toBe(true);
  expect(supportsSixel({ environment: { VTE_VERSION: '7800' } })).toBe(true);
  expect(supportsSixel({ environment: { VTE_VERSION: '6003' } })).toBe(false);
});

test('the other Sixel terminals are recognised', () => {
  expect(supportsSixel({ environment: { TERM: 'foot' } })).toBe(true);
  expect(supportsSixel({ environment: { TERM: 'contour' } })).toBe(true);
  expect(supportsSixel({ environment: { TERM: 'mlterm' } })).toBe(true);
});

// Alacritty has neither protocol, which is checkable rather than folklore: its
// binary contains no mention of Sixel at all.
test('a terminal with no Sixel is not asked for one', () => {
  expect(supportsSixel({ environment: { TERM: 'xterm-256color' } })).toBe(false);
  expect(supportsSixel({ environment: {} })).toBe(false);
});

test('the drawing can be forced back on any terminal', () => {
  expect(supportsSixel({ environment: { TGLOW_GRAPHICS: 'off', VTE_VERSION: '8402' } })).toBe(false);
});
