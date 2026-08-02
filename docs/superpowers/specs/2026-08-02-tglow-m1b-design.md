# tglow M1b — finishing what M1 promised

**Date:** 2026-08-02
**Status:** design, approved for planning
**Predecessor:** `2026-08-01-tglow-m1-design.md` (M1a shipped as v0.1.0)

---

## 1. Why this milestone exists

M1a shipped and is in daily use. Checking the M1 spec's §11 "In" list against
`src/`, roughly half of it was never built. It was deferred to M1b deliberately
and recorded — not silently dropped — but it is still absent from something
someone now uses every day.

The most visible gap: **a link in a message renders as plain text**, because
message entities are discarded at the adapter. So does bold, so does `code`.

## 2. Scope coverage — every M1 promise, and where it lands

This table exists because three features in M1a were written in a spec and
silently dropped from the plan, and no test could catch a missing feature.
Nothing may be marked done until every row is accounted for.

| Promised in M1 §11 | M1a | M1b-1 | M1b-2 |
| --- | --- | --- | --- |
| config, auth, session, reconnect | ✅ | | |
| SQLite cache + migrations | ✅ | | |
| dialog list, ordering, unread counts | ✅ | | |
| message history with paging | ✅ | | |
| send text | ✅ | | |
| live updates | ✅ | | |
| status bar, which-key popup | ✅ | | |
| **rich text entities** (bold, italic, code, link, spoiler) | | **✅** | |
| **reply, edit, delete** | | **✅** | |
| **mark as read + read receipts** | | **✅** | |
| **`pts` gap recovery** | | **✅** | |
| **vim operators, registers, `.` repeat** | | | **✅** |
| **`<C-p>` fuzzy chat jump** | | | **✅** |
| **`/` incremental search over cached history** | | | **✅** |
| **remaining 10 devglow palettes** | | | **✅** |

M1b-1 is the message layer — what you hit reading and answering. M1b-2 is the
editor layer. **This document specs both; only M1b-1 is planned now.**

Deferred beyond M1b, unchanged: media and stickers, reactions, voice waveforms,
typing indicators, online status (M2); folders, archive, forum topics (M4).

**Animated `.tgs` playback is now blocked, not merely deferred.** ThorVG's WASM
is fused to a browser custom element — headless use needs full DOM emulation or
reimplementing 41 Emscripten imports, and a Rust `rlottie` sidecar would give up
the single-binary release. Every sticker type still renders as a still via its
thumbnail. Revisit as its own milestone.

---

## 3. M1b-1 — the message layer

### 3.1 Rich text entities

Telegram sends `offset` and `length` **in UTF-16 code units**. tglow measures
text in graphemes and display columns (`src/tui/text-width.ts`). Converting
between the two is where this goes wrong, and it goes wrong silently on exactly
the text a Vietnamese user writes: combining diacritics and emoji.

**Design.** A pure module `src/tui/entities.ts`:

```ts
export interface IStyledSpan { text: string; style: TSpanStyle; url?: string; }
export const toStyledSpans = (opts: { text: string; entities: ITelegramEntity[] }): IStyledSpan[]
```

- Convert UTF-16 offsets to grapheme indices once, up front, via a lookup built
  from `toGraphemes`. Never index the raw string by entity offsets.
- Overlapping entities are legal in Telegram (bold inside a link). Flatten into
  non-overlapping spans carrying a **set** of styles.
- Unknown entity types pass through as plain text rather than throwing — Telegram
  adds new ones and an unknown type must not blank a message.

Supported: `bold`, `italic`, `underline`, `strike`, `code`, `pre`, `spoiler`,
`url`, `text_url`, `mention`, `hashtag`. Rendering:

| Entity | Rendering |
| --- | --- |
| bold / italic / underline / strike | OpenTUI `<b>` `<i>` `<u>` and strike attribute |
| code, pre | `text.code` (GREEN); `pre` on its own rows with a left rule |
| url, text_url | `text.link` (SKY), underlined; the URL shown on `K` |
| mention, hashtag | `text.link` |
| spoiler | rendered as `█` blocks until revealed |

