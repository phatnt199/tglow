import type { ReactNode } from 'react';

import type { IMessageRow } from '../../core/cache/index.ts';
import { EntityKinds, type TEntityKind } from '../../core/common/index.ts';
import { toStyledSpans, type IStyledSpan } from '../entities.ts';
import { measureTextWidth, padStartToWidth, padToWidth, toGraphemes, truncateToWidth } from '../text-width.ts';
import type { ITokens } from '../theme/index.ts';
import { resolveVisibleRowRange } from '../viewport.ts';
import { wrapSpans } from '../wrap-spans.ts';

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
  /**
   * Message ids whose spoiler entities render as text instead of a `█` mask.
   * No default: a caller that forgot this prop would otherwise render every
   * spoiler either always hidden or always shown, silently, and the
   * distinction between "no spoilers on screen" and "forgot to wire reveals"
   * is exactly the bug a required prop catches at compile time.
   */
  revealedSpoilers: Set<number>;
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

/** The kinds the M1 spec renders as coloured, underlined text rather than a modifier tag. */
const LINK_KINDS: readonly TEntityKind[] = [
  EntityKinds.URL, EntityKinds.TEXT_URL, EntityKinds.MENTION, EntityKinds.HASHTAG,
];

interface IRenderedRow {
  key: string;
  messageIndex: number;
  gutter: string;
  time: string;
  sender: string;
  content: IStyledSpan[];
  own: boolean;
  revealed: boolean;
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
 * `█` repeated to the span's *display* width, not its character count -- an
 * emoji inside a spoiler is two columns, and a mask narrower than what it
 * covers would shift every column after it once the row is padded out.
 */
const maskSpoilerSpans = (opts: { spans: IStyledSpan[]; revealed: boolean }): IStyledSpan[] => {
  if (opts.revealed) {
    return opts.spans;
  }
  return opts.spans.map(span => {
    if (!span.kinds.includes(EntityKinds.SPOILER)) {
      return span;
    }
    return { ...span, text: '█'.repeat(measureTextWidth({ text: span.text })) };
  });
};

const isLineBreakGrapheme = (grapheme: string): boolean =>
  grapheme === '\n' || grapheme === '\r' || grapheme === '\r\n';

/**
 * Mirrors wrap-text.ts's toLogicalLines, over styled spans instead of a raw
 * string. `wrapSpans` has no concept of a line break -- an embedded newline
 * would otherwise be just another non-space grapheme inside one very long
 * word instead of starting a new row -- so this splits first, the same way
 * toLogicalLines does before wrapText ever wraps a word. A width-0 grapheme
 * that is not the line break itself is an unrenderable control character by
 * measureGrapheme's own definition; a raw tab becomes a single space for the
 * reason toLogicalLines gives one -- a real terminal expands it at its own
 * tab stop, which desyncs the column the rail depends on -- and anything else
 * in that class is dropped. Styling survives every split because it is
 * carried per span rather than thrown away, which is the one job wrapText
 * itself could never have done here.
 */
const toLogicalSpanLines = (opts: { spans: IStyledSpan[] }): IStyledSpan[][] => {
  const lines: IStyledSpan[][] = [];
  let current: IStyledSpan[] = [];
  let segment = '';

  const closeSegment = (span: IStyledSpan): void => {
    if (segment !== '') {
      current.push({ text: segment, kinds: span.kinds, url: span.url });
      segment = '';
    }
  };

  for (const span of opts.spans) {
    for (const { grapheme, width } of toGraphemes({ text: span.text })) {
      if (isLineBreakGrapheme(grapheme)) {
        closeSegment(span);
        lines.push(current);
        current = [];
        continue;
      }
      if (width > 0) {
        segment += grapheme;
        continue;
      }
      if (grapheme === '\t') {
        segment += ' ';
      }
    }
    closeSegment(span);
  }
  lines.push(current);

  return lines.map(line => (line.length > 0 ? line : [{ text: '', kinds: [], url: null }]));
};

const isPlainSpan = (span: IStyledSpan): boolean => span.kinds.length === 0;

/**
 * Every rendered row must sum to exactly `width` columns, or the highlighted
 * cursor row's background stops wherever the text ran out instead of reaching
 * the pane's edge -- the styled-span equivalent of the old
 * `padToWidth({ text: line, width: contentWidth })`. The padding is appended
 * to the row's last span only when that span is already plain; extending a
 * link's underline or carrying a code span's colour into blank trailing
 * columns would draw a style nothing asked for, so a styled last span gets
 * its own unstyled trailing span instead.
 */
const padRowContent = (opts: { spans: IStyledSpan[]; width: number }): IStyledSpan[] => {
  const { spans, width } = opts;
  const used = spans.reduce((total, span) => total + measureTextWidth({ text: span.text }), 0);
  const deficit = width - used;
  if (deficit <= 0) {
    return spans;
  }

  const padding = ' '.repeat(deficit);
  const last = spans[spans.length - 1]!;
  if (isPlainSpan(last)) {
    return [...spans.slice(0, -1), { ...last, text: last.text + padding }];
  }
  return [...spans, { text: padding, kinds: [], url: null }];
};

const isLinkKind = (kinds: TEntityKind[]): boolean => LINK_KINDS.some(kind => kinds.includes(kind));
const isUnderlinedKind = (kinds: TEntityKind[]): boolean => kinds.includes(EntityKinds.UNDERLINE) || isLinkKind(kinds);

/**
 * Priority for a span whose kinds would otherwise disagree on colour.
 * Telegram does not in practice send code or a link overlapping an
 * unrevealed spoiler, so any fixed order is defensible -- this one favours
 * the mask colour first, since a still-hidden spoiler must never read as
 * anything else, then the two other content colours in the brief's table
 * order.
 */
const resolveContentColour = (opts: { kinds: TEntityKind[]; revealed: boolean; own: boolean; tokens: ITokens }): string => {
  const { kinds, revealed, own, tokens } = opts;
  if (kinds.includes(EntityKinds.SPOILER) && !revealed) {
    return tokens.messageCursor;
  }
  if (kinds.includes(EntityKinds.CODE) || kinds.includes(EntityKinds.PRE)) {
    return tokens.textCode;
  }
  if (isLinkKind(kinds)) {
    return tokens.textLink;
  }
  return own ? tokens.messageOwn : tokens.messageOther;
};

/** OpenTUI's `<b>`/`<i>`/`<u>` OR their attribute into whatever their parent already carries, so nesting composes instead of overriding. */
const wrapWithModifiers = (opts: { text: string; kinds: TEntityKind[] }): ReactNode => {
  const { text, kinds } = opts;
  let node: ReactNode = text;
  if (isUnderlinedKind(kinds)) {
    node = <u>{node}</u>;
  }
  if (kinds.includes(EntityKinds.ITALIC)) {
    node = <i>{node}</i>;
  }
  if (kinds.includes(EntityKinds.BOLD)) {
    node = <b>{node}</b>;
  }
  return node;
};

const renderContentSpan = (opts: {
  span: IStyledSpan;
  own: boolean;
  revealed: boolean;
  tokens: ITokens;
  spanKey: string;
}): ReactNode => {
  const { span, own, revealed, tokens, spanKey } = opts;
  const fg = resolveContentColour({ kinds: span.kinds, revealed, own, tokens });
  return (
    <span key={spanKey} fg={fg}>
      {wrapWithModifiers({ text: span.text, kinds: span.kinds })}
    </span>
  );
};

/**
 * One entry per rendered row, in order. Wrapping here rather than leaving it
 * to the renderer is the whole fix: a `<text>` allowed to wrap itself makes
 * one child several rows tall, the column shrinks it to fit instead of
 * clipping it, and shrunk children overdraw one another -- see
 * src/tui/viewport.ts. Entities change how many rows a message produces
 * (a masked spoiler is narrower, a link never grows one), so every row still
 * comes from this one pass rather than being guessed at elsewhere.
 */
const buildRows = (opts: {
  messages: IMessageRow[];
  cursor: number;
  contentWidth: number;
  resolveSenderName: (opts: { fromId: string | null }) => string;
  revealedSpoilers: Set<number>;
}): IRenderedRow[] => {
  const { messages, cursor, contentWidth, resolveSenderName, revealedSpoilers } = opts;
  const rows: IRenderedRow[] = [];

  messages.forEach((message, index) => {
    const senderName = resolveSenderName({ fromId: message.fromId });
    const opensGroup = startsGroup({ message, previous: messages[index - 1] });
    // Hybrid numbering as in relativenumber + number: the cursor row shows its
    // absolute index, every other row its distance from the cursor.
    const gutter = index === cursor ? String(index + 1) : String(Math.abs(index - cursor));
    const revealed = revealedSpoilers.has(message.id);

    const styled = maskSpoilerSpans({
      spans: toStyledSpans({ text: message.text, entities: message.entities }),
      revealed,
    });
    const wrappedRows = toLogicalSpanLines({ spans: styled })
      .flatMap(line => wrapSpans({ spans: line, width: contentWidth }));

    wrappedRows.forEach((rowSpans, lineIndex) => {
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
        content: padRowContent({ spans: rowSpans, width: contentWidth }),
        own: message.out === 1,
        revealed,
      });
    });
  });

  return rows;
};

export const MessageView = (props: IMessageViewProps) => {
  const { messages, cursor, focused, tokens, height, width, resolveSenderName, revealedSpoilers } = props;

  if (messages.length === 0) {
    return (
      <box flexDirection="column" width={width} height={height}>
        <text fg={tokens.dim}>No messages</text>
      </box>
    );
  }

  const contentWidth = Math.max(MINIMUM_CONTENT_WIDTH, width - RAIL_WIDTH);
  const rows = buildRows({ messages, cursor, contentWidth, resolveSenderName, revealedSpoilers });

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
            {row.content.map((span, spanIndex) =>
              renderContentSpan({ span, own: row.own, revealed: row.revealed, tokens, spanKey: `${row.key}:${spanIndex}` }),
            )}
          </text>
        );
      })}
    </box>
  );
};
