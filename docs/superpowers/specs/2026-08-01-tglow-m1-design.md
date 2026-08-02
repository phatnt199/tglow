# tglow — a vim-native Telegram client for the terminal

**Date:** 2026-08-01
**Status:** M1 design, approved for planning
**Scope of this document:** milestone M1 in implementable detail; M2–M4 as roadmap.

---

## 1. What this is

A Telegram client that runs in the terminal, driven entirely by vim keys, styled
with the devglow palette so it sits alongside the author's neovim, zsh, alacritty
and superfile setup as one visual system.

It logs in as a **real user account** over MTProto — not a bot — so it shows every
DM, group and channel with full history.

Design stance: **an editor that happens to chat.** The app starts in NORMAL mode.
Nothing you type is sent by accident.

### Success criteria for M1

A person can launch `tglow`, log in with their phone number, see their chat list,
read history, send a message, receive one live, reply to it, edit it, delete it —
and never touch the mouse or an arrow key.

---

## 2. Verified technical foundation

Every load-bearing assumption below was **tested on this machine**, not assumed.
Probe source: `docs/superpowers/probes/` (ported from the brainstorming scratchpad).

| Claim | How it was verified | Result |
| --- | --- | --- |
| GramJS imports under Bun | `import("telegram")` | PASS — v2.26.22 |
| MTProto crypto works on Bun | AES-IGE encrypt/decrypt round-trip | PASS |
| Sockets + DH handshake work | live TCP connect to a Telegram DC | PASS |
| Auth key + session serialize | `client.session.save()` | PASS — 369-char session |
| Live RPC round-trip | `help.getNearestDc` | PASS — returned `country=VN` |
| OpenTUI loads on Bun | `import("@opentui/core")` | PASS — 257 exports |
| OpenTUI React bindings load | `import("@opentui/react")` | PASS |
| WebP decode + resize | `sharp` 0.35.3 lossless round-trip | PASS |
| Half-block sticker rendering | truecolor `▀` render of a real WebP | PASS |
| `.tgs` unwrapping | `Bun.gunzipSync` → Lottie JSON | PASS — zero deps |

Two negative findings that **constrain the design**:

- **Alacritty 0.18.0-dev supports no image protocol.** Confirmed by inspecting
  terminfo: no sixel, no Kitty graphics. All image output must therefore be
  Unicode half-blocks (`▀`, fg = top pixel, bg = bottom pixel, 2 px per cell).
- **No `ffmpeg`/`chafa`/`magick` on the system.** Decoding must happen in-process.
  Consequence: `.webm` video stickers can show a still thumbnail only (VP9 decode
  would require a new native dependency).

**Chosen stack:** Bun 1.3 · TypeScript 7.0.2 · `@opentui/react` 0.4.5 · React
19.2.8 · `telegram` (GramJS) 2.26.22 · `bun:sqlite` (built in, zero deps) ·
`@venizia/ignis-inversion` 0.1.1-6 · `@venizia/ignis-helpers` 0.1.1-14 ·
`drizzle-orm` 0.45.2 · `drizzle-kit` 0.31.10 · `sharp` (M2).

**On the data layer.** §7's schema is expressed as Drizzle tables, and
`drizzle-kit generate` diffs them to produce migrations. The original plan used
`CREATE TABLE IF NOT EXISTS`, which is a no-op against a database that already
exists — a column added in M2 would never have reached anyone who had already
run the application, silently. Drizzle is also what IGNIS uses, so this moves
toward its stack. Pinned to 0.45.2/0.31.10, not the 1.0 RC, whose
`drizzle-kit generate` crashes with `SQLiteSyncDialect is not a constructor`.

**On tests.** Every test lives under `__tests__/`, mirroring `src/`, so source
directories contain only source. `tsconfig.json`'s `include` covers both — with
`src` alone, typecheck silently stops covering tests.

### IGNIS

The project follows the **IGNIS Code Style Standard** throughout and uses
IGNIS's DI container, error helpers and logger. Full rules and the verified API
live in `docs/superpowers/conventions/ignis-style.md`; every task brief points
at it. Additional verified findings:

