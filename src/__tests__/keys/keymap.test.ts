import { test, expect } from 'bun:test';

import { Container, BindingScopes } from '@venizia/ignis-inversion';

import { BindingKeys } from '../../common/index.ts';
import { ActionTypes, INITIAL_ENGINE_STATE, Operators, VimContexts, VimModes } from '../../keys/common/index.ts';
import type { IEngineState, IKey, TVimContext, TVimMode } from '../../keys/common/index.ts';
import { KeyNormalizerService } from '../../keys/key-normalizer.ts';
import { KeymapService } from '../../keys/keymap.ts';
import { VimEngineService } from '../../keys/vim-engine.ts';

const build = (): { keymapService: KeymapService; engine: VimEngineService; keyNormalizer: KeyNormalizerService } => {
  const container = new Container({ scope: 'KeymapTest' });
  container.bind({ key: BindingKeys.KEY_NORMALIZER }).toClass(KeyNormalizerService).setScope(BindingScopes.SINGLETON);
  container.bind({ key: BindingKeys.VIM_ENGINE }).toClass(VimEngineService).setScope(BindingScopes.SINGLETON);
  container.bind({ key: BindingKeys.KEYMAP }).toClass(KeymapService).setScope(BindingScopes.SINGLETON);
  return {
    keymapService: container.get<KeymapService>({ key: BindingKeys.KEYMAP }),
    engine: container.get<VimEngineService>({ key: BindingKeys.VIM_ENGINE }),
    keyNormalizer: container.get<KeyNormalizerService>({ key: BindingKeys.KEY_NORMALIZER }),
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

// Gap 4b (task-11-report.md): "the URL shown on K" (spec §3.1). K is already
// this project's LSP-hover-style key (M1 spec §5), and OpenTUI reports a
// shifted letter lowercased with shift set separately (ignis-style.md), so
// the binding has to be <S-k>, never a bare 'K'.
test('<S-k> shows the link under the cursor', () => {
  const { keymapService, engine } = build();
  const result = engine.resolve({
    state: INITIAL_ENGINE_STATE,
    key: buildKey('k', { shift: true }),
    keymap: keymapService.getBindings(),
  });
  expect(result.status).toBe('resolved');
  expect(result.actions).toEqual([{ type: ActionTypes.LINK_SHOW }]);
});

// A bare 'K' can never arrive from a real key press (ignis-style.md's own
// warning: OpenTUI lowercases a shifted letter into `name`), so a binding
// written that way would be permanently dead -- the same class of bug the
// promised-keys guard below exists to catch, pinned here at the source.
test('bare K is not bound -- only <S-k>, so it stays reachable', () => {
  const { keymapService } = build();
  expect(keymapService.getBindings().some(binding => binding.keys === 'K')).toBe(false);
});

test('dd asks to delete the message under the cursor', () => {
  const { keymapService, engine } = build();
  const keymap = keymapService.getBindings();
  // M1b-2 Task 3: `d` is now a live operator trigger (vim-engine.ts, engine-
  // intrinsic, no keymap entry), so the first `d` is genuinely ambiguous
  // against this real `dd` binding -- not merely `pending`, the way an
  // ordinary unclaimed prefix like `g` still is. See the two tests below for
  // both halves of that ambiguity settling.
  const pending = engine.resolve({ state: INITIAL_ENGINE_STATE, key: buildKey('d'), keymap });
  expect(pending.status).toBe('ambiguous');
  // M1b-2 Task 4: dd's own action is OPERATOR_APPLY now, count-aware like
  // yy/cc and any d+motion delete, rather than DELETE_REQUEST directly --
  // the reducer's OPERATOR_APPLY case still asks for confirmation before
  // deleting anything (action-reducer.ts, action-reducer.test.ts).
  expect(engine.resolve({ state: pending.state, key: buildKey('d'), keymap }).actions).toEqual([
    { type: ActionTypes.OPERATOR_APPLY, operator: Operators.DELETE, unit: 'message', from: 0, to: 0, register: null },
  ]);
});

// M1b-2 Task 4: a count reaches dd exactly as it reaches any other counted
// binding -- state.count flows into applyStateActions's binding.action(count)
// call the same way it always has; dd's own action just now does something
// with it instead of ignoring the parameter.
test('3dd asks to delete three messages, in one OPERATOR_APPLY', () => {
  const { keymapService, engine } = build();
  const keymap = keymapService.getBindings();
  let state = INITIAL_ENGINE_STATE;
  state = engine.resolve({ state, key: buildKey('3'), keymap }).state;
  const pending = engine.resolve({ state, key: buildKey('d'), keymap });
  expect(pending.status).toBe('ambiguous');
  expect(engine.resolve({ state: pending.state, key: buildKey('d'), keymap }).actions).toEqual([
    { type: ActionTypes.OPERATOR_APPLY, operator: Operators.DELETE, unit: 'message', from: 0, to: 2, register: null },
  ]);
});

// The Minor from M1b-1's final review: dd used to be `context: '*'`, so it
// deleted a message in the messages pane while the cursor was actually
// focused on the chat list. Fixed by scoping the dd binding itself to
// VimContexts.MESSAGES and, since d/y/c commit with no keymap entry of
// their own to filter by context, gating operator entry the same way in
// vim-engine.ts's operatorForToken (vim-engine.test.ts covers that half).
test('dd does nothing while focused on the chat list', () => {
  const { keymapService, engine } = build();
  const keymap = keymapService.getBindings();
  const chatList: IEngineState = { ...INITIAL_ENGINE_STATE, context: VimContexts.CHAT_LIST };
  const first = engine.resolve({ state: chatList, key: buildKey('d'), keymap });
  expect(first.status).toBe('unmapped');
  const second = engine.resolve({ state: first.state, key: buildKey('d'), keymap });
  expect(second.status).toBe('unmapped');
  expect(second.actions).toEqual([]);
});

// yy/cc get no keymap entry of their own -- reusing vim-engine.ts's
// operator-pending state instead (see its own doubled-form branch in
// resolveUnderOperator), the same way bare d/y/c never have. No competing
// binding means no ambiguity either: unlike bare `d` against the real `dd`,
// a bare `y` or `c` commits to operator-pending on the very first press.
test('yy against the real keymap yanks the message under the cursor', () => {
  const { keymapService, engine } = build();
  const keymap = keymapService.getBindings();
  const pending = engine.resolve({ state: INITIAL_ENGINE_STATE, key: buildKey('y'), keymap });
  expect(pending.status).toBe('pending');
  expect(pending.state.operator).toBe(Operators.YANK);
  expect(engine.resolve({ state: pending.state, key: buildKey('y'), keymap }).actions).toEqual([
    { type: ActionTypes.OPERATOR_APPLY, operator: Operators.YANK, unit: 'message', from: 0, to: 0, register: null },
  ]);
});

test('cc against the real keymap targets the message under the cursor for change', () => {
  const { keymapService, engine } = build();
  const keymap = keymapService.getBindings();
  const pending = engine.resolve({ state: INITIAL_ENGINE_STATE, key: buildKey('c'), keymap });
  expect(pending.state.operator).toBe(Operators.CHANGE);
  expect(engine.resolve({ state: pending.state, key: buildKey('c'), keymap }).actions).toEqual([
    { type: ActionTypes.OPERATOR_APPLY, operator: Operators.CHANGE, unit: 'message', from: 0, to: 0, register: null },
  ]);
});

test('bare y, bare c, yy and cc are none of them bound -- doubling is engine-intrinsic, not a keymap entry', () => {
  const keys = build().keymapService.getBindings().map(binding => binding.keys);
  expect(keys).not.toContain('y');
  expect(keys).not.toContain('c');
  expect(keys).not.toContain('yy');
  expect(keys).not.toContain('cc');
});

// M1b-2 Task 5: registers. `"` is engine-intrinsic exactly like the bare
// operator triggers above -- no keymap entry of its own.
test('bare " is not bound -- register-pending is engine-intrinsic, not a keymap entry', () => {
  const keys = build().keymapService.getBindings().map(binding => binding.keys);
  expect(keys).not.toContain('"');
});

test('"ayy against the real keymap names register a, then yanks the message under the cursor', () => {
  const { keymapService, engine } = build();
  const keymap = keymapService.getBindings();
  let state = INITIAL_ENGINE_STATE;
  state = engine.resolve({ state, key: buildKey('"'), keymap }).state;
  const named = engine.resolve({ state, key: buildKey('a'), keymap });
  expect(named.status).toBe('resolved');
  expect(named.state.register).toBe('a');
  state = named.state;
  state = engine.resolve({ state, key: buildKey('y'), keymap }).state;
  const applied = engine.resolve({ state, key: buildKey('y'), keymap });
  expect(applied.actions).toEqual([
    { type: ActionTypes.OPERATOR_APPLY, operator: Operators.YANK, unit: 'message', from: 0, to: 0, register: 'a' },
  ]);
});

// Decision 3 (task-5-brief.md), against the real keymap this time: the same
// M1b-1 rule dd's own context fix and operatorForToken's gate already apply.
test('" does nothing while focused on the chat list', () => {
  const { keymapService, engine } = build();
  const keymap = keymapService.getBindings();
  const chatList: IEngineState = { ...INITIAL_ENGINE_STATE, context: VimContexts.CHAT_LIST };
  const result = engine.resolve({ state: chatList, key: buildKey('"'), keymap });
  expect(result.status).toBe('unmapped');
  expect(result.state.register).toBeNull();
});

// `d` needs no binding of its own: vim-engine.ts treats it (along with `y`
// and `c`) as an operator trigger intrinsically, the same way it already
// treats digits as counts without a keymap entry for each one (see
// OPERATOR_TRIGGERS in vim-engine.ts). This just pins that keymap.ts really
// has no literal `d` entry to collide with `dd` -- not that one would be
// unreachable if it existed; Task 1 already removed that limit
// (vim-engine.test.ts's own ambiguous-status tests).
test('bare d is not bound -- only dd, so it stays reachable', () => {
  const { keymapService } = build();
  expect(keymapService.getBindings().some(binding => binding.keys === 'd')).toBe(false);
});

// The other half of the ambiguity above: a real motion, not a second `d`,
// settles it immediately in the same key press -- no timeout needed, since
// resolve() already knows `dd` cannot complete once the second key isn't
// `d`. This is the first genuinely ambiguous sequence the real keymap has
// ever produced (Task 1's report verified zero among the original 27
// bindings), so it is also what makes App's timeoutlen (Task 2) live
// against production key presses for the first time -- previously only
// app.test.tsx's own test-only binding could construct one.
test('d then a real motion resolves immediately as an operator application, not dd', () => {
  const { keymapService, engine } = build();
  const keymap = keymapService.getBindings();

  const pending = engine.resolve({ state: INITIAL_ENGINE_STATE, key: buildKey('d'), keymap });
  expect(pending.status).toBe('ambiguous');
  expect(pending.state.operator).toBeNull();

  const applied = engine.resolve({ state: pending.state, key: buildKey('j'), keymap });
  expect(applied.status).toBe('resolved');
  expect(applied.actions).toEqual([
    { type: ActionTypes.OPERATOR_APPLY, operator: Operators.DELETE, unit: 'message', from: 0, to: 1, register: null },
  ]);
});

// M1b-2 Task 7: `.` is engine-intrinsic exactly like the bare operator
// triggers and the register prefix above -- no keymap entry of its own.
test('bare . is not bound -- repeat is engine-intrinsic, not a keymap entry', () => {
  const keys = build().keymapService.getBindings().map(binding => binding.keys);
  expect(keys).not.toContain('.');
});

// Against the real keymap this time (real dd, with its own d/dd ambiguity
// dance), the same way "yy against the real keymap" and "\"ayy against the
// real keymap" already prove their own engine-intrinsic features work
// outside this file's synthetic fixture.
test('. against the real keymap repeats dd', () => {
  const { keymapService, engine } = build();
  const keymap = keymapService.getBindings();

  const pending = engine.resolve({ state: INITIAL_ENGINE_STATE, key: buildKey('d'), keymap });
  expect(pending.status).toBe('ambiguous');
  const applied = engine.resolve({ state: pending.state, key: buildKey('d'), keymap });
  expect(applied.actions).toEqual([
    { type: ActionTypes.OPERATOR_APPLY, operator: Operators.DELETE, unit: 'message', from: 0, to: 0, register: null },
  ]);

  const repeated = engine.resolve({ state: applied.state, key: buildKey('.'), keymap });
  expect(repeated.status).toBe('resolved');
  expect(repeated.actions).toEqual([
    { type: ActionTypes.OPERATOR_APPLY, operator: Operators.DELETE, unit: 'message', from: 0, to: 0, register: null },
  ]);
});

// "d alone waits": nothing completes the ambiguity within the same
// synchronous key press, so it is still there for App's timeoutlen to
// settle via flushPending -- which commits the operator (not DELETE_REQUEST,
// dd's own action) and keeps waiting for a motion, exactly as real vim's
// operator-pending has no timeout of its own once the ambiguity itself is
// resolved.
test('d alone against the real keymap commits the operator once flushPending fires, not dd', () => {
  const { keymapService, engine } = build();
  const keymap = keymapService.getBindings();

  const pending = engine.resolve({ state: INITIAL_ENGINE_STATE, key: buildKey('d'), keymap });
  const flushed = engine.flushPending({ state: pending.state, keymap });
  expect(flushed.status).toBe('pending');
  expect(flushed.actions).toEqual([]);
  expect(flushed.state.operator).toBe(Operators.DELETE);
  expect(flushed.state.pending).toEqual([]);
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

// M1b-2 Task 8: <C-p>, fuzzy jump to any chat. Only the opening half lives in
// the keymap -- once the chat picker overlay is open, app.tsx intercepts
// every key (including a second <C-p>) directly, ahead of engine resolution,
// the same way it already does for the which-key overlay's own escape.
test('<C-p> toggles the chat picker overlay', () => {
  const { keymapService, engine } = build();
  const result = engine.resolve({
    state: INITIAL_ENGINE_STATE,
    key: buildKey('p', { ctrl: true }),
    keymap: keymapService.getBindings(),
  });
  expect(result.status).toBe('resolved');
  expect(result.actions).toEqual([{ type: ActionTypes.OVERLAY_TOGGLE, overlay: 'chatpicker' }]);
});

// M1b-2 Task 9: `/` search overlay -- opens exactly like `\` and `<C-p>`
// above; app.tsx intercepts every key once it is open, the same pattern.
test('/ toggles the search overlay', () => {
  const { keymapService, engine } = build();
  const result = engine.resolve({
    state: INITIAL_ENGINE_STATE,
    key: buildKey('/'),
    keymap: keymapService.getBindings(),
  });
  expect(result.status).toBe('resolved');
  expect(result.actions).toEqual([{ type: ActionTypes.OVERLAY_TOGGLE, overlay: 'search' }]);
});

// `n` gains a real binding of its own (cycle forward through search matches),
// which makes it genuinely ambiguous against the real `nf` binding below --
// the same shape `d` vs `dd` already established (Task 3). This is the
// collision the brief asked to be checked for; see app.test.tsx for the
// end-to-end proof that `nf`, typed quickly, still resolves exactly as it did
// before this task, via App's own timeoutlen (Tasks 1-2).
test('n is ambiguous against nf', () => {
  const { keymapService, engine } = build();
  const keymap = keymapService.getBindings();
  const pending = engine.resolve({ state: INITIAL_ENGINE_STATE, key: buildKey('n'), keymap });
  expect(pending.status).toBe('ambiguous');
  expect(engine.resolve({ state: pending.state, key: buildKey('f'), keymap }).actions).toEqual([
    { type: ActionTypes.FOCUS_SET, context: VimContexts.CHAT_LIST },
  ]);
});

// The other half: nothing completes `nf` within the same key press, so `n`
// alone is still there for App's timeoutlen to settle via flushPending --
// which resolves n's own binding (cycle forward), not nf.
test('n alone, once flushPending settles it, cycles forward through search matches', () => {
  const { keymapService, engine } = build();
  const keymap = keymapService.getBindings();
  const pending = engine.resolve({ state: INITIAL_ENGINE_STATE, key: buildKey('n'), keymap });
  const flushed = engine.flushPending({ state: pending.state, keymap });
  expect(flushed.status).toBe('resolved');
  expect(flushed.actions).toEqual([{ type: ActionTypes.SEARCH_CYCLE, direction: 'next' }]);
});

// <S-n> shares no prefix with `nf` (a real Shift-N press canonicalizes to
// "<S-n>", never bare "N" -- ignis-style.md), so it resolves immediately,
// with no ambiguity to settle, unlike bare n above.
test('<S-n> cycles backward through search matches, with no ambiguity', () => {
  const { keymapService, engine } = build();
  const result = engine.resolve({
    state: INITIAL_ENGINE_STATE,
    key: buildKey('n', { shift: true }),
    keymap: keymapService.getBindings(),
  });
  expect(result.status).toBe('resolved');
  expect(result.actions).toEqual([{ type: ActionTypes.SEARCH_CYCLE, direction: 'previous' }]);
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
    // M1b-2 Task 8: fuzzy jump to any chat.
    { context: '*', mode: VimModes.NORMAL, keys: '<C-p>' },
    // M1b-2 Task 9: `/` search, and n/N to cycle its matches.
    { context: '*', mode: VimModes.NORMAL, keys: '/' },
    { context: '*', mode: VimModes.NORMAL, keys: 'n' },
    { context: '*', mode: VimModes.NORMAL, keys: '<S-n>' },
    // M1b-1 message actions -- spec §3.1/§3.2, promised in the README's key
    // table. The same class of bug this whole guard exists for: each of
    // these is one binding away from being silently left out of the table.
    { context: '*', mode: VimModes.NORMAL, keys: 'zs' },
    { context: '*', mode: VimModes.NORMAL, keys: 'r' },
    { context: '*', mode: VimModes.NORMAL, keys: 'e' },
    // M1b-2 Task 4: no longer '*' -- the Minor from M1b-1's review (dd
    // deleted in the messages pane while the chat list had focus).
    { context: VimContexts.MESSAGES, mode: VimModes.NORMAL, keys: 'dd' },
    // Task 12 (task-11-report.md gap 4b): K shows a link's URL on the status
    // line -- promised by the design spec's own rendering table and, like the
    // row above, one binding away from being silently left out.
    { context: '*', mode: VimModes.NORMAL, keys: '<S-k>' },
    // Mode changes
    { context: '*', mode: VimModes.NORMAL, keys: 'i' },
    { context: '*', mode: VimModes.NORMAL, keys: 'a' },
    { context: '*', mode: VimModes.INSERT, keys: 'jk' },
    { context: '*', mode: VimModes.INSERT, keys: '<escape>' },
    { context: '*', mode: VimModes.INSERT, keys: '<return>' },
    // Application. <C-l> is the only way to clear an integrity warning:
    // IApplicationState.integrityWarning is deliberately unreachable from
    // every service patch that clears statusMessage, so losing this binding
    // would strand the warning on the status line for the rest of the session.
    { context: '*', mode: VimModes.NORMAL, keys: '<C-l>' },
    { context: '*', mode: VimModes.NORMAL, keys: '<C-c>' },
  ];

  for (const binding of promised) {
    expect({ ...binding, bound: isBound(binding) }).toEqual({ ...binding, bound: true });
  }
});

// The same class of bug the guard above exists for, but for M1b-2's
// engine-intrinsic keys specifically: none of d/y/c, yy/cc, " or . has a
// keymap entry for that guard's own isBound to find -- the tests earlier in
// this file pin that directly ("bare d/y/c/./\" is not bound"). describe()'s
// separate _intrinsicKeys list (keymap.ts) is the only thing that keeps these
// seven keys from silently vanishing out of the which-key popup, so this
// checks describe()'s own output the same way the guard above checks
// getBindings(). app.test.tsx's own which-key test covers the other half --
// that the popup actually renders whatever this list returns.
test('every engine-intrinsic key the project promises the user is still described', () => {
  const shown = build().keymapService.describe({ mode: VimModes.NORMAL, context: VimContexts.MESSAGES });
  const describedKeys = shown.map(entry => entry.keys);
  const isDescribed = (keys: string): boolean => describedKeys.includes(keys);

  const promisedIntrinsic = ['d', 'y', 'c', 'yy', 'cc', '"', '.'];
  for (const keys of promisedIntrinsic) {
    expect({ keys, described: isDescribed(keys) }).toEqual({ keys, described: true });
  }

  // dd keeps its own real binding (keymap.ts) rather than an intrinsic
  // descriptor -- describe() folding the two lists together must not end up
  // listing it twice.
  expect(describedKeys.filter(keys => keys === 'dd')).toHaveLength(1);
});

// Mirrors "dd does nothing while focused on the chat list" and "\" does
// nothing while focused on the chat list" above, but for describe() rather
// than resolve(): _intrinsicKeys carries the same context as vim-engine.ts's
// own isMessagesNormalMode gate, so the popup must not advertise a key that
// would not actually do anything from the pane the user is currently in.
test('engine-intrinsic keys are not described while focused on the chat list', () => {
  const shown = build().keymapService.describe({ mode: VimModes.NORMAL, context: VimContexts.CHAT_LIST });
  const describedKeys = shown.map(entry => entry.keys);
  for (const keys of ['d', 'y', 'c', 'yy', 'cc', '"', '.']) {
    expect(describedKeys.includes(keys)).toBe(false);
  }
});

// y cannot join the `promised` list above: outside a pending confirmation it
// is already engine-intrinsic (vim-engine.ts's OPERATOR_TRIGGERS, the yank
// trigger, no keymap entry -- the same reason bare `d` has none either), and
// while IApplicationState.pendingConfirmation is set, both `y` and `n` mean
// "answer the question" instead, intercepted directly in app.tsx ahead of
// engine.resolve (the same way it already has to for the which-key overlay's
// escape and the reply/edit escapes -- see keymap.ts's own comment on the dd
// binding). `n` itself DID join the list above as of M1b-2 Task 9 (it is now
// a real binding, cycling search matches) -- the two meanings never collide,
// since the pendingConfirmation gate in app.tsx returns before engine.resolve
// is ever reached, so a real `n` keymap entry is simply unreachable for as
// long as a confirmation is pending. What this test guards is the contract
// app.tsx's own interception depends on regardless: it compares
// keyNormalizer.toCanonicalString(key) against the literal strings 'y' and
// 'n', so a change to normalization that altered how a bare letter
// stringifies (see the ignis-style note on capital letters, for the shape
// such a change could take) would silently break the delete confirmation with
// nothing else here to catch it.
test('y and n normalize to the literal tokens the delete confirmation compares against', () => {
  const { keyNormalizer } = build();
  expect(keyNormalizer.toCanonicalString({ key: buildKey('y') })).toBe('y');
  expect(keyNormalizer.toCanonicalString({ key: buildKey('n') })).toBe('n');
});

// ---------------------------------------------------------------------------
// The operators, registers and repeat are NOT table bindings -- vim-engine.ts
// reduces them, and keymap.ts carries display-only descriptors so which-key
// can list them. That split is exactly where the `\` bug can happen again in a
// new place: a descriptor advertises a key in the which-key popup while the
// engine ignores it, and the guard above cannot see it because the key was
// never meant to be in getBindings().
//
// So this asserts the two halves against each other. Every intrinsic key the
// popup advertises must be one the engine actually acts on -- anything the
// engine reports `unmapped` for is advertised and dead.
// ---------------------------------------------------------------------------
test('every intrinsic key which-key advertises is one the engine actually acts on', () => {
  const { keymapService, engine } = build();
  const keymap = keymapService.getBindings();

  const advertised = keymapService
    .describe({ mode: VimModes.NORMAL, context: VimContexts.MESSAGES })
    .map(entry => entry.keys);

  // The seven from the plan's Task 12 list that are engine-intrinsic rather
  // than table-driven. `dd` is asserted in the promised-keys guard above,
  // because it IS a table binding.
  for (const keys of ['d', 'y', 'c', 'yy', 'cc', '"', '.']) {
    expect(advertised, `which-key advertises ${keys}`).toContain(keys);

    // Fed one character at a time, the way a person types it: `yy` must
    // survive `y` leaving the engine mid-operator rather than unmapped.
    let state: IEngineState = INITIAL_ENGINE_STATE;
    let status = 'unmapped';
    for (const character of [...keys]) {
      const result = engine.resolve({ state, key: buildKey(character), keymap });
      state = result.state;
      status = result.status;
    }
    expect(status, `the engine acts on ${keys}`).not.toBe('unmapped');
  }
});

// dd is a real keymap binding, not the intrinsic doubled form the engine's own
// branch handles -- so it records lastChange through applyStateActions, a
// different code path with a different chance of dropping the register. The
// vim-engine tests cannot see this: their keymap has no dd, so `"add` there
// goes through the intrinsic branch instead and passes either way. This is the
// path a real key press actually takes.
test('"add against the real keymap records the register, so . replays into it', () => {
  const { keymapService, engine } = build();
  const keymap = keymapService.getBindings();
  let state = INITIAL_ENGINE_STATE;
  for (const character of ['"', 'a', 'd', 'd']) {
    state = engine.resolve({ state, key: buildKey(character), keymap }).state;
  }

  const repeated = engine.resolve({ state, key: buildKey('.'), keymap });

  expect(repeated.actions).toEqual([
    { type: ActionTypes.OPERATOR_APPLY, operator: Operators.DELETE, unit: 'message', from: 0, to: 0, register: 'a' },
  ]);
});

// nvim: 6Gdk then 3. deletes four lines upward. Driven against the real keymap
// because that is where k is actually bound to a negative delta.
test('3. after dk against the real keymap repeats upward', () => {
  const { keymapService, engine } = build();
  const keymap = keymapService.getBindings();
  let state = INITIAL_ENGINE_STATE;
  for (const character of ['d', 'k', '3']) {
    state = engine.resolve({ state, key: buildKey(character), keymap }).state;
  }

  const repeated = engine.resolve({ state, key: buildKey('.'), keymap });

  expect(repeated.actions).toEqual([
    { type: ActionTypes.OPERATOR_APPLY, operator: Operators.DELETE, unit: 'message', from: -3, to: 0, register: null },
  ]);
});
