import type { IMessageRow } from '../../core/cache/index.ts';
import type { ITokens } from '../theme/index.ts';

export interface IMessageViewProps {
  messages: IMessageRow[];
  cursor: number;
  focused: boolean;
  tokens: ITokens;
  resolveSenderName: (opts: { fromId: string | null }) => string;
}

const GUTTER_WIDTH = 4;
const SENDER_WIDTH = 8;

export const MessageView = (props: IMessageViewProps) => {
  const { messages, cursor, focused, tokens, resolveSenderName } = props;

  if (messages.length === 0) {
    return (
      <box flexDirection="column">
        <text fg={tokens.dim}>No messages</text>
      </box>
    );
  }

  return (
    <box flexDirection="column">
      {messages.map((message, index) => {
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
