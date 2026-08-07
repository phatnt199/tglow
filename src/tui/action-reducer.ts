import { getError } from '@venizia/ignis-inversion';

// Type-only import, erased at runtime under verbatimModuleSyntax, so this
// path choice has no bearing on the telegram/global.window crash the test
// files' value imports had to avoid (see src/__tests__/tui/action-reducer.test.ts)
// -- points at the concrete module rather than the core/ barrel purely
// because that is where IApplicationState is actually defined.
import type { IApplicationState } from '../core/application-store.ts';
// Same reasoning as the type-only import above -- IMessageRow is defined in
// cache/database.ts, and this stays off the core/ barrel's crash path too.
import type { IMessageRow } from '../core/cache/database.ts';
import { ActionTypes, Operators, UNNAMED_REGISTER, VimContexts, VimModes, type TAction } from '../keys/common/index.ts';
import { extractLinkUrls } from './entities.ts';

const clamp = (opts: { value: number; maximum: number }): number => {
  if (opts.maximum < 0) {
    return 0;
  }
  return Math.min(Math.max(opts.value, 0), opts.maximum);
};

/**
 * The one place the delete question is worded, so `dd` and a ranged `3dd`
 * cannot drift apart -- the same reason OPERATOR_APPLY routes through
 * DELETE_REQUEST rather than building its own patch.
 *
 * The count is in the prompt because the prompt is the only thing standing
 * between a keystroke and the app's one irreversible, networked action.
 * Answering "Delete this message?" and losing three would be the worst
 * possible version of this feature. A single message keeps the wording it has
 * always had: "Delete 1 message?" reads like a machine, and one is the
 * overwhelmingly common case.
 */
const buildDeleteConfirmation = (opts: { messages: IMessageRow[] }): Partial<IApplicationState> => {
  const { messages } = opts;
  return {
    pendingConfirmation: { kind: 'delete', messageIds: messages.map(message => message.id) },
    statusMessage: messages.length === 1
      ? 'Delete this message? (y/n)'
      : `Delete ${messages.length} messages? (y/n)`,
  };
};

/**
 * Maps a committed search's message ids back to their *current* position in
 * `messages`, sorted ascending -- `messages`' own oldest-first order, the
 * same order the message pane renders top to bottom. Not memoized at commit
 * time: a message deleted (or otherwise dropped from the loaded window)
 * since the search ran is silently excluded here rather than pointing the
 * cursor at the wrong row or crashing. Exported so app.tsx's own Enter-commit
 * (the one place that first populates IApplicationState.searchMatchIds) can
 * share this exact resolution rather than keeping a second copy that could
 * drift from what SEARCH_CYCLE below considers "the same match, right now".
 */
