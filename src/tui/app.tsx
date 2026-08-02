import { useCallback, useRef, useSyncExternalStore } from 'react';

import { useKeyboard, useTerminalDimensions } from '@opentui/react';
import { ApplicationLogger, type ILogger } from '@venizia/ignis-helpers';

// Type-only import, erased at runtime under verbatimModuleSyntax, so this
// path choice has no bearing on the telegram/global.window crash the test
// files' value imports had to avoid (see src/__tests__/tui/app.test.tsx) --
// points at the concrete module rather than the core/ barrel purely because
// that is where IApplicationState is actually defined.
import type { ApplicationStoreService, IApplicationState } from '../core/application-store.ts';
import { ActionTypes, VimContexts, VimModes, type IEngineState, type TAction } from '../keys/common/index.ts';
import type { KeyNormalizerService, KeymapService, VimEngineService } from '../keys/index.ts';
import { applyAction } from './action-reducer.ts';
import { resolveWhichKeyHeight, WhichKey } from './overlays/index.ts';
import { ChatList, Composer, MessageView, StatusLine } from './panes/index.ts';
import type { ITokens } from './theme/index.ts';

export interface IAppProps {
  store: ApplicationStoreService;
  engine: VimEngineService;
  keymapService: KeymapService;
  keyNormalizer: KeyNormalizerService;
  tokens: ITokens;
  resolveSenderName: (opts: { fromId: string | null }) => string;
  onSend: (text: string) => Promise<void>;
  onEdit: (opts: { messageId: number; text: string }) => Promise<void>;
  onDelete: (opts: { messageId: number }) => Promise<void>;
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
/** The composer's rule and prompt, then the status line. */
const CHROME_HEIGHT = 3;
/** The status line is always exactly one row, whichever chrome sits above it. */
const STATUS_LINE_HEIGHT = 1;
/** Composer grows by exactly this many rows while a reply is pending -- see the comment on chromeHeight below. */
const REPLY_PREVIEW_HEIGHT = 1;
/** Composer grows by exactly this many rows while an edit is in progress -- see the comment on chromeHeight below. */
const EDIT_INDICATOR_HEIGHT = 1;
/**
 * `fillchars = "vert:│"`: splits are a single rule, not a box. Boxing the
 * panes also put a doubled `┐┌` seam where two of them met.
 */
const RULE_WIDTH = 1;
const VERTICAL_RULE = '│';

/**
 * The two keys the which-key overlay owns outright while it is open, in the
 * same canonical form the keymap itself is authored in (key-normalizer.ts).
 * <escape> is checked directly here, ahead of engine resolution, so closing
 * the overlay cannot also run whatever <escape> otherwise means in the pane
 * underneath it -- refocusing the messages pane from the chat list, for
 * instance. The leader needs no such override: the engine already resolves
 * it to OVERLAY_TOGGLE below, which the reducer toggles closed the same way
 * it toggled open, so it is left to flow through the ordinary path.
 */
const OVERLAY_ESCAPE_TOKEN = '<escape>';
const OVERLAY_LEADER_TOKEN = '\\';

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

export const App = (props: IAppProps) => {
  const {
    store, engine, keymapService, keyNormalizer, tokens, resolveSenderName,
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

  // MessageService clears composerText only after its network round-trip
  // resolves, so the composer sits populated with no in-flight indicator for
  // that entire window. A ref, not state: the keyboard handler must see the
  // current value on the very next synchronous key press, the same reason it
  // already reads store.getState() fresh rather than a render's `state`.
  const sendInFlightRef = useRef(false);

  useKeyboard(event => {
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

      const { messageId } = current.pendingConfirmation;
      store.setState({ patch: applyAction({ state: current, action: confirmationAction }) });
      if (confirmationAction.type === ActionTypes.CONFIRM) {
        void onDelete({ messageId }).catch(error => { logRejection({ method: 'onDelete', error }); });
      }
      return;
    }

    // The overlay owns input while it is open. Everything except the two
    // keys above is swallowed here, before the engine ever sees it, so a
    // stray keystroke cannot move a cursor or seed a pending prefix the
    // engine would still be holding once the overlay closes.
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
      return;
    }

    let patch: Partial<IApplicationState> = { ...flushPatch };

    for (const action of result.actions) {
      // Computed once and read by both the reducer and the side-effect
      // switch below, so a hypothetical binding that both moves a cursor and
      // opens the item under it (e.g. [CURSOR_MOVE, CHAT_OPEN]) reads the
      // post-move position in both places, not the pre-move snapshot.
      const accumulated = { ...current, ...patch };
      patch = { ...patch, ...applyAction({ state: accumulated, action }) };

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
          // Gated on unit === 'message' specifically so chat-list movement
          // (unit: 'chat') can never reach this at all -- not suppressed by a
          // debounce or a flag, structurally excluded.
          const { activePeerId, messages } = accumulated;
          if (action.unit !== 'message' || !activePeerId) {
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
  });

  const activeDialog = state.dialogs.find(dialog => dialog.peerId === state.activePeerId);
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
  const chromeHeight = isWhichKeyOpen
    ? resolveWhichKeyHeight({ bindingCount: whichKeyBindings.length, width }) + STATUS_LINE_HEIGHT
    : CHROME_HEIGHT + (replyingTo !== null ? REPLY_PREVIEW_HEIGHT : 0) + (isEditing ? EDIT_INDICATOR_HEIGHT : 0);
  const paneHeight = Math.max(1, height - chromeHeight);
  const messageWidth = Math.max(1, width - SIDEBAR_WIDTH - RULE_WIDTH);

  return (
    <box flexDirection="column" width={width} height={height} backgroundColor={tokens.background}>
      <box flexDirection="row" height={paneHeight}>
        <ChatList
          dialogs={state.dialogs}
          cursor={state.chatCursor}
          focused={state.engine.context === VimContexts.CHAT_LIST}
          tokens={tokens}
          width={SIDEBAR_WIDTH}
          height={paneHeight}
          activePeerId={state.activePeerId}
        />

        {/* One `<text>` per row rather than a newline-joined string: the same
            one-child-one-row rule the panes follow, so the rule cannot be
            shrunk into its neighbours either. */}
        <box flexDirection="column" width={RULE_WIDTH} height={paneHeight} flexShrink={0}>
          {Array.from({ length: paneHeight }, (unused, row) => (
            <text key={row} height={1} flexShrink={0} fg={tokens.border}>{VERTICAL_RULE}</text>
          ))}
        </box>

        <MessageView
          messages={state.messages}
          cursor={state.messageCursor}
          focused={state.engine.context === VimContexts.MESSAGES}
          tokens={tokens}
          width={messageWidth}
          height={paneHeight}
          resolveSenderName={resolveSenderName}
          revealedSpoilers={state.revealedSpoilers}
          readOutboxMaxId={activeDialog?.readOutboxMaxId ?? 0}
        />
      </box>

      {isWhichKeyOpen ? (
        <WhichKey
          bindings={whichKeyBindings}
          mode={state.engine.mode}
          context={state.engine.context}
          tokens={tokens}
          width={width}
        />
      ) : (
        <Composer
          text={state.composerText}
          mode={state.engine.mode}
          focused={state.engine.context === VimContexts.COMPOSER}
          tokens={tokens}
          width={width}
          replyingTo={replyingTo}
          editing={isEditing}
        />
      )}

      <StatusLine
        mode={state.engine.mode}
        title={state.statusMessage ?? activeDialog?.title ?? 'no chat'}
        unreadCount={activeDialog?.unreadCount ?? 0}
        position={state.messages.length === 0 ? 0 : state.messageCursor + 1}
        total={state.messages.length}
        hint="\ for keys"
        tokens={tokens}
        width={width}
        confirming={state.pendingConfirmation !== null}
      />
    </box>
  );
};
