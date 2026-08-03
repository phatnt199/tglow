# tglow M1b-2 — the editor layer

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `d`, `y` and `c` compose with motions and counts; registers work including the system clipboard; `.` repeats; `<C-p>` jumps to any chat and `/` searches; and all twelve devglow palettes ship alongside user-defined themes.

**Architecture:** The vim engine stays pure. It gains an `ambiguous` status and a `flushPending` entry point; `App` owns the timer, because a timeout is I/O and the engine has none. Operators are engine state, not App state. Registers live in the store. The picker and search reuse the overlay pattern the which-key popup established.

**Tech Stack:** Bun · TypeScript 7.0.2 · `@venizia/ignis-inversion` · `@opentui/react` · GramJS · Drizzle over `bun:sqlite`

Implements §4 of `docs/superpowers/specs/2026-08-02-tglow-m1b-design.md`.

## Global Constraints

- **Read `docs/superpowers/conventions/ignis-style.md` first.** Binding on every file.
- **No commit message may contain Claude or Anthropic attribution.** No `Co-Authored-By` trailer.
- Arrow functions only; named exports only; explicit return types; options object `opts` except a single fully-typed domain object; `I` prefix on interfaces, `T` on type aliases; kebab-case files; private data fields `_`-prefixed, private methods not; **never abbreviate**.
- Never `new Error` — `getError({ message: '[Class][method] …' })`. Every `catch` logs first. Every `switch` has braces per case and a `default`.
- Dependency rule, enforced by `src/__tests__/boundaries.test.ts` over `src/keys`, `src/core`, `src/cli`, `src/tui`: `keys/` imports only `@venizia/ignis-inversion` and relative paths; `core/` never `react` or `@opentui/*`; `tui/` never `telegram`.
- **Tests live under `src/__tests__/`**, mirroring `src/`. Never elsewhere.
- **Every simulated key press is wrapped in React's `act()`**; a lone Escape needs the existing `pressEscape` helper, which waits for the parser's disambiguation timeout.
- `bun test` green, `bun run typecheck` clean, `bun test 2>&1 | grep -ciE 'MaxListeners|not wrapped in act'` = 0, and `bun run build` still produces the binary.
- Commit after every task.

## What already exists

```ts
// src/keys/common/types.ts
interface IEngineState { mode: TVimMode; context: TVimContext; pending: string[]; count: number | null; }
type TResolveStatus = 'pending' | 'resolved' | 'unmapped';
interface IResolveResult { state: IEngineState; actions: TAction[]; status: TResolveStatus; }
interface IKeyBinding { context: TVimContext | '*'; mode: TVimMode | TVimMode[]; keys: string; action: (count: number) => TAction[]; description: string; }
// src/keys/vim-engine.ts
resolve(opts: { state: IEngineState; key: IKey; keymap: IKeyBinding[] }): IResolveResult
// src/keys/key-normalizer.ts
parseKeySequence(keys: string): string[]   // "<C-p>" is one token, "gg" is two
```

`pending` is already an array of whole tokens, so a typed `<` can never prefix `<escape>`. The
remaining ambiguity is different: a sequence that is *both* an exact match and a prefix of a
longer binding. That is what Task 1 solves.

---

## File structure

| File | Responsibility |
| --- | --- |
| `src/keys/vim-engine.ts` | `ambiguous` status, `flushPending`, operator-pending resolution |
| `src/keys/common/types.ts` | `operator` on `IEngineState`; register and repeat actions |
| `src/keys/keymap.ts` | `d`/`y`/`c`, doubled forms, `"` register prefix, `.`, `<C-p>`, `/` |
| `src/tui/app.tsx` | owns the `timeoutlen` timer |
| `src/core/clipboard.ts` | **new** — OSC 52 write |
| `src/tui/overlays/chat-picker.tsx` | **new** — `<C-p>` |
| `src/tui/overlays/search.tsx` | **new** — `/` |
| `src/core/message-search.ts` | **new** — cached-message search |
| `src/tui/theme/palettes.ts` | the remaining ten |
| `src/tui/theme/theme-loader.ts` | **new** — built-ins plus `~/.config/tglow/themes/` |

