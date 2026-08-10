import { measureTextWidth, truncateToWidth } from './text-width.ts';

/**
 * The frame drawn around the two panes.
 *
 * One shared frame, not two boxes. M1a tried boxing each pane and got a
 * doubled `┐┌` seam where they met -- the comment on RULE_WIDTH in app.tsx
 * still records it. Here the junction is a `┬`/`┴` this module draws itself,
 * so there is exactly one column of border between the panes and it is the
 * same column the vertical rule already occupied.
 *
 * Drawn as strings rather than delegated to a box border for the same reason
 * app.tsx draws its rule one `<text>` per row: full control over every cell,
 * and no renderer-owned border that could disagree with the width arithmetic
 * below.
 */

export const FRAME_LEFT = 1;
export const FRAME_RIGHT = 1;
/** The column between two panes -- the rule M1a already spent, now a frame junction. */
export const FRAME_MIDDLE = 1;
/** Top and bottom edges. */
export const FRAME_TOP = 1;
export const FRAME_BOTTOM = 1;

/**
 * Columns the frame takes for a given number of panes: the two outer edges,
 * plus a junction between each adjacent pair. Two panes cost three columns;
 * adding the folder rail makes it four.
 */
export const frameHorizontalCost = (opts: { paneCount: number }): number => {
  const junctions = Math.max(0, opts.paneCount - 1);
  return FRAME_LEFT + junctions * FRAME_MIDDLE + FRAME_RIGHT;
};

/** The two-pane cost, kept as a constant for the callers that never show a rail. */
export const FRAME_HORIZONTAL_COST = frameHorizontalCost({ paneCount: 2 });
/** Total rows the frame takes: the two edges. */
export const FRAME_VERTICAL_COST = FRAME_TOP + FRAME_BOTTOM;

const HORIZONTAL = '─';
const VERTICAL = '│';
const TOP_LEFT = '┌';
const TOP_RIGHT = '┐';
const TOP_JUNCTION = '┬';
const BOTTOM_LEFT = '└';
const BOTTOM_RIGHT = '┘';
const BOTTOM_JUNCTION = '┴';

/** `┌─ Chats ──` -- one leading dash, a spaced title, then fill. */
const TITLE_PREFIX = `${HORIZONTAL} `;
const TITLE_SUFFIX = ' ';

export interface IPaneWidths {
  /**
   * Columns for the folder rail, or 0 when it is not shown -- which is the
   * case for an account with no folders of its own, exactly as the graphical
   * clients hide it. A zero-width rail costs no junction either.
   */
  rail: number;
  /** Columns available to the chat list, inside the frame. */
  sidebar: number;
  /** Columns available to the message view, inside the frame. */
  messages: number;
}

/** The panes actually drawn, left to right, skipping a rail that is not shown. */
const visibleSegments = (opts: { widths: IPaneWidths }): number[] => {
  const { widths } = opts;
  return widths.rail > 0 ? [widths.rail, widths.sidebar, widths.messages] : [widths.sidebar, widths.messages];
};

/**
 * How the window's width divides once the frame has taken its three columns.
 *
 * `sidebar` is what the caller asked for, clamped so that neither pane can be
 * squeezed out of existence by a narrow window or a dragged divider. Below the
 * point where both minimums fit, the sidebar gives way first: a message pane
 * one column wide is useless, and the chat list is the pane you can navigate
 * without.
 */
export const resolvePaneWidths = (opts: {
  width: number;
  sidebarWidth: number;
  minimumPane: number;
  /** 0, or omitted, hides the folder rail entirely -- junction included. */
  railWidth?: number;
}): IPaneWidths => {
  const { width, sidebarWidth, minimumPane } = opts;
  const requestedRail = Math.max(0, opts.railWidth ?? 0);

  // The rail is the first thing dropped when the window cannot hold
  // everything: it is a shortcut, where the chat list and the conversation are
  // the application. Dropping it returns its junction too.
  const withRail = requestedRail > 0
    && width - frameHorizontalCost({ paneCount: 3 }) - requestedRail >= minimumPane * 2;
  const rail = withRail ? requestedRail : 0;

  const inner = Math.max(0, width - frameHorizontalCost({ paneCount: rail > 0 ? 3 : 2 }) - rail);

  if (inner < minimumPane * 2) {
    // The message pane is served first here, which is the whole point of the
    // branch: honouring the requested sidebar instead would leave a window at
    // 30 columns showing a 22-wide chat list and five columns of conversation.
    const messages = Math.min(minimumPane, inner);
    return { rail, sidebar: Math.max(0, inner - messages), messages };
  }

  const sidebar = Math.min(Math.max(sidebarWidth, minimumPane), inner - minimumPane);
  return { rail, sidebar, messages: inner - sidebar };
};

