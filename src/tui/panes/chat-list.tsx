import type { IDialogRow } from '../../core/cache/index.ts';
import type { ITokens } from '../theme/index.ts';
import { resolveVisibleRange } from '../viewport.ts';

export interface IChatListProps {
  dialogs: IDialogRow[];
  cursor: number;
  focused: boolean;
  tokens: ITokens;
  width: number;
  /** Rows available to this pane; see IMessageViewProps.height for what rendering past it does. */
  height: number;
}

const MARKER_WIDTH = 2;
const BADGE_WIDTH = 4;
const MINIMUM_NAME_WIDTH = 4;

export const ChatList = (props: IChatListProps) => {
  const { dialogs, cursor, focused, tokens, width, height } = props;

  if (dialogs.length === 0) {
    return (
      <box flexDirection="column" width={width}>
        <text fg={tokens.dim}>No chats</text>
      </box>
    );
  }

  const nameWidth = Math.max(MINIMUM_NAME_WIDTH, width - MARKER_WIDTH - BADGE_WIDTH);
  const { start, end } = resolveVisibleRange({ total: dialogs.length, cursor, height });

  return (
    <box flexDirection="column" width={width}>
      {dialogs.slice(start, end).map((dialog, offset) => {
        const index = start + offset;
        const selected = index === cursor;
        const marker = selected && focused ? '▸ ' : '  ';
        const name =
          dialog.title.length > nameWidth ? `${dialog.title.slice(0, nameWidth - 1)}…` : dialog.title;
        const badge = dialog.unreadCount > 0 ? String(dialog.unreadCount) : '';
        const padding = ' '.repeat(Math.max(1, nameWidth - name.length + 1));

        return (
          <text
            key={dialog.peerId}
            fg={selected ? tokens.chatActive : tokens.foreground}
            bg={selected ? tokens.messageCursor : undefined}
          >
            {marker}
            {name}
            {padding}
            <span fg={tokens.chatUnread}>{badge}</span>
          </text>
        );
      })}
    </box>
  );
};