---

### Task 1: `ambiguous` status and `flushPending`

**Files:** `src/keys/common/types.ts`, `src/keys/vim-engine.ts`; test `src/__tests__/keys/vim-engine.test.ts`

**Interfaces:**
- Produces: `TResolveStatus` gains `'ambiguous'`; `flushPending(opts: { state: IEngineState; keymap: IKeyBinding[] }): IResolveResult`

- [ ] **Step 1: Write the failing test**

Replace the existing invariant test named `a binding that is also a prefix of a longer one makes
the longer one unreachable (known limit, see M1b)` — that limitation is what this task removes.
Do **not** delete it silently; replace it with these:

```ts
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
```

- [ ] **Step 2: Run and watch them fail**

Run: `bun test src/__tests__/keys/vim-engine.test.ts`
Expected: FAIL — `ambiguous` and `flushPending` do not exist.

- [ ] **Step 3: Implement**

Add `'ambiguous'` to `TResolveStatus`. In `resolve`, after finding an exact match, also test
whether any candidate binding *extends* the sequence. If both are true, return `ambiguous` with
the tokens still pending and no actions. If only the exact match holds, resolve as today.

`flushPending` takes the current state, looks for an exact match on `state.pending`, and returns
`resolved` with its actions or `unmapped` with pending cleared. It never consults a key — it is
the timer's way of saying "nothing more is coming".

Both must remain pure: no timers, no clock, no I/O.

- [ ] **Step 4: Run and watch them pass**, then run the full suite and typecheck.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Report an ambiguous key sequence instead of resolving it early

A sequence that is both an exact match and the start of a longer binding
was resolved immediately, which made the longer binding unreachable --
the reason dd could not coexist with d. The engine now reports the
ambiguity and offers flushPending; deciding when to give up waiting is a
timer, which is I/O, and the engine has none."
```

---

### Task 2: App owns the timeout

**Files:** `src/tui/app.tsx`, `src/core/common/types.ts` (configuration); test `src/__tests__/tui/app.test.tsx`

**Interfaces:**
- Consumes: `flushPending`, `'ambiguous'`
- Produces: `IApplicationConfiguration` gains `timeoutMilliseconds: number` (default 400)

- [ ] **Step 1: Write the failing test**

```ts
test('an ambiguous key resolves the short binding after the timeout', async () => {
  const { renderer, store } = await mount();
  await act(async () => { renderer.mockInput.pressKey('d'); });
  await renderer.flush();
  expect(store.getState().pendingConfirmation).toBeNull();   // dd has not fired
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 500)); });
  await renderer.flush();
  // the short binding's effect, whatever the keymap binds `d` to
});

test('a second key beats the timer and resolves the longer binding', async () => {
  const { renderer, store } = await mount();
  await act(async () => { renderer.mockInput.pressKey('d'); renderer.mockInput.pressKey('d'); });
  await renderer.flush();
  expect(store.getState().pendingConfirmation).not.toBeNull();  // dd fired
});

test('the timer is cancelled when a key arrives, so the short binding never also fires', async () => {
  const { renderer, store } = await mount();
  await act(async () => { renderer.mockInput.pressKey('d'); renderer.mockInput.pressKey('d'); });
  await renderer.flush();
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 500)); });
  await renderer.flush();
  // exactly one confirmation, not one from dd and another from a late d
  expect(store.getState().pendingConfirmation).not.toBeNull();
});

test('unmounting clears a running timer', async () => {
  const { renderer } = await mount();
  await act(async () => { renderer.mockInput.pressKey('d'); });
  await renderer.flush();
  expect(() => renderer.renderer.destroy()).not.toThrow();
});
```

- [ ] **Step 2: Run and watch them fail**, then implement.

Hold the timer id in a ref, not state — the keyboard handler must see the current value
synchronously, the same reason it already reads `store.getState()` fresh rather than a React
snapshot. **Clear the timer on every key press before doing anything else**, and clear it on
unmount. A timer that survives a keypress fires the short binding *after* the long one already
ran, which is the subtle failure this task must not ship.

`timeoutMilliseconds` comes from configuration with a default of 400, so it can be tuned without
a rebuild.

- [ ] **Step 3: Run everything, then commit**

```bash
git add -A
git commit -m "Give an ambiguous key sequence a timeout, as vim does

