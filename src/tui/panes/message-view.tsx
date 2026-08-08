import type { ReactNode } from 'react';

import { TextAttributes } from '@opentui/core';

import type { IMessageRow } from '../../core/cache/index.ts';
import { EntityKinds, type TEntityKind } from '../../core/common/index.ts';
import { describeMedia } from '../../core/media.ts';
import { describeReactions } from '../../core/reactions.ts';
import type { IImageCell } from '../image-renderer.ts';
import { formatClock } from '../clock.ts';
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
  /**
   * The open chat's dialog.readOutboxMaxId -- the highest id of the user's
   * own messages the other side has read. Drives the tick shown on own
   * messages; a message that is not the user's own never reads this. No
   * default, same reasoning as revealedSpoilers above: a caller that forgot
   * it would otherwise show every own message as read (0 is a valid, if
   * misleading, number) rather than fail to compile.
   */
  readOutboxMaxId: number;
  /** A click on a message, by its index in `messages`. */
  onMessagePress?: (opts: { index: number; button: number; x: number; y: number }) => void;
  /** A wheel over the pane. Positive scrolls toward newer messages. */
  onScroll?: (opts: { delta: number }) => void;
  /**
   * The relative-number gutter and the clock, each switchable. Both default
   * on, which is what the pane has always drawn.
   *
   * A hidden field gives its columns back to the conversation rather than
   * blanking them: leaving a hole where the time used to be would spend the
   * width and show nothing for it.
   */
  showGutter?: boolean;
  showTime?: boolean;
  /**
   * The drawn picture for a message, by id, when there is one and it has been
   * fetched. Absent simply means the message shows its descriptor -- which is
   * what every media message showed before pictures, and is what a photo
   * still shows while its bytes are on the way.
   */
  imagesByMessageId?: Map<number, IImageCell[][]>;
  /**
   * Called with where each picture ended up, in cells relative to this pane's
   * own top-left, so a caller that can hand the terminal the real image knows
   * exactly which cells to put it over.
   *
   * Reported from here because this is the only place that knows: which rows
   * are on screen is the outcome of wrapping, scrolling and the viewport, none
   * of which App can work out without redoing all of it.
   */
  onImageRows?: (placements: IImageRowPlacement[]) => void;
}

export interface IImageRowPlacement {
  messageId: number;
  /** Rows from the top of this pane, zero-based. */
  paneRow: number;
  /** Columns from the left of this pane, zero-based -- past the rail. */
  paneColumn: number;
  rows: number;
  columns: number;
}

/** Reserved and always blank: the cursorline shows position, not an arrow. */
const MARKER_WIDTH = 1;
const GUTTER_WIDTH = 4;
const TIME_WIDTH = 5;
const SENDER_WIDTH = 10;
/** Two columns: both ticks once read, one tick and a blank while only sent, or fully blank when the message is not the user's own. */
const TICK_WIDTH = 2;
/**
 * marker, gutter, time, sender and tick, each followed by a single blank
 * column -- minus whichever of the gutter and the time are switched off.
 *
 * A hidden field gives its columns back to the conversation rather than
 * blanking them in place. Leaving a five-column hole where the time used to be
 * would be the worst of both: the width still spent, and nothing shown for it.
 */
const resolveRailWidth = (opts: { showGutter: boolean; showTime: boolean }): number =>
  MARKER_WIDTH
  + (opts.showGutter ? GUTTER_WIDTH + 1 : 0)
  + (opts.showTime ? TIME_WIDTH + 1 : 0)
  + SENDER_WIDTH + 1 + TICK_WIDTH + 1;
/** Below this the rail is worth more than the sliver of text it would leave. */
const MINIMUM_CONTENT_WIDTH = 8;
/**
 * `pre`'s left rule: the character plus one separator column, echoing the
 * rail fields above (a fixed-width field followed by a blank column). Reuses
 * the same glyph as app.tsx's own VERTICAL_RULE (pane divider) rather than
 * inventing a second rule character for what is, visually, the same idea --
 * a vertical line marking a block's edge.
 */
const PRE_RULE = '│ ';
const PRE_RULE_WIDTH = measureTextWidth({ text: PRE_RULE });

/** A gap this long starts a new group even from the same sender. */
const GROUP_GAP_SECONDS = 300;

