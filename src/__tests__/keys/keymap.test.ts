import { test, expect } from 'bun:test';

import { Container, BindingScopes } from '@venizia/ignis-inversion';

import { BindingKeys } from '../../common/index.ts';
import { ActionTypes, INITIAL_ENGINE_STATE, VimContexts, VimModes } from '../../keys/common/index.ts';
import type { IEngineState, IKey, TVimContext, TVimMode } from '../../keys/common/index.ts';
import { KeyNormalizerService } from '../../keys/key-normalizer.ts';
import { KeymapService } from '../../keys/keymap.ts';
import { VimEngineService } from '../../keys/vim-engine.ts';

const build = (): { keymapService: KeymapService; engine: VimEngineService } => {
  const container = new Container({ scope: 'KeymapTest' });
  container.bind({ key: BindingKeys.KEY_NORMALIZER }).toClass(KeyNormalizerService).setScope(BindingScopes.SINGLETON);
  container.bind({ key: BindingKeys.VIM_ENGINE }).toClass(VimEngineService).setScope(BindingScopes.SINGLETON);
  container.bind({ key: BindingKeys.KEYMAP }).toClass(KeymapService).setScope(BindingScopes.SINGLETON);
  return {
    keymapService: container.get<KeymapService>({ key: BindingKeys.KEYMAP }),
    engine: container.get<VimEngineService>({ key: BindingKeys.VIM_ENGINE }),
  };
};

const buildKey = (name: string, modifiers: Partial<IKey> = {}): IKey => ({
  name, ctrl: false, alt: false, shift: false, ...modifiers,
});

test('every binding carries a description for the which-key popup', () => {
  for (const binding of build().keymapService.getBindings()) {
    expect(binding.description.length).toBeGreaterThan(0);
  }
});

test('no two bindings collide on the same keys, mode and context', () => {
  const seen = new Set<string>();
  for (const binding of build().keymapService.getBindings()) {
    const modes = Array.isArray(binding.mode) ? binding.mode : [binding.mode];
    for (const mode of modes) {
      const identity = `${binding.context}:${mode}:${binding.keys}`;
      expect(seen.has(identity)).toBe(false);
      seen.add(identity);
    }
  }
});

test('j and k move through messages', () => {
  const { keymapService, engine } = build();
  const keymap = keymapService.getBindings();
  expect(engine.resolve({ state: INITIAL_ENGINE_STATE, key: buildKey('j'), keymap }).actions)
    .toEqual([{ type: ActionTypes.CURSOR_MOVE, unit: 'message', delta: 1 }]);
  expect(engine.resolve({ state: INITIAL_ENGINE_STATE, key: buildKey('k'), keymap }).actions)
    .toEqual([{ type: ActionTypes.CURSOR_MOVE, unit: 'message', delta: -1 }]);
});

test('i enters insert mode and focuses the composer', () => {
  const { keymapService, engine } = build();
  const result = engine.resolve({ state: INITIAL_ENGINE_STATE, key: buildKey('i'), keymap: keymapService.getBindings() });
  expect(result.state.mode).toBe(VimModes.INSERT);
  expect(result.state.context).toBe(VimContexts.COMPOSER);
});

test('jk leaves insert mode', () => {
  const { keymapService, engine } = build();
  const keymap = keymapService.getBindings();
  const insert: IEngineState = { ...INITIAL_ENGINE_STATE, mode: VimModes.INSERT, context: VimContexts.COMPOSER };
  const pending = engine.resolve({ state: insert, key: buildKey('j'), keymap });
  expect(pending.status).toBe('pending');
  expect(engine.resolve({ state: pending.state, key: buildKey('k'), keymap }).state.mode).toBe(VimModes.NORMAL);
});

