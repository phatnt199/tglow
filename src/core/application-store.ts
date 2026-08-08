import { ApplicationLogger, type ILogger } from '@venizia/ignis-helpers';

import { INITIAL_ENGINE_STATE, type IEngineState, type TOverlay } from '../keys/common/index.ts';
import type { IDialogRow, IFolderRow, IMessageRow } from './cache/index.ts';
import type { IActiveTyping } from './typing-status.ts';

export type TConnectionState = 'offline' | 'connecting' | 'connected';

export interface IApplicationState {
  engine: IEngineState;
  dialogs: IDialogRow[];
  /**
   * The account's chat folders, "All" first. Telegram does not send that one --
   * it is the absence of a filter -- but every client shows it, and without it
   * there is no way back to the unfiltered list.
   */
  folders: IFolderRow[];
  /** Which folder the sidebar is showing. ALL_CHATS_FOLDER_ID means no filtering. */
  activeFolderId: number;
  /**
   * The sidebar's width in columns, or null for the built-in default. Set by
   * dragging the divider between the panes.
   *
   * Not persisted. Writing it back would mean rewriting config.toml, and the
   * TOML reader tglow uses preserves neither comments nor formatting -- a
   * round-trip would quietly destroy a hand-edited file, which is a far worse
   * outcome than re-dragging a divider once per session.
   */
  sidebarWidth: number | null;
  /**
   * The conversation's relative-number gutter and its clock, each switchable
   * with `zn` and `zt`. vim's own `z` is the view prefix, and this project
   * already treats it as one -- `zs` reveals a spoiler.
   *
   * Runtime state rather than configuration: these are the sort of thing you
   * flip to read one wide message and flip back, not a preference to write
   * down. A hidden field also gives its columns back to the conversation, so
   * turning both off is a way to widen the text rather than only to quieten it.
   */
  showGutter: boolean;
  showTime: boolean;
  /**
   * The open right-click menu, or null. `target` is an index into whichever
   * list the menu was opened over -- messages for a message menu, the visible
   * dialogs for a chat menu -- resolved to an actual row only when an item is
   * chosen, so a list that changed underneath cannot act on a stale object.
   */
  contextMenu: {
    kind: 'message' | 'chat';
    target: number;
    x: number;
    y: number;
    cursor: number;
  } | null;
  /**
   * Peer type and bot-ness, which folder membership needs and IDialogRow does
   * not carry. Published alongside the folders rather than looked up per
   * render: App is a pure function of state and has no database of its own.
   */
  peerKinds: Map<string, { type: string; isBot: boolean }>;
  /**
   * Who is typing, recording or choosing a sticker, per chat. Carries its own
   * expiry: Telegram re-sends an action every few seconds while it continues,
   * so one left behind by someone who closed their app must go stale rather
   * than sit in the sidebar claiming something about the present that has
   * quietly become false.
   */
  typingByPeer: Map<string, IActiveTyping>;
  messages: IMessageRow[];
  /**
   * True while an older page is in flight.
   *
   * Reaching the top of the loaded history asks for the page before it, and
   * the cursor stays there while the request runs -- so without this, every
   * key press near the top would ask again, and a slow connection would queue
   * a dozen identical fetches whose replies then each shift the cursor.
   */
  loadingOlder: boolean;
  /**
   * True once the chat's very first message is loaded: there is nothing older
   * to ask for, and asking anyway would be a round trip per keystroke at the
   * top of every short conversation.
   *
   * Reset by loadHistory, since it is a claim about the open chat rather than
   * about the application.
   */
  reachedOldest: boolean;
  activePeerId: string | null;
  chatCursor: number;
  messageCursor: number;
  composerText: string;
  /** The message `r` targeted, or null when no reply is pending. Cleared on a successful send and on escape; preserved on a failed send. */
  replyToMessageId: number | null;
  /** The message `e` is editing, or null when no edit is in progress. EDIT_START refuses to set this at all when the target's `out !== 1` -- you cannot edit someone else's message. Cleared on a successful edit and on the escape that cancels one; preserved on a failed edit. */
  editingMessageId: number | null;
  /** What composerText held the instant before EDIT_START overwrote it with the message's own text. Restored by the escape that cancels an edit, so an accidental `e` never costs the user a draft; null whenever editingMessageId is null. */
  composerTextBeforeEdit: string | null;
  connection: TConnectionState;
  statusMessage: string | null;
  /**
   * The one status the user must not be able to miss: messages were, or may
   * have been, lost. Its own field rather than a severity on statusMessage
   * because statusMessage is *routinely* cleared -- loadHistory, send, edit and
   * delete all patch it to null on success -- and main.ts calls loadHistory
   * immediately after catch-up, so a data-integrity warning written to
   * statusMessage was erased before the first frame every single time. Nothing
   * clears this but the user, with <C-l>.
   */
  integrityWarning: string | null;
  /** Which full-pane overlay is showing, if any. Orthogonal to engine.context: opening one leaves mode and pane focus exactly as they were. */
  overlay: TOverlay | null;
  /**
   * The text typed into the `<C-p>` chat picker while it is open, and the
   * fuzzy-matched result its cursor is currently on. Meaningless while
   * `overlay !== 'chatpicker'`, and reset to '' / 0 every time the picker
   * opens or closes (action-reducer.ts's OVERLAY_TOGGLE case, and the
   * picker's own escape/Enter in app.tsx) so a query typed in a previous
   * session of it can never leak into the next.
   */
  chatPickerQuery: string;
  chatPickerCursor: number;
  /**
   * The text typed into the `/` search overlay while it is open (M1b-2
   * Task 9). Meaningless while `overlay !== 'search'`; reset to '' whenever
   * any overlay opens or closes (mirroring chatPickerQuery's own reset),
   * since nothing outside the overlay itself ever reads it.
   */
  searchQuery: string;
  /**
   * The ids of the messages a committed search last matched -- written once,
   * by app.tsx's own handling of the Enter that closes the search overlay,
   * never by the reducer directly. Ids, not positions in state.messages: n/N
   * (SEARCH_CYCLE, action-reducer.ts) re-resolve each id to its *current*
   * index on every cycle, so a message that moved or was deleted since the
   * search was committed is dropped rather than pointing the cursor at the
   * wrong row. Survives the overlay closing -- unlike searchQuery, this is
   * exactly what n/N need once it has.
   */
  searchMatchIds: number[];
  /**
   * `messageCursor` at the instant the search overlay opened, so its own
   * `<escape>` (app.tsx) can put the cursor back exactly where it was --
   * the same "snapshot before, restore on cancel" shape
   * composerTextBeforeEdit already uses for edit.start/edit.cancel. Null
   * whenever no search is open, and cleared (not merely left stale) the
   * moment escape restores it or Enter commits a jump away from it.
   */
  searchCursorBeforeOpen: number | null;
  /**
   * Set by DELETE_REQUEST -- which `dd`/`3dd` and any d+motion delete all
   * route through (M1b-2 Task 4), never bypass -- while the status line
   * waits for y/n; null once answered either way. The only irreversible
   * action in the app gates on this being non-null: App checks it before
   * engine resolution, the same category of App-level gate as `overlay` and
   * the reply/edit escapes above, and swallows every key except y, n and
   * escape while it is set.
   */
  pendingConfirmation: { kind: 'delete'; messageIds: number[] } | null;
  /**
   * Ids of messages whose spoilers `zs` has revealed. Not persisted: reopening
   * a chat rebuilds the store from scratch, so a spoiler revealed yesterday is
   * hidden again today, which is the intended behaviour, not a bug to fix.
   */
  revealedSpoilers: Set<number>;
  /**
   * Named registers, vim's own `"`-prefixed scheme (M1b-2 Task 5): `"ayy`
   * (or `"add`) writes `registers.a`; an unprefixed yy or dd goes to
   * `registers[UNNAMED_REGISTER]` (`registers['"']`), vim's own name for
   * the unnamed register. The pending name a `"` press is still choosing
   * lives on `engine.register` instead -- it is part of the key sequence
   * being assembled, not a value any operator has actually written yet.
   * `+` is an ordinary key here too; Task 6 gives it an OSC 52 side effect,
   * not a different shape.
   */
  registers: Record<string, string>;
}

