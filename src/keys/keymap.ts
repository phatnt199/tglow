import { ActionTypes, Operators, VimContexts, VimModes } from './common/index.ts';
import type { IKeyBinding, TVimContext, TVimMode } from './common/index.ts';

const HALF_PAGE_MESSAGES = 10;

/**
 * An engine-intrinsic key (vim-engine.ts): resolved directly there, the same
 * way a digit count is, so it has no `action(count)` and no `IKeyBinding` of
 * its own for `describe()` below to find. Deliberately not shaped like
 * `IKeyBinding` with a stub action -- a fabricated one is something
 * `resolve()` could actually match, dispatching a binding that corresponds to
 * no real key handling, which would be worse than the which-key gap this
 * closes.
 */
interface IIntrinsicKeyDescriptor {
  context: TVimContext | '*';
  mode: TVimMode | TVimMode[];
  keys: string;
  description: string;
}

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
    // K is already this project's LSP-hover-style key (M1 spec §5: "message
    // details / sender info"); showing a link's URL is the natural first
    // occupant. Capital letters arrive as <S-x>, never a bare 'X'
    // (ignis-style.md) -- OpenTUI lowercases a shifted letter into `name` and
    // reports the shift separately, so a bare 'K' binding would be dead.
    {
      context: '*', mode: VimModes.NORMAL, keys: '<S-k>', description: 'Show link URL',
      action: () => [{ type: ActionTypes.LINK_SHOW }],
    },
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
    // dd, a literal binding -- not `d` followed by a `d` motion, and kept as
    // one on purpose rather than folded into vim-engine.ts's own
    // doubled-operator recognition (which yy/cc rely on instead, having no
    // literal binding of their own): keeping it means a bare `d` stays
    // genuinely ambiguous against it, exactly the way two competing keymap
    // entries would be -- resolve() reports `ambiguous`, and App's
    // timeoutlen settles it if nothing else does (vim-engine.test.ts,
    // keymap.test.ts). `d` followed by a real motion (`dj`) still resolves
    // immediately as OPERATOR_APPLY instead of waiting.
    //
    // context is messages, not '*' -- a Minor from M1b-1's final review
    // (this binding deleted a message in the messages pane while the chat
    // list had focus) that M1b-2's operators make more reachable, not less,
    // so it is fixed here. The action itself is OPERATOR_APPLY now, count-
    // aware like yy/cc and any d+motion delete, and routed through the same
    // reducer switch they share -- not DELETE_REQUEST directly -- so a typed
    // count (3dd) reaches the reducer instead of being silently ignored. The
    // reducer's own OPERATOR_APPLY case still asks for confirmation before
    // deleting anything (action-reducer.ts): the confirmation itself is
    // intercepted directly in App (app.tsx), the same way the reply/edit
    // escapes above are -- y and n only mean anything while
    // IApplicationState.pendingConfirmation is set, which a static keymap
    // entry has no way to see.
    {
      context: VimContexts.MESSAGES, mode: VimModes.NORMAL, keys: 'dd', description: 'Delete message',
      action: count => [
        { type: ActionTypes.OPERATOR_APPLY, operator: Operators.DELETE, unit: 'message', from: 0, to: count - 1 },
      ],
    },

    // Panes — nf echoes the author's NvimTreeFocus mapping.
    {
      context: '*', mode: VimModes.NORMAL, keys: 'nf', description: 'Focus chat list',
      action: () => [{ type: ActionTypes.FOCUS_SET, context: VimContexts.CHAT_LIST }],
    },
    // Pin. Shifted rather than a bare `p`, which vim spends on paste and this
    // project will want for the same when registers gain one.
    {
      context: '*', mode: VimModes.NORMAL, keys: '<S-p>', description: 'Pin or unpin the message',
      action: () => [{ type: ActionTypes.PIN_TOGGLE }],
    },
    // Display. `z` is vim's view prefix, and this project already uses it as
    // one -- `zs` reveals a spoiler. `zn` and `zt` switch the conversation's
    // gutter and clock, which also widens the text, since a hidden field gives
    // its columns back rather than blanking them.
    {
      context: '*', mode: VimModes.NORMAL, keys: 'zn', description: 'Toggle line numbers',
      action: () => [{ type: ActionTypes.DISPLAY_TOGGLE, field: 'gutter' }],
    },
    {
      context: '*', mode: VimModes.NORMAL, keys: 'zt', description: 'Toggle timestamps',
      action: () => [{ type: ActionTypes.DISPLAY_TOGGLE, field: 'time' }],
    },
    // Folders. `]f`/`[f` follow vim's own bracket-pair convention for "next
    // and previous thing of a kind" (]c, ]q, ]b), and exist so the rail is
    // never mouse-only -- M2's governing rule.
    {
      context: '*', mode: VimModes.NORMAL, keys: ']f', description: 'Next folder',
      action: count => [{ type: ActionTypes.FOLDER_CYCLE, delta: count }],
    },
    {
      context: '*', mode: VimModes.NORMAL, keys: '[f', description: 'Previous folder',
      action: count => [{ type: ActionTypes.FOLDER_CYCLE, delta: -count }],
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
    // M1b-2 Task 8: fuzzy jump to any chat. This binding is only ever what
    // opens the picker -- once state.overlay is 'chatpicker', app.tsx (not
    // this table) intercepts every key directly, ahead of engine resolution,
    // the same pattern it already uses for the which-key overlay's own
    // escape, because <C-p> means something different once the picker owns
    // input: move the selection up, the job k also does, never close it.
    // That is also why reusing OVERLAY_TOGGLE's ordinary "closes if already
    // the same overlay" reducer behaviour is safe here: the only way that
    // branch could fire is a second <C-p> reaching the engine while
    // chatpicker is already open, which app.tsx's own swallow guard makes
    // unreachable.
    {
      context: '*', mode: VimModes.NORMAL, keys: '<C-p>', description: 'Jump to a chat',
      action: () => [{ type: ActionTypes.OVERLAY_TOGGLE, overlay: 'chatpicker' }],
    },
    // M1b-2 Task 9: `/` searches the open chat's cached messages. Opens the
    // overlay exactly like `\` and <C-p> above; app.tsx intercepts every key,
    // including a second `/`, once it is open, the same pattern.
    {
      context: '*', mode: VimModes.NORMAL, keys: '/', description: 'Search messages',
      action: () => [{ type: ActionTypes.OVERLAY_TOGGLE, overlay: 'search' }],
    },
    // n/N cycle the matches a search last committed (app.tsx, on the Enter
    // that closes the overlay) -- vim's own next/previous-match keys, so they
    // carry direction the way CURSOR_MOVE's own delta does rather than being
    // two separate action types. Context '*', like gg/<S-g>/<C-d>/<C-u> above:
    // these move the *message* cursor regardless of which pane currently has
    // focus, the same reasoning app.tsx's own CURSOR_MOVE/CURSOR_EDGE comment
    // gives for those.
    //
    // Giving `n` a real binding makes it genuinely ambiguous against `nf`
    // below -- the same shape bare `d` already has against `dd` (Task 3) --
    // since `nf` is also context '*' and a bare `n` is now both an exact match
    // in its own right and a prefix of a longer one. App's existing timeoutlen
    // (Tasks 1-2) is what settles it; a fast `nf` still resolves immediately,
    // unchanged (keymap.test.ts, app.test.tsx). This was a deliberate choice,
    // not an oversight: `n`/`N` are vim's own search-cycle keys, so giving
    // them the ordinary keymap treatment (rather than an app.tsx-level
    // intercept with no keymap entry, the way y/n mean "confirm/cancel" only
    // while a delete is pending) is what keeps this feature reachable the way
    // a user would expect, at the cost of `nf` no longer resolving with zero
    // delay if the two keys are typed more than timeoutMilliseconds apart.
    {
      context: '*', mode: VimModes.NORMAL, keys: 'n', description: 'Next search match',
      action: () => [{ type: ActionTypes.SEARCH_CYCLE, direction: 'next' }],
    },
    {
      context: '*', mode: VimModes.NORMAL, keys: '<S-n>', description: 'Previous search match',
      action: () => [{ type: ActionTypes.SEARCH_CYCLE, direction: 'previous' }],
    },

    // Application. <C-l> echoes vim's own redraw-the-screen key, which is what
    // a reader reaches for to clear something stuck on their statusline.
    // Dismissal has to be a real key: IApplicationState.integrityWarning is
    // deliberately unreachable from the patches that clear statusMessage (a
    // warning that messages were lost must outlive an ordinary load), so
    // without this it would sit there for the rest of the session.
    {
      context: '*', mode: VimModes.NORMAL, keys: '<C-l>', description: 'Dismiss warning',
      action: () => [{ type: ActionTypes.WARNING_DISMISS }],
    },
    {
      context: '*', mode: VimModes.NORMAL, keys: '<C-c>', description: 'Quit',
      action: () => [{ type: ActionTypes.APPLICATION_QUIT }],
    },
    // vim's command line. Everything it can do is also a key, or is something
    // no single key should do -- `:logout` ends the session, and a keystroke
    // that does that is a keystroke waiting to be pressed by accident.
    {
      context: '*', mode: VimModes.NORMAL, keys: ':', description: 'Command line',
      action: () => [{ type: ActionTypes.OVERLAY_TOGGLE, overlay: 'command' }],
    },
  ];

  /**
   * M1b-2's operator triggers (d/y/c), their doubled whole-message forms (yy,
   * cc -- dd keeps the real, context-scoped binding above instead, per
   * M1b-1's review), the register prefix (") and repeat (.): every one
   * resolved directly in vim-engine.ts, gated behind its own
   * isMessagesNormalMode, with no IKeyBinding of its own for describe() below
   * to find -- the same way a digit count needs none. n/<S-n> need no entry
   * here: unlike the rest of M1b-2 they are real bindings in `_bindings`
   * above (search's own next/previous match), so describe() already finds
   * them there.
   *
   * This list exists only so the which-key popup can see what vim-engine.ts
   * already resolves. resolve() never reads it -- a wrong entry here could
   * misinform the popup but can never change what a key press actually does,
   * which is the whole reason this stays separate from `_bindings` instead of
   * a real IKeyBinding with a stub action() (see IIntrinsicKeyDescriptor above).
   */
  private readonly _intrinsicKeys: IIntrinsicKeyDescriptor[] = [
    { context: VimContexts.MESSAGES, mode: VimModes.NORMAL, keys: 'd', description: 'Delete with motion' },
    { context: VimContexts.MESSAGES, mode: VimModes.NORMAL, keys: 'y', description: 'Yank with motion' },
    { context: VimContexts.MESSAGES, mode: VimModes.NORMAL, keys: 'c', description: 'Change with motion' },
    { context: VimContexts.MESSAGES, mode: VimModes.NORMAL, keys: 'yy', description: 'Yank message' },
    { context: VimContexts.MESSAGES, mode: VimModes.NORMAL, keys: 'cc', description: 'Change message' },
    { context: VimContexts.MESSAGES, mode: VimModes.NORMAL, keys: '"', description: 'Choose a register' },
    { context: VimContexts.MESSAGES, mode: VimModes.NORMAL, keys: '.', description: 'Repeat last change' },
  ];

  getBindings = (): IKeyBinding[] => {
    return this._bindings;
  };

  private matchesMode = (opts: { entry: { mode: TVimMode | TVimMode[] }; mode: TVimMode }): boolean => {
    const { entry, mode } = opts;
    return Array.isArray(entry.mode) ? entry.mode.includes(mode) : entry.mode === mode;
  };

  private matchesContext = (opts: { entry: { context: TVimContext | '*' }; context: TVimContext }): boolean => {
    const { entry, context } = opts;
    return entry.context === '*' || entry.context === context;
  };

  describe = (opts: { mode: TVimMode; context: TVimContext }): Array<{ keys: string; description: string }> => {
    const { mode, context } = opts;

    const tableDriven = this._bindings
      .filter(binding => this.matchesMode({ entry: binding, mode }) && this.matchesContext({ entry: binding, context }))
      .map(binding => ({ keys: binding.keys, description: binding.description }));

    // Concatenated, not merged into one filter over one array: _intrinsicKeys
    // carries no `action`, so keeping the two lists physically separate here
    // is what stops a future edit from quietly treating a display-only
    // descriptor as something resolve() could dispatch.
    const intrinsic = this._intrinsicKeys
      .filter(entry => this.matchesMode({ entry, mode }) && this.matchesContext({ entry, context }))
      .map(entry => ({ keys: entry.keys, description: entry.description }));

    return [...tableDriven, ...intrinsic];
  };
}
