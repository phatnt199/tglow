import { toGraphemes } from './text-width.ts';
import type { IStyledSpan } from './entities.ts';

/**
 * `wrapText` wraps a plain string; this wraps `IStyledSpan[]` the same way, so
 * a bold or linked run that crosses a row boundary stays bold or linked on
 * both rows instead of losing its style at the cut.
 *
 * A space contributes to the output only when it ends up between two words
 * that share a row. A space that would open a row -- the first row of the
 * message, or the row right after a wrap -- or that has no word following it
 * at all (a trailing run at the end of the message), is dropped. A wrap never
 * drops more than the one run of spaces immediately before the word that did
 * not fit. Concatenating every row therefore reproduces the input verbatim,
 * modulo exactly the spaces consumed at wrap points.
 */

interface IStyledGrapheme {
  grapheme: string;
  width: number;
  kinds: IStyledSpan['kinds'];
  url: string | null;
}

const emptySpan = (): IStyledSpan => ({ text: '', kinds: [], url: null });

const flatten = (opts: { spans: IStyledSpan[] }): IStyledGrapheme[] => {
  return opts.spans.flatMap(span =>
    toGraphemes({ text: span.text }).map(({ grapheme, width }) => ({
      grapheme,
      width,
      kinds: span.kinds,
      url: span.url,
    })),
  );
};

const signatureOf = (item: { kinds: IStyledSpan['kinds']; url: string | null }): string => {
  return `${[...item.kinds].sort().join(',')}|${item.url ?? ''}`;
};

/** Adjacent graphemes that share a style collapse back into one span. */
const regroup = (opts: { graphemes: IStyledGrapheme[] }): IStyledSpan[] => {
  const spans: IStyledSpan[] = [];
  let current: IStyledSpan | null = null;
  let currentSignature = '';

  for (const item of opts.graphemes) {
    const signature = signatureOf(item);

    if (current && signature === currentSignature) {
      current.text += item.grapheme;
      continue;
    }

    current = { text: item.grapheme, kinds: item.kinds, url: item.url };
    currentSignature = signature;
    spans.push(current);
  }

  return spans.length === 0 ? [emptySpan()] : spans;
};

/**
 * A word with no space inside it, too wide for one row: cut at column
 * boundaries with nothing dropped, mirroring `wrapText`'s `splitLongWord`. A
 * grapheme wider than the whole field is still emitted alone rather than
 * dropped, which is also what keeps this loop making progress.
 */
const splitLongWord = (opts: { word: IStyledGrapheme[]; width: number }): IStyledGrapheme[][] => {
  const rows: IStyledGrapheme[][] = [];
  let chunk: IStyledGrapheme[] = [];
  let chunkWidth = 0;

  for (const item of opts.word) {
    if (chunkWidth + item.width > opts.width && chunk.length > 0) {
      rows.push(chunk);
      chunk = [];
      chunkWidth = 0;
    }
    chunk.push(item);
    chunkWidth += item.width;
  }

  rows.push(chunk);
  return rows;
};

export const wrapSpans = (opts: { spans: IStyledSpan[]; width: number }): IStyledSpan[][] => {
  const { spans, width } = opts;

  if (width <= 0) {
    return [spans.length === 0 ? [emptySpan()] : spans];
  }

  const graphemes = flatten({ spans });
  if (graphemes.length === 0) {
    return [[emptySpan()]];
  }

  const rows: IStyledGrapheme[][] = [];
  let row: IStyledGrapheme[] = [];
  let rowWidth = 0;
  let pendingSpaces: IStyledGrapheme[] = [];
  let pendingSpacesWidth = 0;
  let word: IStyledGrapheme[] = [];
  let wordWidth = 0;

  // Commits the word accumulated since the last space onto `row`, or wraps.
  // Called on every space and once more after the loop for whatever trails
  // the last one. A no-op when no word is waiting, which is how a leading or
  // repeated run of spaces collapses away instead of producing empty words.
  const flushWord = (): void => {
    if (word.length === 0) {
      return;
    }

    // A row never opens with a space, so the pending run only counts toward
    // the fit check when there is already something on the row to follow.
    const separatorWidth = row.length > 0 ? pendingSpacesWidth : 0;

    if (rowWidth + separatorWidth + wordWidth <= width) {
      if (row.length > 0) {
        row.push(...pendingSpaces);
        rowWidth += pendingSpacesWidth;
      }
      row.push(...word);
      rowWidth += wordWidth;
    } else {
      // The word does not fit after what is already on the row -- the
      // pending spaces were its separator and never appear anywhere.
      if (row.length > 0) {
        rows.push(row);
      }

      if (wordWidth <= width) {
        row = [...word];
        rowWidth = wordWidth;
      } else {
        const split = splitLongWord({ word, width });
        rows.push(...split.slice(0, -1));
        row = split[split.length - 1]!;
        rowWidth = row.reduce((total, entry) => total + entry.width, 0);
      }
    }

    word = [];
    wordWidth = 0;
    pendingSpaces = [];
    pendingSpacesWidth = 0;
  };

  for (const item of graphemes) {
    if (item.grapheme === ' ') {
      flushWord();
      pendingSpaces.push(item);
      pendingSpacesWidth += item.width;
      continue;
    }

    word.push(item);
    wordWidth += item.width;
  }
  flushWord();

  // A message of only spaces never reaches the `rows.push` inside
  // `flushWord`, since there is never a word to flush it with -- without this
  // it would wrap to zero rows instead of the one empty row every other
  // caller relies on.
  if (row.length > 0 || rows.length === 0) {
    rows.push(row);
  }

  return rows.map(entries => regroup({ graphemes: entries }));
};