test('escape also leaves insert mode', () => {
  const { keymapService, engine } = build();
  const insert: IEngineState = { ...INITIAL_ENGINE_STATE, mode: VimModes.INSERT, context: VimContexts.COMPOSER };
  expect(engine.resolve({ state: insert, key: buildKey('escape'), keymap: keymapService.getBindings() }).state.mode)
    .toBe(VimModes.NORMAL);
});

test('gg and G jump to the ends of history', () => {
  const { keymapService, engine } = build();
  const keymap = keymapService.getBindings();
  const pending = engine.resolve({ state: INITIAL_ENGINE_STATE, key: buildKey('g'), keymap });
  expect(engine.resolve({ state: pending.state, key: buildKey('g'), keymap }).actions)
    .toEqual([{ type: ActionTypes.CURSOR_EDGE, unit: 'message', edge: 'first' }]);
  // A real Shift-G press arrives as name 'g' with shift:true -- OpenTUI lowercases
  // shifted letters into `name` (see key-normalizer.ts) -- so that, not an
  // uppercase name, is what must resolve to the last-message edge.
  expect(engine.resolve({ state: INITIAL_ENGINE_STATE, key: buildKey('g', { shift: true }), keymap }).actions)
    .toEqual([{ type: ActionTypes.CURSOR_EDGE, unit: 'message', edge: 'last' }]);
});

test('3j moves three messages', () => {
  const { keymapService, engine } = build();
  const keymap = keymapService.getBindings();
  const counted = engine.resolve({ state: INITIAL_ENGINE_STATE, key: buildKey('3'), keymap });
  expect(engine.resolve({ state: counted.state, key: buildKey('j'), keymap }).actions)
    .toEqual([{ type: ActionTypes.CURSOR_MOVE, unit: 'message', delta: 3 }]);
});

// Echoes the author's nvim mapping: nf focuses the file tree.
test('nf focuses the chat list', () => {
  const { keymapService, engine } = build();
  const keymap = keymapService.getBindings();
  const pending = engine.resolve({ state: INITIAL_ENGINE_STATE, key: buildKey('n'), keymap });
  expect(engine.resolve({ state: pending.state, key: buildKey('f'), keymap }).actions)
    .toEqual([{ type: ActionTypes.FOCUS_SET, context: VimContexts.CHAT_LIST }]);
});

// z is otherwise unbound, so a lone z must become a pending prefix the same
// way g and n already do, and zs resolves it to the reveal action.
test('zs reveals the spoiler on the message under the cursor', () => {
  const { keymapService, engine } = build();
  const keymap = keymapService.getBindings();
  const pending = engine.resolve({ state: INITIAL_ENGINE_STATE, key: buildKey('z'), keymap });
  expect(pending.status).toBe('pending');
  expect(engine.resolve({ state: pending.state, key: buildKey('s'), keymap }).actions)
    .toEqual([{ type: ActionTypes.SPOILER_REVEAL }]);
});

test('r starts a reply to the message under the cursor', () => {
  const { keymapService, engine } = build();
  const result = engine.resolve({
    state: INITIAL_ENGINE_STATE,
    key: buildKey('r'),
    keymap: keymapService.getBindings(),
  });
  expect(result.status).toBe('resolved');
  expect(result.actions).toEqual([{ type: ActionTypes.REPLY_START }]);
});

test('e starts an edit of the message under the cursor', () => {
  const { keymapService, engine } = build();
  const result = engine.resolve({
    state: INITIAL_ENGINE_STATE,
    key: buildKey('e'),
    keymap: keymapService.getBindings(),
  });
  expect(result.status).toBe('resolved');
  expect(result.actions).toEqual([{ type: ActionTypes.EDIT_START }]);
});

test('dd asks to delete the message under the cursor', () => {
  const { keymapService, engine } = build();
  const keymap = keymapService.getBindings();
  const pending = engine.resolve({ state: INITIAL_ENGINE_STATE, key: buildKey('d'), keymap });
  expect(pending.status).toBe('pending');
  expect(engine.resolve({ state: pending.state, key: buildKey('d'), keymap }).actions)
    .toEqual([{ type: ActionTypes.DELETE_REQUEST }]);
});

