import { test, expect } from 'bun:test';

import { Container, BindingScopes } from '@venizia/ignis-inversion';

import { BindingKeys } from '../common/index.ts';
import { ActionTypes, INITIAL_ENGINE_STATE, VimContexts, VimModes } from './common/index.ts';
import type { IEngineState, IKey, IKeyBinding } from './common/index.ts';
import { KeyNormalizerService } from './key-normalizer.ts';
import { VimEngineService } from './vim-engine.ts';

const buildEngine = (): VimEngineService => {
  const container = new Container({ scope: 'VimEngineTest' });
  container.bind({ key: BindingKeys.KEY_NORMALIZER }).toClass(KeyNormalizerService).setScope(BindingScopes.SINGLETON);
  container.bind({ key: BindingKeys.VIM_ENGINE }).toClass(VimEngineService).setScope(BindingScopes.SINGLETON);
  return container.get<VimEngineService>({ key: BindingKeys.VIM_ENGINE });
};

const buildKey = (name: string, modifiers: Partial<IKey> = {}): IKey => ({
  name,
  ctrl: false,
  alt: false,
  shift: false,
  ...modifiers,
});

const keymap: IKeyBinding[] = [
  {
    context: '*', mode: VimModes.NORMAL, keys: 'j', description: 'down',
    action: count => [{ type: ActionTypes.CURSOR_MOVE, unit: 'message', delta: count }],
  },
  {
    context: '*', mode: VimModes.NORMAL, keys: 'gg', description: 'top',
    action: () => [{ type: ActionTypes.CURSOR_EDGE, unit: 'message', edge: 'first' }],
  },
  {
    context: '*', mode: VimModes.NORMAL, keys: 'i', description: 'insert',
    action: () => [{ type: ActionTypes.MODE_SET, mode: VimModes.INSERT }],
  },
  {
    context: '*', mode: VimModes.INSERT, keys: 'escape', description: 'normal',
    action: () => [{ type: ActionTypes.MODE_SET, mode: VimModes.NORMAL }],
  },
  {
    context: VimContexts.MESSAGES, mode: VimModes.NORMAL, keys: '<C-p>', description: 'picker',
    action: () => [{ type: ActionTypes.CHAT_OPEN }],
  },
];

test('the engine resolves from the container', () => {
  expect(buildEngine()).toBeInstanceOf(VimEngineService);
});

test('a single mapped key resolves immediately', () => {
  const result = buildEngine().resolve({ state: INITIAL_ENGINE_STATE, key: buildKey('j'), keymap });
  expect(result.status).toBe('resolved');
  expect(result.actions).toEqual([{ type: ActionTypes.CURSOR_MOVE, unit: 'message', delta: 1 }]);
  expect(result.state.pending).toBe('');
});

test('a count multiplies the action', () => {
  const engine = buildEngine();
  const counted = engine.resolve({ state: INITIAL_ENGINE_STATE, key: buildKey('3'), keymap });
  expect(counted.state.count).toBe(3);
  const result = engine.resolve({ state: counted.state, key: buildKey('j'), keymap });
  expect(result.actions).toEqual([{ type: ActionTypes.CURSOR_MOVE, unit: 'message', delta: 3 }]);
  expect(result.state.count).toBeNull();
});

test('multi-digit counts accumulate', () => {
  const engine = buildEngine();
  const first = engine.resolve({ state: INITIAL_ENGINE_STATE, key: buildKey('1'), keymap });
  const second = engine.resolve({ state: first.state, key: buildKey('2'), keymap });
  expect(second.state.count).toBe(12);
});

test('a leading zero is a motion, not the start of a count', () => {
  const result = buildEngine().resolve({ state: INITIAL_ENGINE_STATE, key: buildKey('0'), keymap });
  expect(result.state.count).toBeNull();
  expect(result.status).toBe('unmapped');
});

test('zero after a digit continues the count', () => {
  const engine = buildEngine();
  const first = engine.resolve({ state: INITIAL_ENGINE_STATE, key: buildKey('1'), keymap });
  const second = engine.resolve({ state: first.state, key: buildKey('0'), keymap });
  expect(second.state.count).toBe(10);
});

