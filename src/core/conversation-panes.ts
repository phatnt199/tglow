import type { IMessageRow } from './cache/index.ts';

/**
 * Several conversations on screen at once.
 *
 * The model is vim's, because tglow's is: `<C-w>v` splits, `<C-w>c` closes,
 * `<C-w>w` cycles, and `<C-w>h`/`<C-w>l` walk left and right across everything
 * on screen -- the sidebar included, which is where those two already went
 * before there was more than one conversation to walk between.
 *
 * Vertical splits only. A terminal is far wider than it is tall and a
 * conversation is a column of text: splitting horizontally would give two
 * chats six lines each, which is not a way to read either of them.
 *
 * ## Where a pane's state actually lives
 *
 * The **focused** pane's conversation is the flat state on IApplicationState --
 * `messages`, `messageCursor`, `composerText` and the rest -- exactly where it
 * was when there was only one. Everything that reads or writes a conversation
 * keeps doing so: the reducer, the key bindings, the composer, search, the
 * image cache. None of them learned about panes, and none of them had to.
 *
 * The panes in this list carry a *snapshot* instead, and the snapshot in the
 * focused pane's own slot is stale by construction -- `capture` writes the flat
 * state into it at the moment focus leaves, and `restore` reads the incoming
 * pane's snapshot back out. Anything that needs every pane's current
 * conversation (drawing them, delivering a live message to one that is not
 * focused) must go through `withActive` below, which hands back the list with
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
  replyToMessageId: number | null;
  editingMessageId: number | null;
  composerTextBeforeEdit: string | null;
}

/** The flat conversation fields, as they appear on IApplicationState. */
export interface IConversationState {
  activePeerId: string | null;
  messages: IMessageRow[];
  messageCursor: number;
  composerText: string;
  replyToMessageId: number | null;
  editingMessageId: number | null;
  composerTextBeforeEdit: string | null;
}

/**
 * The narrowest a conversation may be squeezed before splitting again is
 * refused.
 *
 * Forty columns is about where a wrapped message stops being a paragraph and
 * starts being a ragged strip of two or three words a line. Below that a second
 * pane costs more reading than it adds.
 */
export const MINIMUM_CONVERSATION_WIDTH = 40;

/**
 * A ceiling regardless of how wide the terminal is.
 *
 * Not a technical limit -- four conversations is already more than anyone
 * follows at once, and an ultrawide terminal splitting into seven is a way to
 * lose the one you were reading rather than a feature.
 */
export const MAXIMUM_PANES = 4;

export const createPane = (opts: { peerId?: string | null } = {}): IConversationPane => ({
  peerId: opts.peerId ?? null,
  messages: [],
  messageCursor: 0,
  composerText: '',
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
  replyToMessageId: opts.pane.replyToMessageId,
  editingMessageId: opts.pane.editingMessageId,
  composerTextBeforeEdit: opts.pane.composerTextBeforeEdit,
});

/**
 * The list with the focused pane's stale slot filled in from the flat state.
 *
 * What anything drawing or delivering to *all* panes must use. Reading the
 * list directly would show the focused conversation as it was when focus last
 * left it, which is a pane that stops updating the moment you look at it.
 */
export const withActive = (opts: {
  panes: IConversationPane[];
  activeIndex: number;
  conversation: IConversationState;
}): IConversationPane[] =>
  opts.panes.map((pane, index) =>
    index === opts.activeIndex ? capture({ conversation: opts.conversation }) : pane);

/**
 * How many panes this width can hold, sidebar already subtracted.
 *
 * Returned rather than assumed so splitting can refuse before it happens, and
 * so a terminal narrowed after the fact has a number to fold panes back down
 * to instead of drawing them one character wide.
 */
export const paneCapacity = (opts: { width: number }): number => {
  if (opts.width < MINIMUM_CONVERSATION_WIDTH) {
    // Always at least one: a terminal too narrow for the minimum still has to
    // show the conversation, just cramped. Refusing to draw anything would be
    // a worse answer than drawing it badly.
    return 1;
  }
  return Math.max(1, Math.min(MAXIMUM_PANES, Math.floor(opts.width / MINIMUM_CONVERSATION_WIDTH)));
};

/**
 * Each pane's width in columns, sharing the space and giving the remainder to
 * the leftmost panes.
 *
 * Integer columns, distributed rather than rounded per pane: three panes across
 * 100 columns are 34/33/33 and not 33/33/33 with a column of the frame left
 * unpainted down the right-hand side.
 */
export const splitConversationWidth = (opts: { width: number; count: number }): number[] => {
  const count = Math.max(1, opts.count);
  const base = Math.floor(opts.width / count);
  const remainder = opts.width - base * count;
  return Array.from({ length: count }, (_, index) => base + (index < remainder ? 1 : 0));
};

/**
 * Split the focused pane, putting the new one immediately to its right.
 *
 * The new pane opens on the same conversation, which is what `:vsplit` does --
 * two views of what you were just reading -- and the far more common next
 * action is to point one of them somewhere else, which the chat list already
 * does.
 *
 * Returns the list unchanged when there is no room, so the caller can tell
 * (and say so) rather than silently ending up with the same number of panes.
 */
export const splitPane = (opts: {
  panes: IConversationPane[];
  activeIndex: number;
  capacity: number;
  conversation: IConversationState;
}): { panes: IConversationPane[]; activeIndex: number; split: boolean } => {
  const current = withActive(opts);
  if (current.length >= Math.min(opts.capacity, MAXIMUM_PANES)) {
    return { panes: current, activeIndex: opts.activeIndex, split: false };
  }

  const clone = capture({ conversation: opts.conversation });
  const panes = [
    ...current.slice(0, opts.activeIndex + 1),
    clone,
    ...current.slice(opts.activeIndex + 1),
  ];
  return { panes, activeIndex: opts.activeIndex + 1, split: true };
};

/**
 * Close the focused pane and focus its neighbour.
 *
 * The last pane never closes: vim refuses the same way, and a tglow with no
 * conversation on screen is a chat client showing a chat list and nothing else.
 * Focus goes to the pane on the left when there is one, matching what closing a
 * window does -- the eye is already there.
 */
export const closePane = (opts: {
  panes: IConversationPane[];
  activeIndex: number;
  conversation: IConversationState;
}): { panes: IConversationPane[]; activeIndex: number; closed: boolean } => {
  const current = withActive(opts);
  if (current.length <= 1) {
    return { panes: current, activeIndex: opts.activeIndex, closed: false };
  }

  const panes = current.filter((_, index) => index !== opts.activeIndex);
  return { panes, activeIndex: Math.max(0, opts.activeIndex - 1), closed: true };
};

/**
 * The pane `delta` steps away, wrapping.
 *
 * Wrapping because `<C-w>w` wraps in vim, and with two panes it is the only
 * thing that makes one key enough to go back and forth.
 */
export const cyclePane = (opts: { count: number; activeIndex: number; delta: number }): number => {
  const count = Math.max(1, opts.count);
  return (((opts.activeIndex + opts.delta) % count) + count) % count;
};

/**
 * The pane `delta` steps away, stopping at the ends.
 *
 * `<C-w>h` and `<C-w>l` name a direction rather than a rotation, and a
 * left that wraps to the far right is how you lose track of which pane you are
 * in. Stopping is also what makes `<C-w>h` from the leftmost pane mean "the
 * sidebar" unambiguously -- see the keymap.
 */
export const stepPane = (opts: { count: number; activeIndex: number; delta: number }): number =>
  Math.max(0, Math.min(Math.max(0, opts.count - 1), opts.activeIndex + opts.delta));
