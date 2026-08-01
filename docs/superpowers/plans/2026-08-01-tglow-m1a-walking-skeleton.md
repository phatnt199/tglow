# tglow M1a — Walking Skeleton Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Log in to Telegram with a phone number, browse the chat list with `j`/`k`, read message history, send a message — in a devglow-themed terminal UI built to the IGNIS Code Style Standard.

**Architecture:** Three units wired through the IGNIS DI container. `keys/` is deterministic (no Telegram, no React, no I/O). `core/` wraps GramJS and `bun:sqlite` and never imports React. `tui/` renders with OpenTUI React and never imports `telegram`. Actions flow down, state flows up.

**Tech Stack:** Bun 1.3 · TypeScript 7.0.2 · `@venizia/ignis-inversion` 0.1.1-6 · `@venizia/ignis-helpers` 0.1.1-14 · `@opentui/react` 0.4.5 · React 19.2.8 · `telegram` 2.26.22 · `bun:sqlite`

First of two plans for milestone M1 of `docs/superpowers/specs/2026-08-01-tglow-m1-design.md`. Built as a vertical slice so integration risk surfaces early. Plan M1b adds operators/registers/`.` repeat, reply/edit/delete, entity rendering, `pts` gap recovery, and the overlays.

## Global Constraints

**Read `docs/superpowers/conventions/ignis-style.md` before writing any code.** It is binding on every file and carries the verified IGNIS API. The rules below are the ones most often broken; the document is the full set.

- **Runtime:** Bun ≥ 1.3. Never `npm`/`node`. Tests run with `bun test`.
- **Exact versions** — highest published, verified working together. Do **not** downgrade `@venizia/*` to `0.1.0`: its helpers cannot be imported without `hono`.
  - `typescript` `7.0.2` · `@venizia/ignis-inversion` `0.1.1-6` · `@venizia/ignis-helpers` `0.1.1-14` · `@opentui/core` and `@opentui/react` `0.4.5` · `react` `19.2.8` · `@types/react` `19.2.18` · `telegram` `2.26.22` · `reflect-metadata` `0.2.2`
- **`experimentalDecorators` and `emitDecoratorMetadata` must be inline in `tsconfig.json`.** Bun does not resolve them through `extends`; without them `@inject` is silently dropped and dependencies arrive `undefined` with no error.
- **`@injectable` does not exist in `0.1.1-6`.** Set scope on the binding: `.setScope(BindingScopes.SINGLETON)`. Only `@inject({ key })` remains.
- **IGNIS style, non-negotiable:** `I` prefix on interfaces, `T` on type aliases, kebab-case filenames, arrow functions only (never `function`), named exports only, explicit return types, options object named `opts`, `static readonly` constant classes (never `enum`), barrel `index.ts` at every folder level, `_` prefix on private fields, **never abbreviate** (`database` not `db`, `configuration` not `cfg`, `message` not `msg`).
- **Errors:** never `new Error`. Always `getError({ message: '[ClassName][method] …' })`.
- **Catch blocks are never silent.** Every one logs through `this._logger.for(…)` first.
- **Control flow:** always braces; early return over nesting; `switch` needs braces per case and a `default` that throws via `getError`.
- **The logger must never write to stdout** — it would corrupt the alternate screen. `main.ts` registers a file-writing provider before anything can log.
- **Dependency rule, enforced by Task 2's boundary test:** `keys/` imports only `@venizia/ignis-inversion` and relative paths. `core/` never imports `react` or `@opentui/*`. `tui/` never imports `telegram`.
- **No network in tests.** Every test passes with no internet and no Telegram account. Live connection is exercised only by the manual smoke test in Task 16.
- **Commit after every task.**

## Verified API facts

Confirmed by running code on this machine — see `docs/superpowers/probes/`. Do not re-derive.

- `new Container({ scope })`; `container.bind({ key }).toClass(Cls).setScope(BindingScopes.SINGLETON)`; `container.get<T>({ key })`. Every method takes an options object.
- `ApplicationLogger.get(scope)` takes a **bare string**. An options object yields a logger scoped `"[object Object]"` with no error.
- `ILoggerProvider` is exactly `{ get(scope: string): ILogger }`.
- `ILogger` is `debug | info | warn | error | emerg | log(level, …) | for(methodName)`.
- OpenTUI `KeyEvent` reports Alt as `option` or `meta`, **never `alt`**.
- **`testRender` from `@opentui/react/test-utils` does not work for keyboard tests.** It renders with no `AppContext` provider, so `useAppContext().keyHandler` is null and `useKeyboard` no-ops behind its `?.` guard — tests pass while asserting on a UI that received nothing. Task 2 builds the working replacement.
- `renderer.keyInput` is the `KeyHandler` to supply to `AppContext`.
- JSX intrinsics: `box`, `text`, `span`, `scrollbox`, `input`, `textarea`, `select`, `b`, `i`, `u`, `a`, `br`, `code`.
- GramJS: `TelegramClient`, `Api` from `telegram`; `StringSession` from `telegram/sessions`; `Logger` from `telegram/extensions/Logger`.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/common/binding-keys.ts` | `BindingKeys` static-readonly class — every DI key |
| `src/keys/common/constants.ts` | `VimModes`, `VimContexts`, `ActionTypes` |
| `src/keys/common/types.ts` | `IKey`, `IEngineState`, `TAction`, `IKeyBinding` |
| `src/keys/key-normalizer.ts` | `KeyNormalizerService` — terminal event → canonical key |
| `src/keys/vim-engine.ts` | `VimEngineService` — the deterministic reducer |
| `src/keys/keymap.ts` | `KeymapService` — the binding table |
| `src/core/configuration.ts` | `ConfigurationService` |
| `src/core/session-store.ts` | `SessionStoreService` — 0600 session file |
| `src/core/logger-provider.ts` | `buildFileLoggerProvider` — keeps logs off stdout |
| `src/core/cache/schema.sql` | Table definitions |
| `src/core/cache/database.ts` | `DatabaseService` |
| `src/core/application-store.ts` | `ApplicationStoreService` |
| `src/core/telegram-client.ts` | `TelegramClientService` |
| `src/core/authentication.ts` | `AuthenticationService` |
| `src/core/dialog-service.ts` | `DialogService` |
| `src/core/message-service.ts` | `MessageService` |
| `src/core/telegram-adapter.ts` | GramJS → domain shapes (only file that knows GramJS types) |
| `src/tui/theme/palettes.ts` | devglow palettes |
| `src/tui/theme/tokens.ts` | Semantic tokens |
| `src/tui/panes/*.tsx` | `status-line`, `chat-list`, `message-view`, `composer` |
| `src/tui/action-reducer.ts` | `applyAction` |
| `src/tui/app.tsx` | Layout + key dispatch |
| `src/test/render.tsx` | Working test renderer |
| `src/container.ts` | `buildContainer` |
| `src/main.ts` | Entry point |

---

### Task 1: Scaffold, container and binding keys

**Files:**
- Create: `package.json`, `tsconfig.json`, `src/common/binding-keys.ts`, `src/common/index.ts`
- Test: `src/common/binding-keys.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `BindingKeys` — the single source of every DI key, used by every later task.

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
    "@venizia/ignis-helpers": "0.1.1-14",
    "@venizia/ignis-inversion": "0.1.1-6",
    "react": "19.2.8",
    "reflect-metadata": "0.2.2",
    "telegram": "2.26.22"
  },
  "devDependencies": {
    "@types/bun": "^1.3.14",
    "@types/react": "19.2.18",
    "typescript": "7.0.2"
  }
}
```

Write this file by hand. Do **not** run `bun init` — it scaffolds a
`peerDependencies.typescript` entry that silently prevents the pinned
TypeScript from installing.

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "lib": ["ESNext"],
    "target": "ESNext",
    "module": "Preserve",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "jsxImportSource": "@opentui/react",
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "allowSyntheticDefaultImports": true,
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["bun-types", "react"]
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Install and confirm the pinned versions took**

```bash
bun install
grep -m1 '"version"' node_modules/typescript/package.json
grep -m1 '"version"' node_modules/@venizia/ignis-inversion/package.json
```

Expected: `7.0.2` and `0.1.1-6`. If TypeScript is 5.x, a stray
`peerDependencies` entry is overriding the pin — remove it and reinstall.

- [ ] **Step 4: Write the failing test**

`src/common/binding-keys.test.ts`:

```ts
import { test, expect } from 'bun:test';

import { BindingKeys } from './binding-keys.ts';

test('every binding key uses the @tglow namespace', () => {
  const values = Object.values(BindingKeys) as string[];
  expect(values.length).toBeGreaterThan(0);
  for (const value of values) {
    expect(value).toMatch(/^@tglow\/[a-z-]+\/[a-z-]+$/);
  }
});

test('binding keys are unique', () => {
  const values = Object.values(BindingKeys) as string[];
  expect(new Set(values).size).toBe(values.length);
});
```

- [ ] **Step 5: Run it and watch it fail**

Run: `bun test src/common/binding-keys.test.ts`
Expected: FAIL — `Cannot find module './binding-keys.ts'`

- [ ] **Step 6: Write `src/common/binding-keys.ts`**

A static-readonly class, not an enum — enums are not tree-shakable.

```ts
/** Every dependency-injection key in the application. Format: `@tglow/[component]/[feature]`. */
export class BindingKeys {
  static readonly CONFIGURATION = '@tglow/core/configuration';
  static readonly LOGGER_PROVIDER = '@tglow/core/logger-provider';
  static readonly SESSION_STORE = '@tglow/core/session-store';
  static readonly DATABASE = '@tglow/core/database';
  static readonly APPLICATION_STORE = '@tglow/core/application-store';
  static readonly TELEGRAM_CLIENT = '@tglow/core/telegram-client';
  static readonly AUTHENTICATION = '@tglow/core/authentication';
  static readonly DIALOG_SERVICE = '@tglow/core/dialog-service';
  static readonly MESSAGE_SERVICE = '@tglow/core/message-service';
  static readonly DIALOG_ADAPTER = '@tglow/core/dialog-adapter';
  static readonly MESSAGE_ADAPTER = '@tglow/core/message-adapter';

  static readonly KEY_NORMALIZER = '@tglow/keys/key-normalizer';
  static readonly VIM_ENGINE = '@tglow/keys/vim-engine';
  static readonly KEYMAP = '@tglow/keys/keymap';
}
```

- [ ] **Step 7: Write `src/common/index.ts`**

```ts
export * from './binding-keys.ts';
```

- [ ] **Step 8: Run the tests and typecheck**

```bash
bun test src/common/binding-keys.test.ts
bun run typecheck
```

Expected: 2 tests PASS, typecheck clean.

- [ ] **Step 9: Commit**

```bash
git add package.json tsconfig.json bun.lock src/common/
git commit -m "Add project scaffold and IGNIS binding keys"
```

---

### Task 2: Working TUI test harness and boundary tests

The documented OpenTUI harness silently swallows keyboard input. Every later TUI
task depends on this being right, so it is built and proven first.

**Files:**
- Create: `src/test/render.tsx`
- Test: `src/test/render.test.tsx`, `src/test/boundaries.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `renderWithKeys(node, opts: { width, height }): Promise<TestRendererSetup>` — used by Tasks 13–15.

- [ ] **Step 1: Write the failing test**

`src/test/render.test.tsx`:

```tsx
import { test, expect } from 'bun:test';
import { act, useState } from 'react';

import { useKeyboard } from '@opentui/react';

import { renderWithKeys } from './render.tsx';

const KeyProbe = () => {
  const [seen, setSeen] = useState<string[]>([]);
  useKeyboard(key => setSeen(current => [...current, key.name]));
  return <text>seen:{seen.join(',') || 'none'}</text>;
};

test('keyboard events reach useKeyboard', async () => {
  const renderer = await renderWithKeys(<KeyProbe />, { width: 40, height: 3 });
  await renderer.flush();
  expect(renderer.captureCharFrame()).toContain('seen:none');

  await act(async () => {
    renderer.mockInput.pressKey('j');
  });
  await renderer.flush();
  expect(renderer.captureCharFrame()).toContain('seen:j');

  await act(async () => {
    renderer.mockInput.pressKey('k');
  });
  await renderer.flush();
  expect(renderer.captureCharFrame()).toContain('seen:j,k');
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test src/test/render.test.tsx`
Expected: FAIL — `Cannot find module './render.tsx'`

- [ ] **Step 3: Write `src/test/render.tsx`**

```tsx
import { act, type ReactNode } from 'react';

import { AppContext, createRoot } from '@opentui/react';
import { createTestRenderer, type TestRendererSetup } from '@opentui/core/testing';

/**
 * Render a component tree for testing with keyboard input actually connected.
 *
 * Do not replace this with `testRender` from `@opentui/react/test-utils`: that
 * helper renders without an AppContext provider, so `useAppContext().keyHandler`
 * is null and `useKeyboard` no-ops behind its optional-chaining guard. Tests
 * then pass while asserting on a UI that never received a key.
 *
 * Driving `createTestRenderer` directly means the renderer exists before the
 * first render, so `renderer.keyInput` can be supplied as the key handler.
 */
export const renderWithKeys = async (
  node: ReactNode,
  opts: { width: number; height: number },
): Promise<TestRendererSetup> => {
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
};
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `bun test src/test/render.test.tsx`
Expected: PASS — 1 test, 3 assertions

- [ ] **Step 5: Write the dependency boundary test**

`src/test/boundaries.test.ts`:

```ts
import { test, expect } from 'bun:test';

import { Glob } from 'bun';

interface IImportRecord {
  file: string;
  specifier: string;
}

