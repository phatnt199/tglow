# tglow

A vim-native Telegram client for the terminal, themed with devglow and built to
the IGNIS Code Style Standard.

[![Buy Me A Coffee](https://img.shields.io/badge/Buy_Me_A_Coffee-EBC17A?style=for-the-badge&logo=buymeacoffee&logoColor=080808)](https://buymeacoffee.com/tanphat199)
[![GitHub](https://img.shields.io/badge/Source-phatnt199/tglow-87AFAF?style=for-the-badge&logo=github&logoColor=080808)](https://github.com/phatnt199/tglow)
[![phatnt.com](https://img.shields.io/badge/phatnt.com-7DB9B6?style=for-the-badge&logo=firefoxbrowser&logoColor=080808)](https://phatnt.com)

## Install

tglow ships as one self-contained binary. There is nothing else to install — no
runtime, no `node_modules`, no repository.

1. Download `tglow` and `tglow.sha256`, check it, and make it executable. The
   binary is built per platform; `bun run build` produces one for whatever you
   build it on.

   ```sh
   sha256sum -c tglow.sha256
   chmod +x tglow
   mv tglow ~/.local/bin/tglow      # or anywhere on your PATH
   ```

2. **Get your own `api_id` and `api_hash`** from <https://my.telegram.org> (log
   in, then "API development tools"). tglow ships no keys and never will: these
   identify *your* application to Telegram, they are issued against your own
   account, and nobody can obtain them for you. It takes about a minute.

3. Write them to `~/.config/tglow/config.toml`:

   ```toml
   api_id = 1234567
   api_hash = "your-hash-here"
   palette = "sage"
   ```

4. Run it:

   ```sh
   tglow
   ```

   The first run asks for your phone number, then the code Telegram sends you,
   then your two-factor password if you have one. The code and the password are
   not echoed. tglow then goes straight into the interface — there is no second
   launch — and later runs skip all of this.

Everything tglow stores lives under `~/.local/share/tglow/`: the session, the
message cache and the log. Deleting that directory makes this machine forget
your account, but leaves the session authorised on Telegram's side — use
`:logout` to end it properly.

## The interface

Two panes inside one frame. The sidebar stacks your Telegram **folders** over
the **chat list**; the conversation and its composer share the pane on the
right. The focused pane's border is drawn in the palette's accent, so which
pane has focus is visible without hunting for the cursor.

Folders are your own, read from Telegram. `]f` and `[f` move between them.
tglow evaluates the folders you build by picking chats exactly; a folder built
purely on "all contacts", "unmuted only" or "not archived" will show fewer
chats here than in the official client, because tglow does not cache contact,
notification or archive state. The rail is hidden entirely if you have no
folders.

Each chat shows two rows — name and time, then the last thing said and how much
is unread. When someone is **typing**, recording a voice message or choosing a
sticker, that displaces the preview and appears in the open chat's title.

In a wide window your own messages sit on the right and the other side's on the
left, the way a graphical client lays them out. Below sixty columns of
conversation everything stays left-aligned: right-aligning in a cramped pane
costs the text the room it has least of.

### Resizing

Drag the divider between the sidebar and the conversation to move it. Drag the
divider between the folders and the chat list to move that one — up to the top
puts the folder rail away, and dragging back down brings it back. Neither is
persisted between runs; see `sidebarWidth` in the source for why.

### The mouse

tglow holds the mouse by default. This is not new — OpenTUI has enabled mouse
reporting since the first release — but tglow now intends to use it. Hold
`Shift` for your terminal's own click-and-drag selection, which is the usual
convention and is the terminal's behaviour rather than anything tglow does.

To hand the mouse back completely:

```toml
mouse = false
```

## Themes

tglow ships the twelve [devglow](https://github.com/phatnt199/devglow) palettes:
`sage` (the default), `ember`, `amber`, `ash`, `blush`, `dusk`, `mocha`, `moss`,
`nocturne`, `plum`, `tide` and `vesper`. Choose one in `config.toml`:

```toml
palette = "nocturne"
```

### Writing your own

Drop a `.toml` into `~/.config/tglow/themes/` and name it in `palette`. A file
there **shadows a built-in of the same name**, so `themes/sage.toml` overrides
the shipped sage — the same way a colorscheme in `~/.config/nvim/colors` wins
over one from a plugin. That is how you adjust a palette without rebuilding.

All seventeen keys are required, each a six-digit `#RRGGBB`. A file that is
missing a key, carries a value that is not a colour, or cannot be parsed is
**not applied**: tglow draws sage instead and says why on the status line.
It never refuses to start over a theme file — a typo in one is a typo, not a
reason to lose access to your messages. Press `<C-l>` to dismiss the notice.

`~/.config/tglow/themes/midnight.toml`, with sage's own values as a worked
example:

```toml
FOREGROUND = "#E6E6E6"   # body text
BACKGROUND = "#080808"   # the window itself
RED        = "#AF5F5F"   # errors, and the mode block while confirming
GREEN      = "#87AFAF"   # inline code, and the online dot
BLUE       = "#7590AF"
ORANGE     = "#D59572"
YELLOW     = "#E5B567"
PINK       = "#D68C8C"   # VISUAL mode
GOLD       = "#EBC17A"   # INSERT mode, unread counts
TEAL       = "#7DB9B6"   # NORMAL mode, your own messages, the active chat
SKY        = "#7EAAC7"   # links
WINE       = "#924653"
DARK_00    = "#111111"
DARK_01    = "#181818"
DARK_02    = "#282828"   # rules and borders
DARK_03    = "#383838"   # the cursor line
DARK_04    = "#797979"   # timestamps, gutter, anything dimmed
```

The comments name where each role is actually drawn. The six without one —
`BLUE`, `ORANGE`, `YELLOW`, `WINE`, `DARK_00` and `DARK_01` — are still
required, so a theme stays a complete devglow palette and keeps working when a
later version starts using them, but nothing renders in them today.

## Run from source

```sh
bun install
bun start
```

You still need `~/.config/tglow/config.toml` as above. To re-authenticate
without starting the interface:

```sh
bun run scripts/login.ts
```

## Build the binary

```sh
bun run build
```

Writes `dist/tglow` and `dist/tglow.sha256`. The build regenerates
`src/core/cache/migrations.generated.ts` from `drizzle/` first: a compiled
binary has no `drizzle/` folder to read migrations from, so they are compiled
in, and a test fails if the committed copy ever drifts from `drizzle/`.

## The status line

One row, lualine's shape, and as much of this as the terminal has columns for:

```
 NORMAL  ● Work  Alice · group · 3 unread · typing…     "a3d  ⚑  #1482  14:32  4%  12/240  \ for keys
```

| Field | Says |
| --- | --- |
| `NORMAL` | the mode, and red while a delete is waiting on `y`/`n` |
| `◐` `✕` | connecting, offline — a healthy connection is not drawn at all |
| `●` | the other side is online, in green, immediately before their name |
| `Work` | the active folder, when you have narrowed to one |
| `Alice · group` | the open chat and what kind it is — a plain DM gets no tag |
| `3 unread · typing…` | what is waiting in it, and what the other side is doing |
| `"a3d` | vim's showcmd: the register, count and operator you have typed so far |
| `137/4096` | characters in the composer against Telegram's limit, while in insert mode — red past it |
| `⚑ #1482 14:32` | the message under the cursor: pinned, its id, its clock |
| `4% 12/240` | how far down the history you are |

Nothing is clipped to fit. Each field has a priority, and a narrow terminal
drops the cheapest ones whole — `\ for keys` first, the position and the mode
last. A data-integrity warning claims whatever width it needs.

## Media, reactions and emoji

A message that carries something other than text says what it is, on its own
line above any caption:

```
📷 Photo · 1280×960        🎤 Voice · 0:12         📎 report.pdf · 2.4 MB
🎬 Video · 1:05            🐱 Sticker              📍 Location
🎵 Diễm Xưa · 4:05         🎞 GIF · 0:03           📊 Poll · Ăn gì trưa nay?
```

**Photos are drawn.** tglow renders them with
[chafa](https://hpjansson.org/chafa/), which picks the character that best fits
each cell out of half blocks, quadrants, sextants and braille — so a picture
comes out as a picture rather than as coloured blocks. The descriptor stays
above it: it says what the thing is and how big, which a squint at forty cells
does not.

Thumbnails are fetched once and kept under `~/.local/share/tglow/thumbnails/`.
A sticker still shows the emoji it stands for — the animated ones carry a video
where a thumbnail should be, and tglow does not draw video.

This works in any terminal, because it is text. Nothing is required beyond the
binary — the chafa WebAssembly is compiled into it.

### Seeing the real picture

A drawing made of characters is a drawing, not the photograph. For the actual
pixels, press `O` (or `:view`): tglow downloads the picture at full size and
hands it to whatever your desktop opens pictures with.

That indirection is not a shortcut — it is the only route on some terminals.
**Alacritty cannot display images at all**: no Sixel, no Kitty graphics
protocol, no iTerm2 inline images. It is a deliberate, long-standing decision
of that project, and no library can work around a terminal that has no
mechanism to receive image data. Terminals that *can* show a picture inline —
kitty, WezTerm, Ghostty, Konsole, foot — are worth switching to if that matters
to you.

Reactions are tallied under the message: `👍 3  ❤️ 1  [😂] 2`. The brackets mark
your own, in brackets rather than colour so it survives a terminal without
colour and survives being copied out of one.

A green dot before a name — in the chat list and before the open chat's own
title — means that person is online. The status line says when they were last
seen instead, for anyone who is not. Telegram is deliberately vague for
anyone who hides their exact time — "recently", "within a week" — and tglow
does not sharpen it into a time it does not have.

Emoji are typed like any other character. Anything built from more than one
code point — a skin tone, a flag, a family, `❤️` — used to be dropped silently
on the way to the composer, as was decomposed Vietnamese from an input method
that emits it. Both work.

## History

Opening a chat loads the newest 50 messages and puts the cursor on the last
one. Scrolling back toward the top loads the 50 before it, and so on — the page
is fetched a few rows before you reach the end of the loaded ones, so it is
usually already there by the time you get there. `loading…` appears on the
status line while one is in flight.

The cache is asked before the network, so pages you have read before come back
with no round trip and are readable with no connection at all. A page shorter
than 50 means the start of the conversation; nothing is requested after that.

`/` searches the whole cached chat, not only the part on screen — if the match
is older than what is loaded, the pages between are fetched before it jumps.

## Commands

`:` opens the command line. `<Tab>` completes, `<Esc>` cancels, and
backspacing past the `:` closes it. The hint on the right shows what a
half-typed word could still become.

| Command | Action |
| --- | --- |
| `:q` `:quit` `:q!` `:qa` | close tglow — the same as `<C-c>` |
| `:{number}` | jump to that message, counting from 1 |
| `:h` `:help` | show the key bindings |
| `:read` | mark the open chat read |
| `:pin` / `:unpin` | pin or unpin the message under the cursor |
| `:e` `:reload` | reload the open chat from Telegram |
| `:view` `:open` | open the picture under the cursor at full size, in an image viewer |
| `:send <path>` `:upload` | send a file — the composer becomes its caption, and `~` works |
| `:logout` | sign out on Telegram, erase the local session and cache, and quit — asks `y`/`n` first |

Everything here is also a key, or is something no key should be: `:q` is
`<C-c>`, `:pin` is `P`, and `:logout` has no binding at all, because a single
keystroke should not be able to end a session.

### Logging out

`:logout` calls Telegram's own `auth.logOut`, so tglow stops being listed under
Active Sessions on your other devices, then deletes `~/.local/share/tglow/session`
and `~/.local/share/tglow/cache.sqlite`. The next launch starts at the phone
number prompt.

Deleting those two files by hand does most of the same thing, but *not* the
first part: the session stays authorised on Telegram's side until you revoke
it from another device.

## Keys

Leader is `\`. The application starts in NORMAL mode — nothing you type is sent
by accident.

### Overlays

| Key | Action |
| --- | --- |
| `\` | show key bindings |
| `<C-p>` | fuzzy jump to any chat (type to filter, `<C-n>`/`<C-p>` or `j`/`k` to move, `Enter` to open, `Esc` to cancel) |
| `/` | search the open chat's cached messages (type to filter, `Enter` jumps to the first match, `Esc` cancels and restores the cursor) |
| `n` / `N` | jump to the next / previous search match |

### Movement

| Key | Action |
| --- | --- |
| `j` / `k` | next / previous message |
| `3j` | down three messages |
| `gg` / `G` | oldest loaded / newest |
| `<C-d>` / `<C-u>` | half page down / up |
| `nf` | focus the chat list |
| `<C-w>h` / `<C-w>l` | move focus between chat list and messages |
| `]f` / `[f` | next / previous chat folder |
| `Enter` (chat list) | open the chat |
| `Esc` (chat list) | back to messages, without opening anything |

### Messages

| Key | Action |
| --- | --- |
| `zs` | reveal a spoiler under the cursor |
| `zn` | show or hide the line-number gutter |
| `zt` | show or hide timestamps |
| `K` | show the URL of a link under the cursor |
| `r` | reply to the message under the cursor |
| `e` | edit your own message under the cursor |
| `P` | pin or unpin — the message under the cursor, or the chat when the chat list has focus |
| `R` | react to the message: `R` then the key beside the emoji |
| `F` | forward the message to a chat, chosen from the same picker `<C-p>` uses |
| `O` | open the message's picture at full size, in an image viewer |
| `d{motion}` / `dd` / `3dd` | delete the message under the cursor, or a range (asks `y`/`n` first, and says how many) |
| `y{motion}` / `yy` | yank the message(s) under the cursor into a register |
| `c{motion}` / `cc` | edit (change) the message under the cursor, same as `e` |
| `"a` / `"+` then `y`/`d` | name a register first — any letter, or `+` for the system clipboard |
| `.` | repeat the last change |

### Insert mode

| Key | Action |
| --- | --- |
| `i` / `a` | write a message |
| `jk` or `Esc` | leave insert mode |
| `Enter` (insert) | send |

### Application

| Key | Action |
| --- | --- |
| `<C-l>` (normal) | dismiss a data-integrity warning on the status line |
| `:` | open the command line — see Commands above |
| `<C-c>` (normal) | quit |

## Security

`~/.local/share/tglow/session` is equivalent to a logged-in device on your
account. It is written mode `0600` and git-ignored. Never share it.

The login prompts read the code and the two-factor password in raw mode so
neither is echoed or left in your scrollback, and none of the phone number, the
code, the password or the session string is ever written to the log.

Third-party MTProto clients can attract account restrictions if they behave
abnormally. tglow does not poll, and reports a truthful device model. It does
not yet handle `FLOOD_WAIT`: a rate limit surfaces as a failed send with the
error in the status line, and retrying before it expires will extend it.

## Development

```sh
bun test          # no network or account needed
bun run typecheck
```

Conventions: `docs/superpowers/conventions/ignis-style.md`.
Design: `docs/superpowers/specs/`. Plans: `docs/superpowers/plans/`.
Logs go to `~/.local/share/tglow/tglow.log` — never stdout, which would corrupt
the alternate screen.
