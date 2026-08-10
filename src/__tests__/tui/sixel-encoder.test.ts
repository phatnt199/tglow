import { test, expect } from 'bun:test';
// The `sixel` package, as a devDependency and a decoder only. Its encoder is
// what this file replaces -- see sixel-encoder.ts -- but its decoder is an
// independent implementation of the same specification, which makes it the
// right thing to read the output back with.
import { decode } from 'sixel';

import { encodeSixel } from '../../tui/sixel-encoder.ts';

const ESC = String.fromCharCode(27);

/**
 * The body alone. `decode` takes the sixel data, not the DCS-framed sequence:
 * handed the wrapper it reads the introducer's own bytes as pixels.
 */
const bodyOf = (sequence: string): string =>
  sequence.slice(sequence.indexOf('q') + 1, sequence.indexOf(`${ESC}\\`));

/** An image of one flat colour. */
const flat = (opts: { width: number; height: number; red: number; green: number; blue: number }) => {
  const { width, height, red, green, blue } = opts;
  const data = new Uint8Array(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    data.set([red, green, blue, 255], pixel * 4);
  }
  return { width, height, data };
};

/** Vertical stripes, one pixel wide, alternating between two colours. */
const stripes = (opts: { width: number; height: number }) => {
  const { width, height } = opts;
  const data = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const offset = (row * width + column) * 4;
      data.set(column % 2 === 0 ? [255, 0, 0, 255] : [0, 0, 255, 255], offset);
    }
  }
  return { width, height, data };
};

// ── framing ───────────────────────────────────────────────────────────────

test('a picture is framed as a Device Control String', () => {
  const sequence = encodeSixel({ image: flat({ width: 4, height: 6, red: 200, green: 0, blue: 0 }) });

  expect(sequence.startsWith(`${ESC}P`)).toBe(true);
  expect(sequence.endsWith(`${ESC}\\`)).toBe(true);
  // Raster attributes: square pixels and the size, so the terminal is not left
  // to infer either.
  expect(sequence).toContain('"1;1;4;6');
});

test('nothing at all is encoded as nothing, rather than an empty frame', () => {
  expect(encodeSixel({ image: { width: 0, height: 0, data: new Uint8Array() } })).toBe('');
});

// A trailing band separator scrolls the terminal by a row, and over a
// full-screen renderer that is the whole frame jumping.
test('the last band does not end with a newline', () => {
  const sequence = encodeSixel({ image: flat({ width: 4, height: 12, red: 0, green: 200, blue: 0 }) });

  expect(sequence.endsWith(`-${ESC}\\`)).toBe(false);
  // But the bands in between are still separated.
  expect(sequence).toContain('-');
});

// ── the round trip ────────────────────────────────────────────────────────

// The decisive check: an independent implementation of the same format reads
// back the size that was asked for.
test('what is encoded decodes back at exactly the size it was given', () => {
  for (const [width, height] of [[1, 6], [5, 6], [17, 12], [64, 66]] as const) {
    const decoded = decode(bodyOf(encodeSixel({ image: flat({ width, height, red: 220, green: 30, blue: 40 }) })));

    expect({ width: decoded.width, height: decoded.height }).toEqual({ width, height });
  }
});

// Bands are six pixel rows; a height that is not a multiple of six is the case
// that gets a hand-written encoder wrong.
test('a height that is not a whole number of bands still comes back whole', () => {
  const decoded = decode(bodyOf(encodeSixel({ image: flat({ width: 8, height: 10, red: 10, green: 10, blue: 200 }) })));

  expect(decoded.height).toBe(10);
});

// The palette is a fixed 6x6x6 cube, so a colour comes back near where it went
// in rather than exactly -- within one step of the cube, which is 51 per
// channel.
test('a colour survives the round trip, within the palette it was quantised to', () => {
  const decoded = decode(bodyOf(encodeSixel({ image: flat({ width: 6, height: 6, red: 220, green: 30, blue: 40 }) })));
  const pixel = decoded.data32[0]!;
  const red = pixel & 0xff;
  const green = (pixel >> 8) & 0xff;
  const blue = (pixel >> 16) & 0xff;

  expect(Math.abs(red - 220)).toBeLessThanOrEqual(51);
  expect(Math.abs(green - 30)).toBeLessThanOrEqual(51);
  expect(Math.abs(blue - 40)).toBeLessThanOrEqual(51);
});

// Every colour in a band is drawn as its own pass over that band, and getting
// the carriage returns between passes wrong puts the second colour on top of
// the first.
test('two colours in one band stay in their own columns', () => {
  const decoded = decode(bodyOf(encodeSixel({ image: stripes({ width: 8, height: 6 }) })));
  const at = (column: number): number => decoded.data32[column]!;

  expect(at(0)).not.toBe(at(1));
  expect(at(0)).toBe(at(2));
  expect(at(1)).toBe(at(3));
});

// ── run length ────────────────────────────────────────────────────────────

// A photograph's flat areas would otherwise cost a character per pixel, which
// for a full-width picture is tens of kilobytes per frame.
test('a long run is compressed rather than repeated', () => {
  const sequence = encodeSixel({ image: flat({ width: 200, height: 6, red: 0, green: 0, blue: 0 }) });

  expect(sequence).toContain('!200');
  expect(sequence.length).toBeLessThan(100);
});

// Below four characters the repeat marker and its count are longer than just
// writing them out.
test('a short run is written out rather than compressed', () => {
  expect(encodeSixel({ image: flat({ width: 3, height: 6, red: 0, green: 0, blue: 0 }) })).not.toContain('!');
});