const collectImports = async (directory: string): Promise<IImportRecord[]> => {
  const records: IImportRecord[] = [];
  const glob = new Glob('**/*.{ts,tsx}');

  for await (const file of glob.scan({ cwd: directory, absolute: true })) {
    if (file.includes('.test.')) {
      continue;
    }
    const source = await Bun.file(file).text();
    const pattern = /^\s*(?:import|export)[^'"]*from\s+["']([^"']+)["']/gm;
    for (const match of source.matchAll(pattern)) {
      records.push({ file, specifier: match[1]! });
    }
  }

  return records;
};

test('keys/ imports only ignis-inversion and relative paths', async () => {
  const offenders = (await collectImports('src/keys')).filter(record => {
    if (record.specifier.startsWith('.')) {
      return false;
    }
    return record.specifier !== '@venizia/ignis-inversion';
  });
  expect(offenders).toEqual([]);
});

test('core/ never imports React or OpenTUI', async () => {
  const offenders = (await collectImports('src/core')).filter(
    record => record.specifier === 'react' || record.specifier.startsWith('@opentui/'),
  );
  expect(offenders).toEqual([]);
});

test('tui/ never imports telegram', async () => {
  const offenders = (await collectImports('src/tui')).filter(record =>
    record.specifier.startsWith('telegram'),
  );
  expect(offenders).toEqual([]);
});
```

- [ ] **Step 6: Create the scanned directories and run**

```bash
mkdir -p src/core src/tui src/keys
bun test src/test/
```

Expected: PASS — 4 tests. The boundary tests are trivially true while the
directories are empty and become meaningful as they fill.

- [ ] **Step 7: Commit**

```bash
git add src/test/
git commit -m "Add working TUI test harness and dependency boundary tests

The documented testRender helper renders without an AppContext provider,
so useKeyboard never receives events and keyboard tests pass while
asserting on a UI that got no input."
```

---

### Task 3: Vim constants and types

**Files:**
- Create: `src/keys/common/constants.ts`, `src/keys/common/types.ts`, `src/keys/common/index.ts`
- Test: `src/keys/common/constants.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `VimModes`, `VimContexts`, `ActionTypes`, `TVimMode`, `TVimContext`, `TAction`, `IKey`, `IEngineState`, `IKeyBinding`, `INITIAL_ENGINE_STATE` — used by Tasks 4–6 and 14–15.

- [ ] **Step 1: Write the failing test**

`src/keys/common/constants.test.ts`:

```ts
import { test, expect } from 'bun:test';

import { VimModes, VimContexts, ActionTypes, isVimMode } from './constants.ts';

test('VimModes exposes every supported mode', () => {
  expect(VimModes.NORMAL).toBe('normal');
  expect(VimModes.INSERT).toBe('insert');
  expect(VimModes.VISUAL).toBe('visual');
  expect(VimModes.COMMAND).toBe('command');
  expect(VimModes.SEARCH).toBe('search');
});

test('VimContexts exposes every pane', () => {
  expect(VimContexts.CHAT_LIST).toBe('chatlist');
  expect(VimContexts.MESSAGES).toBe('messages');
  expect(VimContexts.COMPOSER).toBe('composer');
});

test('ActionTypes values are unique', () => {
  const values = Object.values(ActionTypes) as string[];
  expect(new Set(values).size).toBe(values.length);
});

test('isVimMode accepts supported modes and rejects others', () => {
  expect(isVimMode('normal')).toBe(true);
  expect(isVimMode('visual')).toBe(true);
  expect(isVimMode('replace')).toBe(false);
  expect(isVimMode('')).toBe(false);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test src/keys/common/constants.test.ts`
Expected: FAIL — `Cannot find module './constants.ts'`

- [ ] **Step 3: Write `src/keys/common/constants.ts`**

```ts
/** Vim modes. A static-readonly class rather than an enum — enums are not tree-shakable. */
export class VimModes {
  static readonly NORMAL = 'normal';
  static readonly INSERT = 'insert';
  static readonly VISUAL = 'visual';
  static readonly COMMAND = 'command';
  static readonly SEARCH = 'search';
}

export type TVimMode = (typeof VimModes)[Exclude<keyof typeof VimModes, 'prototype'>];

/** Which pane currently owns the cursor. */
export class VimContexts {
  static readonly CHAT_LIST = 'chatlist';
  static readonly MESSAGES = 'messages';
  static readonly COMPOSER = 'composer';
}

export type TVimContext = (typeof VimContexts)[Exclude<keyof typeof VimContexts, 'prototype'>];

export class ActionTypes {
  static readonly CURSOR_MOVE = 'cursor.move';
  static readonly CURSOR_EDGE = 'cursor.edge';
  static readonly MODE_SET = 'mode.set';
  static readonly FOCUS_SET = 'focus.set';
  static readonly CHAT_OPEN = 'chat.open';
  static readonly COMPOSER_SEND = 'composer.send';
  static readonly COMPOSER_INSERT_TEXT = 'composer.insertText';
  static readonly COMPOSER_BACKSPACE = 'composer.backspace';
  static readonly APPLICATION_QUIT = 'application.quit';
}

const SUPPORTED_MODES: readonly string[] = [
  VimModes.NORMAL,
  VimModes.INSERT,
  VimModes.VISUAL,
  VimModes.COMMAND,
  VimModes.SEARCH,
];

export const isVimMode = (value: string): value is TVimMode => {
  return SUPPORTED_MODES.includes(value);
};
```

- [ ] **Step 4: Write `src/keys/common/types.ts`**

```ts
import type { ActionTypes, TVimContext, TVimMode } from './constants.ts';

/** A key press, normalised away from any specific terminal library. */
export interface IKey {
  name: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

/** The shape OpenTUI's KeyEvent gives us, declared structurally so keys/ stays free of OpenTUI. */
export interface IRawKeyEvent {
  name: string;
  ctrl: boolean;
  meta: boolean;
  option: boolean;
  shift: boolean;
}

export type TCursorUnit = 'message' | 'chat';
export type TCursorEdge = 'first' | 'last';

export type TAction =
  | { type: typeof ActionTypes.CURSOR_MOVE; unit: TCursorUnit; delta: number }
  | { type: typeof ActionTypes.CURSOR_EDGE; unit: TCursorUnit; edge: TCursorEdge }
  | { type: typeof ActionTypes.MODE_SET; mode: TVimMode }
  | { type: typeof ActionTypes.FOCUS_SET; context: TVimContext }
  | { type: typeof ActionTypes.CHAT_OPEN }
  | { type: typeof ActionTypes.COMPOSER_SEND }
  | { type: typeof ActionTypes.COMPOSER_INSERT_TEXT; text: string }
  | { type: typeof ActionTypes.COMPOSER_BACKSPACE }
  | { type: typeof ActionTypes.APPLICATION_QUIT };

export interface IEngineState {
  mode: TVimMode;
  context: TVimContext;
  /** Canonical key strings accumulated toward a multi-key binding, for example "g". */
  pending: string;
  /** The 3 in 3j. Null when no count has been typed. */
  count: number | null;
}

export interface IKeyBinding {
  context: TVimContext | '*';
  mode: TVimMode | TVimMode[];
  /** Canonical form: "j", "gg", "<C-p>". */
  keys: string;
  /** Count-aware so 3j yields a single delta-3 action. */
  action: (count: number) => TAction[];
  /** Shown in the which-key popup; every binding must have one. */
  description: string;
}

export type TResolveStatus = 'pending' | 'resolved' | 'unmapped';

export interface IResolveResult {
  state: IEngineState;
  actions: TAction[];
  status: TResolveStatus;
}
```

- [ ] **Step 5: Write `src/keys/common/index.ts`**

```ts
export * from './constants.ts';
export * from './types.ts';
```

- [ ] **Step 6: Add `INITIAL_ENGINE_STATE` to `constants.ts`**

Append to `src/keys/common/constants.ts`:

```ts
import type { IEngineState } from './types.ts';

export const INITIAL_ENGINE_STATE: IEngineState = {
  mode: VimModes.NORMAL,
  context: VimContexts.MESSAGES,
  pending: '',
  count: null,
};
```

- [ ] **Step 7: Run the tests and typecheck**

```bash
bun test src/keys/common/constants.test.ts
bun run typecheck
```

Expected: 4 tests PASS, typecheck clean.

- [ ] **Step 8: Commit**

```bash
git add src/keys/common/
git commit -m "Add vim constants and types"
```

---

### Task 4: Key normalizer service

**Files:**
- Create: `src/keys/key-normalizer.ts`
- Test: `src/keys/key-normalizer.test.ts`

**Interfaces:**
- Consumes: `IKey`, `IRawKeyEvent` from `keys/common`
- Produces: `KeyNormalizerService` with `normalize(opts: { event: IRawKeyEvent }): IKey` and `toCanonicalString(opts: { key: IKey }): string`

- [ ] **Step 1: Write the failing test**

`src/keys/key-normalizer.test.ts`:

```ts
import { test, expect } from 'bun:test';

import { KeyNormalizerService } from './key-normalizer.ts';

const service = new KeyNormalizerService();

test('plain keys stringify to their name', () => {
  expect(service.toCanonicalString({ key: { name: 'j', ctrl: false, alt: false, shift: false } })).toBe('j');
  expect(service.toCanonicalString({ key: { name: 'escape', ctrl: false, alt: false, shift: false } })).toBe('escape');
});

test('modifiers use vim notation', () => {
  expect(service.toCanonicalString({ key: { name: 'p', ctrl: true, alt: false, shift: false } })).toBe('<C-p>');
  expect(service.toCanonicalString({ key: { name: 'j', ctrl: false, alt: true, shift: false } })).toBe('<A-j>');
  expect(service.toCanonicalString({ key: { name: 'u', ctrl: false, alt: false, shift: true } })).toBe('<S-u>');
});

test('modifier order is fixed so a binding matches exactly one key', () => {
  expect(service.toCanonicalString({ key: { name: 'd', ctrl: true, alt: true, shift: false } })).toBe('<C-A-d>');
});

test('shift is not notated on named keys, only single characters', () => {
  expect(service.toCanonicalString({ key: { name: 'escape', ctrl: false, alt: false, shift: true } })).toBe('escape');
});

// OpenTUI reports Alt as `option` or `meta`, never `alt`.
test('normalize folds option and meta onto alt', () => {
  const fromOption = service.normalize({ event: { name: 'j', ctrl: false, meta: false, option: true, shift: false } });
  const fromMeta = service.normalize({ event: { name: 'j', ctrl: false, meta: true, option: false, shift: false } });
  const neither = service.normalize({ event: { name: 'j', ctrl: false, meta: false, option: false, shift: false } });
  expect(fromOption.alt).toBe(true);
  expect(fromMeta.alt).toBe(true);
  expect(neither.alt).toBe(false);
});

test('normalize preserves ctrl and shift', () => {
  expect(service.normalize({ event: { name: 'p', ctrl: true, meta: false, option: false, shift: true } })).toEqual({
    name: 'p',
    ctrl: true,
    alt: false,
    shift: true,
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test src/keys/key-normalizer.test.ts`
Expected: FAIL — `Cannot find module './key-normalizer.ts'`

- [ ] **Step 3: Write `src/keys/key-normalizer.ts`**

```ts
import type { IKey, IRawKeyEvent } from './common/index.ts';

/** Translates terminal key events into the canonical form the keymap matches against. */
export class KeyNormalizerService {
  /** OpenTUI reports Alt as `option` (macOS) or `meta` (Linux); both mean alt here. */
  normalize = (opts: { event: IRawKeyEvent }): IKey => {
    const { event } = opts;
    return {
      name: event.name,
      ctrl: event.ctrl,
      alt: event.option || event.meta,
      shift: event.shift,
    };
  };

  /**
   * Canonical string form. Modifier order is fixed (C then A then S) so that a
   * binding string can only ever match one key combination.
   */
  toCanonicalString = (opts: { key: IKey }): string => {
    const { key } = opts;
    const modifiers: string[] = [];

    if (key.ctrl) {
      modifiers.push('C');
    }
    if (key.alt) {
      modifiers.push('A');
    }
    // Shift is only notated where it is not already implied by the key name.
    if (key.shift && key.name.length === 1) {
      modifiers.push('S');
    }

    if (modifiers.length === 0) {
      return key.name;
    }

    return `<${modifiers.join('-')}-${key.name}>`;
  };
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `bun test src/keys/key-normalizer.test.ts`
Expected: PASS — 6 tests

- [ ] **Step 5: Commit**

```bash
git add src/keys/key-normalizer.ts src/keys/key-normalizer.test.ts
git commit -m "Add key normalizer service"
```

---

### Task 5: Vim engine service

**Files:**
- Create: `src/keys/vim-engine.ts`
- Test: `src/keys/vim-engine.test.ts`

**Interfaces:**
- Consumes: `KeyNormalizerService`; types and constants from `keys/common`
- Produces: `VimEngineService` with `resolve(opts: { state: IEngineState; key: IKey; keymap: IKeyBinding[] }): IResolveResult`

- [ ] **Step 1: Write the failing test**

`src/keys/vim-engine.test.ts`:

```ts
import { test, expect } from 'bun:test';

import { Container, BindingScopes } from '@venizia/ignis-inversion';

import { BindingKeys } from '../common/index.ts';
import { ActionTypes, INITIAL_ENGINE_STATE, VimContexts, VimModes } from './common/index.ts';
import type { IKey, IKeyBinding } from './common/index.ts';
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
  const insert = { ...INITIAL_ENGINE_STATE, mode: VimModes.INSERT };
  expect(engine.resolve({ state: insert, key: buildKey('j'), keymap }).status).toBe('unmapped');
  expect(engine.resolve({ state: insert, key: buildKey('escape'), keymap }).status).toBe('resolved');
});

