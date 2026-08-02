import { getError } from '@venizia/ignis-inversion';

// Type-only import, erased at runtime under verbatimModuleSyntax, so this
// path choice has no bearing on the telegram/global.window crash the test
// files' value imports had to avoid (see __tests__/tui/action-reducer.test.ts)
// -- points at the concrete module rather than the core/ barrel purely
// because that is where IApplicationState is actually defined.
import type { IApplicationState } from '../core/application-store.ts';
import { ActionTypes, type TAction } from '../keys/common/index.ts';

const clamp = (opts: { value: number; maximum: number }): number => {
  if (opts.maximum < 0) {
    return 0;
  }
  return Math.min(Math.max(opts.value, 0), opts.maximum);
};

/**
 * One engine action to one state patch. Pure and synchronous: actions with side
 * effects (sending, opening a chat, quitting) are handled by App, not here.
 */
export const applyAction = (opts: { state: IApplicationState; action: TAction }): Partial<IApplicationState> => {
  const { state, action } = opts;

  switch (action.type) {
    case ActionTypes.CURSOR_MOVE: {
      if (action.unit === 'message') {
        return {
          messageCursor: clamp({ value: state.messageCursor + action.delta, maximum: state.messages.length - 1 }),
        };
      }
      return {
        chatCursor: clamp({ value: state.chatCursor + action.delta, maximum: state.dialogs.length - 1 }),
      };
    }

    case ActionTypes.CURSOR_EDGE: {
      const last = (action.unit === 'message' ? state.messages.length : state.dialogs.length) - 1;
      const target = action.edge === 'first' ? 0 : clamp({ value: last, maximum: last });
      return action.unit === 'message' ? { messageCursor: target } : { chatCursor: target };
    }

    case ActionTypes.MODE_SET: {
      return { engine: { ...state.engine, mode: action.mode } };
    }

    case ActionTypes.FOCUS_SET: {
      return { engine: { ...state.engine, context: action.context } };
    }

    case ActionTypes.COMPOSER_INSERT_TEXT: {
      return { composerText: state.composerText + action.text };
    }

    case ActionTypes.COMPOSER_BACKSPACE: {
      return { composerText: state.composerText.slice(0, -1) };
    }

    case ActionTypes.OVERLAY_TOGGLE: {
      // The same key that opens an overlay closes it again: pressing \\ a
      // second time must return to null rather than re-opening the same
      // overlay it already is.
      return { overlay: state.overlay === action.overlay ? null : action.overlay };
    }

    // Side-effecting actions are App's to perform; the reducer has no patch.
    case ActionTypes.CHAT_OPEN:
    case ActionTypes.COMPOSER_SEND:
    case ActionTypes.APPLICATION_QUIT: {
      return {};
    }

    default: {
      throw getError({
        message: `[action-reducer][applyAction] Unknown action type | Type: ${(action as { type: string }).type}`,
      });
    }
  }
};
