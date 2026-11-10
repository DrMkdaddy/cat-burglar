#!/usr/bin/env bash
# Cat Burglar installer. Uses pnpm when available, then npm. Prefers the npm
# registry package and falls back to the latest GitHub release tarball.
set -euo pipefail

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22 or newer is required." >&2
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "Node.js 22 or newer is required. Found $(node --version)." >&2
  exit 1
fi

if command -v pnpm >/dev/null 2>&1; then
  PM="pnpm"
elif command -v npm >/dev/null 2>&1; then
  PM="npm"
else
  echo "pnpm or npm is required." >&2
  exit 1
fi

PACKAGE="cat-burglar-mcp"
REGISTRY_HAS_PACKAGE=0
if command -v npm >/dev/null 2>&1 && npm view "$PACKAGE" version >/dev/null 2>&1; then
  REGISTRY_HAS_PACKAGE=1
elif command -v pnpm >/dev/null 2>&1 && pnpm view "$PACKAGE" version >/dev/null 2>&1; then
  REGISTRY_HAS_PACKAGE=1
fi

if [ "$REGISTRY_HAS_PACKAGE" -eq 1 ]; then
  echo "Installing $PACKAGE from the npm registry with $PM..."
  if [ "$PM" = "pnpm" ]; then
    pnpm add -g "$PACKAGE"
  else
    npm install -g "$PACKAGE"
  fi
else
  echo "Installing the latest release tarball with $PM..."
  URL="$(curl -fsSL https://api.github.com/repos/DrMkdaddy/cat-burglar/releases/latest \
    | grep -o 'https://[^"]*\.tgz' \
    | head -n 1)"
  if [ -z "$URL" ]; then
    echo "Could not find a release tarball." >&2
    exit 1
  fi
  if [ "$PM" = "pnpm" ]; then
    pnpm add -g "$URL"
  else
    npm install -g --allow-remote=all "$URL"
  fi
fi

if command -v cat-burglar >/dev/null 2>&1; then
  echo "Installed $(cat-burglar --version)"
  echo
  cat-burglar doctor || true
  echo
  echo "Next: cat-burglar install --client <claude-code|claude-desktop|cursor|codex|gemini|vscode|windsurf|cline|opencode>"
else
  echo "Install finished, but cat-burglar is not on PATH." >&2
  if [ "$PM" = "pnpm" ]; then
    echo "Run \`pnpm setup\` and restart your shell, or add \$(pnpm bin -g) to PATH." >&2
  else
    echo "Add your npm global bin directory to PATH." >&2
  fi
  exit 1
fi