const INITIAL_STATE: IApplicationState = {
  engine: INITIAL_ENGINE_STATE,
  dialogs: [],
  folders: [],
  activeFolderId: 0,
  sidebarWidth: null,
  showGutter: true,
  showTime: true,
  contextMenu: null,
  peerKinds: new Map(),
  typingByPeer: new Map(),
  messages: [],
  loadingOlder: false,
  reachedOldest: false,
  activePeerId: null,
  chatCursor: 0,
  messageCursor: 0,
  composerText: '',
  replyToMessageId: null,
  editingMessageId: null,
  composerTextBeforeEdit: null,
  connection: 'offline',
  statusMessage: null,
  integrityWarning: null,
  overlay: null,
  chatPickerQuery: '',
  chatPickerCursor: 0,
  searchQuery: '',
  searchMatchIds: [],
  searchCursorBeforeOpen: null,
  pendingConfirmation: null,
  revealedSpoilers: new Set(),
  registers: {},
};

export class ApplicationStoreService {
  private readonly _logger: ILogger = ApplicationLogger.get(ApplicationStoreService.name);
  private readonly _listeners = new Set<() => void>();
  private _state: IApplicationState = INITIAL_STATE;

  getState = (): IApplicationState => {
    return this._state;
  };

  setState = (opts: { patch: Partial<IApplicationState> }): void => {
    this._state = { ...this._state, ...opts.patch };

    for (const listener of this._listeners) {
      try {
        listener();
      } catch (error) {
        // One bad subscriber must not stop the rest of the UI updating.
        this._logger.for(this.setState.name).error('Listener threw | Reason: %s', error);
      }
    }
  };

  subscribe = (opts: { listener: () => void }): (() => void) => {
    this._listeners.add(opts.listener);
    return (): void => {
      this._listeners.delete(opts.listener);
    };
  };
}
