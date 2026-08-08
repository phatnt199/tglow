/**
 * How much room a picture gets, in terminal cells.
 *
 * Only the arithmetic. Turning pixels into glyphs is chafa's job -- it picks
 * the best character per cell out of half blocks, quadrants, sextants and
 * braille, which is a great deal better than anything worth hand-rolling
 * here. What chafa needs from tglow is a size in cells, and that depends on
 * the pane, so it is this side of the boundary.
 */

/**
 * A terminal cell is about twice as tall as it is wide, so one cell covers
 * two square pixels stacked. That ratio is what makes an image keep its shape
 * rather than coming out squashed.
 */
export const PIXELS_PER_CELL = 2;

export interface IImageSize {
  columns: number;
  rows: number;
}

/**
 * How many cells an image should occupy, keeping its shape.
 *
 * Its natural size is one column per pixel across and one row per two pixels
 * down -- so a 100×100 photo wants 100 columns and 50 rows, and both bounds
 * matter. Scaled by whichever runs out first, never enlarged: a 12-pixel
 * thumbnail blown up to fill the pane would be a wall of colour, and the
 * point of drawing it at all is to recognise what it is.
 */
export const resolveImageSize = (opts: {
  width: number;
  height: number;
  maximumColumns: number;
  maximumRows: number;
}): IImageSize => {
  const { width, height, maximumColumns, maximumRows } = opts;
  if (width <= 0 || height <= 0 || maximumColumns <= 0 || maximumRows <= 0) {
    return { columns: 0, rows: 0 };
  }

  const naturalColumns = width;
  const naturalRows = Math.ceil(height / PIXELS_PER_CELL);
  const scale = Math.min(1, maximumColumns / naturalColumns, maximumRows / naturalRows);

  return {
    // At least one of each whenever there is room: an image scaled to zero
    // rows is an image that silently disappears, which is the failure this
    // whole feature exists to remove.
    columns: Math.max(1, Math.floor(naturalColumns * scale)),
    rows: Math.max(1, Math.floor(naturalRows * scale)),
  };
};
