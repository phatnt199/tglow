/** The author's neovim `scrolloff`: rows of context kept around the cursor. */
const SCROLLOFF_ROWS = 8;

/**
 * The half-open slice of a **rendered-row** list that a pane of `height` rows
 * can show, placed so every row of the cursor's item stays inside it.
 *
 * Rows, not items, because a message that wraps occupies several of them. A
 * range measured in messages hands the pane more rows than it has, and a
 * column of children whose rows exceed the pane is shrunk rather than clipped
 * -- shrunk children overdraw one another, and the frame buffer interleaves
 * their characters into rows belonging to no message at all.
 *
 * Derived from the cursor rather than carried as scroll state: there is no
 * offset in the store to remember between renders, so the margin is applied
 * every time instead of only when the cursor comes within it of an edge. The
 * visible difference from vim is that the cursor sits at a fixed distance
 * from the top of a long list rather than drifting within the window.
 *
 * A pane shorter than twice the margin cannot honour it on both sides at
 * once, so the margin is capped at half the window; clamping the start to
 * [0, totalRows - height] is what keeps the very first and very last rows
 * reachable rather than stranded beyond an edge.
 */
export const resolveVisibleRowRange = (opts: {
  totalRows: number;
  cursorRowStart: number;
  cursorRowSpan: number;
  height: number;
}): { start: number; end: number } => {
  const { totalRows, cursorRowStart } = opts;
  const visible = Math.max(1, opts.height);

  if (totalRows <= visible) {
    return { start: 0, end: totalRows };
  }

  const span = Math.max(1, opts.cursorRowSpan);
  const lastRow = cursorRowStart + span - 1;
  const margin = Math.min(SCROLLOFF_ROWS, Math.floor((visible - 1) / 2));

  // Three pulls in order of increasing authority: the margin above the cursor
  // item, then the margin below its last row, then the item's own first row.
  // The last wins outright, so an item taller than the pane is read from its
  // top rather than scrolled to its tail.
  const withLeadingMargin = cursorRowStart - margin;
  const withTrailingMargin = Math.max(withLeadingMargin, lastRow + margin + 1 - visible);
  const anchored = Math.min(withTrailingMargin, cursorRowStart);
  const start = Math.min(Math.max(anchored, 0), totalRows - visible);

  return { start, end: start + visible };
};

/**
 * The same window over a list whose items are one row each -- the chat list,
 * and anything else where item index and row index coincide.
 */
export const resolveVisibleRange = (opts: {
  total: number;
  cursor: number;
  height: number;
}): { start: number; end: number } => {
  return resolveVisibleRowRange({
    totalRows: opts.total,
    cursorRowStart: opts.cursor,
    cursorRowSpan: 1,
    height: opts.height,
  });
};
