import type { IDialogRow } from './cache/index.ts';

/**
 * Getting to the next chat with something in it.
 *
 * This is the loop a chat client is actually used for, and until now tglow had
 * no way to do it at all: no binding, no `:` command, and a chat picker that
 * does not rank by unread. Finding the next unread meant reading the sidebar
 * with your eyes and pressing `j` until you arrived.
 *
 * ## The decisions, and why
 *
 * **Within the visible list.** A folder is the user's own statement of what
 * they are looking at; jumping out of it to somewhere they filtered away would
 * be overruling that. `]f` moves between folders and is the answer to "what
 * about the others".
 *
 * **Wrapping.** So it can be held down. There is no meaningful "end" of a chat
 * list to stop at, unlike a message history where the newest is a real edge.
 *
 * **Skipping the chat you are reading.** Its badge may still say unread --
 * marking read is a round trip that may not have landed -- and taking you back
 * to where you already are is the one answer that is never useful.
 *
 * **Muted chats are NOT skipped**, and that is a gap rather than a decision.
 * The `muted_until` column exists in the schema and nothing has ever written
 * to it: measured against a real account, all 102 dialogs hold 0. Filtering on
 * it would be filtering on a field that is always false, which reads like a
 * feature and is nothing at all.
 */

/**
 * The next chat with unread messages, or null when there is none to go to.
 *
 * `from` may be anywhere, including past the end of a list that has since
 * shrunk -- the search starts at the following index either way.
 */
export const resolveNextUnread = (opts: {
  dialogs: readonly IDialogRow[];
  /** Where the cursor is now. */
  from: number;
  /** +1 for the next, -1 for the previous. */
  delta: number;
  /** The chat already open, which is never a useful destination. */
  skipPeerId: string | null;
}): number | null => {
  const { dialogs, delta, skipPeerId } = opts;
  const count = dialogs.length;
  if (count === 0) {
    return null;
  }

  const step = delta >= 0 ? 1 : -1;
  // Clamped first, so a cursor left pointing past a list that has shrunk still
  // starts somewhere real rather than wrapping from an imaginary position.
  const start = Math.max(0, Math.min(count - 1, opts.from));

  for (let moved = 1; moved <= count; moved += 1) {
    const index = (((start + step * moved) % count) + count) % count;
    const dialog = dialogs[index]!;
    if (dialog.unreadCount > 0 && dialog.peerId !== skipPeerId) {
      return index;
    }
  }
  return null;
};

/** What the status line says when there is nowhere to go. */
export const NOTHING_UNREAD_MESSAGE = 'No unread chats here';
