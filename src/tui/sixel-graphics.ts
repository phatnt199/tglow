// Encoded here rather than by the `sixel` package -- see sixel-encoder.ts for
// why. The package remains a devDependency, because its *decoder* is what the
// tests read the encoder's output back with.
import { encodeSixel } from './sixel-encoder.ts';

import type { IRgbaImage } from './kitty-graphics.ts';

/**
 * Sixel: the other way to put a real picture in a terminal.
 *
 * Older and cruder than the Kitty protocol -- a palette of at most 256 colours
 * and no notion of a placement to move or delete -- but supported by a very
 * different set of terminals: GNOME Terminal and GNOME Console (through VTE),
 * foot, xterm, Contour, mlterm, Windows Terminal. Between the two protocols
 * that is most terminals a person actually uses.
 *
 * Not Alacritty. Alacritty has neither, which is checkable rather than
 * folklore: its binary contains no mention of Sixel at all.
 */

/** Device Control String ... String Terminator, which is how Sixel is framed. */
const DCS = 'P';

/** Sixel draws six pixel rows at a time; that is what the format is named after. */
const SIXEL_BAND_HEIGHT = 6;

/**
 * A cell's size in pixels, when nobody has said otherwise.
 *
 * Sixel measures in pixels where the conversation measures in cells, so
 * something has to convert. The terminal knows the answer and will report it
 * -- but only by replying to an escape sequence, and that reply lands on the
 * same stdin the key handler is reading, which is the problem `q=2` exists to
 * avoid on the other protocol. So this is assumed, and overridable by anyone
 * whose font makes it wrong.
 *
 * Ten by twenty is the common shape of a terminal cell at ordinary sizes, and
 * being a little out costs a picture that is slightly the wrong size rather
 * than one that is missing.
 */
const DEFAULT_CELL_WIDTH = 10;
const DEFAULT_CELL_HEIGHT = 20;

export interface ICellSize {
  width: number;
  height: number;
}

/** `TGLOW_CELL_SIZE=8x16`, for a font this guesses wrong about. */
export const resolveCellSize = (opts: { environment: Record<string, string | undefined> }): ICellSize => {
  const raw = opts.environment.TGLOW_CELL_SIZE ?? '';
  const match = /^(\d+)x(\d+)$/.exec(raw.trim());
  if (!match) {
    return { width: DEFAULT_CELL_WIDTH, height: DEFAULT_CELL_HEIGHT };
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 ? { width, height } : { width: DEFAULT_CELL_WIDTH, height: DEFAULT_CELL_HEIGHT };
};

/**
 * An image scaled to a pixel size, by nearest neighbour.
 *
 * Nearest neighbour rather than an average: at these sizes what survives is
 * shape and colour, and averaging turns the thin strokes in a screenshot or a
 * meme into grey mush. It is also the only resampler worth writing by hand,
 * which matters -- the alternative was pulling in an image library to do one
 * thing.
 */
export const scaleRgba = (opts: { image: IRgbaImage; width: number; height: number }): IRgbaImage => {
  const { image, width, height } = opts;
  if (width <= 0 || height <= 0 || image.width <= 0 || image.height <= 0) {
    return { width: 0, height: 0, data: new Uint8Array() };
  }

  const data = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row += 1) {
    const source = Math.min(image.height - 1, Math.floor((row * image.height) / height));
    for (let column = 0; column < width; column += 1) {
      const from = (source * image.width + Math.min(image.width - 1, Math.floor((column * image.width) / width))) * 4;
      const to = (row * width + column) * 4;
      data[to] = image.data[from] ?? 0;
      data[to + 1] = image.data[from + 1] ?? 0;
      data[to + 2] = image.data[from + 2] ?? 0;
      data[to + 3] = 255;
    }
  }
  return { width, height, data };
};

/**
 * A picture, as a Sixel sequence placed at a cell position.
 *
 * The cursor is moved first and put back afterwards, because Sixel draws
 * wherever the cursor happens to be and leaves it somewhere else -- and the
 * renderer owns that cursor. Saving and restoring it is the difference
 * between a picture and a conversation that starts drawing itself sideways.
 */
export const drawImage = (opts: {
  image: IRgbaImage;
  row: number;
  column: number;
  columns: number;
  rows: number;
  cell: ICellSize;
}): string => {
  const { image, row, column, columns, rows, cell } = opts;
  // Rounded *down* to a whole number of bands. Sixel draws six pixel rows at
  // a time and pads the last one, so a height that is not a multiple of six
  // comes out taller than asked for -- and an image that spills into the row
  // below is the one thing a picture over a diffing renderer must never do.
  // Measured: 80 pixels came back as 83.
  const height = Math.max(
    SIXEL_BAND_HEIGHT,
    Math.floor((rows * cell.height) / SIXEL_BAND_HEIGHT) * SIXEL_BAND_HEIGHT,
  );
  const scaled = scaleRgba({ image, width: Math.max(1, columns * cell.width), height });
  if (scaled.width === 0) {
    return '';
  }

  const sixel = encodeSixel({ image: scaled });
  // Save, move, draw, restore.
  return `7[${row};${column}H${sixel}8`;
};

/**
 * Whether this terminal will draw a Sixel.
 *
 * Read from the environment for the same reason the Kitty check is: the
 * polite way to ask is an escape sequence whose reply arrives on stdin, where
 * the key handler would read it as keystrokes nobody typed.
 *
 * VTE is the interesting one -- GNOME Terminal and GNOME Console both use it,
 * and it has carried Sixel since 0.78 (verified against the installed library,
 * which exports vte_terminal_set_enable_sixel). It identifies itself through
 * VTE_VERSION.
 */
export const supportsSixel = (opts: { environment: Record<string, string | undefined> }): boolean => {
  const { environment } = opts;
  if (environment.TGLOW_GRAPHICS === 'off') {
    return false;
  }

  const term = environment.TERM ?? '';
  const program = (environment.TERM_PROGRAM ?? '').toLowerCase();
  // VTE reports its version as a number like 8402 for 0.84.2; Sixel arrived in
  // 0.78, which is 7800.
  const vte = Number(environment.VTE_VERSION ?? '0');
  return vte >= 7800
    || term.startsWith('foot')
    || term.startsWith('contour')
    || term.startsWith('mlterm')
    || term === 'xterm-sixel'
    || ['wezterm', 'contour'].includes(program);
};

/** Exposed for a round-trip test: what a well-formed sequence looks like from the outside. */
export const SIXEL_INTRODUCER = DCS;
