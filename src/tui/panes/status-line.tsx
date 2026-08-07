import type { IEngineState } from '../../keys/common/index.ts';
import { VimModes, type TVimMode } from '../../keys/common/index.ts';
import type { TConnectionState } from '../../core/application-store.ts';
import type { ITokens } from '../theme/index.ts';
import { measureTextWidth, truncateToWidth } from '../text-width.ts';
import {
  buildShowcmd, fitGroups, formatConnection, formatProgress, joinSegments,
  MESSAGE_LENGTH_LIMIT, MINIMUM_TITLE_WIDTH, PHRASE_SEPARATOR, READOUT_SEPARATOR, StatusTones,
  type ISegmentGroup, type IStatusSegment, type TStatusTone,
} from '../status-segments.ts';

export interface IStatusLineProps {
  mode: TVimMode;
  title: string;
  unreadCount: number;
  position: number;
  total: number;
  hint: string;
  tokens: ITokens;
  /** Columns available; position and hint are pushed to the far end of them. */
  width: number;
  /**
   * True while a destructive action (Task 8: delete) is waiting on y/n.
   * Recolours the title red rather than adding a row -- the status line stays
   * exactly one row either way (app.tsx's own STATUS_LINE_HEIGHT comment), so
   * the app's only irreversible action does not need its own chrome budget,
   * only a colour unmistakable enough that a skimmed status line still reads
   * as dangerous.
   */
  confirming: boolean;
  /**
   * True while `title` is carrying a data-integrity warning rather than a chat
   * name -- messages were, or may have been, lost. Colours it like
   * `confirming` for the same reason: a skimmed status line has to read as
   * wrong. Both are booleans on the same title rather than two rows, because
   * the status line stays exactly one row (app.tsx's STATUS_LINE_HEIGHT).
   */
  warning: boolean;
  /**
   * Everything below is context the line shows when there is room for it, in
   * priority order, and gives up quietly when there is not -- see
   * status-segments.ts. All optional: a caller that wants only the M1 line
   * still gets a correct one, and the props exist so App can fill them in
   * without every test harness having to.
   */
  engine?: IEngineState;
  connection?: TConnectionState;
  /** The active folder's name, shown only when it is not the everything folder. */
  folder?: string;
  /** 'bot', 'group', 'channel' -- a DM gets none, since it is the unremarkable case. */
  peerKind?: string;
  /** What the other side is doing, already phrased ('typing…'). */
  typing?: string;
  /** The message under the cursor, for its id, its clock and its flag. */
  messageId?: number | null;
  messageTime?: string;
  messagePinned?: boolean;
  /** Chats with something unread, across every folder -- what is waiting outside this one. */
  unreadChats?: number;
  /** Characters in the composer, shown against Telegram's limit while in insert mode. */
  composerLength?: number;
}

/** One column of air at each end, matching the pane rails above. */
const EDGE_PADDING = 1;
/** Between the mode block and the chat title. */
const CONTEXT_INDENT = 2;
/** Between the two groups, and the least air before the trailing one. */
const SECTION_GAP = 3;
/**
 * Between the connection mark and the folder, and between that pair and the
 * title. A space, not the phrase dot: `●` is a mark rather than a word, and a
 * dot beside it reads as a second, smaller mark.
 */
const LEADING_SEPARATOR = ' ';

const resolveModeColour = (opts: { mode: TVimMode; tokens: ITokens; confirming: boolean }): string => {
  const { mode, tokens, confirming } = opts;

  // Waiting on y/n is its own mode: every other key is dropped until the
  // question is answered. lualine gives its blocking mode a block of its own
  // colour rather than leaving it reading NORMAL, so this does too.
  if (confirming) {
    return tokens.error;
  }

  switch (mode) {
    case VimModes.INSERT: {
      return tokens.modeInsert;
    }
    case VimModes.VISUAL: {
      return tokens.modeVisual;
    }
    default: {
      return tokens.modeNormal;
    }
  }
};

