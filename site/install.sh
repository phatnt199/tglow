#!/usr/bin/env sh
# tglow installer
# Usage: curl -sSf https://tglow.phatnt.com/install.sh | sh
#
# What this does:
#   1. Detects OS / architecture
#   2. Downloads the latest release binary + tglow.sha256
#   3. Verifies the checksum
#   4. Installs the binary:
#      - Windows: %LOCALAPPDATA%\tglow\tglow.exe (and adds to User PATH)
#      - Linux/macOS: ~/.local/bin/tglow
#   5. Asks for api_id and api_hash and writes ~/.config/tglow/config.toml
#
# Environment overrides:
#   TGLOW_INSTALL_DIR   install directory
#   TGLOW_NO_CONFIG     set to 1 to skip the config.toml step

set -eu

REPO="phatnt199/tglow"
RELEASES_URL="https://github.com/${REPO}/releases"

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
  BIN_NAME="tglow"

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
      case "$ARCH" in
        x86_64|amd64) ARTIFACT="tglow-windows-x64.exe" ;;
        *) die "Unsupported Windows architecture: $ARCH (only x86_64 supported)" ;;
      esac
      BIN_NAME="tglow.exe"
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

# ── Download helper (curl or wget) ────────────────────────────────────────────

download() {
  URL="$1"
  DEST="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -sSfL --progress-bar "$URL" -o "$DEST"
  elif command -v wget >/dev/null 2>&1; then
    wget -q --show-progress "$URL" -O "$DEST"
  else
    die "Neither curl nor wget found — cannot download release files"
  fi
}

# ── Checksum verification ─────────────────────────────────────────────────────

verify_checksum() {
  BINARY="$1"
  SHAFILE="$2"

  BASENAME="$(basename "$BINARY")"

  # Extract the expected hash for this specific artifact from the .sha256 file.
  EXPECTED="$(grep -E "(^|[[:space:]])${BASENAME}\$" "$SHAFILE" | awk '{print $1}')"
  if [ -z "$EXPECTED" ]; then
    die "No checksum found for $BASENAME in tglow.sha256"
  fi

  if command -v sha256sum >/dev/null 2>&1; then
    ACTUAL="$(sha256sum "$BINARY" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    ACTUAL="$(shasum -a 256 "$BINARY" | awk '{print $1}')"
  elif command -v certutil.exe >/dev/null 2>&1 || command -v certutil >/dev/null 2>&1; then
    CERTUTIL_CMD="$(command -v certutil.exe 2>/dev/null || command -v certutil 2>/dev/null)"
    ACTUAL="$("$CERTUTIL_CMD" -hashfile "$BINARY" SHA256 2>/dev/null | grep -v ":" | tr -d ' \r\n' | tr '[:upper:]' '[:lower:]')"
  else
    die "No sha256 tool found (sha256sum, shasum, or certutil required) — cannot verify checksum"
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
    case "$OS" in
      MINGW*|MSYS*|CYGWIN*)
        if [ -n "${LOCALAPPDATA:-}" ]; then
          if command -v cygpath >/dev/null 2>&1; then
            INSTALL_DIR="$(cygpath -u "$LOCALAPPDATA")/tglow"
          else
            INSTALL_DIR="$HOME/AppData/Local/tglow"
          fi
        else
          INSTALL_DIR="$HOME/AppData/Local/tglow"
        fi
        ;;
      *)
        INSTALL_DIR="$HOME/.local/bin"
        ;;
    esac
  fi

  mkdir -p "$INSTALL_DIR"

  # Warn on Linux/macOS if the directory is not on PATH.
  case "$OS" in
    MINGW*|MSYS*|CYGWIN*) ;;
    *)
      case ":$PATH:" in
        *":$INSTALL_DIR:"*) ;;
        *)
          warn "$INSTALL_DIR is not on your PATH."
          warn "Add this to your environment PATH or shell profile:"
          warn "  export PATH=\"\$HOME/.local/bin:\$PATH\""
          ;;
      esac
      ;;
  esac
}

# ── Windows PATH helper ───────────────────────────────────────────────────────

setup_windows_path() {
  DIR="$1"
  if command -v cygpath >/dev/null 2>&1; then
    WIN_DIR="$(cygpath -w "$DIR")"
  else
    WIN_DIR="$DIR"
  fi

  if command -v powershell.exe >/dev/null 2>&1 || command -v powershell >/dev/null 2>&1; then
    PS_CMD="$(command -v powershell.exe 2>/dev/null || command -v powershell 2>/dev/null)"
    "$PS_CMD" -NoProfile -Command "
      \$target = '$WIN_DIR'.TrimEnd('\\');
      \$userPath = [Environment]::GetEnvironmentVariable('Path', 'User');
      \$paths = @();
      if (\$userPath) { \$paths = \$userPath.Split(';') | Where-Object { \$_ -ne '' } };
      if (\$paths -notcontains \$target) {
        \$newPath = (\$paths + \$target) -join ';';
        [Environment]::SetEnvironmentVariable('Path', \$newPath, 'User');
      }
    " >/dev/null 2>&1 || true
    ok "Configured User PATH: $WIN_DIR"
  fi
}

# ── Config setup ──────────────────────────────────────────────────────────────

setup_config() {
  CONFIG_DIR="$HOME/.config/tglow"
  CONFIG_FILE="$CONFIG_DIR/config.toml"

  if [ -f "$CONFIG_FILE" ]; then
    ok "Config already exists at $CONFIG_FILE — skipping"
    return
  fi

  if [ ! -r /dev/tty ] || [ ! -w /dev/tty ]; then
    info "No interactive terminal available (/dev/tty) — skipping config creation."
    info "You can configure tglow later by creating $CONFIG_FILE"
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
    if ! read -r API_ID </dev/tty; then
      warn "Failed to read api_id — skipping config creation"
      return
    fi
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
    if ! read -r API_HASH </dev/tty; then
      warn "Failed to read api_hash — skipping config creation"
      return
    fi
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
  resolve_install_dir

  info "Platform : $ARTIFACT"
  info "Install  : $INSTALL_DIR/$BIN_NAME"
  printf '\n'

  DOWNLOAD_BASE="${RELEASES_URL}/latest/download"
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

  # Atomic copy-then-mv to avoid ETXTBSY on running binaries
  TMP_DEST="${INSTALL_DIR}/.${BIN_NAME}.tmp.$$"
  cp "${TMPDIR_WORK}/${ARTIFACT}" "$TMP_DEST"
  mv -f "$TMP_DEST" "${INSTALL_DIR}/${BIN_NAME}"

  ok "Installed tglow → ${INSTALL_DIR}/${BIN_NAME}"

  # Configure Windows PATH automatically
  case "$OS" in
    MINGW*|MSYS*|CYGWIN*)
      setup_windows_path "$INSTALL_DIR"
      ;;
  esac

  # Config step — skippable via env var
  if [ "${TGLOW_NO_CONFIG:-0}" != "1" ]; then
    setup_config
  fi

  printf '\n'
  bold 'Done!'
  printf ' Run %s to start.\n\n' "$(green 'tglow')"
}

main "$@"
