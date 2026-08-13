import type { IMessageRow } from './cache/index.ts';

/**
 * Several conversations on screen at once.
 *
 * The model is vim's, because tglow's is: `<C-w>|` splits into a new column,
 * `<C-w>-` splits the current column into another row, `<C-w>c` closes, and
 * `<C-w>h`/`j`/`k`/`l` move between them the way they move anywhere else.
 *
 * ## Columns of rows, not a window tree
 *
 * vim nests windows arbitrarily. This does not: the layout is a list of
 * columns, and each column is a stack of conversations. `<C-w>|` adds a
 * column, `<C-w>-` adds a row to the column you are in, and that covers every
 * arrangement anyone actually builds out of a chat client while staying
 * something h/j/k/l can describe exactly -- left and right change column, up
 * and down move within one. A tree would buy arbitrary nesting and cost a
 * layout nobody can predict from the keys they pressed.
 *
 * ## Where a pane's state actually lives
 *
 * The **focused** pane's conversation is the flat state on IApplicationState --
 * `messages`, `messageCursor`, `composerText` and the rest -- exactly where it
 * was when there was only one. Everything that reads or writes a conversation
 * keeps doing so: the reducer, the key bindings, the composer, search, the
 * image cache. None of them learned about panes, and none of them had to.
 *
 * The panes in the grid carry a *snapshot* instead, and the snapshot in the
 * focused pane's own slot is stale by construction -- `capture` writes the flat
 * state into it at the moment focus leaves, and `restore` reads the incoming
 * pane's snapshot back out. Anything that needs every pane's current
 * conversation (drawing them, delivering a live message to one that is not
 * focused) must go through `withActive` below, which hands back the grid with
 * that stale slot filled in.
 */

/** What one pane remembers about its conversation while another has the focus. */
export interface IConversationPane {
  peerId: string | null;
  messages: IMessageRow[];
  messageCursor: number;
  /**
   * The draft, kept per pane so switching away and back does not cost what you
   * had typed. Splitting to look something up in another chat and coming back
   * to an empty composer would make the split the expensive way to do it.
   */
  composerText: string;
  /** Where the caret sits in that draft. See IApplicationState.composerCursor. */
  composerCursor: number;
  replyToMessageId: number | null;
  editingMessageId: number | null;
  composerTextBeforeEdit: string | null;
}

/** The layout: columns left to right, each a stack of panes top to bottom. */
export type TPaneGrid = IConversationPane[][];

/** Where the focus is. */
export interface IPanePosition {
  column: number;
  row: number;
}

/** The flat conversation fields, as they appear on IApplicationState. */
export interface IConversationState {
  activePeerId: string | null;
  messages: IMessageRow[];
  messageCursor: number;
  composerText: string;
  composerCursor: number;
  replyToMessageId: number | null;
  editingMessageId: number | null;
  composerTextBeforeEdit: string | null;
}

export type TPaneDirection = 'left' | 'right' | 'up' | 'down';

/**
 * The narrowest a conversation may be squeezed before another column is
 * refused.
 *
 * Forty columns is about where a wrapped message stops being a paragraph and
 * starts being a ragged strip of two or three words a line.
 */
export const MINIMUM_CONVERSATION_WIDTH = 40;

/**
 * The shortest a conversation may be squeezed before another row is refused.
 *
 * Eight rows is a divider, a composer, and about five messages -- the point
 * below which a second conversation stops being readable and starts being
 * proof that it is there. A terminal is much wider than it is tall, so this is
 * the limit that actually bites: two rows is usually fine, three rarely.
 */
export const MINIMUM_CONVERSATION_HEIGHT = 8;

/**
 * A ceiling on the whole grid regardless of how large the terminal is.
 *
 * Not a technical limit -- four conversations is already more than anyone
 * follows at once, and an ultrawide terminal splitting into nine is a way to
 * lose the one you were reading rather than a feature.
 */
export const MAXIMUM_PANES = 4;

export const createPane = (opts: { peerId?: string | null } = {}): IConversationPane => ({
  peerId: opts.peerId ?? null,
  messages: [],
  messageCursor: 0,
  composerText: '',
  composerCursor: 0,
  replyToMessageId: null,
  editingMessageId: null,
  composerTextBeforeEdit: null,
});

