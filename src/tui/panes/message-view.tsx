import type { IMessageRow } from '../../core/cache/index.ts';
import type { ITokens } from '../theme/index.ts';
import { resolveVisibleRange } from '../viewport.ts';

export interface IMessageViewProps {
  messages: IMessageRow[];
  cursor: number;
  focused: boolean;
  tokens: ITokens;
  /** Rows available to this pane. Rendering past it does not overflow -- yoga shrinks every row instead, so a 200-message history displayed every twentieth message and marked the wrong one as the cursor. */
  height: number;
  resolveSenderName: (opts: { fromId: string | null }) => string;
}

const GUTTER_WIDTH = 4;
const SENDER_WIDTH = 8;

export const MessageView = (props: IMessageViewProps) => {
  const { messages, cursor, focused, tokens, height, resolveSenderName } = props;

  if (messages.length === 0) {
    return (
      <box flexDirection="column">
        <text fg={tokens.dim}>No messages</text>
      </box>
    );
  }

  const { start, end } = resolveVisibleRange({ total: messages.length, cursor, height });

  return (
    <box flexDirection="column">
      {messages.slice(start, end).map((message, offset) => {
        // The absolute position in the history, not the position in the
        // window: the gutter numbers and the cursor comparison both mean the
        // former, and a sliced index would silently renumber the whole pane.
        const index = start + offset;
        const selected = index === cursor;
        // Hybrid numbering as in relativenumber + number: the cursor row shows
        // its absolute index, every other row its distance from the cursor.
        const gutter = selected ? String(index + 1) : String(Math.abs(index - cursor));
        const marker = selected && focused ? '▸' : ' ';
        const sender = resolveSenderName({ fromId: message.fromId })
          .slice(0, SENDER_WIDTH)
          .padEnd(SENDER_WIDTH);

        return (
          <text
            key={message.id}
            fg={message.out === 1 ? tokens.messageOwn : tokens.messageOther}
            bg={selected ? tokens.messageCursor : undefined}
          >
            {marker}
            <span fg={tokens.dim}>{`${gutter.padStart(GUTTER_WIDTH)} `}</span>
            <span fg={tokens.dim}>{sender}</span>
            {` ${message.text}`}
          </text>
        );
      })}
    </box>
  );
};
