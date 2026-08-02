import type { IMessageRow } from '../../core/cache/index.ts';
import type { ITokens } from '../theme/index.ts';
import { padStartToWidth, padToWidth, truncateToWidth } from '../text-width.ts';
import { resolveVisibleRowRange } from '../viewport.ts';
import { wrapText } from '../wrap-text.ts';

export interface IMessageViewProps {
  messages: IMessageRow[];
  cursor: number;
  focused: boolean;
  tokens: ITokens;
  /**
   * Rows available to this pane. Every child is one row tall and the slice is
   * taken in rows, so this is a hard limit rather than a hint -- see
   * src/tui/viewport.ts for what happens to a column whose children want more
   * rows than it has.
   */
  height: number;
  /** Columns available to this pane; the content column wraps to what is left of it. */
  width: number;
  resolveSenderName: (opts: { fromId: string | null }) => string;
}

/** Reserved and always blank: the cursorline shows position, not an arrow. */
const MARKER_WIDTH = 1;
const GUTTER_WIDTH = 4;
const TIME_WIDTH = 5;
const SENDER_WIDTH = 10;
/** marker, gutter, time and sender, each followed by a single blank column. */
const RAIL_WIDTH = MARKER_WIDTH + GUTTER_WIDTH + 1 + TIME_WIDTH + 1 + SENDER_WIDTH + 1;
/** Below this the rail is worth more than the sliver of text it would leave. */
const MINIMUM_CONTENT_WIDTH = 8;

/** A gap this long starts a new group even from the same sender. */
const GROUP_GAP_SECONDS = 300;

const MARKER = ' '.repeat(MARKER_WIDTH);
const BLANK_GUTTER = ' '.repeat(GUTTER_WIDTH);
const BLANK_TIME = ' '.repeat(TIME_WIDTH);
const BLANK_SENDER = ' '.repeat(SENDER_WIDTH);

interface IRenderedRow {
  key: string;
  messageIndex: number;
  gutter: string;
  time: string;
  sender: string;
  content: string;
  own: boolean;
}

/** `date` is a Unix timestamp in seconds -- what telegram-adapter.ts stores. */
const formatTime = (opts: { date: number }): string => {
  const at = new Date(opts.date * 1000);
  const hours = String(at.getHours()).padStart(2, '0');
  const minutes = String(at.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
};

/**
 * Consecutive messages from one person, close together in time, read as one
 * utterance. Repeating the name and the clock on every line of it is the noise
 * the git-blame rail exists to avoid.
 */
const startsGroup = (opts: { message: IMessageRow; previous: IMessageRow | undefined }): boolean => {
  const { message, previous } = opts;
  if (!previous) {
    return true;
  }
  if (previous.fromId !== message.fromId) {
    return true;
  }
  return message.date - previous.date >= GROUP_GAP_SECONDS;
};

/**
 * One entry per rendered row, in order. Wrapping here rather than leaving it to
 * the renderer is the whole fix: a `<text>` allowed to wrap itself makes one
 * child several rows tall, the column shrinks it to fit instead of clipping
 * it, and shrunk children overdraw one another into rows belonging to no
 * message at all.
 */
const buildRows = (opts: {
  messages: IMessageRow[];
  cursor: number;
  contentWidth: number;
  resolveSenderName: (opts: { fromId: string | null }) => string;
}): IRenderedRow[] => {
  const { messages, cursor, contentWidth, resolveSenderName } = opts;
  const rows: IRenderedRow[] = [];

  messages.forEach((message, index) => {
    const senderName = resolveSenderName({ fromId: message.fromId });
    const opensGroup = startsGroup({ message, previous: messages[index - 1] });
    // Hybrid numbering as in relativenumber + number: the cursor row shows its
    // absolute index, every other row its distance from the cursor.
    const gutter = index === cursor ? String(index + 1) : String(Math.abs(index - cursor));

    wrapText({ text: message.text, width: contentWidth }).forEach((line, lineIndex) => {
      const opensMessage = lineIndex === 0;
      rows.push({
        key: `${message.id}:${lineIndex}`,
        messageIndex: index,
        gutter: opensMessage ? padStartToWidth({ text: gutter, width: GUTTER_WIDTH }) : BLANK_GUTTER,
        time: opensMessage && opensGroup ? formatTime({ date: message.date }) : BLANK_TIME,
        sender:
          opensMessage && opensGroup
            ? padToWidth({ text: truncateToWidth({ text: senderName, width: SENDER_WIDTH }), width: SENDER_WIDTH })
            : BLANK_SENDER,
        content: padToWidth({ text: line, width: contentWidth }),
        own: message.out === 1,
      });
    });
  });

  return rows;
};

export const MessageView = (props: IMessageViewProps) => {
  const { messages, cursor, focused, tokens, height, width, resolveSenderName } = props;

  if (messages.length === 0) {
    return (
      <box flexDirection="column" width={width} height={height}>
        <text fg={tokens.dim}>No messages</text>
      </box>
    );
  }

  const contentWidth = Math.max(MINIMUM_CONTENT_WIDTH, width - RAIL_WIDTH);
  const rows = buildRows({ messages, cursor, contentWidth, resolveSenderName });

  // A cursor pointing past the end of the history would otherwise anchor the
  // window at -1 and scroll the pane off its own top.
  const cursorRowStart = Math.max(0, rows.findIndex(row => row.messageIndex === cursor));
  const cursorRowSpan = rows.filter(row => row.messageIndex === cursor).length;
  const { start, end } = resolveVisibleRowRange({
    totalRows: rows.length,
    cursorRowStart,
    cursorRowSpan,
    height,
  });

  return (
    <box flexDirection="column" width={width} height={height}>
      {rows.slice(start, end).map(row => {
        const highlighted = row.messageIndex === cursor && focused;

        return (
          <text
            key={row.key}
            height={1}
            flexShrink={0}
            bg={highlighted ? tokens.messageCursor : undefined}
          >
            <span fg={highlighted ? tokens.chatUnread : tokens.dim}>{`${MARKER}${row.gutter} `}</span>
            <span fg={tokens.dim}>{`${row.time} ${row.sender} `}</span>
            <span fg={row.own ? tokens.messageOwn : tokens.messageOther}>{row.content}</span>
          </text>
        );
      })}
    </box>
  );
};