/** The focused pane's slot, brought up to date from the flat state. */
export const capture = (opts: { conversation: IConversationState }): IConversationPane => ({
  peerId: opts.conversation.activePeerId,
  messages: opts.conversation.messages,
  messageCursor: opts.conversation.messageCursor,
  composerText: opts.conversation.composerText,
  composerCursor: opts.conversation.composerCursor,
  replyToMessageId: opts.conversation.replyToMessageId,
  editingMessageId: opts.conversation.editingMessageId,
  composerTextBeforeEdit: opts.conversation.composerTextBeforeEdit,
});

/** The flat state a pane becomes when it takes the focus. */
export const restore = (opts: { pane: IConversationPane }): IConversationState => ({
  activePeerId: opts.pane.peerId,
  messages: opts.pane.messages,
  messageCursor: opts.pane.messageCursor,
  composerText: opts.pane.composerText,
  composerCursor: opts.pane.composerCursor,
  replyToMessageId: opts.pane.replyToMessageId,
  editingMessageId: opts.pane.editingMessageId,
  composerTextBeforeEdit: opts.pane.composerTextBeforeEdit,
});

/** The starting layout: one column, one conversation, which is what tglow always was. */
export const createGrid = (): TPaneGrid => [[createPane()]];

/** How many conversations the grid holds. */
export const countPanes = (opts: { grid: TPaneGrid }): number =>
  opts.grid.reduce((total, column) => total + column.length, 0);

/** The pane at a position, or null when the position names nothing. */
export const paneAt = (opts: { grid: TPaneGrid; at: IPanePosition }): IConversationPane | null =>
  opts.grid[opts.at.column]?.[opts.at.row] ?? null;

/**
 * The grid with the focused pane's stale slot filled in from the flat state.
 *
 * What anything drawing or delivering to *all* panes must use. Reading the
 * grid directly would show the focused conversation as it was when focus last
 * left it, which is a pane that stops updating the moment you look at it.
 */
export const withActive = (opts: {
  grid: TPaneGrid;
  active: IPanePosition;
  conversation: IConversationState;
}): TPaneGrid =>
  opts.grid.map((column, columnIndex) =>
    column.map((pane, rowIndex) =>
      columnIndex === opts.active.column && rowIndex === opts.active.row
        ? capture({ conversation: opts.conversation })
        : pane));

/**
 * A position clamped back inside the grid.
 *
 * Columns hold different numbers of rows, so moving between them has to bring
 * the row with it: stepping right from row 3 into a column with two rows lands
 * on its last one rather than on nothing.
 */
export const clampPosition = (opts: { grid: TPaneGrid; at: IPanePosition }): IPanePosition => {
  const column = Math.max(0, Math.min(opts.grid.length - 1, opts.at.column));
  const rows = opts.grid[column]?.length ?? 1;
  return { column, row: Math.max(0, Math.min(rows - 1, opts.at.row)) };
};

/**
 * Add a column beside the focused one, holding a second view of the same chat.
 *
 * Which is what `:vsplit` does -- two views of what you were just reading --
 * and the far more common next action is to point one of them somewhere else,
 * which the chat list already does.
 *
 * Refused rather than silently ignored when there is no room, so the caller
 * has something to say about it.
 */
export const splitVertical = (opts: {
  grid: TPaneGrid;
  active: IPanePosition;
  conversation: IConversationState;
  width: number;
}): { grid: TPaneGrid; active: IPanePosition; split: boolean } => {
  const current = withActive(opts);
  const wouldBe = current.length + 1;
  if (countPanes({ grid: current }) >= MAXIMUM_PANES
    || Math.floor(opts.width / wouldBe) < MINIMUM_CONVERSATION_WIDTH) {
    return { grid: current, active: opts.active, split: false };
  }

  const grid = [
    ...current.slice(0, opts.active.column + 1),
    [capture({ conversation: opts.conversation })],
    ...current.slice(opts.active.column + 1),
  ];
  return { grid, active: { column: opts.active.column + 1, row: 0 }, split: true };
};

/**
 * Add a row beneath the focused pane, inside its own column.
 *
 * The height limit is the one that actually bites: a terminal is far wider
 * than it is tall, so a third row is usually refused where a third column
 * would not be.
 */
