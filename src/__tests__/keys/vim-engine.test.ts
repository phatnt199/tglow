import { test, expect } from 'bun:test';

import { Container, BindingScopes } from '@venizia/ignis-inversion';

import { BindingKeys } from '../../common/index.ts';
import { ActionTypes, INITIAL_ENGINE_STATE, Operators, VimContexts, VimModes } from '../../keys/common/index.ts';
import type { IEngineState, IKey, IKeyBinding } from '../../keys/common/index.ts';
import { KeyNormalizerService } from '../../keys/key-normalizer.ts';
import { VimEngineService } from '../../keys/vim-engine.ts';

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
    context: '*', mode: VimModes.INSERT, keys: '<escape>', description: 'normal',
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

test('resolve throws on an empty keymap', () => {
  const engine = buildEngine();
  expect(() => engine.resolve({ state: INITIAL_ENGINE_STATE, key: buildKey('j'), keymap: [] })).toThrow(
    '[VimEngineService][resolve]',
  );
});

test('a single mapped key resolves immediately', () => {
  const result = buildEngine().resolve({ state: INITIAL_ENGINE_STATE, key: buildKey('j'), keymap });
  expect(result.status).toBe('resolved');
  expect(result.actions).toEqual([{ type: ActionTypes.CURSOR_MOVE, unit: 'message', delta: 1 }]);
  expect(result.state.pending).toEqual([]);
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

test('a digit in insert mode does not accumulate a count', () => {
  const engine = buildEngine();
  const insert: IEngineState = { ...INITIAL_ENGINE_STATE, mode: VimModes.INSERT };
  const result = engine.resolve({ state: insert, key: buildKey('3'), keymap });
  expect(result.state.count).toBeNull();
});

test('a digit while a prefix is pending does not accumulate a count', () => {
  const engine = buildEngine();
  const pending = engine.resolve({ state: INITIAL_ENGINE_STATE, key: buildKey('g'), keymap });
  expect(pending.state.pending).toEqual(['g']);
  const result = engine.resolve({ state: pending.state, key: buildKey('3'), keymap });
  expect(result.state.count).toBeNull();
});

test('a prefix of a longer binding stays pending', () => {
  const result = buildEngine().resolve({ state: INITIAL_ENGINE_STATE, key: buildKey('g'), keymap });
  expect(result.status).toBe('pending');
  expect(result.state.pending).toEqual(['g']);
  expect(result.actions).toEqual([]);
});

test('completing a multi-key binding resolves and clears pending', () => {
  const engine = buildEngine();
  const first = engine.resolve({ state: INITIAL_ENGINE_STATE, key: buildKey('g'), keymap });
  const second = engine.resolve({ state: first.state, key: buildKey('g'), keymap });
  expect(second.status).toBe('resolved');
  expect(second.actions).toEqual([{ type: ActionTypes.CURSOR_EDGE, unit: 'message', edge: 'first' }]);
  expect(second.state.pending).toEqual([]);
});

test('an unmapped key clears pending and count', () => {
  const engine = buildEngine();
  const pending = engine.resolve({ state: INITIAL_ENGINE_STATE, key: buildKey('g'), keymap });
  const result = engine.resolve({ state: { ...pending.state, count: 4 }, key: buildKey('z'), keymap });
  expect(result.status).toBe('unmapped');
  expect(result.state.pending).toEqual([]);
  expect(result.state.count).toBeNull();
});

test('bindings are filtered by mode', () => {
  const engine = buildEngine();
  const insert: IEngineState = { ...INITIAL_ENGINE_STATE, mode: VimModes.INSERT };
  expect(engine.resolve({ state: insert, key: buildKey('j'), keymap }).status).toBe('unmapped');
  expect(engine.resolve({ state: insert, key: buildKey('escape'), keymap }).status).toBe('resolved');
});

test('a binding with an array of modes matches any of them', () => {
  const multiModeKeymap: IKeyBinding[] = [
    {
      context: '*', mode: [VimModes.NORMAL, VimModes.VISUAL], keys: 'x', description: 'multi-mode',
      action: () => [{ type: ActionTypes.CHAT_OPEN }],
    },
  ];
  const engine = buildEngine();

  const normal = engine.resolve({ state: INITIAL_ENGINE_STATE, key: buildKey('x'), keymap: multiModeKeymap });
  expect(normal.status).toBe('resolved');

  const visual: IEngineState = { ...INITIAL_ENGINE_STATE, mode: VimModes.VISUAL };
  expect(engine.resolve({ state: visual, key: buildKey('x'), keymap: multiModeKeymap }).status).toBe('resolved');

  const insertMode: IEngineState = { ...INITIAL_ENGINE_STATE, mode: VimModes.INSERT };
  expect(engine.resolve({ state: insertMode, key: buildKey('x'), keymap: multiModeKeymap }).status).toBe('unmapped');
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

test('focus.set updates the returned context', () => {
  const focusKeymap: IKeyBinding[] = [
    {
      context: '*', mode: VimModes.NORMAL, keys: '<C-w>', description: 'focus chat list',
      action: () => [{ type: ActionTypes.FOCUS_SET, context: VimContexts.CHAT_LIST }],
    },
  ];
  const result = buildEngine().resolve({
    state: INITIAL_ENGINE_STATE,
    key: buildKey('w', { ctrl: true }),
    keymap: focusKeymap,
  });
  expect(result.state.context).toBe(VimContexts.CHAT_LIST);
});

test('resolve and flushPending never mutate the state they are given', () => {
  // A frozen copy makes a mutation throw immediately, which fails the test
  // loudly -- rather than relying on a later equality check that could pass
  // for the wrong reason if a shared constant got contaminated elsewhere.
  const buildFrozenState = (): IEngineState => Object.freeze({ ...INITIAL_ENGINE_STATE });
  const engine = buildEngine();

  // resolve -- the pending/count path.
  expect(() => engine.resolve({ state: buildFrozenState(), key: buildKey('3'), keymap })).not.toThrow();
  // resolve -- the resolved path.
  expect(() => engine.resolve({ state: buildFrozenState(), key: buildKey('j'), keymap })).not.toThrow();
  // resolve -- the unmapped path.
  expect(() => engine.resolve({ state: buildFrozenState(), key: buildKey('z'), keymap })).not.toThrow();

  // flushPending -- nothing pending: returned as-is, so mutation is moot, but
  // pinned here anyway so the four flushPending branches read as a set.
  expect(() => engine.flushPending({ state: buildFrozenState(), keymap })).not.toThrow();
  // flushPending -- a pending sequence with an exact match ('gg') resolves it.
  const frozenExactPending = Object.freeze({ ...INITIAL_ENGINE_STATE, pending: ['g', 'g'] });
  expect(() => engine.flushPending({ state: frozenExactPending, keymap })).not.toThrow();
  // flushPending -- a pending prefix with no exact match ('g') clears it.
  const frozenPrefixOnly = Object.freeze({ ...INITIAL_ENGINE_STATE, pending: ['g'] });
  expect(() => engine.flushPending({ state: frozenPrefixOnly, keymap })).not.toThrow();
});

// Otherwise `j` in the chat list would move the message cursor, and which one
// won would depend on the order bindings happen to be declared in.
test('a context-specific binding beats a wildcard one for the same keys', () => {
  const specificBinding: IKeyBinding = {
    context: VimContexts.CHAT_LIST, mode: VimModes.NORMAL, keys: 'j', description: 'next chat',
    action: (count: number) => [{ type: ActionTypes.CURSOR_MOVE, unit: 'chat' as const, delta: count }],
  };
  const wildcardFirst: IKeyBinding[] = [...keymap, specificBinding];
  const specificFirst: IKeyBinding[] = [specificBinding, ...keymap];
  const engine = buildEngine();

  // Wildcard declared first, specific declared last -- the specific binding
  // wins. On its own this doesn't prove order-independence, since a
  // last-wins implementation would also pass this half.
  expect(
    engine.resolve({
      state: { ...INITIAL_ENGINE_STATE, context: VimContexts.CHAT_LIST },
      key: buildKey('j'),
      keymap: wildcardFirst,
    }).actions,
  ).toEqual([{ type: ActionTypes.CURSOR_MOVE, unit: 'chat', delta: 1 }]);

  // Specific declared first, wildcard declared last -- still wins. A
  // last-wins implementation would fail this half.
  expect(
    engine.resolve({
      state: { ...INITIAL_ENGINE_STATE, context: VimContexts.CHAT_LIST },
      key: buildKey('j'),
      keymap: specificFirst,
    }).actions,
  ).toEqual([{ type: ActionTypes.CURSOR_MOVE, unit: 'chat', delta: 1 }]);

  // Elsewhere, the specific binding is filtered out by context before
  // specificity is even considered, so the wildcard is the only candidate --
  // this exercises context filtering, not specificity resolution.
  expect(
    engine.resolve({ state: INITIAL_ENGINE_STATE, key: buildKey('j'), keymap: wildcardFirst }).actions,
  ).toEqual([{ type: ActionTypes.CURSOR_MOVE, unit: 'message', delta: 1 }]);
});

// vim resolves this with timeoutlen. The engine stays pure: it reports the
// ambiguity and App owns the timer.
const ambiguousKeymap: IKeyBinding[] = [
  { context: '*', mode: VimModes.NORMAL, keys: 'd', description: 'short',
    action: () => [{ type: ActionTypes.CURSOR_EDGE, unit: 'message', edge: 'first' }] },
  { context: '*', mode: VimModes.NORMAL, keys: 'dd', description: 'long',
    action: () => [{ type: ActionTypes.CURSOR_EDGE, unit: 'message', edge: 'last' }] },
];

test('a key that is both an exact match and a prefix reports ambiguous, not resolved', () => {
  const result = buildEngine().resolve({ state: INITIAL_ENGINE_STATE, key: buildKey('d'), keymap: ambiguousKeymap });
  expect(result.status).toBe('ambiguous');
  expect(result.actions).toEqual([]);
  expect(result.state.pending).toEqual(['d']);
});

test('completing the longer binding resolves it and beats the timeout', () => {
  const engine = buildEngine();
  const first = engine.resolve({ state: INITIAL_ENGINE_STATE, key: buildKey('d'), keymap: ambiguousKeymap });
  const second = engine.resolve({ state: first.state, key: buildKey('d'), keymap: ambiguousKeymap });
  expect(second.status).toBe('resolved');
  expect(second.actions).toEqual([{ type: ActionTypes.CURSOR_EDGE, unit: 'message', edge: 'last' }]);
  expect(second.state.pending).toEqual([]);
});

test('flushPending resolves the shorter binding when the timer fires', () => {
  const engine = buildEngine();
  const first = engine.resolve({ state: INITIAL_ENGINE_STATE, key: buildKey('d'), keymap: ambiguousKeymap });
  const flushed = engine.flushPending({ state: first.state, keymap: ambiguousKeymap });
  expect(flushed.status).toBe('resolved');
  expect(flushed.actions).toEqual([{ type: ActionTypes.CURSOR_EDGE, unit: 'message', edge: 'first' }]);
  expect(flushed.state.pending).toEqual([]);
});

test('flushPending on a prefix with no exact match clears without acting', () => {
  const engine = buildEngine();
  const pending = engine.resolve({ state: INITIAL_ENGINE_STATE, key: buildKey('g'), keymap });
  const flushed = engine.flushPending({ state: pending.state, keymap });
  expect(flushed.status).toBe('unmapped');
  expect(flushed.actions).toEqual([]);
  expect(flushed.state.pending).toEqual([]);
});

test('flushPending with nothing pending is a no-op', () => {
  const flushed = buildEngine().flushPending({ state: INITIAL_ENGINE_STATE, keymap });
  expect(flushed.status).toBe('unmapped');
  expect(flushed.state).toEqual(INITIAL_ENGINE_STATE);
});

test('flushPending preserves a typed count', () => {
  const engine = buildEngine();
  const counted = engine.resolve({ state: INITIAL_ENGINE_STATE, key: buildKey('3'), keymap: ambiguousKeymap });
  const pending = engine.resolve({ state: counted.state, key: buildKey('d'), keymap: ambiguousKeymap });
  expect(pending.status).toBe('ambiguous');
  const flushed = engine.flushPending({ state: pending.state, keymap: ambiguousKeymap });
  expect(flushed.status).toBe('resolved');
});

test('a key that is only a prefix still reports pending, not ambiguous', () => {
  const result = buildEngine().resolve({ state: INITIAL_ENGINE_STATE, key: buildKey('g'), keymap });
  expect(result.status).toBe('pending');
});

test('a key that is only an exact match still resolves immediately', () => {
  const result = buildEngine().resolve({ state: INITIAL_ENGINE_STATE, key: buildKey('j'), keymap });
  expect(result.status).toBe('resolved');
});

// Code review on Task 16: bracket-notating named keys ("<escape>") moved the
// collision rather than removing it. A typed "<" is a valid canonical token
// in its own right, and the old string-level `startsWith` matched it against
// every bracketed binding ("<escape>".startsWith("<") is true) -- so typing
// "<" registered as a pending prefix, and the literal characters of
// "<return>" typed one at a time actually resolved the send binding. These
// three tests pin the token-sequence fix: a single token can never be a
// prefix of a different single token, no matter what characters either one
// contains. Confirmed to fail against the pre-tokenization (bracket-only)
// engine before this fix -- see the Task 16 fix report.
test('typing the literal "<" character is unmapped, not a pending prefix of a named key', () => {
  const engine = buildEngine();
  const namedKeymap: IKeyBinding[] = [
    {
      context: '*', mode: VimModes.INSERT, keys: '<escape>', description: 'normal',
      action: () => [{ type: ActionTypes.MODE_SET, mode: VimModes.NORMAL }],
    },
  ];
  const insert: IEngineState = { ...INITIAL_ENGINE_STATE, mode: VimModes.INSERT };
  const result = engine.resolve({ state: insert, key: buildKey('<'), keymap: namedKeymap });
  expect(result.status).toBe('unmapped');
});

test('typing the literal characters of "<return>" one at a time never resolves the binding', () => {
  const engine = buildEngine();
  const namedKeymap: IKeyBinding[] = [
    {
      context: '*', mode: VimModes.INSERT, keys: '<return>', description: 'send',
      action: () => [{ type: ActionTypes.COMPOSER_SEND }],
    },
  ];
  let state: IEngineState = { ...INITIAL_ENGINE_STATE, mode: VimModes.INSERT };
  for (const character of ['<', 'r', 'e', 't', 'u', 'r', 'n', '>']) {
    const result = engine.resolve({ state, key: buildKey(character), keymap: namedKeymap });
    expect(result.status).not.toBe('resolved');
    state = result.state;
  }
});

test('a real escape key press still resolves the <escape> binding', () => {
  const engine = buildEngine();
  const namedKeymap: IKeyBinding[] = [
    {
      context: '*', mode: VimModes.INSERT, keys: '<escape>', description: 'normal',
      action: () => [{ type: ActionTypes.MODE_SET, mode: VimModes.NORMAL }],
    },
  ];
  const insert: IEngineState = { ...INITIAL_ENGINE_STATE, mode: VimModes.INSERT };
  const result = engine.resolve({ state: insert, key: buildKey('escape'), keymap: namedKeymap });
  expect(result.status).toBe('resolved');
  expect(result.state.mode).toBe(VimModes.NORMAL);
});

// M1b-2 Task 3: operators compose with motions and counts. `d`/`y`/`c` are
// engine-intrinsic operator triggers -- like the digits accumulateCount
// handles above, they need no entry in `keymap` at all -- so every test
// below uses the same plain `keymap` fixture the rest of this file already
// shares (no dd binding in it), which is what lets `d` commit immediately
// instead of racing a competing binding the way it does against the real
// production keymap (see keymap.test.ts for that half).
test('d alone enters operator-pending', () => {
  const engine = buildEngine();
  const result = engine.resolve({ state: INITIAL_ENGINE_STATE, key: buildKey('d'), keymap });
  expect(result.state.operator).toBe(Operators.DELETE);
});

test('dj applies delete over one message downward', () => {
  const engine = buildEngine();
  const pending = engine.resolve({ state: INITIAL_ENGINE_STATE, key: buildKey('d'), keymap });
  const applied = engine.resolve({ state: pending.state, key: buildKey('j'), keymap });
  expect(applied.actions).toEqual([
    { type: ActionTypes.OPERATOR_APPLY, operator: Operators.DELETE, unit: 'message', from: 0, to: 1 },
  ]);
  expect(applied.state.operator).toBeNull();
});

test('d3j applies delete over three', () => {
  const engine = buildEngine();
  let state = INITIAL_ENGINE_STATE;
  state = engine.resolve({ state, key: buildKey('d'), keymap }).state;
  state = engine.resolve({ state, key: buildKey('3'), keymap }).state;
  const applied = engine.resolve({ state, key: buildKey('j'), keymap });
  expect(applied.actions[0]).toMatchObject({ operator: Operators.DELETE, from: 0, to: 3 });
});

test('3dj also applies over three — the count may precede the operator', () => {
  const engine = buildEngine();
  let state = INITIAL_ENGINE_STATE;
  state = engine.resolve({ state, key: buildKey('3'), keymap }).state;
  state = engine.resolve({ state, key: buildKey('d'), keymap }).state;
  const applied = engine.resolve({ state, key: buildKey('j'), keymap });
  expect(applied.actions[0]).toMatchObject({ from: 0, to: 3 });
});

test('escape cancels operator-pending without acting', () => {
  const engine = buildEngine();
  const pending = engine.resolve({ state: INITIAL_ENGINE_STATE, key: buildKey('d'), keymap });
  const cancelled = engine.resolve({ state: pending.state, key: buildKey('escape'), keymap });
  expect(cancelled.state.operator).toBeNull();
  expect(cancelled.actions).toEqual([]);
});

test('a key that is not a motion cancels operator-pending rather than acting', () => {
  const engine = buildEngine();
  const pending = engine.resolve({ state: INITIAL_ENGINE_STATE, key: buildKey('d'), keymap });
  const bogus = engine.resolve({ state: pending.state, key: buildKey('z'), keymap });
  expect(bogus.state.operator).toBeNull();
  expect(bogus.actions).toEqual([]);
});

test('an operator does not fire an ordinary cursor move', () => {
  const engine = buildEngine();
  const pending = engine.resolve({ state: INITIAL_ENGINE_STATE, key: buildKey('d'), keymap });
  const applied = engine.resolve({ state: pending.state, key: buildKey('j'), keymap });
  expect(applied.actions.some(action => action.type === ActionTypes.CURSOR_MOVE)).toBe(false);
});

// Chosen deliberately, per M1b-2's own brief: vim multiplies an operator's
// count against the motion's (2d3j deletes 6, not 3 and not 23). Getting
// this right needs the two counts kept apart -- state.count alone cannot
// tell "2, carried over from before the operator" from "2, the first digit
// of a fresh motion count" apart, and collapsing them into one field either
// silently concatenates (2 then 3 reads as 23) or drops one arbitrarily.
// IEngineState.operatorCount exists for exactly this: the count pending
// when the operator commits moves there, and `count` resets to null so a
// motion's own count accumulates fresh -- ordinarily, and here.
test('a count before the operator multiplies with a count typed after it, as in vim', () => {
  const engine = buildEngine();
  let state = INITIAL_ENGINE_STATE;
  state = engine.resolve({ state, key: buildKey('2'), keymap }).state;
  state = engine.resolve({ state, key: buildKey('d'), keymap }).state;
  state = engine.resolve({ state, key: buildKey('3'), keymap }).state;
  const applied = engine.resolve({ state, key: buildKey('j'), keymap });
  expect(applied.actions[0]).toMatchObject({ from: 0, to: 6 });
});

// Proof that operatorCount's split from count does not cost ordinary
// multi-digit motion counts: nothing preceded the operator here, so this
// exercises the same accumulateCount path any un-operated 12j would.
test('a multi-digit count after the operator accumulates normally', () => {
  const engine = buildEngine();
  let state = INITIAL_ENGINE_STATE;
  state = engine.resolve({ state, key: buildKey('d'), keymap }).state;
  state = engine.resolve({ state, key: buildKey('1'), keymap }).state;
  state = engine.resolve({ state, key: buildKey('2'), keymap }).state;
  const applied = engine.resolve({ state, key: buildKey('j'), keymap });
  expect(applied.actions[0]).toMatchObject({ from: 0, to: 12 });
});

test('y and c are also live operator triggers, not only d', () => {
  const engine = buildEngine();
  expect(engine.resolve({ state: INITIAL_ENGINE_STATE, key: buildKey('y'), keymap }).state.operator)
    .toBe(Operators.YANK);
  expect(engine.resolve({ state: INITIAL_ENGINE_STATE, key: buildKey('c'), keymap }).state.operator)
    .toBe(Operators.CHANGE);
});

// accumulateCount's own gate excludes INSERT deliberately (a digit there is
// composer text, not a count) -- operator entry must draw the same line, or
// typing an ordinary message containing the letter "d" would silently steal
// keystrokes into operator-pending instead of the composer.
test('d in insert mode does not enter operator-pending', () => {
  const engine = buildEngine();
  const insert: IEngineState = { ...INITIAL_ENGINE_STATE, mode: VimModes.INSERT };
  const result = engine.resolve({ state: insert, key: buildKey('d'), keymap });
  expect(result.state.operator).toBeNull();
});
