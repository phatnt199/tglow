import type { IDialogRow } from '../../core/cache/index.ts';
import type { IActiveTyping } from '../../core/typing-status.ts';
import type { ITokens } from '../theme/index.ts';
import { padStartToWidth, padToWidth, truncateToWidth } from '../text-width.ts';
import { resolveVisibleRange } from '../viewport.ts';

export interface IChatListProps {
  dialogs: IDialogRow[];
  cursor: number;
  focused: boolean;
  tokens: ITokens;
  width: number;
  /** Rows available to this pane; see IMessageViewProps.height for what rendering past it does. */
  height: number;
  /**
   * The chat whose history the message view is showing. Distinct from the
   * cursor, which the cursorline marks -- the two are usually the same row and
   * are not always, and the previous build had no way to tell them apart.
   */
  activePeerId: string | null;
  /**
   * Who is typing, recording or choosing a sticker, per chat. A live action
   * displaces the preview on that chat's second row: the preview is history,
   * and this is the present.
   */
  typingByPeer?: Map<string, IActiveTyping>;
  /** Passed in rather than read from the clock here, so a component stays a pure function of its props. */
  now?: number;
}

/** The open-chat bar; the cursorline carries position, so this column is only ever that. */
const MARKER_WIDTH = 1;
const BADGE_WIDTH = 4;
const SEPARATOR_WIDTH = 1;
const MINIMUM_NAME_WIDTH = 4;
const ACTIVE_MARKER = '▎';

/**
 * A name and a time, then what was last said and how much of it is unread --
 * the shape every graphical Telegram client uses, and the one the owner asked
 * for with a screenshot. Two rows is what buys room for the preview at all: on
 * one row the name, time, preview and badge together leave nothing readable in
 * a sidebar this narrow.
 */
const ROWS_PER_CHAT = 2;
/** `HH:MM`. */
const TIME_WIDTH = 5;

/**
 * The clock time a chat was last spoken in.
 *
 * Time only, no date. The list is ordered by recency, so the rows a glance
 * lands on are today's; a date would spend four of the sidebar's columns to
 * say "a while ago" less clearly than an old time already does.
 */
const formatTime = (opts: { at: number | null }): string => {
  const { at } = opts;
  if (at === null || at <= 0) {
    return '';
  }
  const when = new Date(at * 1000);
  return `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
};

/** A preview is one row: a multi-line message must not push the next chat down. */
const firstLineOf = (opts: { text: string }): string => opts.text.split(/\r\n|\r|\n/)[0] ?? '';

/** Wider than the badge column, and Telegram's own answer to the same problem. */
const BADGE_OVERFLOW = '999+';
const BADGE_MAXIMUM = 9999;

const formatBadge = (opts: { unreadCount: number }): string => {
  if (opts.unreadCount <= 0) {
    return '';
  }
  return opts.unreadCount > BADGE_MAXIMUM ? BADGE_OVERFLOW : String(opts.unreadCount);
};

export const ChatList = (props: IChatListProps) => {
  const { dialogs, cursor, focused, tokens, width, height, activePeerId, typingByPeer, now = 0 } = props;

  if (dialogs.length === 0) {
    return (
      <box flexDirection="column" width={width} height={height}>
        <text fg={tokens.dim}>No chats</text>
      </box>
    );
  }

  // The name shares its row with the time; the badge sits on the second row
  // beside the preview, which is what frees the width for both.
  const timeWidth = TIME_WIDTH;
  const nameWidth = Math.max(MINIMUM_NAME_WIDTH, width - MARKER_WIDTH - SEPARATOR_WIDTH - timeWidth);
  const previewWidth = Math.max(MINIMUM_NAME_WIDTH, width - MARKER_WIDTH - SEPARATOR_WIDTH - BADGE_WIDTH);

  // Two rows per chat, so the window holds half as many. Passing the row count
  // straight to resolveVisibleRange would scroll in half-chat steps and leave
  // a row of one chat stranded at the edge.
  const { start, end } = resolveVisibleRange({
    total: dialogs.length,
    cursor,
    height: Math.max(1, Math.floor(height / ROWS_PER_CHAT)),
  });

  return (
    <box flexDirection="column" width={width} height={height}>
      {dialogs.slice(start, end).map((dialog, offset) => {
        // The absolute position in the list, not the position in the window: a
        // sliced index would silently renumber the whole pane.
        const index = start + offset;
        const highlighted = index === cursor && focused;
        const background = highlighted ? tokens.messageCursor : undefined;
        const marker = dialog.peerId === activePeerId ? ACTIVE_MARKER : ' ';

        const name = padToWidth({
          text: truncateToWidth({ text: dialog.title, width: nameWidth }),
          width: nameWidth,
        });
        const time = padStartToWidth({
          text: formatTime({ at: dialog.lastMessageAt }),
          width: timeWidth,
        });

        // What someone is doing right now displaces what they last said: the
        // preview is history, and "typing…" is the present.
        const typing = typingByPeer?.get(dialog.peerId);
        const live = typing && typing.expiresAt > now ? typing.phrase : null;
        const secondLine = live ?? dialog.preview ?? '';
        const preview = padToWidth({
          text: truncateToWidth({ text: firstLineOf({ text: secondLine }), width: previewWidth }),
          width: previewWidth,
        });
        const badge = padStartToWidth({
          text: formatBadge({ unreadCount: dialog.unreadCount }),
          width: BADGE_WIDTH,
        });

        return (
          <box key={dialog.peerId} flexDirection="column" width={width} height={ROWS_PER_CHAT} flexShrink={0}>
            <text height={1} flexShrink={0} bg={background}>
              <span fg={tokens.chatActive}>{marker}</span>
              <span fg={tokens.foreground}>{`${name} `}</span>
              <span fg={tokens.dim}>{time}</span>
            </text>
            <text height={1} flexShrink={0} bg={background}>
              <span fg={tokens.chatActive}>{' '}</span>
              {/* A live action is the one thing on this row worth colouring:
                  it is the only part that is true right now. */}
              <span fg={live === null ? tokens.dim : tokens.chatActive}>{`${preview} `}</span>
              <span fg={tokens.chatUnread}>{badge}</span>
            </text>
          </box>
        );
      })}
    </box>
  );
};
