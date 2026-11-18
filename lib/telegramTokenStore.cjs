'use strict';
/* ── TELEGRAM BOT TOKEN STORE ─────────────────────────────────────────────────
   Keeps the Telegram bot token that powers .tgs / .tgsticker / .tgpack in a
   file on the persistent data volume, so it survives bot restarts, panel
   restarts and code updates. Values typed into a panel's environment screen
   can be wiped by an update; this file cannot, because the updater never
   touches nexstore/ (see lib/code-updater.cjs KEEP list).

   Location: <nexstore root>/secrets/telegram-bot-token.json
     - nexstore root = Railway volume (/app/nexstore) when mounted, else <repo>/nexstore
     - override with MIAS_SECRETS_DIR=<folder> (used by tests)
   The folder is git-ignored and the file is written with mode 0600.

   Precedence when the bot needs the token:
     1. token saved with .settoken   (always wins; it is the newest explicit choice)
     2. TELEGRAM_BOT_TOKEN from the environment / panel variables
     3. TGS_BOT_TOKEN / TG_BOT_TOKEN from the environment

   The file is re-read on every call (it is tiny), so the command process and
   the bot worker process always agree without a restart. */

const fs = require('fs');
const path = require('path');

const TOKEN_RE = /^\d{6,12}:[A-Za-z0-9_-]{30,}$/;
const FILE_NAME = 'telegram-bot-token.json';

let bootEnvToken = null; // value of TELEGRAM_BOT_TOKEN before this module first changed it

function isValidTelegramToken(value) {
  return TOKEN_RE.test(String(value || '').trim());
}

function secretsDir() {
  const override = String(process.env.MIAS_SECRETS_DIR || '').trim();
  if (override) return path.resolve(override);
  try {
    const sessionPaths = require('../sessionPaths.js');
    return path.join(sessionPaths.nexstoreRoot(), 'secrets');
  } catch (_) {
    return path.join(__dirname, '..', 'nexstore', 'secrets');
  }
}

function storeFile() {
  return path.join(secretsDir(), FILE_NAME);
}

/** Returns the saved token, or '' when none is saved or the file is unreadable. */
function readStoredToken() {
  try {
    const data = JSON.parse(fs.readFileSync(storeFile(), 'utf8'));
    const token = String(data && data.token || '').trim();
    return isValidTelegramToken(token) ? token : '';
  } catch (_) {
    return '';
  }
}

/** Reads metadata about the saved token without exposing it. */
function readStoredMeta() {
  try {
    const data = JSON.parse(fs.readFileSync(storeFile(), 'utf8'));
    return { savedAt: data.savedAt || null, botUsername: data.botUsername || null };
  } catch (_) {
    return null;
  }
}

/** Atomically writes the token to the persistent file. Throws on bad format. */
function saveStoredToken(token, meta = {}) {
  const clean = String(token || '').trim();
  if (!isValidTelegramToken(clean)) throw new Error('invalid Telegram bot token format');
  const file = storeFile();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  const payload = { token: clean, savedAt: new Date().toISOString(), ...meta };
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch (_) {}
  loadIntoEnv();
  return file;
}

/** Removes the saved token and restores the environment value the bot booted with. */
function clearStoredToken() {
  let removed = false;
  try { fs.rmSync(storeFile(), { force: true }); removed = true; } catch (_) {}
  if (bootEnvToken) process.env.TELEGRAM_BOT_TOKEN = bootEnvToken;
  else delete process.env.TELEGRAM_BOT_TOKEN;
  loadIntoEnv();
  return removed;
}

/**
 * Makes process.env.TELEGRAM_BOT_TOKEN match the saved token when one exists.
 * Returns where the active token came from: 'saved' | 'env' | 'none'.
 */
function loadIntoEnv() {
  if (bootEnvToken === null) bootEnvToken = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
  const saved = readStoredToken();
  if (saved) {
    process.env.TELEGRAM_BOT_TOKEN = saved;
    return 'saved';
  }
  const envToken = String(process.env.TELEGRAM_BOT_TOKEN || process.env.TGS_BOT_TOKEN || process.env.TG_BOT_TOKEN || '').trim();
  return envToken ? 'env' : 'none';
}

/** The token the bot will use right now, and where it came from. */
function activeToken() {
  const saved = readStoredToken();
  if (saved) return { token: saved, source: 'saved' };
  const env = String(process.env.TELEGRAM_BOT_TOKEN || process.env.TGS_BOT_TOKEN || process.env.TG_BOT_TOKEN || '').trim();
  if (env) return { token: env, source: 'env' };
  return { token: '', source: 'none' };
}

/** "123456789:AAE…xyz" → "…xyz" so a reply can show which token is active without leaking it. */
function maskToken(token) {
  const t = String(token || '');
  return t ? `…${t.slice(-4)}` : '';
}

module.exports = {
  isValidTelegramToken,
  secretsDir,
  storeFile,
  readStoredToken,
  readStoredMeta,
  saveStoredToken,
  clearStoredToken,
  loadIntoEnv,
  activeToken,
  maskToken,
};