test('a prefix of a longer binding stays pending', () => {
  const result = buildEngine().resolve({ state: INITIAL_ENGINE_STATE, key: buildKey('g'), keymap });
  expect(result.status).toBe('pending');
  expect(result.state.pending).toBe('g');
  expect(result.actions).toEqual([]);
});

test('completing a multi-key binding resolves and clears pending', () => {
  const engine = buildEngine();
  const first = engine.resolve({ state: INITIAL_ENGINE_STATE, key: buildKey('g'), keymap });
  const second = engine.resolve({ state: first.state, key: buildKey('g'), keymap });
  expect(second.status).toBe('resolved');
  expect(second.actions).toEqual([{ type: ActionTypes.CURSOR_EDGE, unit: 'message', edge: 'first' }]);
  expect(second.state.pending).toBe('');
});

test('an unmapped key clears pending and count', () => {
  const engine = buildEngine();
  const pending = engine.resolve({ state: INITIAL_ENGINE_STATE, key: buildKey('g'), keymap });
  const result = engine.resolve({ state: { ...pending.state, count: 4 }, key: buildKey('z'), keymap });
  expect(result.status).toBe('unmapped');
  expect(result.state.pending).toBe('');
  expect(result.state.count).toBeNull();
});

test('bindings are filtered by mode', () => {
  const engine = buildEngine();
  const insert: IEngineState = { ...INITIAL_ENGINE_STATE, mode: VimModes.INSERT };
  expect(engine.resolve({ state: insert, key: buildKey('j'), keymap }).status).toBe('unmapped');
  expect(engine.resolve({ state: insert, key: buildKey('escape'), keymap }).status).toBe('resolved');
});

test('bindings are filtered by context', () => {
  const engine = buildEngine();
  const chatList: IEngineState = { ...INITIAL_ENGINE_STATE, context: VimContexts.CHAT_LIST };
  expect(engine.resolve({ state: chatList, key: buildKey('p', { ctrl: true }), keymap }).status).toBe('unmapped');
  expect(engine.resolve({ state: INITIAL_ENGINE_STATE, key: buildKey('p', { ctrl: true }), keymap }).status).toBe('resolved');
});

test('mode.set updates the returned state', () => {
  const result = buildEngine().resolve({ state: INITIAL_ENGINE_STATE, key: buildKey('i'), keymap });
  expect(result.state.mode).toBe(VimModes.INSERT);
});

test('resolve never mutates the state it is given', () => {
  const before = { ...INITIAL_ENGINE_STATE };
  buildEngine().resolve({ state: INITIAL_ENGINE_STATE, key: buildKey('3'), keymap });
  expect(INITIAL_ENGINE_STATE).toEqual(before);
});

// Otherwise `j` in the chat list would move the message cursor, and which one
// won would depend on the order bindings happen to be declared in.
test('a context-specific binding beats a wildcard one for the same keys', () => {
  const withOverride: IKeyBinding[] = [
    ...keymap,
    {
      context: VimContexts.CHAT_LIST, mode: VimModes.NORMAL, keys: 'j', description: 'next chat',
      action: (count: number) => [{ type: ActionTypes.CURSOR_MOVE, unit: 'chat' as const, delta: count }],
    },
  ];
  const engine = buildEngine();

  // In the chat list, the specific binding wins even though '*' is declared first.
  expect(
    engine.resolve({
      state: { ...INITIAL_ENGINE_STATE, context: VimContexts.CHAT_LIST },
      key: buildKey('j'),
      keymap: withOverride,
    }).actions,
  ).toEqual([{ type: ActionTypes.CURSOR_MOVE, unit: 'chat', delta: 1 }]);

  // Elsewhere the wildcard still applies.
  expect(
    engine.resolve({ state: INITIAL_ENGINE_STATE, key: buildKey('j'), keymap: withOverride }).actions,
  ).toEqual([{ type: ActionTypes.CURSOR_MOVE, unit: 'message', delta: 1 }]);
});
