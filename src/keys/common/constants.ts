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

export class ActionTypes {
  static readonly CURSOR_MOVE = 'cursor.move';
  static readonly CURSOR_EDGE = 'cursor.edge';
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
};