const resolveToneColour = (opts: { tone: TStatusTone; tokens: ITokens }): string => {
  const { tone, tokens } = opts;
  switch (tone) {
    case StatusTones.PLAIN: {
      return tokens.foreground;
    }
    case StatusTones.ACCENT: {
      return tokens.chatUnread;
    }
    case StatusTones.ALERT: {
      return tokens.error;
    }
    default: {
      return tokens.dim;
    }
  }
};

/**
 * What goes to the right of the title, richest first.
 *
 * Priorities, and why: showcmd and the position are what a vim user reads
 * without looking, so they outlast everything. The composer's length matters
 * only while typing, but while typing it matters more than the history behind
 * it. The hint goes first -- it teaches the keymap once and is noise forever
 * after.
 */
const buildTrailing = (props: IStatusLineProps): IStatusSegment[] => {
  const { engine, mode, hint, position, total, messageId, messageTime, messagePinned } = props;

  const showcmd = engine ? buildShowcmd({ engine }) : '';

  // Only while typing, and against the limit rather than alone: a bare "3900"
  // says nothing, while "3900/4096" says how much room is left. Telegram
  // refuses the send past it, so the count turns red before the user finds
  // that out by losing the message.
  const length = props.composerLength ?? 0;
  const composer = mode === VimModes.INSERT ? `${length}/${MESSAGE_LENGTH_LIMIT}` : '';

  return [
    { text: showcmd, tone: StatusTones.ACCENT, priority: 95 },
    {
      text: composer,
      tone: length > MESSAGE_LENGTH_LIMIT ? StatusTones.ALERT : StatusTones.DIM,
      priority: 90,
    },
    { text: messagePinned === true ? '⚑' : '', tone: StatusTones.ACCENT, priority: 45 },
    { text: messageId === null || messageId === undefined ? '' : `#${messageId}`, tone: StatusTones.DIM, priority: 40 },
    { text: messageTime ?? '', tone: StatusTones.DIM, priority: 35 },
    { text: formatProgress({ position, total }), tone: StatusTones.DIM, priority: 50 },
    { text: total === 0 ? '' : `${position}/${total}`, tone: StatusTones.DIM, priority: 100 },
    { text: hint, tone: StatusTones.DIM, priority: 10 },
  ];
};

/** What goes to the left of the title: where you are, before what you are looking at. */
const buildLeading = (props: IStatusLineProps): IStatusSegment[] => {
  const { connection, folder } = props;
  const link: { text: string; tone: TStatusTone } = connection
    ? formatConnection({ connection })
    : { text: '', tone: StatusTones.DIM };

  return [
    { text: link.text, tone: link.tone, priority: 60 },
    { text: folder ?? '', tone: StatusTones.DIM, priority: 20 },
  ];
};

/** What goes after the title, describing the chat rather than locating it. */
const buildContext = (props: IStatusLineProps): IStatusSegment[] => {
  const { peerKind, unreadCount, unreadChats, typing } = props;

  return [
    { text: peerKind ?? '', tone: StatusTones.DIM, priority: 25 },
    { text: unreadCount > 0 ? `${unreadCount} unread` : '', tone: StatusTones.ACCENT, priority: 55 },
    { text: typing ?? '', tone: StatusTones.ACCENT, priority: 70 },
    { text: unreadChats !== undefined && unreadChats > 0 ? `${unreadChats} chats waiting` : '', tone: StatusTones.DIM, priority: 15 },
  ];
};