export const splitHorizontal = (opts: {
  grid: TPaneGrid;
  active: IPanePosition;
  conversation: IConversationState;
  height: number;
}): { grid: TPaneGrid; active: IPanePosition; split: boolean } => {
  const current = withActive(opts);
  const column = current[opts.active.column];
  if (column === undefined) {
    return { grid: current, active: opts.active, split: false };
  }
  const wouldBe = column.length + 1;
  if (countPanes({ grid: current }) >= MAXIMUM_PANES
    || Math.floor(opts.height / wouldBe) < MINIMUM_CONVERSATION_HEIGHT) {
    return { grid: current, active: opts.active, split: false };
  }

  const rows = [
    ...column.slice(0, opts.active.row + 1),
    capture({ conversation: opts.conversation }),
    ...column.slice(opts.active.row + 1),
  ];
  const grid = current.map((existing, index) => (index === opts.active.column ? rows : existing));
  return { grid, active: { column: opts.active.column, row: opts.active.row + 1 }, split: true };
};

/**
 * Close the focused pane, and its column too when that empties it.
 *
 * The last pane never closes: vim refuses the same way, and a tglow with no
 * conversation on screen is a chat client showing a chat list and nothing
 * else. The focus goes to what was above, or failing that to the column on the
 * left -- the eye is already there.
 */
export const closePane = (opts: {
  grid: TPaneGrid;
  active: IPanePosition;
  conversation: IConversationState;
}): { grid: TPaneGrid; active: IPanePosition; closed: boolean } => {
  const current = withActive(opts);
  if (countPanes({ grid: current }) <= 1) {
    return { grid: current, active: opts.active, closed: false };
  }

  const column = current[opts.active.column] ?? [];
  const rows = column.filter((_, index) => index !== opts.active.row);
  if (rows.length > 0) {
    const grid = current.map((existing, index) => (index === opts.active.column ? rows : existing));
    return {
      grid,
      active: clampPosition({ grid, at: { column: opts.active.column, row: opts.active.row - 1 } }),
      closed: true,
    };
  }

  const grid = current.filter((_, index) => index !== opts.active.column);
  return {
    grid,
    active: clampPosition({ grid, at: { column: opts.active.column - 1, row: opts.active.row } }),
    closed: true,
  };
};

/**
 * The position one step in a direction, stopping at the edges.
 *
 * Stopping rather than wrapping: h/j/k/l name a direction, and a left that
 * reappears on the far right is how you lose track of which pane you are in.
 * It is also what lets the reducer read "already leftmost, asked to go left"
 * as "they meant the chat list".
 */
export const move = (opts: {
  grid: TPaneGrid;
  active: IPanePosition;
  direction: TPaneDirection;
}): IPanePosition => {
  const { grid, active, direction } = opts;
  switch (direction) {
    case 'left':
    case 'right': {
      const column = active.column + (direction === 'right' ? 1 : -1);
      // The row comes along, clamped: columns hold different numbers of rows.
      return clampPosition({ grid, at: { column, row: active.row } });
    }
    default: {
      const row = active.row + (direction === 'down' ? 1 : -1);
      return clampPosition({ grid, at: { column: active.column, row } });
    }
  }
};

/**
 * The next pane in reading order, wrapping -- what `<C-w>w` has always meant.
 *
 * Across columns as well as down them, so one key reaches every conversation
 * however the grid is arranged.
 */
export const cyclePane = (opts: { grid: TPaneGrid; active: IPanePosition; delta: number }): IPanePosition => {
  const order: IPanePosition[] = opts.grid.flatMap((column, columnIndex) =>
    column.map((_, rowIndex) => ({ column: columnIndex, row: rowIndex })));
  if (order.length === 0) {
    return opts.active;
  }
  const current = order.findIndex(at => at.column === opts.active.column && at.row === opts.active.row);
  const next = (((Math.max(0, current) + opts.delta) % order.length) + order.length) % order.length;
  return order[next]!;
};

/**
 * Sizes shared out along one axis, giving the remainder to the first slots.
 *
 * Integer cells, distributed rather than rounded per slot: three panes across
 * 100 columns are 34/33/33 and not 33/33/33 with a column of the frame left
 * unpainted down the right-hand side.
 */
export const shareEvenly = (opts: { total: number; count: number }): number[] => {
  const count = Math.max(1, opts.count);
  const base = Math.floor(opts.total / count);
  const remainder = opts.total - base * count;
  return Array.from({ length: count }, (_, index) => base + (index < remainder ? 1 : 0));
};