/** Shown in place of a sender-and-text preview when the target isn't (or isn't yet) in `messages` -- still says something rather than leaving the reply unexplained. */
const REPLY_FALLBACK_TEXT = 'Replying to an earlier message';

const MARKER = ' '.repeat(MARKER_WIDTH);
const BLANK_GUTTER = ' '.repeat(GUTTER_WIDTH);
const BLANK_TIME = ' '.repeat(TIME_WIDTH);
const BLANK_SENDER = ' '.repeat(SENDER_WIDTH);
const BLANK_TICK = ' '.repeat(TICK_WIDTH);
// The single "sent" tick sits in the same first column the read state's own
// first ✓ occupies, so a message going from sent to read never shifts the
// tick already on screen -- only fills in the second column beside it.
/**
 * The pinned mark, in the one column M1a reserved and left blank.
 *
 * A flag rather than 📌: the pushpin is two columns wide, and widening the
 * rail by one for every message in every chat to mark the handful that are
 * pinned is a poor trade. `⚑` measures one, which the whole rail depends on --
 * every field here is fixed-width, and a glyph a column wider than its field
 * shifts the entire row.
 */
const PIN_MARKER = '⚑';
const TICK_SENT = '✓ ';
const TICK_READ = '✓✓';

/** The kinds the M1 spec renders as coloured, underlined text rather than a modifier tag. */
const LINK_KINDS: readonly TEntityKind[] = [
  EntityKinds.URL, EntityKinds.TEXT_URL, EntityKinds.MENTION, EntityKinds.HASHTAG,
];

interface IRenderedRow {
  key: string;
  messageIndex: number;
  /** 'quote' rows render their one content span dimmed, ignoring entity/ownership colour entirely -- see the render loop below. */
  kind: 'content' | 'quote';
  gutter: string;
  time: string;
  sender: string;
  tick: string;
  content: IStyledSpan[];
  own: boolean;
  revealed: boolean;
  /** The pinned mark, or a blank. Only the row that opens a message carries one. */
  marker: string;
  /** True for a row carrying `pre` content -- prefixed with PRE_RULE ahead of `content` at render time. Always false for a quote row. */
  rulePrefix: boolean;
  /**
   * One row of a picture, drawn cell by cell instead of as styled text.
   *
   * Its own field rather than a kind of content span: a cell carries its own
   * two colours, where a span's colour comes from its entity kinds, and
   * squeezing pixels through that would mean inventing an entity per shade.
   */
  cells?: IImageCell[];
}

/**
 * Ticks are per-message, unlike time/sender which show once per consecutive
 * group (startsGroup below) -- two own messages sent seconds apart can still
 * disagree on whether the other side has read them yet, so each needs its own
 * mark rather than inheriting its group's.
 */
