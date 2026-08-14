#!/usr/bin/env bash
#
# Every platform's binary, from one machine.
#
# Bun cross-compiles the JavaScript, but OpenTUI reaches its renderer through a
# native library -- libopentui.so, .dylib, opentui.dll -- that lives in a
# per-platform package. `bun install` fetches only the one matching the machine
# it runs on, because the others declare an `os`/`cpu` that does not match, so
# a cross-build fails to resolve the import until the rest are fetched by hand.
# That is what the first half of this does.
#
# This is no longer how releases are built -- .github/workflows/release.yml
# builds each platform on a runner of that platform, and starts it there. Keep
# this for checking locally that a change still compiles everywhere, without
# pushing a tag to find out.
#
# What this cannot do is *run* what it builds. A macOS or Windows binary made
# here is verified as far as its file format and the native library inside it,
# and no further; the first person to run one is finding out something this
# script did not.
set -euo pipefail

VERSION="$(node -p "require('./package.json').version" 2>/dev/null || bun -e "console.log(require('./package.json').version)")"
OPENTUI_VERSION="$(bun -e "console.log(require('./node_modules/@opentui/core/package.json').version)")"
OUT="${1:-dist/release}"

mkdir -p "$OUT"

# The native packages a cross-build needs, and the file each must contain.
declare -A NATIVE=(
  [core-linux-x64]=libopentui.so
  [core-darwin-arm64]=libopentui.dylib
  [core-darwin-x64]=libopentui.dylib
  [core-win32-x64]=opentui.dll
)

echo "── fetching native renderers (@opentui $OPENTUI_VERSION)"
for pkg in "${!NATIVE[@]}"; do
  dest="node_modules/@opentui/$pkg"
  if [ -f "$dest/${NATIVE[$pkg]}" ]; then
    echo "   $pkg — already present"
    continue
  fi
  mkdir -p "$dest"
  curl -sL "https://registry.npmjs.org/@opentui/$pkg/-/$pkg-$OPENTUI_VERSION.tgz" \
    | tar -xz -C "$dest" --strip-components=1
  # Checked rather than assumed: a tarball that extracted without the library
  # produces a binary that compiles and then cannot draw.
  [ -f "$dest/${NATIVE[$pkg]}" ] || { echo "   $pkg — MISSING ${NATIVE[$pkg]}"; exit 1; }
  echo "   $pkg — fetched"
done

# target:artifact name
TARGETS=(
  "bun-linux-x64:tglow-linux-x64"
  "bun-darwin-arm64:tglow-macos-arm64"
  "bun-darwin-x64:tglow-macos-x64"
  "bun-windows-x64:tglow-windows-x64.exe"
)

echo "── building tglow $VERSION"
for entry in "${TARGETS[@]}"; do
  target="${entry%%:*}"
  name="${entry##*:}"
  bun build --compile --target="$target" --asset-naming="[name].[ext]" \
    src/main.ts --outfile "$OUT/${name%.exe}" >/dev/null
  # Bun appends .exe for the Windows target on its own; normalise either way.
  [ -f "$OUT/${name%.exe}.exe" ] && [ "$name" != "${name%.exe}" ] || true
  echo "   $name — $(du -h "$OUT/$name" 2>/dev/null | cut -f1)"
done

echo "── checksums"
( cd "$OUT" && sha256sum tglow-* > tglow.sha256 && sha256sum -c tglow.sha256 )

echo "── formats"
( cd "$OUT" && for f in tglow-*; do printf '   %-26s %s\n' "$f" "$(file -b "$f" | cut -c1-58)"; done )
