import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';

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
import { resolveFolderMembership } from '../core/folder-service.ts';
import { readTypingStatus } from '../core/typing-status.ts';
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
import { ChatPicker, resolveChatPickerHeight, resolveWhichKeyHeight, SEARCH_OVERLAY_HEIGHT, SearchOverlay, WhichKey } from './overlays/index.ts';
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
import { ChatList, Composer, FolderRail, MessageView, StatusLine } from './panes/index.ts';
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
 * OpenTUI's MouseButton.LEFT. Named rather than compared to a bare 0, and
 * checked by every press handler: until the context menu exists a right click
 * must do nothing at all, and "nothing" is not the same as "whatever left
 * does" -- which is exactly what an unguarded handler would give it.
 */
const MOUSE_BUTTON_LEFT = 0;

/** What one notch of the wheel moves, matching the three lines most terminals send. */
const SCROLL_ROWS_PER_NOTCH = 3;

/** The frame's left border, which the sidebar starts after. */
const FRAME_LEFT_COLUMNS = 1;

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
  onDrag?: (opts: { x: number }) => void;
}) => (
  <box
    flexDirection="column"
    width={1}
    height={props.height}
    flexShrink={0}
    onMouseDrag={props.onDrag ? (event: { x: number }) => { props.onDrag?.({ x: event.x }); } : undefined}
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

/**
 * The chat picker's own vocabulary while it owns input (M1b-2 Task 8): each
 * pair below is one direction -- `<C-n>`/`j` down, `<C-p>`/`k` up -- echoing
 * vim's own choice of j/k alongside emacs-style C-n/C-p, the same pairing
 * ctrlp.vim and fzf both use. Search (Task 9) has no result list of its own
 * to move a selection through, so it has no equivalent of these two.
 */
const CHAT_PICKER_NEXT_TOKENS: readonly string[] = ['<C-n>', 'j'];
const CHAT_PICKER_PREVIOUS_TOKENS: readonly string[] = ['<C-p>', 'k'];

/**
 * Bounds how many cache rows a single `/` query asks MessageSearchService
 * for. Mirrors main.ts's own HISTORY_LIMIT: state.messages never holds more
 * than that many rows at once (no pagination past it exists yet), so a match
 * outside this many of the newest cached rows could never be present in
 * state.messages for resolveSearchMatchIndices to find anyway -- searching
 * further than this would only cost time, not find anything reachable.
 */
const SEARCH_RESULT_LIMIT = 200;

const CONTROL_CHARACTER_BOUNDARY = 0x20;
const DELETE_CODE_POINT = 0x7f;

/**
 * True only for a single, unmodified, printable character. Two things a
 * naive check misses:
 *
 * - Tab and linefeed arrive with `ctrl: false` (OpenTUI's parseKeypress
 *   resolves them before the ctrl branch), so `!ctrl` alone does not keep
 *   control characters out of the composer -- the code-point range check is
 *   what actually excludes them.
 * - `sequence.length` counts UTF-16 code units, which splits a non-BMP
 *   character (an emoji) into two, silently failing "exactly one character"
 *   for perfectly ordinary input. Array.from a string to count code points
 *   instead.
 */
const isPrintableCharacter = (opts: { sequence: string; ctrl: boolean; meta: boolean }): boolean => {
  const { sequence, ctrl, meta } = opts;
  if (ctrl || meta) {
    return false;
  }

  const codePoints = Array.from(sequence);
  if (codePoints.length !== 1) {
    return false;
  }

  const codePoint = codePoints[0].codePointAt(0) ?? 0;
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
    onSend, onEdit, onDelete, onQuit, onOpenChat, onMarkRead,
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

      const { messageIds } = current.pendingConfirmation;
      store.setState({ patch: applyAction({ state: current, action: confirmationAction }) });
      if (confirmationAction.type === ActionTypes.CONFIRM) {
        // One call carrying every id, not a loop of single deletes: Telegram's
        // own deleteMessages takes an array, so a ranged delete is one round
        // trip, one republish and one status message rather than N of each.
        void onDelete({ messageIds }).catch(error => { logRejection({ method: 'onDelete', error }); });
      }
      return;
    }

    // The chat picker owns every key while it is open, the same guarantee
    // which-key's own block just below makes -- but unlike which-key it has
    // real state of its own to update (chatPickerQuery/chatPickerCursor),
    // not merely a choice between swallowing a key and letting it through,
    // so it gets its own block, checked first.
    if (current.overlay === 'chatpicker') {
      const pickerToken = keyNormalizer.toCanonicalString({ key });

      if (pickerToken === OVERLAY_ESCAPE_TOKEN) {
        store.setState({ patch: { overlay: null, chatPickerQuery: '', chatPickerCursor: 0 } });
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
          initialPatch: { chatCursor: targetIndex, overlay: null, chatPickerQuery: '', chatPickerCursor: 0 },
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
        // A blank query is MessageSearchService's own business rule to
        // refuse (message-search.ts), not App's to re-check -- activePeerId
        // is the one thing only App can see, so that guard stays here.
        const rows = current.activePeerId === null
          ? []
          : messageSearchService.search({
            peerId: current.activePeerId,
            query: current.searchQuery,
            limit: SEARCH_RESULT_LIMIT,
          });
        const matchIds = rows.map(row => row.id);
        const positions = resolveSearchMatchIndices({ messages: current.messages, matchIds });
        // Mirrors the chat picker's own "Enter with nothing selected does
        // nothing" rule: there is no first match to jump to yet, which reads
        // as "keep refining the query", not as "give up and close".
        if (positions.length === 0) {
          return;
        }
        store.setState({
          patch: {
            overlay: null,
            searchQuery: '',
            // What n/N (SEARCH_CYCLE, action-reducer.ts) cycle through once
            // this overlay has closed -- ids, not positions, so a message
            // that later moves or is deleted is dropped rather than
            // corrupting the cursor (resolveSearchMatchIndices's own doc
            // comment).
            searchMatchIds: matchIds,
            // The first (topmost, oldest-loaded) match currently on screen --
            // positions is already sorted ascending by resolveSearchMatchIndices.
            messageCursor: positions[0]!,
            searchCursorBeforeOpen: null,
            // `/` can be opened from the chat list (it is context '*', like
            // \ and <C-p>) -- MessageView only highlights the cursor row
            // while focused (message-view.tsx), so without this a jump
            // triggered from there would move messageCursor with nothing on
            // screen to show it moved. Mirrors CHAT_OPEN's own side effect
            // (commitResolution below), which focuses messages for the same
            // reason once it moves the cursor there.
            engine: { ...current.engine, context: VimContexts.MESSAGES },
          },
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
  // The folder section takes what its folders need, capped so the chat list
  // always keeps the larger half: folders are how you reach chats, not a thing
  // to look at on their own. Zero hides it, divider included.
  const folderSectionHeight = hasFolders
    ? Math.max(0, Math.min(state.folders.length, Math.floor(paneHeight / 2) - SECTION_DIVIDER_HEIGHT))
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

  const pressChat = (opts: { index: number; button: number }): void => {
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

  const pressMessage = (opts: { index: number; button: number }): void => {
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
  const chatListFocused = state.engine.context === VimContexts.CHAT_LIST;
  // The focused pane's frame, not both: which pane has focus was previously
  // visible only through a cursor highlight, invisible in an empty pane.
  const frameColour = chatListFocused ? tokens.borderActive : tokens.border;

  return (
    <box flexDirection="column" width={width} height={height} backgroundColor={tokens.background}>
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

        <FrameColumn height={paneHeight} colour={frameColour} tee={sectionTee(FRAME_TEE_LEFT)} onDrag={dragDivider} />

        {/* The right column: conversation, a rule, then the composer beneath
            it. The composer belongs to the chat it writes into, so it stops
            where the chat does rather than running under the chat list -- the
            shape every graphical Telegram client uses, and the one the owner
            asked for. The chat list keeps its full height beside it.

            Each column of the row renders its own rows independently, so this
            nests without disturbing the frame: the chat list still draws
            paneHeight rows on the left while these draw paneHeight rows on the
            right. */}
        <box flexDirection="column" width={paneWidths.messages} height={paneHeight} flexShrink={0}>
          <MessageView
            messages={state.messages}
            cursor={state.messageCursor}
            focused={state.engine.context === VimContexts.MESSAGES}
            tokens={tokens}
            width={paneWidths.messages}
            height={messageHeight}
            resolveSenderName={resolveSenderName}
            revealedSpoilers={state.revealedSpoilers}
            readOutboxMaxId={activeDialog?.readOutboxMaxId ?? 0}
            onMessagePress={pressMessage}
            onScroll={({ delta }) => { scrollBy({ unit: 'message', delta }); }}
          />

          {isOverlayOpen ? null : (
            <>
              <text height={1} flexShrink={0} fg={tokens.border}>
                {COMPOSER_RULE.repeat(Math.max(0, paneWidths.messages))}
              </text>
              <Composer
                text={state.composerText}
                mode={state.engine.mode}
                focused={state.engine.context === VimContexts.COMPOSER}
                tokens={tokens}
                width={paneWidths.messages}
                replyingTo={replyingTo}
                editing={isEditing}
              />
            </>
          )}
        </box>

        <FrameColumn height={paneHeight} colour={frameColour} />
      </box>

      <text height={1} flexShrink={0} fg={frameColour}>
        {buildBottomEdge({ widths: paneWidths })}
      </text>

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
      />
    </box>
  );
};
