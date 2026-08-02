/**
 * Display columns, for laying text out against a terminal cell grid.
 *
 * Neither `String.length` nor `Array.from(text).length` is that number. A CJK
 * ideograph and most emoji occupy two cells; a combining mark occupies none;
 * a ZWJ emoji sequence is several code points drawn as one two-cell glyph.
 * The owner's own chat list carries Vietnamese, which arrives decomposed often
 * enough to matter, and the message view carries CJK and emoji.
 *
 * OpenTUI 0.4.5 exposes no width helper of its own -- the calculation lives in
 * its Zig core, reachable only through a native buffer -- so this is a
 * reimplementation, and `__tests__/tui/text-width.test.tsx` pins it against the
 * cells that renderer actually consumes rather than against a table of
 * expected numbers. A wrap width that disagrees with the renderer by even one
 * column re-opens the overdraw the wrapping exists to close.
 */

/**
 * East Asian Wide and Fullwidth, plus the emoji blocks that terminals draw at
 * two columns. Every range is covered by a sample in the test file above, so
 * this table is verified against the renderer rather than transcribed on
 * trust. Ambiguous-width characters (`…`, box drawing) are deliberately absent:
 * OpenTUI draws them at one column.
 */
const WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f1e6, 0x1f1ff],
  [0x1f300, 0x1f64f],
  [0x1f680, 0x1f6ff],
  [0x1f900, 0x1f9ff],
  [0x1fa70, 0x1faff],
  [0x20000, 0x3fffd],
];

const CONTROL_BOUNDARY = 0x20;
const DELETE_CODE_POINT = 0x7f;
const CONTROL_UPPER_BOUNDARY = 0xa0;

/** Format characters a terminal draws nothing for even outside a cluster. */
const ZERO_WIDTH_CODE_POINTS = new Set([0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0xfeff]);

const SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export const ELLIPSIS = '…';

const isWideCodePoint = (codePoint: number): boolean => {
  for (const [start, end] of WIDE_RANGES) {
    if (codePoint >= start && codePoint <= end) {
      return true;
    }
  }
  return false;
};

/**
 * A grapheme cluster is one glyph, so its width is its base character's --
 * the combining marks, joiners and variation selectors that follow add
 * nothing. Taking the base is also what makes a ZWJ family two columns rather
 * than six.
 */
const measureGrapheme = (grapheme: string): number => {
  const codePoint = grapheme.codePointAt(0) ?? 0;

  if (codePoint < CONTROL_BOUNDARY) {
    return 0;
  }
  if (codePoint >= DELETE_CODE_POINT && codePoint < CONTROL_UPPER_BOUNDARY) {
    return 0;
  }
  if (ZERO_WIDTH_CODE_POINTS.has(codePoint)) {
    return 0;
  }

  return isWideCodePoint(codePoint) ? 2 : 1;
};

/** The graphemes of a string, each paired with the columns it occupies. */
export const toGraphemes = (opts: { text: string }): { grapheme: string; width: number }[] => {
  const graphemes: { grapheme: string; width: number }[] = [];
  for (const segment of SEGMENTER.segment(opts.text)) {
    graphemes.push({ grapheme: segment.segment, width: measureGrapheme(segment.segment) });
  }
  return graphemes;
};

export const measureTextWidth = (opts: { text: string }): number => {
  let total = 0;
  for (const segment of SEGMENTER.segment(opts.text)) {
    total += measureGrapheme(segment.segment);
  }
  return total;
};

/**
 * The longest prefix of `text` fitting in `width` columns, along with what was
 * left over. Splitting on graphemes rather than characters is what keeps a
 * decomposed `ư` whole and stops a two-column glyph being halved.
 */
export const splitAtWidth = (opts: { text: string; width: number }): { head: string; tail: string } => {
  const { text, width } = opts;
  if (width <= 0) {
    return { head: '', tail: text };
  }

  let used = 0;
  let head = '';
  const graphemes = toGraphemes({ text });

  for (let index = 0; index < graphemes.length; index += 1) {
    const { grapheme, width: cost } = graphemes[index]!;
    if (used + cost > width) {
      return { head, tail: graphemes.slice(index).map(entry => entry.grapheme).join('') };
    }
    used += cost;
    head += grapheme;
  }

  return { head, tail: '' };
};

/**
 * The longest *suffix* of `text` fitting in `width` columns -- what a
 * single-row input field shows once what has been typed no longer fits, since
 * the end is where the caret is.
 */
export const extractTailToWidth = (opts: { text: string; width: number }): string => {
  const { text, width } = opts;
  if (width <= 0) {
    return '';
  }

  const graphemes = toGraphemes({ text });
  let used = 0;
  let index = graphemes.length;

  while (index > 0) {
    const cost = graphemes[index - 1]!.width;
    if (used + cost > width) {
      break;
    }
    used += cost;
    index -= 1;
  }

  return graphemes.slice(index).map(entry => entry.grapheme).join('');
};

/** Right-pad to exactly `width` columns; a string already that wide is returned as is. */
export const padToWidth = (opts: { text: string; width: number }): string => {
  const deficit = opts.width - measureTextWidth({ text: opts.text });
  return deficit <= 0 ? opts.text : opts.text + ' '.repeat(deficit);
};

/** Left-pad to exactly `width` columns, for the right-aligned gutter and badge. */
export const padStartToWidth = (opts: { text: string; width: number }): string => {
  const deficit = opts.width - measureTextWidth({ text: opts.text });
  return deficit <= 0 ? opts.text : ' '.repeat(deficit) + opts.text;
};

/**
 * Shorten to `width` columns, marking the cut with an ellipsis. Padded back out
 * afterwards because dropping a two-column glyph can leave a column spare, and
 * a field that comes up short drags every column right of it out of line.
 */
export const truncateToWidth = (opts: { text: string; width: number }): string => {
  const { text, width } = opts;
  if (width <= 0) {
    return '';
  }
  if (measureTextWidth({ text }) <= width) {
    return text;
  }

  const room = width - measureTextWidth({ text: ELLIPSIS });
  if (room <= 0) {
    return padToWidth({ text: splitAtWidth({ text, width }).head, width });
  }

  return padToWidth({ text: `${splitAtWidth({ text, width: room }).head}${ELLIPSIS}`, width });
};
