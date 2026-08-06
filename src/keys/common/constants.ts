import type { IEngineState } from './types.ts';

/** Vim modes. A static-readonly class rather than an enum — enums are not tree-shakable. */
export class VimModes {
  static readonly NORMAL = 'normal';
  static readonly INSERT = 'insert';
  static readonly VISUAL = 'visual';
  static readonly COMMAND = 'command';
  static readonly SEARCH = 'search';
}

export type TVimMode = (typeof VimModes)[Exclude<keyof typeof VimModes, 'prototype'>];

/** Which pane currently owns the cursor. */
export class VimContexts {
  static readonly CHAT_LIST = 'chatlist';
  static readonly MESSAGES = 'messages';
  static readonly COMPOSER = 'composer';
}

export type TVimContext = (typeof VimContexts)[Exclude<keyof typeof VimContexts, 'prototype'>];

/**
 * The three operators that compose with a motion -- vim-engine.ts treats
 * `d`/`y`/`c` as their triggers intrinsically, the same way it treats
 * digits as counts, so no keymap entry names these directly.
 */
export class Operators {
  static readonly DELETE = 'delete';
  static readonly YANK = 'yank';
  static readonly CHANGE = 'change';
}

export type TOperator = (typeof Operators)[Exclude<keyof typeof Operators, 'prototype'>];

/**
 * `"`, vim's own name for both the key that opens register-pending
 * (vim-engine.ts) and the unnamed register an unprefixed yank or delete
 * writes to (action-reducer.ts, IApplicationState.registers) -- one
 * character playing both roles, exactly as real vim overloads it. A plain
 * constant, not a static-readonly class: it names a single value, not an
 * enumerable family the way Operators/VimModes/VimContexts each do.
 */
export const UNNAMED_REGISTER = '"';

/**
 * `+`, vim's own name for the system-clipboard register (M1b-2 Task 6). An
 * ordinary register name everywhere register state itself lives
 * (IEngineState.register, IApplicationState.registers, this file's own
 * REGISTER_NAME_PATTERN counterpart in vim-engine.ts) -- the one name App
 * gives an OSC 52 side effect once an operator actually writes to it
 * (app.tsx's commitResolution), not a different shape here.
 */
export const CLIPBOARD_REGISTER = '+';

export class ActionTypes {
  static readonly CURSOR_MOVE = 'cursor.move';
  static readonly CURSOR_EDGE = 'cursor.edge';
  static readonly OPERATOR_APPLY = 'operator.apply';
  static readonly REGISTER_SET = 'register.set';
  static readonly MODE_SET = 'mode.set';
  static readonly FOCUS_SET = 'focus.set';
  static readonly CHAT_OPEN = 'chat.open';
  static readonly COMPOSER_SEND = 'composer.send';
  static readonly COMPOSER_INSERT_TEXT = 'composer.insertText';
  static readonly COMPOSER_BACKSPACE = 'composer.backspace';
  static readonly APPLICATION_QUIT = 'application.quit';
  static readonly OVERLAY_TOGGLE = 'overlay.toggle';
  static readonly SPOILER_REVEAL = 'spoiler.reveal';
  static readonly REPLY_START = 'reply.start';
  static readonly REPLY_CANCEL = 'reply.cancel';
  static readonly EDIT_START = 'edit.start';
  static readonly EDIT_CANCEL = 'edit.cancel';
  static readonly DELETE_REQUEST = 'delete.request';
  static readonly CONFIRM = 'confirmation.confirm';
  static readonly CANCEL_CONFIRMATION = 'confirmation.cancel';
  static readonly LINK_SHOW = 'link.show';
  static readonly WARNING_DISMISS = 'warning.dismiss';
  static readonly SEARCH_CYCLE = 'search.cycle';
  /** Moves the sidebar to the next or previous chat folder. */
  static readonly FOLDER_CYCLE = 'folder.cycle';
}

const SUPPORTED_MODES: readonly string[] = [
  VimModes.NORMAL,
  VimModes.INSERT,
  VimModes.VISUAL,
  VimModes.COMMAND,
  VimModes.SEARCH,
];

export const isVimMode = (value: string): value is TVimMode => {
  return SUPPORTED_MODES.includes(value);
};

export const INITIAL_ENGINE_STATE: IEngineState = {
  mode: VimModes.NORMAL,
  context: VimContexts.MESSAGES,
  pending: [],
  count: null,
  operator: null,
  operatorCount: null,
  register: null,
  lastChange: null,
};
