'use strict';
/**
 * Shared JID helpers for the deployment flow.
 *
 * pair.js tracks users by BARE PHONE NUMBER ("2349012345678") while Baileys
 * reports incoming messages with a FULL JID ("2349012345678@s.whatsapp.net"
 * or "2349012345678:12@s.whatsapp.net" for multi-device).
 *
 * Mixing the two was the root cause of the "it always picks MIAS MDX" bug:
 * the pending-selection map was keyed by bare number, the incoming-message
 * lookup used the full JID, so no selection ever matched and the flow fell
 * through to its timeout default.
 *
 * Everything in deploy/ now keys off `jidKey()` (digits only) and sends to
 * `toJid()` (full addressable JID).
 */

/** Digits-only identity key. "234901:12@s.whatsapp.net" -> "234901" */
function jidKey(input) {
  if (!input) return '';
  return String(input).split('@')[0].split(':')[0].replace(/\D/g, '');
}

/** Full sendable JID. "2349012345678" -> "2349012345678@s.whatsapp.net" */
function toJid(input) {
  if (!input) return '';
  const raw = String(input);
  // Preserve group / broadcast / newsletter JIDs untouched.
  if (raw.includes('@') && !raw.endsWith('@s.whatsapp.net')) return raw;
  const digits = jidKey(raw);
  return digits ? `${digits}@s.whatsapp.net` : '';
}

/** True when both inputs refer to the same user, regardless of format. */
function sameUser(a, b) {
  const ka = jidKey(a);
  return !!ka && ka === jidKey(b);
}

module.exports = { jidKey, toJid, sameUser };
