import { ActionTypes, VimContexts, VimModes } from './common/index.ts';
import type { IKeyBinding, TVimContext, TVimMode } from './common/index.ts';

const HALF_PAGE_MESSAGES = 10;

/** The M1a binding table. One table drives dispatch and the which-key popup, so they cannot drift. */
export class KeymapService {
  private readonly _bindings: IKeyBinding[] = [
    // Movement
    {
      context: '*', mode: VimModes.NORMAL, keys: 'j', description: 'Next message',
      action: count => [{ type: ActionTypes.CURSOR_MOVE, unit: 'message', delta: count }],
    },
    {
      context: '*', mode: VimModes.NORMAL, keys: 'k', description: 'Previous message',
      action: count => [{ type: ActionTypes.CURSOR_MOVE, unit: 'message', delta: -count }],
    },
    {
      context: '*', mode: VimModes.NORMAL, keys: 'gg', description: 'Oldest loaded message',
      action: () => [{ type: ActionTypes.CURSOR_EDGE, unit: 'message', edge: 'first' }],
    },
    // OpenTUI lowercases shifted letters into `name` and sets `shift` separately
    // (verified in @opentui/core's parseKeypress), so a real Shift-G press
    // canonicalizes to <S-g>, never bare 'G' -- match that, not vim's own display form.
    {
      context: '*', mode: VimModes.NORMAL, keys: '<S-g>', description: 'Newest message',
      action: () => [{ type: ActionTypes.CURSOR_EDGE, unit: 'message', edge: 'last' }],
    },
    {
      context: '*', mode: VimModes.NORMAL, keys: '<C-d>', description: 'Half page down',
      action: count => [{ type: ActionTypes.CURSOR_MOVE, unit: 'message', delta: HALF_PAGE_MESSAGES * count }],
    },
    {
      context: '*', mode: VimModes.NORMAL, keys: '<C-u>', description: 'Half page up',
      action: count => [{ type: ActionTypes.CURSOR_MOVE, unit: 'message', delta: -HALF_PAGE_MESSAGES * count }],
    },

    // Panes — nf echoes the author's NvimTreeFocus mapping.
    {
      context: '*', mode: VimModes.NORMAL, keys: 'nf', description: 'Focus chat list',
      action: () => [{ type: ActionTypes.FOCUS_SET, context: VimContexts.CHAT_LIST }],
    },
    {
      context: VimContexts.CHAT_LIST, mode: VimModes.NORMAL, keys: 'j', description: 'Next chat',
      action: count => [{ type: ActionTypes.CURSOR_MOVE, unit: 'chat', delta: count }],
    },
    {
      context: VimContexts.CHAT_LIST, mode: VimModes.NORMAL, keys: 'k', description: 'Previous chat',
      action: count => [{ type: ActionTypes.CURSOR_MOVE, unit: 'chat', delta: -count }],
    },
    {
      context: VimContexts.CHAT_LIST, mode: VimModes.NORMAL, keys: '<return>', description: 'Open chat',
      action: () => [
        { type: ActionTypes.CHAT_OPEN },
        { type: ActionTypes.FOCUS_SET, context: VimContexts.MESSAGES },
      ],
    },

    // Mode changes
    {
      context: '*', mode: VimModes.NORMAL, keys: 'i', description: 'Write a message',
      action: () => [
        { type: ActionTypes.FOCUS_SET, context: VimContexts.COMPOSER },
        { type: ActionTypes.MODE_SET, mode: VimModes.INSERT },
      ],
    },
    {
      context: '*', mode: VimModes.NORMAL, keys: 'a', description: 'Write a message',
      action: () => [
        { type: ActionTypes.FOCUS_SET, context: VimContexts.COMPOSER },
        { type: ActionTypes.MODE_SET, mode: VimModes.INSERT },
      ],
    },
    // jk is how this author leaves insert mode; Esc is kept as the vim default.
    {
      context: '*', mode: VimModes.INSERT, keys: 'jk', description: 'Leave insert mode',
      action: () => [{ type: ActionTypes.MODE_SET, mode: VimModes.NORMAL }],
    },
    // Angle brackets, not the bare word: KeyNormalizerService wraps every
    // named key this way precisely so "escape" can never be confused with a
    // pending prefix of the single letter "e" a composer's user types.
    {
      context: '*', mode: VimModes.INSERT, keys: '<escape>', description: 'Leave insert mode',
      action: () => [{ type: ActionTypes.MODE_SET, mode: VimModes.NORMAL }],
    },
    {
      context: '*', mode: VimModes.INSERT, keys: '<return>', description: 'Send message',
      action: () => [{ type: ActionTypes.COMPOSER_SEND }],
    },
    {
      context: '*', mode: VimModes.INSERT, keys: '<backspace>', description: 'Delete character',
      action: () => [{ type: ActionTypes.COMPOSER_BACKSPACE }],
    },

    // Application
    {
      context: '*', mode: VimModes.NORMAL, keys: '<C-c>', description: 'Quit',
      action: () => [{ type: ActionTypes.APPLICATION_QUIT }],
    },
  ];

  getBindings = (): IKeyBinding[] => {
    return this._bindings;
  };

  describe = (opts: { mode: TVimMode; context: TVimContext }): Array<{ keys: string; description: string }> => {
    const { mode, context } = opts;
    return this._bindings
      .filter(binding => (Array.isArray(binding.mode) ? binding.mode.includes(mode) : binding.mode === mode))
      .filter(binding => binding.context === '*' || binding.context === context)
      .map(binding => ({ keys: binding.keys, description: binding.description }));
  };
}
