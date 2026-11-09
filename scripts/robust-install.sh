#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# robust-install.sh <dir>
# Low-memory resilient installer for container and low-RAM environments
# ─────────────────────────────────────────────────────────────────────────────
set -u

DIR="${1:-.}"
cd "$DIR" || { echo "[install] $DIR — no such directory"; exit 1; }

# Detect the panel/container memory limit (cgroup-aware; MemTotal can expose host RAM).
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
if [ -n "${NPM_HEAPS:-}" ]; then
  HEAPS="$NPM_HEAPS"
elif [ "$TOTAL_MEM_KB" -le 393216 ]; then
  HEAPS="96 72 64"
elif [ "$TOTAL_MEM_KB" -le 786432 ]; then
  HEAPS="160 128 96"
elif [ "$TOTAL_MEM_KB" -le 1572864 ]; then
  HEAPS="256 192 160"
else
  HEAPS="512 384 256"
fi

# Keep npm's cache on the persistent application disk rather than /tmp, which may
# be a memory-backed filesystem on hosting panels.
CACHE_DIR="$PWD/.npm-cache"
TMP_DIR="$PWD/.npm-tmp"
mkdir -p "$CACHE_DIR" "$TMP_DIR"
AVAILABLE_KB=$(df -Pk "$PWD" 2>/dev/null | awk 'NR==2 {print $4}')
if [ -n "$AVAILABLE_KB" ]; then
  AVAILABLE_MB=$((AVAILABLE_KB / 1024))
  echo "[install] $DIR — detected memory limit $((TOTAL_MEM_KB / 1024))MB; available disk ${AVAILABLE_MB}MB"
  if [ "$AVAILABLE_KB" -lt 102400 ]; then
    echo "[install] $DIR — less than 100MB disk space is available; free panel disk space before installing."
    rm -rf "$TMP_DIR"
    exit 1
  fi
fi

ATTEMPT=0
TOTAL=$(echo "$HEAPS" | wc -w)

clean_tree() {
  rm -rf node_modules
}

for HEAP in $HEAPS; do
  ATTEMPT=$((ATTEMPT + 1))
  echo "[install] $DIR — attempt $ATTEMPT/$TOTAL (heap ${HEAP}MB)"

  EXTRA=""
  if [ "$ATTEMPT" -eq "$TOTAL" ]; then
    EXTRA="--ignore-scripts"
    echo "[install] $DIR — final attempt runs with --ignore-scripts + rebuild"
  fi

  if [ -f package-lock.json ]; then INSTALL_COMMAND=ci; else INSTALL_COMMAND=install; fi

  NODE_OPTIONS="--max-old-space-size=${HEAP}" \
  npm_config_cache="$CACHE_DIR" \
  npm_config_maxsockets=1 \
  TMPDIR="$TMP_DIR" \
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
    rm -rf "$TMP_DIR"
    exit 0
  fi

  echo "[install] $DIR — attempt $ATTEMPT failed (exit $CODE); full clean and retry"
  clean_tree
done

echo "[install] $DIR — full lockfile install attempts exhausted; refusing to start with a partial dependency tree."

echo "[install] $DIR — all attempts failed"
rm -rf "$TMP_DIR"
exit 1
