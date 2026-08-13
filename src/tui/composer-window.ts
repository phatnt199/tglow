/**
 * Which part of a draft the prompt row shows, and where the caret sits in it.
 *
 * The composer used to show the tail of the text and park a block at the end,
 * which was exactly right while the end was the only place you could type.
 * Now that the caret moves (see composer-text.ts), the visible slice has to
 * follow it: a caret scrolled off the left edge is a caret you cannot aim.
 *
 * The window is computed fresh from the caret rather than remembered between
 * renders, which keeps this pure -- and the arithmetic below is arranged so
 * that the answer only *changes* when the caret would otherwise leave the
 * field. A window recomputed on every keystroke that jumped every keystroke
 * would be unusable, so that stability is the property worth testing.
 *
 * Columns, not characters: a CJK ideograph takes two cells and a combining
 * mark none, so every measurement here goes through text-width.ts.
 */

import { measureTextWidth, toGraphemes } from './text-width.ts';

/**
 * Columns kept visible past the caret once the draft outgrows the field.
 *
 * Zero would pin the caret to the right edge, where every insertion scrolls
 * the row and you never see the word you are typing into. A few columns of
 * lookahead is what makes editing mid-draft feel like editing rather than
 * appending.
 */
const LOOKAHEAD = 4;

export interface IComposerWindow {
  /** The visible text left of the caret. */
  before: string;
  /**
   * The single cell the caret is on -- a space when it sits past the last
   * grapheme, which is where a caret spends most of its life.
   */
  at: string;
  /** The visible text right of the caret. */
  after: string;
  /**
   * The caret's offset in columns from the field's first column. What the
   * *terminal's* own cursor needs, so an IME draws its preedit on the caret
   * rather than wherever the last write happened to leave it.
   */
  caretColumn: number;
}

const EMPTY: IComposerWindow = { before: '', at: '', after: '', caretColumn: 0 };

const NEWLINE = '\n';

export const resolveComposerWindow = (opts: {
  text: string;
  /** The caret, in graphemes, as composer-text.ts counts them. */
  cursor: number;
  /** Columns the field has, prompt already subtracted. */
  room: number;
}): IComposerWindow => {
  if (opts.room <= 0) {
    return EMPTY;
  }

  const all = toGraphemes({ text: opts.text });
  const whole = Math.max(0, Math.min(all.length, opts.cursor));

  // The prompt is one row, and `<A-Enter>` puts real newlines in a draft --
  // as does `e` on a message that had them. A newline measures zero columns,
  // so left in the slice it was packed in like any other cell and the text
  // node simply stopped there: everything after it went undrawn, and once the
  // caret was past it the caret went undrawn too. So the row shows the line
  // the caret is on, and the caret is placed within that line.
  let lineStart = whole;
  while (lineStart > 0 && all[lineStart - 1]!.grapheme !== NEWLINE) {
    lineStart -= 1;
  }
  let lineEnd = whole;
  while (lineEnd < all.length && all[lineEnd]!.grapheme !== NEWLINE) {
    lineEnd += 1;
  }

  // One cell past the last grapheme, so a caret at the end has something to
  // sit on -- the same extra column the old fixed block took.
  const cells = [...all.slice(lineStart, lineEnd), { grapheme: ' ', width: 1 }];
  const caret = Math.max(0, Math.min(cells.length - 1, whole - lineStart));

  // A single grapheme too wide for the field -- a CJK character in a pane
  // three columns across -- cannot be drawn at all. Returning it anyway put
  // two columns of glyph in a one-column box, which the renderer discards, so
  // the whole field went blank rather than merely tight.
  if (cells[caret]!.width > opts.room) {
    return EMPTY;
  }

  // Grown outward from the caret, which is what guarantees the caret is in
  // the window however narrow the field gets.
  let start = caret;
  let end = caret + 1;
  let used = cells[caret]!.width;

  // Leftward first, holding LOOKAHEAD columns back for the right: the text
  // already written is worth more of the row than the text ahead of the
  // caret. Filling rightward first instead pins the caret a few columns from
  // the left edge, and then every keystroke scrolls the whole row.
  const behind = Math.max(used, opts.room - LOOKAHEAD);
  while (start > 0 && used + cells[start - 1]!.width <= behind) {
    used += cells[start - 1]!.width;
    start -= 1;
  }
  // Then rightward with everything left over.
  while (end < cells.length && used + cells[end]!.width <= opts.room) {
    used += cells[end]!.width;
    end += 1;
  }
  // And leftward again for the columns the right had no text to spend, which
  // is what makes a caret at the end of a long draft show the tail.
  while (start > 0 && used + cells[start - 1]!.width <= opts.room) {
    used += cells[start - 1]!.width;
    start -= 1;
  }

  const join = (from: number, to: number): string =>
    cells.slice(from, to).map(cell => cell.grapheme).join('');
  const before = join(start, caret);

  return {
    before,
    at: cells[caret]!.grapheme,
    after: join(caret + 1, end),
    caretColumn: measureTextWidth({ text: before }),
  };
};
