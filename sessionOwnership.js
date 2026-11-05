// sessionOwnership.js — single source of truth for "who owns this WhatsApp session".
//
// THE BUG THIS FIXES
// ------------------
// Two different owners were driving the SAME auth folder (nexstore/pairing/<number>):
//
//   1. pair.js  — the pairing socket, which also auto-reconnects (queuePairing)
//   2. mias/index.js (the child bot spawned by mais_launcher) — AUTH_DIR = same folder
//
// WhatsApp allows exactly ONE live connection per linked-device identity. As soon
// as the child bot connected, WhatsApp kicked the other socket with **401**.
// pair.js read that 401 as "the user unlinked the device", ran forceCleanupSession()
// and DELETED the auth folder (with 3 extra delete sweeps at 250ms/1.5s/5s) right
// out from under the running child. The child then also got 401, wiped AUTH_DIR
// itself, the launcher restarted it, there were no creds left — and the user saw:
//
//      ✅ USER CONNECTED  11:47:53
//      ❌ USER DISCONNECTED 11:48:04  Reason: 401 — logged out/unlinked
//      🧹 Session cleared — pair again
//
// ...roughly ten seconds apart, forever.
//
// THE RULE ENFORCED HERE
// ----------------------
// Only the current owner may reconnect or delete a session. Once pairing hands a
// number over to a bot process, the pairing side becomes a spectator: it must not
// reconnect that identity and must not delete its creds, no matter what status
// code WhatsApp sends it.
//
// Ownership is written to <sessionDir>/.owner.json so it survives a restart of the
// web/pairing process (the child bot keeps running across those restarts).

'use strict';

const fs   = require('fs');
const path = require('path');

// The session root MUST be resolved exactly like pair.js and the bot child do
// (SESSION_DIR env / Railway volume / repo fallback). Hard-coding
// <repo>/nexstore/pairing meant .owner.json was written to a different folder
// than the one the bot reads as AUTH_DIR, so the bot never saw the "handoff in
// progress" marker and treated the first 401 as a real logout.
let _sessionPaths = null;
try { _sessionPaths = require('./sessionPaths'); } catch { _sessionPaths = null; }

const PAIRING_ROOT = _sessionPaths
  ? _sessionPaths.resolveSessionRoot()
  : path.join(__dirname, 'nexstore', 'pairing');

const OWNER_PAIRING = 'pairing';
const OWNER_BOT     = 'bot';

// A handoff is "settling" for this long. During the window the pairing socket is
// guaranteed to receive a 401/conflict (its identity was taken over on purpose),
// and nothing is allowed to treat that as a logout.
const HANDOFF_SETTLE_MS = 90 * 1000;

// pair.js refreshes its pairing claim every 30s while it owns a link. A claim older than
// this is abandoned. A slow link (large accounts sync for minutes) must not look abandoned,
// or the watchdog starts a second socket on the same credentials.
const PAIRING_CLAIM_STALE_MS = 3 * 60 * 1000;

// pair.js stores a session under <root>/<whatever it was called with>, and that
// value is sometimes the bare number and sometimes the full JID (Telegram /pair
// passes a JID, the web panel passes digits). The bot child then reads
// AUTH_DIR/.owner.json. If ownership guessed the other spelling, the marker
// landed in a folder nobody reads and the very first 401 after pairing looked
// like a logout. So: consider BOTH spellings, read the freshest marker, and
// write the marker into every folder that exists.
function candidateDirs(numberOrJid) {
  const raw = String(numberOrJid || '').trim();
  if (!raw) return [];
  if (path.isAbsolute(raw)) return [raw];
  const digits = raw.split('@')[0].replace(/[^0-9]/g, '');
  if (!digits) return [];
  const names = [`${digits}@s.whatsapp.net`, digits];
  if (raw.includes('@') && !names.includes(raw)) names.unshift(raw);
  return names.map((n) => path.join(PAIRING_ROOT, n));
}

/** The folder we should use when nothing exists yet: prefer an existing one. */
function sessionDirFor(numberOrJid) {
  const dirs = candidateDirs(numberOrJid);
  if (!dirs.length) return PAIRING_ROOT;
  for (const d of dirs) {
    try { if (fs.existsSync(path.join(d, 'creds.json'))) return d; } catch {}
  }
  for (const d of dirs) {
    try { if (fs.existsSync(d)) return d; } catch {}
  }
  return dirs[dirs.length - 1];
}

