import { ApplicationLogger, type ILogger } from '@venizia/ignis-helpers';

import { INITIAL_ENGINE_STATE, type IEngineState, type TOverlay } from '../keys/common/index.ts';
import type { IDialogRow, IMessageRow } from './cache/index.ts';

export type TConnectionState = 'offline' | 'connecting' | 'connected';

export interface IApplicationState {
  engine: IEngineState;
  dialogs: IDialogRow[];
  messages: IMessageRow[];
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
   * Set by DELETE_REQUEST -- which `dd`/`3dd` and any d+motion delete all
   * route through (M1b-2 Task 4), never bypass -- while the status line
   * waits for y/n; null once answered either way. The only irreversible
   * action in the app gates on this being non-null: App checks it before
   * engine resolution, the same category of App-level gate as `overlay` and
   * the reply/edit escapes above, and swallows every key except y, n and
   * escape while it is set.
   */
  pendingConfirmation: { kind: 'delete'; messageId: number } | null;
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
  messages: [],
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