const resolveTick = (opts: { own: boolean; messageId: number; readOutboxMaxId: number }): string => {
  const { own, messageId, readOutboxMaxId } = opts;
  if (!own) {
    return BLANK_TICK;
  }
  return messageId <= readOutboxMaxId ? TICK_READ : TICK_SENT;
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
const isPreSpan = (span: IStyledSpan): boolean => span.kinds.includes(EntityKinds.PRE);

interface IWrappedRow {
  spans: IStyledSpan[];
  isPre: boolean;
}

/**
 * Splits one logical line (already newline-free, from toLogicalSpanLines)
 * into consecutive runs that agree on pre-ness, so a `pre` span's boundary is
 * never straddled by a run mixing it with plain content -- a `code` span
 * (inline, spec §3.1) is deliberately excluded and stays free to share a row.
 * Real Telegram sends `pre` as a whole block rather than interleaved with
 * other text on the same line, so in practice every run here is either the
 * entire line or none of it; splitting defensively rather than assuming that
 * shape costs nothing and does not misrender the ordinary case.
 */
const splitPreRuns = (opts: { spans: IStyledSpan[] }): IWrappedRow[] => {
  const runs: IWrappedRow[] = [];
  let current: IStyledSpan[] = [];
  let currentIsPre: boolean | null = null;

  for (const span of opts.spans) {
    const spanIsPre = isPreSpan(span);
    if (currentIsPre !== null && spanIsPre !== currentIsPre) {
      runs.push({ spans: current, isPre: currentIsPre });
      current = [];
    }
    current.push(span);
    currentIsPre = spanIsPre;
  }
  if (current.length > 0) {
    runs.push({ spans: current, isPre: currentIsPre! });
  }
  return runs;
};

/**
 * One logical line to the rows it wraps into, each tagged with whether it
 * came from a `pre` run -- a `pre` run wraps narrower, leaving room for
 * PRE_RULE, so the row it produces can carry the rule without overrunning
 * contentWidth once padRowContent pads it back out.
 */
const wrapLogicalLine = (opts: { spans: IStyledSpan[]; contentWidth: number; preContentWidth: number }): IWrappedRow[] => {
  const { spans, contentWidth, preContentWidth } = opts;
  return splitPreRuns({ spans }).flatMap(run =>
    wrapSpans({ spans: run.spans, width: run.isPre ? preContentWidth : contentWidth })
      .map(rowSpans => ({ spans: rowSpans, isPre: run.isPre })),
  );
};

/**
 * `messages` here is `props.messages` -- everything this pane currently
 * holds, not the whole cache -- so a reply to something outside that window
 * (scrolled past, or simply never loaded) falls back to REPLY_FALLBACK_TEXT
 * rather than an empty or misleading quote.
 */
const buildQuoteText = (opts: {
  replyToMessageId: number;
  messages: IMessageRow[];
  resolveSenderName: (opts: { fromId: string | null }) => string;
}): string => {
  const { replyToMessageId, messages, resolveSenderName } = opts;
  const target = messages.find(candidate => candidate.id === replyToMessageId);
  if (!target) {
    return REPLY_FALLBACK_TEXT;
  }
  const senderName = resolveSenderName({ fromId: target.fromId });
  const firstLine = target.text.split(/\r\n|\r|\n/)[0] ?? '';
  return `Replying to ${senderName}: ${firstLine}`;
};

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
const padRowContent = (opts: { spans: IStyledSpan[]; width: number; indent?: number }): IStyledSpan[] => {
  const { spans, width } = opts;
  const indent = Math.max(0, opts.indent ?? 0);
  // Prepended as its own unstyled span rather than merged into the first: the
  // first span may be a link or a code run, and extending either backwards
  // would underline or colour blank columns nothing asked for -- the same
  // reasoning the trailing pad already follows.
  const indented = indent > 0 ? [{ text: ' '.repeat(indent), kinds: [], url: null }, ...spans] : spans;

  const used = indented.reduce((total, span) => total + measureTextWidth({ text: span.text }), 0);
  const deficit = width - used;
  if (deficit <= 0) {
    return indented;
  }

  const padding = ' '.repeat(deficit);
  const last = indented[indented.length - 1]!;
  if (isPlainSpan(last)) {
    return [...indented.slice(0, -1), { ...last, text: last.text + padding }];
  }
  return [...indented, { text: padding, kinds: [], url: null }];
};

/**
 * The minimum content width at which own messages are pushed to the right.
 *
 * Below it every message stays left-aligned, the way a narrow Telegram window
 * also gives up on side-by-side. Right-aligning in a cramped pane costs the
 * one thing that pane has least of -- room for the text itself -- and buys a
 * distinction the `me` in the sender column already makes.
 */
export const RIGHT_ALIGN_MINIMUM_CONTENT_WIDTH = 60;

/**
 * How far right to push a message's block, so its widest line ends at the
 * pane's right edge. Own messages only, and only when there is room.
 *
 * The indent needs no cap of its own: it is `contentWidth - widest`, which
 * shrinks to nothing as a message grows, so a long message barely moves while
 * a short one goes all the way over. An earlier version capped it at half the
 * pane, reasoning that a block should never be squeezed thin -- but the
 * squeezing it feared cannot happen, and the cap only stopped short messages
 * from reaching the edge, which is precisely the case right-alignment is for.
 * It parked every one of them mid-pane instead.
 */
const resolveBlockIndent = (opts: { own: boolean; contentWidth: number; rows: IStyledSpan[][] }): number => {
  const { own, contentWidth, rows } = opts;
  if (!own || contentWidth < RIGHT_ALIGN_MINIMUM_CONTENT_WIDTH || rows.length === 0) {
    return 0;
  }

  const widest = rows.reduce(
    (widestSoFar, row) =>
      Math.max(widestSoFar, row.reduce((total, span) => total + measureTextWidth({ text: span.text }), 0)),
    0,
  );
  return Math.max(0, contentWidth - widest);
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

/**
 * Strike has no dedicated JSX tag the way bold/italic/underline do -- OpenTUI's
 * component catalogue offers only span/b/strong/i/em/u/br/a
 * (@opentui/react's components/index.ts) -- so it is carried as a bit in the
 * numeric `attributes` field every span-like renderable accepts instead
 * (TextAttributes.STRIKETHROUGH, @opentui/core). Set on the outer `<span>`
 * rather than the modifiers themselves: TextNodeRenderable.mergeStyles ORs a
 * node's own attributes with whatever it inherits (`this._attributes |
 * parentStyle.attributes`, verified in @opentui/core's compiled
 * TextNodeRenderable), so a strike-and-bold span still ends up with both bits
 * set on its innermost text node.
 */
const resolveAttributes = (opts: { kinds: TEntityKind[] }): number | undefined =>
  opts.kinds.includes(EntityKinds.STRIKE) ? TextAttributes.STRIKETHROUGH : undefined;

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
    <span key={spanKey} fg={fg} attributes={resolveAttributes({ kinds: span.kinds })}>
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
  readOutboxMaxId: number;
  imagesByMessageId: Map<number, IImageCell[][]> | undefined;
}): IRenderedRow[] => {
  const {
    messages, cursor, contentWidth, resolveSenderName, revealedSpoilers, readOutboxMaxId, imagesByMessageId,
  } = opts;
  const rows: IRenderedRow[] = [];
  // Never below 1: a pane so narrow that contentWidth itself sits at
  // MINIMUM_CONTENT_WIDTH still leaves splitLongWord something to cut into.
  const preContentWidth = Math.max(1, contentWidth - PRE_RULE_WIDTH);

  messages.forEach((message, index) => {
    const senderName = resolveSenderName({ fromId: message.fromId });
    const opensGroup = startsGroup({ message, previous: messages[index - 1] });
    // Hybrid numbering as in relativenumber + number: the cursor row shows its
    // absolute index, every other row its distance from the cursor.
    const gutter = index === cursor ? String(index + 1) : String(Math.abs(index - cursor));
    const revealed = revealedSpoilers.has(message.id);
    const own = message.out === 1;
    const tick = resolveTick({ own, messageId: message.id, readOutboxMaxId });

    // Pushed before the message's own content rows, so it sits directly above
    // them and, sharing this message's `messageIndex`, scrolls and highlights
    // with the rest of it exactly as a wrapped continuation row already does.
    if (message.replyToMessageId !== null) {
      const quoteText = buildQuoteText({ replyToMessageId: message.replyToMessageId, messages, resolveSenderName });
      rows.push({
        key: `${message.id}:quote`,
        messageIndex: index,
        kind: 'quote',
        // The pinned mark belongs to the message, and the message's own first
        // row carries it -- a quote row above it would put the flag on the
        // wrong line.
        marker: MARKER,
        // Blank, like a wrapped continuation row: the quote is not itself a
        // dated, sent-by someone message, so the rail has nothing to show.
        gutter: BLANK_GUTTER,
        time: BLANK_TIME,
        sender: BLANK_SENDER,
        tick: BLANK_TICK,
        content: padRowContent({
          spans: [{ text: truncateToWidth({ text: quoteText, width: contentWidth }), kinds: [], url: null }],
          width: contentWidth,
        }),
        own,
        revealed,
        rulePrefix: false,
      });
    }

    // Media first, on its own line, then whatever caption came with it.
    //
    // Before this a photo was a message whose text was '' and whose row was
    // therefore blank -- not "a picture we cannot draw", but nothing at all,
    // indistinguishable from an empty message. The descriptor is plain text
    // rather than an entity run: it is not part of what anyone typed, so
    // nothing in it should be a link, a mention, or maskable as a spoiler.
    const mediaLine: IStyledSpan[][] = message.media
      ? [[{ text: describeMedia({ media: message.media }), kinds: [], url: null }]]
      : [];

    const styled = maskSpoilerSpans({
      spans: toStyledSpans({ text: message.text, entities: message.entities }),
      revealed,
    });
    // Reactions last, below the message they are about -- which is where every
    // client puts them, and the only place that reads correctly for a message
    // that wraps: attached to the top they would look like a reaction to the
    // message above.
    const reactionText = describeReactions({ reactions: message.reactions ?? [] });
    const reactionLine: IStyledSpan[][] = reactionText === ''
      ? []
      : [[{ text: reactionText, kinds: [], url: null }]];

    // The picture, above the descriptor that names it. Both: the descriptor
    // says what it is and how big, which a squint at forty cells does not.
    //
    // Kept out of the wrapping below, unlike every other row here. A picture
    // row is already exactly one row wide by construction, and routing it
    // through the wrapper as an empty line produced no rows at all -- the
    // picture silently vanished and took its descriptor's position with it.
    const picture = imagesByMessageId?.get(message.id);

    const wrappedRows = [...mediaLine, ...toLogicalSpanLines({ spans: styled }), ...reactionLine]
      .flatMap(line => wrapLogicalLine({ spans: line, contentWidth, preContentWidth }));

    // How far this message's block is pushed right. Zero for everything the
    // other side sent, and zero in a narrow pane -- see resolveBlockIndent.
    //
    // Computed once per message from its widest row, not per row: indenting
    // each row to its own width would right-align every line individually and
    // leave a wrapped paragraph ragged down its left edge. One indent for the
    // whole block keeps the lines aligned with each other and moves the block
    // as a unit, which is what a bubble is.
    const blockIndent = resolveBlockIndent({
      own,
      contentWidth,
      rows: wrappedRows.map(row => row.spans),
    });

    // The picture's own rows, before anything the message says.
    (picture ?? []).forEach((cells, pictureIndex) => {
      const opensMessage = pictureIndex === 0;
      rows.push({
        key: `${message.id}:picture:${pictureIndex}`,
        messageIndex: index,
        kind: 'content',
        marker: opensMessage && message.pinned === 1 ? PIN_MARKER : MARKER,
        gutter: opensMessage ? padStartToWidth({ text: gutter, width: GUTTER_WIDTH }) : BLANK_GUTTER,
        time: opensMessage && opensGroup ? formatClock({ date: message.date }) : BLANK_TIME,
        sender: opensMessage && opensGroup
          ? padToWidth({ text: truncateToWidth({ text: senderName, width: SENDER_WIDTH }), width: SENDER_WIDTH })
          : BLANK_SENDER,
        tick: opensMessage ? tick : BLANK_TICK,
        content: [],
        cells,
        own,
        revealed,
        rulePrefix: false,
      });
    });

    wrappedRows.forEach(({ spans: rowSpans, isPre }, lineIndex) => {
      // The rail's once-per-message fields belong to whichever row is
      // genuinely first, which is a picture row when there is a picture.
      const opensMessage = lineIndex === 0 && !picture;
      const rowWidth = isPre ? preContentWidth : contentWidth;
      rows.push({
        key: `${message.id}:${lineIndex}`,
        messageIndex: index,
        kind: 'content',
        marker: opensMessage && message.pinned === 1 ? PIN_MARKER : MARKER,
        gutter: opensMessage ? padStartToWidth({ text: gutter, width: GUTTER_WIDTH }) : BLANK_GUTTER,
        time: opensMessage && opensGroup ? formatClock({ date: message.date }) : BLANK_TIME,
        sender:
          opensMessage && opensGroup
            ? padToWidth({ text: truncateToWidth({ text: senderName, width: SENDER_WIDTH }), width: SENDER_WIDTH })
            : BLANK_SENDER,
        // Every own message's own row, not gated on opensGroup the way
        // time/sender are -- see resolveTick's own comment above.
        tick: opensMessage ? tick : BLANK_TICK,
        content: padRowContent({ spans: rowSpans, width: rowWidth, indent: isPre ? 0 : blockIndent }),
        // The first rows of a message with a picture are its picture, one
        // output row each -- so they scroll, wrap and highlight with the rest
        // of the message rather than being a separate thing pinned somewhere.
        own,
        revealed,
        rulePrefix: isPre,
      });
    });
  });

  return rows;
};

