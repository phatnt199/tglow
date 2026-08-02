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
  /** Which full-pane overlay is showing, if any. Orthogonal to engine.context: opening one leaves mode and pane focus exactly as they were. */
  overlay: TOverlay | null;
  /**
   * Ids of messages whose spoilers `zs` has revealed. Not persisted: reopening
   * a chat rebuilds the store from scratch, so a spoiler revealed yesterday is
   * hidden again today, which is the intended behaviour, not a bug to fix.
   */
  revealedSpoilers: Set<number>;
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
  overlay: null,
  revealedSpoilers: new Set(),
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
