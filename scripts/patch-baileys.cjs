'use strict';
/**
 * Automated idempotent patcher for @itsliaaa/baileys.
 * Hooks into messages-recv.js to allow conditional delivery receipt suppression
 * when anonymousMode is active, while preserving all message decryption,
 * upsert, protocol ACKs, read receipts, peer/sender/history receipts.
 */
const fs = require('fs');
const path = require('path');

function patchFile(filePath) {
  if (!fs.existsSync(filePath)) return false;
  let code = fs.readFileSync(filePath, 'utf8');
  if (code.includes('__ANONYMOUS_MODE_HOOK__')) {
    return true; // Already patched
  }

  // Target:
  // acked = true;
  // await sendReceipt(msg.key.remoteJid, participant, [msg.key.id], type);
  const targetPattern = /acked\s*=\s*true;\s*await\s+sendReceipt\(msg\.key\.remoteJid,\s*participant,\s*\[msg\.key\.id\],\s*type\);/;
  if (!targetPattern.test(code)) {
    console.warn(`[patch-baileys] Target pattern not found in ${filePath}`);
    return false;
  }

  const replacement = `acked = true;
                        /* __ANONYMOUS_MODE_HOOK__ */
                        const _shouldSuppressDelivery = typeof config?.shouldSuppressDeliveryReceipt === 'function'
                            ? config.shouldSuppressDeliveryReceipt(msg, type)
                            : (globalThis.__miasShouldSuppressDelivery && globalThis.__miasShouldSuppressDelivery(authState?.creds?.me?.id, msg, type));
                        if (!_shouldSuppressDelivery) {
                            await sendReceipt(msg.key.remoteJid, participant, [msg.key.id], type);
                        } else {
                            if (logger && typeof logger.debug === 'function') {
                                logger.debug({ id: msg?.key?.id }, '[Anonymous Mode] Suppressed incoming delivery receipt');
                            }
                        }`;

  code = code.replace(targetPattern, replacement);
  fs.writeFileSync(filePath, code, 'utf8');
  console.log(`[patch-baileys] Successfully patched ${filePath}`);
  return true;
}

function run() {
  const root = path.join(__dirname, '..');
  const candidates = [
    path.join(root, 'node_modules', '@whiskeysockets', 'baileys', 'lib', 'Socket', 'messages-recv.js'),
    path.join(root, 'node_modules', '@itsliaaa', 'baileys', 'lib', 'Socket', 'messages-recv.js'),
    path.join(root, 'mias', 'node_modules', '@whiskeysockets', 'baileys', 'lib', 'Socket', 'messages-recv.js'),
    path.join(root, 'mias', 'node_modules', '@itsliaaa', 'baileys', 'lib', 'Socket', 'messages-recv.js')
  ];

  let patchedCount = 0;
  for (const c of candidates) {
    if (patchFile(c)) patchedCount++;
  }
  return patchedCount;
}

if (require.main === module) {
  run();
}

module.exports = { run, patchFile };