test('bindings are filtered by context', () => {
  const engine = buildEngine();
  const chatList = { ...INITIAL_ENGINE_STATE, context: VimContexts.CHAT_LIST };
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
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test src/keys/vim-engine.test.ts`
Expected: FAIL — `Cannot find module './vim-engine.ts'`

- [ ] **Step 3: Write `src/keys/vim-engine.ts`**

```ts
import { getError, inject } from '@venizia/ignis-inversion';

import { BindingKeys } from '../common/index.ts';
import { ActionTypes, VimModes } from './common/index.ts';
import type {
  IEngineState,
  IKey,
  IKeyBinding,
  IResolveResult,
  TVimContext,
  TVimMode,
} from './common/index.ts';
import type { KeyNormalizerService } from './key-normalizer.ts';

const DIGIT_PATTERN = /^[0-9]$/;

/**
 * The vim layer, expressed as a deterministic fold over key presses. No I/O, no
 * clock, no mutation: the same state and key always produce the same actions,
 * which is what makes counts, prefixes and mode transitions exhaustively testable.
 */
export class VimEngineService {
  constructor(
    @inject({ key: BindingKeys.KEY_NORMALIZER })
    private readonly _keyNormalizer: KeyNormalizerService,
  ) {}

  private matchesMode = (opts: { binding: IKeyBinding; mode: TVimMode }): boolean => {
    const { binding, mode } = opts;
    if (Array.isArray(binding.mode)) {
      return binding.mode.includes(mode);
    }
    return binding.mode === mode;
  };

  private matchesContext = (opts: { binding: IKeyBinding; context: TVimContext }): boolean => {
    return opts.binding.context === '*' || opts.binding.context === opts.context;
  };

  private accumulateCount = (opts: { state: IEngineState; token: string }): IEngineState | null => {
    const { state, token } = opts;

    const countable = state.mode === VimModes.NORMAL || state.mode === VimModes.VISUAL;
    if (!countable || state.pending !== '') {
      return null;
    }
    if (!DIGIT_PATTERN.test(token)) {
      return null;
    }
    // A leading 0 is the line-start motion in vim, never the start of a count.
    if (token === '0' && state.count === null) {
      return null;
    }

    return { ...state, count: (state.count ?? 0) * 10 + Number(token) };
  };

  private applyStateActions = (opts: { state: IEngineState; binding: IKeyBinding; count: number }): {
    state: IEngineState;
    actions: IResolveResult['actions'];
  } => {
    const { binding, count } = opts;
    const actions = binding.action(count);
    let state: IEngineState = { ...opts.state, pending: '', count: null };

    for (const action of actions) {
      switch (action.type) {
        case ActionTypes.MODE_SET: {
          state = { ...state, mode: action.mode };
          break;
        }
        case ActionTypes.FOCUS_SET: {
          state = { ...state, context: action.context };
          break;
        }
        default: {
          // Every other action is state the reducer owns, not the engine.
          break;
        }
      }
    }

    return { state, actions };
  };

  resolve = (opts: { state: IEngineState; key: IKey; keymap: IKeyBinding[] }): IResolveResult => {
    const { state, key, keymap } = opts;

    if (keymap.length === 0) {
      throw getError({ message: '[VimEngineService][resolve] Empty keymap provided' });
    }

    const token = this._keyNormalizer.toCanonicalString({ key });

    const counted = this.accumulateCount({ state, token });
    if (counted) {
      return { state: counted, actions: [], status: 'pending' };
    }

    const candidates = keymap.filter(binding => {
      return (
        this.matchesMode({ binding, mode: state.mode }) &&
        this.matchesContext({ binding, context: state.context })
      );
    });

    const sequence = state.pending + token;

    const exact = candidates.find(binding => binding.keys === sequence);
    if (exact) {
      const applied = this.applyStateActions({ state, binding: exact, count: state.count ?? 1 });
      return { state: applied.state, actions: applied.actions, status: 'resolved' };
    }

    const isPrefix = candidates.some(binding => {
      return binding.keys.startsWith(sequence) && binding.keys !== sequence;
    });
    if (isPrefix) {
      return { state: { ...state, pending: sequence }, actions: [], status: 'pending' };
    }

    return { state: { ...state, pending: '', count: null }, actions: [], status: 'unmapped' };
  };
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `bun test src/keys/vim-engine.test.ts`
Expected: PASS — 13 tests

- [ ] **Step 5: Confirm the boundary still holds**

Run: `bun test src/test/boundaries.test.ts`
Expected: PASS — `keys/` imports only `@venizia/ignis-inversion` and relative paths.

- [ ] **Step 6: Commit**

```bash
git add src/keys/vim-engine.ts src/keys/vim-engine.test.ts
git commit -m "Add vim engine service with counts, prefixes and mode filtering"
```

---

### Task 6: Keymap service

**Files:**
- Create: `src/keys/keymap.ts`, `src/keys/index.ts`
- Test: `src/keys/keymap.test.ts`

**Interfaces:**
- Consumes: types and constants from `keys/common`
- Produces: `KeymapService` with `getBindings(): IKeyBinding[]` and `describe(opts: { mode, context }): Array<{ keys: string; description: string }>`

- [ ] **Step 1: Write the failing test**

`src/keys/keymap.test.ts`:

```ts
import { test, expect } from 'bun:test';

import { Container, BindingScopes } from '@venizia/ignis-inversion';

import { BindingKeys } from '../common/index.ts';
import { ActionTypes, INITIAL_ENGINE_STATE, VimContexts, VimModes } from './common/index.ts';
import type { IKey } from './common/index.ts';
import { KeyNormalizerService } from './key-normalizer.ts';
import { KeymapService } from './keymap.ts';
import { VimEngineService } from './vim-engine.ts';

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
  const insert = { ...INITIAL_ENGINE_STATE, mode: VimModes.INSERT, context: VimContexts.COMPOSER };
  const pending = engine.resolve({ state: insert, key: buildKey('j'), keymap });
  expect(pending.status).toBe('pending');
  expect(engine.resolve({ state: pending.state, key: buildKey('k'), keymap }).state.mode).toBe(VimModes.NORMAL);
});

test('escape also leaves insert mode', () => {
  const { keymapService, engine } = build();
  const insert = { ...INITIAL_ENGINE_STATE, mode: VimModes.INSERT, context: VimContexts.COMPOSER };
  expect(engine.resolve({ state: insert, key: buildKey('escape'), keymap: keymapService.getBindings() }).state.mode)
    .toBe(VimModes.NORMAL);
});

test('gg and G jump to the ends of history', () => {
  const { keymapService, engine } = build();
  const keymap = keymapService.getBindings();
  const pending = engine.resolve({ state: INITIAL_ENGINE_STATE, key: buildKey('g'), keymap });
  expect(engine.resolve({ state: pending.state, key: buildKey('g'), keymap }).actions)
    .toEqual([{ type: ActionTypes.CURSOR_EDGE, unit: 'message', edge: 'first' }]);
  expect(engine.resolve({ state: INITIAL_ENGINE_STATE, key: buildKey('G', { shift: true }), keymap }).actions)
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
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test src/keys/keymap.test.ts`
Expected: FAIL — `Cannot find module './keymap.ts'`

- [ ] **Step 3: Write `src/keys/keymap.ts`**

Mappings deliberately echo `dotfiles/confs/neovim/lua/main/003-keymaps.lua`.
Leader is `\`.

```ts
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
    {
      context: '*', mode: VimModes.NORMAL, keys: 'G', description: 'Newest message',
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
      context: VimContexts.CHAT_LIST, mode: VimModes.NORMAL, keys: 'return', description: 'Open chat',
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
    {
      context: '*', mode: VimModes.INSERT, keys: 'escape', description: 'Leave insert mode',
      action: () => [{ type: ActionTypes.MODE_SET, mode: VimModes.NORMAL }],
    },
    {
      context: '*', mode: VimModes.INSERT, keys: 'return', description: 'Send message',
      action: () => [{ type: ActionTypes.COMPOSER_SEND }],
    },
    {
      context: '*', mode: VimModes.INSERT, keys: 'backspace', description: 'Delete character',
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
```

The chat-list `j`/`k` bindings are more specific than the `*` ones. `resolve`
filters by context before matching, and both survive the collision check because
their contexts differ — but the `*` binding still wins in the messages context,
which is what the test for `j` asserts.

- [ ] **Step 4: Write `src/keys/index.ts`**

```ts
export * from './common/index.ts';
export * from './key-normalizer.ts';
export * from './keymap.ts';
export * from './vim-engine.ts';
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `bun test src/keys/`
Expected: PASS — 10 keymap tests plus the earlier engine and normalizer tests.

If `j` in the chat-list context resolves to a message move rather than a chat
move, `resolve` is picking the first match rather than the most specific: make
`candidates` prefer bindings whose `context` is not `'*'`.

- [ ] **Step 6: Commit**

```bash
git add src/keys/keymap.ts src/keys/keymap.test.ts src/keys/index.ts
git commit -m "Add keymap service echoing the author's nvim mappings"
```

---

### Task 7: File logger provider

The default IGNIS provider is winston writing to stdout, which corrupts the
alternate screen the moment anything logs. This must exist before any service
can log, which is why it comes before the rest of `core/`.

**Files:**
- Create: `src/core/logger-provider.ts`
- Test: `src/core/logger-provider.test.ts`

**Interfaces:**
- Consumes: `ILogger`, `ILoggerProvider`, `LoggerFactory` from `@venizia/ignis-helpers`
- Produces: `buildFileLoggerProvider(opts: { filePath: string }): ILoggerProvider`, `installFileLogger(opts: { filePath: string }): void`

- [ ] **Step 1: Write the failing test**

`src/core/logger-provider.test.ts`:

```ts
import { test, expect } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ApplicationLogger } from '@venizia/ignis-helpers';

import { buildFileLoggerProvider, installFileLogger } from './logger-provider.ts';

const buildLogPath = (): string => join(mkdtempSync(join(tmpdir(), 'tglow-log-')), 'tglow.log');

test('the provider exposes the ILoggerProvider contract', () => {
  const provider = buildFileLoggerProvider({ filePath: buildLogPath() });
  expect(typeof provider.get).toBe('function');
  expect(typeof provider.get('Probe').error).toBe('function');
  expect(typeof provider.get('Probe').for).toBe('function');
});

test('log lines are written to the file, never to stdout', () => {
  const filePath = buildLogPath();
  const provider = buildFileLoggerProvider({ filePath });
  provider.get('TelegramClientService').for('connect').error('Could not connect | Reason: %s', 'network down');

  expect(existsSync(filePath)).toBe(true);
  const contents = readFileSync(filePath, 'utf8');
  expect(contents).toContain('TelegramClientService');
  expect(contents).toContain('connect');
  expect(contents).toContain('Could not connect');
  expect(contents).toContain('network down');
});

test('for() nests the method onto the scope', () => {
  const filePath = buildLogPath();
  buildFileLoggerProvider({ filePath }).get('DialogService').for('sync').info('Refreshed');
  expect(readFileSync(filePath, 'utf8')).toContain('DialogService.sync');
});

test('every level writes', () => {
  const filePath = buildLogPath();
  const logger = buildFileLoggerProvider({ filePath }).get('Probe');
  logger.debug('a-debug');
  logger.info('a-info');
  logger.warn('a-warn');
  logger.error('a-error');
  const contents = readFileSync(filePath, 'utf8');
  for (const marker of ['a-debug', 'a-info', 'a-warn', 'a-error']) {
    expect(contents).toContain(marker);
  }
});

test('installFileLogger routes ApplicationLogger through the file', () => {
  const filePath = buildLogPath();
  installFileLogger({ filePath });
  ApplicationLogger.get('InstalledProbe').for('run').warn('routed through file');
  expect(readFileSync(filePath, 'utf8')).toContain('routed through file');
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test src/core/logger-provider.test.ts`
Expected: FAIL — `Cannot find module './logger-provider.ts'`

- [ ] **Step 3: Write `src/core/logger-provider.ts`**

```ts
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { LoggerFactory, type ILogger, type ILoggerProvider } from '@venizia/ignis-helpers';

type TLogLevel = 'debug' | 'info' | 'warn' | 'error' | 'emerg';

const formatArgument = (value: unknown): string => {
  if (typeof value === 'string') {
    return value;
  }
  if (value instanceof Error) {
    return value.message;
  }
  return JSON.stringify(value);
};

/**
 * A TUI owns the alternate screen: anything written to stdout lands in the
 * middle of a frame. IGNIS's default provider is winston-to-stdout, so the
 * application replaces it with this before the first log call.
 */
const buildFileLogger = (opts: { filePath: string; scope: string }): ILogger => {
  const { filePath, scope } = opts;

  const write = (level: TLogLevel) => {
    return (message: string, ...args: unknown[]): void => {
      const rendered = args.length === 0 ? message : `${message} ${args.map(formatArgument).join(' ')}`;
      const line = `${new Date().toISOString()} [${level}] [${scope}] ${rendered}\n`;
      appendFileSync(filePath, line);
    };
  };

  return {
    debug: write('debug'),
    info: write('info'),
    warn: write('warn'),
    error: write('error'),
    emerg: write('emerg'),
    log: (level: TLogLevel, message: string, ...args: unknown[]): void => {
      write(level)(message, ...args);
    },
    for: (methodName: string): ILogger => {
      return buildFileLogger({ filePath, scope: `${scope}.${methodName}` });
    },
  } as ILogger;
};

export const buildFileLoggerProvider = (opts: { filePath: string }): ILoggerProvider => {
  mkdirSync(dirname(opts.filePath), { recursive: true });
  return { get: (scope: string): ILogger => buildFileLogger({ filePath: opts.filePath, scope }) };
};

/** Must run before anything else can log, or winston claims stdout first. */
export const installFileLogger = (opts: { filePath: string }): void => {
  LoggerFactory.use({ provider: buildFileLoggerProvider({ filePath: opts.filePath }) });
};
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `bun test src/core/logger-provider.test.ts`
Expected: PASS — 5 tests

- [ ] **Step 5: Commit**

```bash
git add src/core/logger-provider.ts src/core/logger-provider.test.ts
git commit -m "Add file logger provider to keep logs off the alternate screen"
```

---

### Task 8: Configuration service

**Files:**
- Create: `src/core/common/types.ts`, `src/core/common/index.ts`, `src/core/configuration.ts`
- Test: `src/core/configuration.test.ts`

**Interfaces:**
- Consumes: `getError` from `@venizia/ignis-inversion`
- Produces: `IApplicationConfiguration` (`apiId`, `apiHash`, `palette`, `sessionPath`, `cachePath`, `logPath`), `ConfigurationService` with `load(opts?: { filePath?: string }): IApplicationConfiguration` and `getDefaultPath(): string`

- [ ] **Step 1: Write the failing test**

`src/core/configuration.test.ts`:

```ts
import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigurationService } from './configuration.ts';

const writeConfiguration = (body: string): string => {
  const filePath = join(mkdtempSync(join(tmpdir(), 'tglow-')), 'config.toml');
  writeFileSync(filePath, body);
  return filePath;
};

const service = new ConfigurationService();

test('loads api credentials', () => {
  const filePath = writeConfiguration('api_id = 12345\napi_hash = "abc123"\n');
  const configuration = service.load({ filePath });
  expect(configuration.apiId).toBe(12345);
  expect(configuration.apiHash).toBe('abc123');
});

test('palette defaults to sage', () => {
  const filePath = writeConfiguration('api_id = 1\napi_hash = "x"\n');
  expect(service.load({ filePath }).palette).toBe('sage');
});

test('palette can be overridden', () => {
  const filePath = writeConfiguration('api_id = 1\napi_hash = "x"\npalette = "ember"\n');
  expect(service.load({ filePath }).palette).toBe('ember');
});

test('comments and blank lines are ignored', () => {
  const filePath = writeConfiguration('# a comment\n\napi_id = 7\napi_hash = "y"\n');
  expect(service.load({ filePath }).apiId).toBe(7);
});

test('a missing file explains where to get credentials', () => {
  expect(() => service.load({ filePath: '/nonexistent/config.toml' })).toThrow(/my\.telegram\.org/);
});

test('a missing api_id is reported with the class and method', () => {
  const filePath = writeConfiguration('api_hash = "x"\n');
  expect(() => service.load({ filePath })).toThrow(/\[ConfigurationService\]\[load\]/);
  expect(() => service.load({ filePath })).toThrow(/api_id/);
});

test('a non-numeric api_id is rejected', () => {
  const filePath = writeConfiguration('api_id = "nope"\napi_hash = "x"\n');
  expect(() => service.load({ filePath })).toThrow(/api_id/);
});

test('an empty api_hash is rejected', () => {
  const filePath = writeConfiguration('api_id = 1\napi_hash = ""\n');
  expect(() => service.load({ filePath })).toThrow(/api_hash/);
});

test('derived paths sit under the data directory', () => {
  const filePath = writeConfiguration('api_id = 1\napi_hash = "x"\n');
  const configuration = service.load({ filePath });
  expect(configuration.sessionPath).toContain('tglow');
  expect(configuration.cachePath).toContain('tglow');
  expect(configuration.logPath).toContain('tglow');
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test src/core/configuration.test.ts`
Expected: FAIL — `Cannot find module './configuration.ts'`

- [ ] **Step 3: Write `src/core/common/types.ts`**

```ts
export interface IApplicationConfiguration {
  apiId: number;
  apiHash: string;
  palette: string;
  sessionPath: string;
  cachePath: string;
  logPath: string;
}
```

- [ ] **Step 4: Write `src/core/common/index.ts`**

```ts
export * from './types.ts';
```

- [ ] **Step 5: Write `src/core/configuration.ts`**

```ts
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { getError } from '@venizia/ignis-inversion';

import type { IApplicationConfiguration } from './common/index.ts';

const DEFAULT_PALETTE = 'sage';

const SETUP_HINT = [
  'Create it with:',
  '',
  '  mkdir -p ~/.config/tglow',
  '  printf \'api_id = 0\\napi_hash = ""\\n\' > ~/.config/tglow/config.toml',
  '',
  'Get api_id and api_hash from https://my.telegram.org (log in, API development tools).',
].join('\n');

export class ConfigurationService {
  getDefaultPath = (): string => {
    return join(homedir(), '.config', 'tglow', 'config.toml');
  };

  /** Minimal TOML reader: bare `key = value` pairs, strings and integers only. */
  private parse = (opts: { source: string }): Record<string, string | number> => {
    const parsed: Record<string, string | number> = {};

    for (const line of opts.source.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('#')) {
        continue;
      }

      const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/.exec(trimmed);
      if (!match) {
        continue;
      }

      const key = match[1]!;
      const value = match[2]!.trim();

      if (/^".*"$/.test(value)) {
        parsed[key] = value.slice(1, -1);
        continue;
      }
      if (/^-?\d+$/.test(value)) {
        parsed[key] = Number(value);
        continue;
      }
      parsed[key] = value;
    }

    return parsed;
  };

  load = (opts: { filePath?: string } = {}): IApplicationConfiguration => {
    const filePath = opts.filePath ?? this.getDefaultPath();

    if (!existsSync(filePath)) {
      throw getError({
        message: `[ConfigurationService][load] No config file | Path: ${filePath}\n\n${SETUP_HINT}`,
      });
    }

    const raw = this.parse({ source: readFileSync(filePath, 'utf8') });

    if (typeof raw.api_id !== 'number') {
      throw getError({
        message: `[ConfigurationService][load] api_id missing or not a number | Path: ${filePath}\n\n${SETUP_HINT}`,
      });
    }
    if (typeof raw.api_hash !== 'string' || raw.api_hash === '') {
      throw getError({
        message: `[ConfigurationService][load] api_hash missing or empty | Path: ${filePath}\n\n${SETUP_HINT}`,
      });
    }

    const dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share');

    return {
      apiId: raw.api_id,
      apiHash: raw.api_hash,
      palette: typeof raw.palette === 'string' ? raw.palette : DEFAULT_PALETTE,
      sessionPath: join(dataHome, 'tglow', 'session'),
      cachePath: join(dataHome, 'tglow', 'cache.sqlite'),
      logPath: join(dataHome, 'tglow', 'tglow.log'),
    };
  };
}
```

- [ ] **Step 6: Run the tests and watch them pass**

Run: `bun test src/core/configuration.test.ts`
Expected: PASS — 9 tests

- [ ] **Step 7: Commit**

```bash
git add src/core/common/ src/core/configuration.ts src/core/configuration.test.ts
git commit -m "Add configuration service with actionable setup errors"
```

---

### Task 9: Session store service

**Files:**
- Create: `src/core/session-store.ts`
- Test: `src/core/session-store.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `SessionStoreService` with `load(opts: { filePath: string }): string`, `save(opts: { filePath: string; value: string }): void`, `clear(opts: { filePath: string }): void`

- [ ] **Step 1: Write the failing test**

`src/core/session-store.test.ts`:

```ts
import { test, expect } from 'bun:test';
import { existsSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SessionStoreService } from './session-store.ts';

const service = new SessionStoreService();
const buildPath = (): string => join(mkdtempSync(join(tmpdir(), 'tglow-')), 'nested', 'session');

test('a missing session file reads as an empty string', () => {
  expect(service.load({ filePath: buildPath() })).toBe('');
});

test('a saved session round-trips', () => {
  const filePath = buildPath();
  service.save({ filePath, value: '1BQANOTEuMTA4LjU2' });
  expect(service.load({ filePath })).toBe('1BQANOTEuMTA4LjU2');
});

// The session string is equivalent to a logged-in device on the account.
test('the session file is created mode 0600', () => {
  const filePath = buildPath();
  service.save({ filePath, value: 'secret' });
  expect(statSync(filePath).mode & 0o777).toBe(0o600);
});

test('saving creates missing parent directories', () => {
  const filePath = buildPath();
  service.save({ filePath, value: 'x' });
  expect(existsSync(filePath)).toBe(true);
});

test('clear removes the file and reads back empty', () => {
  const filePath = buildPath();
  service.save({ filePath, value: 'x' });
  service.clear({ filePath });
  expect(existsSync(filePath)).toBe(false);
  expect(service.load({ filePath })).toBe('');
});

test('clearing a missing file is not an error', () => {
  expect(() => service.clear({ filePath: buildPath() })).not.toThrow();
});

test('surrounding whitespace is stripped on load', () => {
  const filePath = buildPath();
  service.save({ filePath, value: '  padded  ' });
  expect(service.load({ filePath })).toBe('padded');
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test src/core/session-store.test.ts`
Expected: FAIL — `Cannot find module './session-store.ts'`

- [ ] **Step 3: Write `src/core/session-store.ts`**

```ts
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const SESSION_FILE_MODE = 0o600;
const SESSION_DIRECTORY_MODE = 0o700;

/**
 * The GramJS session string is equivalent to a logged-in device: whoever reads
 * it controls the account. Written 0600, git-ignored, and never logged or
 * included in an error message.
 */
export class SessionStoreService {
  load = (opts: { filePath: string }): string => {
    if (!existsSync(opts.filePath)) {
      return '';
    }
    return readFileSync(opts.filePath, 'utf8').trim();
  };

  save = (opts: { filePath: string; value: string }): void => {
    mkdirSync(dirname(opts.filePath), { recursive: true, mode: SESSION_DIRECTORY_MODE });
    writeFileSync(opts.filePath, opts.value, { mode: SESSION_FILE_MODE });
  };

  clear = (opts: { filePath: string }): void => {
    if (!existsSync(opts.filePath)) {
      return;
    }
    rmSync(opts.filePath);
  };
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `bun test src/core/session-store.test.ts`
Expected: PASS — 7 tests

- [ ] **Step 5: Commit**

```bash
git add src/core/session-store.ts src/core/session-store.test.ts
git commit -m "Add session store with 0600 permissions"
```

---

### Task 10: SQLite cache

**Files:**
- Create: `src/core/cache/schema.sql`, `src/core/cache/database.ts`, `src/core/cache/index.ts`
- Test: `src/core/cache/database.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `DatabaseService` with `open(opts: { filePath: string }): void`, `upsertPeer`, `upsertDialog`, `listDialogs`, `insertMessages`, `listMessages`, `getSyncState`, `setSyncState`, `close`. Row types `IPeerInput`, `IDialogInput`, `IMessageInput`, `IDialogRow`, `IMessageRow` are used by Tasks 11, 13, 15, 16.

- [ ] **Step 1: Write `src/core/cache/schema.sql`**

`folder_id` and `status` are unused in M1a but present so M2 and M4 need no migration.

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

`src/core/cache/database.test.ts`:

```ts
import { test, expect } from 'bun:test';

import { DatabaseService } from './database.ts';

const buildDatabase = (): DatabaseService => {
  const database = new DatabaseService();
  database.open({ filePath: ':memory:' });
  database.upsertPeer({ id: 'u1', type: 'user', accessHash: 'h1', title: 'Alice', username: 'alice' });
  database.upsertPeer({ id: 'u2', type: 'user', accessHash: 'h2', title: 'Bob', username: null });
  return database;
};

test('peers and dialogs round-trip', () => {
  const database = buildDatabase();
  database.upsertDialog({ peerId: 'u1', pinned: 0, unreadCount: 2, lastMessageAt: 100, topMessageId: 5 });
  expect(database.listDialogs()[0]!.title).toBe('Alice');
  database.close();
});

test('upsertPeer updates rather than duplicating', () => {
  const database = buildDatabase();
  database.upsertPeer({ id: 'u1', type: 'user', accessHash: 'h1', title: 'Alice Smith', username: 'alice' });
  database.upsertDialog({ peerId: 'u1', pinned: 0, unreadCount: 0, lastMessageAt: 1, topMessageId: 1 });
  const dialogs = database.listDialogs();
  expect(dialogs).toHaveLength(1);
  expect(dialogs[0]!.title).toBe('Alice Smith');
  database.close();
});

test('dialogs sort pinned first, then by recency', () => {
  const database = buildDatabase();
  database.upsertDialog({ peerId: 'u1', pinned: 0, unreadCount: 0, lastMessageAt: 300, topMessageId: 9 });
  database.upsertDialog({ peerId: 'u2', pinned: 1, unreadCount: 0, lastMessageAt: 100, topMessageId: 4 });
  expect(database.listDialogs().map(dialog => dialog.peerId)).toEqual(['u2', 'u1']);
  database.close();
});

test('messages are read back newest-first', () => {
  const database = buildDatabase();
  database.insertMessages({
    messages: [
      { peerId: 'u1', id: 1, fromId: 'u1', date: 100, text: 'morning!', out: 0 },
      { peerId: 'u1', id: 2, fromId: 'u1', date: 200, text: 'ok ping me', out: 0 },
      { peerId: 'u1', id: 3, fromId: 'me', date: 300, text: 'not yet', out: 1 },
    ],
  });
  expect(database.listMessages({ peerId: 'u1', limit: 10 }).map(message => message.text))
    .toEqual(['not yet', 'ok ping me', 'morning!']);
  database.close();
});

test('inserting the same message twice updates it', () => {
  const database = buildDatabase();
  const message = { peerId: 'u1', id: 1, fromId: 'u1', date: 100, text: 'hi', out: 0 };
  database.insertMessages({ messages: [message] });
  database.insertMessages({ messages: [{ ...message, text: 'hi (edited)' }] });
  const rows = database.listMessages({ peerId: 'u1', limit: 10 });
  expect(rows).toHaveLength(1);
  expect(rows[0]!.text).toBe('hi (edited)');
  database.close();
});

test('listMessages honours its limit and scopes to one peer', () => {
  const database = buildDatabase();
  database.insertMessages({
    messages: [
      { peerId: 'u1', id: 1, fromId: 'u1', date: 100, text: 'a', out: 0 },
      { peerId: 'u1', id: 2, fromId: 'u1', date: 200, text: 'b', out: 0 },
      { peerId: 'u2', id: 1, fromId: 'u2', date: 150, text: 'other', out: 0 },
    ],
  });
  expect(database.listMessages({ peerId: 'u1', limit: 1 }).map(message => message.text)).toEqual(['b']);
  expect(database.listMessages({ peerId: 'u2', limit: 10 }).map(message => message.text)).toEqual(['other']);
  database.close();
});

test('sync state round-trips', () => {
  const database = buildDatabase();
  expect(database.getSyncState({ key: 'pts' })).toBeNull();
  database.setSyncState({ key: 'pts', value: 4242 });
  expect(database.getSyncState({ key: 'pts' })).toBe(4242);
  database.close();
});

test('using the database before open reports the class and method', () => {
  expect(() => new DatabaseService().listDialogs()).toThrow(/\[DatabaseService\]/);
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `bun test src/core/cache/database.test.ts`
Expected: FAIL — `Cannot find module './database.ts'`

- [ ] **Step 4: Write `src/core/cache/database.ts`**

```ts
import { readFileSync } from 'node:fs';

import { Database } from 'bun:sqlite';
import { getError } from '@venizia/ignis-inversion';

export interface IPeerInput {
  id: string;
  type: 'user' | 'chat' | 'channel';
  accessHash: string | null;
  title: string;
  username: string | null;
}

export interface IDialogInput {
  peerId: string;
  pinned: number;
  unreadCount: number;
  lastMessageAt: number;
  topMessageId: number;
}

export interface IMessageInput {
  peerId: string;
  id: number;
  fromId: string | null;
  date: number;
  text: string;
  out: number;
}

export interface IDialogRow {
  peerId: string;
  title: string;
  pinned: number;
  unreadCount: number;
  lastMessageAt: number | null;
  topMessageId: number | null;
}

export interface IMessageRow {
  peerId: string;
  id: number;
  fromId: string | null;
  date: number;
  text: string;
  out: number;
}

const SCHEMA_PATH = new URL('./schema.sql', import.meta.url).pathname;

export class DatabaseService {
  private _database: Database | null = null;

  private require = (methodName: string): Database => {
    if (!this._database) {
      throw getError({ message: `[DatabaseService][${methodName}] Database is not open` });
    }
    return this._database;
  };

  open = (opts: { filePath: string }): void => {
    const database = new Database(opts.filePath);
    database.run('PRAGMA journal_mode = WAL');
    database.run('PRAGMA foreign_keys = ON');
    database.run(readFileSync(SCHEMA_PATH, 'utf8'));
    this._database = database;
  };

  upsertPeer = (peer: IPeerInput): void => {
    this.require('upsertPeer')
      .prepare(
        `INSERT INTO peers (id, type, access_hash, title, username, updated_at)
         VALUES ($id, $type, $accessHash, $title, $username, $updatedAt)
         ON CONFLICT(id) DO UPDATE SET
           type = $type, access_hash = $accessHash, title = $title,
           username = $username, updated_at = $updatedAt`,
      )
      .run({
        $id: peer.id,
        $type: peer.type,
        $accessHash: peer.accessHash,
        $title: peer.title,
        $username: peer.username,
        $updatedAt: Date.now(),
      });
  };

  upsertDialog = (dialog: IDialogInput): void => {
    this.require('upsertDialog')
      .prepare(
        `INSERT INTO dialogs (peer_id, pinned, unread_count, last_message_at, top_message_id)
         VALUES ($peerId, $pinned, $unreadCount, $lastMessageAt, $topMessageId)
         ON CONFLICT(peer_id) DO UPDATE SET
           pinned = $pinned, unread_count = $unreadCount,
           last_message_at = $lastMessageAt, top_message_id = $topMessageId`,
      )
      .run({
        $peerId: dialog.peerId,
        $pinned: dialog.pinned,
        $unreadCount: dialog.unreadCount,
        $lastMessageAt: dialog.lastMessageAt,
        $topMessageId: dialog.topMessageId,
      });
  };

  listDialogs = (): IDialogRow[] => {
    return this.require('listDialogs')
      .prepare(
        `SELECT d.peer_id AS peerId, p.title AS title, d.pinned AS pinned,
                d.unread_count AS unreadCount, d.last_message_at AS lastMessageAt,
                d.top_message_id AS topMessageId
         FROM dialogs d
         JOIN peers p ON p.id = d.peer_id
         ORDER BY d.pinned DESC, d.last_message_at DESC`,
      )
      .all() as IDialogRow[];
  };

  insertMessages = (opts: { messages: IMessageInput[] }): void => {
    const database = this.require('insertMessages');
    const statement = database.prepare(
      `INSERT INTO messages (peer_id, id, from_id, date, text, out)
       VALUES ($peerId, $id, $fromId, $date, $text, $out)
       ON CONFLICT(peer_id, id) DO UPDATE SET
         from_id = $fromId, date = $date, text = $text, out = $out`,
    );

    database.transaction((messages: IMessageInput[]) => {
      for (const message of messages) {
        statement.run({
          $peerId: message.peerId,
          $id: message.id,
          $fromId: message.fromId,
          $date: message.date,
          $text: message.text,
          $out: message.out,
        });
      }
    })(opts.messages);
  };

  listMessages = (opts: { peerId: string; limit: number }): IMessageRow[] => {
    return this.require('listMessages')
      .prepare(
        `SELECT peer_id AS peerId, id, from_id AS fromId, date, text, out
         FROM messages
         WHERE peer_id = $peerId AND deleted = 0
         ORDER BY date DESC, id DESC
         LIMIT $limit`,
      )
      .all({ $peerId: opts.peerId, $limit: opts.limit }) as IMessageRow[];
  };

  getSyncState = (opts: { key: string }): number | null => {
    const row = this.require('getSyncState')
      .prepare('SELECT value FROM sync_state WHERE key = $key')
      .get({ $key: opts.key }) as { value: number } | null;
    return row ? row.value : null;
  };

  setSyncState = (opts: { key: string; value: number }): void => {
    this.require('setSyncState')
      .prepare(
        `INSERT INTO sync_state (key, value) VALUES ($key, $value)
         ON CONFLICT(key) DO UPDATE SET value = $value`,
      )
      .run({ $key: opts.key, $value: opts.value });
  };

  close = (): void => {
    this._database?.close();
    this._database = null;
  };
}
```

- [ ] **Step 5: Write `src/core/cache/index.ts`**

```ts
export * from './database.ts';
```

- [ ] **Step 6: Run the tests and watch them pass**

Run: `bun test src/core/cache/database.test.ts`
Expected: PASS — 8 tests

- [ ] **Step 7: Commit**

```bash
git add src/core/cache/
git commit -m "Add SQLite cache service"
```

---

### Task 11: Application store service

**Files:**
- Create: `src/core/application-store.ts`
- Test: `src/core/application-store.test.ts`

**Interfaces:**
- Consumes: `IDialogRow`, `IMessageRow` from `core/cache`; `IEngineState` from `keys/common`
- Produces: `IApplicationState`, `ApplicationStoreService` with `getState()`, `setState(opts: { patch })`, `subscribe(opts: { listener }): () => void`

```ts
interface IApplicationState {
  engine: IEngineState;
  dialogs: IDialogRow[];
  messages: IMessageRow[];
  activePeerId: string | null;
  chatCursor: number;
  messageCursor: number;
  composerText: string;
  connection: 'offline' | 'connecting' | 'connected';
  statusMessage: string | null;
}
```

- [ ] **Step 1: Write the failing test**

`src/core/application-store.test.ts`:

```ts
import { test, expect } from 'bun:test';

import { VimModes } from '../keys/common/index.ts';
import { ApplicationStoreService } from './application-store.ts';

test('starts with sensible defaults', () => {
  const store = new ApplicationStoreService();
  expect(store.getState().connection).toBe('offline');
  expect(store.getState().dialogs).toEqual([]);
  expect(store.getState().engine.mode).toBe(VimModes.NORMAL);
  expect(store.getState().activePeerId).toBeNull();
});

test('setState merges shallowly', () => {
  const store = new ApplicationStoreService();
  store.setState({ patch: { connection: 'connected' } });
  expect(store.getState().connection).toBe('connected');
  expect(store.getState().messages).toEqual([]);
});

test('subscribers are notified on every change', () => {
  const store = new ApplicationStoreService();
  let calls = 0;
  store.subscribe({ listener: () => { calls += 1; } });
  store.setState({ patch: { connection: 'connecting' } });
  store.setState({ patch: { statusMessage: 'hello' } });
  expect(calls).toBe(2);
});

test('unsubscribe stops notifications', () => {
  const store = new ApplicationStoreService();
  let calls = 0;
  const unsubscribe = store.subscribe({ listener: () => { calls += 1; } });
  store.setState({ patch: { connection: 'connecting' } });
  unsubscribe();
  store.setState({ patch: { connection: 'connected' } });
  expect(calls).toBe(1);
});

// React's useSyncExternalStore bails out unless the reference changes.
test('state is replaced, not mutated', () => {
  const store = new ApplicationStoreService();
  const before = store.getState();
  store.setState({ patch: { connection: 'connected' } });
  expect(store.getState()).not.toBe(before);
  expect(before.connection).toBe('offline');
});

test('one throwing subscriber does not stop the others', () => {
  const store = new ApplicationStoreService();
  let reached = false;
  store.subscribe({ listener: () => { throw new Error('boom'); } });
  store.subscribe({ listener: () => { reached = true; } });
  store.setState({ patch: { connection: 'connected' } });
  expect(reached).toBe(true);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test src/core/application-store.test.ts`
Expected: FAIL — `Cannot find module './application-store.ts'`

- [ ] **Step 3: Write `src/core/application-store.ts`**

```ts
import { ApplicationLogger, type ILogger } from '@venizia/ignis-helpers';

import { INITIAL_ENGINE_STATE, type IEngineState } from '../keys/common/index.ts';
import type { IDialogRow, IMessageRow } from './cache/index.ts';

export type TConnectionState = 'offline' | 'connecting' | 'connected';

export interface IApplicationState {
  engine: IEngineState;
  dialogs: IDialogRow[];
  messages: IMessageRow[];
  activePeerId: string | null;
  chatCursor: number;
  messageCursor: number;
  composerText: string;
  connection: TConnectionState;
  statusMessage: string | null;
}

const INITIAL_STATE: IApplicationState = {
  engine: INITIAL_ENGINE_STATE,
  dialogs: [],
  messages: [],
  activePeerId: null,
  chatCursor: 0,
  messageCursor: 0,
  composerText: '',
  connection: 'offline',
  statusMessage: null,
};

export class ApplicationStoreService {
  private readonly _logger: ILogger = ApplicationLogger.get(ApplicationStoreService.name);
  private readonly _listeners = new Set<() => void>();
  private _state: IApplicationState = INITIAL_STATE;

  getState = (): IApplicationState => {
    return this._state;
  };

  setState = (opts: { patch: Partial<IApplicationState> }): void => {
    this._state = { ...this._state, ...opts.patch };

    for (const listener of this._listeners) {
      try {
        listener();
      } catch (error) {
        // One bad subscriber must not stop the rest of the UI updating.
        this._logger.for(this.setState.name).error('Listener threw | Reason: %s', error);
      }
    }
  };

  subscribe = (opts: { listener: () => void }): (() => void) => {
    this._listeners.add(opts.listener);
    return (): void => {
      this._listeners.delete(opts.listener);
    };
  };
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `bun test src/core/application-store.test.ts`
Expected: PASS — 6 tests

- [ ] **Step 5: Commit**

```bash
git add src/core/application-store.ts src/core/application-store.test.ts
git commit -m "Add application store service"
```

---

### Task 12: Telegram client and authentication

**Files:**
- Create: `src/core/telegram-client.ts`, `src/core/authentication.ts`
- Test: `src/core/authentication.test.ts`

**Interfaces:**
- Consumes: `IApplicationConfiguration`, `SessionStoreService`
- Produces:
  - `TelegramClientService` with `build(opts: { configuration }): TelegramClient` and `persistSession(opts: { client; configuration }): void` — no unit tests, exercised by the smoke test
  - `TAuthenticationStep = 'phone' | 'code' | 'password' | 'ready'`
  - `IAuthenticationGateway` = `{ sendCode(opts: { phone }): Promise<void>; signIn(opts: { code }): Promise<'ok' | 'needPassword'>; checkPassword(opts: { password }): Promise<void> }`
  - `AuthenticationService` with `getStep()`, `submitPhone(opts: { phone })`, `submitCode(opts: { code })`, `submitPassword(opts: { password })`

The gateway is separated from GramJS so the whole login flow, including the 2FA
branch and every failure path, is testable with no network and no phone number.

- [ ] **Step 1: Write the failing test**

`src/core/authentication.test.ts`:

```ts
import { test, expect } from 'bun:test';

import { AuthenticationService, type IAuthenticationGateway } from './authentication.ts';

const buildGateway = (overrides: Partial<IAuthenticationGateway> = {}): IAuthenticationGateway => ({
  sendCode: async () => {},
  signIn: async () => 'ok',
  checkPassword: async () => {},
  ...overrides,
});

test('starts at the phone step', () => {
  expect(new AuthenticationService(buildGateway()).getStep()).toBe('phone');
});

test('a valid phone advances to the code step', async () => {
  const service = new AuthenticationService(buildGateway());
  expect(await service.submitPhone({ phone: '+84900000000' })).toBe('code');
});

test('a correct code with no two-factor reaches ready', async () => {
  const service = new AuthenticationService(buildGateway());
  await service.submitPhone({ phone: '+84900000000' });
  expect(await service.submitCode({ code: '12345' })).toBe('ready');
});

test('an account with two-factor is routed to the password step', async () => {
  const service = new AuthenticationService(buildGateway({ signIn: async () => 'needPassword' }));
  await service.submitPhone({ phone: '+84900000000' });
  expect(await service.submitCode({ code: '12345' })).toBe('password');
  expect(await service.submitPassword({ password: 'hunter2' })).toBe('ready');
});

test('submitting out of order is rejected with the class and method', async () => {
  const service = new AuthenticationService(buildGateway());
  await expect(service.submitCode({ code: '12345' })).rejects.toThrow(/\[AuthenticationService\]\[submitCode\]/);
});

test('a wrong code keeps us on the code step', async () => {
  const service = new AuthenticationService(
    buildGateway({ signIn: async () => { throw new Error('PHONE_CODE_INVALID'); } }),
  );
  await service.submitPhone({ phone: '+84900000000' });
  await expect(service.submitCode({ code: '00000' })).rejects.toThrow(/PHONE_CODE_INVALID/);
  expect(service.getStep()).toBe('code');
});

test('a wrong password keeps us on the password step', async () => {
  const service = new AuthenticationService(
    buildGateway({
      signIn: async () => 'needPassword',
      checkPassword: async () => { throw new Error('PASSWORD_HASH_INVALID'); },
    }),
  );
  await service.submitPhone({ phone: '+84900000000' });
  await service.submitCode({ code: '12345' });
  await expect(service.submitPassword({ password: 'wrong' })).rejects.toThrow(/PASSWORD_HASH_INVALID/);
  expect(service.getStep()).toBe('password');
});

test('an empty phone is rejected before any network call', async () => {
  let called = false;
  const service = new AuthenticationService(buildGateway({ sendCode: async () => { called = true; } }));
  await expect(service.submitPhone({ phone: '   ' })).rejects.toThrow(/phone/i);
  expect(called).toBe(false);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test src/core/authentication.test.ts`
Expected: FAIL — `Cannot find module './authentication.ts'`

- [ ] **Step 3: Write `src/core/authentication.ts`**

```ts
import { getError } from '@venizia/ignis-inversion';
import { ApplicationLogger, type ILogger } from '@venizia/ignis-helpers';

export type TAuthenticationStep = 'phone' | 'code' | 'password' | 'ready';

export interface IAuthenticationGateway {
  sendCode(opts: { phone: string }): Promise<void>;
  signIn(opts: { code: string }): Promise<'ok' | 'needPassword'>;
  checkPassword(opts: { password: string }): Promise<void>;
}

/**
 * Login as an explicit state machine. On failure the step is deliberately left
 * unchanged so the interface can simply re-prompt.
 */
export class AuthenticationService {
  private readonly _logger: ILogger = ApplicationLogger.get(AuthenticationService.name);
  private _step: TAuthenticationStep = 'phone';

  constructor(private readonly _gateway: IAuthenticationGateway) {}

  getStep = (): TAuthenticationStep => {
    return this._step;
  };

  submitPhone = async (opts: { phone: string }): Promise<TAuthenticationStep> => {
    if (this._step !== 'phone') {
      throw getError({
        message: `[AuthenticationService][submitPhone] Wrong step | Step: ${this._step}`,
      });
    }

    const phone = opts.phone.trim();
    if (phone === '') {
      throw getError({ message: '[AuthenticationService][submitPhone] A phone number is required' });
    }

    // The phone number is never logged.
    await this._gateway.sendCode({ phone });
    this._step = 'code';
    return this._step;
  };

  submitCode = async (opts: { code: string }): Promise<TAuthenticationStep> => {
    if (this._step !== 'code') {
      throw getError({
        message: `[AuthenticationService][submitCode] Submit a phone number first | Step: ${this._step}`,
      });
    }

    try {
      const result = await this._gateway.signIn({ code: opts.code.trim() });
      this._step = result === 'needPassword' ? 'password' : 'ready';
      return this._step;
    } catch (error) {
      this._logger.for(this.submitCode.name).warn('Sign-in rejected | Reason: %s', error);
      throw error;
    }
  };

  submitPassword = async (opts: { password: string }): Promise<TAuthenticationStep> => {
    if (this._step !== 'password') {
      throw getError({
        message: `[AuthenticationService][submitPassword] No two-factor password was requested | Step: ${this._step}`,
      });
    }

    try {
      await this._gateway.checkPassword({ password: opts.password });
      this._step = 'ready';
      return this._step;
    } catch (error) {
      this._logger.for(this.submitPassword.name).warn('Password rejected | Reason: %s', error);
      throw error;
    }
  };
}
```

- [ ] **Step 4: Write `src/core/telegram-client.ts`**

```ts
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { Logger } from 'telegram/extensions/Logger';

import type { IApplicationConfiguration } from './common/index.ts';
import type { SessionStoreService } from './session-store.ts';

const CONNECTION_RETRIES = 5;
const RETRY_DELAY_MILLISECONDS = 1000;

export class TelegramClientService {
  constructor(private readonly _sessionStore: SessionStoreService) {}

  /**
   * Device fields are truthful on purpose: misrepresenting the client is one of
   * the behaviours that attracts account restrictions.
   */
  build = (opts: { configuration: IApplicationConfiguration }): TelegramClient => {
    const { configuration } = opts;
    const session = new StringSession(this._sessionStore.load({ filePath: configuration.sessionPath }));

    return new TelegramClient(session, configuration.apiId, configuration.apiHash, {
      connectionRetries: CONNECTION_RETRIES,
      retryDelay: RETRY_DELAY_MILLISECONDS,
      autoReconnect: true,
      deviceModel: 'tglow',
      systemVersion: process.platform,
      appVersion: '0.1.0',
      baseLogger: new Logger('error' as never),
    });
  };

  persistSession = (opts: { client: TelegramClient; configuration: IApplicationConfiguration }): void => {
    const value = opts.client.session.save() as unknown as string;
    if (typeof value !== 'string' || value === '') {
      return;
    }
    this._sessionStore.save({ filePath: opts.configuration.sessionPath, value });
  };
}
```

- [ ] **Step 5: Run the tests and typecheck**

```bash
bun test src/core/authentication.test.ts
bun run typecheck
bun test src/test/boundaries.test.ts
```

Expected: 8 tests PASS, typecheck clean, boundaries clean.

- [ ] **Step 6: Commit**

```bash
git add src/core/telegram-client.ts src/core/authentication.ts src/core/authentication.test.ts
git commit -m "Add Telegram client and testable authentication state machine"
```

---

### Task 13: Dialog and message services

**Files:**
- Create: `src/core/dialog-service.ts`, `src/core/message-service.ts`, `src/core/index.ts`
- Test: `src/core/dialog-service.test.ts`, `src/core/message-service.test.ts`

**Interfaces:**
- Consumes: `DatabaseService`, `ApplicationStoreService`
- Produces:
  - `IRawDialog` = `{ peerId; type; accessHash; title; username; pinned; unreadCount; lastMessageAt; topMessageId }`
  - `IDialogAdapter` = `{ fetchDialogs(): Promise<IRawDialog[]> }`
  - `DialogService` with `sync(): Promise<void>`
  - `IRawMessage` = `{ id; peerId; fromId; date; text; out }`
  - `IMessageAdapter` = `{ fetchHistory(opts: { peerId; limit }): Promise<IRawMessage[]>; send(opts: { peerId; text }): Promise<IRawMessage> }`
  - `MessageService` with `loadHistory(opts: { peerId; limit }): Promise<void>` and `send(opts: { peerId; text }): Promise<void>`

Each takes its adapter through `@inject`, so tests supply a fake instead of the network.

- [ ] **Step 1: Write the failing dialog test**

`src/core/dialog-service.test.ts`:

```ts
import { test, expect } from 'bun:test';

import { ApplicationStoreService } from './application-store.ts';
import { DatabaseService } from './cache/index.ts';
import { DialogService, type IDialogAdapter, type IRawDialog } from './dialog-service.ts';

const buildRawDialog = (overrides: Partial<IRawDialog> = {}): IRawDialog => ({
  peerId: 'u1', type: 'user', accessHash: 'h', title: 'Alice', username: 'alice',
  pinned: 0, unreadCount: 0, lastMessageAt: 100, topMessageId: 1, ...overrides,
});

const buildService = (adapter: IDialogAdapter): { service: DialogService; database: DatabaseService; store: ApplicationStoreService } => {
  const database = new DatabaseService();
  database.open({ filePath: ':memory:' });
  const store = new ApplicationStoreService();
  return { service: new DialogService(adapter, database, store), database, store };
};

test('fetched dialogs land in the store', async () => {
  const { service, store, database } = buildService({ fetchDialogs: async () => [buildRawDialog()] });
  await service.sync();
  expect(store.getState().dialogs.map(dialog => dialog.title)).toEqual(['Alice']);
  database.close();
});

test('dialogs are cached so they survive a restart', async () => {
  const { service, database } = buildService({ fetchDialogs: async () => [buildRawDialog()] });
  await service.sync();
  expect(database.listDialogs()).toHaveLength(1);
  database.close();
});

test('pinned dialogs sort above more recent unpinned ones', async () => {
  const { service, store, database } = buildService({
    fetchDialogs: async () => [
      buildRawDialog({ peerId: 'u1', title: 'Alice', pinned: 0, lastMessageAt: 300 }),
      buildRawDialog({ peerId: 'u2', title: 'Bob', pinned: 1, lastMessageAt: 100 }),
    ],
  });
  await service.sync();
  expect(store.getState().dialogs.map(dialog => dialog.title)).toEqual(['Bob', 'Alice']);
  database.close();
});

test('a second sync updates rather than duplicating', async () => {
  let unreadCount = 1;
  const { service, store, database } = buildService({
    fetchDialogs: async () => [buildRawDialog({ unreadCount })],
  });
  await service.sync();
  unreadCount = 7;
  await service.sync();
  const dialogs = store.getState().dialogs;
  expect(dialogs).toHaveLength(1);
  expect(dialogs[0]!.unreadCount).toBe(7);
  database.close();
});

// Going offline must never blank the interface.
test('a network failure leaves the cached list visible', async () => {
  let shouldFail = false;
  const { service, store, database } = buildService({
    fetchDialogs: async () => {
      if (shouldFail) {
        throw new Error('network down');
      }
      return [buildRawDialog()];
    },
  });
  await service.sync();
  shouldFail = true;
  await service.sync();
  expect(store.getState().dialogs).toHaveLength(1);
  expect(store.getState().statusMessage).toContain('network down');
  database.close();
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test src/core/dialog-service.test.ts`
Expected: FAIL — `Cannot find module './dialog-service.ts'`

- [ ] **Step 3: Write `src/core/dialog-service.ts`**

```ts
import { inject } from '@venizia/ignis-inversion';
import { ApplicationLogger, type ILogger } from '@venizia/ignis-helpers';

import { BindingKeys } from '../common/index.ts';
import type { ApplicationStoreService } from './application-store.ts';
import type { DatabaseService } from './cache/index.ts';

export interface IRawDialog {
  peerId: string;
  type: 'user' | 'chat' | 'channel';
  accessHash: string | null;
  title: string;
  username: string | null;
  pinned: number;
  unreadCount: number;
  lastMessageAt: number;
  topMessageId: number;
}

export interface IDialogAdapter {
  fetchDialogs(): Promise<IRawDialog[]>;
}

export class DialogService {
  private readonly _logger: ILogger = ApplicationLogger.get(DialogService.name);

  constructor(
    @inject({ key: BindingKeys.DIALOG_ADAPTER }) private readonly _adapter: IDialogAdapter,
    @inject({ key: BindingKeys.DATABASE }) private readonly _database: DatabaseService,
    @inject({ key: BindingKeys.APPLICATION_STORE }) private readonly _store: ApplicationStoreService,
  ) {}

  /** Refresh the chat list. On failure the cached list stays on screen. */
  sync = async (): Promise<void> => {
    try {
      const dialogs = await this._adapter.fetchDialogs();

      for (const dialog of dialogs) {
        this._database.upsertPeer({
          id: dialog.peerId,
          type: dialog.type,
          accessHash: dialog.accessHash,
          title: dialog.title,
          username: dialog.username,
        });
        this._database.upsertDialog({
          peerId: dialog.peerId,
          pinned: dialog.pinned,
          unreadCount: dialog.unreadCount,
          lastMessageAt: dialog.lastMessageAt,
          topMessageId: dialog.topMessageId,
        });
      }

      this._store.setState({ patch: { dialogs: this._database.listDialogs(), statusMessage: null } });
    } catch (error) {
      this._logger.for(this.sync.name).error('Could not refresh chats | Reason: %s', error);
      this._store.setState({
        patch: {
          dialogs: this._database.listDialogs(),
          statusMessage: `Could not refresh chats: ${(error as Error).message}`,
        },
      });
    }
  };
}
```

- [ ] **Step 4: Run the dialog tests and watch them pass**

Run: `bun test src/core/dialog-service.test.ts`
Expected: PASS — 5 tests

- [ ] **Step 5: Write the failing message test**

`src/core/message-service.test.ts`:

```ts
import { test, expect } from 'bun:test';

import { ApplicationStoreService } from './application-store.ts';
import { DatabaseService } from './cache/index.ts';
import { MessageService, type IMessageAdapter, type IRawMessage } from './message-service.ts';

const buildRawMessage = (overrides: Partial<IRawMessage> = {}): IRawMessage => ({
  id: 1, peerId: 'u1', fromId: 'u1', date: 100, text: 'hi', out: 0, ...overrides,
});

const buildService = (adapter: IMessageAdapter) => {
  const database = new DatabaseService();
  database.open({ filePath: ':memory:' });
  database.upsertPeer({ id: 'u1', type: 'user', accessHash: 'h', title: 'Alice', username: null });
  const store = new ApplicationStoreService();
  return { service: new MessageService(adapter, database, store), database, store };
};

const buildAdapter = (overrides: Partial<IMessageAdapter> = {}): IMessageAdapter => ({
  fetchHistory: async () => [],
  send: async opts => buildRawMessage({ id: 99, peerId: opts.peerId, text: opts.text, out: 1, date: 999 }),
  ...overrides,
});

test('history is presented oldest-first', async () => {
  const { service, store, database } = buildService(
    buildAdapter({
      fetchHistory: async () => [
        buildRawMessage({ id: 1, date: 100, text: 'morning!' }),
        buildRawMessage({ id: 2, date: 200, text: 'ok ping me' }),
      ],
    }),
  );
  await service.loadHistory({ peerId: 'u1', limit: 50 });
  expect(store.getState().messages.map(message => message.text)).toEqual(['morning!', 'ok ping me']);
  database.close();
});

test('history is cached', async () => {
  const { service, database } = buildService(buildAdapter({ fetchHistory: async () => [buildRawMessage()] }));
  await service.loadHistory({ peerId: 'u1', limit: 50 });
  expect(database.listMessages({ peerId: 'u1', limit: 50 })).toHaveLength(1);
  database.close();
});

test('a network failure falls back to the cache', async () => {
  const { service, store, database } = buildService(
    buildAdapter({ fetchHistory: async () => { throw new Error('offline'); } }),
  );
  database.insertMessages({
    messages: [{ peerId: 'u1', id: 1, fromId: 'u1', date: 100, text: 'cached', out: 0 }],
  });
  await service.loadHistory({ peerId: 'u1', limit: 50 });
  expect(store.getState().messages.map(message => message.text)).toEqual(['cached']);
  expect(store.getState().statusMessage).toContain('offline');
  database.close();
});

test('sending appends the message to the view and clears the composer', async () => {
  const { service, store, database } = buildService(buildAdapter());
  store.setState({ patch: { activePeerId: 'u1', composerText: 'on my way' } });
  await service.send({ peerId: 'u1', text: 'on my way' });
  expect(store.getState().messages.map(message => message.text)).toEqual(['on my way']);
  expect(store.getState().composerText).toBe('');
  database.close();
});

test('empty and whitespace-only messages are not sent', async () => {
  let sent = 0;
  const { service, database } = buildService(
    buildAdapter({ send: async opts => { sent += 1; return buildRawMessage({ text: opts.text }); } }),
  );
  await service.send({ peerId: 'u1', text: '   ' });
  expect(sent).toBe(0);
  database.close();
});

// Losing what someone typed is the worst possible failure.
test('a failed send keeps the composed text', async () => {
  const { service, store, database } = buildService(
    buildAdapter({ send: async () => { throw new Error('FLOOD_WAIT_30'); } }),
  );
  store.setState({ patch: { composerText: 'important' } });
  await service.send({ peerId: 'u1', text: 'important' });
  expect(store.getState().composerText).toBe('important');
  expect(store.getState().statusMessage).toContain('FLOOD_WAIT_30');
  database.close();
});
```

- [ ] **Step 6: Run it and watch it fail**

Run: `bun test src/core/message-service.test.ts`
Expected: FAIL — `Cannot find module './message-service.ts'`

- [ ] **Step 7: Write `src/core/message-service.ts`**

```ts
import { inject } from '@venizia/ignis-inversion';
import { ApplicationLogger, type ILogger } from '@venizia/ignis-helpers';

import { BindingKeys } from '../common/index.ts';
import type { ApplicationStoreService } from './application-store.ts';
import type { DatabaseService, IMessageRow } from './cache/index.ts';

const SEND_REFRESH_LIMIT = 200;

export interface IRawMessage {
  id: number;
  peerId: string;
  fromId: string | null;
  date: number;
  text: string;
  out: number;
}

export interface IMessageAdapter {
  fetchHistory(opts: { peerId: string; limit: number }): Promise<IRawMessage[]>;
  send(opts: { peerId: string; text: string }): Promise<IRawMessage>;
}

export class MessageService {
  private readonly _logger: ILogger = ApplicationLogger.get(MessageService.name);

  constructor(
    @inject({ key: BindingKeys.MESSAGE_ADAPTER }) private readonly _adapter: IMessageAdapter,
    @inject({ key: BindingKeys.DATABASE }) private readonly _database: DatabaseService,
    @inject({ key: BindingKeys.APPLICATION_STORE }) private readonly _store: ApplicationStoreService,
  ) {}

  /** The cache returns newest-first; a chat reads oldest-first. */
  private forDisplay = (opts: { rows: IMessageRow[] }): IMessageRow[] => {
    return [...opts.rows].reverse();
  };

  loadHistory = async (opts: { peerId: string; limit: number }): Promise<void> => {
    const { peerId, limit } = opts;

    try {
      const fetched = await this._adapter.fetchHistory({ peerId, limit });
      this._database.insertMessages({
        messages: fetched.map(message => ({
          peerId: message.peerId,
          id: message.id,
          fromId: message.fromId,
          date: message.date,
          text: message.text,
          out: message.out,
        })),
      });
      this._store.setState({
        patch: {
          messages: this.forDisplay({ rows: this._database.listMessages({ peerId, limit }) }),
          activePeerId: peerId,
          statusMessage: null,
        },
      });
    } catch (error) {
      this._logger.for(this.loadHistory.name).error('Could not load history | Reason: %s', error);
      // Offline is not an error state for reading — show what we already have.
      this._store.setState({
        patch: {
          messages: this.forDisplay({ rows: this._database.listMessages({ peerId, limit }) }),
          activePeerId: peerId,
          statusMessage: `Could not load history: ${(error as Error).message}`,
        },
      });
    }
  };

  send = async (opts: { peerId: string; text: string }): Promise<void> => {
    const { peerId, text } = opts;

    if (text.trim() === '') {
      return;
    }

    try {
      const sent = await this._adapter.send({ peerId, text });
      this._database.insertMessages({
        messages: [{
          peerId: sent.peerId,
          id: sent.id,
          fromId: sent.fromId,
          date: sent.date,
          text: sent.text,
          out: sent.out,
        }],
      });
      this._store.setState({
        patch: {
          messages: this.forDisplay({
            rows: this._database.listMessages({ peerId, limit: SEND_REFRESH_LIMIT }),
          }),
          composerText: '',
          statusMessage: null,
        },
      });
    } catch (error) {
      this._logger.for(this.send.name).error('Send failed | Reason: %s', error);
      this._store.setState({ patch: { statusMessage: `Send failed: ${(error as Error).message}` } });
    }
  };
}
```

- [ ] **Step 8: Write `src/core/index.ts`**

```ts
export * from './common/index.ts';
export * from './application-store.ts';
export * from './authentication.ts';
export * from './cache/index.ts';
export * from './configuration.ts';
export * from './dialog-service.ts';
export * from './logger-provider.ts';
export * from './message-service.ts';
export * from './session-store.ts';
export * from './telegram-client.ts';
```

- [ ] **Step 9: Run the tests and watch them pass**

```bash
bun test src/core/
bun run typecheck
```

Expected: all core tests PASS, typecheck clean.

- [ ] **Step 10: Commit**

```bash
git add src/core/dialog-service.ts src/core/dialog-service.test.ts src/core/message-service.ts src/core/message-service.test.ts src/core/index.ts
git commit -m "Add dialog and message services with offline fallback"
```

---

### Task 14: devglow theme

**Files:**
- Create: `src/tui/theme/palettes.ts`, `src/tui/theme/tokens.ts`, `src/tui/theme/index.ts`
- Test: `src/tui/theme/tokens.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `IPalette` (17 keys), `PALETTES`, `DEFAULT_PALETTE_NAME`, `ITokens`, `buildTokens(opts: { paletteName: string }): ITokens`

- [ ] **Step 1: Write the failing test**

`src/tui/theme/tokens.test.ts`:

```ts
import { test, expect } from 'bun:test';

import { PALETTES, type IPalette } from './palettes.ts';
import { buildTokens } from './tokens.ts';

const PALETTE_KEYS: Array<keyof IPalette> = [
  'FOREGROUND', 'BACKGROUND', 'RED', 'GREEN', 'BLUE', 'ORANGE', 'YELLOW',
  'PINK', 'GOLD', 'TEAL', 'SKY', 'WINE',
  'DARK_00', 'DARK_01', 'DARK_02', 'DARK_03', 'DARK_04',
];

test('every palette has all seventeen devglow keys', () => {
  for (const [name, palette] of Object.entries(PALETTES)) {
    for (const key of PALETTE_KEYS) {
      expect(palette[key], `${name}.${key}`).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  }
});

// These values come from devglow/lua/devglow/palettes/sage.lua and must match.
test('sage matches the upstream devglow palette exactly', () => {
  const sage = PALETTES.sage!;
  expect(sage.FOREGROUND).toBe('#E6E6E6');
  expect(sage.BACKGROUND).toBe('#080808');
  expect(sage.GOLD).toBe('#EBC17A');
  expect(sage.TEAL).toBe('#7DB9B6');
  expect(sage.PINK).toBe('#D68C8C');
  expect(sage.DARK_03).toBe('#383838');
});

test('an unknown palette falls back to sage', () => {
  expect(buildTokens({ paletteName: 'nonexistent' })).toEqual(buildTokens({ paletteName: 'sage' }));
});

test('mode colours differ so the status bar reads at a glance', () => {
  const tokens = buildTokens({ paletteName: 'sage' });
  expect(tokens.modeNormal).toBe('#7DB9B6');
  expect(tokens.modeInsert).toBe('#EBC17A');
  expect(tokens.modeVisual).toBe('#D68C8C');
  expect(new Set([tokens.modeNormal, tokens.modeInsert, tokens.modeVisual]).size).toBe(3);
});

test('tokens resolve against whichever palette is chosen', () => {
  expect(buildTokens({ paletteName: 'ember' }).modeInsert).toBe(PALETTES.ember!.GOLD);
  expect(buildTokens({ paletteName: 'sage' }).modeInsert).toBe(PALETTES.sage!.GOLD);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test src/tui/theme/tokens.test.ts`
Expected: FAIL — `Cannot find module './palettes.ts'`

- [ ] **Step 3: Write `src/tui/theme/palettes.ts`**

Values copied verbatim from `devglow/lua/devglow/palettes/`. M1a ships `sage`
(the active alacritty theme) and `ember`; the remaining ten are transcribed in
M1b — the structure is identical.

```ts
export interface IPalette {
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
const SAGE: IPalette = {
  FOREGROUND: '#E6E6E6',
  BACKGROUND: '#080808',
  RED: '#AF5F5F',
  GREEN: '#87AFAF',
  BLUE: '#7590AF',
  ORANGE: '#D59572',
  YELLOW: '#E5B567',
  PINK: '#D68C8C',
  GOLD: '#EBC17A',
  TEAL: '#7DB9B6',
  SKY: '#7EAAC7',
  WINE: '#924653',
  DARK_00: '#111111',
  DARK_01: '#181818',
  DARK_02: '#282828',
  DARK_03: '#383838',
  DARK_04: '#797979',
};

/** Not the flame itself, but the glowing coals underneath. */
const EMBER: IPalette = {
  FOREGROUND: '#F5F0EB',
  BACKGROUND: '#141311',
  RED: '#D06060',
  GREEN: '#6AADAD',
  BLUE: '#5A9D9D',
  ORANGE: '#D4785E',
  YELLOW: '#E0BA6A',
  PINK: '#E08B72',
  GOLD: '#EACA80',
  TEAL: '#7BBDBD',
  SKY: '#6AADAD',
  WINE: '#B45A42',
  DARK_00: '#1A1917',
  DARK_01: '#211F1D',
  DARK_02: '#2E2B28',
  DARK_03: '#3D3935',
  DARK_04: '#847C74',
};

export const PALETTES: Record<string, IPalette> = { sage: SAGE, ember: EMBER };
export const DEFAULT_PALETTE_NAME = 'sage';
```

- [ ] **Step 4: Write `src/tui/theme/tokens.ts`**

```ts
import { DEFAULT_PALETTE_NAME, PALETTES, type IPalette } from './palettes.ts';

/** Semantic roles, so components never name a colour and palettes stay swappable. */
export interface ITokens {
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

export const buildTokens = (opts: { paletteName: string }): ITokens => {
  const palette: IPalette = PALETTES[opts.paletteName] ?? PALETTES[DEFAULT_PALETTE_NAME]!;

  return {
    background: palette.BACKGROUND,
    foreground: palette.FOREGROUND,
    border: palette.DARK_02,
    dim: palette.DARK_04,
    modeNormal: palette.TEAL,
    modeInsert: palette.GOLD,
    modeVisual: palette.PINK,
    chatUnread: palette.GOLD,
    chatActive: palette.TEAL,
    messageOwn: palette.TEAL,
    messageOther: palette.FOREGROUND,
    messageCursor: palette.DARK_03,
    error: palette.RED,
  };
};
```

- [ ] **Step 5: Write `src/tui/theme/index.ts`**

```ts
export * from './palettes.ts';
export * from './tokens.ts';
```

- [ ] **Step 6: Run the tests and watch them pass**

Run: `bun test src/tui/theme/tokens.test.ts`
Expected: PASS — 5 tests

- [ ] **Step 7: Commit**

```bash
git add src/tui/theme/
git commit -m "Add devglow palettes and semantic theme tokens"
```

---

### Task 15: The four panes

**Files:**
- Create: `src/tui/panes/status-line.tsx`, `src/tui/panes/chat-list.tsx`, `src/tui/panes/message-view.tsx`, `src/tui/panes/composer.tsx`, `src/tui/panes/index.ts`
- Test: one `.test.tsx` beside each

**Interfaces:**
- Consumes: `ITokens`; `IDialogRow`, `IMessageRow`; `renderWithKeys`
- Produces: `StatusLine`, `ChatList`, `MessageView`, `Composer` — all arrow-function components with `I*Props` interfaces.

- [ ] **Step 1: Write the failing StatusLine test**

`src/tui/panes/status-line.test.tsx`:

```tsx
import { test, expect } from 'bun:test';

import { VimModes } from '../../keys/common/index.ts';
import { renderWithKeys } from '../../test/render.tsx';
import { buildTokens } from '../theme/index.ts';
import { StatusLine } from './status-line.tsx';

const tokens = buildTokens({ paletteName: 'sage' });

test('shows mode, chat, unread count and position', async () => {
  const renderer = await renderWithKeys(
    <StatusLine mode={VimModes.NORMAL} title="Alice" unreadCount={3} position={4} total={312}
                hint="\\ for keys" tokens={tokens} />,
    { width: 60, height: 1 },
  );
  await renderer.flush();
  const frame = renderer.captureCharFrame();
  expect(frame).toContain('NORMAL');
  expect(frame).toContain('Alice');
  expect(frame).toContain('3 unread');
  expect(frame).toContain('4/312');
});

test('the mode label is upper case, like lualine', async () => {
  const renderer = await renderWithKeys(
    <StatusLine mode={VimModes.INSERT} title="Bob" unreadCount={0} position={1} total={1} hint="" tokens={tokens} />,
    { width: 60, height: 1 },
  );
  await renderer.flush();
  expect(renderer.captureCharFrame()).toContain('INSERT');
});

test('a zero unread count is not shown', async () => {
  const renderer = await renderWithKeys(
    <StatusLine mode={VimModes.NORMAL} title="Bob" unreadCount={0} position={1} total={1} hint="" tokens={tokens} />,
    { width: 60, height: 1 },
  );
  await renderer.flush();
  expect(renderer.captureCharFrame()).not.toContain('unread');
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test src/tui/panes/status-line.test.tsx`
Expected: FAIL — `Cannot find module './status-line.tsx'`

- [ ] **Step 3: Write `src/tui/panes/status-line.tsx`**

```tsx
import { VimModes, type TVimMode } from '../../keys/common/index.ts';
import type { ITokens } from '../theme/index.ts';

export interface IStatusLineProps {
  mode: TVimMode;
  title: string;
  unreadCount: number;
  position: number;
  total: number;
  hint: string;
  tokens: ITokens;
}

const resolveModeColour = (opts: { mode: TVimMode; tokens: ITokens }): string => {
  const { mode, tokens } = opts;

  switch (mode) {
    case VimModes.INSERT: {
      return tokens.modeInsert;
    }
    case VimModes.VISUAL: {
      return tokens.modeVisual;
    }
    default: {
      return tokens.modeNormal;
    }
  }
};

/** lualine-style: mode in section A, then context, then position. */
export const StatusLine = (props: IStatusLineProps) => {
  const { mode, title, unreadCount, position, total, hint, tokens } = props;

  const segments: string[] = [title];
  if (unreadCount > 0) {
    segments.push(`${unreadCount} unread`);
  }
  segments.push(`${position}/${total}`);
  if (hint !== '') {
    segments.push(hint);
  }

  return (
    <box flexDirection="row">
      <text fg={resolveModeColour({ mode, tokens })}>{` ${mode.toUpperCase()} `}</text>
      <text fg={tokens.dim}>{`│ ${segments.join(' │ ')}`}</text>
    </box>
  );
};
```

- [ ] **Step 4: Run and commit StatusLine**

```bash
bun test src/tui/panes/status-line.test.tsx
git add src/tui/panes/status-line.tsx src/tui/panes/status-line.test.tsx
git commit -m "Add status line pane"
```

Expected: 3 tests PASS.

- [ ] **Step 5: Write the failing ChatList test**

`src/tui/panes/chat-list.test.tsx`:

```tsx
import { test, expect } from 'bun:test';

import type { IDialogRow } from '../../core/cache/index.ts';
import { renderWithKeys } from '../../test/render.tsx';
import { buildTokens } from '../theme/index.ts';
import { ChatList } from './chat-list.tsx';

const tokens = buildTokens({ paletteName: 'sage' });

const dialogs: IDialogRow[] = [
  { peerId: 'u1', title: 'Alice', pinned: 0, unreadCount: 2, lastMessageAt: 300, topMessageId: 9 },
  { peerId: 'u2', title: 'Bob', pinned: 0, unreadCount: 0, lastMessageAt: 200, topMessageId: 4 },
  { peerId: 'c1', title: 'devs', pinned: 0, unreadCount: 7, lastMessageAt: 100, topMessageId: 2 },
];

test('lists every chat', async () => {
  const renderer = await renderWithKeys(
    <ChatList dialogs={dialogs} cursor={0} focused tokens={tokens} width={20} />,
    { width: 20, height: 10 },
  );
  await renderer.flush();
  const frame = renderer.captureCharFrame();
  expect(frame).toContain('Alice');
  expect(frame).toContain('Bob');
  expect(frame).toContain('devs');
});

test('shows unread counts', async () => {
  const renderer = await renderWithKeys(
    <ChatList dialogs={dialogs} cursor={0} focused tokens={tokens} width={20} />,
    { width: 20, height: 10 },
  );
  await renderer.flush();
  const frame = renderer.captureCharFrame();
  expect(frame).toContain('2');
  expect(frame).toContain('7');
});

test('marks the cursor row when focused', async () => {
  const renderer = await renderWithKeys(
    <ChatList dialogs={dialogs} cursor={1} focused tokens={tokens} width={20} />,
    { width: 20, height: 10 },
  );
  await renderer.flush();
  expect(renderer.captureCharFrame()).toContain('▸ Bob');
});

test('does not mark the cursor row when unfocused', async () => {
  const renderer = await renderWithKeys(
    <ChatList dialogs={dialogs} cursor={1} focused={false} tokens={tokens} width={20} />,
    { width: 20, height: 10 },
  );
  await renderer.flush();
  expect(renderer.captureCharFrame()).not.toContain('▸');
});

test('renders an empty list without crashing', async () => {
  const renderer = await renderWithKeys(
    <ChatList dialogs={[]} cursor={0} focused tokens={tokens} width={20} />,
    { width: 20, height: 10 },
  );
  await renderer.flush();
  expect(renderer.captureCharFrame()).toContain('No chats');
});
```

- [ ] **Step 6: Write `src/tui/panes/chat-list.tsx`**

```tsx
import type { IDialogRow } from '../../core/cache/index.ts';
import type { ITokens } from '../theme/index.ts';

export interface IChatListProps {
  dialogs: IDialogRow[];
  cursor: number;
  focused: boolean;
  tokens: ITokens;
  width: number;
}

const MARKER_WIDTH = 2;
const BADGE_WIDTH = 4;
const MINIMUM_NAME_WIDTH = 4;

export const ChatList = (props: IChatListProps) => {
  const { dialogs, cursor, focused, tokens, width } = props;

  if (dialogs.length === 0) {
    return (
      <box flexDirection="column" width={width}>
        <text fg={tokens.dim}>No chats</text>
      </box>
    );
  }

  const nameWidth = Math.max(MINIMUM_NAME_WIDTH, width - MARKER_WIDTH - BADGE_WIDTH);

  return (
    <box flexDirection="column" width={width}>
      {dialogs.map((dialog, index) => {
        const selected = index === cursor;
        const marker = selected && focused ? '▸ ' : '  ';
        const name =
          dialog.title.length > nameWidth ? `${dialog.title.slice(0, nameWidth - 1)}…` : dialog.title;
        const badge = dialog.unreadCount > 0 ? String(dialog.unreadCount) : '';
        const padding = ' '.repeat(Math.max(1, nameWidth - name.length + 1));

        return (
          <text
            key={dialog.peerId}
            fg={selected ? tokens.chatActive : tokens.foreground}
            bg={selected ? tokens.messageCursor : undefined}
          >
            {marker}
            {name}
            {padding}
            <span fg={tokens.chatUnread}>{badge}</span>
          </text>
        );
      })}
    </box>
  );
};
```

- [ ] **Step 7: Run and commit ChatList**

```bash
bun test src/tui/panes/chat-list.test.tsx
git add src/tui/panes/chat-list.tsx src/tui/panes/chat-list.test.tsx
git commit -m "Add chat list pane"
```

Expected: 5 tests PASS.

- [ ] **Step 8: Write the failing MessageView test**

`src/tui/panes/message-view.test.tsx`:

```tsx
import { test, expect } from 'bun:test';

import type { IMessageRow } from '../../core/cache/index.ts';
import { renderWithKeys } from '../../test/render.tsx';
import { buildTokens } from '../theme/index.ts';
import { MessageView } from './message-view.tsx';

const tokens = buildTokens({ paletteName: 'sage' });
const resolveSenderName = (opts: { fromId: string | null }): string =>
  opts.fromId === 'me' ? 'me' : 'Alice';

const messages: IMessageRow[] = [1, 2, 3, 4].map(id => ({
  peerId: 'u1', id, fromId: id === 3 ? 'me' : 'u1', date: id * 100, text: `msg${id}`, out: id === 3 ? 1 : 0,
}));

test('shows sender and text for each message', async () => {
  const renderer = await renderWithKeys(
    <MessageView messages={messages} cursor={3} focused tokens={tokens} resolveSenderName={resolveSenderName} />,
    { width: 50, height: 10 },
  );
  await renderer.flush();
  const frame = renderer.captureCharFrame();
  expect(frame).toContain('msg1');
  expect(frame).toContain('msg4');
  expect(frame).toContain('Alice');
  expect(frame).toContain('me');
});

// Mirrors relativenumber + number, so 3j is obvious before it is typed.
test('the gutter shows relative distance, absolute on the cursor row', async () => {
  const renderer = await renderWithKeys(
    <MessageView messages={messages} cursor={3} focused tokens={tokens} resolveSenderName={resolveSenderName} />,
    { width: 50, height: 10 },
  );
  await renderer.flush();
  const lines = renderer.captureCharFrame().split('\n');
  expect(lines[0]).toContain('3');
  expect(lines[1]).toContain('2');
  expect(lines[2]).toContain('1');
  expect(lines[3]).toContain('4');
});

test('marks the cursor row when focused', async () => {
  const renderer = await renderWithKeys(
    <MessageView messages={messages} cursor={1} focused tokens={tokens} resolveSenderName={resolveSenderName} />,
    { width: 50, height: 10 },
  );
  await renderer.flush();
  expect(renderer.captureCharFrame()).toContain('▸');
});

test('renders an empty history without crashing', async () => {
  const renderer = await renderWithKeys(
    <MessageView messages={[]} cursor={0} focused tokens={tokens} resolveSenderName={resolveSenderName} />,
    { width: 50, height: 10 },
  );
  await renderer.flush();
  expect(renderer.captureCharFrame()).toContain('No messages');
});
```

- [ ] **Step 9: Write `src/tui/panes/message-view.tsx`**

```tsx
import type { IMessageRow } from '../../core/cache/index.ts';
import type { ITokens } from '../theme/index.ts';

export interface IMessageViewProps {
  messages: IMessageRow[];
  cursor: number;
  focused: boolean;
  tokens: ITokens;
  resolveSenderName: (opts: { fromId: string | null }) => string;
}

const GUTTER_WIDTH = 4;
const SENDER_WIDTH = 8;

export const MessageView = (props: IMessageViewProps) => {
  const { messages, cursor, focused, tokens, resolveSenderName } = props;

  if (messages.length === 0) {
    return (
      <box flexDirection="column">
        <text fg={tokens.dim}>No messages</text>
      </box>
    );
  }

  return (
    <box flexDirection="column">
      {messages.map((message, index) => {
        const selected = index === cursor;
        // Hybrid numbering as in relativenumber + number: the cursor row shows
        // its absolute index, every other row its distance from the cursor.
        const gutter = selected ? String(index + 1) : String(Math.abs(index - cursor));
        const marker = selected && focused ? '▸' : ' ';
        const sender = resolveSenderName({ fromId: message.fromId })
          .slice(0, SENDER_WIDTH)
          .padEnd(SENDER_WIDTH);

        return (
          <text
            key={message.id}
            fg={message.out === 1 ? tokens.messageOwn : tokens.messageOther}
            bg={selected ? tokens.messageCursor : undefined}
          >
            {marker}
            <span fg={tokens.dim}>{`${gutter.padStart(GUTTER_WIDTH)} `}</span>
            <span fg={tokens.dim}>{sender}</span>
            {` ${message.text}`}
          </text>
        );
      })}
    </box>
  );
};
```

- [ ] **Step 10: Write the failing Composer test**

`src/tui/panes/composer.test.tsx`:

```tsx
import { test, expect } from 'bun:test';

import { VimModes } from '../../keys/common/index.ts';
import { renderWithKeys } from '../../test/render.tsx';
import { buildTokens } from '../theme/index.ts';
import { Composer } from './composer.tsx';

const tokens = buildTokens({ paletteName: 'sage' });

test('shows a hint in normal mode when empty', async () => {
  const renderer = await renderWithKeys(
    <Composer text="" mode={VimModes.NORMAL} focused={false} tokens={tokens} />,
    { width: 50, height: 3 },
  );
  await renderer.flush();
  expect(renderer.captureCharFrame()).toContain('press i to write');
});

test('shows the typed text in insert mode', async () => {
  const renderer = await renderWithKeys(
    <Composer text="on my way" mode={VimModes.INSERT} focused tokens={tokens} />,
    { width: 50, height: 3 },
  );
  await renderer.flush();
  expect(renderer.captureCharFrame()).toContain('on my way');
});

test('shows a cursor block while in insert mode', async () => {
  const renderer = await renderWithKeys(
    <Composer text="hi" mode={VimModes.INSERT} focused tokens={tokens} />,
    { width: 50, height: 3 },
  );
  await renderer.flush();
  expect(renderer.captureCharFrame()).toContain('█');
});

test('hides the hint once text has been typed', async () => {
  const renderer = await renderWithKeys(
    <Composer text="hi" mode={VimModes.NORMAL} focused={false} tokens={tokens} />,
    { width: 50, height: 3 },
  );
  await renderer.flush();
  expect(renderer.captureCharFrame()).not.toContain('press i to write');
});

test('always shows the prompt marker', async () => {
  const renderer = await renderWithKeys(
    <Composer text="" mode={VimModes.NORMAL} focused={false} tokens={tokens} />,
    { width: 50, height: 3 },
  );
  await renderer.flush();
  expect(renderer.captureCharFrame()).toContain('❯');
});
```

- [ ] **Step 11: Write `src/tui/panes/composer.tsx`**

```tsx
import { VimModes, type TVimMode } from '../../keys/common/index.ts';
import type { ITokens } from '../theme/index.ts';

export interface IComposerProps {
  text: string;
  mode: TVimMode;
  focused: boolean;
  tokens: ITokens;
}

export const Composer = (props: IComposerProps) => {
  const { text, mode, focused, tokens } = props;

  const showHint = text === '' && mode !== VimModes.INSERT;
  const cursor = mode === VimModes.INSERT && focused ? '█' : '';

  return (
    <box flexDirection="row" border borderColor={tokens.border}>
      <text fg={tokens.modeInsert}>{'❯ '}</text>
      {showHint ? (
        <text fg={tokens.dim}>press i to write…</text>
      ) : (
        <text fg={tokens.foreground}>
          {text}
          {cursor}
        </text>
      )}
    </box>
  );
};
```

- [ ] **Step 12: Write `src/tui/panes/index.ts`**

```ts
export * from './chat-list.tsx';
export * from './composer.tsx';
export * from './message-view.tsx';
export * from './status-line.tsx';
```

- [ ] **Step 13: Run everything and commit**

```bash
bun test src/tui/
bun run typecheck
git add src/tui/panes/
git commit -m "Add message view and composer panes"
```

Expected: all pane tests PASS (3 + 5 + 4 + 5), typecheck clean.

---

### Task 16: Action reducer and App

Where the three units meet. The tests prove an end-to-end keystroke path: a key
goes through the engine, produces an action, mutates the store, and changes the
frame.

**Files:**
- Create: `src/tui/action-reducer.ts`, `src/tui/app.tsx`, `src/tui/index.ts`
- Test: `src/tui/action-reducer.test.ts`, `src/tui/app.test.tsx`

**Interfaces:**
- Consumes: `VimEngineService`, `KeymapService`, `KeyNormalizerService`, `ApplicationStoreService`, all four panes
- Produces:
  - `applyAction(opts: { state: IApplicationState; action: TAction }): Partial<IApplicationState>`
  - `<App store engine keymapService keyNormalizer tokens resolveSenderName onSend onQuit onOpenChat />`

- [ ] **Step 1: Write the failing reducer test**

`src/tui/action-reducer.test.ts`:

```ts
import { test, expect } from 'bun:test';

import { ApplicationStoreService, type IApplicationState } from '../core/index.ts';
import { ActionTypes } from '../keys/common/index.ts';
import { applyAction } from './action-reducer.ts';

const buildState = (patch: Partial<IApplicationState> = {}): IApplicationState => {
  const store = new ApplicationStoreService();
  store.setState({
    patch: {
      messages: [1, 2, 3, 4].map(id => ({
        peerId: 'u1', id, fromId: 'u1', date: id * 100, text: `m${id}`, out: 0,
      })),
      ...patch,
    },
  });
  return store.getState();
};

test('cursor.move advances the message cursor', () => {
  const patch = applyAction({
    state: buildState({ messageCursor: 0 }),
    action: { type: ActionTypes.CURSOR_MOVE, unit: 'message', delta: 1 },
  });
  expect(patch.messageCursor).toBe(1);
});

test('cursor.move honours a count', () => {
  const patch = applyAction({
    state: buildState({ messageCursor: 0 }),
    action: { type: ActionTypes.CURSOR_MOVE, unit: 'message', delta: 3 },
  });
  expect(patch.messageCursor).toBe(3);
});

test('the message cursor clamps at both ends', () => {
  expect(applyAction({
    state: buildState({ messageCursor: 0 }),
    action: { type: ActionTypes.CURSOR_MOVE, unit: 'message', delta: -5 },
  }).messageCursor).toBe(0);
  expect(applyAction({
    state: buildState({ messageCursor: 3 }),
    action: { type: ActionTypes.CURSOR_MOVE, unit: 'message', delta: 9 },
  }).messageCursor).toBe(3);
});

test('cursor.edge jumps to first and last', () => {
  expect(applyAction({
    state: buildState({ messageCursor: 2 }),
    action: { type: ActionTypes.CURSOR_EDGE, unit: 'message', edge: 'first' },
  }).messageCursor).toBe(0);
  expect(applyAction({
    state: buildState({ messageCursor: 0 }),
    action: { type: ActionTypes.CURSOR_EDGE, unit: 'message', edge: 'last' },
  }).messageCursor).toBe(3);
});

test('moving with no messages stays at zero', () => {
  expect(applyAction({
    state: buildState({ messages: [], messageCursor: 0 }),
    action: { type: ActionTypes.CURSOR_MOVE, unit: 'message', delta: 1 },
  }).messageCursor).toBe(0);
});

test('composer text is appended and removed', () => {
  expect(applyAction({
    state: buildState({ composerText: 'on my ' }),
    action: { type: ActionTypes.COMPOSER_INSERT_TEXT, text: 'way' },
  }).composerText).toBe('on my way');
  expect(applyAction({
    state: buildState({ composerText: 'hix' }),
    action: { type: ActionTypes.COMPOSER_BACKSPACE },
  }).composerText).toBe('hi');
});

test('backspace on empty text is harmless', () => {
  expect(applyAction({
    state: buildState({ composerText: '' }),
    action: { type: ActionTypes.COMPOSER_BACKSPACE },
  }).composerText).toBe('');
});

test('an unknown action type is rejected rather than ignored', () => {
  expect(() =>
    applyAction({ state: buildState(), action: { type: 'nonsense' } as never }),
  ).toThrow(/\[applyAction\]/);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test src/tui/action-reducer.test.ts`
Expected: FAIL — `Cannot find module './action-reducer.ts'`

- [ ] **Step 3: Write `src/tui/action-reducer.ts`**

```ts
import { getError } from '@venizia/ignis-inversion';

import type { IApplicationState } from '../core/index.ts';
import { ActionTypes, type TAction } from '../keys/common/index.ts';

const clamp = (opts: { value: number; maximum: number }): number => {
  if (opts.maximum < 0) {
    return 0;
  }
  return Math.min(Math.max(opts.value, 0), opts.maximum);
};

/**
 * One engine action to one state patch. Pure and synchronous: actions with side
 * effects (sending, opening a chat, quitting) are handled by App, not here.
 */
export const applyAction = (opts: { state: IApplicationState; action: TAction }): Partial<IApplicationState> => {
  const { state, action } = opts;

  switch (action.type) {
    case ActionTypes.CURSOR_MOVE: {
      if (action.unit === 'message') {
        return {
          messageCursor: clamp({ value: state.messageCursor + action.delta, maximum: state.messages.length - 1 }),
        };
      }
      return {
        chatCursor: clamp({ value: state.chatCursor + action.delta, maximum: state.dialogs.length - 1 }),
      };
    }

    case ActionTypes.CURSOR_EDGE: {
      const last = (action.unit === 'message' ? state.messages.length : state.dialogs.length) - 1;
      const target = action.edge === 'first' ? 0 : clamp({ value: last, maximum: last });
      return action.unit === 'message' ? { messageCursor: target } : { chatCursor: target };
    }

    case ActionTypes.MODE_SET: {
      return { engine: { ...state.engine, mode: action.mode } };
    }

    case ActionTypes.FOCUS_SET: {
      return { engine: { ...state.engine, context: action.context } };
    }

    case ActionTypes.COMPOSER_INSERT_TEXT: {
      return { composerText: state.composerText + action.text };
    }

    case ActionTypes.COMPOSER_BACKSPACE: {
      return { composerText: state.composerText.slice(0, -1) };
    }

    // Side-effecting actions are App's to perform; the reducer has no patch.
    case ActionTypes.CHAT_OPEN:
    case ActionTypes.COMPOSER_SEND:
    case ActionTypes.APPLICATION_QUIT: {
      return {};
    }

    default: {
      throw getError({
        message: `[action-reducer][applyAction] Unknown action type | Type: ${(action as { type: string }).type}`,
      });
    }
  }
};
```

- [ ] **Step 4: Run the reducer tests and watch them pass**

Run: `bun test src/tui/action-reducer.test.ts`
Expected: PASS — 8 tests

- [ ] **Step 5: Write the failing App test**

`src/tui/app.test.tsx`:

```tsx
import { test, expect } from 'bun:test';
import { act } from 'react';

import { BindingScopes, Container } from '@venizia/ignis-inversion';

import { BindingKeys } from '../common/index.ts';
import { ApplicationStoreService } from '../core/index.ts';
import type { IDialogRow, IMessageRow } from '../core/cache/index.ts';
import { KeyNormalizerService, KeymapService, VimEngineService } from '../keys/index.ts';
import { renderWithKeys } from '../test/render.tsx';
import { buildTokens } from './theme/index.ts';
import { App } from './app.tsx';

const tokens = buildTokens({ paletteName: 'sage' });

const dialogs: IDialogRow[] = [
  { peerId: 'u1', title: 'Alice', pinned: 0, unreadCount: 2, lastMessageAt: 300, topMessageId: 3 },
];
const messages: IMessageRow[] = [1, 2, 3, 4].map(id => ({
  peerId: 'u1', id, fromId: 'u1', date: id * 100, text: `msg${id}`, out: 0,
}));

const mount = async () => {
  const container = new Container({ scope: 'AppTest' });
  container.bind({ key: BindingKeys.KEY_NORMALIZER }).toClass(KeyNormalizerService).setScope(BindingScopes.SINGLETON);
  container.bind({ key: BindingKeys.VIM_ENGINE }).toClass(VimEngineService).setScope(BindingScopes.SINGLETON);
  container.bind({ key: BindingKeys.KEYMAP }).toClass(KeymapService).setScope(BindingScopes.SINGLETON);

  const store = new ApplicationStoreService();
  store.setState({ patch: { dialogs, messages, activePeerId: 'u1', connection: 'connected' } });

  const sent: string[] = [];
  const renderer = await renderWithKeys(
    <App
      store={store}
      engine={container.get<VimEngineService>({ key: BindingKeys.VIM_ENGINE })}
      keymapService={container.get<KeymapService>({ key: BindingKeys.KEYMAP })}
      keyNormalizer={container.get<KeyNormalizerService>({ key: BindingKeys.KEY_NORMALIZER })}
      tokens={tokens}
      resolveSenderName={() => 'Alice'}
      onSend={async text => { sent.push(text); }}
      onQuit={() => {}}
      onOpenChat={async () => {}}
    />,
    { width: 70, height: 14 },
  );
  await renderer.flush();
  return { renderer, store, sent };
};

test('starts in NORMAL mode with both panes on screen', async () => {
  const { renderer } = await mount();
  const frame = renderer.captureCharFrame();
  expect(frame).toContain('NORMAL');
  expect(frame).toContain('Alice');
  expect(frame).toContain('msg1');
});

test('j moves the cursor — engine to store to render', async () => {
  const { renderer, store } = await mount();
  expect(store.getState().messageCursor).toBe(0);
  await act(async () => { renderer.mockInput.pressKey('j'); });
  await renderer.flush();
  expect(store.getState().messageCursor).toBe(1);
});

test('3j moves three messages', async () => {
  const { renderer, store } = await mount();
  await act(async () => {
    renderer.mockInput.pressKey('3');
    renderer.mockInput.pressKey('j');
  });
  await renderer.flush();
  expect(store.getState().messageCursor).toBe(3);
});

test('i enters INSERT and jk returns to NORMAL', async () => {
  const { renderer, store } = await mount();
  await act(async () => { renderer.mockInput.pressKey('i'); });
  await renderer.flush();
  expect(store.getState().engine.mode).toBe('insert');
  expect(renderer.captureCharFrame()).toContain('INSERT');

  await act(async () => {
    renderer.mockInput.pressKey('j');
    renderer.mockInput.pressKey('k');
  });
  await renderer.flush();
  expect(store.getState().engine.mode).toBe('normal');
});

test('typing in INSERT reaches the composer and does not move the cursor', async () => {
  const { renderer, store } = await mount();
  await act(async () => { renderer.mockInput.pressKey('i'); });
  await renderer.flush();
  await act(async () => { await renderer.mockInput.typeText('hey'); });
  await renderer.flush();
  expect(store.getState().composerText).toBe('hey');
  expect(store.getState().messageCursor).toBe(0);
});

test('Enter in INSERT sends the composed text', async () => {
  const { renderer, sent } = await mount();
  await act(async () => { renderer.mockInput.pressKey('i'); });
  await renderer.flush();
  await act(async () => { await renderer.mockInput.typeText('on my way'); });
  await renderer.flush();
  await act(async () => { renderer.mockInput.pressEnter(); });
  await renderer.flush();
  expect(sent).toEqual(['on my way']);
});
```

- [ ] **Step 6: Run it and watch it fail**

Run: `bun test src/tui/app.test.tsx`
Expected: FAIL — `Cannot find module './app.tsx'`

- [ ] **Step 7: Write `src/tui/app.tsx`**

```tsx
import { useSyncExternalStore } from 'react';

import { useKeyboard, useTerminalDimensions } from '@opentui/react';

import type { ApplicationStoreService, IApplicationState } from '../core/index.ts';
import { ActionTypes, VimContexts, VimModes } from '../keys/common/index.ts';
import type { KeyNormalizerService, KeymapService, VimEngineService } from '../keys/index.ts';
import { applyAction } from './action-reducer.ts';
import { ChatList, Composer, MessageView, StatusLine } from './panes/index.ts';
import type { ITokens } from './theme/index.ts';

export interface IAppProps {
  store: ApplicationStoreService;
  engine: VimEngineService;
  keymapService: KeymapService;
  keyNormalizer: KeyNormalizerService;
  tokens: ITokens;
  resolveSenderName: (opts: { fromId: string | null }) => string;
  onSend: (text: string) => Promise<void>;
  onQuit: () => void;
  onOpenChat: (opts: { peerId: string }) => Promise<void>;
}

const SIDEBAR_WIDTH = 22;
const CHROME_HEIGHT = 4;

export const App = (props: IAppProps) => {
  const { store, engine, keymapService, keyNormalizer, tokens, resolveSenderName } = props;

  const state = useSyncExternalStore(
    listener => store.subscribe({ listener }),
    store.getState,
    store.getState,
  );
  const { width, height } = useTerminalDimensions();

  useKeyboard(event => {
    const key = keyNormalizer.normalize({ event });
    const result = engine.resolve({ state: state.engine, key, keymap: keymapService.getBindings() });

    // In insert mode an unmapped printable key is text, not a missing binding.
    if (result.status === 'unmapped' && state.engine.mode === VimModes.INSERT) {
      const isPrintable = event.sequence?.length === 1 && !event.ctrl && !event.meta;
      if (isPrintable) {
        store.setState({ patch: { composerText: state.composerText + event.sequence } });
      }
      return;
    }

    if (result.status !== 'resolved') {
      store.setState({ patch: { engine: result.state } });
      return;
    }

    let patch: Partial<IApplicationState> = {};

    for (const action of result.actions) {
      patch = { ...patch, ...applyAction({ state: { ...state, ...patch }, action }) };

      switch (action.type) {
        case ActionTypes.COMPOSER_SEND: {
          const text = state.composerText;
          patch = { ...patch, composerText: '' };
          void props.onSend(text);
          break;
        }
        case ActionTypes.CHAT_OPEN: {
          const target = state.dialogs[state.chatCursor];
          if (target) {
            void props.onOpenChat({ peerId: target.peerId });
          }
          break;
        }
        case ActionTypes.APPLICATION_QUIT: {
          props.onQuit();
          break;
        }
        default: {
          break;
        }
      }
    }

    // The engine owns mode and context; action patches must not override them.
    store.setState({ patch: { ...patch, engine: result.state } });
  });

  const activeDialog = state.dialogs.find(dialog => dialog.peerId === state.activePeerId);
  const bodyHeight = Math.max(1, height - CHROME_HEIGHT);

  return (
    <box flexDirection="column" width={width} height={height} backgroundColor={tokens.background}>
      <box flexDirection="row" height={bodyHeight}>
        <box border borderColor={tokens.border} width={SIDEBAR_WIDTH}>
          <ChatList
            dialogs={state.dialogs}
            cursor={state.chatCursor}
            focused={state.engine.context === VimContexts.CHAT_LIST}
            tokens={tokens}
            width={SIDEBAR_WIDTH - 2}
          />
        </box>
        <box border borderColor={tokens.border} flexGrow={1}>
          <MessageView
            messages={state.messages}
            cursor={state.messageCursor}
            focused={state.engine.context === VimContexts.MESSAGES}
            tokens={tokens}
            resolveSenderName={resolveSenderName}
          />
        </box>
      </box>

      <Composer
        text={state.composerText}
        mode={state.engine.mode}
        focused={state.engine.context === VimContexts.COMPOSER}
        tokens={tokens}
      />

      <StatusLine
        mode={state.engine.mode}
        title={state.statusMessage ?? activeDialog?.title ?? 'no chat'}
        unreadCount={activeDialog?.unreadCount ?? 0}
        position={state.messages.length === 0 ? 0 : state.messageCursor + 1}
        total={state.messages.length}
        hint="\\ for keys"
        tokens={tokens}
      />
    </box>
  );
};
```

- [ ] **Step 8: Write `src/tui/index.ts`**

```ts
export * from './action-reducer.ts';
export * from './app.tsx';
export * from './panes/index.ts';
export * from './theme/index.ts';
```

- [ ] **Step 9: Run the App tests and the whole suite**

```bash
bun test src/tui/app.test.tsx
bun test
bun run typecheck
```

Expected: 6 App tests PASS, whole suite green, typecheck clean, boundaries clean.

If "typing in INSERT" fails, the cause is the unmapped-printable branch: confirm
`event.sequence` is the single character and that `j` reaches the `jk` binding as
a pending prefix before that branch is consulted.

- [ ] **Step 10: Commit**

```bash
git add src/tui/action-reducer.ts src/tui/action-reducer.test.ts src/tui/app.tsx src/tui/app.test.tsx src/tui/index.ts
git commit -m "Wire vim engine to store and panes in App"
```

---

### Task 17: Container, entry point and live smoke test

**Files:**
- Create: `src/core/telegram-adapter.ts`, `src/container.ts`, `src/main.ts`, `scripts/login.ts`, `README.md`

**Interfaces:**
- Consumes: everything above
- Produces: a runnable `bun start`

`telegram-adapter.ts` is the only file that knows GramJS object shapes. Keeping
the translation in one place is what let Tasks 13 and 16 be tested without a
network.

- [ ] **Step 1: Write `src/core/telegram-adapter.ts`**

```ts
import type { TelegramClient } from 'telegram';

import type { IDialogAdapter, IRawDialog } from './dialog-service.ts';
import type { IMessageAdapter, IRawMessage } from './message-service.ts';

const DIALOG_FETCH_LIMIT = 100;

const resolvePeerType = (opts: { className: string }): IRawDialog['type'] => {
  switch (opts.className) {
    case 'Channel': {
      return 'channel';
    }
    case 'Chat': {
      return 'chat';
    }
    default: {
      return 'user';
    }
  }
};

export const buildDialogAdapter = (opts: { client: TelegramClient }): IDialogAdapter => ({
  fetchDialogs: async (): Promise<IRawDialog[]> => {
    const dialogs = await opts.client.getDialogs({ limit: DIALOG_FETCH_LIMIT });

    return dialogs.map(dialog => {
      const entity = dialog.entity as { id: unknown; accessHash?: unknown; className: string };
      return {
        peerId: String(entity.id),
        type: resolvePeerType({ className: entity.className }),
        accessHash: entity.accessHash != null ? String(entity.accessHash) : null,
        title: dialog.title ?? dialog.name ?? '(no title)',
        username: null,
        pinned: dialog.pinned ? 1 : 0,
        unreadCount: dialog.unreadCount ?? 0,
        lastMessageAt: dialog.message?.date ?? 0,
        topMessageId: dialog.message?.id ?? 0,
      };
    });
  },
});

export const buildMessageAdapter = (opts: { client: TelegramClient }): IMessageAdapter => ({
  fetchHistory: async (historyOpts: { peerId: string; limit: number }): Promise<IRawMessage[]> => {
    const messages = await opts.client.getMessages(historyOpts.peerId, { limit: historyOpts.limit });

    return messages
      .filter(message => message.className === 'Message')
      .map(message => ({
        id: message.id,
        peerId: historyOpts.peerId,
        fromId: message.out ? 'me' : historyOpts.peerId,
        date: message.date,
        text: message.message ?? '',
        out: message.out ? 1 : 0,
      }));
  },

  send: async (sendOpts: { peerId: string; text: string }): Promise<IRawMessage> => {
    const sent = await opts.client.sendMessage(sendOpts.peerId, { message: sendOpts.text });
    return {
      id: sent.id,
      peerId: sendOpts.peerId,
      fromId: 'me',
      date: sent.date,
      text: sendOpts.text,
      out: 1,
    };
  },
});
```

- [ ] **Step 2: Write `src/container.ts`**

```ts
import { BindingScopes, Container } from '@venizia/ignis-inversion';
import type { TelegramClient } from 'telegram';

import { BindingKeys } from './common/index.ts';
import {
  ApplicationStoreService,
  DatabaseService,
  DialogService,
  MessageService,
  SessionStoreService,
  type IApplicationConfiguration,
} from './core/index.ts';
import { buildDialogAdapter, buildMessageAdapter } from './core/telegram-adapter.ts';
import { KeyNormalizerService, KeymapService, VimEngineService } from './keys/index.ts';

export const buildContainer = (opts: {
  configuration: IApplicationConfiguration;
  client: TelegramClient;
  database: DatabaseService;
}): Container => {
  const container = new Container({ scope: 'TglowContainer' });

  container.bind({ key: BindingKeys.CONFIGURATION }).toValue(opts.configuration);
  container.bind({ key: BindingKeys.DATABASE }).toValue(opts.database);
  container.bind({ key: BindingKeys.DIALOG_ADAPTER }).toValue(buildDialogAdapter({ client: opts.client }));
  container.bind({ key: BindingKeys.MESSAGE_ADAPTER }).toValue(buildMessageAdapter({ client: opts.client }));

  container.bind({ key: BindingKeys.SESSION_STORE }).toClass(SessionStoreService).setScope(BindingScopes.SINGLETON);
  container.bind({ key: BindingKeys.APPLICATION_STORE }).toClass(ApplicationStoreService).setScope(BindingScopes.SINGLETON);
  container.bind({ key: BindingKeys.DIALOG_SERVICE }).toClass(DialogService).setScope(BindingScopes.SINGLETON);
  container.bind({ key: BindingKeys.MESSAGE_SERVICE }).toClass(MessageService).setScope(BindingScopes.SINGLETON);

  container.bind({ key: BindingKeys.KEY_NORMALIZER }).toClass(KeyNormalizerService).setScope(BindingScopes.SINGLETON);
  container.bind({ key: BindingKeys.VIM_ENGINE }).toClass(VimEngineService).setScope(BindingScopes.SINGLETON);
  container.bind({ key: BindingKeys.KEYMAP }).toClass(KeymapService).setScope(BindingScopes.SINGLETON);

  return container;
};
```

- [ ] **Step 3: Write `src/main.ts`**

```ts
import 'reflect-metadata';

import { createElement } from 'react';

import { createCliRenderer } from '@opentui/core';
import { AppContext, createRoot } from '@opentui/react';
import { isApplicationError } from '@venizia/ignis-inversion';

import { BindingKeys } from './common/index.ts';
import { buildContainer } from './container.ts';
import {
  ApplicationStoreService,
  ConfigurationService,
  DatabaseService,
  DialogService,
  MessageService,
  SessionStoreService,
  TelegramClientService,
  installFileLogger,
} from './core/index.ts';
import { KeyNormalizerService, KeymapService, VimEngineService } from './keys/index.ts';
import { App } from './tui/app.tsx';
import { buildTokens } from './tui/theme/index.ts';

const HISTORY_LIMIT = 200;

const main = async (): Promise<void> => {
  const configurationService = new ConfigurationService();

  let configuration;
  try {
    configuration = configurationService.load();
  } catch (error) {
    process.stderr.write(`${isApplicationError(error) ? error.message : String(error)}\n`);
    process.exit(1);
  }

  // Before anything can log: winston would otherwise claim stdout and corrupt
  // the alternate screen on the first logged error.
  installFileLogger({ filePath: configuration.logPath });

  const client = new TelegramClientService(new SessionStoreService()).build({ configuration });
  await client.connect();

  if (!(await client.isUserAuthorized())) {
    process.stderr.write(
      [
        'Not logged in.',
        '',
        'M1a does not include the interactive login interface — that lands with',
        'the auth panes in plan M1b. Authorise once with:',
        '',
        '  bun run scripts/login.ts',
        '',
      ].join('\n'),
    );
    process.exit(1);
  }

  new TelegramClientService(new SessionStoreService()).persistSession({ client, configuration });

  const database = new DatabaseService();
  database.open({ filePath: configuration.cachePath });

  const container = buildContainer({ configuration, client, database });
  const store = container.get<ApplicationStoreService>({ key: BindingKeys.APPLICATION_STORE });
  const dialogService = container.get<DialogService>({ key: BindingKeys.DIALOG_SERVICE });
  const messageService = container.get<MessageService>({ key: BindingKeys.MESSAGE_SERVICE });

  store.setState({ patch: { connection: 'connected' } });
  await dialogService.sync();

  const firstDialog = store.getState().dialogs[0];
  if (firstDialog) {
    await messageService.loadHistory({ peerId: firstDialog.peerId, limit: HISTORY_LIMIT });
  }

  const renderer = await createCliRenderer({});
  const root = createRoot(renderer);

  const quit = (): void => {
    renderer.destroy();
    database.close();
    void client.destroy();
    process.exit(0);
  };

  root.render(
    createElement(
      AppContext.Provider,
      { value: { keyHandler: renderer.keyInput, renderer } },
      createElement(App, {
        store,
        engine: container.get<VimEngineService>({ key: BindingKeys.VIM_ENGINE }),
        keymapService: container.get<KeymapService>({ key: BindingKeys.KEYMAP }),
        keyNormalizer: container.get<KeyNormalizerService>({ key: BindingKeys.KEY_NORMALIZER }),
        tokens: buildTokens({ paletteName: configuration.palette }),
        resolveSenderName: (opts: { fromId: string | null }) =>
          opts.fromId === 'me' ? 'me' : (firstDialog?.title ?? 'them'),
        onSend: async (text: string): Promise<void> => {
          const peerId = store.getState().activePeerId;
          if (peerId) {
            await messageService.send({ peerId, text });
          }
        },
        onQuit: quit,
        onOpenChat: async (opts: { peerId: string }): Promise<void> => {
          await messageService.loadHistory({ peerId: opts.peerId, limit: HISTORY_LIMIT });
        },
      }),
    ),
  );
};

await main();
```

- [ ] **Step 4: Write `scripts/login.ts`**

```ts
import { ConfigurationService, SessionStoreService, TelegramClientService } from '../src/core/index.ts';

const configuration = new ConfigurationService().load();
const clientService = new TelegramClientService(new SessionStoreService());
const client = clientService.build({ configuration });

await client.start({
  phoneNumber: async () => prompt('Phone number (with country code): ') ?? '',
  password: async () => prompt('Two-factor password: ') ?? '',
  phoneCode: async () => prompt('Code you just received: ') ?? '',
  onError: error => {
    console.error(error.message);
  },
});

clientService.persistSession({ client, configuration });
console.log('Logged in. Session saved to', configuration.sessionPath);
await client.destroy();
```

- [ ] **Step 5: Write `README.md`**

````markdown
# tglow

A vim-native Telegram client for the terminal, themed with devglow and built to
the IGNIS Code Style Standard.

## Setup

1. Get `api_id` and `api_hash` from <https://my.telegram.org> (log in, then
   "API development tools"). This cannot be automated — it needs your account.

2. Write them to `~/.config/tglow/config.toml`:

   ```toml
   api_id = 1234567
   api_hash = "your-hash-here"
   palette = "sage"
   ```

3. Log in once, then run:

   ```sh
   bun install
   bun run scripts/login.ts
   bun start
   ```

## Keys

Leader is `\`. The application starts in NORMAL mode — nothing you type is sent
by accident.

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

`~/.local/share/tglow/session` is equivalent to a logged-in device on your
account. It is written mode `0600` and git-ignored. Never share it.

Third-party MTProto clients can attract account restrictions if they behave
abnormally. tglow honours `FLOOD_WAIT`, does not poll aggressively, and reports
a truthful device model.

## Development

```sh
bun test          # no network or account needed
bun run typecheck
```

Conventions: `docs/superpowers/conventions/ignis-style.md`.
Design: `docs/superpowers/specs/`. Plans: `docs/superpowers/plans/`.
Logs go to `~/.local/share/tglow/tglow.log` — never stdout, which would corrupt
the alternate screen.
````

- [ ] **Step 6: Typecheck and run the full suite**

```bash
bun install
bun run typecheck
bun test
```

Expected: typecheck clean, every test green. `main.ts`, `container.ts` and
`telegram-adapter.ts` have no unit tests, so the compiler is their only check —
fix every type error before continuing.

- [ ] **Step 7: Manual smoke test — the one thing tests cannot cover**

Needs a real account and network. Everything up to here passed without either.

```bash
bun run scripts/login.ts   # once, interactive
bun start
```

Verify, in order:

1. The chat list appears on the left, devglow-coloured.
2. The most recent chat's history appears on the right.
3. `j` and `k` move the cursor; the gutter shows relative numbers.
4. `3j` jumps three messages.
5. `nf`, then `j`/`k`, then `Enter` opens a different chat.
6. `i` switches the status bar to `INSERT`; typing appears in the composer.
7. `Enter` sends — the message appears in history and on your phone.
8. `jk` returns to `NORMAL`.
9. `<C-c>` exits cleanly with the terminal restored.
10. `cat ~/.local/share/tglow/tglow.log` shows log lines, and **nothing was
    printed over the interface** while it ran.

If the terminal is left broken after exit, `renderer.destroy()` is not being
reached on the quit path. If the frame is corrupted mid-session, something
logged to stdout — `installFileLogger` is running too late or was skipped.

- [ ] **Step 8: Commit**

```bash
git add src/core/telegram-adapter.ts src/container.ts src/main.ts scripts/login.ts README.md
git commit -m "Add container wiring, entry point and setup documentation"
```

---

## Self-Review

Checked after writing, against the spec and the conventions document.

**Spec coverage for M1a's slice.** Configuration §8 → Task 8. Session at 0600
§8 → Task 9. SQLite schema §7 → Task 10. Store §3 → Task 11. Auth state machine
§8 → Task 12. Dialog list §11 → Task 13. History paging §7 → Task 13. Send §11 →
Task 13. devglow palettes and tokens §6 → Task 14. Relative message numbers §6 →
Task 15. Status bar §6 → Task 15. Vim modes, counts, prefixes §4 → Tasks 3–6.
Dependency rule §3 → Task 2's boundary tests. Error handling §9 (offline
fallback, failed send keeps text, FLOOD_WAIT surfaced) → Task 13.

**IGNIS coverage.** DI container and binding keys → Tasks 1, 5, 6, 13, 17.
`getError`/`ApplicationError` → Tasks 5, 8, 10, 12, 16. `ILogger` with a
non-stdout provider → Task 7, consumed in Tasks 11, 12, 13. Style standard
(arrow functions, `I`/`T` prefixes, kebab-case files, options objects, barrel
exports, static-readonly constants, no abbreviations, braces, `switch` defaults)
→ every task, with `docs/superpowers/conventions/ignis-style.md` as the
reference each brief points at.

**Deliberately deferred to plan M1b**, not silently dropped:

- Operators (`d`/`y`/`c`), registers, `.` repeat, `;`/`,`. Task 3's
  `IEngineState` already carries the `pending` and `count` fields these extend.
- Reply, edit, delete; rich text entities; `pts` gap recovery; mark-as-read and
  read receipts; `/` search; `<C-p>` picker; which-key popup; `:` command line.
- The interactive login interface. M1a uses `scripts/login.ts` once, which is
  why `main.ts` exits with instructions rather than prompting.
  `AuthenticationService` is already built and tested so the interface has
  something to drive.
- The remaining ten devglow palettes (structure proven with two).

**Placeholder scan.** No TBD/TODO. Every code step carries runnable code.

**Type consistency.** `IDialogRow`/`IMessageRow` are defined once in Task 10 and
used unchanged in Tasks 11, 13, 15, 16. `TAction` is defined in Task 3 and every
variant is handled by Task 16's `applyAction` switch, whose `default` throws.
`IEngineState` fields are set in Task 3 and read in Tasks 5, 6, 16. `ITokens` is
defined in Task 14 and consumed by all four panes. `BindingKeys` from Task 1 is
the only source of DI keys. `renderWithKeys` from Task 2 is used by Tasks 15–16.

**Two risks worth naming.**

1. Task 16's App test is the first place the engine, the store and OpenTUI all
   run together. If any assumption is wrong, it surfaces there — which is why
   this plan is a vertical slice rather than three horizontal layers.
2. Task 6 registers `j`/`k` in both the `'*'` and chat-list contexts. If
   `resolve` returns the first match rather than preferring the more specific
   context, chat-list navigation will silently move the message cursor instead.
   Task 6's step 5 calls this out with the fix.