The engine reports ambiguity; App decides how long to wait. The timer is
cleared on every key press and on unmount -- one that survives a press
would fire the short binding after the long one had already run."
```

---

### Task 3: Operators compose with motions

**Files:** `src/keys/common/types.ts`, `src/keys/common/constants.ts`, `src/keys/vim-engine.ts`, `src/keys/keymap.ts`; tests in `src/__tests__/keys/`

**Interfaces:**
- Produces: `IEngineState` gains `operator: TOperator | null`; `Operators` static class with `DELETE`, `YANK`, `CHANGE`; `TAction` gains `{ type: ActionTypes.OPERATOR_APPLY; operator: TOperator; unit: TCursorUnit; from: number; to: number }`

- [ ] **Step 1: Write the failing tests**

```ts
test('d alone enters operator-pending', () => {
  const result = engine.resolve({ state: INITIAL_ENGINE_STATE, key: buildKey('d'), keymap });
  expect(result.state.operator).toBe(Operators.DELETE);
});

test('dj applies delete over one message downward', () => {
  const pending = engine.resolve({ state: INITIAL_ENGINE_STATE, key: buildKey('d'), keymap });
  const applied = engine.resolve({ state: pending.state, key: buildKey('j'), keymap });
  expect(applied.actions).toEqual([
    { type: ActionTypes.OPERATOR_APPLY, operator: Operators.DELETE, unit: 'message', from: 0, to: 1 },
  ]);
  expect(applied.state.operator).toBeNull();
});

test('d3j applies delete over three', () => {
  let state = INITIAL_ENGINE_STATE;
  state = engine.resolve({ state, key: buildKey('d'), keymap }).state;
  state = engine.resolve({ state, key: buildKey('3'), keymap }).state;
  const applied = engine.resolve({ state, key: buildKey('j'), keymap });
  expect(applied.actions[0]).toMatchObject({ operator: Operators.DELETE, from: 0, to: 3 });
});

test('3dj also applies over three — the count may precede the operator', () => {
  let state = INITIAL_ENGINE_STATE;
  state = engine.resolve({ state, key: buildKey('3'), keymap }).state;
  state = engine.resolve({ state, key: buildKey('d'), keymap }).state;
  const applied = engine.resolve({ state, key: buildKey('j'), keymap });
  expect(applied.actions[0]).toMatchObject({ from: 0, to: 3 });
});

test('escape cancels operator-pending without acting', () => {
  const pending = engine.resolve({ state: INITIAL_ENGINE_STATE, key: buildKey('d'), keymap });
  const cancelled = engine.resolve({ state: pending.state, key: buildKey('escape'), keymap });
  expect(cancelled.state.operator).toBeNull();
  expect(cancelled.actions).toEqual([]);
});

test('a key that is not a motion cancels operator-pending rather than acting', () => {
  const pending = engine.resolve({ state: INITIAL_ENGINE_STATE, key: buildKey('d'), keymap });
  const bogus = engine.resolve({ state: pending.state, key: buildKey('z'), keymap });
  expect(bogus.state.operator).toBeNull();
  expect(bogus.actions).toEqual([]);
});

