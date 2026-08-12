import type { IConversationPane, TPaneGrid } from '../core/conversation-panes.ts';

/**
 * Which picture belongs to which pane, drawn at which width, and where on the
 * screen it lands.
 *
 * All of this used to be inline in App, written when a conversation was the
 * only thing right of the sidebar. Every part of it assumed that:
 *
 *   - pictures were fetched for the focused chat alone, so a split pane showed
 *     none at all;
 *   - they were sized to the *whole* conversation area rather than to the pane
 *     actually holding them, so a two-column split drew every photo at roughly
 *     twice the width it had room for;
 *   - the cache was keyed by message id, so the cells rendered before a split
 *     stayed in it at the old size afterwards;
 *   - and a placement's screen column was measured from the first column's
 *     left edge, with each pane's placements *replacing* the last pane's
 *     rather than joining them -- so with two panes, one pane's photographs
 *     were drawn on top of the other's.
 *
 * Pulled out here because none of it needs a terminal or a wasm decoder to be
 * checked, and all of it was wrong in ways a test would have caught.
 */

/** How much of a pane's width the gutter, time and sender rail take before a picture starts. */
export const IMAGE_RAIL_ALLOWANCE = 28;
export const MAXIMUM_IMAGE_ROWS = 14;
export const MAXIMUM_STICKER_ROWS = 6;
export const MAXIMUM_STICKER_COLUMNS = 18;

/**
 * The cache key for a drawn picture.
 *
 * The width is part of it, and that is the whole point: chafa renders to a
 * fixed number of cells, so the same photograph at 40 columns and at 80 is two
 * different results. Keyed by message id alone, a split -- which halves every
 * pane's width -- left the pre-split cells in place and drew them into a pane
 * that could not hold them.
 */
export const imageCacheKey = (opts: { messageId: number; width: number }): string =>
  `${opts.messageId}@${opts.width}`;

/** How wide a picture may be drawn inside a pane of this width. */
export const resolveImageWidth = (opts: { paneWidth: number; sticker: boolean }): number => {
  const available = Math.max(1, opts.paneWidth - IMAGE_RAIL_ALLOWANCE);
  return opts.sticker ? Math.min(available, MAXIMUM_STICKER_COLUMNS) : available;
};

/** How tall. */
export const resolveImageRows = (opts: { sticker: boolean }): number =>
  opts.sticker ? MAXIMUM_STICKER_ROWS : MAXIMUM_IMAGE_ROWS;

export interface IImageRequest {
  peerId: string;
  messageId: number;
  sticker: boolean;
  /** The pane's own width, not the conversation area's. */
  paneWidth: number;
  maximumColumns: number;
  maximumRows: number;
  /** What the result is stored under. */
  key: string;
}

/** A message carrying something drawable, as the planner needs to see it. */
export interface IDrawableMessage {
  id: number;
  sticker: boolean;
}

/**
 * Every picture the screen currently wants, across every pane.
 *
 * One entry per (message, width): two panes showing the same chat at the same
 * width share a single fetch, and the same chat at two different widths is
 * genuinely two different pictures to draw.
 */
export const planImageFetches = (opts: {
  grid: TPaneGrid;
  /** Each column's width, left to right -- see splitConversationWidth. */
  widths: number[];
  /** The drawable messages in a pane, in the order they should be fetched. */
  drawableOf: (pane: IConversationPane) => IDrawableMessage[];
}): IImageRequest[] => {
  const requests = new Map<string, IImageRequest>();

  opts.grid.forEach((column, columnIndex) => {
    const paneWidth = opts.widths[columnIndex] ?? 0;
    for (const pane of column) {
      if (pane.peerId === null) {
        continue;
      }
      for (const message of opts.drawableOf(pane)) {
        const maximumColumns = resolveImageWidth({ paneWidth, sticker: message.sticker });
        const key = imageCacheKey({ messageId: message.id, width: maximumColumns });
        if (requests.has(key)) {
          continue;
        }
        requests.set(key, {
          peerId: pane.peerId,
          messageId: message.id,
          sticker: message.sticker,
          paneWidth,
          maximumColumns,
          maximumRows: resolveImageRows({ sticker: message.sticker }),
          key,
        });
      }
    }
  });

  return [...requests.values()];
};

/**
 * The screen column a pane's own column 0 sits at, one-based.
 *
 * Every column left of this one, plus the divider after each of them. Getting
 * this wrong is how a right-hand pane's photographs ended up drawn over the
 * left-hand pane: the old code measured every placement from the first
 * column's edge, whatever pane it came from.
 */
export const resolvePaneOrigin = (opts: {
  /** The screen column the conversation area starts at, zero-based. */
  conversationLeft: number;
  widths: number[];
  column: number;
  /** Columns spent on the rule between two conversation columns. */
  dividerColumns: number;
}): number => {
  let left = opts.conversationLeft;
  for (let index = 0; index < opts.column; index += 1) {
    left += (opts.widths[index] ?? 0) + opts.dividerColumns;
  }
  return left;
};

/**
 * A stable numeric id for the Kitty graphics protocol, from a cache key.
 *
 * The protocol names images with a number, and the obvious number -- the
 * message id -- is wrong once the same photograph can be on screen at two
 * widths: both would claim the same id and the second transmission would
 * replace the first, so one pane drew the other pane's size.
 *
 * FNV-1a, which is small, has no dependencies and spreads short keys well.
 * Kept inside a signed 32-bit range because the protocol's own id is one, and
 * away from zero because zero means "no id" there.
 */
export const toTerminalImageId = (opts: { key: string }): number => {
  const OFFSET_BASIS = 2_166_136_261;
  const PRIME = 16_777_619;
  let hash = OFFSET_BASIS;
  for (let index = 0; index < opts.key.length; index += 1) {
    hash ^= opts.key.charCodeAt(index);
    hash = Math.imul(hash, PRIME);
  }
  return (hash >>> 1) + 1;
};
