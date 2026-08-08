import { ApplicationLogger } from '@venizia/ignis-helpers';

import initialiseChafa from 'chafa-wasm';
// Imported as a file asset so `bun build --compile` carries the WebAssembly
// into the binary. It lands at /$bunfs/root/chafa.wasm, which is exactly where
// chafa's own loader looks -- but only if the build passes
// `--asset-naming="[name].[ext]"`, since Bun otherwise hashes the name and the
// loader has the plain one baked in. See package.json's build script; without
// that flag the compiled binary starts and then dies on the first photo.
import './chafa-asset.ts';

import { resolveImageSize, type IImageSize } from './half-block.ts';

/**
 * Pictures, as terminal cells.
 *
 * chafa does the hard part: for each cell it picks the character that best
 * approximates those pixels, out of half blocks, quadrants, sextants and
 * braille, and chooses the two colours to draw it in. That is a far better
 * picture than any one glyph can give, and it is not worth reimplementing.
 *
 * This module is the boundary: it owns starting chafa once, converting its
 * output into something the renderer can draw, and never letting a bad image
 * take the application down with it.
 */

export interface IImageCell {
  char: string;
  /** `#RRGGBB`, or null where chafa says the glyph has no foreground -- a solid block of background. */
  foreground: string | null;
  background: string | null;
}

/** What chafa returns per cell: a code point and two colours, each `0xRRGGBB` or -1 for "none". */
type TChafaCell = [number, number, number];

interface IChafaModule {
  imageToMatrix: (
    image: ArrayBufferLike | { width: number; height: number; data: Uint8ClampedArray },
    config: Record<string, unknown>,
    callback: (error: unknown, result: { matrix: TChafaCell[][] }) => void,
  ) => void;
  decodeImage: (
    image: ArrayBufferLike,
    callback: (error: unknown, result: { width: number; height: number; data: Uint8ClampedArray }) => void,
  ) => void;
}

const NO_COLOUR = -1;
const HEX_RADIX = 16;
const HEX_DIGITS = 6;

/**
 * Started once and shared.
 *
 * Instantiating the module means compiling two megabytes of WebAssembly, which
 * is far too slow to do per picture. The promise is memoized rather than the
 * module, so several photos arriving together wait on one start rather than
 * racing to begin several.
 */
let started: Promise<IChafaModule> | null = null;

const chafa = async (): Promise<IChafaModule> => {
  started ??= initialiseChafa() as unknown as Promise<IChafaModule>;
  return started;
};

const toHexColour = (opts: { value: number }): string | null =>
  opts.value === NO_COLOUR || opts.value < 0
    ? null
    : `#${(opts.value >>> 0).toString(HEX_RADIX).padStart(HEX_DIGITS, '0')}`;

/** chafa's callback style, as a promise, so the callers read top to bottom. */
const toMatrix = async (opts: {
  module: IChafaModule;
  image: { width: number; height: number; data: Uint8ClampedArray };
  size: IImageSize;
}): Promise<TChafaCell[][]> =>
  new Promise((resolve, reject) => {
    opts.module.imageToMatrix(
      opts.image,
      {
        width: opts.size.columns,
        height: opts.size.rows,
        // Every glyph chafa knows, not the default subset. Measured on a real
        // thumbnail: 59 distinct characters against 37, which is the
        // difference between a picture and a mosaic at these sizes.
        symbols: 'all',
      },
      (error, result) => (error ? reject(error instanceof Error ? error : new Error(String(error))) : resolve(result.matrix)),
    );
  });

const decode = async (opts: { module: IChafaModule; bytes: Uint8Array }): Promise<{
  width: number;
  height: number;
  data: Uint8ClampedArray;
}> =>
  new Promise((resolve, reject) => {
    // `buffer` rather than the view: chafa reads an ArrayBuffer, and a
    // Uint8Array that is a window onto a larger buffer would otherwise hand it
    // whatever else is in that buffer.
    const bytes = opts.bytes.slice();
    opts.module.decodeImage(
      bytes.buffer as ArrayBuffer,
      (error, result) => (error ? reject(error instanceof Error ? error : new Error(String(error))) : resolve(result)),
    );
  });

/**
 * An encoded picture -- JPEG, PNG or WebP -- as a grid of cells, sized to fit.
 *
 * Returns null rather than throwing on anything it cannot draw. A photo that
 * will not decode is one message rendering as its descriptor instead of its
 * picture; a throw here would be the whole conversation failing to draw, and
 * the descriptor was the entire experience until very recently.
 */
export const renderImage = async (opts: {
  bytes: Uint8Array;
  maximumColumns: number;
  maximumRows: number;
}): Promise<IImageCell[][] | null> => {
  const { bytes, maximumColumns, maximumRows } = opts;
  if (bytes.length === 0 || maximumColumns <= 0 || maximumRows <= 0) {
    return null;
  }

  try {
    const module = await chafa();
    const image = await decode({ module, bytes });
    const size = resolveImageSize({
      width: image.width, height: image.height, maximumColumns, maximumRows,
    });
    if (size.columns <= 0 || size.rows <= 0) {
      return null;
    }

    const matrix = await toMatrix({ module, image, size });
    return matrix.map(row => row.map(([codePoint, foreground, background]) => ({
      char: String.fromCodePoint(codePoint),
      foreground: toHexColour({ value: foreground }),
      background: toHexColour({ value: background }),
    })));
  } catch (error) {
    // Logged, not swallowed. A renderer that returns null without saying why
    // is undiagnosable: the picture simply does not appear, and every layer
    // above looks equally guilty. This cost a debugging session once already.
    ApplicationLogger.get('renderImage').error('Could not draw a picture | Reason: %s', error);
    return null;
  }
};
