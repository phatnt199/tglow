# tglow M1a — Walking Skeleton Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Log in to Telegram with a phone number, browse the chat list with `j`/`k`, read message history, send a message, and see incoming messages arrive live — all in a devglow-themed terminal UI.

**Architecture:** Three units with a strict dependency rule. `keys/` is a pure reducer with zero imports. `core/` wraps GramJS and `bun:sqlite` and never imports React. `tui/` renders with OpenTUI React and never calls GramJS. Actions flow down, state flows up.

**Tech Stack:** Bun 1.3 · TypeScript (strict) · `@opentui/react` 0.4.5 · React 19.2 · `telegram` (GramJS) 2.26.22 · `bun:sqlite` (built in)

This is the first of two plans covering milestone M1 of
`docs/superpowers/specs/2026-08-01-tglow-m1-design.md`. It builds a vertical
slice end-to-end so integration risk surfaces immediately. Plan M1b adds the
full vim engine (operators, registers, `.` repeat), reply/edit/delete, `pts` gap
recovery, entity rendering, and the overlays.

## Global Constraints

- **Runtime:** Bun ≥ 1.3. Never `npm`/`node`. Tests run with `bun test`.
- **TypeScript strict mode on.** No `any` in committed code.
- **Dependency rule, enforced by Task 2's boundary test:**
  - `src/keys/**` imports **nothing** — no `telegram`, no `react`, no `@opentui/*`, no `bun:sqlite`, no `node:*`.
  - `src/core/**` must not import `react` or `@opentui/*`.
  - `src/tui/**` must not import `telegram`.
- **Leader key is `\`** (matches `vim.g.mapleader`).
- **devglow sage palette values are copied verbatim** from
  `devglow/lua/devglow/palettes/sage.lua`. Do not invent colours.
- **Secrets:** the session file is written mode `0600` and is already covered by
  `.gitignore`. Never commit `config.toml`, `*.session`, or `*.sqlite`.
- **No network in tests.** Every test must pass with no internet and no Telegram
  account. Live connection is exercised only by the manual smoke test in Task 16.
- **Commit after every task.**

## Verified API facts

These were confirmed by running code on this machine. Do not re-derive them.

- `useKeyboard` from `@opentui/react` receives a `KeyEvent` with fields
  `{ name, ctrl, meta, shift, option, sequence, raw, eventType, number, source }`.
  **Alt/Meta arrives as `option` or `meta`, not `alt`.**
- **`testRender` from `@opentui/react/test-utils` does not work for keyboard
  tests.** It renders without an `AppContext` provider, so
  `useAppContext().keyHandler` is `null` and `useKeyboard` silently no-ops
  (the hook guards with `keyHandler?.on(...)`). Task 2 builds the working
  replacement. This is not optional.
- `renderer.keyInput` is the `KeyHandler` instance that must be supplied to
  `AppContext`.
- `createTestRenderer({width,height})` returns `{ renderer, mockInput, flush,
  captureCharFrame, waitFor, waitForFrame, resize, ... }`.
- JSX intrinsics available: `box`, `text`, `span`, `scrollbox`, `input`,
  `textarea`, `select`, `line-number`, `b`, `i`, `u`, `a`, `br`, `code`.
- GramJS: `TelegramClient` and `Api` from `telegram`, `StringSession` from
  `telegram/sessions`, `Logger` from `telegram/extensions/Logger`.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/keys/types.ts` | `Mode`, `Context`, `Key`, `Action`, `Binding`, `EngineState` |
