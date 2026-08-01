# IGNIS conventions for tglow

Every file in `src/` follows these. They are hard rules, not suggestions — a
change that violates one should be rejected in review, not waved through.

Source: `~/Workspace/save/venizia/ignis` —
`docs/wiki/content/best-practices/code-style-standards/` and
`.agents/knowledge/conventions/coding-style.md`.

---

## 1. The stack, with versions

Highest published version of each, verified working together on this machine.

| Package | Version | Why this one |
| --- | --- | --- |
| `typescript` | `7.0.2` | Highest stable. Typechecks IGNIS decorators cleanly — verified. |
| `@venizia/ignis-inversion` | `0.1.1-6` | Highest. DI container, `getError`, `ApplicationError`. |
| `@venizia/ignis-helpers` | `0.1.1-14` | Highest. Supplies `ApplicationLogger` / `LoggerFactory` / `ILogger`. |
| `@hono/zod-openapi` | `1.5.1` | **Required transitively by helpers**, not used by tglow directly — see below. |
| `hono` | `4.12.33` | Peer of `@hono/zod-openapi`. |
| `@opentui/core` / `@opentui/react` | `0.4.5` | Only published version. |
| `react` | `19.2.8` | `@types/react` stops at 19.2.18; the 19.3 canary has no types and would break `strict`. |
| `telegram` (GramJS) | `2.26.22` | Only published version. |
| `reflect-metadata` | `0.2.2` | Required for `@inject` metadata. |

> **`@venizia/ignis-helpers` cannot be imported without `@hono/zod-openapi`.**
> Its root barrel reaches `dist/modules/error/types.js`, which requires it at
> runtime — on the `ApplicationLogger` / `LoggerFactory` path, not only on
> HTTP-specific paths. Verified in an isolated directory:
>
> ```
> Cannot find module '@hono/zod-openapi'
>   from node_modules/@venizia/ignis-helpers/dist/modules/error/types.js
> ```
>
> So `@hono/zod-openapi` and `hono` are declared as direct dependencies. tglow
> imports neither; they exist purely to satisfy that require. Cost is six extra
> packages. The `./common` subpath avoids them but carries no logger, so it
> cannot replace the root import.
>
> **Do not downgrade `@venizia/*` to `0.1.0`.** It is older than `0.1.1-6`
> despite looking newer to some tooling, and `0.1.1-6` is what the DI API in
> this document describes.

`experimentalDecorators` and `emitDecoratorMetadata` must be **inline** in
`tsconfig.json`. Bun does not resolve them through `extends`, and `@inject` is
silently dropped without them — no error, just `undefined` dependencies.

---

## 2. Verified IGNIS API

Confirmed by running `docs/superpowers/probes/04-ignis-di-logger.test.ts`.
Do not re-derive these; several differ from what the docs imply.

```typescript
// Container — every method takes an options object.
const container = new Container({ scope: 'TglowContainer' });
container.bind({ key: BindingKeys.STORE }).toClass(Store).setScope(BindingScopes.SINGLETON);
container.bind({ key: BindingKeys.CONFIGURATION }).toValue(configuration);
const store = container.get<IStore>({ key: BindingKeys.STORE });
```

- **`@injectable` does not exist in `0.1.1-6`.** It was removed. Scope is set on
  the binding with `.setScope(...)`, not by decorating the class. Only `@inject`
  remains, for constructor parameters.
- `@inject({ key })` — an options object, not a bare key.
- `BindingScopes.SINGLETON` / `.TRANSIENT`. `BindingValueTypes.CLASS|VALUE|PROVIDER`.
- `getError({ message })` returns an `ApplicationError` with `statusCode` 400.

```typescript
// Logger — get() takes a BARE STRING. Passing an options object silently
// produces a logger scoped "[object Object]" with no error.
const logger: ILogger = ApplicationLogger.get('TelegramClient');
logger.for('connect').error('Could not connect | Reason: %s', reason);
```

`ILogger` is `debug | info | warn | error | emerg | log(level, …) | for(method)`.

### Terminal tests: wrap every key press in `act()`

```ts
await act(async () => { renderer.mockInput.pressKey('j'); });
await renderer.flush();
```

Without `act()` the React state update does not flush, so the next assertion
reads a stale frame. Nothing errors and nothing warns in the result — the test
simply passes having checked nothing. Verified by controlled comparison; it
holds for `testRender` and for `src/test/render.tsx` alike.

### The logger must never write to stdout