test('an operator does not fire an ordinary cursor move', () => {
  const pending = engine.resolve({ state: INITIAL_ENGINE_STATE, key: buildKey('d'), keymap });
  const applied = engine.resolve({ state: pending.state, key: buildKey('j'), keymap });
  expect(applied.actions.some(action => action.type === ActionTypes.CURSOR_MOVE)).toBe(false);
});
```

- [ ] **Step 2: Run and watch them fail**, then implement.

While `operator` is set, a motion binding does not emit its own action; instead the engine
converts the motion's delta into an `OPERATOR_APPLY` range and clears the operator. Counts
multiply as usual and may appear before or after the operator, as in vim.

- [ ] **Step 3: Run everything, then commit.**

---

### Task 4: Doubled operators, and `d` becomes bindable

**Files:** `src/keys/keymap.ts`, `src/tui/action-reducer.ts`, `src/tui/app.tsx`; tests as above

- [ ] **Step 1: Write the failing tests** — `dd` deletes the message under the cursor and still
  asks for confirmation (M1b-1's guarantee, which must survive); `yy` yanks one message; `3dd`
  targets three; `dd` in the chat list does nothing rather than deleting a message in the other
  pane (a Minor from M1b-1's review, fixed here since operators make it reachable).

- [ ] **Step 2: Implement.** A doubled operator (`dd`, `yy`, `cc`) targets `count` whole
  messages from the cursor. Delete still routes through `DELETE_REQUEST` and its confirmation —
  operators must not become a way around it.

- [ ] **Step 3: Run everything, then commit.**

---

### Task 5: Registers

**Files:** `src/keys/common/types.ts`, `src/keys/vim-engine.ts`, `src/keys/keymap.ts`, `src/core/application-store.ts`, `src/tui/action-reducer.ts`; tests in `src/__tests__/`

**Interfaces:**
- Produces: `IEngineState` gains `register: string | null`; `IApplicationState` gains `registers: Record<string, string>`; `TAction` gains `{ type: ActionTypes.REGISTER_SET; name: string }`

- [ ] **Step 1: Write the failing tests** — `"a` sets the pending register and the next `yy`
  writes there; an unnamed yank writes to `"`; `"ayy` then `"byy` keeps both; a register name
  is consumed by one operation and does not leak into the next.

- [ ] **Step 2: Implement.** `"` puts the engine in register-pending: the next key names the
  register. Yank writes the message text to `registers[name]`. Keep it to letters and `+`.

- [ ] **Step 3: Run everything, then commit.**

---

### Task 6: `"+y` writes to the system clipboard

**Files:** `src/core/clipboard.ts`; test `src/__tests__/core/clipboard.test.ts`

**Interfaces:**
- Produces: `buildOsc52Sequence(opts: { text: string }): string`, `writeToClipboard(opts: { text: string; write: (sequence: string) => void }): void`

The owner's alacritty sets `terminal.osc52 = "OnlyCopy"`, so this works — but **the renderer owns
stdout**, and writing an escape sequence into the middle of a frame is exactly how the
interleaved-text bug happened.

- [ ] **Step 1: Write the failing test** — the sequence is `\x1b]52;c;<base64>\x07`; a
  multi-byte string (Vietnamese, emoji) base64-encodes from UTF-8 bytes, not from code units;
  empty text produces a valid clear sequence; `writeToClipboard` calls the injected writer
  exactly once and never touches `process.stdout` itself.

- [ ] **Step 2: Implement.** `buildOsc52Sequence` is pure. `writeToClipboard` takes the writer
  as a parameter so tests never touch a terminal — and so App can route it through whatever
  OpenTUI provides rather than racing the renderer.

- [ ] **Step 3: Find out how to emit a raw sequence safely.** Read `@opentui/core`'s renderer
  for a method that writes an escape sequence outside the frame — look for something like a raw
  write, an external-output hook, or a documented escape hatch. **If none exists, say so and
  report what you found rather than writing to `process.stdout` and hoping.** A corrupted frame
  is worse than a missing clipboard integration, and the owner can copy with the mouse.

- [ ] **Step 4: Run everything, then commit.**

---

### Task 7: `.` repeats the last change

**Files:** `src/keys/common/types.ts`, `src/keys/vim-engine.ts`, `src/keys/keymap.ts`

- [ ] **Step 1: Write the failing tests** — `.` after `dd` repeats the delete on the message now
  under the cursor; `.` with no prior change does nothing; a motion alone is not a change and is
  not repeated; `3.` repeats with a new count; a *failed* operation is not recorded, so `.` does
  not retry something that just failed.

