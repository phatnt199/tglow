import type { ActionTypes, TVimContext, TVimMode } from './constants.ts';

/** A key press, normalised away from any specific terminal library. */
export interface IKey {
  name: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

/** The shape OpenTUI's KeyEvent gives us, declared structurally so keys/ stays free of OpenTUI. */
export interface IRawKeyEvent {
  name: string;
  ctrl: boolean;
  meta: boolean;
  option: boolean;
  shift: boolean;
}

export type TCursorUnit = 'message' | 'chat';
export type TCursorEdge = 'first' | 'last';

export type TAction =
  | { type: typeof ActionTypes.CURSOR_MOVE; unit: TCursorUnit; delta: number }
  | { type: typeof ActionTypes.CURSOR_EDGE; unit: TCursorUnit; edge: TCursorEdge }
  | { type: typeof ActionTypes.MODE_SET; mode: TVimMode }
  | { type: typeof ActionTypes.FOCUS_SET; context: TVimContext }
  | { type: typeof ActionTypes.CHAT_OPEN }
  | { type: typeof ActionTypes.COMPOSER_SEND }
  | { type: typeof ActionTypes.COMPOSER_INSERT_TEXT; text: string }
  | { type: typeof ActionTypes.COMPOSER_BACKSPACE }
  | { type: typeof ActionTypes.APPLICATION_QUIT };

export interface IEngineState {
  mode: TVimMode;
  context: TVimContext;
  /** Canonical key strings accumulated toward a multi-key binding, for example "g". */
  pending: string;
  /** The 3 in 3j. Null when no count has been typed. */
  count: number | null;
}

export interface IKeyBinding {
  context: TVimContext | '*';
  mode: TVimMode | TVimMode[];
  /** Canonical form: "j", "gg", "<C-p>". */
  keys: string;
  /** Count-aware so 3j yields a single delta-3 action. */
  action: (count: number) => TAction[];
  /** Shown in the which-key popup; every binding must have one. */
  description: string;
}

export type TResolveStatus = 'pending' | 'resolved' | 'unmapped';

export interface IResolveResult {
  state: IEngineState;
  actions: TAction[];
  status: TResolveStatus;
}