| Claim | Result |
| --- | --- |
| `@venizia/ignis-inversion` DI under Bun | PASS — constructor injection, singleton scope |
| `getError` → `ApplicationError` | PASS — `[Class][method]` format, statusCode 400 |
| `ApplicationLogger` + custom provider | PASS — logs divertible to a file |
| TypeScript 7.0.2 with IGNIS decorators | PASS — typechecks and runs |

Three findings that shape the design:

- **`@injectable` does not exist in `0.1.1-6`.** Removed since 0.1.0. Scope is
  set on the binding via `.setScope(...)`; only `@inject` remains.
- **`ignis-helpers` cannot be imported without `@hono/zod-openapi`** at any
  version, including `0.1.1-14`. Its root barrel reaches
  `dist/modules/error/types.js`, which requires it at runtime on the
  `ApplicationLogger` path. `@hono/zod-openapi` and `hono` are therefore direct
  dependencies that tglow never imports itself — six extra packages, the price
  of a scoped logger that can be diverted off stdout. The `./common` subpath
  avoids them but carries no logger.
- **The default logger provider writes to stdout**, which corrupts a TUI's
  alternate screen. `main.ts` must register a file-writing provider before
  anything can log.

IGNIS core, boot and filter are deliberately **not** used — they are HTTP server
machinery (controllers, routes, OpenAPI, Drizzle repositories) and tglow has no
HTTP surface. See §8 of the conventions document.

TDLib was rejected: it would add a ~40 MB native binary and an FFI risk surface to
buy a local database and update-gap handling that GramJS + `bun:sqlite` give us
with no native dependency at all.

---

## 3. Architecture

### The dependency rule

Enforced by review and by a lint boundary check:

- `keys/` imports **only `@venizia/ignis-inversion`**. No Telegram, no React, no
  terminal, no I/O. It is deterministic: same state plus same key always yields
  the same actions.
- `core/` imports GramJS, `bun:sqlite` and IGNIS. It **never** imports React or
  OpenTUI.
- `tui/` imports `core` (read state, dispatch actions) and `keys` (types only).
  It **never** imports `telegram`.
- `main.ts` builds the container and wires the three together.

Actions flow down; state flows up. One direction only.

Every unit is a class bound into the IGNIS container and resolved by binding
key, so a test can swap any dependency for a fake without touching the code
under test. Services take their collaborators through `@inject` on constructor
parameters rather than reaching for module-level singletons.

**On the vim engine's determinism.** Its correctness is entirely mechanical —
counts, operator+motion composition, mode transitions — so it must be drivable
from a test with no terminal and no account. Being a container-resolved service
does not compromise that: `VimEngineService` takes no collaborators, so a test
resolves it from a container and asserts on returned actions. The rule that
matters is the import restriction above, and Task 2's boundary test enforces it.

### Layout

```
src/
├── common/
│   └── binding-keys.ts       every DI key, one static-readonly class
│
├── keys/                    deterministic — no Telegram, React or I/O
│   ├── common/              constants (VimModes, ActionTypes) + types
│   ├── key-normalizer.ts    terminal event → canonical key string
│   ├── vim-engine.ts        resolve(...) → { state, actions }
│   └── keymap.ts            the binding table (single source of truth)
│
├── core/                    headless — runs and is tested without a terminal
│   ├── common/              IApplicationConfiguration
│   ├── configuration.ts     ~/.config/tglow/config.toml
│   ├── logger-provider.ts   file-writing ILogger; keeps logs off stdout
│   ├── session-store.ts     session persistence at 0600
│   ├── telegram-client.ts   GramJS lifecycle
│   ├── authentication.ts    phone → code → 2FA → ready state machine
│   ├── application-store.ts observable state + subscribers
│   ├── dialog-service.ts    chat list: fetch, cache, order
│   ├── message-service.ts   history paging, send
│   ├── telegram-adapter.ts  the only file that knows GramJS shapes
│   └── cache/
│       ├── schema.ts        Drizzle table definitions
│       ├── migrate.ts       applies generated migrations on open
│       └── database.ts      DatabaseService over drizzle-orm/bun-sqlite
│
├── tui/                     OpenTUI React — dumb by design
│   ├── panes/               status-line · chat-list · message-view · composer
│   ├── theme/               devglow palettes → semantic tokens
│   ├── action-reducer.ts
│   └── app.tsx
│
├── container.ts             builds the IGNIS container
└── main.ts

__tests__/                   mirrors src/; source dirs hold only source
drizzle/                     generated migrations, committed
```

