#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# robust-install.sh <dir>
# Auto-detects container RAM & Disk space to pick optimal installation strategy.
# - On low-memory panels (<= 512MB RAM, e.g. KataBump 308MB): runs paced staged
#   install to prevent KataBump's anti-abuse high file creation rate kill (>5000/15s)
#   and keeps V8 heap capped at 128MB.
# - On large VPSs (> 512MB RAM): runs high-throughput fast lockfile install.
# ─────────────────────────────────────────────────────────────────────────────
set -u

DIR="${1:-.}"
cd "$DIR" || { echo "[install] $DIR — no such directory"; exit 1; }

# 1. Clean stale temporary caches immediately before anything else to free disk
cleanup_disk() {
  rm -rf "$PWD/.npm-cache" "$PWD/.npm-tmp" "$PWD/tmp" 2>/dev/null || true
}
cleanup_disk

# 2. Detect container/panel cgroup memory limits (Pterodactyl / Docker / LXC)
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

# 3. Check available disk space
AVAILABLE_KB=$(df -Pk "$PWD" 2>/dev/null | awk 'NR==2 {print $4}')
AVAILABLE_MB=0
if [ -n "$AVAILABLE_KB" ]; then
  AVAILABLE_MB=$((AVAILABLE_KB / 1024))
fi

echo "[install] $DIR — detected container RAM: ${TOTAL_MEM_MB}MB | available disk: ${AVAILABLE_MB}MB"

# 4. If running on low-memory panel (<= 512MB RAM, like KataBump 308MB):
# Run paced install script to ensure file creation stays < 5,000 files/15s and heap <= 128MB.
if [ "$TOTAL_MEM_MB" -le 512 ]; then
  echo "[install] Profile: Low-Memory Panel (capped heap 128MB, paced file bursts)"
  if [ -f scripts/panel-paced-install.cjs ]; then
    echo "[install] Running panel-paced-install.cjs..."
    if node scripts/panel-paced-install.cjs "$PWD"; then
      echo "[install] Paced installation succeeded! Cleaning temporary files..."
      cleanup_disk
      exit 0
    else
      echo "[install] Paced install failed. Retrying with fallback..."
    fi
  fi
  HEAPS="128 140"
  SOCKETS=1
  CMD="install"
  EXTRA_FLAGS="--omit=dev --prefer-offline"
else
  PROFILE="High-Performance Panel/VPS (multi-socket, fast lockfile install)"
  echo "[install] Profile: $PROFILE"
  HEAPS="384 256"
  SOCKETS=4
  if [ -f package-lock.json ]; then CMD="ci"; else CMD="install"; fi
  EXTRA_FLAGS="--omit=dev"
fi

CACHE_DIR="$PWD/.npm-cache"
TMP_DIR="$PWD/.npm-tmp"
mkdir -p "$CACHE_DIR" "$TMP_DIR"

clean_tree() {
  rm -rf node_modules
}

ATTEMPT=0
TOTAL=$(echo "$HEAPS" | wc -w)

for HEAP in $HEAPS; do
  ATTEMPT=$((ATTEMPT + 1))
  echo "[install] Attempt $ATTEMPT/$TOTAL — V8 heap capped at ${HEAP}MB..."

  UV_THREADPOOL_SIZE=1   NODE_OPTIONS="--max-old-space-size=${HEAP}"   npm_config_cache="$CACHE_DIR"   npm_config_maxsockets="$SOCKETS"   TMPDIR="$TMP_DIR"   npm "$CMD"       --no-audit --no-fund --no-progress       --legacy-peer-deps       --maxsockets="$SOCKETS"       --fetch-retries 3       --fetch-retry-maxtimeout 60000       --loglevel=warn       $EXTRA_FLAGS
  CODE=$?

  if [ $CODE -eq 0 ]; then
    echo "[install] Installation succeeded on attempt $ATTEMPT! Cleaning disk..."
    cleanup_disk
    exit 0
  fi

  echo "[install] Attempt $ATTEMPT failed with exit code $CODE."
  clean_tree
done

cleanup_disk
echo "[install] Installation attempts exhausted."
exit 1
