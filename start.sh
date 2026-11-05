#!/bin/bash
set -e
cd "."

# Install root dependencies if missing
if [ ! -d node_modules ] || [ ! -d node_modules/chalk ]; then
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
  [ -d "/node_modules/wa-sticker-formatter" ] || continue
  (cd "" && node -e "const s=require('sharp');require('wa-sticker-formatter');console.log('[MIAS LITE MDX] sticker engine active (sharp '+s.versions.sharp+')')")     || echo "[MIAS LITE MDX] Note: sticker engine running fallback"
done

# Setup local helper
GKTW_PACKAGE="cox"
for d in mias; do
  [ -d "" ] || continue
  if [ "" = "cox" ]; then
    if [ ! -d "/node_modules/cox" ]; then
      echo "[MIAS LITE MDX] Linking helper cox into ..."
      (cd "" && npm install ../cox --save --no-audit --no-fund --legacy-peer-deps) || true
    fi
  fi
done

# Signal session key cleanup
if [ "0" != "1" ] && [ -d "prezzy_auth" ]; then
  cleared=0
  if [ "" -gt 0 ]; then
    echo "[MIAS LITE MDX] Cleared  stale state snapshots from auth dir"
  fi
fi

# Ensure core client is installed
if [ -d mias ] && [ ! -d mias/node_modules/axios ]; then
  echo "[MIAS LITE MDX] Installing missing client dependencies..."
  bash scripts/robust-install.sh mias || true
fi

echo "[MIAS LITE MDX] Starting web pairing server and bot supervisor..."
exec node server.js
