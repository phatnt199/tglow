import type { IDialogRow } from '../../core/cache/index.ts';
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
}

/** The open-chat bar; the cursorline carries position, so this column is only ever that. */
const MARKER_WIDTH = 1;
const BADGE_WIDTH = 4;
const SEPARATOR_WIDTH = 1;
const MINIMUM_NAME_WIDTH = 4;
const ACTIVE_MARKER = '▎';

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
  const { dialogs, cursor, focused, tokens, width, height, activePeerId } = props;

  if (dialogs.length === 0) {
    return (
      <box flexDirection="column" width={width} height={height}>
        <text fg={tokens.dim}>No chats</text>
      </box>
    );
  }

  const nameWidth = Math.max(
    MINIMUM_NAME_WIDTH,
    width - MARKER_WIDTH - SEPARATOR_WIDTH - BADGE_WIDTH,
  );
  const { start, end } = resolveVisibleRange({ total: dialogs.length, cursor, height });

  return (
    <box flexDirection="column" width={width} height={height}>
      {dialogs.slice(start, end).map((dialog, offset) => {
        // The absolute position in the list, not the position in the window: a
        // sliced index would silently renumber the whole pane.
        const index = start + offset;
        const highlighted = index === cursor && focused;
        const marker = dialog.peerId === activePeerId ? ACTIVE_MARKER : ' ';
        const name = padToWidth({
          text: truncateToWidth({ text: dialog.title, width: nameWidth }),
          width: nameWidth,
        });
        const badge = padStartToWidth({ text: formatBadge({ unreadCount: dialog.unreadCount }), width: BADGE_WIDTH });

        return (
          <text
            key={dialog.peerId}
            height={1}
            flexShrink={0}
            bg={highlighted ? tokens.messageCursor : undefined}
          >
            <span fg={tokens.chatActive}>{marker}</span>
            <span fg={tokens.foreground}>{`${name} `}</span>
            <span fg={tokens.chatUnread}>{badge}</span>
          </text>
        );
      })}
    </box>
  );
};