A TUI owns the alternate screen. The default provider is winston writing to
stdout, which corrupts the frame on the first logged error. `main.ts` must
register a file-writing provider **before anything else can log**:

```typescript
LoggerFactory.use({ provider: { get: (scope: string): ILogger => buildFileLogger({ scope }) } });
```

`ILoggerProvider` is exactly `{ get(scope: string): ILogger }`.

---

## 3. Naming

| Thing | Rule | Example |
| --- | --- | --- |
| Interface | `I` prefix | `IMessageStore`, `ILogger` |
| Type alias | `T` prefix | `TVimMode`, `TBindingKey` |
| Class | PascalCase + suffix | `MessageRepository`, `TelegramClientService` |
| File | kebab-case | `chat-list.tsx`, `vim-engine.ts` |
| Private **data** field | underscore prefix | `_messages`, `_container`, `_logger` |
| Private **method** | no prefix | `matchesMode`, `accumulateCount` |
| Binding key | `@tglow/[component]/[feature]` | `@tglow/core/message-store` |
| Constants | `static readonly` class, never `enum` | `class VimModes { static readonly NORMAL = 'normal'; }` |
| Barrel | `index.ts` at every folder level | `src/core/index.ts` |
| Scope name | `ClassName.name` | `ApplicationLogger.get(MessageService.name)` |

**Never abbreviate.** `configuration` not `cfg`. `database` not `db`. `message`
not `msg`. `repository` not `repo`. This applies to type parameters too:
`<TDocument>` not `<TDoc>`.

Because every member is an arrow-function property, "field" and "method" are the
same construct syntactically. The split above is by role: state carries `_`,
behaviour does not. IGNIS's own code is inconsistent here (`BaseLogger._scope`
versus `Binding.bindScope`), so this is tglow's ruling, not an inherited one.

---

## 4. Functions

- **Arrow functions only.** Never `function` declarations — including React
  components: `export const ChatList = (props: IChatListProps) => …`.
- **Named exports only.** No default exports.
- **Explicit return types** on every function.
- **Options object** for arguments, conventionally named `opts`:
  `resolve(opts: { state: IEngineState; key: IKey })`, not `resolve(state, key)`.
  A single unambiguous argument may stay positional (`ApplicationLogger.get(scope)`
  is IGNIS's own precedent).
- Naming verbs: `generate*`, `build*`, `to*`, `is*`, `extract*`, `resolve*`.

---

## 5. Control flow

- **Always braces.** No single-statement `if` without `{ }`.
- **Early return over nesting.** Guard clauses at the top.
- **`switch` needs braces per case and a `default`** that throws via `getError`.
  Even on an exhaustive union — the `default` catches values that arrive from
  outside the type system.
- **No silent catch.** Every `catch` logs through a scoped logger before it
  does anything else:

```typescript
try {
  await this.client.connect();
} catch (error) {
  this.logger.for(this.connect.name).error('Could not connect | Reason: %s', error);
  throw getError({ message: '[TelegramClientService][connect] Connection failed' });
}
```

- **Never `new Error`.** Always `getError({ message })` or `ApplicationError`.
- Error message format: `[ClassName][method] Message`.
- Log message format: `[method] Message | Key: %s`.

---

## 6. Types

- **Avoid `any` and `unknown`.** Derive types; never duplicate a shape that can
  be inferred. Where a cast is truly unavoidable, prefer a plain `as any` over
  `as unknown as T` — the simple cast is honest about being an escape hatch.
- Import order: Node built-ins → third-party → internal absolute → relative,
  separated by blank lines.

---

## 7. Comments

A comment earns its place only by stating something the code cannot show: an
invariant, a non-obvious constraint, why a shortcut is safe. Not a changelog,
not a restatement of the line below, not a note to a reviewer.

---

## 8. Where IGNIS stops

tglow uses `@venizia/ignis-inversion` and `@venizia/ignis-helpers`. It does
**not** use `@venizia/ignis` (core), `ignis-boot`, or `ignis-filter`.

Those are HTTP server machinery — controllers, routes, OpenAPI generation,
Drizzle repositories, glob-based bootstrapping. tglow has no HTTP surface, no
routes, and a single-file SQLite cache rather than a relational ORM. Importing
them would add a web framework to a terminal application to look compliant.

The style standard, the DI container, `getError`/`ApplicationError`, and
`ILogger` apply everywhere. That is the whole of IGNIS that this project has
work for.
