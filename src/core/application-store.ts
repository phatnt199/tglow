import { ApplicationLogger, type ILogger } from '@venizia/ignis-helpers';

import { INITIAL_ENGINE_STATE, type IEngineState, type TOverlay } from '../keys/common/index.ts';
import type { IDialogRow, IFolderRow, IMessageRow } from './cache/index.ts';
import type { IPresence } from './presence.ts';
import type { IImageCell } from '../tui/image-renderer.ts';
import type { IActiveTyping } from './typing-status.ts';
import { createGrid, type IPanePosition, type TPaneGrid } from './conversation-panes.ts';
import type { IAvailableUpdate } from './updater.ts';

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
   * The folder section's height in rows, or null for "as many as the folders
   * need". Set by dragging the divider between the folders and the chat list.
   *
   * Not persisted, same as sidebarWidth and for the same reason -- see there.
   */
  folderHeight: number | null;
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
  /**
   * Who is online, and when each was last seen.
   *
   * Alongside the dialogs rather than on them: presence changes far more often
   * than a chat's own row does, and a live status update should not have to
   * rewrite the chat list to be seen.
   */
  presenceByPeer: Map<string, IPresence>;
  /**
   * The drawn picture for a message at a width, keyed by both.
   *
   * Cells rather than bytes: the bytes live on disk and are decoded once per
   * pane width, and keeping megabytes of JPEG in application state to redo
   * that work on every render would be the wrong half to remember.
   *
   * The width is in the key because chafa renders to a fixed number of cells,
   * so one photograph at 40 columns and the same one at 80 are two different
   * results. Keyed by message id alone -- which is what this was -- splitting
   * the screen halved every pane and left the pre-split cells in place, to be
   * drawn into a pane that could not hold them. See tui/image-layout.ts.
   */
  imagesByKey: Map<string, IImageCell[][]>;
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
  /**
   * The conversation panes on screen: columns left to right, each a stack of
   * conversations top to bottom.
   *
   * The focused pane's slot here is a snapshot that goes stale the moment it
   * takes the focus: its live conversation is `activePeerId`/`messages`/
   * `messageCursor` and the composer fields below, exactly where they were
   * when there was only ever one conversation. Anything that needs every
   * pane's *current* state has to merge the two with `withActive` from
   * core/conversation-panes.ts, which is where the whole arrangement is
   * explained.
   */
  paneGrid: TPaneGrid;
  /** Which pane the conversation fields below belong to. */
  activePane: IPanePosition;
  /**
   * How many columns the conversation area has, sidebar and frame already
   * taken off.
   *
   * In state purely so splitting can refuse before it happens. The reducer is
   * a pure function of state and has no terminal to measure, and a split that
   * only discovered there was no room at render time would already have
   * created the pane it could not draw. App writes this whenever the terminal
   * or the sidebar changes size.
   */
  conversationWidth: number;
  /** The same, down the page, for deciding whether another row fits. */
  conversationHeight: number;
  activePeerId: string | null;
  chatCursor: number;
  messageCursor: number;
  composerText: string;
  /**
   * Where the caret is in the composer, counted in *graphemes*.
   *
   * Graphemes rather than code units because Vietnamese decomposes: `ế` can be
   * two code points, and a caret counting units lands inside the letter -- so
   * a backspace there takes the diacritic off and leaves it attached to
   * whatever came before. Before this existed the composer could only be
   * appended to and trimmed from the end, so fixing a typo in the middle of a
   * message meant retyping everything after it.
   */
  composerCursor: number;
  /** The message `r` targeted, or null when no reply is pending. Cleared on a successful send and on escape; preserved on a failed send. */
  replyToMessageId: number | null;
  /** The message `e` is editing, or null when no edit is in progress. EDIT_START refuses to set this at all when the target's `out !== 1` -- you cannot edit someone else's message. Cleared on a successful edit and on the escape that cancels one; preserved on a failed edit. */
  editingMessageId: number | null;
  /** What composerText held the instant before EDIT_START overwrote it with the message's own text. Restored by the escape that cancels an edit, so an accidental `e` never costs the user a draft; null whenever editingMessageId is null. */
  composerTextBeforeEdit: string | null;
  /**
   * The caret that went with composerTextBeforeEdit.
   *
   * Snapshotting the draft and not its caret restores only half of what was
   * taken: a caret deliberately parked at the front of a sentence came back at
   * the end of it, and the next character typed went to the wrong place. The
   * text and the caret are one fact in two fields everywhere else in this
   * store, and this is the pair that keeps that true across a cancelled edit.
   */
  composerCursorBeforeEdit: number | null;
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
  /**
   * The newer release tglow knows about, or null.
   *
   * Set by the once-a-day check, and by `:update` when it looks. Only ever a
   * statement that something exists -- installing it is `:update`'s own doing,
   * never this field's arrival.
   */
  availableUpdate: IAvailableUpdate | null;
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
   * What choosing a chat in the picker does: open it, or forward the message
   * under the cursor into it.
   *
   * One picker rather than two: choosing a chat is the same gesture with the
   * same fuzzy match and the same keys, and a second overlay that looked
   * identical would be a second place for those to drift. Reset to 'open'
   * whenever any overlay opens or closes, so a cancelled forward cannot leave
   * the next <C-p> forwarding instead of opening.
   */
  chatPickerPurpose: 'open' | 'forward';
  /** The message a forward is about, snapshotted when the picker opened -- the cursor can move under a still-open overlay. */
  forwardMessageId: number | null;
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
   * What has been typed after the `:` while the command line is open. The
   * colon itself is the overlay's, not the query's -- it cannot be deleted,
   * exactly as vim's own command line behaves.
   *
   * Reset to '' whenever any overlay opens or closes, mirroring
   * chatPickerQuery and searchQuery: a command typed in a previous session of
   * it must never leak into the next.
   */
  commandQuery: string;
  /**
   * Set by DELETE_REQUEST -- which `dd`/`3dd` and any d+motion delete all
   * route through (M1b-2 Task 4), never bypass -- while the status line
   * waits for y/n; null once answered either way. The only irreversible
   * action in the app gates on this being non-null: App checks it before
   * engine resolution, the same category of App-level gate as `overlay` and
   * the reply/edit escapes above, and swallows every key except y, n and
   * escape while it is set.
   */
  pendingConfirmation:
    | { kind: 'delete'; messageIds: number[] }
    // `:logout` is the second thing in tglow that cannot be undone, and the
    // first that cannot be undone from inside tglow at all -- signing back in
    // means the phone-and-code flow again. It asks the same y/n the only other
    // irreversible action does, through the same field, so there is one place
    // that can ever be answered rather than two.
    | { kind: 'logout' }
    | null;
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
  folderHeight: null,
  showGutter: true,
  showTime: true,
  contextMenu: null,
  peerKinds: new Map(),
  typingByPeer: new Map(),
  presenceByPeer: new Map(),
  imagesByKey: new Map(),
  messages: [],
  loadingOlder: false,
  reachedOldest: false,
  // One pane, holding nothing, which is what tglow looked like before it
  // could hold more than one.
  paneGrid: createGrid(),
  activePane: { column: 0, row: 0 },
  // Corrected by App on its first frame; nothing splits before then.
  conversationWidth: 0,
  conversationHeight: 0,
  activePeerId: null,
  chatCursor: 0,
  messageCursor: 0,
  composerText: '',
  composerCursor: 0,
  replyToMessageId: null,
  editingMessageId: null,
  composerTextBeforeEdit: null,
  composerCursorBeforeEdit: null,
  connection: 'offline',
  statusMessage: null,
  integrityWarning: null,
  availableUpdate: null,
  overlay: null,
  chatPickerQuery: '',
  chatPickerCursor: 0,
  chatPickerPurpose: 'open',
  forwardMessageId: null,
  searchQuery: '',
  searchMatchIds: [],
  searchCursorBeforeOpen: null,
  commandQuery: '',
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