/** lualine's shape: mode block in section A, then context, then position. */
export const StatusLine = (props: IStatusLineProps) => {
  const { mode, title, tokens, width, confirming, warning } = props;

  const block = ` ${mode.toUpperCase()} `;
  const blockWidth = measureTextWidth({ text: block });

  // How much of the line the title claims before anything optional competes
  // for the rest.
  //
  // While confirming or warning, the title is not a chat name -- it is a
  // question the user has to answer or a message about data they may have
  // lost, and every readout on this line is worth less than reading it in
  // full. Otherwise it takes what it needs up to half the line: enough that
  // ordinary chat names are never clipped to make room for a clock, and
  // bounded so one long group name cannot push the position off the end.
  const titleWidth = measureTextWidth({ text: title });
  const titleReserve = confirming || warning
    ? titleWidth
    : Math.max(MINIMUM_TITLE_WIDTH, Math.min(titleWidth, Math.floor(width / 2)));

  // All three groups against one budget, so priority means the same thing
  // everywhere on the line. Each carries the cost of the separator joining it
  // to the title, charged only while it still has a member -- a group that
  // loses its last segment gives back its join too.
  const budget = Math.max(0, width - blockWidth - CONTEXT_INDENT - EDGE_PADDING - SECTION_GAP - titleReserve);
  const fitted = fitGroups({
    width: budget,
    groups: [
      { segments: buildLeading(props), separator: LEADING_SEPARATOR, joinWidth: LEADING_SEPARATOR.length },
      // The title joins the context group as its first member, so the dot
      // between "Alice" and "2 unread" is the same separator the group uses
      // throughout -- one phrase about one chat, not a title with a
      // decoration bolted on.
      { segments: buildContext(props), separator: PHRASE_SEPARATOR, joinWidth: PHRASE_SEPARATOR.length },
      { segments: buildTrailing(props), separator: READOUT_SEPARATOR, joinWidth: 0 },
    ],
  });
  const [leading, context, trailing] = fitted.groups as [ISegmentGroup, ISegmentGroup, ISegmentGroup];

  const spent = blockWidth + CONTEXT_INDENT + EDGE_PADDING + fitted.width;

  // The title is the only elastic part: everything else is either the reader's
  // position or something they asked to be told. Below zero the line has no
  // room for a title at all.
  const room = Math.max(0, width - spent - SECTION_GAP);
  const shown = truncateToWidth({ text: title, width: room });
  const filler = Math.max(SECTION_GAP, width - spent - measureTextWidth({ text: shown }));

  const titleColour = confirming || warning ? tokens.error : tokens.foreground;
  const leadingGapSpan: { text: string; tone: TStatusTone } = { text: LEADING_SEPARATOR, tone: StatusTones.DIM };
  const phraseGapSpan: { text: string; tone: TStatusTone } = { text: PHRASE_SEPARATOR, tone: StatusTones.DIM };
  const spans: { text: string; tone: TStatusTone }[] = [
    ...joinSegments({ segments: leading.segments, separator: LEADING_SEPARATOR }),
    ...(leading.segments.length > 0 ? [leadingGapSpan] : []),
  ];
  const after: { text: string; tone: TStatusTone }[] = context.segments.length > 0
    ? [phraseGapSpan, ...joinSegments({ segments: context.segments, separator: PHRASE_SEPARATOR })]
    : [];

  return (
    <box flexDirection="row" width={width} height={1}>
      <text height={1} flexShrink={0} fg={tokens.background} bg={resolveModeColour({ mode, tokens, confirming })}>
        {block}
      </text>
      <text height={1} flexShrink={0}>
        <span fg={tokens.dim}>{' '.repeat(CONTEXT_INDENT)}</span>
        {spans.map((span, index) => (
          <span key={`lead:${index}`} fg={resolveToneColour({ tone: span.tone, tokens })}>{span.text}</span>
        ))}
        <span fg={titleColour}>{shown}</span>
        {after.map((span, index) => (
          <span key={`ctx:${index}`} fg={resolveToneColour({ tone: span.tone, tokens })}>{span.text}</span>
        ))}
        <span fg={tokens.dim}>{' '.repeat(filler)}</span>
        {joinSegments({ segments: trailing.segments, separator: READOUT_SEPARATOR }).map((span, index) => (
          <span key={`trail:${index}`} fg={resolveToneColour({ tone: span.tone, tokens })}>{span.text}</span>
        ))}
        <span fg={tokens.dim}>{' '.repeat(EDGE_PADDING)}</span>
      </text>
    </box>
  );
};

export { MESSAGE_LENGTH_LIMIT };
