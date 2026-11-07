'use strict';
/*
 * Session debug helpers (CommonJS, no side effects on require).
 *  • describeSession(dir): is a paired session usable on disk?
 *      missing | unreadable | unregistered | ok   (+ stale hint by age)
 *  • summarizeSessionRoot(root): one entry per paired session folder
 *  • classifyDisconnect(code): plain reason for a Baileys DisconnectReason code
 *  • logSessionDebug(root, log): one line per session plus a verdict, at boot
 *
 * Env: SESSION_STALE_DAYS (default 14) — creds older than this get a "stale" hint.
 */
const fs = require('fs');
const path = require('path');

// Baileys DisconnectReason values
const DISCONNECT = {
  connectionClosed: 428,
  connectionLost: 408,
  connectionReplaced: 440,
  timedOut: 408,
  loggedOut: 401,
  badSession: 500,
  restartRequired: 515,
  multideviceMismatch: 411,
  forbidden: 403,
  unavailableService: 503,
};

const HINTS = {
  401: 'loggedOut: WhatsApp ended this linked device. Pair the number again.',
  500: 'badSession: the saved session data is corrupt or rejected. Pair again.',
  440: 'connectionReplaced: another device took over this session. Keep one active login.',
  403: 'forbidden: WhatsApp refused the session (often a ban or a reused session). Check the account.',
  411: 'multideviceMismatch: the session and the account disagree. Pair again.',
  515: 'restartRequired: normal reconnect after pairing, not a fault.',
  428: 'connectionClosed: the socket closed. Usually transient; a repeat means a network or session issue.',
  408: 'connectionLost/timedOut: the link dropped. Usually transient; a repeat means a network issue.',
  503: 'unavailableService: WhatsApp is unavailable right now. Wait and retry.',
};

function staleDays() {
  const n = Number(process.env.SESSION_STALE_DAYS);
  return Number.isFinite(n) && n > 0 ? n : 14;
}

function describeSession(dir, opts = {}) {
  const now = opts.now || Date.now();
  const out = { dir, status: 'missing', jid: null, ageDays: null, reasons: [] };
  const credsPath = path.join(dir, 'creds.json');
  if (!fs.existsSync(credsPath)) {
    out.reasons.push('creds.json not found');
    return out;
  }
  try {
    out.ageDays = Math.floor((now - fs.statSync(credsPath).mtimeMs) / 86400000);
  } catch (e) { /* age is a hint only */ }
  let creds;
  try {
    creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
  } catch (e) {
    out.status = 'unreadable';
    out.reasons.push('creds.json is not valid JSON: ' + (e && e.message));
    return out;
  }
  out.jid = creds && creds.me && typeof creds.me.id === 'string' ? creds.me.id : null;
  if (creds.registered === false || !out.jid) {
    out.status = 'unregistered';
    out.reasons.push(!out.jid ? 'no account id in creds (not paired)' : 'creds marked unregistered');
    return out;
  }
  out.status = 'ok';
  if (out.ageDays != null && out.ageDays >= staleDays()) {
    out.reasons.push(`creds not updated for ${out.ageDays} days (stale hint, may still work)`);
  }
  return out;
}

function summarizeSessionRoot(root, opts = {}) {
  let names = [];
  try { names = fs.readdirSync(root); } catch (e) { return []; }
  return names
    .filter(n => !n.includes('.quarantine-'))
    .filter(n => { try { return fs.statSync(path.join(root, n)).isDirectory(); } catch (e) { return false; } })
    .map(n => describeSession(path.join(root, n), opts));
}

function classifyDisconnect(code) {
  const n = Number(code);
  const name = Object.keys(DISCONNECT).find(k => DISCONNECT[k] === n) || 'unknown';
  const session_invalid = n === 401 || n === 500 || n === 411;
  return {
    code: Number.isFinite(n) ? n : null,
    name,
    sessionInvalid: session_invalid,
    hint: HINTS[n] || 'unrecognised disconnect code; check the bot log for the full error.',
  };
}

function logSessionDebug(root, log = console.log) {
  const sessions = summarizeSessionRoot(root);
  if (!sessions.length) {
    log('[session-debug] no paired sessions under ' + root + ' — pair a number before the bot can come online');
    return sessions;
  }
  for (const s of sessions) {
    const who = s.jid ? s.jid.split(':')[0] : path.basename(s.dir);
    const extra = s.reasons.length ? ' — ' + s.reasons.join('; ') : '';
    log(`[session-debug] ${who}: ${s.status}${s.ageDays != null ? ` (creds ${s.ageDays}d old)` : ''}${extra}`);
  }
  const usable = sessions.filter(s => s.status === 'ok').length;
  log(`[session-debug] verdict: ${usable}/${sessions.length} session(s) usable on disk`);
  return sessions;
}

module.exports = { describeSession, summarizeSessionRoot, classifyDisconnect, logSessionDebug, DISCONNECT };