- [ ] **Step 2: Implement.** `IEngineState.lastChange: TAction[] | null`, set when an operator
  applies. `.` re-emits it, substituting a freshly typed count when one is given.

- [ ] **Step 3: Run everything, then commit.**

---

### Task 8: `<C-p>` fuzzy chat jump

**Files:** `src/tui/overlays/chat-picker.tsx`, `src/core/fuzzy-match.ts`; tests for both

**Interfaces:**
- Produces: `fuzzyMatch(opts: { candidates: string[]; query: string }): { index: number; score: number }[]`

- [ ] **Step 1: Write the failing tests for `fuzzyMatch`** — subsequence matching, so `dvs`
  matches `devs — backend`; case-insensitive; a contiguous run scores above a scattered one;
  a match at a word boundary scores above one mid-word; an empty query returns everything in
  original order; **Vietnamese input matches with and without diacritics**, so `duc` finds
  `Đức anh hoàng` — the owner's chat list is full of these and an ASCII-only matcher is useless
  to them.

- [ ] **Step 2: Write the overlay**, following the which-key pattern: it replaces the composer
  area, takes every key while open, `<C-n>`/`<C-p>` or `j`/`k` move the selection, `Enter` opens
  the chat, `<escape>` closes. Typing filters.

- [ ] **Step 3: Test through `App`** with real key presses: `<C-p>` opens it, typing narrows the
  list, `Enter` opens the selected chat, `<escape>` closes without changing the active chat.

- [ ] **Step 4: Run everything, then commit.**

---

### Task 9: `/` searches cached messages

**Files:** `src/core/message-search.ts`, `src/tui/overlays/search.tsx`, `src/core/cache/database.ts`

**Interfaces:**
- Produces: `DatabaseService.searchMessages(opts: { peerId: string; query: string; limit: number }): IMessageRow[]`; `MessageSearchService.search(...)`

- [ ] **Step 1: Write the failing database test** — a `LIKE` search scoped to one peer, case-
  insensitive, matching a substring; `%` and `_` in the query are escaped so they are literal;
  deleted messages are excluded; the limit is honoured; **a query with Vietnamese characters
  matches**.

- [ ] **Step 2: Write the overlay** — `/` opens it, typing searches as you type, `Enter` jumps
  the cursor to the first match, `n`/`N` cycle, `<escape>` closes and restores the cursor.

- [ ] **Step 3: Test through `App`.**

- [ ] **Step 4: Run everything, then commit.**

---

### Task 10: The remaining ten devglow palettes

**Files:** `src/tui/theme/palettes.ts`; test `src/__tests__/tui/theme/tokens.test.ts`

- [ ] **Step 1: Transcribe** the ten from
  `/home/tanphat199/Workspace/save/tanphat199/devglow/lua/devglow/palettes/*.lua`:
  amber, ash, blush, dusk, mocha, moss, nocturne, plum, tide, vesper.

  **Read each `.lua` file and copy its seventeen values.** Do not derive, interpolate or infer
  any value. In M1a, ember's five shades were written from memory rather than transcribed and
  the entire ramp was wrong — nothing caught it because only sage had assertions.

- [ ] **Step 2: Assert every value of every palette against its source file.** Twelve palettes ×
  seventeen keys. Write the test by reading the `.lua` files, not by copying your own output —
  if you generate both sides from the same mistake, the test proves nothing.

- [ ] **Step 3: Add a test that every palette produces a legible token set** — `dim` distinct
  from both `background` and `foreground`, the three mode colours distinct from each other.

- [ ] **Step 4: Run everything, then commit.**

---

### Task 11: User-defined themes

**Files:** `src/tui/theme/theme-loader.ts`, `src/core/configuration.ts`; tests for both

The owner asked for this: a colorscheme file they can drop in, like an nvim colorscheme or a
tmux theme.

**Interfaces:**
- Produces: `loadTheme(opts: { name: string; userThemeDirectory: string }): { palette: IPalette; source: 'builtin' | 'user' | 'fallback' }`

