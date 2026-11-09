#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# robust-install.sh <dir>
# Auto-detects container RAM & Disk space to pick optimal installation strategy.
# Fast & resilient on both 308MB low-memory panels (KataBump) and large VPSs.
# ─────────────────────────────────────────────────────────────────────────────
set -u

DIR="${1:-.}"
cd "$DIR" || { echo "[install] $DIR — no such directory"; exit 1; }

# 1. Detect container/panel cgroup memory limits (Pterodactyl / Docker / LXC)
read_limit() {
  for FILE in /sys/fs/cgroup/memory.max /sys/fs/cgroup/memory/memory.limit_in_bytes /sys/fs/cgroup/memory.limit_in_bytes; do
    [ -r "$FILE" ] || continue
    VALUE=$(cat "$FILE" 2>/dev/null | tr -d '[:space:]')
    case "$VALUE" in ''|max) continue ;; esac
    if [ "$VALUE" -gt 0 ] 2>/dev/null && [ "$VALUE" -lt 1099511627776 ] 2>/dev/null; then
      echo $((VALUE / 1024))
      return
    fi
  done
  grep MemTotal /proc/meminfo 2>/dev/null | awk '{print $2}'
}

TOTAL_MEM_KB=$(read_limit)
TOTAL_MEM_KB=${TOTAL_MEM_KB:-2000000}
TOTAL_MEM_MB=$((TOTAL_MEM_KB / 1024))

# 2. Check available disk space
AVAILABLE_KB=$(df -Pk "$PWD" 2>/dev/null | awk 'NR==2 {print $4}')
AVAILABLE_MB=0
if [ -n "$AVAILABLE_KB" ]; then
  AVAILABLE_MB=$((AVAILABLE_KB / 1024))
fi

echo "[install] $DIR — detected container RAM: ${TOTAL_MEM_MB}MB | available disk: ${AVAILABLE_MB}MB"

# 3. Route cache and temp to disk, never memory-backed /tmp
CACHE_DIR="$PWD/.npm-cache"
TMP_DIR="$PWD/.npm-tmp"
mkdir -p "$CACHE_DIR" "$TMP_DIR"

cleanup_disk() {
  rm -rf "$TMP_DIR" "$CACHE_DIR" 2>/dev/null || true
}

# If disk is tight (< 120MB), clean caches immediately before starting
if [ -n "$AVAILABLE_KB" ] && [ "$AVAILABLE_KB" -lt 122880 ] 2>/dev/null; then
  echo "[install] Disk space is constrained (${AVAILABLE_MB}MB free). Purging old caches..."
  cleanup_disk
  mkdir -p "$CACHE_DIR" "$TMP_DIR"
fi

# 4. Configure memory profile & install strategy based on detected RAM
# Low-memory panel (<= 512MB RAM, e.g. KataBump 308MB):
# Never run 'npm ci' which buffers entire lockfile into memory causing exit 137.
# Use streaming locked install with maxsockets=1 and capped V8 heap.
if [ "$TOTAL_MEM_MB" -le 512 ]; then
  PROFILE="Low-Memory Panel (capped heap, maxsockets=1, disk-cached)"
  HEAPS="128 140 112"
  SOCKETS=1
  CMD="install"
  EXTRA_FLAGS="--omit=dev --prefer-offline"
else
  PROFILE="High-Performance Panel/VPS (multi-socket, fast lockfile install)"
  HEAPS="384 256"
  SOCKETS=4
  if [ -f package-lock.json ]; then CMD="ci"; else CMD="install"; fi
  EXTRA_FLAGS="--omit=dev"
fi

echo "[install] Profile: $PROFILE"

clean_tree() {
  rm -rf node_modules
}

ATTEMPT=0
TOTAL=$(echo "$HEAPS" | wc -w)

for HEAP in $HEAPS; do
  ATTEMPT=$((ATTEMPT + 1))
  echo "[install] Attempt $ATTEMPT/$TOTAL — V8 heap capped at ${HEAP}MB..."

  SCRIPT_FLAG=""
  if [ "$ATTEMPT" -eq "$TOTAL" ]; then
    SCRIPT_FLAG="--ignore-scripts"
    echo "[install] Final fallback attempt runs with --ignore-scripts + rebuild"
  fi

  UV_THREADPOOL_SIZE=1 \
  NODE_OPTIONS="--max-old-space-size=${HEAP}" \
  npm_config_cache="$CACHE_DIR" \
  npm_config_maxsockets="$SOCKETS" \
  TMPDIR="$TMP_DIR" \
  npm "$CMD" \
      --no-audit --no-fund --no-progress \
      --legacy-peer-deps \
      --maxsockets="$SOCKETS" \
      --fetch-retries 3 \
      --fetch-retry-maxtimeout 60000 \
      --loglevel=warn \
      $EXTRA_FLAGS \
      $SCRIPT_FLAG
  CODE=$?

  if [ $CODE -eq 0 ] && [ -n "$SCRIPT_FLAG" ]; then
    for pkg in sharp @napi-rs/canvas @resvg/resvg-js bufferutil utf-8-validate; do
      [ -d "node_modules/$pkg" ] || continue
      echo "[install] Rebuilding $pkg..."
      NODE_OPTIONS="--max-old-space-size=${HEAP}" npm rebuild "$pkg" --no-audit --no-fund 2>/dev/null || true
    done
  fi

  if [ $CODE -eq 0 ]; then
    echo "[install] Installation succeeded on attempt $ATTEMPT! Cleaning temporary disk caches..."
    cleanup_disk
    exit 0
  fi

  echo "[install] Attempt $ATTEMPT failed with exit code $CODE. Cleaning and retrying with alternative heap profile..."
  clean_tree
done

cleanup_disk
echo "[install] Installation attempts exhausted."
exit 1
