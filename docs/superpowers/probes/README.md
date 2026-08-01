# Verification probes

These are the scripts that established the technical claims in
`../specs/2026-08-01-tglow-m1-design.md` §2. They are kept in the repo so the
claims stay checkable rather than becoming folklore.

Run them from a directory where the dependencies are installed:

```sh
bun add telegram @opentui/core @opentui/react react sharp
bun run 01-bun-gramjs-opentui.ts
bun run 02-halfblock-sticker.ts
```

## 01-bun-gramjs-opentui.ts

Staged Bun-compatibility probe. Each stage is isolated so a failure localises:

1. `import("telegram")` — ESM/CJS interop under Bun
2. AES-IGE encrypt/decrypt round-trip — MTProto crypto, the most likely thing to
   break on a non-Node runtime
3. TCP connect + Diffie-Hellman auth-key handshake against a live Telegram DC
4. An unauthenticated RPC round-trip (`help.getNearestDc`)
5. `@opentui/core` and `@opentui/react` import

The bogus `api_id` is intentional: it is validated only at `initConnection`, so
reaching that point already proves transport, crypto and framing all work.

Last run on this machine: **all stages PASS**, `help.getNearestDc` returned
`country=VN`.

## 02-halfblock-sticker.ts

Proves Telegram stickers can be displayed in a terminal with no image protocol —
which matters because Alacritty supports neither sixel nor the Kitty graphics
protocol (verified with `infocmp -1 alacritty | grep -iE 'sixel|graph'`).

Encodes a gradient-heavy transparent test sticker as real WebP, then renders it
with `▀` where foreground is the top pixel and background the bottom pixel,
giving two pixels of vertical resolution per cell. Alpha is composited over the
devglow `BACKGROUND` so transparency looks correct.

Renders at 16, 24 and 34 cells wide for comparison. **Run it in a truecolor
terminal** — piping it to a file just shows the escape sequences.
