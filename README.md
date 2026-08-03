# tglow

A vim-native Telegram client for the terminal, themed with devglow and built to
the IGNIS Code Style Standard.

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
message cache and the log. Deleting that directory logs you out and forgets the
cache; it does not touch anything on Telegram.

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
| `Enter` (chat list) | open the chat |
| `Esc` (chat list) | back to messages, without opening anything |

### Messages

| Key | Action |
| --- | --- |
| `zs` | reveal a spoiler under the cursor |
| `K` | show the URL of a link under the cursor |
| `r` | reply to the message under the cursor |
| `e` | edit your own message under the cursor |
| `d{motion}` / `dd` | delete the message under the cursor (asks `y`/`n` to confirm) |
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