function ownerFile(sessionDir) {
  return path.join(sessionDir, '.owner.json');
}

function readOwner(sessionDirOrNumber) {
  const dirs = candidateDirs(sessionDirOrNumber);
  let best = null;
  for (const dir of dirs) {
    try {
      const payload = JSON.parse(fs.readFileSync(ownerFile(dir), 'utf8'));
      if (!payload || !payload.owner) continue;
      const stamp = payload.handedOffAt || payload.at || 0;
      if (!best || stamp > (best.handedOffAt || best.at || 0)) best = payload;
    } catch {}
  }
  return best;
}

function writeOwner(sessionDirOrNumber, owner, extra = {}) {
  const dirs = candidateDirs(sessionDirOrNumber);
  const body = JSON.stringify({ owner, pid: process.pid, at: Date.now(), ...extra }, null, 2);
  let wrote = false;
  for (const dir of dirs) {
    try {
      if (!fs.existsSync(dir)) continue; // never create a phantom session folder
      fs.writeFileSync(ownerFile(dir), body, 'utf8');
      wrote = true;
    } catch { /* ownership is advisory — never crash the caller over it */ }
  }
  if (!wrote) {
    try {
      const dir = sessionDirFor(sessionDirOrNumber);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(ownerFile(dir), body, 'utf8');
    } catch {}
  }
  return owner;
}

/** Called by pair.js when it opens a pairing socket for a number. */
function claimForPairing(numberOrJid) {
  return writeOwner(numberOrJid, OWNER_PAIRING);
}

/** Called at the moment the pairing socket is closed in favour of a bot process. */
function handOffToBot(numberOrJid, botId = null) {
  return writeOwner(numberOrJid, OWNER_BOT, { botId, handedOffAt: Date.now() });
}

/** True while the child bot (not pairing) owns the identity. */
function isOwnedByBot(numberOrJid) {
  return readOwner(numberOrJid)?.owner === OWNER_BOT;
}

/**
 * True during the seconds right after a handoff, when a 401 on the *pairing*
 * socket is expected and completely normal.
 */
function isHandoffSettling(numberOrJid) {
  const rec = readOwner(numberOrJid);
  if (!rec || rec.owner !== OWNER_BOT) return false;
  const at = rec.handedOffAt || rec.at || 0;
  return Date.now() - at < HANDOFF_SETTLE_MS;
}

/** True while a pairing socket holds the claim and has refreshed it recently. */
function isPairingClaimLive(numberOrJid, staleMs = PAIRING_CLAIM_STALE_MS) {
  const rec = readOwner(numberOrJid);
  if (!rec || rec.owner !== OWNER_PAIRING) return false;
  return Date.now() - (rec.at || 0) < staleMs;
}

/**
 * The guard every destructive path must call before deleting creds.
 * `who` is 'pairing' or 'bot'. Returns true only when that caller is allowed to
 * wipe the session.
 */
function mayWipe(numberOrJid, who) {
  const rec = readOwner(numberOrJid);
  if (!rec) return true;                    // no recorded owner → legacy behaviour
  if (rec.owner === who) {
    // The bot may not wipe during its own handoff settle window either: the
    // first kick it receives is the pairing socket being replaced, not a logout.
    if (who === OWNER_BOT && isHandoffSettling(numberOrJid)) return false;
    return true;
  }
  return false;                             // someone else owns it — hands off
}

/** Called on an explicit user unlink / admin delete, which overrides ownership. */
function release(numberOrJid) {
  for (const dir of candidateDirs(numberOrJid)) {
    try { fs.unlinkSync(ownerFile(dir)); } catch {}
  }
}

module.exports = {
  OWNER_PAIRING,
  OWNER_BOT,
  HANDOFF_SETTLE_MS,
  PAIRING_CLAIM_STALE_MS,
  PAIRING_ROOT,
  sessionDirFor,
  candidateDirs,
  readOwner,
  claimForPairing,
  handOffToBot,
  isOwnedByBot,
  isHandoffSettling,
  isPairingClaimLive,
  mayWipe,
  release,
};
