'use strict';
/*
 * SESSION_ID restore for one worker's auth directory.
 * Readable home for the logic that used to live inside mias/index.js.
 *
 * Order (same as before):
 *   1. creds.json already on disk → keep it
 *   2. restore from the database, if one is provided
 *   3. import SESSION_ID (prezzy_ / JUST_X prefixes, JSON or base64)
 *
 * Safety rules:
 *   • a corrupt creds.json is never overwritten            → "unreadable"
 *   • creds for one account are never written into another
 *     account's folder                                       → "different worker"
 *   • a legacy multi-file export is validated before anything is written
 *                                                            → "Unsafe session export"
 */
const fs = require('fs');
const path = require('path');
const { normalizeLegacyAuthBuffers } = require('../../scripts/sessionPolicy.cjs');

const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/;

function digitsOf(jidOrId) {
  return String(jidOrId || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
}

function accountOfDir(dir) {
  const m = path.basename(dir).match(/^(\d{6,20})@s\.whatsapp\.net$/);
  return m ? m[1] : '';
}

function looksLikeCreds(o) {
  return !!o && typeof o === 'object' && !Array.isArray(o) && !!(o.noiseKey || o.signedIdentityKey || o.me);
}

function assertSameAccount(creds, dir) {
  const want = accountOfDir(dir);
  const got = digitsOf(creds && creds.me && creds.me.id);
  if (want && got && want !== got) {
    throw new Error(`different worker: this SESSION_ID belongs to ${got}, but ${path.basename(dir)} is for ${want}. Not imported.`);
  }
}

function stripPrefix(raw) {
  let s = String(raw || '').trim();
  s = s.replace(/^(?:JUST[-_ ]?X|MIAS[-_ ]?(?:LITE[-_ ]?)?MDX|MIAS[-_ ]?LITE|MIAS|MAIS)[~_ -]/i, '');
  if (s.startsWith('prezzy_')) s = s.slice('prezzy_'.length);
  return s;
}

function decodeSessionId(raw) {
  const text = Buffer.from(stripPrefix(raw), 'base64').toString('utf8');
  try { return JSON.parse(text); } catch { return null; }
}

function readDiskCreds(file) {
  if (!fs.existsSync(file)) return { state: 'missing' };
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return { state: 'unreadable', error: e.message };
  }
  return looksLikeCreds(parsed) ? { state: 'ok', creds: parsed } : { state: 'empty' };
}

async function restoreSessionFromSessionId(opts = {}) {
  const { sessionId, authDir, restoreFromDb, log = console.log } = opts;
  const dir = String(authDir || '');
  if (!dir) throw new Error('authDir is required');
  const credsFile = path.join(dir, 'creds.json');
  fs.mkdirSync(dir, { recursive: true });

  const disk = readDiskCreds(credsFile);
  if (disk.state === 'unreadable') {
    throw new Error(`creds.json in ${dir} is unreadable (${disk.error}); not overwriting it. Fix or remove that file, then restart.`);
  }
  if (disk.state === 'ok') {
    log('✅ Session found on disk → ' + dir);
    return true;
  }

  if (typeof restoreFromDb === 'function') {
    try {
      const r = await restoreFromDb(path.basename(dir), dir);
      if (r && r.restored > 0 && fs.existsSync(credsFile)) {
        log('✅ Session restored from database → ' + dir);
        return true;
      }
    } catch { /* database is optional; fall through to SESSION_ID */ }
  }

  if (!sessionId) {
    log('ℹ️  No SESSION_ID set; waiting for paired creds in AUTH_DIR.');
    return false;
  }

  const parsed = decodeSessionId(sessionId);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('invalid SESSION_ID. Get a new one from the pairing server.');
  }

  if (parsed['creds.json'] !== undefined) {
    const entries = Object.entries(parsed);
    for (const [name] of entries) {
      if (!SAFE_FILE.test(name) || name.includes('..')) {
        throw new Error(`Unsafe session export: file name "${name}" is not allowed. Nothing was written.`);
      }
    }
    const credsObj = typeof parsed['creds.json'] === 'string' ? safeParse(parsed['creds.json']) : parsed['creds.json'];
    if (!looksLikeCreds(credsObj)) throw new Error('invalid SESSION_ID: the creds.json inside the export has no account data.');
    assertSameAccount(credsObj, dir);
    for (const [name, value] of entries) {
      const body = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
      fs.writeFileSync(path.join(dir, name), body, 'utf8');
    }
    normalizeLegacyAuthBuffers(dir); // Node's [bytes] arrays → the base64 form Baileys can revive
    log('✅ Session restored (legacy multi-file) → ' + dir);
    return true;
  }

  if (looksLikeCreds(parsed)) {
    assertSameAccount(parsed, dir);
    fs.writeFileSync(credsFile, JSON.stringify(parsed, null, 2), 'utf8');
    normalizeLegacyAuthBuffers(dir);
    log('✅ Session restored (creds format) → ' + dir);
    return true;
  }

  throw new Error('invalid SESSION_ID. Get a new one from the pairing server.');
}

function safeParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

module.exports = { restoreSessionFromSessionId, decodeSessionId, assertSameAccount, SAFE_FILE };
