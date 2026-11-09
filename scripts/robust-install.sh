#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# robust-install.sh <dir>
# Low-memory resilient installer for container and low-RAM environments
# ─────────────────────────────────────────────────────────────────────────────
set -u

DIR="${1:-.}"
cd "$DIR" || { echo "[install] $DIR — no such directory"; exit 1; }

# Detect memory limit
TOTAL_MEM_KB=$(grep MemTotal /proc/meminfo 2>/dev/null | awk '{print $2}' || echo "2000000")
if [ -z "${NPM_HEAPS:-}" ]; then
  if [ "$TOTAL_MEM_KB" -le 1048576 ]; then
    HEAPS="192 144 112"
  else
    HEAPS="512 384 256"
  fi
else
  HEAPS="$NPM_HEAPS"
fi

ATTEMPT=0
TOTAL=$(echo "$HEAPS" | wc -w)

clean_tree() {
  rm -rf node_modules
}

for HEAP in $HEAPS; do
  ATTEMPT=$((ATTEMPT + 1))
  CACHE_DIR="/tmp/npm-cache-$(echo "$DIR" | tr '/.' '__')-$ATTEMPT"
  echo "[install] $DIR — attempt $ATTEMPT/$TOTAL (heap ${HEAP}MB)"

  EXTRA=""
  if [ "$ATTEMPT" -eq "$TOTAL" ]; then
    EXTRA="--ignore-scripts"
    echo "[install] $DIR — final attempt runs with --ignore-scripts + rebuild"
  fi

  if [ -f package-lock.json ]; then INSTALL_COMMAND=ci; else INSTALL_COMMAND=install; fi

  NODE_OPTIONS="--max-old-space-size=${HEAP}" \
  npm_config_cache="$CACHE_DIR" \
  npm "$INSTALL_COMMAND" \
      --no-audit --no-fund --no-progress \
      --legacy-peer-deps \
      --maxsockets 1 \
      --fetch-retries 5 \
      --fetch-retry-maxtimeout 120000 \
      --loglevel=warn \
      $EXTRA
  CODE=$?

  if [ $CODE -eq 0 ] && [ -n "$EXTRA" ]; then
    for pkg in sharp @napi-rs/canvas canvas @resvg/resvg-js bufferutil utf-8-validate; do
      [ -d "node_modules/$pkg" ] || continue
      echo "[install] $DIR — rebuilding $pkg"
      NODE_OPTIONS="--max-old-space-size=${HEAP}" npm rebuild "$pkg" --no-audit --no-fund \
        || { CODE=1; echo "[install] $DIR — required native rebuild failed: $pkg"; break; }
    done
  fi

  if [ $CODE -eq 0 ]; then
    echo "[install] $DIR — OK on attempt $ATTEMPT"
    rm -rf "$CACHE_DIR"
    exit 0
  fi

  echo "[install] $DIR — attempt $ATTEMPT failed (exit $CODE); full clean and retry"
  clean_tree
  rm -rf "$CACHE_DIR"
done

echo "[install] $DIR — full install attempts exhausted; falling back to critical minimal dependencies..."
if [ -f "lib/ensure-dependencies.cjs" ]; then
  node lib/ensure-dependencies.cjs && exit 0
fi

echo "[install] $DIR — all attempts failed"
exit 1
