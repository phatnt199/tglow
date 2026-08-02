/** The author's neovim `scrolloff`: rows of context kept around the cursor. */
const SCROLLOFF_ROWS = 8;

/**
 * The half-open slice of a list that a pane of `height` rows can show, placed
 * so the cursor is always inside it.
 *
 * Derived from the cursor rather than carried as scroll state: there is no
 * offset in the store to remember between renders, so the margin is applied
 * every time instead of only when the cursor comes within it of an edge. The
 * visible difference from vim is that the cursor sits at a fixed distance
 * from the top of a long list rather than drifting within the window.
 *
 * A pane shorter than twice the margin cannot honour it on both sides at
 * once, so the margin is capped at half the window; clamping the start to
 * [0, total - height] is what keeps the very first and very last rows
 * reachable rather than stranded beyond an edge.
 */
export const resolveVisibleRange = (opts: {
  total: number;
  cursor: number;
  height: number;
}): { start: number; end: number } => {
  const { total, cursor } = opts;
  const visible = Math.max(1, opts.height);

  if (total <= visible) {
    return { start: 0, end: total };
  }

  const margin = Math.min(SCROLLOFF_ROWS, Math.floor((visible - 1) / 2));
  const start = Math.min(Math.max(cursor - margin, 0), total - visible);

  return { start, end: start + visible };
};
