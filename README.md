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
| `\` | show key bindings |
| `j` / `k` | next / previous message |
| `3j` | down three messages |
| `gg` / `G` | oldest loaded / newest |
| `<C-d>` / `<C-u>` | half page down / up |
| `nf` | focus the chat list |
| `<C-w>h` / `<C-w>l` | move focus between chat list and messages |
| `Enter` (chat list) | open the chat |
| `Esc` (chat list) | back to messages, without opening anything |
| `i` / `a` | write a message |
| `jk` or `Esc` | leave insert mode |
| `Enter` (insert) | send |
| `<C-c>` (normal) | quit |

## Security

`~/.local/share/tglow/session` is equivalent to a logged-in device on your
account. It is written mode `0600` and git-ignored. Never share it.

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
