#!/bin/bash
set -e
cd "."

# Auto-pull latest code from GitHub on startup so bot is never stale
if [ "${AUTO_PULL:-on}" != "off" ] && [ -d ".git" ] && command -v git >/dev/null 2>&1; then
  echo "[BUILD-SYNC] Checking GitHub for updates..."
  git config pull.rebase false 2>/dev/null || true
  if git fetch origin main --depth=1 --quiet 2>/dev/null || git fetch origin main --quiet 2>/dev/null; then
    LOCAL_SHA=$(git rev-parse HEAD 2>/dev/null || echo "")
    REMOTE_SHA=$(git rev-parse origin/main 2>/dev/null || echo "")
    if [ -n "$REMOTE_SHA" ] && [ "$LOCAL_SHA" != "$REMOTE_SHA" ]; then
      echo "[BUILD-SYNC] 🚀 New code detected on GitHub ($REMOTE_SHA)! Auto-pulling now..."
      if git reset --hard origin/main 2>/dev/null || git pull origin main 2>/dev/null; then
        echo "[BUILD-SYNC] ✅ Successfully updated to latest GitHub code ($REMOTE_SHA)."
      fi
    else
      echo "[BUILD-SYNC] ✅ Code is up to date ($LOCAL_SHA)."
    fi
  fi
fi

# Ensure critical helpers and shims run first to ensure dependencies
node -e "try{require('./lib/shims/ensure-helpers.cjs')}catch(e){}"

# Install root dependencies if missing
if [ ! -d node_modules ] || [ ! -d node_modules/chalk ] || [ ! -d node_modules/lodash ] || [ ! -d node_modules/axios ] || [ ! -d node_modules/qrcode ] || [ ! -d node_modules/@whiskeysockets/baileys ] || [ ! -d node_modules/@itsliaaa/starforge ] || [ ! -d node_modules/express ]; then
  echo "[MIAS LITE MDX] Installing main dependencies..."
  bash scripts/robust-install.sh .
fi

# Ensure mias/node_modules symlinks to root node_modules
if [ -d mias ]; then
  if [ -e mias/node_modules ] && [ ! -L mias/node_modules ]; then
    rm -rf mias/node_modules
  fi
  if [ ! -e mias/node_modules ]; then
    ln -sf ../node_modules mias/node_modules 2>/dev/null || true
  fi
fi

# Verify sticker engine
for d in mias; do
  [ -d "$d/node_modules/wa-sticker-formatter" ] || continue
  (cd "$d" && node -e "const s=require('sharp');require('wa-sticker-formatter');console.log('[MIAS LITE MDX] sticker engine active (sharp '+s.versions.sharp+')')") \
    || echo "[MIAS LITE MDX] Note: sticker engine running fallback"
done

# Setup local helper
GKTW_PACKAGE="cox"
for d in mias; do
  [ -d "$d" ] || continue
  if [ "$GKTW_PACKAGE" = "cox" ]; then
    if [ ! -d "$d/node_modules/cox" ]; then
      echo "[MIAS LITE MDX] Linking helper cox into $d..."
      (cd "$d" && npm install ../cox --save --no-audit --no-fund --legacy-peer-deps) || true
    fi
  fi
done

# Signal session key cleanup
if [ "0" != "1" ] && [ -d "prezzy_auth" ]; then
  echo "[MIAS LITE MDX] Auth directory preserved"
fi

# Pull the newest code first (also works without a .git folder)
node lib/code-updater.cjs || true

echo "[MIAS LITE MDX] Starting web pairing server and bot supervisor..."
exec node server.js