// Task 8's own limit, not a regression: the engine resolves an exact match
// before it checks for a prefix (pinned generically in vim-engine.test.ts),
// so a bare `d` binding would make `dd` permanently unreachable. Operator-
// pending with a timeout, which would let both coexist, is M1b-2 work.
test('bare d is not bound -- only dd, so it stays reachable', () => {
  const { keymapService } = build();
  expect(keymapService.getBindings().some(binding => binding.keys === 'd')).toBe(false);
});

test('describe returns only bindings for the given mode and context', () => {
  const shown = build().keymapService.describe({ mode: VimModes.NORMAL, context: VimContexts.MESSAGES });
  expect(shown.some(binding => binding.keys === 'j')).toBe(true);
  expect(shown.some(binding => binding.keys === 'escape')).toBe(false);
});

// <C-w>h/l were specified in the M1 design's keymap table (§5) and never
// implemented -- the chat list had `nf` in but no binding at all back out,
// which is the second of the two reported gaps this task closes. <C-w> alone
// is a two-token prefix ("<C-w>" then "h" or "l"), so it also exercises the
// tokenizer's prefix handling: a bare Ctrl-W must stay pending, not resolve
// to anything, until the second key arrives.
test('<C-w> alone stays pending and resolves to nothing', () => {
  const { keymapService, engine } = build();
  const result = engine.resolve({
    state: INITIAL_ENGINE_STATE,
    key: buildKey('w', { ctrl: true }),
    keymap: keymapService.getBindings(),
  });
  expect(result.status).toBe('pending');
  expect(result.actions).toEqual([]);
});

test('<C-w>h focuses the chat list and <C-w>l focuses messages', () => {
  const { keymapService, engine } = build();
  const keymap = keymapService.getBindings();

  const pendingToList = engine.resolve({ state: INITIAL_ENGINE_STATE, key: buildKey('w', { ctrl: true }), keymap });
  expect(engine.resolve({ state: pendingToList.state, key: buildKey('h'), keymap }).actions)
    .toEqual([{ type: ActionTypes.FOCUS_SET, context: VimContexts.CHAT_LIST }]);

  const pendingToMessages = engine.resolve({ state: INITIAL_ENGINE_STATE, key: buildKey('w', { ctrl: true }), keymap });
  expect(engine.resolve({ state: pendingToMessages.state, key: buildKey('l'), keymap }).actions)
    .toEqual([{ type: ActionTypes.FOCUS_SET, context: VimContexts.MESSAGES }]);
});

test('a round trip: <C-w>h to the chat list and <C-w>l back to messages', () => {
  const { keymapService, engine } = build();
  const keymap = keymapService.getBindings();
  expect(INITIAL_ENGINE_STATE.context).toBe(VimContexts.MESSAGES);

  const pendingToList = engine.resolve({ state: INITIAL_ENGINE_STATE, key: buildKey('w', { ctrl: true }), keymap });
  const toList = engine.resolve({ state: pendingToList.state, key: buildKey('h'), keymap });
  expect(toList.state.context).toBe(VimContexts.CHAT_LIST);

  const pendingToMessages = engine.resolve({ state: toList.state, key: buildKey('w', { ctrl: true }), keymap });
  const toMessages = engine.resolve({ state: pendingToMessages.state, key: buildKey('l'), keymap });
  expect(toMessages.state.context).toBe(VimContexts.MESSAGES);
});

// The "I changed my mind" key -- without it, `nf` into the chat list was a
// dead end unless the cursor happened to be sitting on a chat worth opening.
test('<escape> in the chat list returns focus to messages without opening anything', () => {
  const { keymapService, engine } = build();
  const chatList: IEngineState = { ...INITIAL_ENGINE_STATE, context: VimContexts.CHAT_LIST };
  const result = engine.resolve({ state: chatList, key: buildKey('escape'), keymap: keymapService.getBindings() });
  expect(result.actions).toEqual([{ type: ActionTypes.FOCUS_SET, context: VimContexts.MESSAGES }]);
  expect(result.state.context).toBe(VimContexts.MESSAGES);
});

