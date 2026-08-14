#!/usr/bin/env sh
# tglow installer
# Usage: curl -sSf https://tglow.phatnt.com/install.sh | sh
#
# What this does:
#   1. Detects OS / architecture
#   2. Downloads the latest release binary + tglow.sha256
#   3. Verifies the checksum
#   4. Installs the binary to ~/.local/bin (Linux/macOS) or tells you where to put it
#   5. Asks for api_id and api_hash and writes ~/.config/tglow/config.toml
#
# Environment overrides:
#   TGLOW_INSTALL_DIR   install directory (default: ~/.local/bin)
#   TGLOW_NO_CONFIG     set to 1 to skip the config.toml step

set -eu

REPO="phatnt199/tglow"
RELEASES_URL="https://github.com/${REPO}/releases"
API_URL="https://api.github.com/repos/${REPO}/releases/latest"

# ── Colour helpers ────────────────────────────────────────────────────────────

tty_escape() { printf "\033[%sm" "$1"; }
bold()  { tty_escape 1; printf '%s' "$1"; tty_escape 0; }
green() { tty_escape 32; printf '%s' "$1"; tty_escape 0; }
yellow(){ tty_escape 33; printf '%s' "$1"; tty_escape 0; }
red()   { tty_escape 31; printf '%s' "$1"; tty_escape 0; }

info()  { printf '  %s\n' "$1"; }
ok()    { printf '  %s %s\n' "$(green '✓')" "$1"; }
warn()  { printf '  %s %s\n' "$(yellow '!')" "$1"; }
die()   { printf '\n  %s %s\n\n' "$(red '✗')" "$1" >&2; exit 1; }

# ── OS / arch detection ───────────────────────────────────────────────────────

detect_platform() {
  OS="$(uname -s)"
  ARCH="$(uname -m)"

  case "$OS" in
    Linux)
      case "$ARCH" in
        x86_64) ARTIFACT="tglow-linux-x64" ;;
        *) die "Unsupported Linux architecture: $ARCH (only x86_64 supported)" ;;
      esac
      ;;
    Darwin)
      case "$ARCH" in
        arm64)  ARTIFACT="tglow-macos-arm64" ;;
        x86_64) ARTIFACT="tglow-macos-x64" ;;
        *) die "Unsupported macOS architecture: $ARCH" ;;
      esac
      ;;
    MINGW*|MSYS*|CYGWIN*)
      die "Windows detected. Please install tglow manually from ${RELEASES_URL}"
      ;;
    *)
      die "Unsupported OS: $OS"
      ;;
  esac
}

# ── Dependency checks ─────────────────────────────────────────────────────────

require() {
  command -v "$1" >/dev/null 2>&1 || die "Required tool not found: $1 — please install it and retry"
}

# ── Fetch latest release tag from GitHub API ──────────────────────────────────

fetch_latest_version() {
  if command -v curl >/dev/null 2>&1; then
    VERSION="$(curl -sSf "$API_URL" | grep '"tag_name"' | head -1 | sed 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')"
  elif command -v wget >/dev/null 2>&1; then
    VERSION="$(wget -qO- "$API_URL" | grep '"tag_name"' | head -1 | sed 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')"
  else
    die "Neither curl nor wget found — cannot fetch release info"
  fi

  if [ -z "$VERSION" ]; then
    die "Could not determine the latest tglow version from GitHub API"
  fi
}

# ── Download helper (curl or wget) ────────────────────────────────────────────

download() {
  URL="$1"
  DEST="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -sSfL --progress-bar "$URL" -o "$DEST"
  else
    wget -q --show-progress "$URL" -O "$DEST"
  fi
}

# ── Checksum verification ─────────────────────────────────────────────────────

verify_checksum() {
  BINARY="$1"
  SHAFILE="$2"

  BASENAME="$(basename "$BINARY")"

  # Extract the expected hash for this specific artifact from the .sha256 file.
  EXPECTED="$(grep "$BASENAME" "$SHAFILE" | awk '{print $1}')"
  if [ -z "$EXPECTED" ]; then
    die "No checksum found for $BASENAME in tglow.sha256"
  fi

  if command -v sha256sum >/dev/null 2>&1; then
    ACTUAL="$(sha256sum "$BINARY" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    ACTUAL="$(shasum -a 256 "$BINARY" | awk '{print $1}')"
  else
    warn "No sha256 tool found — skipping checksum verification"
    return
  fi

  if [ "$ACTUAL" != "$EXPECTED" ]; then
    rm -f "$BINARY"
    die "Checksum mismatch! Expected $EXPECTED, got $ACTUAL. The download may be corrupt."
  fi
}

