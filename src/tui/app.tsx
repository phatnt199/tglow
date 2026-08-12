import { Fragment, useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';

import { useKeyboard, useRenderer, useTerminalDimensions } from '@opentui/react';
import { ApplicationLogger, type ILogger } from '@venizia/ignis-helpers';

// Type-only import, erased at runtime under verbatimModuleSyntax, so this
// path choice has no bearing on the telegram/global.window crash the test
// files' value imports had to avoid (see src/__tests__/tui/app.test.tsx) --
// points at the concrete module rather than the core/ barrel purely because
// that is where IApplicationState is actually defined.
import type { ApplicationStoreService, IApplicationState } from '../core/application-store.ts';
// Type-only too, so -- like the import above -- safe from the core/ barrel's
// crash path regardless of which module it pointed at; kept on cache/index.ts
// rather than database.ts to match how src/tui/panes/chat-list.tsx already
// imports this same type.
import type { IDialogRow } from '../core/cache/index.ts';
// Same reasoning as the type-only imports above, but this one is a value
// import (writeToClipboard is called below, not just typed against) -- the
// concrete module is what keeps it off the core/ barrel's telegram/
// global.window crash path, not merely off the hook by being erased.
import { writeToClipboard } from '../core/clipboard.ts';
// Same reasoning as writeToClipboard directly above: fuzzyMatch (M1b-2
// Task 8) is called below, not just typed against, so it too has to come
// from its concrete module rather than the core/ barrel.
import { fuzzyMatch } from '../core/fuzzy-match.ts';
import { ALL_CHATS_FOLDER_ID, resolveFolderMembership } from '../core/folder-service.ts';
import { readTypingStatus } from '../core/typing-status.ts';
import { MediaKinds } from '../core/media.ts';
import { describePresence, PresenceKinds } from '../core/presence.ts';
import { renderImage, type IImageCell } from './image-renderer.ts';
import {
  imageCacheKey,
  planImageFetches,
  resolveImageWidth,
  resolvePaneOrigin,
  toTerminalImageId,
} from './image-layout.ts';
import { formatClock } from './clock.ts';
import { CommandNames, completeCommand, describeUnknown, parseCommand } from './command-line.ts';
import { forget, place, supportsGraphics, transmit, type IImagePlacement, type IRgbaImage } from './kitty-graphics.ts';
import { drawImage, resolveCellSize, supportsSixel } from './sixel-graphics.ts';
import { resolveReactionKey } from './reaction-picker.ts';
import { measureTextWidth, toGraphemes } from './text-width.ts';
import { formatPeerKind } from './status-segments.ts';
// Type-only: App receives a MessageSearchService instance through props
// (constructed and DI-wired by main.ts) and only ever calls the instance
// method .search() on it below -- there is no `new MessageSearchService(...)`
// here for a value import to serve.
import type { MessageSearchService } from '../core/message-search.ts';
import {
  ActionTypes, CLIPBOARD_REGISTER, Operators, UNNAMED_REGISTER, VimContexts, VimModes,
  type IEngineState, type IResolveResult, type TAction,
} from '../keys/common/index.ts';
import type { KeyNormalizerService, KeymapService, VimEngineService } from '../keys/index.ts';
import { applyAction, resolveSearchMatchIndices } from './action-reducer.ts';
import { ChatPicker, CommandLine, ContextMenu, ReactionPicker, resolveChatPickerHeight, resolveWhichKeyHeight, SEARCH_OVERLAY_HEIGHT, SearchOverlay, WhichKey } from './overlays/index.ts';
import { buildChatMenu, buildMessageMenu, MenuActions, resolveMenuPosition, resolveMenuWidth } from './context-menu.ts';
import {
  FRAME_TEE_LEFT,
  FRAME_TEE_RIGHT,
  FRAME_VERTICAL,
  FRAME_VERTICAL_COST,
  buildSectionDivider,
  buildBottomEdge,
  buildTopEdge,
  resolvePaneWidths,
} from './pane-frame.ts';
import { ChatList, Composer, COMPOSER_PROMPT_WIDTH, FolderRail, MessageView, StatusLine, type IImageRowPlacement } from './panes/index.ts';
import { shareEvenly, withActive } from '../core/conversation-panes.ts';
import type { ITokens } from './theme/index.ts';

export interface IAppProps {
  store: ApplicationStoreService;
  engine: VimEngineService;
  keymapService: KeymapService;
  keyNormalizer: KeyNormalizerService;
  /**
   * `/`'s own search, M1b-2 Task 9. Called directly, synchronously, the same
   * treatment VimEngineService/KeymapService already get -- unlike
   * onSend/onEdit/onOpenChat below, this never touches the network
   * (DatabaseService.searchMessages is a local, synchronous bun:sqlite read),
   * so it needs no callback-prop wrapping or fire-and-forget error handling.
   */
  messageSearchService: MessageSearchService;
  /**
   * How long an `ambiguous` key sequence (vim-engine.ts's own status: an
   * exact match that is also the prefix of a longer binding, the way a
   * hypothetical bare `d` would sit next to `dd`) waits for a completing key
   * before the engine's flushPending resolves the shorter binding on its
   * own -- vim's own timeoutlen. Sourced from IApplicationConfiguration so
   * it can be tuned without a rebuild.
   */
  timeoutMilliseconds: number;
  tokens: ITokens;
  resolveSenderName: (opts: { fromId: string | null }) => string;
  onSend: (text: string) => Promise<void>;
  onEdit: (opts: { messageId: number; text: string }) => Promise<void>;
  onDelete: (opts: { messageIds: number[] }) => Promise<void>;
  onPin: (opts: { peerId: string; messageId: number }) => Promise<void>;
  /** Load the page of history before the one on screen. Called when the cursor nears the top of it; every guard lives in the service. */
  onLoadOlder: (opts: { peerId: string }) => Promise<void>;
  /**
   * `:logout`, once confirmed: sign out on Telegram, erase the local session
   * and cache, and quit. Never called without a y/n answered yes.
   */
  onLogout: () => Promise<void>;
  /** Pin or unpin a chat in the sidebar. */
  onPinChat: (opts: { peerId: string }) => Promise<void>;
  /** React to a message, or take the reaction back by choosing the same one again. */
  onReact: (opts: { peerId: string; messageId: number; emoji: string }) => Promise<void>;
  /** Copy messages into another chat. */
  onForward: (opts: { fromPeerId: string; toPeerId: string; messageIds: number[] }) => Promise<void>;
  /** Send a file from disk, with the composer as its caption. */
  onSendFile: (opts: { peerId: string; path: string }) => Promise<void>;
  /** The picture on a message, as bytes, from the cache or from Telegram. */
  onThumbnail: (opts: { peerId: string; messageId: number }) => Promise<Uint8Array | null>;
  /** Open the message's picture at full size, outside the terminal. */
  onOpenMedia: (opts: { peerId: string; messageId: number }) => Promise<void>;
  onQuit: () => void;
  onOpenChat: (opts: { peerId: string }) => Promise<void>;
  /**
   * Called only for the two moments Task 9's brief names: once a chat is open
   * and its newest message is showing, and again whenever the cursor reaches
   * that newest message afterward. Never for chat-list movement -- reading is
   * an explicit act, not a side effect of browsing. Fired on every qualifying
   * move with no debounce of its own; MessageService.markRead owns that.
   */
  onMarkRead: (opts: { peerId: string; maxId: number }) => Promise<void>;
}

const SIDEBAR_WIDTH = 22;
/**
 * The composer now lives inside the right pane, beneath the conversation it
 * writes into, rather than spanning the window under both panes. These are its
 * rows, taken out of the message view -- and they must stay in lockstep with
 * what composer.tsx actually renders, or the right column is given more rows of
 * children than it has room for and they overdraw each other.
 */
const COMPOSER_RULE_HEIGHT = 1;
const COMPOSER_PROMPT_HEIGHT = 1;
const COMPOSER_RULE = '─';
/** The status line is always exactly one row, whichever chrome sits above it. */
const STATUS_LINE_HEIGHT = 1;
/** Composer grows by exactly this many rows while a reply is pending -- see the comment on chromeHeight below. */
const REPLY_PREVIEW_HEIGHT = 1;
/** Composer grows by exactly this many rows while an edit is in progress -- see the comment on chromeHeight below. */
const EDIT_INDICATOR_HEIGHT = 1;
/**
 * M1a drew splits as a single rule rather than a box, following
 * `fillchars = "vert:│"` -- and because boxing each pane separately put a
 * doubled `┐┌` seam where two of them met.
 *
 * M2 boxes them anyway, at the owner's choice, but as ONE shared frame: the
 * column between the panes is a `┬`/`┴` junction that pane-frame.ts draws
 * itself, so it is still exactly one column and the seam cannot come back.
 */
const MINIMUM_PANE_WIDTH = 16;
/**
 * Rows the panes keep whatever an overlay asks for. Below this the frame is a
 * top edge, a sliver and a bottom edge, which reads as the borders having
 * disappeared rather than as a popup being tall.
 */
const MINIMUM_PANE_HEIGHT = 4;
/** The titled rule between the sidebar's folder section and its chat list. */
const SECTION_DIVIDER_HEIGHT = 1;
/**
 * The fewest rows the chat list keeps when the folder section is dragged down
 * over it. One row is a chat -- below that the section is a divider with
 * nothing under it, which is a worse outcome than refusing the last row of the
 * drag.
 */
const MINIMUM_SECTION_HEIGHT = 2;

/**
 * OpenTUI's MouseButton.LEFT. Named rather than compared to a bare 0, and
 * checked by every press handler: until the context menu exists a right click
 * must do nothing at all, and "nothing" is not the same as "whatever left
 * does" -- which is exactly what an unguarded handler would give it.
 */
const MOUSE_BUTTON_LEFT = 0;
/** OpenTUI's MouseButton.RIGHT, which opens the context menu. */
const MOUSE_BUTTON_RIGHT = 2;

/** What one notch of the wheel moves, matching the three lines most terminals send. */
const SCROLL_ROWS_PER_NOTCH = 3;

/** The frame's left border, which the sidebar starts after. */
const FRAME_LEFT_COLUMNS = 1;
/** The frame's top border, which the folder rail starts under. */
const FRAME_TOP_ROWS = 1;
/**
 * Straight to the terminal, past the renderer.
 *
 * A picture is not made of cells and OpenTUI has nowhere to put one, so the
 * graphics sequences go out on their own. `process.stdout.write` is the right
 * call and not a bypass: the renderer only replaces it when it is capturing
 * output for a split footer, which tglow does not use -- and if that ever
 * changed, being captured is a better failure than writing behind its back.
 */
const writeToTerminal = (opts: { text: string }): void => {
  process.stdout.write(opts.text);
};

/** The frame's bottom border, under the panes and above the status line. */
const FRAME_BOTTOM_ROWS = 1;
/** The vertical rule between the sidebar and the conversation. */
const FRAME_DIVIDER_COLUMNS = 1;
/** Telegram counts in seconds; JavaScript counts in milliseconds. */
const MILLISECONDS_PER_SECOND = 1000;
/** The rail beside the conversation, which a picture must not draw over. */
const IMAGE_RAIL_ALLOWANCE = 28;
/**
 * How tall a picture may be, by what it is.
 *
 * A photo is worth looking at, so it gets room. A sticker is an aside -- it
 * stands in for a facial expression -- and one taking a third of the pane
 * pushes the conversation off screen to say something an emoji says in one
 * cell. Small enough to read as punctuation, large enough to tell which
 * sticker it is.
 */
const MAXIMUM_IMAGE_ROWS = 14;
const MAXIMUM_STICKER_ROWS = 6;
const MAXIMUM_STICKER_COLUMNS = 18;

/**
 * One `<text>` per row, the same one-child-one-row rule the panes follow, so a
 * frame column cannot be shrunk into its neighbours.
 *
 * `tee` names the row where a pane's own section divider meets this column, and
 * the glyph to draw there -- `├` on the left edge, `┤` on the right -- which is
 * what makes the divider and the frame read as one continuous rule instead of a
 * rule that stops short at a wall.
 */
const FrameColumn = (props: {
  height: number;
  colour: string;
  tee?: { row: number; glyph: string };
  /** Present only on the divider between the panes, which is the one draggable column. */
  onPress?: () => void;
}) => (
  <box
    flexDirection="column"
    width={1}
    height={props.height}
    flexShrink={0}
    onMouseDown={props.onPress ? () => { props.onPress?.(); } : undefined}
  >
    {Array.from({ length: props.height }, (unused, row) => (
      <text key={row} height={1} flexShrink={0} fg={props.colour}>
        {props.tee?.row === row ? props.tee.glyph : FRAME_VERTICAL}
      </text>
    ))}
  </box>
);

/**
 * The two keys an overlay owns outright while it is open, in the same
 * canonical form the keymap itself is authored in (key-normalizer.ts).
 * <escape> is checked directly here, ahead of engine resolution, so closing
 * an overlay cannot also run whatever <escape> otherwise means in the pane
 * underneath it -- refocusing the messages pane from the chat list, for
 * instance. Shared by both overlays below (which-key and, as of M1b-2
 * Task 8, the chat picker), since closing without side effects is the same
 * requirement either way. The leader is which-key's alone -- it needs no such
 * override, since the engine already resolves it to OVERLAY_TOGGLE, which the
 * reducer toggles closed the same way it toggled open, so it is left to flow
 * through the ordinary path; the chat picker has no equivalent because its
 * own opening key, <C-p>, means something else entirely once it owns input
 * (see CHAT_PICKER_PREVIOUS_TOKENS below).
 */
const OVERLAY_ESCAPE_TOKEN = '<escape>';
const OVERLAY_LEADER_TOKEN = '\\';

/**
 * Enter and Backspace mean the same thing to both the chat picker (M1b-2
 * Task 8) and the search overlay (Task 9) -- commit the typed query,
 * edit it -- so both blocks below share these rather than each declaring an
 * identical pair under its own name.
 */
const ENTER_TOKEN = '<return>';
const BACKSPACE_TOKEN = '<backspace>';
/** Completes a half-typed command, the way vim's own command line does. */
const TAB_TOKEN = '<tab>';

/**
 * The chat picker's own vocabulary while it owns input (M1b-2 Task 8): each
 * pair below is one direction -- `<C-n>`/`j` down, `<C-p>`/`k` up -- echoing
 * vim's own choice of j/k alongside emacs-style C-n/C-p, the same pairing
 * ctrlp.vim and fzf both use. Search (Task 9) has no result list of its own
 * to move a selection through, so it has no equivalent of these two.
 */
/**
 * Everything the chat picker owns, cleared.
 *
 * One constant rather than the same four keys written at each way out of it.
 * The picker closes from three places -- escape, Enter-to-open, and
 * Enter-to-forward -- and adding `chatPickerPurpose` was enough to leave two
 * of them stale, so a cancelled forward left the next <C-p> forwarding
 * instead of opening.
 */
const CLEARED_CHAT_PICKER = {
  chatPickerQuery: '',
  chatPickerCursor: 0,
  chatPickerPurpose: 'open',
  forwardMessageId: null,
} satisfies Partial<IApplicationState>;

const CHAT_PICKER_NEXT_TOKENS: readonly string[] = ['<C-n>', 'j'];
const CHAT_PICKER_PREVIOUS_TOKENS: readonly string[] = ['<C-p>', 'k'];

/**
 * Bounds how many cache rows a single `/` query asks MessageSearchService for.
 *
 * This used to mirror a fixed 200-message window and reason that a match
 * outside it could never be reachable. The conversation pages now, so that is
 * no longer true -- a match older than what is on screen becomes reachable as
 * soon as the pages between are loaded, which is what commitSearch below does
 * before it jumps. The bound is now simply how far back a single search is
 * willing to look, not a statement about what the view can hold.
 */
const SEARCH_RESULT_LIMIT = 500;

/**
 * How many pages a committed search will load to reach its oldest match.
 *
 * Bounded because each page is a round trip: a search whose only match is
 * years back should say so rather than silently spending a minute walking
 * there. Ten pages is well past the fixed window this replaced, so no search
 * that used to land reaches less far now.
 */
const SEARCH_PAGE_BUDGET = 10;

/**
 * How close to the top of the loaded history the cursor gets before the page
 * behind it is fetched.
 *
 * Not zero: a fetch started only once the cursor is already on the oldest
 * loaded message is a fetch the user waits for. A few rows of warning is
 * enough for a page to arrive while they are still reading toward it, and
 * small enough that opening a chat -- which lands on the newest message --
 * never triggers one on a history worth paging.
 */
const OLDER_PREFETCH_ROWS = 5;

const CONTROL_CHARACTER_BOUNDARY = 0x20;
const DELETE_CODE_POINT = 0x7f;

/**
 * True only for a single, unmodified, printable character. Three things a
 * naive check misses:
 *
 * - Tab and linefeed arrive with `ctrl: false` (OpenTUI's parseKeypress
 *   resolves them before the ctrl branch), so `!ctrl` alone does not keep
 *   control characters out of the composer -- the code-point range check is
 *   what actually excludes them.
 * - `sequence.length` counts UTF-16 code units, which splits a non-BMP
 *   character (an emoji) into two, silently failing "exactly one character"
 *   for perfectly ordinary input.
 * - Counting code points instead fixes `😀` and stops there. One *character*,
 *   as a reader means it, is a grapheme: `👍🏽` is two code points, `❤️` is two,
 *   `🇻🇳` is two, a family emoji is seven, and decomposed Vietnamese -- which
 *   plenty of input methods emit -- is three for a single letter. Every one of
 *   those was silently dropped on the way to the composer, so the character
 *   the user typed simply never appeared and nothing said why.
 *
 * Graphemes, then, which is the same unit the renderer measures in
 * (text-width.ts) -- so what can be typed and what can be drawn agree by
 * construction. A pasted word is still many graphemes and still rejected, and
 * so is a bracketed token like "<escape>".
 */
export const isPrintableCharacter = (opts: { sequence: string; ctrl: boolean; meta: boolean }): boolean => {
  const { sequence, ctrl, meta } = opts;
  if (ctrl || meta) {
    return false;
  }

  if (toGraphemes({ text: sequence }).length !== 1) {
    return false;
  }

  // The first code point decides: a control character is one on its own, and
  // no grapheme starts with one and continues into something printable.
  const codePoint = sequence.codePointAt(0) ?? 0;
  return codePoint >= CONTROL_CHARACTER_BOUNDARY && codePoint !== DELETE_CODE_POINT;
};

/**
 * `state.dialogs`, fuzzy-matched against the chat picker's own query and
 * resolved back from fuzzyMatch's `{index, score}` pairs to the dialogs
 * themselves. The one place that mapping happens, shared by the keyboard
 * handler below (to know what Enter/`<C-n>`/`<C-p>` act on) and the render
 * body (to know what ChatPicker draws, and how tall resolveChatPickerHeight
 * says it is) -- so the two can never disagree about what is currently
 * showing.
 */
const resolveChatPickerResults = (opts: { dialogs: IDialogRow[]; query: string }): IDialogRow[] => {
  const { dialogs, query } = opts;
  return fuzzyMatch({ candidates: dialogs.map(dialog => dialog.title), query }).map(match => dialogs[match.index]!);
};

const logger: ILogger = ApplicationLogger.get('App');

/**
 * The send and open-chat callbacks are deliberately fire-and-forget -- a key
 * press must not wait on the network -- but a rejection escaping one of them
 * is an unhandled rejection, which ends the process and takes the alternate
 * screen with it. The services report failure through the store; App only has
 * to stop the rejection escaping and leave a trace behind.
 */
const logRejection = (opts: { method: string; error: unknown }): void => {
  logger.for(opts.method).error('Callback rejected | Reason: %s', opts.error);
};

/**
 * The literal text a dead pending prefix stands for. A canonical token is
 * either one character a human typed or a bracketed key name, and only the
 * former is text -- the same test `isPrintableCharacter` applies to a live
 * press, so a bracketed token ("<escape>") is more than one code point and
 * drops out on its own.
 */
const toFlushedText = (opts: { pending: string[] }): string => {
  return opts.pending
    .filter(token => isPrintableCharacter({ sequence: token, ctrl: false, meta: false }))
    .join('');
};

/**
 * The text to copy to the system clipboard, if `action` just wrote it into
 * the clipboard register (Task 6's `+`) -- null for every other operator,
 * every other register name, and an operator that targeted zero messages
 * (a no-op yank/delete: `actionPatch` then carries no `registers` key at all
 * to read one back out of). Pure: only decides whether a copy is warranted,
 * never performs one -- see the OPERATOR_APPLY case in commitResolution
 * below for the actual write, which is the side effect this stays free of.
 */
const resolveClipboardText = (opts: {
  action: TAction;
  registerName: string;
  actionPatch: Partial<IApplicationState>;
}): string | null => {
  const { action, registerName, actionPatch } = opts;
  if (action.type !== ActionTypes.OPERATOR_APPLY) {
    return null;
  }
  if (action.operator !== Operators.YANK && action.operator !== Operators.DELETE) {
    return null;
  }
  if (registerName !== CLIPBOARD_REGISTER) {
    return null;
  }
  return actionPatch.registers?.[registerName] ?? null;
};

export const App = (props: IAppProps) => {
  const {
    store, engine, keymapService, keyNormalizer, messageSearchService, timeoutMilliseconds, tokens, resolveSenderName,
    onSend, onEdit, onDelete, onPin, onPinChat, onReact, onForward, onSendFile, onThumbnail, onOpenMedia, onLoadOlder, onLogout, onQuit, onOpenChat, onMarkRead,
  } = props;

  // useSyncExternalStore re-subscribes whenever the `subscribe` argument's
  // identity changes; an inline arrow here is a new function every render, so
  // it would tear down and re-register the store listener on every render,
  // not just at mount. Verified empirically: an inline arrow's subscribe()
  // call count climbs by one per post-mount render (1, 2, 3, ...), while this
  // memoized form stays at 1. store.subscribe is itself a stable per-instance
  // arrow-function property, so `store` is the only real dependency.
  const subscribe = useCallback(
    (listener: () => void) => store.subscribe({ listener }),
    [store],
  );
  const state = useSyncExternalStore(subscribe, store.getState, store.getState);
  const { width, height } = useTerminalDimensions();
  // The real renderer in production, and in tests -- @opentui/core/testing's
  // TestRenderer is exactly a CliRenderer, backed by fake stdin/stdout rather
  // than a mock. Read once per render rather than per key press: it is a
  // stable per-instance object either way (useRenderer throws if AppContext
  // has none, which both main.ts and renderWithKeys always provide), so there
  // is nothing to gain from reading it inside useKeyboard's callback instead.
  const renderer = useRenderer();

  // MessageService clears composerText only after its network round-trip
  // resolves, so the composer sits populated with no in-flight indicator for
  // that entire window. A ref, not state: the keyboard handler must see the
  // current value on the very next synchronous key press, the same reason it
  // already reads store.getState() fresh rather than a render's `state`.
  const sendInFlightRef = useRef(false);
  /**
   * What the drag in progress is doing, decided by what was pressed down on
   * rather than by what the pointer is currently over.
   *
   * OpenTUI delivers a drag to the element under the pointer, not to the one
   * the drag started on -- so the divider stopped receiving events the instant
   * the pointer moved off its single column, which is to say immediately.
   * Tracking the mode here and handling the drag at the root is what lets a
   * one-column handle be draggable at all.
   */
  const dragModeRef = useRef<'divider' | 'section' | null>(null);
  /**
   * Whether this terminal will show a real picture, worked out once: it cannot
   * change while tglow is running, and asking per frame would be asking the
   * same question a hundred times a second.
   */
  /**
   * Which protocol this terminal takes, in order of preference.
   *
   * Kitty first where both are offered: it keeps images as addressable
   * placements, so a picture that scrolls is moved for a few dozen bytes,
   * where Sixel has to be redrawn in full. Sixel second, because it reaches a
   * different and much larger set of terminals -- GNOME Terminal and Console
   * through VTE, foot, xterm, Contour. Neither, and the chafa drawing stands.
   */
  const protocol = useMemo((): 'kitty' | 'sixel' | 'none' => {
    if (supportsGraphics({ environment: process.env })) {
      return 'kitty';
    }
    return supportsSixel({ environment: process.env }) ? 'sixel' : 'none';
  }, []);
  const graphicsCapable = protocol !== 'none';
  const cellSize = useMemo(() => resolveCellSize({ environment: process.env }), []);
  /** Images already handed to the terminal, so each is sent once rather than once per frame. */
  const transmittedRef = useRef<Set<number>>(new Set());
  /** Where the pictures currently are, so the per-frame repaint has something to re-place without re-deriving it. */
  const placementsRef = useRef<IImagePlacement[]>([]);
  /**
   * Which placements each column contributed last time, so a column can
   * replace its own without disturbing its neighbours'.
   */
  const paneOwnedRef = useRef<Map<number, Set<number>>>(new Map());
  /** Which pictures the terminal is currently showing, so the ones that scroll away can be taken down. */
  const placedRef = useRef<Set<number>>(new Set());
  /** The decoded pixels, kept only for Sixel -- which has no image the terminal remembers. */
  const pixelsRef = useRef<Map<number, IRgbaImage>>(new Map());
  /**
   * Whether the press being handled right now is the one that opened a menu.
   * Children handle a press before the root does, so without this the root
   * would close a menu the child had just opened.
   */
  const menuOpenedThisPressRef = useRef(false);

  // The pending ambiguous-key timeout, if any. A ref, not state, for the same
  // reason the handler below reads store.getState() fresh rather than a
  // React snapshot: the very next key press -- possibly landing in the same
  // synchronous burst mockInput and a fast typist both produce -- must see
  // the current timer id immediately to cancel it, and a state update is not
  // visible until React commits it.
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * The last mile shared by an immediately resolved key press and a delayed
   * flushPending resolution once the timeout scheduled below fires: fold
   * every action through applyAction, run whichever side effects it
   * triggers, and commit the result to the store. The timer has no key press
   * of its own to re-run through the handler, so this is what lets a
   * delayed resolution -- a short binding that happens to move the cursor
   * onto the newest message, say -- get exactly the same treatment as a live
   * one, rather than a second, divergence-prone copy of the switch below.
   */
  const commitResolution = (opts: {
    current: IApplicationState;
    result: IResolveResult;
    initialPatch?: Partial<IApplicationState>;
  }): void => {
    const { current, result } = opts;
    let patch: Partial<IApplicationState> = { ...opts.initialPatch };

    for (const action of result.actions) {
      // Computed once and read by both the reducer and the side-effect
      // switch below, so a hypothetical binding that both moves a cursor and
      // opens the item under it (e.g. [CURSOR_MOVE, CHAT_OPEN]) reads the
      // post-move position in both places, not the pre-move snapshot.
      const accumulated = { ...current, ...patch };
      const actionPatch = applyAction({ state: accumulated, action });
      patch = { ...patch, ...actionPatch };

      switch (action.type) {
        case ActionTypes.COMPOSER_SEND: {
          // The composer is MessageService's to clear -- send()'s or, while
          // editingMessageId is set, edit()'s -- and it clears only once the
          // round trip has actually resolved. Emptying it here was
          // optimistic in the worst sense: a rejected send left the user with
          // nothing to retry and no copy of what they had written, and it
          // also made the service's "still what I sent?" check permanently
          // false, so its own clear never ran in production.
          //
          // That leaves a window, between dispatch and the round-trip
          // resolving, where the composer still shows the sent text with
          // nothing on screen to say a send is in flight. Without a guard, a
          // second Enter in that window re-dispatches this case with the same
          // non-empty string -- a duplicate send (or duplicate edit), which
          // MessageService's own comment calls unrecoverable. Set before the
          // call and cleared in `finally` so a rejection releases it too;
          // leaving it set on failure would make the composer permanently
          // unable to send. One guard, not one each: send and edit can never
          // both be in flight, since editingMessageId and the composer are
          // the same shared state either path reads before dispatching.
          if (sendInFlightRef.current) {
            break;
          }
          sendInFlightRef.current = true;
          const { editingMessageId, composerText } = accumulated;
          const inFlight = editingMessageId !== null
            ? onEdit({ messageId: editingMessageId, text: composerText })
            : onSend(composerText);
          void inFlight
            .catch(error => {
              logRejection({ method: editingMessageId !== null ? 'onEdit' : 'onSend', error });
            })
            .finally(() => {
              sendInFlightRef.current = false;
            });
          break;
        }
        // Pinning is a side effect App performs, like send and delete, rather
        // than something the reducer can do: it is a network call, and the
        // reducer is pure. It asks nothing first -- pinning is undone by the
        // same key that did it, and the one confirmation in this application
        // exists for the one thing that cannot be taken back.
        case ActionTypes.MEDIA_OPEN: {
          const target = accumulated.messages[accumulated.messageCursor];
          if (!target || accumulated.activePeerId === null) {
            break;
          }
          if (!target.media) {
            store.setState({ patch: { statusMessage: 'Nothing to open on this message' } });
            break;
          }
          void onOpenMedia({ peerId: accumulated.activePeerId, messageId: target.id })
            .catch(error => { logRejection({ method: 'onOpenMedia', error }); });
          break;
        }

        case ActionTypes.PIN_TOGGLE: {
          // One key, two things to pin, told apart by which pane has focus --
          // the same way j and k already mean "next chat" or "next message"
          // depending on where you are. A second binding for chats would be a
          // second thing to remember for one idea.
          if (accumulated.engine.context === VimContexts.CHAT_LIST) {
            const chat = visibleDialogs[accumulated.chatCursor];
            if (chat) {
              void onPinChat({ peerId: chat.peerId }).catch(error => {
                logRejection({ method: 'onPinChat', error });
              });
            }
            break;
          }
          const target = accumulated.messages[accumulated.messageCursor];
          if (target && accumulated.activePeerId !== null) {
            void onPin({ peerId: accumulated.activePeerId, messageId: target.id }).catch(error => {
              logRejection({ method: 'onPin', error });
            });
          }
          break;
        }

        case ActionTypes.CHAT_OPEN: {
          const target = accumulated.dialogs[accumulated.chatCursor];
          if (target) {
            const { peerId } = target;
            // onMarkRead is chained onto onOpenChat's own resolution, not
            // fired alongside it: onOpenChat is what actually loads the
            // chat's messages (MessageService.loadHistory), so only once it
            // resolves does the store hold the newest message to mark --
            // reading store.getState() here, before that lands, would still
            // see whatever chat was open previously.
            void onOpenChat({ peerId })
              .then(() => {
                const { messages } = store.getState();
                const newest = messages[messages.length - 1];
                if (!newest) {
                  return;
                }
                void onMarkRead({ peerId, maxId: newest.id }).catch(error => {
                  logRejection({ method: 'onMarkRead', error });
                });
              })
              .catch(error => {
                logRejection({ method: 'onOpenChat', error });
              });
          }
          break;
        }
        case ActionTypes.CURSOR_MOVE:
        case ActionTypes.CURSOR_EDGE: {
          // The other of the two moments Task 9's brief names markRead for.
          // Gated on unit === 'message' so chat-list movement (unit: 'chat')
          // can never reach this at all -- not suppressed by a debounce or a
          // flag, structurally excluded.
          //
          // The unit alone was not enough. gg, <S-g>, <C-d> and <C-u> are
          // `context: '*'` bindings carrying unit: 'message' (keymap.ts), so
          // they move the *message* cursor while the user is browsing the chat
          // list -- and <S-g> from there acked the open chat on one keystroke,
          // which is precisely the never-auto-read guarantee this pair of
          // conditions exists to keep. Excluding the chat list rather than
          // requiring the messages pane: the message pane is on screen and its
          // cursor is visibly moving in COMPOSER context too (i, then escape,
          // then G), and that is still the user reading their own chat.
          const { activePeerId, messages } = accumulated;
          if (action.unit !== 'message' || !activePeerId) {
            break;
          }
          if (accumulated.engine.context === VimContexts.CHAT_LIST) {
            break;
          }
          const newCursor = patch.messageCursor ?? accumulated.messageCursor;
          const newest = messages[messages.length - 1];
          if (newest && newCursor === messages.length - 1) {
            void onMarkRead({ peerId: activePeerId, maxId: newest.id }).catch(error => {
              logRejection({ method: 'onMarkRead', error });
            });
          }
          break;
        }
        case ActionTypes.APPLICATION_QUIT: {
          onQuit();
          break;
        }
        case ActionTypes.OPERATOR_APPLY: {
          // M1b-2 Task 6: "+y (and "+d -- delete writes a register exactly
          // as yank does, Task 5) copies to the system clipboard. registerName
          // mirrors action-reducer.ts's own OPERATOR_APPLY computation
          // exactly -- the same accumulated.engine.register read, off the
          // same pre-resolution snapshot -- rather than re-deriving it from
          // a source that could drift from what the reducer actually wrote.
          const registerName = accumulated.engine.register ?? UNNAMED_REGISTER;
          const clipboardText = resolveClipboardText({ action, registerName, actionPatch });
          if (clipboardText !== null) {
            writeToClipboard({
              text: clipboardText,
              // OpenTUI's own copyToClipboardOSC52 (@opentui/core) performs
              // its own UTF-8-safe base64 encoding, from plain text, entirely
              // inside the native renderer core -- outside the JS frame loop,
              // which is what makes it safe to call from here (clipboard.ts's
              // own doc comment says why a raw write from anywhere else is
              // not). write's own `sequence` parameter goes unused for
              // exactly that reason: feeding it the already-built OSC 52
              // sequence would base64-encode an already-encoded payload,
              // corrupting the clipboard the same way a mis-encoded write
              // would. buildOsc52Sequence's exact wire format is pinned
              // directly by clipboard.test.ts; production delivery goes
              // through OpenTUI's own implementation instead, reached here
              // with the plain text still in scope through this closure.
              write: () => { renderer.copyToClipboardOSC52(clipboardText); },
            });
          }
          break;
        }
        default: {
          break;
        }
      }
    }

    // pending/count are the engine's alone, always -- result.state is the
    // only place either is ever correctly reset once a binding resolves
    // (vim-engine.ts's applyStateActions), and no reducer case may touch
    // them (MODE_SET/FOCUS_SET's own patches spread state.engine verbatim,
    // carrying over whatever pending/count happened to predate this key,
    // precisely because resetting them is not their job). Trusting a
    // reducer's full patch.engine here previously let a stale pending
    // survive a resolved FOCUS_SET, corrupting the very next key press's
    // token sequence -- caught by "return in the chat list opens the chat"
    // regressing the moment this line first tried `{ ...result.state,
    // ...patch.engine }` wholesale.
    //
    // mode/context are different: usually result.state already agrees with
    // the reducer, since applyStateActions mirrors MODE_SET/FOCUS_SET
    // independently -- but EDIT_START can genuinely disagree, because
    // whether it enters INSERT depends on `out` on the message under the
    // cursor, state engine.resolve() never receives and structurally cannot
    // see (a pure fold over IEngineState alone -- vim-engine.ts's own doc
    // comment). EDIT_START's refusal branch sets no engine key at all, so
    // result.state (unchanged mode/context) still wins then.
    const nextEngineState: IEngineState = patch.engine
      ? { ...result.state, mode: patch.engine.mode, context: patch.engine.context }
      : result.state;
    store.setState({ patch: { ...patch, engine: nextEngineState } });
  };

  /**
   * `/` committed: find the matches, make sure at least one is reachable, and
   * jump to it.
   *
   * A search reads the whole cache; the cursor can only land on a message the
   * view actually holds. While the view held a fixed 200 that was a
   * distinction without a difference, and this was a synchronous function. Now
   * the conversation pages, matches older than the loaded window are common,
   * and reporting "no match" against a window that had simply not been opened
   * far enough would make `/` look broken.
   *
   * So: page back until a match is in range. Nothing is loaded when a match is
   * already there, which is every search that used to work -- their behaviour
   * is unchanged, including the jump landing on the topmost loaded match.
   */
  const commitSearch = async (opts: { query: string }): Promise<void> => {
    const opened = store.getState();
    // A blank query is MessageSearchService's own business rule to refuse
    // (message-search.ts), not App's to re-check -- activePeerId is the one
    // thing only App can see, so that guard stays here.
    if (opened.activePeerId === null) {
      return;
    }
    const peerId = opened.activePeerId;
    const matchIds = messageSearchService
      .search({ peerId, query: opts.query, limit: SEARCH_RESULT_LIMIT })
      .map(row => row.id);

    for (let page = 0; page < SEARCH_PAGE_BUDGET; page += 1) {
      const state = store.getState();
      const reachable = resolveSearchMatchIndices({ messages: state.messages, matchIds }).length > 0;
      // Give up on the chat changing underneath too: paging one conversation
      // toward another's search result would be worse than not jumping.
      if (reachable || state.reachedOldest || state.activePeerId !== peerId) {
        break;
      }
      await onLoadOlder({ peerId });
    }

    const current = store.getState();
    const positions = resolveSearchMatchIndices({ messages: current.messages, matchIds });
    // Mirrors the chat picker's own "Enter with nothing selected does
    // nothing" rule: there is no first match to jump to, which reads as "keep
    // refining the query", not as "give up and close".
    if (positions.length === 0) {
      return;
    }

    store.setState({
      patch: {
        overlay: null,
        searchQuery: '',
        // What n/N (SEARCH_CYCLE, action-reducer.ts) cycle through once this
        // overlay has closed -- ids, not positions, so a message that later
        // moves or is deleted is dropped rather than corrupting the cursor
        // (resolveSearchMatchIndices's own doc comment).
        searchMatchIds: matchIds,
        // The first (topmost, oldest-loaded) match currently on screen --
        // positions is already sorted ascending by resolveSearchMatchIndices.
        messageCursor: positions[0]!,
        searchCursorBeforeOpen: null,
        // `/` can be opened from the chat list (it is context '*', like \ and
        // <C-p>) -- MessageView only highlights the cursor row while focused
        // (message-view.tsx), so without this a jump triggered from there
        // would move messageCursor with nothing on screen to show it moved.
        // Mirrors CHAT_OPEN's own side effect (commitResolution below), which
        // focuses messages for the same reason once it moves the cursor there.
        engine: { ...current.engine, context: VimContexts.MESSAGES },
      },
    });
  };

  /**
   * `:` committed.
   *
   * Every command runs the same thing its key runs -- through commitResolution
   * where an action exists, so a command can no more skip a confirmation than
   * the context menu can. The overlay closes first, so whatever the command
   * does to state cannot be undone by a stale patch landing after it.
   */
  const runCommand = (opts: { input: string }): void => {
    const { spec, argument, lineNumber } = parseCommand({ input: opts.input });
    const current = store.getState();
    const closed: Partial<IApplicationState> = { overlay: null, commandQuery: '' };

    // vim's `:{number}`: jump to that message, 1-based, clamped rather than
    // refused -- `:9999` in a chat of forty means "the end", which is what
    // typing a large number has always meant in vim.
    if (lineNumber !== null) {
      store.setState({
        patch: {
          ...closed,
          messageCursor: Math.max(0, Math.min(lineNumber - 1, current.messages.length - 1)),
          engine: { ...current.engine, context: VimContexts.MESSAGES },
        },
      });
      return;
    }

    if (spec === null) {
      // An empty `:` is a cancelled command, not a mistyped one -- vim says
      // nothing either.
      store.setState({
        patch: {
          ...closed,
          statusMessage: opts.input.trim() === '' ? current.statusMessage : describeUnknown({ input: opts.input }),
        },
      });
      return;
    }

    store.setState({ patch: closed });
    const state = store.getState();

    switch (spec.name) {
      case CommandNames.QUIT: {
        commitResolution({
          current: state,
          result: { state: state.engine, actions: [{ type: ActionTypes.APPLICATION_QUIT }], status: 'resolved' },
        });
        return;
      }
      case CommandNames.HELP: {
        store.setState({
          patch: applyAction({
            state, action: { type: ActionTypes.OVERLAY_TOGGLE, overlay: 'whichkey' },
          }),
        });
        return;
      }
      case CommandNames.READ: {
        const dialog = state.dialogs.find(row => row.peerId === state.activePeerId);
        if (dialog && dialog.topMessageId !== null) {
          void onMarkRead({ peerId: dialog.peerId, maxId: dialog.topMessageId })
            .catch(error => { logRejection({ method: 'onMarkRead', error }); });
        }
        return;
      }
      // Pin and unpin are one action -- PIN_TOGGLE reads the message's current
      // state and does the opposite -- so `:pin` on something already pinned
      // would unpin it, saying one thing and doing another. Each refuses the
      // case it does not mean instead.
      case CommandNames.PIN:
      case CommandNames.UNPIN: {
        const target = state.messages[state.messageCursor];
        const wantPinned = spec.name === CommandNames.PIN;
        if (!target) {
          return;
        }
        if ((target.pinned === 1) === wantPinned) {
          store.setState({
            patch: { statusMessage: wantPinned ? 'Already pinned' : 'Not pinned' },
          });
          return;
        }
        commitResolution({
          current: state,
          result: { state: state.engine, actions: [{ type: ActionTypes.PIN_TOGGLE }], status: 'resolved' },
        });
        return;
      }
      case CommandNames.RELOAD: {
        if (state.activePeerId !== null) {
          void onOpenChat({ peerId: state.activePeerId })
            .catch(error => { logRejection({ method: 'onOpenChat', error }); });
        }
        return;
      }
      case CommandNames.SEND_FILE: {
        if (state.activePeerId === null) {
          return;
        }
        if (argument === '') {
          store.setState({ patch: { statusMessage: 'Usage: :send <path>' } });
          return;
        }
        void onSendFile({ peerId: state.activePeerId, path: argument })
          .catch(error => { logRejection({ method: 'onSendFile', error }); });
        return;
      }
      case CommandNames.OPEN_MEDIA: {
        commitResolution({
          current: state,
          result: { state: state.engine, actions: [{ type: ActionTypes.MEDIA_OPEN }], status: 'resolved' },
        });
        return;
      }
      case CommandNames.LOGOUT: {
        store.setState({
          patch: {
            pendingConfirmation: { kind: 'logout' },
            // Short enough to fit beside the mode block on a narrow terminal.
            // The first wording ran to 64 columns and was truncated at 70,
            // taking its own "(y/n)" with it -- a confirmation that does not
            // say which keys answer it is not a confirmation.
            statusMessage: 'Sign out and erase local data? (y/n)',
          },
        });
        return;
      }
      default: {
        return;
      }
    }
  };

  useKeyboard(event => {
    // Cleared before anything else, on every key press without exception --
    // an ambiguous key's timer must never survive the key that completes the
    // longer binding it was racing, or it fires the shorter binding's own
    // effect *after* the longer one already ran: two effects from one user
    // action, the data-loss shape this task exists to prevent (dd deletes,
    // then a stale d timer runs whatever d alone does). See the 'ambiguous'
    // branch below for where a fresh one gets armed.
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }

    // Read the store directly rather than closing over the render's `state`.
    // mockInput fires keypress events synchronously, and so does a real
    // terminal on a fast paste or a quick typist: several presses can land
    // before React commits a re-render, so a handler built on this render's
    // `state` would have every press after the first recompute from the same
    // pre-burst snapshot. Verified empirically -- with the closed-over
    // snapshot, three synchronous key presses collapse to one character
    // instead of three. The store's own state is updated synchronously on
    // every setState, so reading it fresh here is always current.
    const current = store.getState();
    const key = keyNormalizer.normalize({ event });

    // The only irreversible action in the app gates on this, so it is
    // checked before even the which-key overlay below: while
    // pendingConfirmation is set, only y (confirm) and n (cancel, along with
    // <escape> -- the same "also cancels" role it plays for the overlay and
    // the reply/edit escapes) mean anything, and every other key is
    // swallowed before the engine ever sees it. KeymapService's bindings are
    // static and have no way to see pendingConfirmation, so y and n cannot be
    // expressed as ordinary keymap entries the way dd itself is -- the same
    // reasoning the reply/edit escapes below already rely on. CONFIRM and
    // CANCEL_CONFIRMATION are still real actions run through applyAction,
    // not a hand-rolled patch, so the reducer stays the one place that
    // decides what answering the question does to state.
    // The context menu owns input while it is open, and is checked before the
    // confirmation gate below because a menu can only be open when nothing is
    // pending -- choosing Delete closes it before the question is asked.
    //
    // j/k/Enter/escape rather than mouse-only: M2's governing rule is that
    // nothing becomes reachable only by mouse, and a menu you could not
    // operate from the keyboard would break it in the very feature that
    // introduces the mouse.
    if (current.contextMenu !== null) {
      const menuToken = keyNormalizer.toCanonicalString({ key });
      const openMenu = current.contextMenu;

      if (menuToken === OVERLAY_ESCAPE_TOKEN) {
        closeMenu();
        return;
      }
      if (menuToken === 'j' || menuToken === '<down>') {
        store.setState({
          patch: {
            contextMenu: { ...openMenu, cursor: Math.min(openMenu.cursor + 1, Math.max(0, menuItems.length - 1)) },
          },
        });
        return;
      }
      if (menuToken === 'k' || menuToken === '<up>') {
        store.setState({ patch: { contextMenu: { ...openMenu, cursor: Math.max(0, openMenu.cursor - 1) } } });
        return;
      }
      if (menuToken === '<return>') {
        chooseMenuItem({ index: openMenu.cursor });
        return;
      }
      // Every other key is swallowed. A menu that let keys through to the pane
      // underneath would act on a message while asking about it.
      return;
    }

    if (current.pendingConfirmation !== null) {
      const confirmationToken = keyNormalizer.toCanonicalString({ key });

      let confirmationAction: TAction | null = null;
      if (confirmationToken === 'y') {
        confirmationAction = { type: ActionTypes.CONFIRM };
      } else if (confirmationToken === 'n' || confirmationToken === OVERLAY_ESCAPE_TOKEN) {
        confirmationAction = { type: ActionTypes.CANCEL_CONFIRMATION };
      }
      if (confirmationAction === null) {
        return;
      }

      const confirmed = current.pendingConfirmation;
      store.setState({ patch: applyAction({ state: current, action: confirmationAction }) });
      if (confirmationAction.type !== ActionTypes.CONFIRM) {
        return;
      }
      // Answered yes. Which question was being answered is the confirmation's
      // own to say -- App has exactly one y/n gate and every irreversible
      // action goes through it, so this switch is where they part company.
      switch (confirmed.kind) {
        case 'delete': {
          // One call carrying every id, not a loop of single deletes:
          // Telegram's own deleteMessages takes an array, so a ranged delete
          // is one round trip, one republish and one status message rather
          // than N of each.
          void onDelete({ messageIds: confirmed.messageIds })
            .catch(error => { logRejection({ method: 'onDelete', error }); });
          return;
        }
        case 'logout': {
          void onLogout().catch(error => { logRejection({ method: 'onLogout', error }); });
          return;
        }
        default: {
          return;
        }
      }
    }

    // The chat picker owns every key while it is open, the same guarantee
    // which-key's own block just below makes -- but unlike which-key it has
    // real state of its own to update (chatPickerQuery/chatPickerCursor),
    // not merely a choice between swallowing a key and letting it through,
    // so it gets its own block, checked first.
    // The picker owns every key while it is open, like the command line
    // below. One keystroke sends and closes -- there is no cursor to move and
    // nothing to confirm, because reacting is undone by pressing the same key
    // again.
    if (current.overlay === 'reaction') {
      const reactionToken = keyNormalizer.toCanonicalString({ key });
      if (reactionToken === OVERLAY_ESCAPE_TOKEN) {
        store.setState({ patch: { overlay: null } });
        return;
      }
      const emoji = resolveReactionKey({ key: reactionToken });
      const target = current.messages[current.messageCursor];
      if (emoji !== null && target && current.activePeerId !== null) {
        store.setState({ patch: { overlay: null } });
        void onReact({ peerId: current.activePeerId, messageId: target.id, emoji })
          .catch(error => { logRejection({ method: 'onReact', error }); });
      }
      return;
    }

    // The command line owns every key while it is open, the same guarantee the
    // picker and search make below -- including `:` itself, which is a
    // character to type rather than a second command line to open.
    if (current.overlay === 'command') {
      const commandToken = keyNormalizer.toCanonicalString({ key });

      if (commandToken === OVERLAY_ESCAPE_TOKEN) {
        store.setState({ patch: { overlay: null, commandQuery: '' } });
        return;
      }
      if (commandToken === ENTER_TOKEN) {
        runCommand({ input: current.commandQuery });
        return;
      }
      if (commandToken === BACKSPACE_TOKEN) {
        // Backspacing past the start closes it, as vim does: the `:` is the
        // overlay's own and there is nothing left to be editing without it.
        if (current.commandQuery === '') {
          store.setState({ patch: { overlay: null } });
          return;
        }
        store.setState({ patch: { commandQuery: current.commandQuery.slice(0, -1) } });
        return;
      }
      if (commandToken === TAB_TOKEN) {
        store.setState({ patch: { commandQuery: completeCommand({ input: current.commandQuery }) } });
        return;
      }

      const isCommandPrintable = isPrintableCharacter({ sequence: event.sequence, ctrl: event.ctrl, meta: event.meta });
      if (isCommandPrintable) {
        store.setState({ patch: { commandQuery: current.commandQuery + event.sequence } });
      }
      return;
    }

    if (current.overlay === 'chatpicker') {
      const pickerToken = keyNormalizer.toCanonicalString({ key });

      if (pickerToken === OVERLAY_ESCAPE_TOKEN) {
        store.setState({ patch: { overlay: null, ...CLEARED_CHAT_PICKER } });
        return;
      }

      const results = resolveChatPickerResults({ dialogs: current.dialogs, query: current.chatPickerQuery });

      if (CHAT_PICKER_NEXT_TOKENS.includes(pickerToken)) {
        store.setState({
          patch: { chatPickerCursor: Math.min(current.chatPickerCursor + 1, Math.max(0, results.length - 1)) },
        });
        return;
      }
      if (CHAT_PICKER_PREVIOUS_TOKENS.includes(pickerToken)) {
        store.setState({ patch: { chatPickerCursor: Math.max(current.chatPickerCursor - 1, 0) } });
        return;
      }
      if (pickerToken === ENTER_TOKEN) {
        const selected = results[current.chatPickerCursor];
        if (!selected) {
          return;
        }
        // Same picker, same keys, different outcome. The message is the one
        // the picker was opened on (forwardMessageId), not the one the cursor
        // is on now -- the cursor can still move while an overlay is up.
        if (current.chatPickerPurpose === 'forward') {
          const { forwardMessageId } = current;
          store.setState({
            patch: { overlay: null, ...CLEARED_CHAT_PICKER },
          });
          if (forwardMessageId !== null && current.activePeerId !== null) {
            void onForward({
              fromPeerId: current.activePeerId,
              toPeerId: selected.peerId,
              messageIds: [forwardMessageId],
            }).catch(error => { logRejection({ method: 'onForward', error }); });
          }
          return;
        }
        // Reuses CHAT_OPEN's own side effect (commitResolution's switch case
        // below) rather than duplicating the onOpenChat/onMarkRead chain --
        // chatCursor moves to match the picked chat as part of the same
        // patch, so the chat list's own cursor lands exactly where it would
        // have if the user had instead navigated there with j/k and pressed
        // Enter directly.
        const targetIndex = current.dialogs.findIndex(dialog => dialog.peerId === selected.peerId);
        commitResolution({
          current,
          result: {
            state: current.engine,
            actions: [{ type: ActionTypes.CHAT_OPEN }, { type: ActionTypes.FOCUS_SET, context: VimContexts.MESSAGES }],
            status: 'resolved',
          },
          initialPatch: { chatCursor: targetIndex, overlay: null, ...CLEARED_CHAT_PICKER },
        });
        return;
      }
      if (pickerToken === BACKSPACE_TOKEN) {
        store.setState({ patch: { chatPickerQuery: current.chatPickerQuery.slice(0, -1), chatPickerCursor: 0 } });
        return;
      }

      // Any other key is text for the query, narrowing it, never a keymap
      // binding: a printable 'i' here must not enter insert mode the way it
      // would in the messages pane underneath.
      const isPrintable = isPrintableCharacter({ sequence: event.sequence, ctrl: event.ctrl, meta: event.meta });
      if (isPrintable) {
        store.setState({ patch: { chatPickerQuery: current.chatPickerQuery + event.sequence, chatPickerCursor: 0 } });
      }
      return;
    }

    // The search overlay owns every key while it is open (M1b-2 Task 9), the
    // same guarantee which-key's and the chat picker's own blocks make --
    // checked ahead of which-key's generic block below for the same reason
    // chatpicker's is: it has real state of its own (searchQuery) to update,
    // not merely a choice between swallowing a key and letting it through.
    // This is also what makes n/N (SEARCH_CYCLE, a real keymap binding as of
    // this task) reachable only *after* the overlay has closed -- while it is
    // open, a bare `n` lands here and becomes query text, never the engine.
    if (current.overlay === 'search') {
      const searchToken = keyNormalizer.toCanonicalString({ key });

      if (searchToken === OVERLAY_ESCAPE_TOKEN) {
        store.setState({
          patch: {
            overlay: null,
            searchQuery: '',
            // Clamped defensively: state.messages could have shrunk (a
            // delete elsewhere) since searchCursorBeforeOpen was captured,
            // and an out-of-range messageCursor is not a state this app ever
            // otherwise allows (action-reducer.ts's own clamp helper is what
            // keeps CURSOR_MOVE/CURSOR_EDGE from producing one).
            messageCursor: Math.min(
              current.searchCursorBeforeOpen ?? current.messageCursor,
              Math.max(0, current.messages.length - 1),
            ),
            searchCursorBeforeOpen: null,
          },
        });
        return;
      }

      if (searchToken === ENTER_TOKEN) {
        void commitSearch({ query: current.searchQuery }).catch(error => {
          logRejection({ method: 'commitSearch', error });
        });
        return;
      }

      if (searchToken === BACKSPACE_TOKEN) {
        store.setState({ patch: { searchQuery: current.searchQuery.slice(0, -1) } });
        return;
      }

      // Any other key is text for the query, narrowing it, never a keymap
      // binding: a printable 'i' here must not enter insert mode the way it
      // would in the messages pane underneath -- the same rule the chat
      // picker's own identical block above already applies.
      const isSearchPrintable = isPrintableCharacter({ sequence: event.sequence, ctrl: event.ctrl, meta: event.meta });
      if (isSearchPrintable) {
        store.setState({ patch: { searchQuery: current.searchQuery + event.sequence } });
      }
      return;
    }

    // The which-key overlay owns input while it is open. Everything except
    // the two keys above is swallowed here, before the engine ever sees it,
    // so a stray keystroke cannot move a cursor or seed a pending prefix the
    // engine would still be holding once the overlay closes. In practice this
    // is reached only for 'whichkey' -- 'chatpicker' and 'search' both have
    // their own dedicated blocks above, checked first, which always return
    // before this one is ever reached for either of them.
    if (current.overlay !== null) {
      const overlayToken = keyNormalizer.toCanonicalString({ key });
      if (overlayToken === OVERLAY_ESCAPE_TOKEN) {
        store.setState({ patch: { overlay: null } });
        return;
      }
      if (overlayToken !== OVERLAY_LEADER_TOKEN) {
        return;
      }
    }

    // A pending reply is App-level state (IApplicationState), the same
    // category as overlay above, so escape has to be intercepted here too:
    // KeymapService's bindings are static and have no way to see whether a
    // reply is pending, so there is no way to express "bound only sometimes"
    // as a keymap entry. Checked only in NORMAL mode -- in INSERT, escape
    // still means "leave insert mode" first, exactly as it does today; a
    // second escape once back in NORMAL then cancels the reply. Unreachable
    // while the overlay is open: that block above always returns first.
    if (current.replyToMessageId !== null && current.engine.mode === VimModes.NORMAL) {
      const replyToken = keyNormalizer.toCanonicalString({ key });
      if (replyToken === OVERLAY_ESCAPE_TOKEN) {
        store.setState({ patch: { replyToMessageId: null } });
        return;
      }
    }

    // An in-progress edit is App-level state too, but EDIT_START (unlike
    // REPLY_START) moves straight into INSERT as part of starting -- so this
    // has to be checked in INSERT, not NORMAL, or the very first escape the
    // user presses would fall through to the ordinary INSERT <escape>
    // binding below, which only ever knows to leave insert mode. That escape
    // is the one that must also restore whatever the composer held before
    // EDIT_START overwrote it, or an accidental `e` followed by Escape would
    // look exactly like the discarded-draft class of bug MessageService
    // already exists to prevent on a failed send.
    if (current.editingMessageId !== null && current.engine.mode === VimModes.INSERT) {
      const editToken = keyNormalizer.toCanonicalString({ key });
      if (editToken === OVERLAY_ESCAPE_TOKEN) {
        store.setState({
          patch: {
            editingMessageId: null,
            composerText: current.composerTextBeforeEdit ?? '',
            composerTextBeforeEdit: null,
            engine: { ...current.engine, mode: VimModes.NORMAL },
          },
        });
        return;
      }
    }

    const keymap = keymapService.getBindings();
    let result = engine.resolve({ state: current.engine, key, keymap });

    const isPrintable = isPrintableCharacter({ sequence: event.sequence, ctrl: event.ctrl, meta: event.meta });
    const isInsert = current.engine.mode === VimModes.INSERT;

    // Vim flushes a prefix that turns out to match nothing as literal text,
    // and INSERT here has no other fall-through: `jk` leaves insert mode, so
    // the engine withholds a bare `j` while it waits for the `k`, and
    // discarding it on the key that proves no binding will complete swallowed
    // every j anyone typed -- "enjoy" reached the composer as "enoy".
    //
    // The key that broke the match is then handled as though it had arrived
    // with no prefix. A printable one is simply text: tglow has no
    // `timeoutlen`, so a character withheld a second time would stay
    // invisible until some later press happened to end the sequence. Anything
    // else is re-resolved against a cleared prefix, which is what lets a
    // single Escape leave INSERT after a lone j rather than needing two.
    let flushed = '';
    if (result.status === 'unmapped' && isInsert && current.engine.pending.length > 0) {
      flushed = toFlushedText({ pending: current.engine.pending });
      if (!isPrintable) {
        result = engine.resolve({ state: { ...current.engine, pending: [] }, key, keymap });
      }
    }
    const flushPatch: Partial<IApplicationState> =
      flushed === '' ? {} : { composerText: current.composerText + flushed };

    // In insert mode an unmapped printable key is text, not a missing binding.
    if (result.status === 'unmapped' && isInsert) {
      const typed = flushed + (isPrintable ? event.sequence : '');
      store.setState({
        patch: {
          engine: result.state,
          ...(typed === '' ? {} : { composerText: current.composerText + typed }),
        },
      });
      return;
    }

    if (result.status !== 'resolved') {
      store.setState({ patch: { ...flushPatch, engine: result.state } });

      // vim's timeoutlen: an ambiguous sequence is both a complete binding
      // and the start of a longer one, so App waits to see whether a
      // completing key beats the clock before giving up and letting
      // flushPending resolve the shorter binding on its own. `result.state`
      // is captured here, in the timer's closure, rather than re-read from
      // the store when it fires -- the clear at the very top of this handler
      // guarantees no other key press can land before that happens, so it is
      // never stale by the time it does.
      if (result.status === 'ambiguous') {
        const ambiguousEngineState = result.state;
        timeoutRef.current = setTimeout(() => {
          timeoutRef.current = null;
          const flushedResult = engine.flushPending({ state: ambiguousEngineState, keymap });
          commitResolution({ current, result: flushedResult });
        }, timeoutMilliseconds);
      }
      return;
    }

    commitResolution({ current, result, initialPatch: flushPatch });
  });

  // A timer that outlives the component would fire into a torn-down tree --
  // App unmounts when main.ts's quit() tears down the renderer, or a test's
  // renderer.destroy() does -- and nothing else on that path clears this one.
  useEffect(() => {
    return () => {
      if (timeoutRef.current !== null) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  // Reaching the top of the loaded history loads the page before it.
  //
  // An effect on the cursor rather than a case in commitResolution's switch,
  // because there is no one action that means "scrolled up": k, 3k, gg, <C-u>,
  // a wheel notch and a search jump all move the cursor, and scrollBy does not
  // even go through commitResolution. Watching where the cursor ended up
  // catches every route, including ones added later.
  //
  // The guards all live in MessageService.loadOlder -- already loading, no
  // more to load, wrong chat -- so this stays a statement of when to ask
  // rather than a second copy of when not to.
  useEffect(() => {
    if (state.activePeerId === null || state.messageCursor > OLDER_PREFETCH_ROWS) {
      return;
    }
    void onLoadOlder({ peerId: state.activePeerId }).catch(error => {
      logRejection({ method: 'onLoadOlder', error });
    });
  }, [state.activePeerId, state.messageCursor, state.messages.length]);

  const activeDialog = state.dialogs.find(dialog => dialog.peerId === state.activePeerId);
  const isConfirming = state.pendingConfirmation !== null;
  // Four claims on one row, most urgent first. The confirmation prompt wins
  // outright: it is the only thing the user is obliged to answer, and a
  // swallowed y/n question is worse than a delayed warning. integrityWarning
  // then outranks statusMessage rather than falling back to it, because
  // statusMessage carries things like "No link in this message" that nothing
  // ever clears -- a warning that ranked below those would be one keystroke
  // away from being hidden for the rest of the session, which is the bug this
  // field exists to fix, in a new shape.
  const isWarning = !isConfirming && state.integrityWarning !== null;
  const statusTitle = (isConfirming ? state.statusMessage : null)
    ?? state.integrityWarning
    ?? state.statusMessage
    ?? activeDialog?.title
    ?? 'no chat';
  // Found rather than assumed: REPLY_START can only ever target a message
  // still in state.messages (Task 6's action-reducer.ts reads it straight off
  // state.messages[state.messageCursor]), but resolving it here rather than
  // trusting that invariant means a target that later fell out of the loaded
  // window degrades to no preview instead of a crash.
  const replyTargetMessage = state.replyToMessageId === null
    ? null
    : state.messages.find(message => message.id === state.replyToMessageId) ?? null;
  const replyingTo = replyTargetMessage
    ? { senderName: resolveSenderName({ fromId: replyTargetMessage.fromId }), text: replyTargetMessage.text }
    : null;
  // describe() is cheap (a filter + map over a couple dozen bindings at
  // most) and pure, so it costs nothing to compute unconditionally rather
  // than branching on whether the overlay is actually open.
  const whichKeyBindings = keymapService.describe({ mode: state.engine.mode, context: state.engine.context });
  const isWhichKeyOpen = state.overlay === 'whichkey';
  const isChatPickerOpen = state.overlay === 'chatpicker';
  const isSearchOpen = state.overlay === 'search';
  // Unlike whichKeyBindings above, computed only while actually open:
  // state.dialogs can run into the hundreds, and fuzzy-matching all of them
  // on every render -- most of which have nothing to do with the picker --
  // would be wasted work the which-key case, filtering barely thirty
  // bindings, does not have to worry about.
  const chatPickerResults = isChatPickerOpen
    ? resolveChatPickerResults({ dialogs: state.dialogs, query: state.chatPickerQuery })
    : [];
  const isEditing = state.editingMessageId !== null;
  // The overlay replaces the composer and grows upward, so the panes above
  // it must shrink by however many rows it actually renders -- Math.max(1, …)
  // keeps at least one row for them even if a future binding table were long
  // enough to ask for more than the terminal has. Composer grows by one row
  // for each of REPLY_PREVIEW_HEIGHT ("Replying to…") and EDIT_INDICATOR_HEIGHT
  // ("Editing message") it actually renders -- driven by these same
  // `replyingTo`/`isEditing` values, so chromeHeight can never disagree with
  // Composer about which of its rows are on screen. Skipping both while the
  // overlay is open is correct, not an oversight: Composer is not rendered at
  // all then.
  //
  // SearchOverlay (M1b-2 Task 9) gets its own branch ahead of the plain
  // Composer fallback, the same way ChatPicker/WhichKey do -- but unlike
  // either of those two, its own row count (SEARCH_OVERLAY_HEIGHT) is a
  // constant, not something to compute from state first, since it never
  // grows a results list of its own.
  // Below the frame there is now only the status line, plus whichever overlay
  // is open. The composer moved inside the right pane, so it no longer takes
  // rows from here -- it takes them from the message view instead, further
  // down. An overlay still replaces it outright: Composer is not rendered at
  // all while one is open.
  const isOverlayOpen = isChatPickerOpen || isWhichKeyOpen || isSearchOpen;
  const requestedChromeHeight = isChatPickerOpen
    ? resolveChatPickerHeight({ resultCount: chatPickerResults.length }) + STATUS_LINE_HEIGHT
    : isWhichKeyOpen
      ? resolveWhichKeyHeight({ bindingCount: whichKeyBindings.length, width }) + STATUS_LINE_HEIGHT
      : isSearchOpen
        ? SEARCH_OVERLAY_HEIGHT + STATUS_LINE_HEIGHT
        : STATUS_LINE_HEIGHT;
  // An overlay takes what it asks for, but never so much that the panes above
  // collapse. which-key grows with the number of bindings, and on a short
  // terminal it asked for nearly the whole window -- leaving the frame as a
  // top edge, one row, and a bottom edge, which reads as the conversation
  // having lost its borders rather than as a popup being large. Reported as
  // exactly that: "sometimes the conversation pane has no vertical line".
  //
  // Capped rather than scrolled: an overlay that has to be scrolled to be read
  // is worse than one showing a little less, and every overlay here is a list
  // whose tail the user can reach another way.
  const chromeHeight = Math.min(
    requestedChromeHeight,
    Math.max(STATUS_LINE_HEIGHT, height - FRAME_VERTICAL_COST - MINIMUM_PANE_HEIGHT),
  );
  // The frame's two edge rows come out of the pane height, and its three
  // columns out of the pane widths. Getting either wrong is how a wrapped line
  // ends up drawn over its own border -- M1a's interleaved-text report in a
  // new place, which is why pane-frame.ts owns the arithmetic and is tested on
  // its own.
  const paneHeight = Math.max(1, height - chromeHeight - FRAME_VERTICAL_COST);
  // The composer's own rows, now taken out of the right pane rather than out
  // of the window. Its rule counts too, and this must stay in lockstep with
  // what Composer actually renders -- the same invariant its own doc comment
  // has always carried, just measured against a different container.
  const composerHeight = isOverlayOpen
    ? 0
    : COMPOSER_RULE_HEIGHT + COMPOSER_PROMPT_HEIGHT
      + (replyingTo !== null ? REPLY_PREVIEW_HEIGHT : 0)
      + (isEditing ? EDIT_INDICATOR_HEIGHT : 0);
  const messageHeight = Math.max(1, paneHeight - composerHeight);
  // The rail is shown only when the account actually has folders. A rail
  // holding nothing but the synthetic "All" is a column of wasted width, and
  // the graphical clients hide it for the same reason.
  const hasFolders = state.folders.length > 1;
  const activeFolder = state.folders.find(folder => folder.id === state.activeFolderId)
    ?? state.folders[0]
    ?? null;
  // The chat list shows the active folder's members, not every dialog. Falls
  // back to the unfiltered list when no folder resolves at all, so a folder id
  // left over from a folder the user has since deleted shows their chats rather
  // than an empty sidebar.
  const visibleDialogs = activeFolder === null
    ? state.dialogs
    : resolveFolderMembership({ folder: activeFolder, dialogs: state.dialogs, peerKinds: state.peerKinds });
  // Each folder's own unread total, for the badge beside its name. Computed
  // over every dialog rather than the visible ones -- the point of the badge is
  // to tell you about the folders you are NOT looking at.
  const unreadByFolder = new Map(state.folders.map(folder => [
    folder.id,
    resolveFolderMembership({ folder, dialogs: state.dialogs, peerKinds: state.peerKinds })
      .reduce((total, dialog) => total + dialog.unreadCount, 0),
  ]));
  const paneWidths = resolvePaneWidths({
    width,
    sidebarWidth: state.sidebarWidth ?? SIDEBAR_WIDTH,
    minimumPane: MINIMUM_PANE_WIDTH,
  });

  const paneGrid = withActive({ grid: state.paneGrid, active: state.activePane, conversation: state });
  // Each internal divider costs a column, exactly like the ones either side of
  // the sidebar, so the columns share what is left rather than what was asked
  // for -- otherwise the rightmost is pushed a column off the screen per split.
  const conversationWidths = shareEvenly({
    total: Math.max(0, paneWidths.messages - (paneGrid.length - 1) * FRAME_VERTICAL_COST),
    count: paneGrid.length,
  });
  // The folder section takes what its folders need, capped so the chat list
  // always keeps the larger half: folders are how you reach chats, not a thing
  // to look at on their own. Zero hides it, divider included.
  //
  // A dragged height wins over both, clamped the same way the sidebar's own
  // width is: the user asking for more folder rows than the pane has must
  // leave the chat list something, and a drag to the very top must not leave
  // the folders a section with no rows in it and a divider still drawn.
  const automaticFolderHeight = Math.min(state.folders.length, Math.floor(paneHeight / 2) - SECTION_DIVIDER_HEIGHT);
  const folderSectionHeight = hasFolders
    ? Math.max(0, Math.min(
      state.folderHeight ?? automaticFolderHeight,
      paneHeight - SECTION_DIVIDER_HEIGHT - MINIMUM_SECTION_HEIGHT,
    ))
    : 0;
  const chatListHeight = Math.max(
    1,
    paneHeight - (folderSectionHeight > 0 ? folderSectionHeight + SECTION_DIVIDER_HEIGHT : 0),
  );
  /** Where the sidebar's own divider meets a frame column, or nothing when there is no divider. */
  const sectionTee = (glyph: string): { row: number; glyph: string } | undefined =>
    (folderSectionHeight > 0 ? { row: folderSectionHeight, glyph } : undefined);

  // ── the mouse ──────────────────────────────────────────────────────────
  //
  // Every handler below dispatches the action its keyboard equivalent already
  // dispatches, rather than patching state directly. That is what keeps the
  // mouse an alternative route rather than a second, divergence-prone
  // implementation -- and it is why clicking delete would still ask y/n, the
  // same way `dd` does.
  //
  // A click also focuses the pane it landed in, exactly as clicking into a
  // window does in vim: acting on a pane you are not in would be the surprise.

  const pressChat = (opts: { index: number; button: number; x?: number; y?: number }): void => {
    if (opts.button === MOUSE_BUTTON_RIGHT) {
      // The cursor moves to the chat the menu is about, exactly as the message
      // menu already does and for the same reason: acting on one row while the
      // cursorline sits on another is the surprise. Pin is what made this
      // matter -- it reads the cursor, so without this it pinned whichever
      // chat the keyboard had last been on.
      const current = store.getState();
      menuOpenedThisPressRef.current = true;
      store.setState({
        patch: {
          chatCursor: Math.max(0, Math.min(opts.index, current.dialogs.length - 1)),
          contextMenu: { kind: 'chat', target: opts.index, x: opts.x ?? 0, y: opts.y ?? 0, cursor: 0 },
        },
      });
      return;
    }
    if (opts.button !== MOUSE_BUTTON_LEFT) {
      return;
    }
    const current = store.getState();
    // The index the pane reports is into the *filtered* list it was given, so
    // it is resolved back to a peer here rather than trusted as a chat cursor.
    const dialog = visibleDialogs[opts.index];
    if (!dialog) {
      return;
    }
    store.setState({
      patch: {
        engine: { ...current.engine, context: VimContexts.CHAT_LIST },
        chatCursor: opts.index,
      },
    });
    // Opening is what Enter does from the chat list, so a click does it too:
    // a click that only moved a cursor would need a second click to mean
    // anything, which is not what clicking a chat means anywhere else.
    void onOpenChat({ peerId: dialog.peerId }).catch(error => {
      logRejection({ method: 'onOpenChat', error });
    });
  };

  const pressMessage = (opts: { index: number; button: number; x?: number; y?: number }): void => {
    if (opts.button === MOUSE_BUTTON_RIGHT) {
      // The menu acts on the message it was opened over, so the cursor moves
      // there too -- otherwise choosing Delete would ask about one message
      // while the cursorline sat on another.
      const current = store.getState();
      menuOpenedThisPressRef.current = true;
      store.setState({
        patch: {
          messageCursor: Math.max(0, Math.min(opts.index, current.messages.length - 1)),
          contextMenu: { kind: 'message', target: opts.index, x: opts.x ?? 0, y: opts.y ?? 0, cursor: 0 },
        },
      });
      return;
    }
    if (opts.button !== MOUSE_BUTTON_LEFT) {
      return;
    }
    const current = store.getState();
    store.setState({
      patch: {
        engine: { ...current.engine, context: VimContexts.MESSAGES },
        messageCursor: Math.max(0, Math.min(opts.index, current.messages.length - 1)),
      },
    });
  };

  /**
   * The wheel, over either pane.
   *
   * It moves the cursor, and the viewport follows it -- the viewport is
   * derived from the cursor, and always has been. That is also what vim does
   * once you scroll far enough to push the cursor out of the window, and it is
   * what Telegram does: scrolling to the newest message marks it read, because
   * you have genuinely seen it. The rule that reading is an explicit act is
   * about the chat *list* -- never marking a chat read because the cursor
   * passed over it -- and that still holds, since a wheel over the sidebar
   * moves through chats without opening any.
   */
  const scrollBy = (opts: { unit: 'message' | 'chat'; delta: number }): void => {
    const current = store.getState();
    store.setState({
      patch: applyAction({
        state: current,
        action: { type: ActionTypes.CURSOR_MOVE, unit: opts.unit, delta: opts.delta * SCROLL_ROWS_PER_NOTCH },
      }),
    });
  };

  /**
   * Dragging the divider between the panes.
   *
   * `x` is the pointer's column in the window, and the sidebar starts one
   * column in -- past the frame's left border -- so the width it implies is
   * `x - 1`. Nothing is clamped here: resolvePaneWidths already refuses to let
   * either pane vanish, and doing it twice would mean two places to disagree
   * about the minimum.
   */
  const dragDivider = (opts: { x: number }): void => {
    store.setState({ patch: { sidebarWidth: Math.max(0, opts.x - FRAME_LEFT_COLUMNS) } });
  };

  /** The one column the divider occupies: past the frame's left border and the sidebar. */
  const dividerColumn = FRAME_LEFT_COLUMNS + paneWidths.sidebar;

  /**
   * Hand the terminal the real pictures, where it can take them.
   *
   * Written straight to stdout rather than through the renderer, because a
   * picture is not made of cells and OpenTUI has nowhere to put one. The cells
   * underneath still carry the chafa drawing: a terminal that ignores these
   * sequences shows that instead, and one that honours them composites the
   * photograph over the top.
   *
   * Placed after every frame, not once. The renderer redraws cells and has no
   * reason to preserve something it does not know about, so the placement is
   * re-sent -- which costs a few dozen bytes, unlike the image.
   */
  const placeImages = useCallback((opts: {
    column: number;
    widths: number[];
    keyFor: (messageId: number) => string;
    placements: IImageRowPlacement[];
  }): void => {
    if (!graphicsCapable) {
      return;
    }
    // The pane's own left edge, not the first column's. Measuring every
    // placement from the first column is how a right-hand pane's photographs
    // were drawn on top of the left-hand pane's.
    const paneLeft = resolvePaneOrigin({
      conversationLeft: dividerColumn + FRAME_DIVIDER_COLUMNS,
      widths: opts.widths,
      column: opts.column,
      dividerColumns: FRAME_DIVIDER_COLUMNS,
    });
    const mine = opts.placements.map(placement => ({
      id: toTerminalImageId({ key: opts.keyFor(placement.messageId) }),
      // One-based, which is what a cursor position is.
      row: FRAME_TOP_ROWS + placement.paneRow + 1,
      column: paneLeft + placement.paneColumn + 1,
      columns: placement.columns,
      rows: placement.rows,
    }));
    // Joined to the other panes' rather than replacing them. Every pane calls
    // this during the same render, so an assignment left only whichever pane
    // happened to run last with any pictures at all.
    placementsRef.current = [
      ...placementsRef.current.filter(placement => !paneOwnedRef.current.get(opts.column)?.has(placement.id)),
      ...mine,
    ];
    paneOwnedRef.current.set(opts.column, new Set(mine.map(placement => placement.id)));
  }, [graphicsCapable, dividerColumn]);

  /**
   * Put the pictures back, every frame.
   *
   * Not once per render, which is what this did at first and why nothing
   * appeared: React re-renders when state changes, and the renderer repaints
   * many times between those. A placement made during one render is gone by
   * the time anything looks at the screen, and nothing puts it back until the
   * user happens to press a key.
   *
   * Re-placing is cheap -- a few dozen bytes naming an image the terminal
   * already holds -- which is exactly why transmitting and placing are
   * separate calls.
   */
  // The reducer decides whether a split fits, and it has no terminal to
  // measure -- so the measurement is published to it here. Written only when
  // it actually changes: this runs on every resize, and a setState per frame
  // would be a re-render per frame.
  useEffect(() => {
    if (state.conversationWidth !== paneWidths.messages || state.conversationHeight !== paneHeight) {
      store.setState({ patch: { conversationWidth: paneWidths.messages, conversationHeight: paneHeight } });
    }
  }, [store, state.conversationWidth, state.conversationHeight, paneWidths.messages, paneHeight]);

  useEffect(() => {
    if (!graphicsCapable) {
      return;
    }
    const repaint = (): void => {
      const current = placementsRef.current;

      // Sixel: no placements to move or delete, so every visible picture is
      // simply drawn again where it now belongs. More bytes than kitty's
      // few-dozen re-place, and the reason kitty is preferred where both are
      // on offer.
      if (protocol === 'sixel') {
        const drawings = current
          .map(placement => {
            const image = pixelsRef.current.get(placement.id);
            return image === undefined ? '' : drawImage({
              image,
              row: placement.row,
              column: placement.column,
              columns: placement.columns,
              rows: placement.rows,
              cell: cellSize,
            });
          })
          .filter(drawing => drawing !== '');
        if (drawings.length > 0) {
          writeToTerminal({ text: drawings.join('') });
        }
        return;
      }

      const showing = new Set(current.map(placement => placement.id));

      // Anything that has scrolled out is taken off the screen. Re-placing
      // alone is not enough: a picture whose message has scrolled away has no
      // placement to replace, so it simply stayed where it was -- which is
      // what left old stickers smeared down the pane.
      const stale = [...placedRef.current].filter(id => !showing.has(id));
      const sequences = [
        ...stale.map(id => forget({ id })),
        ...current.map(placement => place({ placement })),
      ];
      for (const id of stale) {
        placedRef.current.delete(id);
        // Forgotten entirely, so the next time it is on screen it is sent
        // again: kitty frees the pixels with the placement, and placing an
        // image it no longer holds draws nothing.
        transmittedRef.current.delete(id);
      }
      for (const id of showing) {
        placedRef.current.add(id);
      }

      if (sequences.length > 0) {
        writeToTerminal({ text: sequences.join('') });
      }
    };
    renderer.addPostProcessFn(repaint);
    return (): void => { renderer.removePostProcessFn(repaint); };
  }, [protocol, graphicsCapable, renderer, cellSize]);


  // Pictures for whatever is on screen.
  //
  // Driven off the loaded messages rather than the visible slice: working out
  // which rows are visible needs the rows, which needs the pictures, which is
  // the circle this avoids. A window is fifty messages and the fetch is
  // remembered on disk, so the cost is one pass the first time and nothing
  // after.
  //
  // Re-run on width because the size in cells depends on the pane; the bytes
  // come back off disk, so a resize costs a redraw rather than a download.
  useEffect(() => {
    // Photos and stickers. A sticker's *document* is often an animation tglow
    // cannot draw, but the still in its `thumbs` is an ordinary image -- so
    // what gets drawn is one frame of it, which is what a sticker looks like
    // anywhere it is not moving.
    // Every pane, not just the focused one -- and each at its own width. Both
    // of those were wrong before: a split pane showed no pictures at all, and
    // the ones that did appear were sized to the whole conversation area,
    // which is roughly twice the width of a pane once the screen is split.
    const requests = planImageFetches({
      grid: paneGrid,
      widths: conversationWidths,
      drawableOf: pane => pane.messages
        .filter(message => message.media?.kind === MediaKinds.PHOTO || message.media?.kind === MediaKinds.STICKER)
        .map(message => ({ id: message.id, sticker: message.media?.kind === MediaKinds.STICKER })),
    }).filter(request => !state.imagesByKey.has(request.key));
    if (requests.length === 0) {
      return;
    }

    let live = true;
    void (async (): Promise<void> => {
      for (const request of requests) {
        const bytes = await onThumbnail({ peerId: request.peerId, messageId: request.messageId });
        if (!live || bytes === null) {
          continue;
        }

        const rendered = await renderImage({
          bytes,
          maximumColumns: request.maximumColumns,
          maximumRows: request.maximumRows,
        });
        // Checked again after the await: the pane this was for may be gone.
        // Keyed by width, a picture that arrives late is simply stored -- it
        // cannot land in the wrong pane the way an id-keyed one could.
        if (!live || rendered === null) {
          continue;
        }
        // The picture itself, for a terminal that can hold one. Transmitted
        // under the cache key rather than the message id: the same photograph
        // at two pane widths is two different images to the terminal, and
        // giving both the message's id made the second overwrite the first.
        const terminalId = toTerminalImageId({ key: request.key });
        if (protocol === 'kitty' && !transmittedRef.current.has(terminalId)) {
          transmittedRef.current.add(terminalId);
          writeToTerminal({ text: transmit({ id: terminalId, pixels: rendered.pixels }) });
        }
        // Sixel has no notion of an image the terminal holds: the pixels go
        // out with every draw, so they are kept here to draw from.
        if (protocol === 'sixel') {
          pixelsRef.current.set(terminalId, rendered.pixels);
        }

        const next = new Map(store.getState().imagesByKey);
        next.set(request.key, rendered.cells);
        store.setState({ patch: { imagesByKey: next } });
      }
    })();

    return (): void => {
      live = false;
    };
    // conversationWidths is derived from paneGrid and the terminal width, so
    // its identity changes every render -- joined into a string so a resize or
    // a split re-runs this and a plain repaint does not.
  }, [paneGrid, conversationWidths.join(','), state.imagesByKey]);


  // The terminal's own cursor, parked on the composer's caret while typing.
  //
  // Reported by the user: a Vietnamese IME drew its half-typed word over the
  // status line, and it only appeared in the composer once committed. An IME
  // renders its composition at the *terminal* cursor, outside the application
  // entirely -- so with the cursor hidden and left wherever the last write
  // put it, the preedit had nowhere sensible to go. Nothing tglow draws
  // changes; what changes is where the terminal thinks the caret is.
  //
  // Only in insert mode: a visible block sitting in the conversation in normal
  // mode would compete with the cursorline, which is what shows position
  // there.
  useEffect(() => {
    const typing = state.engine.mode === VimModes.INSERT;
    if (!typing) {
      renderer.setCursorPosition(0, 0, false);
      return;
    }
    // The prompt row: the frame's bottom border and the status line sit under
    // it, and the composer's own extra rows (a pending reply, an edit) push it
    // no further because they are drawn above the prompt, not below it.
    const caretRow = height - STATUS_LINE_HEIGHT - FRAME_BOTTOM_ROWS - 1;
    const promptStart = dividerColumn + FRAME_DIVIDER_COLUMNS + COMPOSER_PROMPT_WIDTH;
    // What the composer actually shows: it keeps the tail of a line too long
    // for the pane, so the caret is at the end of what is visible rather than
    // at the end of the text.
    const room = Math.max(0, paneWidths.messages - COMPOSER_PROMPT_WIDTH - 1);
    const typed = Math.min(measureTextWidth({ text: state.composerText }), room);
    // One-based, which is what setCursorPosition takes -- OpenTUI's own
    // editor adds the same +1 to its screen coordinates before calling it
    // (renderCursor, @opentui/core). Passing zero-based put the caret a row
    // above the composer, which is exactly where the IME would then have
    // drawn.
    renderer.setCursorPosition(promptStart + typed + 1, caretRow + 1, true);
  }, [
    state.engine.mode, state.composerText, height, paneWidths.sidebar, paneWidths.messages, renderer,
  ]);


  const menuItems = state.contextMenu === null
    ? []
    : state.contextMenu.kind === 'message'
      ? buildMessageMenu({ message: state.messages[state.contextMenu.target] })
      : buildChatMenu({ dialog: visibleDialogs[state.contextMenu.target] });

  const closeMenu = (): void => {
    store.setState({ patch: { contextMenu: null } });
  };

  /**
   * Running a menu item.
   *
   * Each dispatches exactly what its key dispatches -- the menu is another way
   * to reach an action, never a second implementation. Delete goes through
   * DELETE_REQUEST, so it still asks y/n: a menu must not become the one route
   * that skips the only confirmation in the app.
   */
  const chooseMenuItem = (opts: { index: number }): void => {
    const menu = state.contextMenu;
    const item = menuItems[opts.index];
    if (menu === null || !item) {
      return;
    }

    // Closed first, so whatever the action does to state cannot be undone by a
    // stale menu patch landing after it.
    closeMenu();
    const current = store.getState();

    switch (item.action) {
      case MenuActions.REPLY: {
        store.setState({ patch: applyAction({ state: current, action: { type: ActionTypes.REPLY_START } }) });
        return;
      }
      case MenuActions.EDIT: {
        store.setState({ patch: applyAction({ state: current, action: { type: ActionTypes.EDIT_START } }) });
        return;
      }
      case MenuActions.DELETE: {
        store.setState({ patch: applyAction({ state: current, action: { type: ActionTypes.DELETE_REQUEST } }) });
        return;
      }
      case MenuActions.YANK: {
        store.setState({
          patch: applyAction({
            state: current,
            action: {
              type: ActionTypes.OPERATOR_APPLY,
              operator: Operators.YANK, unit: 'message', from: 0, to: 0, register: null,
            },
          }),
        });
        return;
      }
      // Through commitResolution rather than applyAction, unlike its
      // neighbours here: pinning is the one menu item whose action carries a
      // side effect, and applyAction alone would move the state and never
      // make the call. `P` reaches the same case by the same route.
      case MenuActions.PIN: {
        // PIN_TOGGLE reads the focused pane to decide what it is pinning, and
        // a menu is opened by pointing at something rather than by focusing
        // it -- so the context is set from which menu this is, not from where
        // the keyboard happened to be.
        const context = menu.kind === 'chat' ? VimContexts.CHAT_LIST : VimContexts.MESSAGES;
        commitResolution({
          current: { ...current, engine: { ...current.engine, context } },
          result: {
            state: { ...current.engine, context },
            actions: [{ type: ActionTypes.PIN_TOGGLE }],
            status: 'resolved',
          },
        });
        return;
      }
      case MenuActions.COPY_LINK: {
        store.setState({ patch: applyAction({ state: current, action: { type: ActionTypes.LINK_SHOW } }) });
        return;
      }
      case MenuActions.OPEN: {
        const dialog = visibleDialogs[menu.target];
        if (dialog) {
          void onOpenChat({ peerId: dialog.peerId }).catch(error => {
            logRejection({ method: 'onOpenChat', error });
          });
        }
        return;
      }
      case MenuActions.MARK_READ: {
        const dialog = visibleDialogs[menu.target];
        if (dialog && dialog.topMessageId !== null) {
          void onMarkRead({ peerId: dialog.peerId, maxId: dialog.topMessageId }).catch(error => {
            logRejection({ method: 'onMarkRead', error });
          });
        }
        return;
      }
      default: {
        return;
      }
    }
  };

  /**
   * What a press begins, decided from where it landed rather than from which
   * element claimed it.
   *
   * Deciding by coordinate rather than by a handler on the divider itself is
   * deliberate. OpenTUI delivers a drag to whatever is under the pointer, so a
   * one-column handle loses the drag on the first movement -- and relying on
   * that column to receive even the initial press made the whole gesture
   * depend on hit-testing a single cell, which it did not survive. The column
   * is known here exactly, so this needs no hit-testing at all.
   */
  const beginDrag = (opts: { x: number; y: number; button: number }): void => {
    // Clicking away closes the menu, which is what every menu does and what
    // this one failed to do -- only escape and choosing an item closed it.
    //
    // Guarded on a menu opened by *this* press: children handle the press
    // before the root does, so a right click has already opened its menu by
    // the time this runs, and closing unconditionally would shut it again
    // before it was ever drawn. Choosing an item closes it via its own
    // handler, so this only ever has to catch a press that landed elsewhere.
    if (menuOpenedThisPressRef.current) {
      menuOpenedThisPressRef.current = false;
    } else if (store.getState().contextMenu !== null) {
      closeMenu();
    }

    if (opts.button !== MOUSE_BUTTON_LEFT) {
      return;
    }
    // Only the divider. A drag anywhere else does nothing: dragging the
    // conversation to scroll it was built and then removed at the owner's
    // request, and the wheel covers the same ground without competing with the
    // terminal's own click-and-drag.
    // Two dividers, told apart by where the press landed. The vertical one
    // runs the full height at a known column; the horizontal one runs across
    // the sidebar at a known row, so both are decided by coordinate rather
    // than by hit-testing a one-cell target the drag would then lose.
    if (opts.x === dividerColumn) {
      dragModeRef.current = 'divider';
      return;
    }
    const onSectionDivider = folderSectionHeight > 0
      && opts.y === FRAME_TOP_ROWS + folderSectionHeight
      && opts.x > 0 && opts.x < dividerColumn;
    dragModeRef.current = onSectionDivider ? 'section' : null;
  };

  /** Every drag, routed by what it started on rather than what it is over. */
  const dragAnywhere = (opts: { x: number; y: number }): void => {
    if (dragModeRef.current === 'divider') {
      dragDivider({ x: opts.x });
      return;
    }
    if (dragModeRef.current === 'section') {
      dragSection({ y: opts.y });
    }
  };

  /**
   * Dragging the divider between the folders and the chat list.
   *
   * `y` is the pointer's row in the window, and the sidebar's first row is one
   * down -- past the frame's top border -- so the height it implies is the
   * rows above it. Clamped to zero at the floor rather than refused: dragging
   * it to the top is how you put the folder rail away, and it comes back by
   * dragging it down again. The ceiling is applied where the height is read,
   * so a drag past the bottom of a short window cannot strand the chat list.
   */
  const dragSection = (opts: { y: number }): void => {
    store.setState({ patch: { folderHeight: Math.max(0, opts.y - FRAME_TOP_ROWS) } });
  };

  const endDrag = (): void => {
    dragModeRef.current = null;
  };

  const pressFolder = (opts: { id: number; button: number }): void => {
    if (opts.button !== MOUSE_BUTTON_LEFT) {
      return;
    }
    const current = store.getState();
    const target = current.folders.findIndex(folder => folder.id === opts.id);
    if (target === -1) {
      return;
    }
    // Through FOLDER_CYCLE rather than setting activeFolderId directly, so a
    // click and `]f` go through one code path -- including its reset of the
    // chat cursor, which a direct write would silently skip.
    const from = current.folders.findIndex(folder => folder.id === current.activeFolderId);
    store.setState({
      patch: applyAction({
        state: current,
        action: { type: ActionTypes.FOLDER_CYCLE, delta: target - (from === -1 ? 0 : from) },
      }),
    });
  };
  // The open chat's frame title says what the other side is doing, when they
  // are doing anything -- "Alice · typing…" -- which is where every graphical
  // client puts it. Read with `now` rather than trusting the map, so a status
  // whose timer never fired (a suspended laptop) is still not drawn.
  const now = Date.now();
  const activeTyping = state.activePeerId === null
    ? null
    : readTypingStatus({ typing: state.typingByPeer, peerId: state.activePeerId, now });
  const activeChatTitle = activeDialog === undefined
    ? 'tglow'
    : activeTyping === null
      ? activeDialog.title
      : `${activeDialog.title} · ${activeTyping.phrase}`;

  // ── the conversation panes ──────────────────────────────────────────────
  //
  // The focused pane's conversation is the flat state, so the list has to be
  // merged before anything draws from it -- otherwise the one pane that is
  // certainly up to date is the one drawn stale. See core/conversation-panes.ts.
  const paneTitle = (pane: { peerId: string | null }): string => {
    const dialog = state.dialogs.find(row => row.peerId === pane.peerId);
    if (dialog === undefined) {
      return 'tglow';
    }
    // readTypingStatus rather than the map directly: a status carries its own
    // expiry, and one left behind by somebody who closed their app must go
    // stale rather than sit in the frame claiming they are still typing.
    const typing = pane.peerId === null
      ? null
      : readTypingStatus({ typing: state.typingByPeer, peerId: pane.peerId, now });
    return typing === null ? dialog.title : `${dialog.title} · ${typing.phrase}`;
  };
  // The top edge names the conversation each column *starts* with; the ones
  // stacked beneath it get their own titled divider inside the column, the
  // same device the sidebar already uses between folders and chats.
  const conversationSpans = paneGrid.map((column, index) => ({
    width: conversationWidths[index] ?? 0,
    title: paneTitle(column[0] ?? { peerId: null }),
  }));

  // What the status line shows beyond the M1 four. Derived here rather than
  // inside the component: everything below reads state the component has no
  // business holding, and none of it changes what the line does -- only what
  // it has to say.
  const cursorMessage = state.messages[state.messageCursor];
  // The open chat's presence, resolved once: the status line wants both the
  // dot and the phrase, and they must agree about which state they describe.
  const activePresence = (state.activePeerId === null
    ? null
    : state.presenceByPeer.get(state.activePeerId)) ?? { kind: PresenceKinds.UNKNOWN, seenAt: null };
  // Named only when the user has narrowed to one. "All chats" says the same
  // thing as an empty folder field and costs nine columns to say it.
  const statusFolder = hasFolders && activeFolder !== null && activeFolder.id !== ALL_CHATS_FOLDER_ID
    ? activeFolder.title
    : '';
  // Chats, not messages, and across every folder rather than the visible ones:
  // the question this answers is "is something waiting that I cannot see from
  // here", which a total that only counts the current folder cannot.
  const unreadChats = state.dialogs.reduce(
    (waiting, dialog) => waiting + (dialog.unreadCount > 0 ? 1 : 0),
    0,
  ) - (activeDialog !== undefined && activeDialog.unreadCount > 0 ? 1 : 0);
  const chatListFocused = state.engine.context === VimContexts.CHAT_LIST;
  // The focused pane's frame, not both: which pane has focus was previously
  // visible only through a cursor highlight, invisible in an empty pane.
  const frameColour = chatListFocused ? tokens.borderActive : tokens.border;

  return (
    <box
      flexDirection="column"
      width={width}
      height={height}
      backgroundColor={tokens.background}
      // Every drag is handled here rather than on the element it started from,
      // because OpenTUI delivers a drag to whatever is under the pointer --
      // which loses a one-column divider on the first movement. What the drag
      // means was decided when it began; see dragModeRef.
      onMouseDown={(event: { x: number; y: number; button: number }) => {
        beginDrag({ x: event.x, y: event.y, button: event.button });
      }}
      onMouseDrag={(event: { x: number; y: number }) => { dragAnywhere({ x: event.x, y: event.y }); }}
      onMouseDragEnd={endDrag}
      onMouseUp={endDrag}
    >
      <text height={1} flexShrink={0} fg={frameColour}>
        {buildTopEdge({
          widths: paneWidths,
          // The sidebar's top edge names whichever section actually starts
          // there: the folders when they are shown, the chat list when they
          // are not. The divider below carries the other name.
          titles: {
            rail: 'Folders',
            sidebar: folderSectionHeight > 0 ? 'Folders' : 'Chats',
            messages: activeChatTitle,
          },
          conversations: conversationSpans,
        })}
      </text>

      <box flexDirection="row" height={paneHeight}>
        <FrameColumn height={paneHeight} colour={frameColour} tee={sectionTee(FRAME_TEE_RIGHT)} />

        {/* The sidebar is one column split horizontally -- folders above,
            chats below -- rather than a separate rail beside the chat list.
            The owner asked for this shape (their own herdr sidebar stacks
            spaces over agents the same way), and in a terminal it is the
            better trade: horizontal room is what a conversation needs, and a
            third pane spends it where a divider row costs almost nothing. */}
        <box flexDirection="column" width={paneWidths.sidebar} height={paneHeight} flexShrink={0}>
          {folderSectionHeight > 0 ? (
            <>
              <FolderRail
                folders={state.folders}
                activeFolderId={state.activeFolderId}
                unreadByFolder={unreadByFolder}
                onFolderPress={pressFolder}
                tokens={tokens}
                width={paneWidths.sidebar}
                height={folderSectionHeight}
              />
              <text height={1} flexShrink={0} fg={frameColour}>
                {buildSectionDivider({ width: paneWidths.sidebar, title: 'Chats' })}
              </text>
            </>
          ) : null}

          <ChatList
            dialogs={visibleDialogs}
            cursor={state.chatCursor}
            focused={chatListFocused}
            tokens={tokens}
            width={paneWidths.sidebar}
            height={chatListHeight}
            activePeerId={state.activePeerId}
            typingByPeer={state.typingByPeer}
            now={now}
            onChatPress={pressChat}
            onScroll={({ delta }) => { scrollBy({ unit: 'chat', delta }); }}
          />
        </box>

        <FrameColumn height={paneHeight} colour={frameColour} tee={sectionTee(FRAME_TEE_LEFT)} />

        {/* The right column: conversation, a rule, then the composer beneath
            it. The composer belongs to the chat it writes into, so it stops
            where the chat does rather than running under the chat list -- the
            shape every graphical Telegram client uses, and the one the owner
            asked for. The chat list keeps its full height beside it.

            Each column of the row renders its own rows independently, so this
            nests without disturbing the frame: the chat list still draws
            paneHeight rows on the left while these draw paneHeight rows on the
            right. */}
        {paneGrid.map((column, columnIndex) => {
          const columnWidth = conversationWidths[columnIndex] ?? 0;
          // The dividers between stacked conversations cost a row each, the
          // same way the ones between columns cost a column.
          const rowHeights = shareEvenly({
            total: Math.max(0, paneHeight - (column.length - 1) * SECTION_DIVIDER_HEIGHT),
            count: column.length,
          });
          return (
            <Fragment key={`column-${columnIndex}`}>
              {columnIndex > 0 ? <FrameColumn height={paneHeight} colour={frameColour} /> : null}
              <box flexDirection="column" width={columnWidth} height={paneHeight} flexShrink={0}>
                {column.map((pane, rowIndex) => {
                  const rowHeight = rowHeights[rowIndex] ?? 0;
                  const isActive = columnIndex === state.activePane.column && rowIndex === state.activePane.row;
                  // Only the focused pane owns the composer, and only it can
                  // be scrolled or clicked into: every key binding and every
                  // side effect in this file works on the conversation in the
                  // flat state, which is this pane's. An unfocused pane is a
                  // live view, not a second place to type -- one Enter would
                  // otherwise be ambiguous about which chat it sends to.
                  const showComposer = isActive && !isOverlayOpen;
                  const bodyHeight = Math.max(1, rowHeight - (showComposer ? composerHeight : 0));
                  const paneDialog = state.dialogs.find(row => row.peerId === pane.peerId);
                  // This pane's pictures, at this pane's width. MessageView
                  // still looks a picture up by message id, so the width-keyed
                  // cache is narrowed to one pane here rather than pushed down
                  // into the component -- which keeps the component ignorant
                  // of panes, as it has been throughout.
                  const pictureWidth = resolveImageWidth({ paneWidth: columnWidth, sticker: false });
                  const stickerWidth = resolveImageWidth({ paneWidth: columnWidth, sticker: true });
                  const paneImages = new Map<number, IImageCell[][]>();
                  for (const message of pane.messages) {
                    const width = message.media?.kind === MediaKinds.STICKER ? stickerWidth : pictureWidth;
                    const cells = state.imagesByKey.get(imageCacheKey({ messageId: message.id, width }));
                    if (cells !== undefined) {
                      paneImages.set(message.id, cells);
                    }
                  }
                  return (
                    <Fragment key={`pane-${columnIndex}-${rowIndex}`}>
                      {/* The conversation a column *starts* with is named on
                          the frame's top edge; the ones stacked beneath get
                          their own titled divider, which is the device the
                          sidebar already uses between folders and chats. */}
                      {rowIndex > 0 ? (
                        <text height={SECTION_DIVIDER_HEIGHT} flexShrink={0} fg={frameColour}>
                          {buildSectionDivider({ width: columnWidth, title: paneTitle(pane) })}
                        </text>
                      ) : null}
                      <MessageView
                        messages={pane.messages}
                        cursor={pane.messageCursor}
                        focused={isActive && state.engine.context === VimContexts.MESSAGES}
                        tokens={tokens}
                        width={columnWidth}
                        height={bodyHeight}
                        resolveSenderName={resolveSenderName}
                        revealedSpoilers={state.revealedSpoilers}
                        // Drawn pictures belong to the focused conversation:
                        // the cache is keyed by message id alone and is
                        // refilled per pane width, so handing it to a pane of
                        // a different width would draw one chat's photos at
                        // another's size.
                        imagesByMessageId={paneImages}
                        onImageRows={rows => {
                          placeImages({
                            column: columnIndex,
                            widths: conversationWidths,
                            keyFor: messageId => imageCacheKey({ messageId, width: pictureWidth }),
                            placements: rows,
                          });
                        }}
                        imagesDrawnByTerminal={graphicsCapable}
                        readOutboxMaxId={paneDialog?.readOutboxMaxId ?? 0}
                        onMessagePress={isActive ? pressMessage : undefined}
                        onScroll={isActive ? ({ delta }) => { scrollBy({ unit: 'message', delta }); } : undefined}
                        showGutter={state.showGutter}
                        showTime={state.showTime}
                      />
                      {showComposer ? (
                        <>
                          <text height={COMPOSER_RULE_HEIGHT} flexShrink={0} fg={tokens.border}>
                            {COMPOSER_RULE.repeat(Math.max(0, columnWidth))}
                          </text>
                          <Composer
                            text={state.composerText}
                            mode={state.engine.mode}
                            focused={state.engine.context === VimContexts.COMPOSER}
                            tokens={tokens}
                            width={columnWidth}
                            replyingTo={replyingTo}
                            editing={isEditing}
                          />
                        </>
                      ) : null}
                    </Fragment>
                  );
                })}
              </box>
            </Fragment>
          );
        })}

        <FrameColumn height={paneHeight} colour={frameColour} />
      </box>

      <text height={1} flexShrink={0} fg={frameColour}>
        {buildBottomEdge({ widths: paneWidths, conversations: conversationSpans })}
      </text>

      {/* Absolutely positioned at the pointer, so it sits over the pane it was
          opened on rather than pushing it aside -- a menu that reflowed the
          conversation would move the very message it is about. Pulled back
          from the edges by resolveMenuPosition so it never runs off. */}
      {state.contextMenu !== null && menuItems.length > 0 ? (
        <box
          position="absolute"
          left={resolveMenuPosition({
            x: state.contextMenu.x,
            y: state.contextMenu.y,
            width: resolveMenuWidth({ items: menuItems }),
            height: menuItems.length,
            windowWidth: width,
            windowHeight: height,
          }).x}
          top={resolveMenuPosition({
            x: state.contextMenu.x,
            y: state.contextMenu.y,
            width: resolveMenuWidth({ items: menuItems }),
            height: menuItems.length,
            windowWidth: width,
            windowHeight: height,
          }).y}
        >
          <ContextMenu
            items={menuItems}
            cursor={state.contextMenu.cursor}
            tokens={tokens}
            width={resolveMenuWidth({ items: menuItems })}
            onChoose={chooseMenuItem}
          />
        </box>
      ) : null}

      {isChatPickerOpen ? (
        <ChatPicker
          results={chatPickerResults}
          query={state.chatPickerQuery}
          cursor={state.chatPickerCursor}
          tokens={tokens}
          width={width}
        />
      ) : isWhichKeyOpen ? (
        <WhichKey
          bindings={whichKeyBindings}
          mode={state.engine.mode}
          context={state.engine.context}
          tokens={tokens}
          width={width}
        />
      ) : isSearchOpen ? (
        <SearchOverlay
          query={state.searchQuery}
          tokens={tokens}
          width={width}
        />
      ) : null}

      {/* In place of the status line, not above it: see CommandLine's own
          doc comment. The chrome budget is unchanged either way, so pressing
          `:` never resizes a pane. */}
      {state.overlay === 'reaction' ? (
        <ReactionPicker
          tokens={tokens}
          width={width}
          chosen={(cursorMessage?.reactions ?? []).find(reaction => reaction.chosen)?.emoji ?? null}
        />
      ) : state.overlay === 'command' ? (
        <CommandLine query={state.commandQuery} tokens={tokens} width={width} />
      ) : (
      <StatusLine
        mode={state.engine.mode}
        title={statusTitle}
        unreadCount={activeDialog?.unreadCount ?? 0}
        position={state.messages.length === 0 ? 0 : state.messageCursor + 1}
        total={state.messages.length}
        hint="\ for keys"
        tokens={tokens}
        width={width}
        confirming={isConfirming}
        warning={isWarning}
        engine={state.engine}
        connection={state.connection}
        folder={statusFolder}
        peerKind={formatPeerKind({ kind: state.activePeerId === null ? undefined : state.peerKinds.get(state.activePeerId) })}
        typing={activeTyping?.phrase ?? ''}
        online={activePresence.kind === PresenceKinds.ONLINE}
        presence={activePresence.kind === PresenceKinds.ONLINE
          ? ''
          : describePresence({ presence: activePresence, now: Math.floor(now / MILLISECONDS_PER_SECOND) })}
        messageId={cursorMessage?.id ?? null}
        messageTime={cursorMessage === undefined ? '' : formatClock({ date: cursorMessage.date })}
        messagePinned={cursorMessage?.pinned === 1}
        unreadChats={unreadChats}
        composerLength={state.composerText.length}
        loadingOlder={state.loadingOlder}
      />
      )}
    </box>
  );
};
