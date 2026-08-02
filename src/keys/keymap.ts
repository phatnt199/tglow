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

    // Message actions — z is otherwise unbound, so it becomes a pending
    // prefix exactly as g does for gg, mirroring vim's own z fold prefix.
    {
      context: '*', mode: VimModes.NORMAL, keys: 'zs', description: 'Reveal spoiler',
      action: () => [{ type: ActionTypes.SPOILER_REVEAL }],
    },
    // <escape> cancels the reply this starts, but only when one is pending --
    // that condition lives in IApplicationState, which no binding's action()
    // can see, so App intercepts it directly (app.tsx) the same way it
    // already does for the which-key overlay's own escape, rather than a
    // second binding here.
    {
      context: '*', mode: VimModes.NORMAL, keys: 'r', description: 'Reply to message',
      action: () => [{ type: ActionTypes.REPLY_START }],
    },
    // EDIT_START itself decides mode and focus (moving straight to INSERT,
    // unlike REPLY_START), since it also has to decide -- looking at
    // out on the message under the cursor -- whether to do that at all.
    // That refusal only IApplicationState can see, so like reply's own
    // escape, <escape> cancelling an edit in progress is intercepted
    // directly in App (app.tsx) rather than expressed as a second binding.
    {
      context: '*', mode: VimModes.NORMAL, keys: 'e', description: 'Edit message',
      action: () => [{ type: ActionTypes.EDIT_START }],
    },

    // Panes — nf echoes the author's NvimTreeFocus mapping.
    {
      context: '*', mode: VimModes.NORMAL, keys: 'nf', description: 'Focus chat list',
      action: () => [{ type: ActionTypes.FOCUS_SET, context: VimContexts.CHAT_LIST }],
    },
    // <C-w>h/l echo vim's own window-navigation keys. Unlike nf (into the
    // chat list only, one-way) these move in both directions and work from
    // any context, so they double as the way out of the chat list too.
    {
      context: '*', mode: VimModes.NORMAL, keys: '<C-w>h', description: 'Focus chat list',
      action: () => [{ type: ActionTypes.FOCUS_SET, context: VimContexts.CHAT_LIST }],
    },
    {
      context: '*', mode: VimModes.NORMAL, keys: '<C-w>l', description: 'Focus messages',
      action: () => [{ type: ActionTypes.FOCUS_SET, context: VimContexts.MESSAGES }],
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
    // The "I changed my mind" key: without it, landing in the chat list with
    // nf had no way back except opening something with Enter. <C-w>l is the
    // other way back, but a newcomer reaches for Escape first.
    {
      context: VimContexts.CHAT_LIST, mode: VimModes.NORMAL, keys: '<escape>', description: 'Back to messages',
      action: () => [{ type: ActionTypes.FOCUS_SET, context: VimContexts.MESSAGES }],
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

    // Overlays — leader is \, matching vim.g.mapleader (see spec §5). The
    // status bar has advertised "\ for keys" since the redesign; this is what
    // makes that true instead of a dead key.
    {
      context: '*', mode: VimModes.NORMAL, keys: '\\', description: 'Show key bindings',
      action: () => [{ type: ActionTypes.OVERLAY_TOGGLE, overlay: 'whichkey' }],
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
