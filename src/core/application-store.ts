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
  connection: TConnectionState;
  statusMessage: string | null;
  /** Which full-pane overlay is showing, if any. Orthogonal to engine.context: opening one leaves mode and pane focus exactly as they were. */
  overlay: TOverlay | null;
}

const INITIAL_STATE: IApplicationState = {
  engine: INITIAL_ENGINE_STATE,
  dialogs: [],
  messages: [],
  activePeerId: null,
  chatCursor: 0,
  messageCursor: 0,
  composerText: '',
  connection: 'offline',
  statusMessage: null,
  overlay: null,
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
