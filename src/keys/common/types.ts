import type { ActionTypes, TOperator, TVimContext, TVimMode } from './constants.ts';

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
/** The two overlays that exist. A union of bare literals, like TCursorUnit/TCursorEdge above, not a class: nothing else keys off it. */
export type TOverlay = 'whichkey' | 'chatpicker';

export type TAction =
  | { type: typeof ActionTypes.CURSOR_MOVE; unit: TCursorUnit; delta: number }
  | { type: typeof ActionTypes.CURSOR_EDGE; unit: TCursorUnit; edge: TCursorEdge }
  | { type: typeof ActionTypes.OPERATOR_APPLY; operator: TOperator; unit: TCursorUnit; from: number; to: number }
  | { type: typeof ActionTypes.REGISTER_SET; name: string }
  | { type: typeof ActionTypes.MODE_SET; mode: TVimMode }
  | { type: typeof ActionTypes.FOCUS_SET; context: TVimContext }
  | { type: typeof ActionTypes.CHAT_OPEN }
  | { type: typeof ActionTypes.COMPOSER_SEND }
  | { type: typeof ActionTypes.COMPOSER_INSERT_TEXT; text: string }
  | { type: typeof ActionTypes.COMPOSER_BACKSPACE }
  | { type: typeof ActionTypes.APPLICATION_QUIT }
  | { type: typeof ActionTypes.OVERLAY_TOGGLE; overlay: TOverlay }
  | { type: typeof ActionTypes.SPOILER_REVEAL }
  | { type: typeof ActionTypes.REPLY_START }
  | { type: typeof ActionTypes.REPLY_CANCEL }
  | { type: typeof ActionTypes.EDIT_START }
  | { type: typeof ActionTypes.EDIT_CANCEL }
  | { type: typeof ActionTypes.DELETE_REQUEST }
  | { type: typeof ActionTypes.CONFIRM }
  | { type: typeof ActionTypes.CANCEL_CONFIRMATION }
  | { type: typeof ActionTypes.LINK_SHOW }
  | { type: typeof ActionTypes.WARNING_DISMISS };

export interface IEngineState {
  mode: TVimMode;
  context: TVimContext;
  /**
   * Canonical key tokens accumulated toward a multi-key binding, for example
   * ["g"]. An array of whole tokens, not a concatenated string: a bracketed
   * group like "<escape>" is one token no matter how many characters it
   * takes to write, so a typed "<" (also one token) can never be mistaken
   * for a prefix of it.
   */
  pending: string[];
  /** The 3 in 3j. Null when no count has been typed. */
  count: number | null;
  /** The operator waiting for a motion -- `d`, `y`, `c` -- or null when none is pending. */
  operator: TOperator | null;
  /**
   * The count that was pending when the operator committed (the 2 in
   * 2d3j), kept apart from `count` so a motion's own count (the 3)
   * multiplies against it -- vim's own rule -- rather than the two
   * colliding in one field. `count` itself resets to null the moment the
   * operator commits, so a motion's count still accumulates the ordinary
   * way. Null whenever operator is, and whenever no count preceded it.
   */
  operatorCount: number | null;
  /**
   * The named register a `"` press is naming, or has named, for the next
   * operator to consume -- `a` in `"ayy`, or null for the default register
   * (an unnamed yy/dd). Consumed (reset to null) the moment an operator
   * actually applies, exactly like operator/operatorCount reset once their
   * own operation commits: a name is part of the sequence being assembled,
   * not a value that should outlive it. IApplicationState.registers (M1b-2
   * Task 5) is where a consumed name's text actually lands; this field
   * only ever holds the name itself.
   */
  register: string | null;
  /**
   * The actions the most recent operator application produced -- what `.`
   * re-emits (M1b-2 Task 7). Set only when an OPERATOR_APPLY actually
   * resolves (vim-engine.ts's recordChange), never for a motion alone, which
   * is what keeps `.` from repeating mere cursor movement. Survives a
   * cancelled delete confirmation unchanged: it is written the instant the
   * engine resolves OPERATOR_APPLY, before App ever asks y/n, the same
   * timing Task 5's register write already relies on ("a cancelled dd still
   * copies the message").
   */
  lastChange: TAction[] | null;
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

export type TResolveStatus = 'pending' | 'resolved' | 'unmapped' | 'ambiguous';

export interface IResolveResult {
  state: IEngineState;
  actions: TAction[];
  status: TResolveStatus;
}