### Data flow

```
keypress ──→ keys/engine (pure fn) ──→ Action[] ──→ dispatch
                                                       │
                                                       ▼
                                         core: mutate store, call Telegram
                                                       │
        React re-render  ◄─── store.emit  ◄────────────┤
                                                       │
                        Telegram update ──→ core/updates
```

### Why this shape

`keys/engine` being a **pure function** is the load-bearing decision. Full vim —
counts, operator+motion composition, registers, `.` repeat — is a state machine,
and state machines are only tractable when you can drive them from a test with no
terminal and no network. Bolting vim onto React keypress handlers is how these
projects collapse under their own weight.

`core/` running headless means "send a message, receive an update, persist it" is
testable in CI against a mock transport.

Each file stays small enough to hold in one context window.

---

## 4. The vim engine

### Modes

| Mode | Purpose | Enter | Leave |
| --- | --- | --- | --- |
| `NORMAL` | navigate chats and messages | *default at launch* | — |
| `INSERT` | type into the composer | `i` `a` `o` | `jk` or `Esc` → composer-NORMAL |
| `VISUAL` | select a message range | `v` `V` | `Esc` |
| `COMMAND` | `:` ex commands | `:` | `Enter` / `Esc` |
| `SEARCH` | `/` incremental search | `/` `?` | `Enter` / `Esc` |

### Two vim contexts

This is the subtle part. There are two distinct "buffers":

1. **App-level** — the message list is the buffer, each *message* is a line.
   `j`/`k` move between messages, `dd` deletes a message, `yy` yanks its text.
2. **Composer-level** — the text being typed is a buffer with ordinary vim text
   editing: `w` `b` `0` `$` `dw` `ciw` `x` `A` `I`.

Transition model:

```
 NORMAL (messages) ──i/a──► INSERT (composer, typing)
        ▲                        │
        │                       jk
        │                        ▼
        └──── Esc ──────  NORMAL (composer, text editing)
```

Both `jk` and `Esc` leave INSERT for composer-NORMAL — they are equivalent, as in
vim. A further `Esc` from composer-NORMAL returns focus to the message list.

This is what "fully vim" requires: a half-measure where `jk` jumped straight out
to the message list would make editing a multi-line draft impossible.

### Engine state

```ts
interface EngineState {
  mode: Mode;
  context: Context;              // "chatlist" | "messages" | "composer" | "overlay"
  pending: Key[];                // unresolved prefix, e.g. [d] awaiting a motion
  count: number | null;          // the 3 in 3j
  operator: OperatorId | null;   // d | y | c while operator-pending
  register: string | null;       // set by "
  lastChange: Action[] | null;   // powers .
  lastFind: { motion: string; char: string } | null;  // powers ; and ,
}

function resolve(
  state: EngineState,
  key: Key,
  keymap: Keymap,
): { state: EngineState; actions: Action[]; status: "pending" | "resolved" | "unmapped" };
```

Pure. No side effects. Every branch reachable from a unit test.

### Bindings are declarative

```ts
interface Binding {
  context: Context | "*";
  mode: Mode | Mode[];
  keys: string;               // "dd", "<C-p>", "\\nv"
  action: Action | ((ctx: BindingCtx) => Action[]);
  countable?: boolean;        // may be prefixed with a count
  desc: string;               // powers the which-key popup
}
```

