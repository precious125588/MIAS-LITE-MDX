'use strict';

function sessionDigits(value) {
  return String(value || '').split('@')[0].split(':')[0].replace(/\D/g, '');
}

function parseDiscardSessions(value) {
  return new Set(String(value || '')
    .split(/[,|\s]+/)
    .map(sessionDigits)
    .filter(Boolean));
}

function matchesSession(value, digits) {
  return Boolean(digits) && sessionDigits(value) === digits;
}

function isSessionIdentity(value) {
  return /^\+?\d+(?::\d+)?(?:@s\.whatsapp\.net)?(?:\.quarantine-[\w.-]+)?$/i.test(String(value || '').trim());
}

function shouldPruneSession(value, envSessionDigits, discardSet = new Set(), purgeAll = false) {
  const raw = String(value || '').trim();
  const digits = sessionDigits(raw);
  if (!digits || !isSessionIdentity(raw)) return false;
  if (envSessionDigits && digits === envSessionDigits) return false;
  return Boolean(purgeAll || discardSet.has(digits));
}

// The installed fork revives {type:'Buffer', data:<base64>} but not the
// standard Node JSON array form. Convert representation, never key material.
function authJsonReplacer(_key, value) {
  if (value?.type === 'Buffer' && Array.isArray(value.data)) {
    if (!value.data.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
      throw new Error('Invalid byte array in authentication data');
    }
    return { type: 'Buffer', data: Buffer.from(value.data).toString('base64') };
  }
  return value;
}

function normalizeLegacyAuthBuffers(targetDir) {
  const fs = require('node:fs');
  const path = require('node:path');
  const pending = [];
  for (const name of fs.readdirSync(targetDir)) {
    if (name.startsWith('.') || !name.endsWith('.json')) continue;
    const file = path.join(targetDir, name);
    if (!fs.statSync(file).isFile()) continue;
    const original = fs.readFileSync(file, 'utf8');
    let changed = false;
    const encoded = JSON.stringify(JSON.parse(original), (key, value) => {
      const next = authJsonReplacer(key, value);
      if (next !== value) changed = true;
      return next;
    }, 2);
    if (changed) pending.push({ file, encoded });
  }
  for (const { file, encoded } of pending) {
    fs.writeFileSync(file + '.buffer-migration.tmp', encoded, { mode: 0o600 });
    fs.renameSync(file + '.buffer-migration.tmp', file);
  }
  return pending.length;
}

// A session token is an import seed, not a backup of the latest ratchets.
// Never replace rotated credentials, or merge keys from separate companion links.
function initializeSessionDirectory(targetDir, bootResult) {
  const fs = require('node:fs');
  const path = require('node:path');
  const expected = sessionDigits(bootResult?.canonicalJid);
  const creds = bootResult?.credsObj;
  if (!expected || sessionDigits(creds?.me?.id) !== expected || creds?.registered === false ||
      !creds?.noiseKey || !creds?.signedIdentityKey) {
    throw new Error('SESSION_ID must contain a paired identity and authentication keys');
  }
  fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
  const target = path.join(targetDir, 'creds.json');
  if (fs.existsSync(target)) {
    let saved;
    try { saved = JSON.parse(fs.readFileSync(target, 'utf8')); }
    catch { throw new Error('Saved credentials are unreadable; preserved for recovery, not overwritten'); }
    if (sessionDigits(saved?.me?.id) !== expected || saved?.registered === false ||
        !saved?.noiseKey || !saved?.signedIdentityKey) {
      throw new Error('Existing auth directory needs explicit recovery; SESSION_ID import refused');
    }
    normalizeLegacyAuthBuffers(targetDir);
    return { initialized: false, credsObj: JSON.parse(fs.readFileSync(target, 'utf8')) };
  }
  // A partially restored key store must be recovered as a complete snapshot.
  if (fs.readdirSync(targetDir).some(name => !name.startsWith('.') && name.endsWith('.json'))) {
    throw new Error('Auth keys exist without creds.json; refusing to mix them with SESSION_ID');
  }
  // Exclusive creation also protects concurrent bootstrap calls. Baileys does
  // not start until this synchronous write completes.
  try {
    fs.writeFileSync(target, JSON.stringify(creds, authJsonReplacer, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') return initializeSessionDirectory(targetDir, bootResult);
    throw error;
  }
  return { initialized: true, credsObj: JSON.parse(fs.readFileSync(target, 'utf8')) };
}

function connectedWorkerStatus(worker, status) {
  return Boolean(worker?.alive && !worker?.paused && status?.state === 'open' &&
    sessionDigits(worker.number) && sessionDigits(worker.number) === sessionDigits(status.number) &&
    Number(status.updatedAt) >= Date.now() - Number(worker.uptimeMs || 0) - 2000);
}

module.exports = { sessionDigits, parseDiscardSessions, matchesSession, isSessionIdentity, shouldPruneSession, initializeSessionDirectory, connectedWorkerStatus, authJsonReplacer, normalizeLegacyAuthBuffers };
