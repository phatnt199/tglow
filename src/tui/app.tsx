import { useCallback, useSyncExternalStore } from 'react';

import { useKeyboard, useTerminalDimensions } from '@opentui/react';

// Imported from the concrete module, not the core/ barrel -- see the same
// note in action-reducer.ts: the barrel transitively pulls in the `telegram`
// package, which misdetects itself as running in a browser once OpenTUI's
// renderer has set `global.window`, and crashes at import time.
import type { ApplicationStoreService, IApplicationState } from '../core/application-store.ts';
import { ActionTypes, VimContexts, VimModes } from '../keys/common/index.ts';
import type { KeyNormalizerService, KeymapService, VimEngineService } from '../keys/index.ts';
import { applyAction } from './action-reducer.ts';
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
const CHROME_HEIGHT = 4;

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
    const result = engine.resolve({ state: current.engine, key, keymap: keymapService.getBindings() });

    // In insert mode an unmapped printable key is text, not a missing binding.
    if (result.status === 'unmapped' && current.engine.mode === VimModes.INSERT) {
      const isPrintable = event.sequence.length === 1 && !event.ctrl && !event.meta;
      store.setState({
        patch: {
          engine: result.state,
          ...(isPrintable ? { composerText: current.composerText + event.sequence } : {}),
        },
      });
      return;
    }

    if (result.status !== 'resolved') {
      store.setState({ patch: { engine: result.state } });
      return;
    }

    let patch: Partial<IApplicationState> = {};

    for (const action of result.actions) {
      patch = { ...patch, ...applyAction({ state: { ...current, ...patch }, action }) };

      switch (action.type) {
        case ActionTypes.COMPOSER_SEND: {
          const text = current.composerText;
          patch = { ...patch, composerText: '' };
          void onSend(text);
          break;
        }
        case ActionTypes.CHAT_OPEN: {
          const target = current.dialogs[current.chatCursor];
          if (target) {
            void onOpenChat({ peerId: target.peerId });
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
  const bodyHeight = Math.max(1, height - CHROME_HEIGHT);

  return (
    <box flexDirection="column" width={width} height={height} backgroundColor={tokens.background}>
      <box flexDirection="row" height={bodyHeight}>
        <box border borderColor={tokens.border} width={SIDEBAR_WIDTH}>
          <ChatList
            dialogs={state.dialogs}
            cursor={state.chatCursor}
            focused={state.engine.context === VimContexts.CHAT_LIST}
            tokens={tokens}
            width={SIDEBAR_WIDTH - 2}
          />
        </box>
        <box border borderColor={tokens.border} flexGrow={1}>
          <MessageView
            messages={state.messages}
            cursor={state.messageCursor}
            focused={state.engine.context === VimContexts.MESSAGES}
            tokens={tokens}
            resolveSenderName={resolveSenderName}
          />
        </box>
      </box>

      <Composer
        text={state.composerText}
        mode={state.engine.mode}
        focused={state.engine.context === VimContexts.COMPOSER}
        tokens={tokens}
      />

      <StatusLine
        mode={state.engine.mode}
        title={state.statusMessage ?? activeDialog?.title ?? 'no chat'}
        unreadCount={activeDialog?.unreadCount ?? 0}
        position={state.messages.length === 0 ? 0 : state.messageCursor + 1}
        total={state.messages.length}
        hint="\\ for keys"
        tokens={tokens}
      />
    </box>
  );
};