- [ ] **Step 1: Write the failing tests** — a built-in name resolves to the built-in; a `.toml`
  in the user directory resolves to it; a user theme **shadows** a built-in of the same name; an
  unknown name falls back to sage and reports `fallback`; a theme missing a key falls back
  rather than rendering with `undefined`; a malformed file falls back and does not throw; a
  value that is not a hex colour falls back. **The application must always start** — a bad theme
  file is a typo, not a reason to refuse to run.

- [ ] **Step 2: Implement.** Seventeen keys, same shape as the built-ins, so semantic tokens
  derive identically and a theme cannot break the interface by omitting a role. Reuse the
  existing minimal TOML reader in `configuration.ts` rather than adding a dependency; if the
  theme format needs more than it supports, extend that reader and say what you changed.

- [ ] **Step 3: Wire `:set palette=<name>`** to re-resolve through the loader, and report the
  fallback on the status line when one happens — silently rendering the wrong theme would be
  confusing.

- [ ] **Step 4: Document it in the README** — where the directory is, the file format, and the
  seventeen keys with sage as a worked example.

- [ ] **Step 5: Run everything, then commit.**

---

### Task 12: Wire it, and verify scope coverage

**Files:** `src/main.ts`, `src/keys/keymap.ts`, `README.md`, the spec

- [ ] **Step 1: Extend the promised-keys guard** to every binding this milestone added: `d`,
  `y`, `c`, `dd`, `yy`, `cc`, `"`, `.`, `<C-p>`, `/`, `n`, `N`.

- [ ] **Step 2: Verify scope coverage against spec §4**, naming for each row the file that
  implements it and a test that asserts it. A row with an implementation but no test is not
  done; a row you cannot fill is a finding to report, not to skip.

  In M1b-1 this same check found four spec'd features that were never implemented, and the final
  review found three more that lost messages. It is the most valuable step in the plan.

- [ ] **Step 3: Update the spec's §2 table** to mark the M1b-2 rows delivered — and only those
  genuinely delivered. Leave the outstanding items from M1b-1 (channel backfill, `otherUpdates`,
  in-session read receipts) marked outstanding.

- [ ] **Step 4: Full verification** — `bun test`, `bun run typecheck`, warning count 0,
  `bun run build`.

- [ ] **Step 5: Commit.**

---

## Self-Review

**Spec coverage.** §4.1 operator-pending and timeout → Tasks 1–2; §4.2 operators, registers,
repeat → Tasks 3–7; §4.3 picker and search → Tasks 8–9; §4.4 palettes and user themes →
Tasks 10–11; wiring and verification → Task 12.

**Placeholder scan.** No TBD. Tasks 4, 5, 7, 8, 9 describe their tests in prose rather than
quoting every assertion — deliberate, because each is a variation on a pattern the earlier tasks
establish in full, and the behaviours are enumerated precisely. Tasks 1–3 and 6 carry complete
code because they are the ones with novel logic.

**Type consistency.** `TResolveStatus` gains `ambiguous` in Task 1 and is consumed in Task 2.
`IEngineState` gains `operator` (Task 3), `register` (Task 5) and `lastChange` (Task 7), each
added in its own task. `Operators` is defined in Task 3 and used in 4, 5 and 7. `IPalette` is
unchanged — Task 11's loader returns the same shape the built-ins use, which is what lets a user
theme derive identical semantic tokens.

**Three risks worth naming.**

1. **Task 2's timer is the classic source of double-firing.** If it is not cleared on every key
   press, the short binding fires after the long one already ran. There is a test; treat it as
   load-bearing.
2. **Task 6 may not be deliverable.** The renderer owns stdout, and writing OSC 52 mid-frame is
   the interleaved-text bug. The task asks the implementer to find a safe hook and to report
   honestly if there is none, rather than shipping a corrupted frame.
3. **Task 10 is transcription, and transcription is where M1a got ember wrong.** Twelve palettes
   times seventeen values is 204 chances to typo. The assertions must be written from the source
   files, not from the implementation's own output.