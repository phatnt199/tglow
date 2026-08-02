import { useCallback, useRef, useSyncExternalStore } from 'react';

import { useKeyboard, useTerminalDimensions } from '@opentui/react';
import { ApplicationLogger, type ILogger } from '@venizia/ignis-helpers';

// Type-only import, erased at runtime under verbatimModuleSyntax, so this
// path choice has no bearing on the telegram/global.window crash the test
// files' value imports had to avoid (see __tests__/tui/app.test.tsx) --
// points at the concrete module rather than the core/ barrel purely because
// that is where IApplicationState is actually defined.
import type { ApplicationStoreService, IApplicationState } from '../core/application-store.ts';
import { ActionTypes, VimContexts, VimModes } from '../keys/common/index.ts';
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
  onQuit: () => void;
  onOpenChat: (opts: { peerId: string }) => Promise<void>;
}

const SIDEBAR_WIDTH = 22;
/** The composer's rule and prompt, then the status line. */
const CHROME_HEIGHT = 3;
/** The status line is always exactly one row, whichever chrome sits above it. */
const STATUS_LINE_HEIGHT = 1;
/** Composer grows by exactly this many rows while a reply is pending -- see the comment on chromeHeight below. */
const REPLY_PREVIEW_HEIGHT = 1;
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
    store, engine, keymapService, keyNormalizer, tokens, resolveSenderName, onSend, onQuit, onOpenChat,
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
          // The composer is MessageService's to clear, and it clears only
          // once the message has actually gone. Emptying it here was
          // optimistic in the worst sense: a rejected send left the user with
          // nothing to retry and no copy of what they had written, and it
          // also made the service's "still what I sent?" check permanently
          // false, so its own clear never ran in production.
          //
          // That leaves a window, between dispatch and the round-trip
          // resolving, where the composer still shows the sent text with
          // nothing on screen to say a send is in flight. Without a guard, a
          // second Enter in that window re-dispatches this case with the same
          // non-empty string -- a duplicate send, which MessageService's own
          // comment calls unrecoverable. Set before the call and cleared in
          // `finally` so a rejected send releases it too; leaving it set on
          // failure would make the composer permanently unable to send.
          if (sendInFlightRef.current) {
            break;
          }
          sendInFlightRef.current = true;
          void onSend(accumulated.composerText)
            .catch(error => {
              logRejection({ method: 'onSend', error });
            })
            .finally(() => {
              sendInFlightRef.current = false;
            });
          break;
        }
        case ActionTypes.CHAT_OPEN: {
          const target = accumulated.dialogs[accumulated.chatCursor];
          if (target) {
            void onOpenChat({ peerId: target.peerId }).catch(error => {
              logRejection({ method: 'onOpenChat', error });
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

    // The engine owns mode and context; action patches must not override them.
    store.setState({ patch: { ...patch, engine: result.state } });
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
  // The overlay replaces the composer and grows upward, so the panes above
  // it must shrink by however many rows it actually renders -- Math.max(1, …)
  // keeps at least one row for them even if a future binding table were long
  // enough to ask for more than the terminal has. Composer grows by one row
  // of its own (REPLY_PREVIEW_HEIGHT) whenever it actually renders the "Replying
  // to" row -- driven by this same `replyingTo`, so the two can never disagree
  // about whether that row is on screen. Skipping this while the overlay is
  // open is correct, not an oversight: Composer is not rendered at all then.
  const chromeHeight = isWhichKeyOpen
    ? resolveWhichKeyHeight({ bindingCount: whichKeyBindings.length, width }) + STATUS_LINE_HEIGHT
    : CHROME_HEIGHT + (replyingTo !== null ? REPLY_PREVIEW_HEIGHT : 0);
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
      />
    </box>
  );
};
