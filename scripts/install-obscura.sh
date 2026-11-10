#!/usr/bin/env bash
# Install the Obscura binary used as the lightweight fallback engine.
# Apache-2.0, https://github.com/h4ckf0r0day/obscura
set -euo pipefail

VARIANT="${OBSCURA_VARIANT:-stealth}"   # stealth | no-render-stealth | "" (render only)
DEST="${1:-$HOME/.local/bin}"

case "$(uname -s)" in
  Linux) OS="linux" ;;
  Darwin) OS="macos" ;;
  *) echo "unsupported OS: $(uname -s)" >&2; exit 1 ;;
esac

case "$(uname -m)" in
  x86_64|amd64) ARCH="x86_64" ;;
  aarch64|arm64) ARCH="aarch64" ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

if [[ "$OS" == "linux" ]]; then
  if [[ -n "$VARIANT" ]]; then
    ASSET="obscura-${ARCH}-linux-${VARIANT}.tar.gz"
  else
    ASSET="obscura-${ARCH}-linux.tar.gz"
  fi
else
  if [[ -n "$VARIANT" ]]; then
    ASSET="obscura-${ARCH}-macos-${VARIANT}.tar.gz"
  else
    ASSET="obscura-${ARCH}-macos.tar.gz"
  fi
fi

URL="https://github.com/h4ckf0r0day/obscura/releases/latest/download/${ASSET}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Downloading $ASSET"
curl -fL --retry 3 --progress-bar "$URL" -o "$TMP/obscura.tar.gz"
tar -xzf "$TMP/obscura.tar.gz" -C "$TMP"

mkdir -p "$DEST"
install -m 0755 "$TMP/obscura" "$DEST/obscura"
if [[ -f "$TMP/obscura-worker" ]]; then
  install -m 0755 "$TMP/obscura-worker" "$DEST/obscura-worker"
fi

echo "Installed $("$DEST/obscura" --version 2>/dev/null || echo obscura) to $DEST/obscura"
echo "Set BROWSER_MCP_OBSCURA_PATH=$DEST/obscura if it is not on PATH."