# ── Install directory ─────────────────────────────────────────────────────────

resolve_install_dir() {
  INSTALL_DIR="${TGLOW_INSTALL_DIR:-}"

  if [ -z "$INSTALL_DIR" ]; then
    INSTALL_DIR="$HOME/.local/bin"
  fi

  mkdir -p "$INSTALL_DIR"

  # Warn if the directory is not on PATH.
  case ":$PATH:" in
    *":$INSTALL_DIR:"*) ;;
    *)
      warn "$INSTALL_DIR is not on your PATH."
      warn "Add this to your shell profile:"
      warn "  export PATH=\"\$HOME/.local/bin:\$PATH\""
      ;;
  esac
}

# ── Config setup ──────────────────────────────────────────────────────────────

setup_config() {
  CONFIG_DIR="$HOME/.config/tglow"
  CONFIG_FILE="$CONFIG_DIR/config.toml"

  if [ -f "$CONFIG_FILE" ]; then
    ok "Config already exists at $CONFIG_FILE — skipping"
    return
  fi

  printf '\n'
  bold 'Telegram API credentials'
  printf '\n'
  info "tglow ships no API keys. You need your own api_id and api_hash"
  info "from https://my.telegram.org → Log in → API development tools"
  info "(Takes about a minute — the app name and description can be anything.)"
  printf '\n'

  # Read api_id — must be a number
  while true; do
    printf '  api_id (number): '
    read -r API_ID
    case "$API_ID" in
      ''|*[!0-9]*)
        warn "api_id must be a number — try again"
        ;;
      *)
        break
        ;;
    esac
  done

  # Read api_hash — must be non-empty
  while true; do
    printf '  api_hash (string): '
    read -r API_HASH
    if [ -z "$API_HASH" ]; then
      warn "api_hash cannot be empty — try again"
    else
      break
    fi
  done

  mkdir -p "$CONFIG_DIR"

  # Write with mode 0600 from the start — the file contains API credentials.
  (umask 177; cat > "$CONFIG_FILE" <<EOF
api_id   = ${API_ID}
api_hash = "${API_HASH}"
palette  = "sage"

# keymap = "vim"     # or "emacs"
# mouse  = true      # set to false to disable mouse capture
# update_check = true
EOF
)

  ok "Config written to $CONFIG_FILE"
}

# ── macOS Gatekeeper ──────────────────────────────────────────────────────────

remove_quarantine() {
  BINARY="$1"
  if [ "$(uname -s)" = "Darwin" ]; then
    if command -v xattr >/dev/null 2>&1; then
      xattr -d com.apple.quarantine "$BINARY" 2>/dev/null || true
    fi
  fi
}

# ── Main ──────────────────────────────────────────────────────────────────────

main() {
  printf '\n'
  bold 'tglow installer'
  printf '\n\n'

  detect_platform
  fetch_latest_version
  resolve_install_dir

  info "Version  : $VERSION"
  info "Platform : $ARTIFACT"
  info "Install  : $INSTALL_DIR/tglow"
  printf '\n'

  DOWNLOAD_BASE="${RELEASES_URL}/download/${VERSION}"
  TMPDIR_WORK="$(mktemp -d)"
  trap 'rm -rf "$TMPDIR_WORK"' EXIT

  # Download checksum file first — fail fast if the release is broken before
  # wasting bandwidth on the binary itself.
  info "Downloading checksum…"
  download "${DOWNLOAD_BASE}/tglow.sha256" "${TMPDIR_WORK}/tglow.sha256"
  ok "Got tglow.sha256"

  info "Downloading ${ARTIFACT}…"
  download "${DOWNLOAD_BASE}/${ARTIFACT}" "${TMPDIR_WORK}/${ARTIFACT}"
  ok "Downloaded ${ARTIFACT}"

  info "Verifying checksum…"
  verify_checksum "${TMPDIR_WORK}/${ARTIFACT}" "${TMPDIR_WORK}/tglow.sha256"
  ok "Checksum verified"

  chmod +x "${TMPDIR_WORK}/${ARTIFACT}"
  remove_quarantine "${TMPDIR_WORK}/${ARTIFACT}"

  cp "${TMPDIR_WORK}/${ARTIFACT}" "${INSTALL_DIR}/tglow"

  ok "Installed tglow ${VERSION} → ${INSTALL_DIR}/tglow"

  # Config step — skippable via env var
  if [ "${TGLOW_NO_CONFIG:-0}" != "1" ]; then
    setup_config
  fi

  printf '\n'
  bold 'Done!'
  printf ' Run %s to start.\n\n' "$(green 'tglow')"
}

main "$@"
