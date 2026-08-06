# M2 — the mouse layer and visible chrome

**Goal.** tglow gains a mouse: click, scroll, drag and a right-click menu. The
panes gain visible chrome — borders with titles, and a tab bar for open chats.

**The rule that governs every decision below.** The mouse is an *alternative*
route, never the only one. Every action reachable by mouse must already be
reachable by key, and nothing may become mouse-only. tglow is a vim-native
client whose whole premise is not needing the mouse; this milestone is about
not *punishing* you for reaching for it.

---

## 1. Scope coverage — what M2 promises, and where it lands

| Promised | §  | Status |
| --- | --- | --- |
| Mouse events reach the application at all | 2 | |
| Boxed panes with titles | 3 | |
| Tab bar for open chats | 3 | |
| Click a chat to open it | 4 | |
| Click a message to move the cursor | 4 | |
| Click a tab to switch chats | 4 | |
| Scroll wheel over either pane | 5 | |
| Drag the divider to resize, persisted | 6 | |
| Drag the message pane to scroll it | 6 | |
| Drag a chat to pin or reorder it | 6 | |
| Right-click menu on a message | 7 | |
| Right-click menu on a chat | 7 | |

Nothing may be marked done until every row is accounted for. This table exists
because three features in M1a were written in a spec, silently dropped from the
plan, and no test could catch a missing feature.

---

## 2. Mouse foundation

**OpenTUI already enables the mouse.** `createCliRenderer` resolves
`config.useMouse ?? true`, and tglow passes only `exitOnCtrlC: false`. So mouse
reporting has been on since M1a and tglow has never handled a single event: the
terminal's own click-drag selection is already being intercepted, and nothing is
offered in exchange. This milestone is partly repayment of that debt.

**Events.** `Renderable` exposes per-element handlers — `onMouseDown`,
`onMouseUp`, `onMouseMove`, `onMouseDrag`, `onMouseDragEnd`, `onMouseDrop`,
`onMouseOver`, `onMouseOut`, `onMouseScroll` — each receiving a `MouseEvent`
with `x`, `y`, `button`, `modifiers` and, for scroll, `ScrollInfo`.
`MouseButton` is `LEFT 0 / MIDDLE 1 / RIGHT 2 / WHEEL_UP 4 / WHEEL_DOWN 5`.
Read from `renderer.d.ts` and `lib/parse.mouse.d.ts`, not guessed.

**Shift bypass.** Every mainstream terminal, Alacritty included, keeps its own
selection on Shift+drag while an application holds the mouse. Nothing is
implemented for this; it is the terminal's behaviour. It must be **verified**
rather than assumed, and documented in the README either way.

**Turning it off.** `mouse = false` in `config.toml` passes `useMouse: false` to
the renderer, restoring native selection completely. Default true, matching
what already happens today.

**Failure posture.** A mouse event handler must never throw into the renderer's
event loop; the same reasoning as `UpdateService.apply`'s catch, which exists
because an escaping error there becomes an unhandled rejection.

---

## 3. Chrome

Boxed panes with titles, and a tab bar. This is a deliberate step away from the
nvim-shaped minimalism M1a chose (`fillchars = "vert:│"`, no window borders) —
chosen by the owner, who picked it over polishing the existing look.

**Borders.** Each pane is a box with a single-line border and a title in its top
edge: `┌─ Chats ─────┐`, `┌─ Alice ─────┐`. The **focused** pane's border takes
`tokens.borderActive`; the unfocused one keeps `tokens.border`. This is where
superfile's `sidebar_border_active = "#AF5F5F"` finally has an analogue, and it
solves a real problem M1a left open: which pane has focus is currently only
visible through the cursor highlight.

**Tab bar.** One row above the panes, listing open chats. A chat opens into a
tab; the active tab is highlighted. Tabs are a new concept — until now tglow had
exactly one open chat — so this section owns that state:
`openChats: string[]` (peer ids, in tab order) alongside the existing
`activePeerId`. Closing the last tab is a no-op, not an empty screen.

**Cost.** Borders take two columns and two rows from each pane. `paneHeight` and
the message pane's content width must account for that, or wrapped text will
overflow its box — the class of bug that produced M1a's interleaved-text report.

---

## 4. Click

| Target | Effect | Keyboard equivalent |
| --- | --- | --- |
| A chat row | open that chat | `Enter` in the chat list |
| A message row | move the message cursor there | `j` / `k` |
| A tab | switch to that chat | (new: `gt` / `gT`) |
| A pane's body | focus that pane | `<C-w>h` / `<C-w>l` |

Clicking a pane focuses it, so a click that also moves a cursor does both — the
same as clicking into a window in vim. `gt`/`gT` are added so tabs are not
mouse-only, honouring the governing rule.

---

## 5. Scroll

Wheel over the message pane scrolls history; wheel over the chat list scrolls
the list. Scrolling moves the **viewport**, not the cursor — this is the
distinction that matters, and the one a naive implementation gets wrong by
mapping wheel to `j`/`k`. `viewport.ts` already owns the visible window.

Scrolling must not mark anything read: read state is driven by the cursor
reaching the newest message, and spec §3.3's rule that "reading is an explicit
act" applies to a wheel exactly as it applies to a cursor passing over a chat.

---

## 6. Drag

**The divider.** Drag the vertical rule to rebalance the panes. Clamped so
neither pane can vanish (minimum 16 columns each). The resulting sidebar width
persists to `config.toml` as `sidebar_width`, written on drag-end rather than
on every motion event.

**Drag to scroll.** Press in the message pane and pull: the viewport follows,
inverted like touch scrolling. Distinct from a click by movement — a press and
release with no motion between them is a click, not a zero-distance drag.

**Drag a chat.** Dragging a chat row up or down reorders it, and dropping it
above the pinned boundary pins it. This writes through to Telegram
(`messages.toggleDialogPin`), so it syncs to every other device — which makes it
the one drag with a networked, visible-elsewhere effect, and therefore the one
that needs the same failure posture as `delete`: report on the status line, and
put the row back if the server refuses.

---

## 7. Right-click menus

A popup at the pointer, dismissed by `Esc`, a click elsewhere, or choosing an
item. Navigable by `j`/`k` and `Enter`, because a menu that only a mouse can
operate would violate the governing rule.

**On a message:** Reply · Edit · Delete · Yank · Copy link (when the message
carries one). Each dispatches exactly the action its key already dispatches, so
delete still asks `y`/`n` — a menu must not become a way around the one
confirmation in the app.

**On a chat:** Open · Pin / Unpin · Mark read.

Items that do not apply are omitted rather than shown disabled: Edit never
appears on someone else's message, matching `e`'s own refusal.

---

## 8. Testing

Mouse events are dispatched through the renderer, so the existing
`renderWithKeys` harness needs a sibling that can fire a `MouseEvent` at a
coordinate. Every section above needs at least one test asserting the *effect*,
not the wiring — the lesson from M1b-1, where four spec'd features were
implemented but untested and three of them lost messages.

Two properties deserve explicit tests beyond their own features:

1. **Nothing becomes mouse-only.** A guard listing every mouse-reachable action
   beside the key that also reaches it, in the shape of the promised-keys guard
   that already caught `\` and `<C-w>h`.
2. **Chrome does not overflow its box.** A wrapped message inside a bordered
   pane must not exceed the pane's inner width — M1a's interleaved-text bug in a
   new place.
