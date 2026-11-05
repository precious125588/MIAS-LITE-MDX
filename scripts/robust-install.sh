#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# robust-install.sh <dir>
#
# WHY: the Railway build died in `bash scripts/robust-install.sh mias` with
#
#   npm error Exit handler never called!          (attempts 1 and 2)
#   npm error ENOTEMPTY: rename '/app/mias/node_modules/axios' ->
#             '/app/mias/node_modules/.axios-cKqQ93Jn'   (attempt 3)
#
# Two separate problems:
#
#   1. "Exit handler never called!" is npm's message when its own process is
#      killed mid-install — on a Railway builder that is the OOM killer. The
#      old script ESCALATED the heap (2048 → 3072 → 4096MB) on every retry,
#      which makes an out-of-memory kill MORE likely, not less, and ran the
#      resolver with --maxsockets 4 so a ~1200-package tree with native
#      builds was extracted in parallel at peak memory.
#
#   2. The retries only deleted node_modules/.package-lock.json. The half
#      written node_modules from the killed attempt stayed on disk, so the
#      next attempt tried to rename an existing, non-empty package directory
#      and failed with ENOTEMPTY. Attempt 3 could never have succeeded.
#
# WHAT: de-escalate the heap, serialize extraction, and do a FULL clean of
#       node_modules (plus a per-attempt cache dir) between attempts. The last
#       attempt falls back to --ignore-scripts + targeted `npm rebuild`, so a
#       required native modules are then rebuilt and checked explicitly.
# ─────────────────────────────────────────────────────────────────────────────
set -u

DIR="${1:-.}"
cd "$DIR" || { echo "[install] $DIR — no such directory"; exit 1; }

# Lower heaps first: the failure mode here is the builder killing npm, so more
# heap means a faster kill. Locked installs avoid fresh dependency resolution.
HEAPS="${NPM_HEAPS:-1024 768 512}"
ATTEMPT=0
TOTAL=$(echo "$HEAPS" | wc -w)

clean_tree() {
  # A killed npm leaves a partially linked node_modules behind. Anything less
  # than a full delete reproduces ENOTEMPTY on the next attempt.
  rm -rf node_modules
  # Keep the committed lockfile: retries must install the same dependency tree.
}

for HEAP in $HEAPS; do
  ATTEMPT=$((ATTEMPT + 1))
  CACHE_DIR="/tmp/npm-cache-$(echo "$DIR" | tr '/.' '__')-$ATTEMPT"
  echo "[install] $DIR — attempt $ATTEMPT/$TOTAL (heap ${HEAP}MB)"

  EXTRA=""
  if [ "$ATTEMPT" -eq "$TOTAL" ]; then
    # Last resort: skip postinstall scripts so the resolver alone has to
    # survive, then rebuild only the native packages that actually need it.
    EXTRA="--ignore-scripts"
    echo "[install] $DIR — final attempt runs with --ignore-scripts + rebuild"
  fi

  if [ -f package-lock.json ]; then INSTALL_COMMAND=ci; else INSTALL_COMMAND=install; fi

  NODE_OPTIONS="--max-old-space-size=${HEAP}" \
  npm_config_cache="$CACHE_DIR" \
  npm "$INSTALL_COMMAND" \
      --no-audit --no-fund --no-progress \
      --legacy-peer-deps \
      --maxsockets 2 \
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

echo "[install] $DIR — all attempts failed"
exit 1
