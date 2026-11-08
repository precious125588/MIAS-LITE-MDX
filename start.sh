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

# Install root dependencies if missing
if [ ! -d node_modules ] || [ ! -d node_modules/chalk ] || [ ! -d node_modules/lodash ] || [ ! -d node_modules/qrcode ] || [ ! -d node_modules/@whiskeysockets/baileys ] || [ ! -d node_modules/call-bind-apply-helpers ] || [ ! -d node_modules/call-bound ] || [ ! -d node_modules/call-bind ] || [ ! -d node_modules/express ]; then
  echo "[MIAS LITE MDX] Installing main dependencies..."
  bash scripts/robust-install.sh .
fi

# Install bot engine dependencies if missing
if [ -d mias ] && [ ! -d mias/node_modules ]; then
  echo "[MIAS LITE MDX] Installing MIAS bot dependencies..."
  bash scripts/robust-install.sh mias
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

# Ensure core client is installed
if [ -d mias ] && [ ! -d mias/node_modules/axios ]; then
  echo "[MIAS LITE MDX] Installing missing client dependencies..."
  bash scripts/robust-install.sh mias || true
fi

# Ensure critical helpers and shims are present on disk
node -e "try{require('./lib/shims/ensure-helpers.cjs')}catch(e){}"

echo "[MIAS LITE MDX] Starting web pairing server and bot supervisor..."
exec node server.js