**Spoilers** reveal per message with `zs` (mirrors vim's `z` fold prefix), state
held in the store, not persisted.

Entities are stored as JSON in the existing `messages.entities` column, which
the schema already has and nothing currently writes. The adapter must stop
discarding them.

**Wrapping must not break a span.** `wrap-text.ts` currently wraps a plain
string. It gains a span-aware path that preserves styles across a wrap.

### 3.2 Reply, edit, delete

| Key | Action |
| --- | --- |
| `r` | reply to the message under the cursor |
| `e` | edit your own message (loads it into the composer) |
| `dd` | delete the message under the cursor |

- **Reply** sets a pending reply target shown above the composer as a quoted
  preview (sender + first line, dimmed). `<escape>` clears it. Sending includes
  `reply_to_msg_id`; the message view shows a quote line above a reply.
- **Edit** loads the text into the composer, marks the composer as editing, and
  on send calls `messages.editMessage` instead of sending new. `<escape>` cancels
  and restores whatever was in the composer.
- **Delete** asks for confirmation on the status line (`y`/`n`) rather than a
  modal, because a mistyped `dd` on a message is not undoable. Deletes for
  everyone where permitted, otherwise for self, and says which it did.

`dd` is an operator sequence, and the engine's exact-vs-prefix limitation makes
`d` + `dd` currently unresolvable. **M1b-1 binds `dd` only** — no bare `d` — so
it works within the current engine. The general fix lands in M1b-2 with
operator-pending.

### 3.3 Mark as read and read receipts

- Opening a chat, and moving the cursor to the newest message, marks it read via
  `messages.readHistory`. Debounce: at most one call per chat per two seconds.
- The dialog's unread count clears locally and in the chat list.
- Own messages render `✓` when sent, `✓✓` when the other side has read them,
  from `read_outbox_max_id` — the column already exists and is never used.
- Never mark read on a chat the cursor merely passes over in the list. Reading
  is an explicit act; auto-reading messages the user has not seen is the kind of
  behaviour that gets a client distrusted.

### 3.4 `pts` gap recovery

The gap the release notes already admit: messages sent while tglow is closed are
never backfilled.

- Persist `pts`, `qts`, `date`, `seq` in `sync_state` (table exists, unused).
- On connect, call `updates.getDifference` from the stored state and apply what
  comes back through the same path live updates use, so a backfilled message and
  a live one are indistinguishable.
- On an update whose `pts` exceeds the expected next value, fetch the difference
  rather than accepting the gap.
- Channels use `updates.getChannelDifference` with per-channel `pts`, keyed
  `channel:<id>:pts`.
- If the server replies `differenceTooLong`, drop cached state for that peer and
  re-fetch history rather than trying to reconcile.

This is the single most commonly skipped piece of a Telegram client, and skipping
it is why messages silently go missing.

---

## 4. M1b-2 — the editor layer (specced, not yet planned)

### 4.1 Operator-pending, and the timeout that unblocks it

`src/keys/vim-engine.ts` resolves an exact match before checking for a prefix, so
a keymap containing both `d` and `dd` makes `dd` unreachable. There is an
invariant test pinning this as a known limit, naming M1b as where it is fixed.

**Design.** Vim resolves the same ambiguity with `timeoutlen`. The engine stays
pure — no timers inside it — and gains one entry point:

```ts
flushPending(opts: { state: IEngineState; keymap: IKeyBinding[] }): IResolveResult
```

When a sequence is *both* an exact match and a prefix of something longer,
`resolve` returns a new status `ambiguous` and holds the pending tokens. `App`
starts a timer (`timeoutlen`, default 400 ms, configurable); if another key
arrives first it goes to `resolve` as normal, and if the timer fires first `App`
calls `flushPending`, which resolves the exact match.

The existing invariant test is replaced by tests for the real behaviour: `d`
alone fires after the timeout, `dd` fires immediately, and a third key that
matches neither falls through.

### 4.2 Operators, registers, repeat

- Operators `d`, `y`, `c` compose with existing motions and counts: `d3j`, `y}`.
- Registers, including `"+` writing to the system clipboard via OSC 52 — the
  owner's alacritty sets `terminal.osc52 = "OnlyCopy"`, so this works.
- `.` repeats the last change, from `lastChange` already sketched in `IEngineState`.

### 4.3 `<C-p>` fuzzy chat jump and `/` search

Both are overlays following the which-key pattern already built. `<C-p>` fuzzy-
matches dialog titles; `/` searches cached message text with a SQLite `LIKE`,
with `n`/`N` to cycle. Server-side and FTS5 search stay in M3.

### 4.4 The remaining ten devglow palettes

Transcribe from `devglow/lua/devglow/palettes/*.lua`. **Every value asserted
against the source file** — ember's five shades were invented rather than
transcribed in M1a and the whole ramp was wrong, and nothing caught it because
only sage had assertions.

---

## 5. Architecture

No new units. M1b-1 extends existing ones:

| File | Change |
| --- | --- |
| `src/tui/entities.ts` | **new** — entities to styled spans, pure |
| `src/tui/wrap-text.ts` | span-aware wrapping |
| `src/tui/panes/message-view.tsx` | render spans, quote lines, tick marks |
| `src/core/telegram-adapter.ts` | stop discarding entities, reply ids, edits |
| `src/core/message-service.ts` | reply, edit, delete, mark-as-read |
| `src/core/update-service.ts` | apply differences alongside live updates |
| `src/core/difference-service.ts` | **new** — `pts` state and gap recovery |
| `src/keys/keymap.ts` | `r`, `e`, `dd`, `zs`, `y`/`n` confirmation |

The dependency rule is unchanged and still enforced: `keys/` imports only
`@venizia/ignis-inversion`, `core/` never React or OpenTUI, `tui/` never
`telegram`.

## 6. Testing

- `entities.ts` is pure — exhaustive unit tests, including overlapping entities,
  entities spanning emoji and combining marks, and unknown types.
- `difference-service` tested against a fake adapter replaying recorded update
  sequences with deliberate gaps. No network.
- Reply, edit and delete tested through `MessageService` with a fake adapter, and
  through `App` with real key presses — M1a's lesson was that a guarantee tested
  only at the service layer can be defeated one layer up.
- Read receipts: assert `readHistory` is **not** called for a chat merely
  scrolled past.

## 7. Risks

1. **UTF-16 to grapheme conversion.** Wrong here means entities land on the wrong
   characters, and it will show up first on Vietnamese text and emoji, not ASCII.
   Test with the owner's actual chat content shapes.
2. **`getDifference` is stateful and easy to get subtly wrong**, and a mistake
   loses messages silently — the opposite of the feature's purpose. Prefer
   re-fetching history over clever reconciliation.
3. **Delete is destructive and `dd` is one keystroke from `d`.** The confirmation
   is not optional.

## 8. Open questions

1. `timeoutlen` default of 400 ms is taken from vim's own default; it may feel
   slow for `dd`. Make it configurable and revisit after use.
2. Whether `e` should edit in the composer or open a larger editing buffer. The
   composer is assumed; a long message may prove it wrong.
