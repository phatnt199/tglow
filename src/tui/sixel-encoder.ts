/**
 * Sixel, encoded here rather than by a library.
 *
 * Not a matter of taste, unlike choosing which glyph best fits a cell -- that
 * is chafa's job and worth every byte of it. Sixel is a specified format with
 * one right answer, and the package that implements it drags in a PNG decoder
 * that assigns an implicit global. Legal in sloppy mode, a ReferenceError
 * under a bundler's strict mode: the binary compiled cleanly and then died on
 * startup with "UPNG is not defined". Importing only the encoder did not help
 * -- its quantiser pulls the same file in -- and a build-time define did not
 * either. tglow ships as one binary, and a dependency that fights that is a
 * dependency that costs more than it saves.
 *
 * The format, briefly. Six pixel rows at a time -- hence the name -- one
 * character per column per band, where the low six bits say which of those
 * rows are lit. Each colour is drawn as its own pass over the band, so a band
 * is emitted once per colour that appears in it.
 */

/** Six pixel rows to a band. */
const BAND_HEIGHT = 6;
/** Sixel data characters start here; the low six bits carry the pixels. */
const SIXEL_BASE = 0x3f;
/**
 * A 6x6x6 cube, which is 216 colours.
 *
 * Fixed rather than clustered from the image. A clustering quantiser gives a
 * better palette and needs the whole image in memory twice; at the size a
 * conversation draws a photo the difference is not visible, and the cube costs
 * one multiply per pixel with no allocation at all.
 */
const CUBE_SIDE = 6;
const CHANNEL_MAXIMUM = 255;
/** Sixel states colours in percent, not bytes. */
const PERCENT = 100;

const CHANNELS_PER_PIXEL = 4;

/** Device Control String in, String Terminator out. */
const SIXEL_INTRODUCER = 'P';
const SIXEL_TERMINATOR = '\\';

export interface IRgbaSource {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}

/** Which of the 216 cube colours a pixel falls into. */
const toPaletteIndex = (opts: { red: number; green: number; blue: number }): number => {
  const level = (value: number): number =>
    Math.min(CUBE_SIDE - 1, Math.floor((value * CUBE_SIDE) / (CHANNEL_MAXIMUM + 1)));
  return level(opts.red) * CUBE_SIDE * CUBE_SIDE + level(opts.green) * CUBE_SIDE + level(opts.blue);
};

/** The palette entry itself, back as percentages of each channel. */
const toPaletteColour = (opts: { index: number }): { red: number; green: number; blue: number } => {
  const blue = opts.index % CUBE_SIDE;
  const green = Math.floor(opts.index / CUBE_SIDE) % CUBE_SIDE;
  const red = Math.floor(opts.index / (CUBE_SIDE * CUBE_SIDE));
  const percent = (level: number): number => Math.round((level * PERCENT) / (CUBE_SIDE - 1));
  return { red: percent(red), green: percent(green), blue: percent(blue) };
};

/**
 * An RGBA image as a Sixel sequence, framed and ready to write.
 *
 * The height is taken as given: rounding it to whole bands is the caller's
 * decision, because only the caller knows how many cells it is allowed to
 * occupy -- see sixel-graphics.ts.
 */
export const encodeSixel = (opts: { image: IRgbaSource }): string => {
  const { image } = opts;
  const { width, height, data } = image;
  if (width <= 0 || height <= 0) {
    return '';
  }

  // One pass to index every pixel, so the band loop below reads integers
  // rather than re-quantising the same pixel once per colour it checks.
  const indexed = new Uint8Array(width * height);
  const present = new Set<number>();
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const offset = pixel * CHANNELS_PER_PIXEL;
    const index = toPaletteIndex({
      red: data[offset] ?? 0,
      green: data[offset + 1] ?? 0,
      blue: data[offset + 2] ?? 0,
    });
    indexed[pixel] = index;
    present.add(index);
  }

  const out: string[] = [`${SIXEL_INTRODUCER}0;0;q`];
  // Raster attributes: square pixels, and the size, so the terminal does not
  // have to infer either.
  out.push('"1;1;' + width + ';' + height);

  for (const index of present) {
    const { red, green, blue } = toPaletteColour({ index });
    out.push('#' + index + ';2;' + red + ';' + green + ';' + blue);
  }

  const bands = Math.ceil(height / BAND_HEIGHT);
  for (let band = 0; band < bands; band += 1) {
    // Which colours actually appear in this band: emitting a pass for a colour
    // that is not here would be a row of empty sixels per unused colour, which
    // for a 216-colour palette is most of them.
    const inBand = new Set<number>();
    for (let row = band * BAND_HEIGHT; row < Math.min(height, (band + 1) * BAND_HEIGHT); row += 1) {
      for (let column = 0; column < width; column += 1) {
        inBand.add(indexed[row * width + column]!);
      }
    }

    let first = true;
    for (const index of inBand) {
      // `$` returns to the start of the same band for the next colour; only
      // between passes, never before the first.
      out.push(first ? '#' + index : '$#' + index);
      first = false;

      let run = -1;
      let runLength = 0;
      for (let column = 0; column < width; column += 1) {
        let bits = 0;
        for (let bit = 0; bit < BAND_HEIGHT; bit += 1) {
          const row = band * BAND_HEIGHT + bit;
          if (row < height && indexed[row * width + column] === index) {
            bits |= 1 << bit;
          }
        }
        if (bits === run) {
          runLength += 1;
          continue;
        }
        if (runLength > 0) {
          out.push(encodeRun({ bits: run, length: runLength }));
        }
        run = bits;
        runLength = 1;
      }
      if (runLength > 0) {
        out.push(encodeRun({ bits: run, length: runLength }));
      }
    }
    // `-` moves to the next band. Not after the last one: a trailing newline
    // scrolls the terminal by a row, which over a full-screen renderer is the
    // whole frame jumping.
    if (band < bands - 1) {
      out.push('-');
    }
  }

  out.push(SIXEL_TERMINATOR);
  return out.join('');
};

/** Run-length form, which is what keeps a photo's flat areas from costing a character per pixel. */
const encodeRun = (opts: { bits: number; length: number }): string => {
  const character = String.fromCharCode(SIXEL_BASE + opts.bits);
  // Below four the marker plus the count is longer than just repeating it.
  return opts.length < 4 ? character.repeat(opts.length) : '!' + opts.length + character;
};
