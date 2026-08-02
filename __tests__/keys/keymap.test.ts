import { test, expect } from 'bun:test';

import { Container, BindingScopes } from '@venizia/ignis-inversion';

import { BindingKeys } from '../../src/common/index.ts';
import { ActionTypes, INITIAL_ENGINE_STATE, VimContexts, VimModes } from '../../src/keys/common/index.ts';
import type { IEngineState, IKey } from '../../src/keys/common/index.ts';
import { KeyNormalizerService } from '../../src/keys/key-normalizer.ts';
import { KeymapService } from '../../src/keys/keymap.ts';
import { VimEngineService } from '../../src/keys/vim-engine.ts';

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

test('describe returns only bindings for the given mode and context', () => {
  const shown = build().keymapService.describe({ mode: VimModes.NORMAL, context: VimContexts.MESSAGES });
  expect(shown.some(binding => binding.keys === 'j')).toBe(true);
  expect(shown.some(binding => binding.keys === 'escape')).toBe(false);
});
