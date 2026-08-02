import { getError } from '@venizia/ignis-inversion';

// Type-only import, erased at runtime under verbatimModuleSyntax, so this
// path choice has no bearing on the telegram/global.window crash the test
// files' value imports had to avoid (see src/__tests__/tui/action-reducer.test.ts)
// -- points at the concrete module rather than the core/ barrel purely
// because that is where IApplicationState is actually defined.
import type { IApplicationState } from '../core/application-store.ts';
import { ActionTypes, VimContexts, VimModes, type TAction } from '../keys/common/index.ts';
import { extractLinkUrls } from './entities.ts';

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

    case ActionTypes.SPOILER_REVEAL: {
      const message = state.messages[state.messageCursor];
      if (!message) {
        return {};
      }
      // A fresh Set, cloned from the current one rather than mutated: the
      // store is read through useSyncExternalStore, which compares by
      // reference and bails out on an unchanged one, leaving the spoiler
      // masked on screen even though state.revealedSpoilers itself now has
      // the id in it.
      return { revealedSpoilers: new Set(state.revealedSpoilers).add(message.id) };
    }

    // Spec §3.1: "url, text_url -- the URL shown on K". A key that appears to
    // do nothing reads as broken, so a message with no link says so rather
    // than leaving the status line untouched -- the same reasoning
    // EDIT_START's refusal branch already applies below.
    case ActionTypes.LINK_SHOW: {
      const message = state.messages[state.messageCursor];
      if (!message) {
        return {};
      }
      const urls = extractLinkUrls({ text: message.text, entities: message.entities });
      if (urls.length === 0) {
        return { statusMessage: 'No link in this message' };
      }
      if (urls.length === 1) {
        return { statusMessage: urls[0] };
      }
      return { statusMessage: `${urls[0]} (+${urls.length - 1} more)` };
    }

    case ActionTypes.REPLY_START: {
      const message = state.messages[state.messageCursor];
      if (!message) {
        return {};
      }
      return { replyToMessageId: message.id };
    }

    case ActionTypes.REPLY_CANCEL: {
      return { replyToMessageId: null };
    }

    case ActionTypes.EDIT_START: {
      const message = state.messages[state.messageCursor];
      if (!message) {
        return {};
      }
      // Refused here, in the interface, rather than left to fail at the
      // server: out !== 1 means this message is not the user's own.
      if (message.out !== 1) {
        return { statusMessage: 'Can only edit your own messages' };
      }
      // Unlike REPLY_START, this is the only action `e` dispatches -- there
      // is no separate FOCUS_SET/MODE_SET pair the way `i` has, because
      // those would fire unconditionally even on the refusal branch above.
      // So this one action also carries what i's two normally would.
      return {
        editingMessageId: message.id,
        composerTextBeforeEdit: state.composerText,
        composerText: message.text,
        engine: { ...state.engine, context: VimContexts.COMPOSER, mode: VimModes.INSERT },
      };
    }

    case ActionTypes.EDIT_CANCEL: {
      return {
        editingMessageId: null,
        composerText: state.composerTextBeforeEdit ?? '',
        composerTextBeforeEdit: null,
      };
    }

    case ActionTypes.DELETE_REQUEST: {
      const message = state.messages[state.messageCursor];
      if (!message) {
        return {};
      }
      return {
        pendingConfirmation: { kind: 'delete', messageId: message.id },
        statusMessage: 'Delete this message? (y/n)',
      };
    }

    // CONFIRM and CANCEL_CONFIRMATION both end the question the same way --
    // only CONFIRM additionally deletes, which is App's side effect to
    // perform (the only place that can reach onDelete), the same split
    // COMPOSER_SEND/CHAT_OPEN draw below. Clearing unconditionally here,
    // not only once a successful delete comes back, keeps a failed or
    // hung network call from leaving every other key swallowed.
    case ActionTypes.CONFIRM:
    case ActionTypes.CANCEL_CONFIRMATION: {
      return { pendingConfirmation: null, statusMessage: null };
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