/**
 * A titled edge: `┌─ Chats ──────┬─ Alice ──────────┐`.
 *
 * A title too long for its pane is truncated rather than allowed to push the
 * junction sideways. Every row of the frame must be exactly `width` cells or
 * the panes below it stop lining up with the edge above them -- the arithmetic
 * that, got wrong, produced M1a's interleaved-text report.
 */
/**
 * The conversation area, when it holds more than one conversation.
 *
 * One entry per pane, left to right, each with the chat it is showing. Their
 * widths plus the junctions between them come to the conversation area's own
 * width -- see splitConversationWidth in core/conversation-panes.ts, which is
 * what works them out.
 */
export interface IConversationSpan {
  width: number;
  title: string;
}

const buildEdge = (opts: {
  widths: IPaneWidths;
  left: string;
  right: string;
  junction: string;
  titles: { rail: string; sidebar: string; messages: string } | null;
  conversations?: IConversationSpan[];
}): string => {
  const { widths, left, right, junction, titles } = opts;

  const segment = (span: number, title: string | null): string => {
    if (span <= 0) {
      return '';
    }
    if (title === null || title === '') {
      return HORIZONTAL.repeat(span);
    }
    // The dashes and spaces around the title, so a title only appears when
    // there is room for it plus at least one more dash of edge.
    const decoration = measureTextWidth({ text: TITLE_PREFIX + TITLE_SUFFIX });
    if (span < decoration + 2) {
      return HORIZONTAL.repeat(span);
    }
    const room = span - decoration - 1;
    const shown = truncateToWidth({ text: title, width: room });
    const used = decoration + measureTextWidth({ text: shown });
    return `${TITLE_PREFIX}${shown}${TITLE_SUFFIX}${HORIZONTAL.repeat(Math.max(0, span - used))}`;
  };

  // One span per conversation pane when there are several, so each gets its
  // own titled stretch of edge and its own junction -- a split that shared one
  // heading would leave the right-hand chat unlabelled.
  const conversationSpans = opts.conversations && opts.conversations.length > 0
    ? opts.conversations.map(span => ({
      width: span.width,
      title: titles === null ? null : span.title,
    }))
    : [{ width: widths.messages, title: titles?.messages ?? null }];

  const spans = [
    ...(widths.rail > 0 ? [{ width: widths.rail, title: titles?.rail ?? null }] : []),
    { width: widths.sidebar, title: titles?.sidebar ?? null },
    ...conversationSpans,
  ];

  return left
    + spans.map(span => segment(span.width, span.title)).join(junction)
    + right;
};

export const buildTopEdge = (opts: {
  widths: IPaneWidths;
  titles: { rail: string; sidebar: string; messages: string };
  /** One per conversation pane when the conversation area is split. */
  conversations?: IConversationSpan[];
}): string => {
  return buildEdge({ ...opts, left: TOP_LEFT, right: TOP_RIGHT, junction: TOP_JUNCTION });
};

export const buildBottomEdge = (opts: { widths: IPaneWidths; conversations?: IConversationSpan[] }): string => {
  return buildEdge({
    widths: opts.widths,
    conversations: opts.conversations,
    left: BOTTOM_LEFT,
    right: BOTTOM_RIGHT,
    junction: BOTTOM_JUNCTION,
    titles: null,
  });
};

export const FRAME_VERTICAL = VERTICAL;
/** The glyphs a frame column shows where a section divider meets it. */
export const FRAME_TEE_RIGHT = '├';
export const FRAME_TEE_LEFT = '┤';

/**
 * The titled rule inside a pane that is split horizontally -- the sidebar's
 * folders above, its chats below.
 *
 * A pane's own divider, not the frame's, so it spans exactly that pane's
 * width. The frame columns either side draw `├` and `┤` on the same row, which
 * is what makes the three read as one continuous rule.
 */
export const buildSectionDivider = (opts: { width: number; title: string }): string => {
  const { width, title } = opts;
  if (width <= 0) {
    return '';
  }
  const decoration = measureTextWidth({ text: TITLE_PREFIX + TITLE_SUFFIX });
  if (width < decoration + 2) {
    return HORIZONTAL.repeat(width);
  }
  const shown = truncateToWidth({ text: title, width: width - decoration - 1 });
  const used = decoration + measureTextWidth({ text: shown });
  return `${TITLE_PREFIX}${shown}${TITLE_SUFFIX}${HORIZONTAL.repeat(Math.max(0, width - used))}`;
};