export const MessageView = (props: IMessageViewProps) => {
  const {
    messages, cursor, focused, tokens, height, width, resolveSenderName, revealedSpoilers, readOutboxMaxId,
    onMessagePress, onScroll, showGutter = true, showTime = true, imagesByMessageId, onImageRows,
  } = props;

  if (messages.length === 0) {
    return (
      <box flexDirection="column" width={width} height={height}>
        <text fg={tokens.dim}>No messages</text>
      </box>
    );
  }

  const contentWidth = Math.max(MINIMUM_CONTENT_WIDTH, width - resolveRailWidth({ showGutter, showTime }));
  const rows = buildRows({
    messages, cursor, contentWidth, resolveSenderName, revealedSpoilers, readOutboxMaxId, imagesByMessageId,
  });

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

  // Where each picture's visible rows landed, for a caller that can hand the
  // terminal the real image. Grouped per message: a picture is contiguous
  // rows, and a placement covers all of them at once.
  //
  // Only what is on screen. A picture scrolled half out has only its visible
  // rows reported, and the terminal is asked to fit the image to those -- so
  // it is cropped by being drawn smaller rather than by spilling past the
  // pane, which is the one thing an image over a diffing renderer must never
  // do.
  const railWidth = resolveRailWidth({ showGutter, showTime });
  const placements: IImageRowPlacement[] = [];
  rows.slice(start, end).forEach((row, offset) => {
    if (!row.cells) {
      return;
    }
    const message = messages[row.messageIndex];
    const existing = placements[placements.length - 1];
    if (message && existing?.messageId === message.id && existing.paneRow + existing.rows === offset) {
      existing.rows += 1;
      return;
    }
    if (message) {
      placements.push({
        messageId: message.id,
        paneRow: offset,
        paneColumn: railWidth,
        rows: 1,
        columns: row.cells.length,
      });
    }
  });
  onImageRows?.(placements);

  return (
    <box
      flexDirection="column"
      width={width}
      height={height}
      onMouseScroll={(event: { scroll?: { direction: string } }) => {
        // Reported as a direction; what it moves is App's decision. It moves
        // the cursor there, and the viewport follows, because this pane's
        // window has always been derived from the cursor rather than tracked
        // separately.
        onScroll?.({ delta: event.scroll?.direction === 'down' ? 1 : -1 });
      }}
    >
      {rows.slice(start, end).map(row => {
        const highlighted = row.messageIndex === cursor && focused;

        return (
          <text
            key={row.key}
            height={1}
            flexShrink={0}
            bg={highlighted ? tokens.messageCursor : undefined}
            // Every row of a message reports the message it belongs to, not
            // the row: clicking the third line of a wrapped message puts the
            // cursor on that message, the way clicking anywhere in a paragraph
            // does. row.messageIndex is already that mapping.
            onMouseDown={(event: { button: number; x: number; y: number }) => {
              onMessagePress?.({ index: row.messageIndex, button: event.button, x: event.x, y: event.y });
            }}
          >
            <span fg={highlighted ? tokens.chatUnread : tokens.dim}>
              {showGutter ? `${row.marker}${row.gutter} ` : row.marker}
            </span>
            <span fg={tokens.dim}>
              {`${showTime ? `${row.time} ` : ''}${row.sender} ${row.tick} `}
            </span>
            {row.cells ? (
              // One span per cell: each carries its own two colours, which is
              // what a picture is. Adjacent cells rarely match in a photo, so
              // there is nothing to merge and no run to find.
              row.cells.map((cell, cellIndex) => (
                <span
                  key={`${row.key}:cell:${cellIndex}`}
                  fg={cell.foreground ?? undefined}
                  bg={cell.background ?? undefined}
                >
                  {cell.char}
                </span>
              ))
            ) : row.kind === 'quote' ? (
              <span fg={tokens.dim}>{row.content[0]?.text ?? ''}</span>
            ) : (
              <>
                {row.rulePrefix && <span key={`${row.key}:rule`} fg={tokens.border}>{PRE_RULE}</span>}
                {row.content.map((span, spanIndex) =>
                  renderContentSpan({ span, own: row.own, revealed: row.revealed, tokens, spanKey: `${row.key}:${spanIndex}` }),
                )}
              </>
            )}
          </text>
        );
      })}
    </box>
  );
};