export const resolveSearchMatchIndices = (opts: { messages: IMessageRow[]; matchIds: number[] }): number[] => {
  const { messages, matchIds } = opts;
  const positions = matchIds
    .map(id => messages.findIndex(message => message.id === id))
    .filter(index => index !== -1);
  return positions.sort((left, right) => left - right);
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

    // M1b-2 Task 4: dd/yy/cc, and any d/y/c + motion (they produce the exact
    // same action shape, per vim-engine.ts's resolveUnderOperator), all land
    // here now. Delete and change are routed through applyAction
    // recursively rather than a copy of their patch, so a later change to
    // delete's confirmation or edit's refusal can never drift between the
    // two paths that reach them.
    case ActionTypes.OPERATOR_APPLY: {
      switch (action.operator) {
        // dd, 3dd and d+motion all still gate on delete.request's own
        // confirmation -- operators must not become a way around it
        // (M1b-1's guarantee). The range's own extent (action.from/to) is
        // deliberately not consulted: only the message at the cursor is
        // ever named in the prompt. Acting on the full range would mean
        // confirming and deleting more than one message from a single y/n
        // answer -- a new pendingConfirmation shape, and a loop in App's
        // CONFIRM handling -- a bigger feature than doubling itself asks
        // for, not a side effect of it.
        case Operators.DELETE: {
          // The range, clamped exactly as YANK clamps its own: `3dd` on the
          // second-to-last message asks for three and can only have two, and
          // vim deletes what is there rather than refusing. The prompt counts
          // what it really found, so it cannot promise a third.
          const start = clamp({ value: state.messageCursor + action.from, maximum: state.messages.length - 1 });
          const end = clamp({ value: state.messageCursor + action.to, maximum: state.messages.length - 1 });
          const targeted = state.messages.slice(start, end + 1);
          if (targeted.length === 0) {
            return {};
          }
          const requested = buildDeleteConfirmation({ messages: targeted });
          // M1b-2 Task 5, decision 1: unlike Task 4's deliberate no-op,
          // delete now also writes the targeted message into a register --
          // real vim's own unnamed register captures a delete exactly as it
          // captures a yank, and leaving dd the one operator that never
          // populated any register would silently break the single most
          // common reason a vim user reaches for dd at all: dd then (Task
          // 6+ paste) p to move a message. Written here, at resolution
          // time, rather than gated on the y/n confirmation that follows:
          // the register is a harmless, local, freely-overwritable value,
          // unlike the confirmation, which guards the one irreversible,
          // networked effect. A cancelled dd still "copies" the message --
          // real vim has no confirmation step to cancel in the first place,
          // so this is a new question tglow's own confirmation raises, not
          // one vim already answers, and a local copy costs nothing to keep.
          // The whole range, joined the way a ranged yank joins one: vim's
          // `3dd` puts three lines in the unnamed register, not the first.
          //
          // The action's own register wins over ambient engine state, which is
          // what makes `.` replay the name the original change used: by the
          // time a repeat resolves, nothing has been typed before it, so
          // state.engine.register is null. Falls back to the engine for the
          // keymap-driven `dd`, whose action carries no register at all.
          const name = action.register ?? state.engine.register ?? UNNAMED_REGISTER;
          return {
            ...requested,
            registers: { ...state.registers, [name]: targeted.map(message => message.text).join('\n') },
          };
        }

        // cc: vim's change is delete-then-insert; the message equivalent
        // already exists as edit.start, refusal included. Like delete,
        // only the message at the cursor is targeted regardless of the
        // range's extent -- there is no such thing as changing several
        // messages into one edit.
        case Operators.CHANGE: {
          return applyAction({ state, action: { type: ActionTypes.EDIT_START } });
        }

        // Yanking is not destructive, so unlike delete and change there is
        // nothing to confirm and no reason to limit it to the cursor's own
        // message: the full range is honoured, its messages joined the way
        // vim joins a multi-line yank into one register value -- named
        // (state.engine.register) when a "-prefix set one, UNNAMED_REGISTER
        // otherwise (M1b-2 Task 5).
        case Operators.YANK: {
          const start = clamp({ value: state.messageCursor + action.from, maximum: state.messages.length - 1 });
          const end = clamp({ value: state.messageCursor + action.to, maximum: state.messages.length - 1 });
          const targeted = state.messages.slice(start, end + 1);
          if (targeted.length === 0) {
            return {};
          }
          const label = targeted.length === 1 ? '1 message' : `${targeted.length} messages`;
          const name = action.register ?? state.engine.register ?? UNNAMED_REGISTER;
          return {
            registers: { ...state.registers, [name]: targeted.map(message => message.text).join('\n') },
            statusMessage: `Yanked ${label}`,
          };
        }

        default: {
          throw getError({
            message: `[action-reducer][applyAction] Unknown operator | Operator: ${(action as { operator: string }).operator}`,
          });
        }
      }
    }

    // M1b-2 Task 5: the status line's only sign a register was even named --
    // naming one moves no cursor and changes no mode, so without this it
    // would look exactly like a dead key, the same class of bug yy's own
    // status message above and <S-k>'s "no link" message below already
    // exist to avoid. engine.register itself is already set by the time
    // this runs (vim-engine.ts's resolve() sets it directly, read here off
    // state.engine which app.tsx's commitResolution keeps in sync), so this
    // case only has a status message to add, nothing to patch onto engine.
    case ActionTypes.REGISTER_SET: {
      return { statusMessage: `Register: ${action.name}` };
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
      //
      // chatPickerQuery/chatPickerCursor/searchQuery reset unconditionally
      // alongside it -- harmless for whichkey, which never reads any of them,
      // and what lets a fresh <C-p> or `/` always open onto an empty query
      // rather than whatever was typed the last time. The picker's and
      // search's own escape and Enter (app.tsx) close their overlay by
      // setting `overlay` directly rather than through this action, so each
      // resets its own fields itself on the way out.
      return {
        overlay: state.overlay === action.overlay ? null : action.overlay,
        chatPickerQuery: '',
        chatPickerCursor: 0,
        searchQuery: '',
        // Only the transition INTO 'search' needs this snapshot -- and this
        // case can only ever be reached with action.overlay === 'search' from
        // outside it (state.overlay !== 'search' already), since app.tsx's
        // own overlay-swallow block intercepts every key, including a second
        // `/`, once the search overlay actually owns input (mirrors
        // chatpicker's own equivalent guarantee). searchCursorBeforeOpen is
        // what the search overlay's own <escape> (app.tsx) restores
        // messageCursor from.
        searchCursorBeforeOpen: action.overlay === 'search' ? state.messageCursor : null,
      };
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

    // M1b-2 Task 9: n/N. Always relative to the *current* messageCursor, not
    // to whichever match a previous cycle landed on -- the same fidelity real
    // vim's own n/N have (a manual j/k in between still counts). Enter itself
    // (app.tsx) does not route through this case -- it always jumps to
    // positions[0], the topmost loaded match, regardless of where the cursor
    // already was -- but shares resolveSearchMatchIndices with it above, so
    // the two can never disagree about what a committed search's ids
    // currently resolve to. Wraps around in both directions here, vim's own
    // 'wrapscan' default; Enter has no "wrap" case of its own to need one.
    case ActionTypes.SEARCH_CYCLE: {
      const positions = resolveSearchMatchIndices({ messages: state.messages, matchIds: state.searchMatchIds });
      if (positions.length === 0) {
        return {};
      }
      if (action.direction === 'next') {
        const next = positions.find(position => position > state.messageCursor);
        return { messageCursor: next ?? positions[0] };
      }
      const previous = [...positions].reverse().find(position => position < state.messageCursor);
      return { messageCursor: previous ?? positions[positions.length - 1] };
    }

    /**
     * `zn` and `zt`. Switching a rail field off gives its columns back to the
     * conversation rather than blanking them in place, so this is as much a
     * way to widen the text as to quieten the margin.
     */
    case ActionTypes.DISPLAY_TOGGLE: {
      return action.field === 'gutter'
        ? { showGutter: !state.showGutter }
        : { showTime: !state.showTime };
    }

    /**
     * `]f`/`[f`. Wraps in both directions, the same way SEARCH_CYCLE does --
     * a rail you can fall off the end of would need a "you are at the last
     * folder" message nobody wants to read.
     *
     * The chat cursor goes back to the top. It indexes the *filtered* list, so
     * leaving it where it was would point at a different chat than the one the
     * user was looking at, or past the end of a smaller folder entirely.
     */
    case ActionTypes.FOLDER_CYCLE: {
      if (state.folders.length === 0) {
        return {};
      }
      const current = state.folders.findIndex(folder => folder.id === state.activeFolderId);
      const from = current === -1 ? 0 : current;
      const count = state.folders.length;
      // `% count` twice with a `+ count` between: JavaScript's remainder keeps
      // the sign of the dividend, so a plain modulo goes negative on `[f`.
      const next = (((from + action.delta) % count) + count) % count;
      return { activeFolderId: state.folders[next]!.id, chatCursor: 0 };
    }

    // The only thing that clears integrityWarning. Nothing else may: the field
    // exists precisely because statusMessage is cleared as a matter of course
    // by loadHistory/send/edit/delete, which is how "some missed messages
    // could not be saved" was erased before the user ever saw it.
    case ActionTypes.WARNING_DISMISS: {
      return { integrityWarning: null };
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
        // Captured only when no edit is already under way. Unconditionally,
        // a second `e` overwrote the saved draft with the *first* message's
        // own text, so the <escape> that cancels restored that instead --
        // `e` `jk` `e` `<escape>` destroyed the very draft this field exists
        // to protect.
        composerTextBeforeEdit: state.editingMessageId === null
          ? state.composerText
          : state.composerTextBeforeEdit,
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
      return buildDeleteConfirmation({ messages: [message] });
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
    case ActionTypes.PIN_TOGGLE:
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