| `src/keys/normalize.ts` | terminal key event → canonical `Key` and key string |
| `src/keys/engine.ts` | `resolve(state, key, keymap)` — the pure reducer |
| `src/keys/keymap.ts` | the M1a binding table |
| `src/core/config.ts` | load `~/.config/tglow/config.toml` |
| `src/core/cache/schema.sql` | table definitions |
| `src/core/cache/db.ts` | open, migrate, typed query helpers |
| `src/core/store.ts` | observable app state + typed event bus |
| `src/core/session.ts` | session string persistence at mode 0600 |
| `src/core/client.ts` | GramJS lifecycle + reconnect |
| `src/core/auth.ts` | phone → code → 2FA → ready state machine |
| `src/core/dialogs.ts` | fetch/cache/order the chat list |
| `src/core/messages.ts` | history paging, send |
| `src/core/updates.ts` | live update → store + cache |
| `src/tui/theme/palettes.ts` | all devglow palettes as typed objects |
| `src/tui/theme/tokens.ts` | semantic token mapping |
| `src/tui/panes/StatusLine.tsx` | lualine-style status bar |
| `src/tui/panes/ChatList.tsx` | left sidebar |
| `src/tui/panes/MessageView.tsx` | history with relative numbers |
| `src/tui/panes/Composer.tsx` | input box |
| `src/tui/App.tsx` | layout + key dispatch wiring |
| `src/test/render.tsx` | working test renderer with keyboard support |
| `src/main.ts` | entry point |

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `src/keys/types.ts`
- Test: `src/keys/types.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `Mode`, `Context`, `Key`, `Action`, `EngineState`, `Binding` types used by every later `keys/` task; `bun test` working.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "tglow",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "bin": { "tglow": "./src/main.ts" },
  "scripts": {
    "start": "bun run src/main.ts",
    "test": "bun test",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@opentui/core": "0.4.5",
    "@opentui/react": "0.4.5",
    "react": "^19.2.0",
    "telegram": "^2.26.22"
  },
  "devDependencies": {
    "@types/react": "^19.2.0",
    "typescript": "^5.9.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

`jsxImportSource` must be `@opentui/react` or JSX will resolve to DOM elements.

```json
{
  "compilerOptions": {
    "lib": ["ESNext"],
    "target": "ESNext",
    "module": "Preserve",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "jsxImportSource": "@opentui/react",
    "allowSyntheticDefaultImports": true,
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["bun-types"]
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Install**

```bash
bun install
```

- [ ] **Step 4: Write the failing test**

`src/keys/types.test.ts`:

```ts
import { test, expect } from "bun:test";
import { isMode, type Mode } from "./types.ts";

test("isMode accepts every vim mode we support", () => {
  const modes: Mode[] = ["normal", "insert", "visual", "command", "search"];
  for (const m of modes) expect(isMode(m)).toBe(true);
});

test("isMode rejects anything else", () => {
  expect(isMode("replace")).toBe(false);
  expect(isMode("")).toBe(false);
});
```

- [ ] **Step 5: Run it and watch it fail**

Run: `bun test src/keys/types.test.ts`
Expected: FAIL — `Cannot find module './types.ts'`

- [ ] **Step 6: Write `src/keys/types.ts`**

```ts
// Pure types for the vim engine. This file must import nothing.

export type Mode = "normal" | "insert" | "visual" | "command" | "search";
export type Context = "chatlist" | "messages" | "composer";

const MODES: readonly string[] = ["normal", "insert", "visual", "command", "search"];

export function isMode(value: string): value is Mode {
  return MODES.includes(value);
}

/** A terminal key press, normalised away from any specific terminal library. */
export interface Key {
  name: string; // "j", "escape", "return", "space", "1"
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

export type Action =
  | { type: "cursor.move"; unit: "message" | "chat"; delta: number }
  | { type: "cursor.edge"; unit: "message" | "chat"; edge: "first" | "last" }
  | { type: "mode.set"; mode: Mode }
  | { type: "focus.set"; context: Context }
  | { type: "chat.open" }
  | { type: "composer.send" }
  | { type: "composer.insertText"; text: string }
  | { type: "composer.backspace" }
  | { type: "app.quit" };

export interface EngineState {
  mode: Mode;
  context: Context;
  /** Canonical key strings accumulated toward a multi-key binding, e.g. "g". */
  pending: string;
  /** The 3 in 3j. Null when no count has been typed. */
  count: number | null;
}

export interface Binding {
  context: Context | "*";
  mode: Mode | Mode[];
  /** Canonical form: "j", "gg", "<C-p>", "<A-j>", "\\nv" */
  keys: string;
  /** A count-aware factory so 3j can produce a single delta-3 action. */
  action: (count: number) => Action[];
  desc: string;
}

export const initialEngineState: EngineState = {
  mode: "normal",
  context: "messages",
  pending: "",
  count: null,
};
```

- [ ] **Step 7: Run the test and watch it pass**

Run: `bun test src/keys/types.test.ts`
Expected: PASS — 2 tests

- [ ] **Step 8: Commit**

```bash
git add package.json tsconfig.json bun.lock src/keys/types.ts src/keys/types.test.ts
git commit -m "Add project scaffold and vim engine types"
```

---

### Task 2: Working TUI test harness

This task exists because the documented harness is broken. Verified above: keys
never reach `useKeyboard` under `testRender`. Every later TUI task depends on
this being right, so it is built and proven first.

**Files:**
- Create: `src/test/render.tsx`
- Test: `src/test/render.test.tsx`

**Interfaces:**
- Consumes: nothing
- Produces: `renderWithKeys(node, {width, height}) => Promise<TestRendererSetup>` — used by Tasks 12–16 for every TUI test.

- [ ] **Step 1: Write the failing test**

`src/test/render.test.tsx`:

```tsx
import { test, expect } from "bun:test";
import { act, useState } from "react";
import { useKeyboard } from "@opentui/react";
import { renderWithKeys } from "./render.tsx";

function KeyProbe() {
  const [seen, setSeen] = useState<string[]>([]);
  useKeyboard((key) => setSeen((s) => [...s, key.name]));
  return <text>seen:{seen.join(",") || "none"}</text>;
}

test("keyboard events reach useKeyboard", async () => {
  const t = await renderWithKeys(<KeyProbe />, { width: 40, height: 3 });
  await t.flush();
  expect(t.captureCharFrame()).toContain("seen:none");

  await act(async () => { t.mockInput.pressKey("j"); });
  await t.flush();
  expect(t.captureCharFrame()).toContain("seen:j");

  await act(async () => { t.mockInput.pressKey("k"); });
  await t.flush();
  expect(t.captureCharFrame()).toContain("seen:j,k");
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test src/test/render.test.tsx`
Expected: FAIL — `Cannot find module './render.tsx'`

- [ ] **Step 3: Write `src/test/render.tsx`**

```tsx
import { act, type ReactNode } from "react";
import { AppContext, createRoot } from "@opentui/react";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";

/**
 * Render a component tree for testing, with keyboard input actually connected.
 *
 * Do not replace this with `testRender` from `@opentui/react/test-utils`. That
 * helper renders the tree without an AppContext provider, so
 * `useAppContext().keyHandler` is null and `useKeyboard` no-ops silently —
 * tests appear to pass while asserting on a UI that never received a key.
 *
 * Driving `createTestRenderer` ourselves means the renderer exists before the
 * first render, so we can supply `renderer.keyInput` as the key handler.
 */
export async function renderWithKeys(
  node: ReactNode,
  opts: { width: number; height: number },
): Promise<TestRendererSetup> {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

  const setup = await createTestRenderer(opts);
  const root = createRoot(setup.renderer);

  act(() => {
    root.render(
      <AppContext.Provider
        value={{ keyHandler: setup.renderer.keyInput, renderer: setup.renderer }}
      >
        {node}
      </AppContext.Provider>,
    );
  });

  return setup;
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `bun test src/test/render.test.tsx`
Expected: PASS — 1 test, 3 assertions

- [ ] **Step 5: Write the dependency boundary test**

`src/test/boundaries.test.ts`:

```ts
import { test, expect } from "bun:test";
import { Glob } from "bun";

async function importsIn(dir: string): Promise<Array<{ file: string; spec: string }>> {
  const found: Array<{ file: string; spec: string }> = [];
  for await (const file of new Glob("**/*.{ts,tsx}").scan({ cwd: dir, absolute: true })) {
    if (file.includes(".test.")) continue;
    const src = await Bun.file(file).text();
    for (const m of src.matchAll(/^\s*(?:import|export)[^'"]*from\s+["']([^"']+)["']/gm)) {
      found.push({ file, spec: m[1]! });
    }
  }
  return found;
}

test("keys/ imports nothing external", async () => {
  const offenders = (await importsIn("src/keys")).filter((i) => !i.spec.startsWith("."));
  expect(offenders).toEqual([]);
});

test("core/ never imports React or OpenTUI", async () => {
  const offenders = (await importsIn("src/core")).filter(
    (i) => i.spec === "react" || i.spec.startsWith("@opentui/"),
  );
  expect(offenders).toEqual([]);
});

test("tui/ never imports telegram", async () => {
  const offenders = (await importsIn("src/tui")).filter((i) => i.spec.startsWith("telegram"));
  expect(offenders).toEqual([]);
});
```

- [ ] **Step 6: Create the directories the boundary test scans and run it**

```bash
mkdir -p src/core src/tui
bun test src/test/boundaries.test.ts
```

Expected: PASS — 3 tests (trivially, since `core/` and `tui/` are still empty;
the test becomes meaningful as they fill up).

- [ ] **Step 7: Commit**

```bash
git add src/test/
git commit -m "Add working TUI test harness and dependency boundary tests

The documented testRender helper renders without an AppContext provider,
so useKeyboard never receives events and keyboard tests pass while
asserting on a UI that got no input. renderWithKeys drives
createTestRenderer directly so renderer.keyInput can be supplied."
```

---

### Task 3: Key normalisation

**Files:**
- Create: `src/keys/normalize.ts`
- Test: `src/keys/normalize.test.ts`

**Interfaces:**
- Consumes: `Key` from `src/keys/types.ts`
- Produces: `keyToString(key: Key): string`, `normalizeKeyEvent(e: RawKeyEvent): Key`, `type RawKeyEvent`

- [ ] **Step 1: Write the failing test**

`src/keys/normalize.test.ts`:

```ts
import { test, expect } from "bun:test";
import { keyToString, normalizeKeyEvent } from "./normalize.ts";

test("plain keys stringify to their name", () => {
  expect(keyToString({ name: "j", ctrl: false, alt: false, shift: false })).toBe("j");
  expect(keyToString({ name: "escape", ctrl: false, alt: false, shift: false })).toBe("escape");
});

test("modifiers use vim notation", () => {
  expect(keyToString({ name: "p", ctrl: true, alt: false, shift: false })).toBe("<C-p>");
  expect(keyToString({ name: "j", ctrl: false, alt: true, shift: false })).toBe("<A-j>");
  expect(keyToString({ name: "u", ctrl: false, alt: false, shift: true })).toBe("<S-u>");
});

test("ctrl takes precedence over alt when both are held", () => {
  expect(keyToString({ name: "d", ctrl: true, alt: true, shift: false })).toBe("<C-A-d>");
});

// OpenTUI reports Alt as `option` or `meta`, never `alt`.
test("normalizeKeyEvent maps option and meta onto alt", () => {
  expect(normalizeKeyEvent({ name: "j", ctrl: false, meta: false, option: true, shift: false }).alt).toBe(true);
  expect(normalizeKeyEvent({ name: "j", ctrl: false, meta: true, option: false, shift: false }).alt).toBe(true);
  expect(normalizeKeyEvent({ name: "j", ctrl: false, meta: false, option: false, shift: false }).alt).toBe(false);
});

test("normalizeKeyEvent preserves ctrl and shift", () => {
  const k = normalizeKeyEvent({ name: "p", ctrl: true, meta: false, option: false, shift: true });
  expect(k).toEqual({ name: "p", ctrl: true, alt: false, shift: true });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test src/keys/normalize.test.ts`
Expected: FAIL — `Cannot find module './normalize.ts'`

- [ ] **Step 3: Write `src/keys/normalize.ts`**

```ts
import type { Key } from "./types.ts";

/**
 * The shape OpenTUI's KeyEvent gives us, narrowed to what we use. Declared
 * structurally rather than imported, because keys/ must not depend on OpenTUI.
 */
export interface RawKeyEvent {
  name: string;
  ctrl: boolean;
  meta: boolean;
  option: boolean;
  shift: boolean;
}

/** OpenTUI reports Alt as `option` (macOS) or `meta` (Linux). Fold both to alt. */
export function normalizeKeyEvent(e: RawKeyEvent): Key {
  return {
    name: e.name,
    ctrl: e.ctrl,
    alt: e.option || e.meta,
    shift: e.shift,
  };
}

/**
 * Canonical string form used by the keymap table. Modifier order is fixed
 * (C then A then S) so a binding string always matches exactly one key.
 */
export function keyToString(key: Key): string {
  const mods: string[] = [];
  if (key.ctrl) mods.push("C");
  if (key.alt) mods.push("A");
  // Shift is only notated for keys where it is not already in the name.
  if (key.shift && key.name.length === 1) mods.push("S");
  if (mods.length === 0) return key.name;
  return `<${mods.join("-")}-${key.name}>`;
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `bun test src/keys/normalize.test.ts`
Expected: PASS — 5 tests

- [ ] **Step 5: Commit**

```bash
git add src/keys/normalize.ts src/keys/normalize.test.ts
git commit -m "Add key normalisation with vim modifier notation"
```

---

### Task 4: The engine reducer

**Files:**
- Create: `src/keys/engine.ts`
- Test: `src/keys/engine.test.ts`

**Interfaces:**
- Consumes: `EngineState`, `Key`, `Binding`, `Action` from `types.ts`; `keyToString` from `normalize.ts`
- Produces: `resolve(state, key, keymap): ResolveResult` where
  `ResolveResult = { state: EngineState; actions: Action[]; status: "pending" | "resolved" | "unmapped" }`

- [ ] **Step 1: Write the failing test**

`src/keys/engine.test.ts`:

```ts
import { test, expect } from "bun:test";
import { resolve } from "./engine.ts";
import { initialEngineState, type Binding, type Key } from "./types.ts";

const k = (name: string, mods: Partial<Key> = {}): Key => ({
  name, ctrl: false, alt: false, shift: false, ...mods,
});

const keymap: Binding[] = [
  { context: "*", mode: "normal", keys: "j",
    action: (n) => [{ type: "cursor.move", unit: "message", delta: n }], desc: "down" },
  { context: "*", mode: "normal", keys: "k",
    action: (n) => [{ type: "cursor.move", unit: "message", delta: -n }], desc: "up" },
  { context: "*", mode: "normal", keys: "gg",
    action: () => [{ type: "cursor.edge", unit: "message", edge: "first" }], desc: "top" },
  { context: "*", mode: "normal", keys: "i",
    action: () => [{ type: "mode.set", mode: "insert" }], desc: "insert" },
  { context: "*", mode: "insert", keys: "escape",
    action: () => [{ type: "mode.set", mode: "normal" }], desc: "normal" },
  { context: "messages", mode: "normal", keys: "<C-p>",
    action: () => [{ type: "chat.open" }], desc: "picker" },
];

test("a single mapped key resolves immediately", () => {
  const r = resolve(initialEngineState, k("j"), keymap);
  expect(r.status).toBe("resolved");
  expect(r.actions).toEqual([{ type: "cursor.move", unit: "message", delta: 1 }]);
  expect(r.state.pending).toBe("");
});

test("a count multiplies the action", () => {
  let s = initialEngineState;
  s = resolve(s, k("3"), keymap).state;
  expect(s.count).toBe(3);
  const r = resolve(s, k("j"), keymap);
  expect(r.actions).toEqual([{ type: "cursor.move", unit: "message", delta: 3 }]);
  expect(r.state.count).toBeNull();
});

test("multi-digit counts accumulate", () => {
  let s = initialEngineState;
  s = resolve(s, k("1"), keymap).state;
  s = resolve(s, k("2"), keymap).state;
  expect(s.count).toBe(12);
});

test("a leading 0 is not a count", () => {
  const r = resolve(initialEngineState, k("0"), keymap);
  expect(r.state.count).toBeNull();
  expect(r.status).toBe("unmapped");
});

test("0 after a digit continues the count", () => {
  let s = initialEngineState;
  s = resolve(s, k("1"), keymap).state;
  s = resolve(s, k("0"), keymap).state;
  expect(s.count).toBe(10);
});

test("a prefix of a longer binding stays pending", () => {
  const r = resolve(initialEngineState, k("g"), keymap);
  expect(r.status).toBe("pending");
  expect(r.state.pending).toBe("g");
  expect(r.actions).toEqual([]);
});

test("completing a multi-key binding resolves and clears pending", () => {
  const s = resolve(initialEngineState, k("g"), keymap).state;
  const r = resolve(s, k("g"), keymap);
  expect(r.status).toBe("resolved");
  expect(r.actions).toEqual([{ type: "cursor.edge", unit: "message", edge: "first" }]);
  expect(r.state.pending).toBe("");
});

test("an unmapped key clears pending and count", () => {
  let s = resolve(initialEngineState, k("g"), keymap).state;
  s = { ...s, count: 4 };
  const r = resolve(s, k("z"), keymap);
  expect(r.status).toBe("unmapped");
  expect(r.state.pending).toBe("");
  expect(r.state.count).toBeNull();
});

test("bindings are filtered by mode", () => {
  const insert = { ...initialEngineState, mode: "insert" as const };
  expect(resolve(insert, k("j"), keymap).status).toBe("unmapped");
  expect(resolve(insert, k("escape"), keymap).status).toBe("resolved");
});

test("bindings are filtered by context", () => {
  const chatlist = { ...initialEngineState, context: "chatlist" as const };
  // <C-p> is bound only in the messages context
  expect(resolve(chatlist, k("p", { ctrl: true }), keymap).status).toBe("unmapped");
  expect(resolve(initialEngineState, k("p", { ctrl: true }), keymap).status).toBe("resolved");
});

test("mode.set actions update the returned state", () => {
  const r = resolve(initialEngineState, k("i"), keymap);
  expect(r.state.mode).toBe("insert");
});

test("resolve never mutates the state it is given", () => {
  const before = { ...initialEngineState };
  resolve(initialEngineState, k("3"), keymap);
  expect(initialEngineState).toEqual(before);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test src/keys/engine.test.ts`
Expected: FAIL — `Cannot find module './engine.ts'`

- [ ] **Step 3: Write `src/keys/engine.ts`**

```ts
import { keyToString } from "./normalize.ts";
import type { Action, Binding, EngineState, Key, Mode } from "./types.ts";

export interface ResolveResult {
  state: EngineState;
  actions: Action[];
  status: "pending" | "resolved" | "unmapped";
}

function modeMatches(binding: Binding, mode: Mode): boolean {
  return Array.isArray(binding.mode) ? binding.mode.includes(mode) : binding.mode === mode;
}

function contextMatches(binding: Binding, state: EngineState): boolean {
  return binding.context === "*" || binding.context === state.context;
}

/**
 * Fold one key press into the engine. Pure: no I/O, no mutation, no clock.
 * Every behaviour of the vim layer is a consequence of this function.
 */
export function resolve(state: EngineState, key: Key, keymap: Binding[]): ResolveResult {
  const str = keyToString(key);

  // Digits are counts in normal and visual mode, not bindings. A leading 0 is
  // a motion (line start) in vim, never the start of a count.
  if ((state.mode === "normal" || state.mode === "visual") && state.pending === "") {
    const isDigit = /^[0-9]$/.test(str);
    if (isDigit && !(str === "0" && state.count === null)) {
      const digit = Number(str);
      return {
        state: { ...state, count: (state.count ?? 0) * 10 + digit },
        actions: [],
        status: "pending",
      };
    }
  }

  const candidates = keymap.filter((b) => modeMatches(b, state.mode) && contextMatches(b, state));
  const sequence = state.pending + str;

  const exact = candidates.find((b) => b.keys === sequence);
  if (exact) {
    const count = state.count ?? 1;
    const actions = exact.action(count);
    let next: EngineState = { ...state, pending: "", count: null };
    for (const action of actions) {
      if (action.type === "mode.set") next = { ...next, mode: action.mode };
      if (action.type === "focus.set") next = { ...next, context: action.context };
    }
    return { state: next, actions, status: "resolved" };
  }

  const isPrefix = candidates.some((b) => b.keys.startsWith(sequence) && b.keys !== sequence);
  if (isPrefix) {
    return { state: { ...state, pending: sequence }, actions: [], status: "pending" };
  }

  return { state: { ...state, pending: "", count: null }, actions: [], status: "unmapped" };
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `bun test src/keys/engine.test.ts`
Expected: PASS — 12 tests

- [ ] **Step 5: Commit**

```bash
git add src/keys/engine.ts src/keys/engine.test.ts
git commit -m "Add pure vim engine reducer with counts, prefixes and mode filtering"
```

---

### Task 5: The M1a keymap

**Files:**
- Create: `src/keys/keymap.ts`
- Test: `src/keys/keymap.test.ts`

**Interfaces:**
- Consumes: `Binding`, `Action` from `types.ts`
- Produces: `keymap: Binding[]`, `describeBindings(mode, context): Array<{keys, desc}>`

- [ ] **Step 1: Write the failing test**

`src/keys/keymap.test.ts`:

```ts
import { test, expect } from "bun:test";
import { keymap, describeBindings } from "./keymap.ts";
import { resolve } from "./engine.ts";
import { initialEngineState, type Key } from "./types.ts";

const k = (name: string, mods: Partial<Key> = {}): Key => ({
  name, ctrl: false, alt: false, shift: false, ...mods,
});

test("every binding has a description for the which-key popup", () => {
  for (const b of keymap) {
    expect(b.desc.length).toBeGreaterThan(0);
  }
});

test("no two bindings collide on the same keys, mode and context", () => {
  const seen = new Set<string>();
  for (const b of keymap) {
    const modes = Array.isArray(b.mode) ? b.mode : [b.mode];
    for (const m of modes) {
      const id = `${b.context}:${m}:${b.keys}`;
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
  }
});

test("j and k move through messages", () => {
  expect(resolve(initialEngineState, k("j"), keymap).actions)
    .toEqual([{ type: "cursor.move", unit: "message", delta: 1 }]);
  expect(resolve(initialEngineState, k("k"), keymap).actions)
    .toEqual([{ type: "cursor.move", unit: "message", delta: -1 }]);
});

test("i enters insert mode", () => {
  const r = resolve(initialEngineState, k("i"), keymap);
  expect(r.state.mode).toBe("insert");
  expect(r.state.context).toBe("composer");
});

test("jk leaves insert mode", () => {
  const insert = { ...initialEngineState, mode: "insert" as const, context: "composer" as const };
  const pending = resolve(insert, k("j"), keymap);
  expect(pending.status).toBe("pending");
  const done = resolve(pending.state, k("k"), keymap);
  expect(done.state.mode).toBe("normal");
});

test("escape also leaves insert mode", () => {
  const insert = { ...initialEngineState, mode: "insert" as const, context: "composer" as const };
  expect(resolve(insert, k("escape"), keymap).state.mode).toBe("normal");
});

test("gg and G jump to the ends of history", () => {
  const s = resolve(initialEngineState, k("g"), keymap).state;
  expect(resolve(s, k("g"), keymap).actions)
    .toEqual([{ type: "cursor.edge", unit: "message", edge: "first" }]);
  expect(resolve(initialEngineState, k("G", { shift: true }), keymap).actions)
    .toEqual([{ type: "cursor.edge", unit: "message", edge: "last" }]);
});

test("3j moves three messages", () => {
  let s = initialEngineState;
  s = resolve(s, k("3"), keymap).state;
  expect(resolve(s, k("j"), keymap).actions)
    .toEqual([{ type: "cursor.move", unit: "message", delta: 3 }]);
});

test("nf focuses the chat list, matching the author's nvim mapping", () => {
  const s = resolve(initialEngineState, k("n"), keymap).state;
  expect(resolve(s, k("f"), keymap).actions)
    .toEqual([{ type: "focus.set", context: "chatlist" }]);
});

test("describeBindings returns only bindings for the given mode and context", () => {
  const shown = describeBindings("normal", "messages");
  expect(shown.some((b) => b.keys === "j")).toBe(true);
  expect(shown.some((b) => b.keys === "escape")).toBe(false);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test src/keys/keymap.test.ts`
Expected: FAIL — `Cannot find module './keymap.ts'`

- [ ] **Step 3: Write `src/keys/keymap.ts`**

Mappings deliberately echo `dotfiles/confs/neovim/lua/main/003-keymaps.lua` so
the keys are already in muscle memory. Leader is `\`.

```ts
import type { Binding, Context, Mode } from "./types.ts";

export const keymap: Binding[] = [
  // ── movement ────────────────────────────────────────────────────────────
  { context: "*", mode: "normal", keys: "j", desc: "Next message",
    action: (n) => [{ type: "cursor.move", unit: "message", delta: n }] },
  { context: "*", mode: "normal", keys: "k", desc: "Previous message",
    action: (n) => [{ type: "cursor.move", unit: "message", delta: -n }] },
  { context: "*", mode: "normal", keys: "gg", desc: "Oldest loaded message",
    action: () => [{ type: "cursor.edge", unit: "message", edge: "first" }] },
  { context: "*", mode: "normal", keys: "G", desc: "Newest message",
    action: () => [{ type: "cursor.edge", unit: "message", edge: "last" }] },
  { context: "*", mode: "normal", keys: "<C-d>", desc: "Half page down",
    action: (n) => [{ type: "cursor.move", unit: "message", delta: 10 * n }] },
  { context: "*", mode: "normal", keys: "<C-u>", desc: "Half page up",
    action: (n) => [{ type: "cursor.move", unit: "message", delta: -10 * n }] },

  // ── panes (echoes <leader>nv / nf from their nvim-tree mappings) ─────────
  { context: "*", mode: "normal", keys: "nf", desc: "Focus chat list",
    action: () => [{ type: "focus.set", context: "chatlist" }] },
  { context: "chatlist", mode: "normal", keys: "return", desc: "Open chat",
    action: () => [{ type: "chat.open" }, { type: "focus.set", context: "messages" }] },

  // ── mode changes ────────────────────────────────────────────────────────
  { context: "*", mode: "normal", keys: "i", desc: "Write a message",
    action: () => [{ type: "focus.set", context: "composer" }, { type: "mode.set", mode: "insert" }] },
  { context: "*", mode: "normal", keys: "a", desc: "Write a message",
    action: () => [{ type: "focus.set", context: "composer" }, { type: "mode.set", mode: "insert" }] },
  // jk is how this author leaves insert mode; Esc works too.
  { context: "*", mode: "insert", keys: "jk", desc: "Leave insert mode",
    action: () => [{ type: "mode.set", mode: "normal" }] },
  { context: "*", mode: "insert", keys: "escape", desc: "Leave insert mode",
    action: () => [{ type: "mode.set", mode: "normal" }] },
  { context: "*", mode: "insert", keys: "return", desc: "Send message",
    action: () => [{ type: "composer.send" }] },
  { context: "*", mode: "insert", keys: "backspace", desc: "Delete character",
    action: () => [{ type: "composer.backspace" }] },

  // ── application ─────────────────────────────────────────────────────────
  { context: "*", mode: "normal", keys: "<C-c>", desc: "Quit",
    action: () => [{ type: "app.quit" }] },
];

/** Bindings visible right now — powers the which-key popup in plan M1b. */
export function describeBindings(
  mode: Mode,
  context: Context,
): Array<{ keys: string; desc: string }> {
  return keymap
    .filter((b) => (Array.isArray(b.mode) ? b.mode.includes(mode) : b.mode === mode))
    .filter((b) => b.context === "*" || b.context === context)
    .map((b) => ({ keys: b.keys, desc: b.desc }));
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `bun test src/keys/keymap.test.ts`
Expected: PASS — 10 tests

Note: the `jk` binding makes `j` a pending prefix in insert mode only, so `j`
still resolves immediately in normal mode. The engine test for prefixes already
covers that interaction.

- [ ] **Step 5: Run the whole suite and the boundary check**

```bash
bun test
bun run typecheck
```

Expected: all pass. `keys/` still imports nothing external.

- [ ] **Step 6: Commit**

```bash
git add src/keys/keymap.ts src/keys/keymap.test.ts
git commit -m "Add M1a keymap echoing the author's nvim mappings"
```

---

### Task 6: SQLite cache

**Files:**
- Create: `src/core/cache/schema.sql`, `src/core/cache/db.ts`
- Test: `src/core/cache/db.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `openDb(path: string): Db`, and the `Db` interface with
  `upsertPeer`, `upsertDialog`, `listDialogs`, `insertMessages`, `listMessages`, `close`.
  Row types `PeerRow`, `DialogRow`, `MessageRow` are used by Tasks 9–11 and 13–14.

- [ ] **Step 1: Write `src/core/cache/schema.sql`**

Copied from spec §7. `folder_id` and `status` are unused in M1a but present so
M2/M4 need no migration.

```sql
CREATE TABLE IF NOT EXISTS peers (
  id             TEXT PRIMARY KEY,
  type           TEXT NOT NULL,
  access_hash    TEXT,
  title          TEXT NOT NULL,
  username       TEXT,
  is_self        INTEGER NOT NULL DEFAULT 0,
  is_bot         INTEGER NOT NULL DEFAULT 0,
  status         TEXT,
  status_seen_at INTEGER,
  updated_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS dialogs (
  peer_id            TEXT PRIMARY KEY REFERENCES peers(id),
  pinned             INTEGER NOT NULL DEFAULT 0,
  unread_count       INTEGER NOT NULL DEFAULT 0,
  unread_mentions    INTEGER NOT NULL DEFAULT 0,
  read_inbox_max_id  INTEGER NOT NULL DEFAULT 0,
  read_outbox_max_id INTEGER NOT NULL DEFAULT 0,
  top_message_id     INTEGER,
  last_message_at    INTEGER,
  muted_until        INTEGER NOT NULL DEFAULT 0,
  folder_id          INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_dialogs_order
  ON dialogs(pinned DESC, last_message_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  peer_id         TEXT NOT NULL REFERENCES peers(id),
  id              INTEGER NOT NULL,
  from_id         TEXT,
  date            INTEGER NOT NULL,
  edit_date       INTEGER,
  text            TEXT,
  entities        TEXT,
  reply_to_msg_id INTEGER,
  fwd_from        TEXT,
  media_kind      TEXT,
  media_json      TEXT,
  out             INTEGER NOT NULL DEFAULT 0,
  deleted         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (peer_id, id)
);

CREATE INDEX IF NOT EXISTS idx_messages_peer_date
  ON messages(peer_id, date DESC);

CREATE TABLE IF NOT EXISTS sync_state (
  key   TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
```

- [ ] **Step 2: Write the failing test**

`src/core/cache/db.test.ts`:

```ts
import { test, expect } from "bun:test";
import { openDb } from "./db.ts";

function fixture() {
  const db = openDb(":memory:");
  db.upsertPeer({ id: "u1", type: "user", accessHash: "h1", title: "Alice", username: "alice" });
  db.upsertPeer({ id: "u2", type: "user", accessHash: "h2", title: "Bob", username: null });
  return db;
}

test("peers round-trip", () => {
  const db = fixture();
  db.upsertDialog({ peerId: "u1", pinned: 0, unreadCount: 2, lastMessageAt: 100, topMessageId: 5 });
  expect(db.listDialogs()[0]!.title).toBe("Alice");
  db.close();
});

test("upsertPeer updates rather than duplicating", () => {
  const db = fixture();
  db.upsertPeer({ id: "u1", type: "user", accessHash: "h1", title: "Alice Smith", username: "alice" });
  db.upsertDialog({ peerId: "u1", pinned: 0, unreadCount: 0, lastMessageAt: 1, topMessageId: 1 });
  const rows = db.listDialogs();
  expect(rows).toHaveLength(1);
  expect(rows[0]!.title).toBe("Alice Smith");
  db.close();
});

test("dialogs sort pinned first, then by recency", () => {
  const db = fixture();
  db.upsertDialog({ peerId: "u1", pinned: 0, unreadCount: 0, lastMessageAt: 300, topMessageId: 9 });
  db.upsertDialog({ peerId: "u2", pinned: 1, unreadCount: 0, lastMessageAt: 100, topMessageId: 4 });
  expect(db.listDialogs().map((d) => d.peerId)).toEqual(["u2", "u1"]);
  db.close();
});

test("messages are stored and read back newest-first", () => {
  const db = fixture();
  db.insertMessages([
    { peerId: "u1", id: 1, fromId: "u1", date: 100, text: "morning!", out: 0 },
    { peerId: "u1", id: 2, fromId: "u1", date: 200, text: "ok ping me", out: 0 },
    { peerId: "u1", id: 3, fromId: "me", date: 300, text: "not yet", out: 1 },
  ]);
  expect(db.listMessages("u1", 10).map((m) => m.text))
    .toEqual(["not yet", "ok ping me", "morning!"]);
  db.close();
});

test("inserting the same message twice does not duplicate it", () => {
  const db = fixture();
  const msg = { peerId: "u1", id: 1, fromId: "u1", date: 100, text: "hi", out: 0 };
  db.insertMessages([msg]);
  db.insertMessages([{ ...msg, text: "hi (edited)" }]);
  const rows = db.listMessages("u1", 10);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.text).toBe("hi (edited)");
  db.close();
});

test("listMessages honours its limit and scopes to one peer", () => {
  const db = fixture();
  db.insertMessages([
    { peerId: "u1", id: 1, fromId: "u1", date: 100, text: "a", out: 0 },
    { peerId: "u1", id: 2, fromId: "u1", date: 200, text: "b", out: 0 },
    { peerId: "u2", id: 1, fromId: "u2", date: 150, text: "other", out: 0 },
  ]);
  expect(db.listMessages("u1", 1).map((m) => m.text)).toEqual(["b"]);
  expect(db.listMessages("u2", 10).map((m) => m.text)).toEqual(["other"]);
  db.close();
});

test("sync state round-trips", () => {
  const db = fixture();
  expect(db.getSyncState("pts")).toBeNull();
  db.setSyncState("pts", 4242);
  expect(db.getSyncState("pts")).toBe(4242);
  db.close();
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `bun test src/core/cache/db.test.ts`
Expected: FAIL — `Cannot find module './db.ts'`

- [ ] **Step 4: Write `src/core/cache/db.ts`**

```ts
import { Database } from "bun:sqlite";

export interface PeerInput {
  id: string;
  type: "user" | "chat" | "channel";
  accessHash: string | null;
  title: string;
  username: string | null;
}

export interface DialogInput {
  peerId: string;
  pinned: number;
  unreadCount: number;
  lastMessageAt: number;
  topMessageId: number;
}

export interface MessageInput {
  peerId: string;
  id: number;
  fromId: string | null;
  date: number;
  text: string;
  out: number;
}

export interface DialogRow {
  peerId: string;
  title: string;
  pinned: number;
  unreadCount: number;
  lastMessageAt: number | null;
  topMessageId: number | null;
}

export interface MessageRow {
  peerId: string;
  id: number;
  fromId: string | null;
  date: number;
  text: string;
  out: number;
}

export interface Db {
  upsertPeer(p: PeerInput): void;
  upsertDialog(d: DialogInput): void;
  listDialogs(): DialogRow[];
  insertMessages(messages: MessageInput[]): void;
  listMessages(peerId: string, limit: number): MessageRow[];
  getSyncState(key: string): number | null;
  setSyncState(key: string, value: number): void;
  close(): void;
}

const SCHEMA_PATH = new URL("./schema.sql", import.meta.url).pathname;

export function openDb(path: string): Db {
  const db = new Database(path);
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");
  db.run(Bun.file(SCHEMA_PATH).text ? readSchemaSync() : "");

  function readSchemaSync(): string {
    // Bun.file().text() is async; the schema is small and read once at open.
    return require("node:fs").readFileSync(SCHEMA_PATH, "utf8") as string;
  }

  const upsertPeerStmt = db.prepare(`
    INSERT INTO peers (id, type, access_hash, title, username, updated_at)
    VALUES ($id, $type, $accessHash, $title, $username, $now)
    ON CONFLICT(id) DO UPDATE SET
      type = $type, access_hash = $accessHash, title = $title,
      username = $username, updated_at = $now
  `);

  const upsertDialogStmt = db.prepare(`
    INSERT INTO dialogs (peer_id, pinned, unread_count, last_message_at, top_message_id)
    VALUES ($peerId, $pinned, $unreadCount, $lastMessageAt, $topMessageId)
    ON CONFLICT(peer_id) DO UPDATE SET
      pinned = $pinned, unread_count = $unreadCount,
      last_message_at = $lastMessageAt, top_message_id = $topMessageId
  `);

  const insertMessageStmt = db.prepare(`
    INSERT INTO messages (peer_id, id, from_id, date, text, out)
    VALUES ($peerId, $id, $fromId, $date, $text, $out)
    ON CONFLICT(peer_id, id) DO UPDATE SET
      from_id = $fromId, date = $date, text = $text, out = $out
  `);

  const listDialogsStmt = db.prepare(`
    SELECT d.peer_id AS peerId, p.title AS title, d.pinned AS pinned,
           d.unread_count AS unreadCount, d.last_message_at AS lastMessageAt,
           d.top_message_id AS topMessageId
    FROM dialogs d
    JOIN peers p ON p.id = d.peer_id
    ORDER BY d.pinned DESC, d.last_message_at DESC
  `);

  const listMessagesStmt = db.prepare(`
    SELECT peer_id AS peerId, id, from_id AS fromId, date, text, out
    FROM messages
    WHERE peer_id = $peerId AND deleted = 0
    ORDER BY date DESC, id DESC
    LIMIT $limit
  `);

  const getSyncStmt = db.prepare(`SELECT value FROM sync_state WHERE key = $key`);
  const setSyncStmt = db.prepare(`
    INSERT INTO sync_state (key, value) VALUES ($key, $value)
    ON CONFLICT(key) DO UPDATE SET value = $value
  `);

  const insertMany = db.transaction((messages: MessageInput[]) => {
    for (const m of messages) {
      insertMessageStmt.run({
        $peerId: m.peerId, $id: m.id, $fromId: m.fromId,
        $date: m.date, $text: m.text, $out: m.out,
      });
    }
  });

  return {
    upsertPeer(p) {
      upsertPeerStmt.run({
        $id: p.id, $type: p.type, $accessHash: p.accessHash,
        $title: p.title, $username: p.username, $now: Date.now(),
      });
    },
    upsertDialog(d) {
      upsertDialogStmt.run({
        $peerId: d.peerId, $pinned: d.pinned, $unreadCount: d.unreadCount,
        $lastMessageAt: d.lastMessageAt, $topMessageId: d.topMessageId,
      });
    },
    listDialogs: () => listDialogsStmt.all() as DialogRow[],
    insertMessages: (messages) => { insertMany(messages); },
    listMessages: (peerId, limit) =>
      listMessagesStmt.all({ $peerId: peerId, $limit: limit }) as MessageRow[],
    getSyncState(key) {
      const row = getSyncStmt.get({ $key: key }) as { value: number } | null;
      return row ? row.value : null;
    },
    setSyncState(key, value) {
      setSyncStmt.run({ $key: key, $value: value });
    },
    close: () => db.close(),
  };
}
```

- [ ] **Step 5: Simplify the schema read**

The conditional in Step 4 is awkward. Replace the two lines

```ts
  db.run(Bun.file(SCHEMA_PATH).text ? readSchemaSync() : "");

  function readSchemaSync(): string {
```

and the closing of that helper with a single synchronous read at the top:

```ts
import { readFileSync } from "node:fs";
// ...
  db.run(readFileSync(SCHEMA_PATH, "utf8"));
```

Delete the `readSchemaSync` helper entirely.

- [ ] **Step 6: Run the tests and watch them pass**

Run: `bun test src/core/cache/db.test.ts`
Expected: PASS — 7 tests

- [ ] **Step 7: Commit**

```bash
git add src/core/cache/
git commit -m "Add SQLite cache with peers, dialogs, messages and sync state"
```

---

### Task 7: Config loading

**Files:**
- Create: `src/core/config.ts`
- Test: `src/core/config.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `loadConfig(path?: string): Config` where
  `Config = { apiId: number; apiHash: string; palette: string; sessionPath: string; cachePath: string }`,
  and `ConfigError`.

- [ ] **Step 1: Write the failing test**

`src/core/config.test.ts`:

```ts
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, ConfigError } from "./config.ts";

function writeConfig(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "tglow-"));
  const path = join(dir, "config.toml");
  writeFileSync(path, body);
  return path;
}

test("loads api credentials", () => {
  const p = writeConfig(`api_id = 12345\napi_hash = "abc123"\n`);
  const cfg = loadConfig(p);
  expect(cfg.apiId).toBe(12345);
  expect(cfg.apiHash).toBe("abc123");
});

test("palette defaults to sage", () => {
  const p = writeConfig(`api_id = 1\napi_hash = "x"\n`);
  expect(loadConfig(p).palette).toBe("sage");
});

test("palette can be overridden", () => {
  const p = writeConfig(`api_id = 1\napi_hash = "x"\npalette = "ember"\n`);
  expect(loadConfig(p).palette).toBe("ember");
});

test("a missing file explains how to fix it", () => {
  expect(() => loadConfig("/nonexistent/config.toml")).toThrow(ConfigError);
  try {
    loadConfig("/nonexistent/config.toml");
  } catch (e) {
    expect((e as Error).message).toContain("my.telegram.org");
  }
});

test("a missing api_id is reported clearly", () => {
  const p = writeConfig(`api_hash = "x"\n`);
  expect(() => loadConfig(p)).toThrow(/api_id/);
});

test("a non-numeric api_id is rejected", () => {
  const p = writeConfig(`api_id = "nope"\napi_hash = "x"\n`);
  expect(() => loadConfig(p)).toThrow(/api_id/);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test src/core/config.test.ts`
Expected: FAIL — `Cannot find module './config.ts'`

- [ ] **Step 3: Write `src/core/config.ts`**

Bun parses TOML natively via `import`, but the path is dynamic here, so parse
the small subset we need by hand rather than adding a dependency.

```ts
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export class ConfigError extends Error {}

export interface Config {
  apiId: number;
  apiHash: string;
  palette: string;
  sessionPath: string;
  cachePath: string;
}

export function defaultConfigPath(): string {
  return join(homedir(), ".config", "tglow", "config.toml");
}

const SETUP_HINT =
  "Create it with:\n\n" +
  "  mkdir -p ~/.config/tglow\n" +
  '  printf \'api_id = 0\\napi_hash = ""\\n\' > ~/.config/tglow/config.toml\n\n' +
  "Get api_id and api_hash from https://my.telegram.org (log in, API development tools).";

/** Minimal TOML reader: bare `key = value` pairs, strings and integers only. */
function parseToml(src: string): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const line of src.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/.exec(trimmed);
    if (!match) continue;
    const [, key, rawValue] = match;
    const value = rawValue!.trim();
    if (/^".*"$/.test(value)) out[key!] = value.slice(1, -1);
    else if (/^-?\d+$/.test(value)) out[key!] = Number(value);
    else out[key!] = value;
  }
  return out;
}

export function loadConfig(path: string = defaultConfigPath()): Config {
  if (!existsSync(path)) {
    throw new ConfigError(`No config file at ${path}.\n\n${SETUP_HINT}`);
  }

  const raw = parseToml(readFileSync(path, "utf8"));

  if (typeof raw.api_id !== "number") {
    throw new ConfigError(`api_id missing or not a number in ${path}.\n\n${SETUP_HINT}`);
  }
  if (typeof raw.api_hash !== "string" || raw.api_hash === "") {
    throw new ConfigError(`api_hash missing or empty in ${path}.\n\n${SETUP_HINT}`);
  }

  const dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  return {
    apiId: raw.api_id,
    apiHash: raw.api_hash,
    palette: typeof raw.palette === "string" ? raw.palette : "sage",
    sessionPath: join(dataHome, "tglow", "session"),
    cachePath: join(dataHome, "tglow", "cache.sqlite"),
  };
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `bun test src/core/config.test.ts`
Expected: PASS — 6 tests

- [ ] **Step 5: Commit**

```bash
git add src/core/config.ts src/core/config.test.ts
git commit -m "Add config loading with actionable setup errors"
```

---

### Task 8: Session persistence

**Files:**
- Create: `src/core/session.ts`
- Test: `src/core/session.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `loadSession(path): string`, `saveSession(path, value): void`, `clearSession(path): void`

- [ ] **Step 1: Write the failing test**

`src/core/session.test.ts`:

```ts
import { test, expect } from "bun:test";
import { mkdtempSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSession, saveSession, clearSession } from "./session.ts";

const tmpPath = () => join(mkdtempSync(join(tmpdir(), "tglow-")), "nested", "session");

test("a missing session file reads as an empty string", () => {
  expect(loadSession(tmpPath())).toBe("");
});

test("a saved session round-trips", () => {
  const p = tmpPath();
  saveSession(p, "1BQANOTEuMTA4LjU2");
  expect(loadSession(p)).toBe("1BQANOTEuMTA4LjU2");
});

// The session string is equivalent to a logged-in device on the account.
test("the session file is created mode 0600", () => {
  const p = tmpPath();
  saveSession(p, "secret");
  expect(statSync(p).mode & 0o777).toBe(0o600);
});

test("saving creates missing parent directories", () => {
  const p = tmpPath();
  saveSession(p, "x");
  expect(existsSync(p)).toBe(true);
});

test("clearSession removes the file", () => {
  const p = tmpPath();
  saveSession(p, "x");
  clearSession(p);
  expect(existsSync(p)).toBe(false);
  expect(loadSession(p)).toBe("");
});

test("clearSession on a missing file is not an error", () => {
  expect(() => clearSession(tmpPath())).not.toThrow();
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test src/core/session.test.ts`
Expected: FAIL — `Cannot find module './session.ts'`

- [ ] **Step 3: Write `src/core/session.ts`**

```ts
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * The GramJS session string is equivalent to a logged-in device: anyone who
 * reads it controls the account. It is written 0600 and is covered by
 * .gitignore. Never log it, never include it in error messages.
 */
export function loadSession(path: string): string {
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf8").trim();
}

export function saveSession(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, value, { mode: 0o600 });
}

export function clearSession(path: string): void {
  if (existsSync(path)) rmSync(path);
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `bun test src/core/session.test.ts`
Expected: PASS — 6 tests

- [ ] **Step 5: Commit**

```bash
git add src/core/session.ts src/core/session.test.ts
git commit -m "Add session persistence with 0600 permissions"
```

---

### Task 9: The store

**Files:**
- Create: `src/core/store.ts`
- Test: `src/core/store.test.ts`

**Interfaces:**
- Consumes: `DialogRow`, `MessageRow` from `cache/db.ts`; `EngineState` from `keys/types.ts`
- Produces: `createStore(): Store` with `getState()`, `setState(partial)`, `subscribe(fn): () => void`, and `AppState`:

```ts
interface AppState {
  engine: EngineState;
  dialogs: DialogRow[];
  messages: MessageRow[];
  activePeerId: string | null;
  chatCursor: number;
  messageCursor: number;
  composerText: string;
  connection: "offline" | "connecting" | "connected";
  statusMessage: string | null;
}
```

- [ ] **Step 1: Write the failing test**

`src/core/store.test.ts`:

```ts
import { test, expect } from "bun:test";
import { createStore } from "./store.ts";

test("starts with sensible defaults", () => {
  const s = createStore();
  expect(s.getState().connection).toBe("offline");
  expect(s.getState().dialogs).toEqual([]);
  expect(s.getState().engine.mode).toBe("normal");
  expect(s.getState().activePeerId).toBeNull();
});

test("setState merges shallowly", () => {
  const s = createStore();
  s.setState({ connection: "connected" });
  expect(s.getState().connection).toBe("connected");
  expect(s.getState().messages).toEqual([]);
});

test("subscribers are notified on change", () => {
  const s = createStore();
  let calls = 0;
  s.subscribe(() => { calls += 1; });
  s.setState({ connection: "connecting" });
  s.setState({ statusMessage: "hi" });
  expect(calls).toBe(2);
});

test("unsubscribe stops notifications", () => {
  const s = createStore();
  let calls = 0;
  const off = s.subscribe(() => { calls += 1; });
  s.setState({ connection: "connecting" });
  off();
  s.setState({ connection: "connected" });
  expect(calls).toBe(1);
});

test("state objects are replaced, not mutated, so React sees a new reference", () => {
  const s = createStore();
  const before = s.getState();
  s.setState({ connection: "connected" });
  expect(s.getState()).not.toBe(before);
  expect(before.connection).toBe("offline");
});

test("one subscriber throwing does not stop the others", () => {
  const s = createStore();
  let reached = false;
  s.subscribe(() => { throw new Error("boom"); });
  s.subscribe(() => { reached = true; });
  s.setState({ connection: "connected" });
  expect(reached).toBe(true);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test src/core/store.test.ts`
Expected: FAIL — `Cannot find module './store.ts'`

- [ ] **Step 3: Write `src/core/store.ts`**

```ts
import { initialEngineState, type EngineState } from "../keys/types.ts";
import type { DialogRow, MessageRow } from "./cache/db.ts";

export interface AppState {
  engine: EngineState;
  dialogs: DialogRow[];
  messages: MessageRow[];
  activePeerId: string | null;
  chatCursor: number;
  messageCursor: number;
  composerText: string;
  connection: "offline" | "connecting" | "connected";
  statusMessage: string | null;
}

export interface Store {
  getState(): AppState;
  setState(partial: Partial<AppState>): void;
  subscribe(listener: () => void): () => void;
}

const initialState: AppState = {
  engine: initialEngineState,
  dialogs: [],
  messages: [],
  activePeerId: null,
  chatCursor: 0,
  messageCursor: 0,
  composerText: "",
  connection: "offline",
  statusMessage: null,
};

export function createStore(): Store {
  let state: AppState = initialState;
  const listeners = new Set<() => void>();

  return {
    getState: () => state,
    setState(partial) {
      state = { ...state, ...partial };
      for (const listener of listeners) {
        // A failing subscriber must not prevent the rest of the UI updating.
        try {
          listener();
        } catch (error) {
          process.stderr.write(`store listener threw: ${String(error)}\n`);
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `bun test src/core/store.test.ts`
Expected: PASS — 6 tests

- [ ] **Step 5: Commit**

```bash
git add src/core/store.ts src/core/store.test.ts
git commit -m "Add observable app store"
```

---

### Task 10: Telegram client and auth state machine

**Files:**
- Create: `src/core/client.ts`, `src/core/auth.ts`
- Test: `src/core/auth.test.ts`

**Interfaces:**
- Consumes: `Config` from `config.ts`; `loadSession`/`saveSession` from `session.ts`
- Produces:
  - `createClient(config: Config): TelegramClient` (thin factory, no tests — exercised by the smoke test)
  - `type AuthStep = "phone" | "code" | "password" | "ready"`
  - `createAuthMachine(deps: AuthDeps): AuthMachine` with
    `step(): AuthStep`, `submitPhone(p)`, `submitCode(c)`, `submitPassword(p)` — all async, returning the new step.
  - `AuthDeps = { sendCode(phone): Promise<void>; signIn(code): Promise<"ok"|"needPassword">; checkPassword(pw): Promise<void> }`

The machine is separated from GramJS precisely so it can be tested without a
network or a phone number.

- [ ] **Step 1: Write the failing test**

`src/core/auth.test.ts`:

```ts
import { test, expect } from "bun:test";
import { createAuthMachine, type AuthDeps } from "./auth.ts";

function deps(overrides: Partial<AuthDeps> = {}): AuthDeps {
  return {
    sendCode: async () => {},
    signIn: async () => "ok",
    checkPassword: async () => {},
    ...overrides,
  };
}

test("starts at the phone step", () => {
  expect(createAuthMachine(deps()).step()).toBe("phone");
});

test("a valid phone advances to the code step", async () => {
  const m = createAuthMachine(deps());
  expect(await m.submitPhone("+84900000000")).toBe("code");
});

test("a correct code with no 2FA reaches ready", async () => {
  const m = createAuthMachine(deps());
  await m.submitPhone("+84900000000");
  expect(await m.submitCode("12345")).toBe("ready");
});

test("an account with 2FA is routed to the password step", async () => {
  const m = createAuthMachine(deps({ signIn: async () => "needPassword" }));
  await m.submitPhone("+84900000000");
  expect(await m.submitCode("12345")).toBe("password");
  expect(await m.submitPassword("hunter2")).toBe("ready");
});

test("submitting out of order is rejected", async () => {
  const m = createAuthMachine(deps());
  await expect(m.submitCode("12345")).rejects.toThrow(/phone/i);
});

test("a wrong code keeps us on the code step", async () => {
  const m = createAuthMachine(deps({
    signIn: async () => { throw new Error("PHONE_CODE_INVALID"); },
  }));
  await m.submitPhone("+84900000000");
  await expect(m.submitCode("00000")).rejects.toThrow(/PHONE_CODE_INVALID/);
  expect(m.step()).toBe("code");
});

test("a wrong password keeps us on the password step", async () => {
  const m = createAuthMachine(deps({
    signIn: async () => "needPassword",
    checkPassword: async () => { throw new Error("PASSWORD_HASH_INVALID"); },
  }));
  await m.submitPhone("+84900000000");
  await m.submitCode("12345");
  await expect(m.submitPassword("wrong")).rejects.toThrow(/PASSWORD_HASH_INVALID/);
  expect(m.step()).toBe("password");
});

test("an empty phone number is rejected before any network call", async () => {
  let called = false;
  const m = createAuthMachine(deps({ sendCode: async () => { called = true; } }));
  await expect(m.submitPhone("  ")).rejects.toThrow(/phone/i);
  expect(called).toBe(false);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test src/core/auth.test.ts`
Expected: FAIL — `Cannot find module './auth.ts'`

- [ ] **Step 3: Write `src/core/auth.ts`**

```ts
export type AuthStep = "phone" | "code" | "password" | "ready";

export interface AuthDeps {
  sendCode(phone: string): Promise<void>;
  signIn(code: string): Promise<"ok" | "needPassword">;
  checkPassword(password: string): Promise<void>;
}

export interface AuthMachine {
  step(): AuthStep;
  submitPhone(phone: string): Promise<AuthStep>;
  submitCode(code: string): Promise<AuthStep>;
  submitPassword(password: string): Promise<AuthStep>;
}

/**
 * Login as an explicit state machine, kept free of GramJS so the whole flow —
 * including the 2FA branch and every failure path — is testable with no network
 * and no phone number.
 *
 * On failure the step is deliberately unchanged, so the UI can simply re-prompt.
 */
export function createAuthMachine(deps: AuthDeps): AuthMachine {
  let step: AuthStep = "phone";

  return {
    step: () => step,

    async submitPhone(phone) {
      if (step !== "phone") throw new Error(`Cannot submit a phone number at the ${step} step`);
      if (phone.trim() === "") throw new Error("A phone number is required");
      await deps.sendCode(phone.trim());
      step = "code";
      return step;
    },

    async submitCode(code) {
      if (step !== "code") throw new Error("Submit a phone number before a code");
      const result = await deps.signIn(code.trim());
      step = result === "needPassword" ? "password" : "ready";
      return step;
    },

    async submitPassword(password) {
      if (step !== "password") throw new Error("No two-factor password was requested");
      await deps.checkPassword(password);
      step = "ready";
      return step;
    },
  };
}
```

- [ ] **Step 4: Write `src/core/client.ts`**

```ts
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { Logger } from "telegram/extensions/Logger";
import type { Config } from "./config.ts";
import { loadSession, saveSession } from "./session.ts";

/**
 * GramJS lifecycle. Device fields are truthful on purpose: misrepresenting the
 * client is one of the behaviours that attracts account restrictions.
 */
export function createClient(config: Config): TelegramClient {
  const session = new StringSession(loadSession(config.sessionPath));

  return new TelegramClient(session, config.apiId, config.apiHash, {
    connectionRetries: 5,
    retryDelay: 1000,
    autoReconnect: true,
    deviceModel: "tglow",
    systemVersion: process.platform,
    appVersion: "0.1.0",
    baseLogger: new Logger("error" as never),
  });
}

export function persistSession(client: TelegramClient, config: Config): void {
  const value = client.session.save() as unknown as string;
  if (typeof value === "string" && value.length > 0) {
    saveSession(config.sessionPath, value);
  }
}
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `bun test src/core/auth.test.ts`
Expected: PASS — 8 tests

- [ ] **Step 6: Verify the boundary test still passes**

Run: `bun test src/test/boundaries.test.ts`
Expected: PASS — `core/` imports `telegram` but no React or OpenTUI.

- [ ] **Step 7: Commit**

```bash
git add src/core/client.ts src/core/auth.ts src/core/auth.test.ts
git commit -m "Add Telegram client factory and testable auth state machine"
```

---

### Task 11: Dialogs and messages

**Files:**
- Create: `src/core/dialogs.ts`, `src/core/messages.ts`
- Test: `src/core/dialogs.test.ts`, `src/core/messages.test.ts`

**Interfaces:**
- Consumes: `Db` from `cache/db.ts`; `Store` from `store.ts`
- Produces:
  - `syncDialogs(deps: { api: DialogApi; db: Db; store: Store }): Promise<void>`
  - `DialogApi = { fetchDialogs(): Promise<RawDialog[]> }`,
    `RawDialog = { peerId; type; accessHash; title; username; pinned; unreadCount; lastMessageAt; topMessageId }`
  - `loadHistory(deps: { api: MessageApi; db: Db; store: Store }, peerId: string, limit: number): Promise<void>`
  - `sendMessage(deps: { api: MessageApi; db: Db; store: Store }, peerId: string, text: string): Promise<void>`
  - `MessageApi = { fetchHistory(peerId, limit): Promise<RawMessage[]>; send(peerId, text): Promise<RawMessage> }`,
    `RawMessage = { id; peerId; fromId; date; text; out }`

Both take their API as a parameter so tests use a fake instead of the network.

- [ ] **Step 1: Write the failing dialogs test**

`src/core/dialogs.test.ts`:

```ts
import { test, expect } from "bun:test";
import { openDb } from "./cache/db.ts";
import { createStore } from "./store.ts";
import { syncDialogs, type DialogApi, type RawDialog } from "./dialogs.ts";

const raw = (over: Partial<RawDialog> = {}): RawDialog => ({
  peerId: "u1", type: "user", accessHash: "h", title: "Alice", username: "alice",
  pinned: 0, unreadCount: 0, lastMessageAt: 100, topMessageId: 1, ...over,
});

function harness(dialogs: RawDialog[]) {
  const db = openDb(":memory:");
  const store = createStore();
  const api: DialogApi = { fetchDialogs: async () => dialogs };
  return { db, store, api };
}

test("fetched dialogs land in the store", async () => {
  const h = harness([raw()]);
  await syncDialogs(h);
  expect(h.store.getState().dialogs.map((d) => d.title)).toEqual(["Alice"]);
  h.db.close();
});

test("dialogs are cached so they survive a restart", async () => {
  const h = harness([raw()]);
  await syncDialogs(h);
  expect(h.db.listDialogs()).toHaveLength(1);
  h.db.close();
});

test("pinned dialogs sort above more recent unpinned ones", async () => {
  const h = harness([
    raw({ peerId: "u1", title: "Alice", pinned: 0, lastMessageAt: 300 }),
    raw({ peerId: "u2", title: "Bob", pinned: 1, lastMessageAt: 100 }),
  ]);
  await syncDialogs(h);
  expect(h.store.getState().dialogs.map((d) => d.title)).toEqual(["Bob", "Alice"]);
  h.db.close();
});

test("a second sync updates rather than duplicating", async () => {
  const db = openDb(":memory:");
  const store = createStore();
  await syncDialogs({ db, store, api: { fetchDialogs: async () => [raw({ unreadCount: 1 })] } });
  await syncDialogs({ db, store, api: { fetchDialogs: async () => [raw({ unreadCount: 7 })] } });
  const dialogs = store.getState().dialogs;
  expect(dialogs).toHaveLength(1);
  expect(dialogs[0]!.unreadCount).toBe(7);
  db.close();
});

test("a network failure leaves the cached list visible", async () => {
  const db = openDb(":memory:");
  const store = createStore();
  await syncDialogs({ db, store, api: { fetchDialogs: async () => [raw()] } });
  await syncDialogs({
    db, store,
    api: { fetchDialogs: async () => { throw new Error("network down"); } },
  });
  expect(store.getState().dialogs).toHaveLength(1);
  expect(store.getState().statusMessage).toContain("network down");
  db.close();
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test src/core/dialogs.test.ts`
Expected: FAIL — `Cannot find module './dialogs.ts'`

- [ ] **Step 3: Write `src/core/dialogs.ts`**

```ts
import type { Db } from "./cache/db.ts";
import type { Store } from "./store.ts";

export interface RawDialog {
  peerId: string;
  type: "user" | "chat" | "channel";
  accessHash: string | null;
  title: string;
  username: string | null;
  pinned: number;
  unreadCount: number;
  lastMessageAt: number;
  topMessageId: number;
}

export interface DialogApi {
  fetchDialogs(): Promise<RawDialog[]>;
}

export interface DialogDeps {
  api: DialogApi;
  db: Db;
  store: Store;
}

/**
 * Refresh the chat list. On failure the cached list stays on screen — going
 * offline should never blank the UI.
 */
export async function syncDialogs({ api, db, store }: DialogDeps): Promise<void> {
  try {
    const dialogs = await api.fetchDialogs();
    for (const d of dialogs) {
      db.upsertPeer({
        id: d.peerId, type: d.type, accessHash: d.accessHash,
        title: d.title, username: d.username,
      });
      db.upsertDialog({
        peerId: d.peerId, pinned: d.pinned, unreadCount: d.unreadCount,
        lastMessageAt: d.lastMessageAt, topMessageId: d.topMessageId,
      });
    }
    store.setState({ dialogs: db.listDialogs(), statusMessage: null });
  } catch (error) {
    store.setState({
      dialogs: db.listDialogs(),
      statusMessage: `Could not refresh chats: ${(error as Error).message}`,
    });
  }
}
```

- [ ] **Step 4: Run the dialogs tests and watch them pass**

Run: `bun test src/core/dialogs.test.ts`
Expected: PASS — 5 tests

- [ ] **Step 5: Write the failing messages test**

`src/core/messages.test.ts`:

```ts
import { test, expect } from "bun:test";
import { openDb } from "./cache/db.ts";
import { createStore } from "./store.ts";
import { loadHistory, sendMessage, type MessageApi, type RawMessage } from "./messages.ts";

const msg = (over: Partial<RawMessage> = {}): RawMessage => ({
  id: 1, peerId: "u1", fromId: "u1", date: 100, text: "hi", out: 0, ...over,
});

function harness(history: RawMessage[] = []) {
  const db = openDb(":memory:");
  const store = createStore();
  db.upsertPeer({ id: "u1", type: "user", accessHash: "h", title: "Alice", username: null });
  const sent: RawMessage[] = [];
  const api: MessageApi = {
    fetchHistory: async () => history,
    send: async (peerId, text) => {
      const m = msg({ id: 99, peerId, text, out: 1, date: 999 });
      sent.push(m);
      return m;
    },
  };
  return { db, store, api, sent };
}

test("history loads oldest-first for display", async () => {
  const h = harness([
    msg({ id: 1, date: 100, text: "morning!" }),
    msg({ id: 2, date: 200, text: "ok ping me" }),
  ]);
  await loadHistory(h, "u1", 50);
  expect(h.store.getState().messages.map((m) => m.text)).toEqual(["morning!", "ok ping me"]);
  h.db.close();
});

test("history is cached", async () => {
  const h = harness([msg()]);
  await loadHistory(h, "u1", 50);
  expect(h.db.listMessages("u1", 50)).toHaveLength(1);
  h.db.close();
});

test("a network failure falls back to the cache", async () => {
  const db = openDb(":memory:");
  const store = createStore();
  db.upsertPeer({ id: "u1", type: "user", accessHash: "h", title: "Alice", username: null });
  db.insertMessages([{ peerId: "u1", id: 1, fromId: "u1", date: 100, text: "cached", out: 0 }]);
  await loadHistory({
    db, store,
    api: {
      fetchHistory: async () => { throw new Error("offline"); },
      send: async () => msg(),
    },
  }, "u1", 50);
  expect(store.getState().messages.map((m) => m.text)).toEqual(["cached"]);
  expect(store.getState().statusMessage).toContain("offline");
  db.close();
});

test("sending appends the message to the view", async () => {
  const h = harness();
  h.store.setState({ activePeerId: "u1" });
  await sendMessage(h, "u1", "on my way");
  expect(h.store.getState().messages.map((m) => m.text)).toEqual(["on my way"]);
  expect(h.sent).toHaveLength(1);
  h.db.close();
});

test("sending clears the composer", async () => {
  const h = harness();
  h.store.setState({ activePeerId: "u1", composerText: "on my way" });
  await sendMessage(h, "u1", "on my way");
  expect(h.store.getState().composerText).toBe("");
  h.db.close();
});

test("empty and whitespace-only messages are not sent", async () => {
  const h = harness();
  await sendMessage(h, "u1", "   ");
  expect(h.sent).toHaveLength(0);
  h.db.close();
});

test("a failed send keeps the text so it is not lost", async () => {
  const db = openDb(":memory:");
  const store = createStore();
  db.upsertPeer({ id: "u1", type: "user", accessHash: "h", title: "Alice", username: null });
  store.setState({ composerText: "important" });
  await sendMessage({
    db, store,
    api: {
      fetchHistory: async () => [],
      send: async () => { throw new Error("FLOOD_WAIT_30"); },
    },
  }, "u1", "important");
  expect(store.getState().composerText).toBe("important");
  expect(store.getState().statusMessage).toContain("FLOOD_WAIT_30");
  db.close();
});
```

- [ ] **Step 6: Run it and watch it fail**

Run: `bun test src/core/messages.test.ts`
Expected: FAIL — `Cannot find module './messages.ts'`

- [ ] **Step 7: Write `src/core/messages.ts`**

```ts
import type { Db, MessageRow } from "./cache/db.ts";
import type { Store } from "./store.ts";

export interface RawMessage {
  id: number;
  peerId: string;
  fromId: string | null;
  date: number;
  text: string;
  out: number;
}

export interface MessageApi {
  fetchHistory(peerId: string, limit: number): Promise<RawMessage[]>;
  send(peerId: string, text: string): Promise<RawMessage>;
}

export interface MessageDeps {
  api: MessageApi;
  db: Db;
  store: Store;
}

/** The cache returns newest-first; the view reads oldest-first, like a chat. */
function forDisplay(rows: MessageRow[]): MessageRow[] {
  return [...rows].reverse();
}

export async function loadHistory(
  { api, db, store }: MessageDeps,
  peerId: string,
  limit: number,
): Promise<void> {
  try {
    const fetched = await api.fetchHistory(peerId, limit);
    db.insertMessages(fetched.map((m) => ({
      peerId: m.peerId, id: m.id, fromId: m.fromId,
      date: m.date, text: m.text, out: m.out,
    })));
    store.setState({
      messages: forDisplay(db.listMessages(peerId, limit)),
      activePeerId: peerId,
      statusMessage: null,
    });
  } catch (error) {
    // Offline is not an error state for reading — show what we already have.
    store.setState({
      messages: forDisplay(db.listMessages(peerId, limit)),
      activePeerId: peerId,
      statusMessage: `Could not load history: ${(error as Error).message}`,
    });
  }
}

export async function sendMessage(
  { api, db, store }: MessageDeps,
  peerId: string,
  text: string,
): Promise<void> {
  if (text.trim() === "") return;

  try {
    const sent = await api.send(peerId, text);
    db.insertMessages([{
      peerId: sent.peerId, id: sent.id, fromId: sent.fromId,
      date: sent.date, text: sent.text, out: sent.out,
    }]);
    store.setState({
      messages: forDisplay(db.listMessages(peerId, 200)),
      composerText: "",
      statusMessage: null,
    });
  } catch (error) {
    // Keep the text: losing what someone typed is the worst possible failure.
    store.setState({ statusMessage: `Send failed: ${(error as Error).message}` });
  }
}
```

- [ ] **Step 8: Run the tests and watch them pass**

Run: `bun test src/core/messages.test.ts`
Expected: PASS — 7 tests

- [ ] **Step 9: Commit**

```bash
git add src/core/dialogs.ts src/core/dialogs.test.ts src/core/messages.ts src/core/messages.test.ts
git commit -m "Add dialog sync and message history with offline fallback"
```

---

### Task 12: devglow theme

**Files:**
- Create: `src/tui/theme/palettes.ts`, `src/tui/theme/tokens.ts`
- Test: `src/tui/theme/tokens.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `palettes: Record<string, Palette>`, `type Palette` (17 keys),
  `tokensFor(paletteName: string): Tokens`, `type Tokens`

- [ ] **Step 1: Write the failing test**

`src/tui/theme/tokens.test.ts`:

```ts
import { test, expect } from "bun:test";
import { palettes, type Palette } from "./palettes.ts";
import { tokensFor } from "./tokens.ts";

const PALETTE_KEYS: Array<keyof Palette> = [
  "FOREGROUND", "BACKGROUND", "RED", "GREEN", "BLUE", "ORANGE", "YELLOW",
  "PINK", "GOLD", "TEAL", "SKY", "WINE",
  "DARK_00", "DARK_01", "DARK_02", "DARK_03", "DARK_04",
];

test("every palette has all 17 devglow keys", () => {
  for (const [name, palette] of Object.entries(palettes)) {
    for (const key of PALETTE_KEYS) {
      expect(palette[key], `${name}.${key}`).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  }
});

// These values come from devglow/lua/devglow/palettes/sage.lua and must match.
test("sage matches the upstream devglow palette exactly", () => {
  const sage = palettes.sage!;
  expect(sage.FOREGROUND).toBe("#E6E6E6");
  expect(sage.BACKGROUND).toBe("#080808");
  expect(sage.GOLD).toBe("#EBC17A");
  expect(sage.TEAL).toBe("#7DB9B6");
  expect(sage.PINK).toBe("#D68C8C");
  expect(sage.DARK_03).toBe("#383838");
});

test("sage is the default palette", () => {
  expect(tokensFor("nonexistent-palette")).toEqual(tokensFor("sage"));
});

test("mode colours differ so the status bar is readable at a glance", () => {
  const t = tokensFor("sage");
  expect(t.modeNormal).toBe("#7DB9B6");
  expect(t.modeInsert).toBe("#EBC17A");
  expect(t.modeVisual).toBe("#D68C8C");
  expect(new Set([t.modeNormal, t.modeInsert, t.modeVisual]).size).toBe(3);
});

test("tokens resolve against whichever palette is chosen", () => {
  expect(tokensFor("ember").modeInsert).toBe(palettes.ember!.GOLD);
  expect(tokensFor("sage").modeInsert).toBe(palettes.sage!.GOLD);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test src/tui/theme/tokens.test.ts`
Expected: FAIL — `Cannot find module './palettes.ts'`

- [ ] **Step 3: Write `src/tui/theme/palettes.ts`**

Values copied verbatim from `devglow/lua/devglow/palettes/`. M1a ships `sage`
(the active alacritty theme) and `ember`; the remaining ten are added in M1b by
transcribing the corresponding `.lua` files — the structure is identical.

```ts
export interface Palette {
  FOREGROUND: string;
  BACKGROUND: string;
  RED: string;
  GREEN: string;
  BLUE: string;
  ORANGE: string;
  YELLOW: string;
  PINK: string;
  GOLD: string;
  TEAL: string;
  SKY: string;
  WINE: string;
  DARK_00: string;
  DARK_01: string;
  DARK_02: string;
  DARK_03: string;
  DARK_04: string;
}

/** Muted, grey-tinted, calm. One for the quiet night. */
const sage: Palette = {
  FOREGROUND: "#E6E6E6",
  BACKGROUND: "#080808",
  RED: "#AF5F5F",
  GREEN: "#87AFAF",
  BLUE: "#7590AF",
  ORANGE: "#D59572",
  YELLOW: "#E5B567",
  PINK: "#D68C8C",
  GOLD: "#EBC17A",
  TEAL: "#7DB9B6",
  SKY: "#7EAAC7",
  WINE: "#924653",
  DARK_00: "#111111",
  DARK_01: "#181818",
  DARK_02: "#282828",
  DARK_03: "#383838",
  DARK_04: "#797979",
};

/** Not the flame itself, but the glowing coals underneath. */
const ember: Palette = {
  FOREGROUND: "#F5F0EB",
  BACKGROUND: "#141311",
  RED: "#D06060",
  GREEN: "#6AADAD",
  BLUE: "#5A9D9D",
  ORANGE: "#D4785E",
  YELLOW: "#E0BA6A",
  PINK: "#E08B72",
  GOLD: "#EACA80",
  TEAL: "#7BBDBD",
  SKY: "#6AADAD",
  WINE: "#B45A42",
  DARK_00: "#1A1917",
  DARK_01: "#211F1D",
  DARK_02: "#2E2B28",
  DARK_03: "#3D3935",
  DARK_04: "#847C74",
};

export const palettes: Record<string, Palette> = { sage, ember };
export const DEFAULT_PALETTE = "sage";
```

- [ ] **Step 4: Write `src/tui/theme/tokens.ts`**

```ts
import { DEFAULT_PALETTE, palettes, type Palette } from "./palettes.ts";

/**
 * Semantic roles, so components never name a colour directly and palettes stay
 * swappable at runtime.
 */
export interface Tokens {
  background: string;
  foreground: string;
  border: string;
  dim: string;

  modeNormal: string;
  modeInsert: string;
  modeVisual: string;

  chatUnread: string;
  chatActive: string;

  messageOwn: string;
  messageOther: string;
  messageCursor: string;

  error: string;
}

export function tokensFor(paletteName: string): Tokens {
  const p: Palette = palettes[paletteName] ?? palettes[DEFAULT_PALETTE]!;
  return {
    background: p.BACKGROUND,
    foreground: p.FOREGROUND,
    border: p.DARK_02,
    dim: p.DARK_04,

    modeNormal: p.TEAL,
    modeInsert: p.GOLD,
    modeVisual: p.PINK,

    chatUnread: p.GOLD,
    chatActive: p.TEAL,

    messageOwn: p.TEAL,
    messageOther: p.FOREGROUND,
    messageCursor: p.DARK_03,

    error: p.RED,
  };
}
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `bun test src/tui/theme/tokens.test.ts`
Expected: PASS — 5 tests

- [ ] **Step 6: Commit**

```bash
git add src/tui/theme/
git commit -m "Add devglow palettes and semantic theme tokens"
```

---

### Task 13: StatusLine and ChatList panes

**Files:**
- Create: `src/tui/panes/StatusLine.tsx`, `src/tui/panes/ChatList.tsx`
- Test: `src/tui/panes/StatusLine.test.tsx`, `src/tui/panes/ChatList.test.tsx`

**Interfaces:**
- Consumes: `Tokens` from `theme/tokens.ts`; `DialogRow` from `core/cache/db.ts`; `renderWithKeys` from `test/render.tsx`
- Produces:
  - `<StatusLine mode title unreadCount position total hint tokens />`
  - `<ChatList dialogs cursor focused tokens width />`

- [ ] **Step 1: Write the failing StatusLine test**

`src/tui/panes/StatusLine.test.tsx`:

```tsx
import { test, expect } from "bun:test";
import { renderWithKeys } from "../../test/render.tsx";
import { tokensFor } from "../theme/tokens.ts";
import { StatusLine } from "./StatusLine.tsx";

const tokens = tokensFor("sage");

test("shows the mode, chat and unread count", async () => {
  const t = await renderWithKeys(
    <StatusLine mode="normal" title="Alice" unreadCount={3} position={4} total={312}
                hint="\\ for keys" tokens={tokens} />,
    { width: 60, height: 1 },
  );
  await t.flush();
  const frame = t.captureCharFrame();
  expect(frame).toContain("NORMAL");
  expect(frame).toContain("Alice");
  expect(frame).toContain("3 unread");
  expect(frame).toContain("4/312");
});

test("the mode label is upper case, like lualine", async () => {
  const t = await renderWithKeys(
    <StatusLine mode="insert" title="Bob" unreadCount={0} position={1} total={1}
                hint="" tokens={tokens} />,
    { width: 60, height: 1 },
  );
  await t.flush();
  expect(t.captureCharFrame()).toContain("INSERT");
});

test("a zero unread count is not shown", async () => {
  const t = await renderWithKeys(
    <StatusLine mode="normal" title="Bob" unreadCount={0} position={1} total={1}
                hint="" tokens={tokens} />,
    { width: 60, height: 1 },
  );
  await t.flush();
  expect(t.captureCharFrame()).not.toContain("unread");
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test src/tui/panes/StatusLine.test.tsx`
Expected: FAIL — `Cannot find module './StatusLine.tsx'`

- [ ] **Step 3: Write `src/tui/panes/StatusLine.tsx`**

```tsx
import type { Mode } from "../../keys/types.ts";
import type { Tokens } from "../theme/tokens.ts";

export interface StatusLineProps {
  mode: Mode;
  title: string;
  unreadCount: number;
  position: number;
  total: number;
  hint: string;
  tokens: Tokens;
}

function modeColour(mode: Mode, tokens: Tokens): string {
  if (mode === "insert") return tokens.modeInsert;
  if (mode === "visual") return tokens.modeVisual;
  return tokens.modeNormal;
}

/** lualine-style: mode in section A, then context, then position. */
export function StatusLine(props: StatusLineProps) {
  const { mode, title, unreadCount, position, total, hint, tokens } = props;

  const segments: string[] = [title];
  if (unreadCount > 0) segments.push(`${unreadCount} unread`);
  segments.push(`${position}/${total}`);
  if (hint !== "") segments.push(hint);

  return (
    <box flexDirection="row">
      <text fg={modeColour(mode, tokens)}>{` ${mode.toUpperCase()} `}</text>
      <text fg={tokens.dim}>{`│ ${segments.join(" │ ")}`}</text>
    </box>
  );
}
```

- [ ] **Step 4: Run the StatusLine tests and watch them pass**

Run: `bun test src/tui/panes/StatusLine.test.tsx`
Expected: PASS — 3 tests

- [ ] **Step 5: Write the failing ChatList test**

`src/tui/panes/ChatList.test.tsx`:

```tsx
import { test, expect } from "bun:test";
import { renderWithKeys } from "../../test/render.tsx";
import { tokensFor } from "../theme/tokens.ts";
import { ChatList } from "./ChatList.tsx";
import type { DialogRow } from "../../core/cache/db.ts";

const tokens = tokensFor("sage");

const dialogs: DialogRow[] = [
  { peerId: "u1", title: "Alice", pinned: 0, unreadCount: 2, lastMessageAt: 300, topMessageId: 9 },
  { peerId: "u2", title: "Bob", pinned: 0, unreadCount: 0, lastMessageAt: 200, topMessageId: 4 },
  { peerId: "c1", title: "devs", pinned: 0, unreadCount: 7, lastMessageAt: 100, topMessageId: 2 },
];

test("lists every chat", async () => {
  const t = await renderWithKeys(
    <ChatList dialogs={dialogs} cursor={0} focused tokens={tokens} width={20} />,
    { width: 20, height: 10 },
  );
  await t.flush();
  const frame = t.captureCharFrame();
  expect(frame).toContain("Alice");
  expect(frame).toContain("Bob");
  expect(frame).toContain("devs");
});

test("shows unread counts but not zeros", async () => {
  const t = await renderWithKeys(
    <ChatList dialogs={dialogs} cursor={0} focused tokens={tokens} width={20} />,
    { width: 20, height: 10 },
  );
  await t.flush();
  const frame = t.captureCharFrame();
  expect(frame).toContain("2");
  expect(frame).toContain("7");
  expect(frame).toMatch(/Bob\s+$/m);
});

test("marks the cursor row", async () => {
  const t = await renderWithKeys(
    <ChatList dialogs={dialogs} cursor={1} focused tokens={tokens} width={20} />,
    { width: 20, height: 10 },
  );
  await t.flush();
  expect(t.captureCharFrame()).toContain("▸ Bob");
});

test("renders an empty list without crashing", async () => {
  const t = await renderWithKeys(
    <ChatList dialogs={[]} cursor={0} focused tokens={tokens} width={20} />,
    { width: 20, height: 10 },
  );
  await t.flush();
  expect(t.captureCharFrame()).toContain("No chats");
});
```

- [ ] **Step 6: Run it and watch it fail**

Run: `bun test src/tui/panes/ChatList.test.tsx`
Expected: FAIL — `Cannot find module './ChatList.tsx'`

- [ ] **Step 7: Write `src/tui/panes/ChatList.tsx`**

```tsx
import type { DialogRow } from "../../core/cache/db.ts";
import type { Tokens } from "../theme/tokens.ts";

export interface ChatListProps {
  dialogs: DialogRow[];
  cursor: number;
  focused: boolean;
  tokens: Tokens;
  width: number;
}

export function ChatList({ dialogs, cursor, focused, tokens, width }: ChatListProps) {
  if (dialogs.length === 0) {
    return (
      <box flexDirection="column" width={width}>
        <text fg={tokens.dim}>No chats</text>
      </box>
    );
  }

  // Leave room for the "▸ " marker and a right-aligned unread badge.
  const nameWidth = Math.max(4, width - 6);

  return (
    <box flexDirection="column" width={width}>
      {dialogs.map((d, i) => {
        const selected = i === cursor;
        const marker = selected && focused ? "▸ " : "  ";
        const name = d.title.length > nameWidth ? d.title.slice(0, nameWidth - 1) + "…" : d.title;
        const badge = d.unreadCount > 0 ? String(d.unreadCount) : "";
        const pad = " ".repeat(Math.max(1, nameWidth - name.length + 1));
        return (
          <text
            key={d.peerId}
            fg={selected ? tokens.chatActive : tokens.foreground}
            bg={selected ? tokens.messageCursor : undefined}
          >
            {marker}{name}{pad}
            <span fg={tokens.chatUnread}>{badge}</span>
          </text>
        );
      })}
    </box>
  );
}
```

- [ ] **Step 8: Run the ChatList tests and watch them pass**

Run: `bun test src/tui/panes/ChatList.test.tsx`
Expected: PASS — 4 tests

- [ ] **Step 9: Commit**

```bash
git add src/tui/panes/StatusLine.tsx src/tui/panes/StatusLine.test.tsx src/tui/panes/ChatList.tsx src/tui/panes/ChatList.test.tsx
git commit -m "Add StatusLine and ChatList panes"
```

---

### Task 14: MessageView and Composer panes

**Files:**
- Create: `src/tui/panes/MessageView.tsx`, `src/tui/panes/Composer.tsx`
- Test: `src/tui/panes/MessageView.test.tsx`, `src/tui/panes/Composer.test.tsx`

**Interfaces:**
- Consumes: `MessageRow` from `core/cache/db.ts`; `Tokens`
- Produces:
  - `<MessageView messages cursor focused tokens senderName />` where
    `senderName: (fromId: string | null) => string`
  - `<Composer text mode focused tokens />`

- [ ] **Step 1: Write the failing MessageView test**

`src/tui/panes/MessageView.test.tsx`:

```tsx
import { test, expect } from "bun:test";
import { renderWithKeys } from "../../test/render.tsx";
import { tokensFor } from "../theme/tokens.ts";
import { MessageView } from "./MessageView.tsx";
import type { MessageRow } from "../../core/cache/db.ts";

const tokens = tokensFor("sage");
const names = (id: string | null) => (id === "me" ? "me" : "Alice");

const messages: MessageRow[] = [
  { peerId: "u1", id: 1, fromId: "u1", date: 100, text: "morning!", out: 0 },
  { peerId: "u1", id: 2, fromId: "u1", date: 200, text: "ok ping me", out: 0 },
  { peerId: "u1", id: 3, fromId: "me", date: 300, text: "not yet", out: 1 },
  { peerId: "u1", id: 4, fromId: "u1", date: 400, text: "did you push it?", out: 0 },
];

test("shows sender and text for each message", async () => {
  const t = await renderWithKeys(
    <MessageView messages={messages} cursor={3} focused tokens={tokens} senderName={names} />,
    { width: 50, height: 10 },
  );
  await t.flush();
  const frame = t.captureCharFrame();
  expect(frame).toContain("morning!");
  expect(frame).toContain("did you push it?");
  expect(frame).toContain("Alice");
  expect(frame).toContain("me");
});

// Mirrors relativenumber + number in the author's neovim config, so 3j is
// visually obvious before it is typed.
test("gutter shows relative distance, and absolute on the cursor row", async () => {
  const t = await renderWithKeys(
    <MessageView messages={messages} cursor={3} focused tokens={tokens} senderName={names} />,
    { width: 50, height: 10 },
  );
  await t.flush();
  const lines = t.captureCharFrame().split("\n");
  expect(lines[0]).toContain("3");   // three above the cursor
  expect(lines[1]).toContain("2");
  expect(lines[2]).toContain("1");
  expect(lines[3]).toContain("4");   // cursor row shows its absolute position
});

test("marks the cursor row", async () => {
  const t = await renderWithKeys(
    <MessageView messages={messages} cursor={1} focused tokens={tokens} senderName={names} />,
    { width: 50, height: 10 },
  );
  await t.flush();
  expect(t.captureCharFrame()).toContain("▸");
});

test("renders an empty history without crashing", async () => {
  const t = await renderWithKeys(
    <MessageView messages={[]} cursor={0} focused tokens={tokens} senderName={names} />,
    { width: 50, height: 10 },
  );
  await t.flush();
  expect(t.captureCharFrame()).toContain("No messages");
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test src/tui/panes/MessageView.test.tsx`
Expected: FAIL — `Cannot find module './MessageView.tsx'`

- [ ] **Step 3: Write `src/tui/panes/MessageView.tsx`**

```tsx
import type { MessageRow } from "../../core/cache/db.ts";
import type { Tokens } from "../theme/tokens.ts";

export interface MessageViewProps {
  messages: MessageRow[];
  cursor: number;
  focused: boolean;
  tokens: Tokens;
  senderName: (fromId: string | null) => string;
}

const GUTTER = 4;
const NAME_WIDTH = 8;

export function MessageView({ messages, cursor, focused, tokens, senderName }: MessageViewProps) {
  if (messages.length === 0) {
    return (
      <box flexDirection="column">
        <text fg={tokens.dim}>No messages</text>
      </box>
    );
  }

  return (
    <box flexDirection="column">
      {messages.map((m, i) => {
        const selected = i === cursor;
        // Hybrid numbering, as in relativenumber + number: the cursor row shows
        // its absolute index, every other row its distance from the cursor.
        const gutter = selected ? String(i + 1) : String(Math.abs(i - cursor));
        const marker = selected && focused ? "▸" : " ";
        const name = senderName(m.fromId).slice(0, NAME_WIDTH).padEnd(NAME_WIDTH);
        return (
          <text
            key={m.id}
            fg={m.out === 1 ? tokens.messageOwn : tokens.messageOther}
            bg={selected ? tokens.messageCursor : undefined}
          >
            {marker}
            <span fg={tokens.dim}>{gutter.padStart(GUTTER)} </span>
            <span fg={tokens.dim}>{name}</span>
            {" "}{m.text}
          </text>
        );
      })}
    </box>
  );
}
```

- [ ] **Step 4: Run the MessageView tests and watch them pass**

Run: `bun test src/tui/panes/MessageView.test.tsx`
Expected: PASS — 4 tests

- [ ] **Step 5: Write the failing Composer test**

`src/tui/panes/Composer.test.tsx`:

```tsx
import { test, expect } from "bun:test";
import { renderWithKeys } from "../../test/render.tsx";
import { tokensFor } from "../theme/tokens.ts";
import { Composer } from "./Composer.tsx";

const tokens = tokensFor("sage");

test("shows a hint in normal mode when empty", async () => {
  const t = await renderWithKeys(
    <Composer text="" mode="normal" focused={false} tokens={tokens} />,
    { width: 50, height: 3 },
  );
  await t.flush();
  expect(t.captureCharFrame()).toContain("press i to write");
});

test("shows the typed text in insert mode", async () => {
  const t = await renderWithKeys(
    <Composer text="on my way" mode="insert" focused tokens={tokens} />,
    { width: 50, height: 3 },
  );
  await t.flush();
  expect(t.captureCharFrame()).toContain("on my way");
});

test("shows a cursor block while in insert mode", async () => {
  const t = await renderWithKeys(
    <Composer text="hi" mode="insert" focused tokens={tokens} />,
    { width: 50, height: 3 },
  );
  await t.flush();
  expect(t.captureCharFrame()).toContain("█");
});

test("does not show the hint once text has been typed", async () => {
  const t = await renderWithKeys(
    <Composer text="hi" mode="normal" focused={false} tokens={tokens} />,
    { width: 50, height: 3 },
  );
  await t.flush();
  expect(t.captureCharFrame()).not.toContain("press i to write");
});

test("always shows the prompt marker", async () => {
  const t = await renderWithKeys(
    <Composer text="" mode="normal" focused={false} tokens={tokens} />,
    { width: 50, height: 3 },
  );
  await t.flush();
  expect(t.captureCharFrame()).toContain("❯");
});
```

- [ ] **Step 6: Run it and watch it fail**

Run: `bun test src/tui/panes/Composer.test.tsx`
Expected: FAIL — `Cannot find module './Composer.tsx'`

- [ ] **Step 7: Write `src/tui/panes/Composer.tsx`**

```tsx
import type { Mode } from "../../keys/types.ts";
import type { Tokens } from "../theme/tokens.ts";

export interface ComposerProps {
  text: string;
  mode: Mode;
  focused: boolean;
  tokens: Tokens;
}

export function Composer({ text, mode, focused, tokens }: ComposerProps) {
  const showHint = text === "" && mode !== "insert";
  const cursor = mode === "insert" && focused ? "█" : "";

  return (
    <box flexDirection="row" border borderColor={tokens.border}>
      <text fg={tokens.modeInsert}>{"❯ "}</text>
      {showHint
        ? <text fg={tokens.dim}>press i to write…</text>
        : <text fg={tokens.foreground}>{text}{cursor}</text>}
    </box>
  );
}
```

- [ ] **Step 8: Run the Composer tests and watch them pass**

Run: `bun test src/tui/panes/Composer.test.tsx`
Expected: PASS — 5 tests

- [ ] **Step 9: Commit**

```bash
git add src/tui/panes/MessageView.tsx src/tui/panes/MessageView.test.tsx src/tui/panes/Composer.tsx src/tui/panes/Composer.test.tsx
git commit -m "Add MessageView with relative numbering and Composer panes"
```

---

### Task 15: App — wire keys to state

This is where the three units meet. The test proves an end-to-end keystroke
path: a key press goes through the pure engine, produces an action, mutates the
store, and changes what is on screen.

**Files:**
- Create: `src/tui/App.tsx`, `src/tui/reducer.ts`
- Test: `src/tui/App.test.tsx`, `src/tui/reducer.test.ts`

**Interfaces:**
- Consumes: `resolve` from `keys/engine.ts`; `keymap`; `Store`; all four panes
- Produces:
  - `applyAction(state: AppState, action: Action): Partial<AppState>` in `reducer.ts`
  - `<App store dispatchSend tokens senderName />`

- [ ] **Step 1: Write the failing reducer test**

`src/tui/reducer.test.ts`:

```ts
import { test, expect } from "bun:test";
import { applyAction } from "./reducer.ts";
import { createStore } from "../core/store.ts";
import type { MessageRow } from "../core/cache/db.ts";

const messages: MessageRow[] = [1, 2, 3, 4].map((id) => ({
  peerId: "u1", id, fromId: "u1", date: id * 100, text: `m${id}`, out: 0,
}));

function stateWith(over: Partial<ReturnType<ReturnType<typeof createStore>["getState"]>> = {}) {
  const s = createStore();
  s.setState({ messages, ...over });
  return s.getState();
}

test("cursor.move advances the message cursor", () => {
  const next = applyAction(stateWith({ messageCursor: 0 }),
    { type: "cursor.move", unit: "message", delta: 1 });
  expect(next.messageCursor).toBe(1);
});

test("cursor.move honours a count", () => {
  const next = applyAction(stateWith({ messageCursor: 0 }),
    { type: "cursor.move", unit: "message", delta: 3 });
  expect(next.messageCursor).toBe(3);
});

test("the message cursor clamps at both ends", () => {
  expect(applyAction(stateWith({ messageCursor: 0 }),
    { type: "cursor.move", unit: "message", delta: -5 }).messageCursor).toBe(0);
  expect(applyAction(stateWith({ messageCursor: 3 }),
    { type: "cursor.move", unit: "message", delta: 9 }).messageCursor).toBe(3);
});

test("cursor.edge jumps to first and last", () => {
  expect(applyAction(stateWith({ messageCursor: 2 }),
    { type: "cursor.edge", unit: "message", edge: "first" }).messageCursor).toBe(0);
  expect(applyAction(stateWith({ messageCursor: 0 }),
    { type: "cursor.edge", unit: "message", edge: "last" }).messageCursor).toBe(3);
});

test("moving with no messages stays at zero", () => {
  const next = applyAction(stateWith({ messages: [], messageCursor: 0 }),
    { type: "cursor.move", unit: "message", delta: 1 });
  expect(next.messageCursor).toBe(0);
});

test("composer.insertText appends", () => {
  const next = applyAction(stateWith({ composerText: "on my " }),
    { type: "composer.insertText", text: "way" });
  expect(next.composerText).toBe("on my way");
});

test("composer.backspace removes the last character", () => {
  const next = applyAction(stateWith({ composerText: "hix" }),
    { type: "composer.backspace" });
  expect(next.composerText).toBe("hi");
});

test("backspace on empty text is harmless", () => {
  const next = applyAction(stateWith({ composerText: "" }), { type: "composer.backspace" });
  expect(next.composerText).toBe("");
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test src/tui/reducer.test.ts`
Expected: FAIL — `Cannot find module './reducer.ts'`

- [ ] **Step 3: Write `src/tui/reducer.ts`**

```ts
import type { Action } from "../keys/types.ts";
import type { AppState } from "../core/store.ts";

function clamp(value: number, max: number): number {
  if (max < 0) return 0;
  return Math.min(Math.max(value, 0), max);
}

/**
 * Turn one engine Action into a state patch. Pure and synchronous: actions with
 * side effects (sending, opening a chat) are handled by App, not here.
 */
export function applyAction(state: AppState, action: Action): Partial<AppState> {
  switch (action.type) {
    case "cursor.move": {
      if (action.unit === "message") {
        return { messageCursor: clamp(state.messageCursor + action.delta, state.messages.length - 1) };
      }
      return { chatCursor: clamp(state.chatCursor + action.delta, state.dialogs.length - 1) };
    }

    case "cursor.edge": {
      const last = (action.unit === "message" ? state.messages.length : state.dialogs.length) - 1;
      const target = action.edge === "first" ? 0 : clamp(last, last);
      return action.unit === "message" ? { messageCursor: target } : { chatCursor: target };
    }

    case "mode.set":
      return { engine: { ...state.engine, mode: action.mode } };

    case "focus.set":
      return { engine: { ...state.engine, context: action.context } };

    case "composer.insertText":
      return { composerText: state.composerText + action.text };

    case "composer.backspace":
      return { composerText: state.composerText.slice(0, -1) };

    // Handled by App because they need I/O.
    case "chat.open":
    case "composer.send":
    case "app.quit":
      return {};
  }
}
```

- [ ] **Step 4: Run the reducer tests and watch them pass**

Run: `bun test src/tui/reducer.test.ts`
Expected: PASS — 8 tests

- [ ] **Step 5: Write the failing App test**

`src/tui/App.test.tsx`:

```tsx
import { test, expect } from "bun:test";
import { act } from "react";
import { renderWithKeys } from "../test/render.tsx";
import { createStore } from "../core/store.ts";
import { tokensFor } from "./theme/tokens.ts";
import { App } from "./App.tsx";
import type { MessageRow, DialogRow } from "../core/cache/db.ts";

const tokens = tokensFor("sage");

const dialogs: DialogRow[] = [
  { peerId: "u1", title: "Alice", pinned: 0, unreadCount: 2, lastMessageAt: 300, topMessageId: 3 },
];
const messages: MessageRow[] = [1, 2, 3, 4].map((id) => ({
  peerId: "u1", id, fromId: "u1", date: id * 100, text: `msg${id}`, out: 0,
}));

async function mount() {
  const store = createStore();
  store.setState({ dialogs, messages, activePeerId: "u1", connection: "connected" });
  const sent: string[] = [];
  const t = await renderWithKeys(
    <App store={store} tokens={tokens} senderName={() => "Alice"}
         onSend={async (text) => { sent.push(text); }} onQuit={() => {}} />,
    { width: 70, height: 14 },
  );
  await t.flush();
  return { t, store, sent };
}

test("starts in NORMAL mode", async () => {
  const { t } = await mount();
  expect(t.captureCharFrame()).toContain("NORMAL");
});

test("j moves the message cursor, proving engine to store to render", async () => {
  const { t, store } = await mount();
  expect(store.getState().messageCursor).toBe(0);
  await act(async () => { t.mockInput.pressKey("j"); });
  await t.flush();
  expect(store.getState().messageCursor).toBe(1);
});

test("3j moves three messages", async () => {
  const { t, store } = await mount();
  await act(async () => {
    t.mockInput.pressKey("3");
    t.mockInput.pressKey("j");
  });
  await t.flush();
  expect(store.getState().messageCursor).toBe(3);
});

test("i enters INSERT and jk returns to NORMAL", async () => {
  const { t, store } = await mount();
  await act(async () => { t.mockInput.pressKey("i"); });
  await t.flush();
  expect(store.getState().engine.mode).toBe("insert");
  expect(t.captureCharFrame()).toContain("INSERT");

  await act(async () => {
    t.mockInput.pressKey("j");
    t.mockInput.pressKey("k");
  });
  await t.flush();
  expect(store.getState().engine.mode).toBe("normal");
});

test("typing in INSERT reaches the composer, and j does not move the cursor", async () => {
  const { t, store } = await mount();
  await act(async () => { t.mockInput.pressKey("i"); });
  await t.flush();
  await act(async () => { await t.mockInput.typeText("hey"); });
  await t.flush();
  expect(store.getState().composerText).toBe("hey");
  expect(store.getState().messageCursor).toBe(0);
});

test("Enter in INSERT sends the composed text", async () => {
  const { t, sent } = await mount();
  await act(async () => { t.mockInput.pressKey("i"); });
  await t.flush();
  await act(async () => { await t.mockInput.typeText("on my way"); });
  await t.flush();
  await act(async () => { t.mockInput.pressEnter(); });
  await t.flush();
  expect(sent).toEqual(["on my way"]);
});

test("the chat list and history are both on screen", async () => {
  const { t } = await mount();
  const frame = t.captureCharFrame();
  expect(frame).toContain("Alice");
  expect(frame).toContain("msg1");
});
```

- [ ] **Step 6: Run it and watch it fail**

Run: `bun test src/tui/App.test.tsx`
Expected: FAIL — `Cannot find module './App.tsx'`

- [ ] **Step 7: Write `src/tui/App.tsx`**

```tsx
import { useEffect, useState, useSyncExternalStore } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { resolve } from "../keys/engine.ts";
import { keymap } from "../keys/keymap.ts";
import { normalizeKeyEvent } from "../keys/normalize.ts";
import type { Store } from "../core/store.ts";
import type { Tokens } from "./theme/tokens.ts";
import { applyAction } from "./reducer.ts";
import { ChatList } from "./panes/ChatList.tsx";
import { MessageView } from "./panes/MessageView.tsx";
import { Composer } from "./panes/Composer.tsx";
import { StatusLine } from "./panes/StatusLine.tsx";

export interface AppProps {
  store: Store;
  tokens: Tokens;
  senderName: (fromId: string | null) => string;
  onSend: (text: string) => Promise<void>;
  onQuit: () => void;
  onOpenChat?: (peerId: string) => Promise<void>;
}

const SIDEBAR_WIDTH = 22;

export function App({ store, tokens, senderName, onSend, onQuit, onOpenChat }: AppProps) {
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const { width, height } = useTerminalDimensions();
  const [sidebarVisible] = useState(true);

  useKeyboard((event) => {
    const key = normalizeKeyEvent(event);
    const result = resolve(state.engine, key, keymap);

    // In insert mode an unmapped printable key is text, not a missing binding.
    if (result.status === "unmapped" && state.engine.mode === "insert") {
      if (event.sequence && event.sequence.length === 1 && !event.ctrl && !event.meta) {
        store.setState({ composerText: state.composerText + event.sequence });
      }
      return;
    }

    if (result.status !== "resolved") {
      store.setState({ engine: result.state });
      return;
    }

    let patch: Partial<typeof state> = { engine: result.state };
    for (const action of result.actions) {
      patch = { ...patch, ...applyAction({ ...state, ...patch }, action) };

      if (action.type === "composer.send") {
        const text = state.composerText;
        patch = { ...patch, composerText: "" };
        void onSend(text);
      }
      if (action.type === "chat.open") {
        const target = state.dialogs[state.chatCursor];
        if (target && onOpenChat) void onOpenChat(target.peerId);
      }
      if (action.type === "app.quit") onQuit();
    }

    // The engine owns mode and context; action patches must not override them.
    store.setState({ ...patch, engine: { ...result.state, ...(patch.engine ?? {}) } });
  });

  useEffect(() => {
    if (state.connection === "connected" && state.statusMessage === null) return;
  }, [state.connection, state.statusMessage]);

  const activeTitle =
    state.dialogs.find((d) => d.peerId === state.activePeerId)?.title ?? "no chat";
  const unread =
    state.dialogs.find((d) => d.peerId === state.activePeerId)?.unreadCount ?? 0;

  const bodyHeight = Math.max(1, height - 4);

  return (
    <box flexDirection="column" width={width} height={height} backgroundColor={tokens.background}>
      <box flexDirection="row" height={bodyHeight}>
        {sidebarVisible && (
          <box border borderColor={tokens.border} width={SIDEBAR_WIDTH}>
            <ChatList
              dialogs={state.dialogs}
              cursor={state.chatCursor}
              focused={state.engine.context === "chatlist"}
              tokens={tokens}
              width={SIDEBAR_WIDTH - 2}
            />
          </box>
        )}
        <box border borderColor={tokens.border} flexGrow={1}>
          <MessageView
            messages={state.messages}
            cursor={state.messageCursor}
            focused={state.engine.context === "messages"}
            tokens={tokens}
            senderName={senderName}
          />
        </box>
      </box>

      <Composer
        text={state.composerText}
        mode={state.engine.mode}
        focused={state.engine.context === "composer"}
        tokens={tokens}
      />

      <StatusLine
        mode={state.engine.mode}
        title={state.statusMessage ?? activeTitle}
        unreadCount={unread}
        position={state.messages.length === 0 ? 0 : state.messageCursor + 1}
        total={state.messages.length}
        hint="\\ for keys"
        tokens={tokens}
      />
    </box>
  );
}
```

- [ ] **Step 8: Run the App tests and watch them pass**

Run: `bun test src/tui/App.test.tsx`
Expected: PASS — 7 tests

If "typing in INSERT" fails, the cause is the unmapped-printable branch: confirm
`event.sequence` is the single character and that `j`/`k` reach the `jk` binding
as a pending prefix before that branch is consulted.

- [ ] **Step 9: Run the whole suite**

```bash
bun test
bun run typecheck
```

Expected: all green, including the boundary tests — `tui/` imports no `telegram`.

- [ ] **Step 10: Commit**

```bash
git add src/tui/App.tsx src/tui/App.test.tsx src/tui/reducer.ts src/tui/reducer.test.ts
git commit -m "Wire vim engine to store and panes in App"
```

---

### Task 16: Entry point and live smoke test

**Files:**
- Create: `src/main.ts`, `src/core/telegram-api.ts`, `README.md`

**Interfaces:**
- Consumes: everything above
- Produces: a runnable `bun run src/main.ts`

`telegram-api.ts` is the only file that translates GramJS objects into the
`RawDialog`/`RawMessage` shapes the core already knows. Keeping the translation
in one place is what let Tasks 11 and 15 be tested without a network.

- [ ] **Step 1: Write `src/core/telegram-api.ts`**

```ts
import type { TelegramClient } from "telegram";
import { Api } from "telegram";
import type { DialogApi, RawDialog } from "./dialogs.ts";
import type { MessageApi, RawMessage } from "./messages.ts";

function peerIdOf(entity: { id: unknown }): string {
  return String(entity.id);
}

export function createDialogApi(client: TelegramClient): DialogApi {
  return {
    async fetchDialogs(): Promise<RawDialog[]> {
      const dialogs = await client.getDialogs({ limit: 100 });
      return dialogs.map((d) => {
        const entity = d.entity as { id: unknown; accessHash?: unknown; className: string };
        const type =
          entity.className === "Channel" ? "channel"
          : entity.className === "Chat" ? "chat"
          : "user";
        return {
          peerId: peerIdOf(entity),
          type,
          accessHash: entity.accessHash != null ? String(entity.accessHash) : null,
          title: d.title ?? d.name ?? "(no title)",
          username: null,
          pinned: d.pinned ? 1 : 0,
          unreadCount: d.unreadCount ?? 0,
          lastMessageAt: d.message?.date ?? 0,
          topMessageId: d.message?.id ?? 0,
        };
      });
    },
  };
}

export function createMessageApi(client: TelegramClient): MessageApi {
  return {
    async fetchHistory(peerId: string, limit: number): Promise<RawMessage[]> {
      const messages = await client.getMessages(peerId, { limit });
      return messages
        .filter((m) => m.className === "Message")
        .map((m) => ({
          id: m.id,
          peerId,
          fromId: m.out ? "me" : peerId,
          date: m.date,
          text: m.message ?? "",
          out: m.out ? 1 : 0,
        }));
    },

    async send(peerId: string, text: string): Promise<RawMessage> {
      const sent = await client.sendMessage(peerId, { message: text });
      return {
        id: sent.id,
        peerId,
        fromId: "me",
        date: sent.date,
        text,
        out: 1,
      };
    },
  };
}

export { Api };
```

- [ ] **Step 2: Write `src/main.ts`**

```ts
import { createRoot } from "@opentui/react";
import { createCliRenderer } from "@opentui/core";
import { AppContext } from "@opentui/react";
import { createElement } from "react";
import { loadConfig, ConfigError } from "./core/config.ts";
import { createClient, persistSession } from "./core/client.ts";
import { openDb } from "./core/cache/db.ts";
import { createStore } from "./core/store.ts";
import { syncDialogs } from "./core/dialogs.ts";
import { loadHistory, sendMessage } from "./core/messages.ts";
import { createDialogApi, createMessageApi } from "./core/telegram-api.ts";
import { tokensFor } from "./tui/theme/tokens.ts";
import { App } from "./tui/App.tsx";

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }

  const client = createClient(config);
  const db = openDb(config.cachePath);
  const store = createStore();

  store.setState({ connection: "connecting" });
  await client.connect();

  if (!(await client.isUserAuthorized())) {
    process.stderr.write(
      "Not logged in.\n\n" +
      "M1a does not yet include the interactive login UI (that lands with the\n" +
      "auth panes in plan M1b). For now, authorise once with GramJS's prompt:\n\n" +
      "  bun run scripts/login.ts\n",
    );
    process.exit(1);
  }

  persistSession(client, config);
  store.setState({ connection: "connected" });

  const dialogApi = createDialogApi(client);
  const messageApi = createMessageApi(client);
  const deps = { db, store, api: messageApi };

  await syncDialogs({ api: dialogApi, db, store });

  const first = store.getState().dialogs[0];
  if (first) await loadHistory(deps, first.peerId, 200);

  const renderer = await createCliRenderer({});
  const root = createRoot(renderer);

  const quit = () => {
    renderer.destroy();
    db.close();
    void client.destroy();
    process.exit(0);
  };

  root.render(
    createElement(
      AppContext.Provider,
      { value: { keyHandler: renderer.keyInput, renderer } },
      createElement(App, {
        store,
        tokens: tokensFor(config.palette),
        senderName: (fromId: string | null) => (fromId === "me" ? "me" : first?.title ?? "them"),
        onSend: async (text: string) => {
          const peerId = store.getState().activePeerId;
          if (peerId) await sendMessage(deps, peerId, text);
        },
        onQuit: quit,
        onOpenChat: async (peerId: string) => { await loadHistory(deps, peerId, 200); },
      }),
    ),
  );
}

await main();
```

- [ ] **Step 3: Write the one-time login script**

`scripts/login.ts`:

```ts
import { loadConfig } from "../src/core/config.ts";
import { createClient, persistSession } from "../src/core/client.ts";

const config = loadConfig();
const client = createClient(config);

await client.start({
  phoneNumber: async () => prompt("Phone number (with country code): ") ?? "",
  password: async () => prompt("Two-factor password: ") ?? "",
  phoneCode: async () => prompt("Code you just received: ") ?? "",
  onError: (err) => { console.error(err.message); },
});

persistSession(client, config);
console.log("Logged in. Session saved to", config.sessionPath);
await client.destroy();
```

- [ ] **Step 4: Write `README.md`**

```markdown
# tglow

A vim-native Telegram client for the terminal, themed with devglow.

## Setup

1. Get `api_id` and `api_hash` from <https://my.telegram.org> (log in, then
   "API development tools"). This cannot be automated — it needs your account.

2. Write them to `~/.config/tglow/config.toml`:

   ```toml
   api_id = 1234567
   api_hash = "your-hash-here"
   palette = "sage"
   ```

3. Log in once:

   ```sh
   bun run scripts/login.ts
   ```

4. Run it:

   ```sh
   bun start
   ```

## Keys

Leader is `\`. The app starts in NORMAL mode — nothing you type is sent by
accident.

| Key | Action |
| --- | --- |
| `j` / `k` | next / previous message |
| `3j` | down three messages |
| `gg` / `G` | oldest loaded / newest |
| `<C-d>` / `<C-u>` | half page down / up |
| `nf` | focus the chat list |
| `Enter` (chat list) | open the chat |
| `i` / `a` | write a message |
| `jk` or `Esc` | leave insert mode |
| `Enter` (insert) | send |
| `<C-c>` | quit |

## Security

The session file at `~/.local/share/tglow/session` is equivalent to a logged-in
device on your account. It is written mode `0600` and is git-ignored. Never
share it.

Third-party MTProto clients can attract account restrictions if they behave
abnormally. tglow honours `FLOOD_WAIT`, does not poll aggressively, and reports
a truthful device model.

## Development

```sh
bun test          # all tests; no network or account needed
bun run typecheck
```

See `docs/superpowers/specs/` for the design and `docs/superpowers/plans/` for
implementation plans.
```

- [ ] **Step 5: Typecheck and run the full suite**

```bash
bun install
bun run typecheck
bun test
```

Expected: typecheck clean, all tests pass. Fix any type errors before going on —
`main.ts` and `telegram-api.ts` are the only files not covered by tests, so the
compiler is the only check they get.

- [ ] **Step 6: Manual smoke test — the one thing tests cannot cover**

This needs a real account and network. Everything up to here passed without either.

```bash
bun run scripts/login.ts   # once, interactive
bun start
```

Verify, in order:

1. The chat list appears on the left, devglow-coloured.
2. The most recent chat's history appears on the right.
3. `j` and `k` move the cursor; the gutter shows relative numbers.
4. `3j` jumps three messages.
5. `nf` then `j`/`k` then `Enter` opens a different chat.
6. `i` switches the status bar to `INSERT`; typing appears in the composer.
7. `Enter` sends — the message appears in the history and on your phone.
8. `jk` returns to `NORMAL`.
9. `<C-c>` exits cleanly with the terminal restored.

If the terminal is left in a broken state after exit, `renderer.destroy()` is
not being reached on the quit path — fix that before committing.

- [ ] **Step 7: Commit**

```bash
git add src/main.ts src/core/telegram-api.ts scripts/login.ts README.md
git commit -m "Add entry point, GramJS adapters and setup documentation"
```

---

## Self-Review

Checked after writing, against the spec.

**Spec coverage for M1a's slice.** Config §8 → Task 7. Session at 0600 §8 →
Task 8. SQLite schema §7 → Task 6. Store §3 → Task 9. Auth state machine §8 →
Task 10. Dialog list §11 → Task 11. History paging §7 → Task 11. Send §11 →
Task 11. devglow palettes and tokens §6 → Task 12. Relative message numbers §6 →
Task 14. Status bar §6 → Task 13. Vim modes, counts, prefixes §4 → Tasks 3–5.
Dependency rule §3 → Task 2's boundary tests. Error handling §9 (offline
fallback, failed send keeps text, FLOOD_WAIT surfaced) → Task 11.

**Deliberately deferred to plan M1b**, and not silently dropped:

- Operators (`d`/`y`/`c`), registers, `.` repeat, `;`/`,` — Task 4 builds the
  state fields (`pending`, `count`) that these extend.
- Reply, edit, delete; rich text entities; `pts` gap recovery; mark-as-read and
  read receipts; `/` search; `<C-p>` picker; which-key popup; `:` command line.
- The interactive login UI. M1a uses `scripts/login.ts` once, which is why
  `main.ts` exits with instructions rather than prompting. `createAuthMachine`
  is already built and tested in Task 10 so the UI has something to drive.
- The remaining ten devglow palettes (structure proven with two).

**Placeholder scan.** No TBD/TODO. Every code step has runnable code. Task 6
Step 5 is a genuine refactor step, not a placeholder — it replaces a working but
awkward construct with a clean one.

**Type consistency.** `DialogRow`/`MessageRow` are defined once in Task 6 and
used unchanged in Tasks 9, 11, 13, 14, 15. `Action` is defined in Task 1 and
every variant is handled in Task 15's `applyAction` switch. `EngineState` fields
(`mode`, `context`, `pending`, `count`) are set in Task 1 and read in Tasks 4, 5,
15. `Tokens` is defined in Task 12 and consumed by all four panes.
`renderWithKeys` from Task 2 is used by Tasks 13, 14, 15.

**One risk worth naming.** Task 15's App test is the first place the pure
engine, the store and OpenTUI all run together. If any single task is going to
uncover a wrong assumption, it is that one — which is exactly why the plan is a
vertical slice rather than three horizontal layers.