// The leader. The status bar has advertised "\ for keys" since the redesign
// while this table bound nothing to it -- the first of the two reported gaps.
test('\\ toggles the which-key overlay', () => {
  const { keymapService, engine } = build();
  const result = engine.resolve({
    state: INITIAL_ENGINE_STATE,
    key: buildKey('\\'),
    keymap: keymapService.getBindings(),
  });
  expect(result.status).toBe('resolved');
  expect(result.actions).toEqual([{ type: ActionTypes.OVERLAY_TOGGLE, overlay: 'whichkey' }]);
});

// Both reported bugs -- `\` bound to nothing, and no way back from the chat
// list -- existed because every test above only asserts what IS bound, never
// what SHOULD be: a key promised by the README, the status-bar hint or the
// M1 spec could be silently dropped from this table (or never added) and
// nothing here would fail. This is that guard: every binding the project
// currently promises the user, checked against the real table, grouped the
// way the promises are grouped (README's key table; spec §5's Navigation,
// Message actions and mode transitions). It fails loudly the moment a
// promised key is missing, instead of shipping silently the way both of
// these did.
test('every binding the project promises the user is actually bound', () => {
  const bindings = build().keymapService.getBindings();
  const isBound = (opts: { context: TVimContext | '*'; mode: TVimMode; keys: string }): boolean =>
    bindings.some(binding => {
      const modes = Array.isArray(binding.mode) ? binding.mode : [binding.mode];
      return binding.context === opts.context && modes.includes(opts.mode) && binding.keys === opts.keys;
    });

  const promised: Array<{ context: TVimContext | '*'; mode: TVimMode; keys: string }> = [
    // Motions
    { context: '*', mode: VimModes.NORMAL, keys: 'j' },
    { context: '*', mode: VimModes.NORMAL, keys: 'k' },
    { context: '*', mode: VimModes.NORMAL, keys: 'gg' },
    { context: '*', mode: VimModes.NORMAL, keys: '<S-g>' },
    { context: '*', mode: VimModes.NORMAL, keys: '<C-d>' },
    { context: '*', mode: VimModes.NORMAL, keys: '<C-u>' },
    // Pane movement -- <C-w>h/l is exactly the class of bug this guards:
    // specified in the spec's keymap table and never implemented.
    { context: '*', mode: VimModes.NORMAL, keys: 'nf' },
    { context: '*', mode: VimModes.NORMAL, keys: '<C-w>h' },
    { context: '*', mode: VimModes.NORMAL, keys: '<C-w>l' },
    { context: VimContexts.CHAT_LIST, mode: VimModes.NORMAL, keys: '<return>' },
    { context: VimContexts.CHAT_LIST, mode: VimModes.NORMAL, keys: '<escape>' },
    // The leader -- advertised in the status-bar hint and rendered, but
    // bound to nothing until this task.
    { context: '*', mode: VimModes.NORMAL, keys: '\\' },
    // Mode changes
    { context: '*', mode: VimModes.NORMAL, keys: 'i' },
    { context: '*', mode: VimModes.NORMAL, keys: 'a' },
    { context: '*', mode: VimModes.INSERT, keys: 'jk' },
    { context: '*', mode: VimModes.INSERT, keys: '<escape>' },
    { context: '*', mode: VimModes.INSERT, keys: '<return>' },
    // Application
    { context: '*', mode: VimModes.NORMAL, keys: '<C-c>' },
  ];

  for (const binding of promised) {
    expect({ ...binding, bound: isBound(binding) }).toEqual({ ...binding, bound: true });
  }
});
