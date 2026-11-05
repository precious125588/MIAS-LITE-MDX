#!/bin/bash
# install-cox.sh — wire the local cox package into mias/.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COX_SRC="$ROOT/cox"
TARGET="$ROOT/mias"

if [ ! -d "$COX_SRC" ]; then
  echo "[cox] $COX_SRC missing — nothing to install"
  exit 0
fi

mkdir -p "$TARGET/cox_local"
cp -R "$COX_SRC/." "$TARGET/cox_local/"
(cd "$TARGET" && npm install ./cox_local --save --no-audit --no-fund \
  || echo "[cox] local install failed, keeping existing deps")
echo "[cox] installed (local file: ./cox_local)"