The `desc` field mirrors the author's `003-keymaps.lua`, where every mapping
carries a description. One table drives both dispatch and the `\` popup, so they
can never drift apart.

---

## 5. Keymap — built on existing muscle memory

Leader is `\`, matching `vim.g.mapleader`. Mappings deliberately echo the
author's neovim config so the keys are already learned.

### Navigation (NORMAL)

| Key | Action | Echoes |
| --- | --- | --- |
| `j` / `k` | next / previous message | vim |
| `3j` | down 3 messages | counts |
| `gg` / `G` | oldest loaded / newest | vim |
| `<C-d>` / `<C-u>` | half page | vim |
| `<A-j>` / `<A-k>` | scroll view one line | their `<A-j>`/`<A-k>` |
| `zz` | centre current message | vim |
| `<C-w>h/l` | move focus between panes | vim windows |
| `nf` | focus chat list | their `nf` → NvimTreeFocus |
| `\nv` | toggle chat-list sidebar | their `<leader>nv` → NvimTreeToggle |
| `]u` / `[u` | next / previous **unread** chat | their `]q`/`[q` pattern |
| `]m` / `[m` | next / previous **mention** | same pattern |

### Message actions (NORMAL)

| Key | Action |
| --- | --- |
| `i` / `a` | write (INSERT in composer) |
| `r` | reply to message under cursor |
| `e` | edit own message |
| `dd` | delete message (`3dd` deletes 3) |
| `yy` | yank message text |
| `\y` | yank to **system clipboard** via OSC 52 |
| `K` | message details / sender info — *echoes LSP hover* |
| `gd` | jump to the message this replies to — *echoes goto-definition* |
| `gr` | show replies to this message — *echoes LSP references* · **M3** |
| `v` / `V` | visual select a message range |

`\y` uses OSC 52, which works because the author's alacritty sets
`terminal.osc52 = "OnlyCopy"` and tmux advertises `clipboard`.

### Search and jump

| Key | Action | Echoes |
| --- | --- | --- |
| `<C-p>` | fuzzy jump to chat | their `<C-p>` → Telescope git_files |
| `/` `?` `n` `N` | incremental search over **cached** history | vim |
| `:` | ex command line | vim |
| `\` | which-key popup | their which-key "modern" preset |
| `<C-f>` | full-text search in chat (server + FTS5) · **M3** | their `<C-f>` → buffer fuzzy find |
| `<C-r>` | global message search · **M3** | their `<C-r>` → Telescope find_files |

`/` in M1 searches what is already cached, using a `LIKE` over the `messages`
table — cheap, offline, and enough that the key does not feel broken. `<C-f>`
escalates to server-side and FTS5 search in M3.

### Ex commands (M1 subset)

`:q` quit · `:w` send draft · `:e <chat>` open chat · `:set palette=<name>` ·
`:read` mark chat read · `:reload` reconnect.

---

## 6. Interface and theming

### Layout

```
┌─ chats ───────┐┌─ Alice ─────────────────────────────────┐
│  Alice      2 ││  3  Alice   did you push it?             │
│  Bob          ││  2  me      not yet                    ✓✓│
│  devs       7 ││  1  Alice   ok ping me                   │
│  saved        ││▶ 0  Alice   morning!                     │
└───────────────┘└──────────────────────────────────────────┘
┌────────────────────────────────────────────────────────────┐
│ ❯ press i to write…                                        │
└────────────────────────────────────────────────────────────┘
 NORMAL │ Alice │ 3 unread │ 4/312 │ \ for keys
```

The status bar is M1-accurate: mode, chat, unread count, cursor position in the
loaded history, hint. Presence (`online`, `typing…`) joins it in M2.

**Relative message numbers.** The gutter shows relative distance from the cursor,
exactly like `relativenumber` + `number` in the author's config — so `3j` is
visually obvious before you type it. The cursor row shows absolute position.

Other borrowed settings: `scrolloff = 8` equivalent, cursorline on the selected
message, `│` pane separators (their `fillchars`), Nerd Font icons, lualine-style
status bar with the mode in section A.

### Theme

All 12 devglow palettes ship as typed TS objects with the same 17-key structure
as `devglow/lua/devglow/palettes/*.lua` (12 colours + 5 shades). **sage** is the
default, matching the active alacritty theme. Switch live with `:set palette=ember`.

Semantic tokens map palette → role, so palettes stay swappable:

| Token | sage value | Use |
| --- | --- | --- |
| `mode.normal` | `TEAL #7DB9B6` | status bar in NORMAL |
| `mode.insert` | `GOLD #EBC17A` | status bar in INSERT |
| `mode.visual` | `PINK #D68C8C` | status bar in VISUAL |
| `chat.unread` | `GOLD` | unread badge |
| `msg.own` | `TEAL` | your messages |
| `msg.other` | `FOREGROUND #E6E6E6` | their messages |
| `msg.cursor` | `DARK_03 #383838` | cursorline |
| `text.code` | `GREEN #87AFAF` | code entities |
| `text.link` | `SKY #7EAAC7` | link entities |
| `text.spoiler` | `DARK_03` on `DARK_03` | hidden until revealed |
| `state.error` | `RED #AF5F5F` | errors, failed sends |
| `border` | `DARK_02 #282828` | pane borders |

---

## 7. Data and sync

### SQLite schema (`bun:sqlite`)

```sql
CREATE TABLE peers (            -- users, groups, channels
  id            TEXT PRIMARY KEY,
  type          TEXT NOT NULL,  -- user | chat | channel
  access_hash   TEXT,
  title         TEXT NOT NULL,
  username      TEXT,
  is_self       INTEGER DEFAULT 0,
  is_bot        INTEGER DEFAULT 0,
  status        TEXT,           -- online | offline | recently | ...  (M2 displays)
  status_seen_at INTEGER,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE dialogs (
  peer_id            TEXT PRIMARY KEY REFERENCES peers(id),
  pinned             INTEGER DEFAULT 0,
  unread_count       INTEGER DEFAULT 0,
  unread_mentions    INTEGER DEFAULT 0,
  read_inbox_max_id  INTEGER DEFAULT 0,
  read_outbox_max_id INTEGER DEFAULT 0,
  top_message_id     INTEGER,
  last_message_at    INTEGER,
  muted_until        INTEGER DEFAULT 0,
  folder_id          INTEGER DEFAULT 0      -- M4 uses this
);
CREATE INDEX idx_dialogs_order ON dialogs(pinned DESC, last_message_at DESC);

CREATE TABLE messages (
  peer_id         TEXT NOT NULL REFERENCES peers(id),
  id              INTEGER NOT NULL,
  from_id         TEXT,
  date            INTEGER NOT NULL,
  edit_date       INTEGER,
  text            TEXT,
  entities        TEXT,          -- JSON
  reply_to_msg_id INTEGER,
  fwd_from        TEXT,          -- JSON
  media_kind      TEXT,          -- null in M1; M2 populates
  media_json      TEXT,
  out             INTEGER DEFAULT 0,
  deleted         INTEGER DEFAULT 0,
  PRIMARY KEY (peer_id, id)
);
CREATE INDEX idx_messages_peer_date ON messages(peer_id, date DESC);

CREATE TABLE history_ranges (   -- which id ranges are contiguously cached
  peer_id TEXT NOT NULL,
  min_id  INTEGER NOT NULL,
  max_id  INTEGER NOT NULL,
  PRIMARY KEY (peer_id, min_id)
);

CREATE TABLE sync_state (       -- 'pts' | 'qts' | 'date' | 'seq' | 'channel:<id>:pts'
  key   TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

CREATE TABLE drafts (
  peer_id         TEXT PRIMARY KEY,
  text            TEXT,
  reply_to_msg_id INTEGER,
  updated_at      INTEGER
);
```

`history_ranges` is what makes scrollback correct: it records which id ranges are
known-contiguous, so scrolling up can tell "cached" from "never fetched" instead
of silently showing a hole.

M3 adds `CREATE VIRTUAL TABLE messages_fts USING fts5(text, content=messages)`.
The schema above is shaped so that slots in without migration pain.

### Paging

Render from SQLite first (instant, works offline), fetch from network on miss.
Keep a sliding window of ~200 messages in memory; page out beyond that.
Scrolling past the top of a contiguous range triggers `messages.getHistory`
with `offset_id`, results written to cache and the range extended.

### Live updates and gap recovery

GramJS emits updates; `core/updates.ts` normalises them, writes to SQLite, and
emits store events. `pts`/`qts`/`date`/`seq` persist in `sync_state`.

On reconnect, or when an update arrives with a `pts` beyond the expected next
value, call `updates.getDifference` (or `updates.getChannelDifference` for
channels) and replay. **This is the single most commonly skipped piece of a
Telegram client, and skipping it is why messages silently go missing.** It is in
M1 deliberately.

---

## 8. Auth and security

State machine in `core/auth.ts`:

```
start → needPhone → needCode → [needPassword] → ready
                        └── needSignUp (unregistered number: error, do not sign up)
```

The session string grants **complete access to the account** — it is equivalent
to a logged-in device. Handling:

- stored at `~/.local/share/tglow/session` with mode `0600`
- encrypted at rest with a key derived from a passphrase (scrypt); if no
  passphrase is set, the file is still `0600` and the user is warned once
- `api_id` / `api_hash` live in `~/.config/tglow/config.toml`, never in the repo
- `.gitignore` covers config, session and cache from the first commit
- logging redacts phone numbers, codes, session strings and auth keys

**Requires the user:** `api_id` and `api_hash` must be obtained by the account
owner from <https://my.telegram.org> (login required), and the phone-code login
must be completed interactively. Neither can be automated.

**Ban risk, stated plainly:** third-party MTProto clients can attract account
restrictions if they behave abnormally. Mitigations: honour `FLOOD_WAIT` strictly,
never poll aggressively, send a truthful device model/app version, and do not
auto-read or auto-join anything.

---

## 9. Error handling

| Condition | Response |
| --- | --- |
| `FLOOD_WAIT_x` | queue and retry after `x`; status bar shows a countdown |
| Network loss | exponential backoff reconnect; status shows `reconnecting…`; cached view stays readable |
| `AUTH_KEY_UNREGISTERED` / session revoked | drop session, return to login, explain why |
| `pts` gap | `getDifference` replay (§7) |
| `MESSAGE_ID_INVALID` on edit/delete | refresh that message from server, report to user |
| SQLite corruption | rebuild cache from network; never block startup on it |
| Send failure | message stays in composer marked failed in `state.error`; retry with `<C-r>` |

Principle: the UI never crashes on a Telegram error. Every failure resolves to a
status-bar message and a recoverable state.

---

## 10. Testing

| Unit | Method | Needs an account? |
| --- | --- | --- |
| `keys/` | exhaustive unit tests: every mode transition, counts, operator+motion pairs, registers, `.` repeat | no |
| `core/` | integration tests against a **mock GramJS transport** + real in-memory SQLite | no |
| `core/updates` | replay recorded update sequences incl. deliberate `pts` gaps | no |
| `tui/` | snapshot tests rendering OpenTUI to a buffer and asserting the frame | no |
| end-to-end | manual, against a real account | yes |

CI runs everything except end-to-end. TDD throughout: the `keys/` engine in
particular is written test-first, since its correctness is entirely mechanical.

---

## 11. M1 scope boundary

**In:** config · auth + session + encryption · connection with reconnect ·
SQLite cache + migrations · dialog list with ordering and unread counts · message
history with paging · send text · **rich text entities** (bold, italic, code,
link, spoiler) · **reply, edit, delete** · live updates · **pts gap recovery** ·
mark as read · read receipts · full vim engine (modes, counts, operators,
registers, `.`) · devglow theming with all 12 palettes · status bar · which-key
popup · `<C-p>` fuzzy chat jump · `/` incremental search over cached history.

**Out (later milestones):** all media and images · stickers · reactions · voice
waveforms · typing indicators · online status display · forward · server-side and
FTS5 message search · global search · link previews · albums · polls · folders ·
archive · forum topics · threads · draft sync · scheduled messages · notifications.

Rationale: M1 is everything needed for text conversation to be genuinely usable,
plus every architectural unknown resolved. Nothing in M1 is deferrable without
making the result unusable; nothing outside it blocks the architecture.

---

## 12. Roadmap

**M2 · Sight** — half-block image renderer (proven, §2) · `stripped` instant
blurry previews · photo/video thumbnails · static `.webp` stickers · **animated
`.tgs`** via `@thorvg/lottie-player` WASM on a ~12 fps frame timer, opt-in with
`:set stickeranim` · reactions view and send, own reaction in `GOLD` · voice
message waveforms from the API's waveform bytes (`▁▂▃▅▇`) · typing indicators ·
online status. *Video `.webm` stickers remain still-only — see §2.*

**M3 · Action** — forward · in-chat message search (FTS5) · global search ·
`:` command mode expansion · link preview cards · albums / grouped media · polls ·
forwarded-from headers · contact and location messages · pinned message bar.

**M4 · Structure** — folders · archive · **forum topics** · channel comment
threads · draft sync with other Telegram clients · scheduled messages.

**Known design tension, flagged early:** forum topics introduce a third
navigation level (folder → chat → topic → messages). The two-pane layout in §6
must not assume exactly two levels. M1 therefore models navigation as a
**stack of scopes** rather than a fixed pair of panes, so M4 does not force a
rewrite.

---

## 12b. Alternatives considered: Rust and Zig

Evaluated after M1a Task 1, with the stack already proven. Decision: **stay on
Bun + TypeScript.**

**Zig — rejected.** No MTProto *client* library exists. The one serious Zig
Telegram project, `mtproto.zig`, is a proxy: it relays traffic without speaking
the client protocol. Adopting Zig means implementing RSA, AES-IGE, the DH
handshake and TL-schema codegen for ~1,500 types before the first message sends.
Note that OpenTUI's renderer is already Zig, so its rendering performance is
already in hand.

**Rust — credible, and better in exactly one place.** `grammers` 0.10.0 is
actively maintained (moved to Codeberg; releases Oct 2025, Feb 2026, Jul 2026),
`ratatui` 0.30.2 is mature, and `ratatui-image` covers sixel/kitty/iterm2/
halfblocks. Its README warns the crypto is unaudited.

The one genuine advantage is animated stickers: the `rlottie` crate (0.5.4,
updated 2026-03) wraps **Telegram's own Lottie renderer**, which is strictly
better than this spec's ThorVG-WASM plan — the single M2 component never proved
out. Performance was not a factor: a chat client is network-bound, and Bun's
startup and memory cost never matter for a long-running process.

**Why Bun won:** IGNIS is TypeScript-only. Adopting Rust discards the DI
container, `getError`/`ApplicationError`, `ILogger`, and most of the style
standard's concrete rules, which is a deliberate project requirement (§2). The
two are mutually exclusive.

**Carried into M2:** if ThorVG-WASM rasterisation proves too slow or too
inaccurate, the fallback is a **small Rust sidecar built on `rlottie`** that
rasterises `.tgs` to frames, invoked from the TUI — `rlottie`'s quality without
rewriting the client. The half-block renderer is the same algorithm in any
language, so nothing in §12's M2 plan is wasted either way.

## 13. Open questions

1. **Project name.** `tglow` is a placeholder chosen to sit in the devglow family.
2. **Animated-sticker CPU budget.** ThorVG rasterisation cost per frame at
   terminal sizes is unmeasured. M2 should benchmark before committing to a
   default frame rate; the opt-in flag exists so the default can be "off".
3. **Multi-account.** The schema has no `account_id` column. Single-account is
   assumed for M1; adding it later is a migration, not a redesign.
