/**
 * sessionPaths.js — ONE source of truth for where WhatsApp session credentials
 * live, so a Railway redeploy can never lose a paired session again.
 *
 * WHY THIS EXISTS
 * ---------------
 * Your volume is mounted at  /app/nexstore   (railway.toml → [[volumes]] mountPath).
 * Anything written OUTSIDE /app/nexstore lives in the container image layer and is
 * thrown away on every deploy — that is why the bot asked you to pair again.
 *
 * Resolution order (first match wins):
 *   1. explicit argument        (caller knows best)
 *   2. process.env.SESSION_DIR  (you can override it in Railway variables)
 *   3. /app/nexstore/pairing    (volume present → ALWAYS this)
 *   4. <repo>/nexstore/pairing  (local dev / non-Docker)
 *
 * This module also exposes safe quarantine helpers: session folders are never
 * hard-deleted any more, they are renamed aside. A stale logout can no longer
 * destroy a valid link.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = __dirname;

function configuredVolumeRoot() {
  const raw = String(process.env.RAILWAY_VOLUME_MOUNT_PATH || '').trim();
  if (!raw) return null;
  const root = path.resolve(raw);
  try {
    return fs.statSync(root).isDirectory() ? root : null;
  } catch {
    return null;
  }
}

function decodeMountField(value) {
  return String(value || '').replace(/\\([0-7]{3})/g, (_match, octal) =>
    String.fromCharCode(parseInt(octal, 8))
  );
}

/** True only when the configured path or /app/nexstore is a real volume mount. */
function isMountedAt(mountPath) {
  const target = path.resolve(mountPath);
  try {
    return fs.readFileSync('/proc/self/mountinfo', 'utf8').split('\n').some((line) => {
      const fields = line.split(' ');
      return fields[4] && path.resolve(decodeMountField(fields[4])) === target;
    });
  } catch {
    return false;
  }
}

/** True when Railway supplied a mount path or the legacy mount is active. */
function isVolumeMounted() {
  return Boolean(configuredVolumeRoot() || isMountedAt('/app/nexstore'));
}

/** Absolute path of the mounted volume, or the legacy local data directory. */
function nexstoreRoot() {
  const configured = configuredVolumeRoot();
  if (configured) return configured;
  if (isMountedAt('/app/nexstore')) return '/app/nexstore';
  return path.join(REPO_ROOT, 'nexstore');
}

/** Absolute path of the folder that holds every paired session. */
function resolveSessionRoot(explicit) {
  const raw =
    explicit ||
    process.env.SESSION_DIR ||
    process.env.SESSION_ROOT ||
    process.env.SESSIONS_DIR ||
    '';
  if (raw && String(raw).trim()) return path.resolve(String(raw).trim());
  const configured = configuredVolumeRoot();
  if (configured) return path.join(configured, 'pairing');
  if (isVolumeMounted()) return '/app/nexstore/pairing';
  return path.join(nexstoreRoot(), 'pairing');
}

/** resolveSessionRoot() + mkdir -p. Always returns an existing absolute path. */
function ensureSessionRoot(root) {
  const r = resolveSessionRoot(root);
  try {
    fs.mkdirSync(r, { recursive: true });
  } catch (e) {
    console.log('[sessionPaths] could not create session root:', e && e.message);
  }
  return r;
}

/** <root>/<number>@s.whatsapp.net for a number or JID. */
function sessionDirFor(numberOrJid, root) {
  const r = ensureSessionRoot(root);
  const n = String(numberOrJid || '').trim();
  if (!n) return r;
  const jid = n.includes('@') ? n : n.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
  return path.join(r, jid);
}

function credsAreComplete(creds) {
  if (!creds || creds.registered === false) return false;
  if (creds.registered === true && creds.me && creds.me.id) return true;
  return !!(creds.me && creds.me.id && (creds.noiseKey || creds.signedIdentityKey || creds.account));
}

/**
 * Move a complete legacy pairing/<digits> session into the canonical
 * pairing/<digits>@s.whatsapp.net directory. Incomplete auth state is left
 * untouched because it may belong to a phone that is currently approving a
 * pairing code.
 */
function migrateLegacySessionDir(numberOrJid, root) {
  const raw = String(numberOrJid || '').trim();
  const digits = raw.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
  if (!digits) return { migrated: false, reason: 'invalid_number' };

  const sessionRoot = ensureSessionRoot(root);
  const jid = `${digits}@s.whatsapp.net`;
  const targetDir = path.join(sessionRoot, jid);
  const targetCreds = path.join(targetDir, 'creds.json');
  const legacyDir = path.join(sessionRoot, digits);
  const legacyCreds = path.join(legacyDir, 'creds.json');
  if (fs.existsSync(targetCreds) || !fs.existsSync(legacyCreds)) {
    return { migrated: false, reason: 'not_needed' };
  }

  try {
    const creds = JSON.parse(fs.readFileSync(legacyCreds, 'utf8'));
    if (!credsAreComplete(creds)) return { migrated: false, reason: 'incomplete' };
    fs.cpSync(legacyDir, targetDir, { recursive: true, force: false, errorOnExist: true });
    const copied = JSON.parse(fs.readFileSync(targetCreds, 'utf8'));
    if (!credsAreComplete(copied)) {
      quarantineDir(targetDir, 'incomplete legacy session migration');
      return { migrated: false, reason: 'verification_failed' };
    }
    return { migrated: true, from: legacyDir, to: targetDir };
  } catch (error) {
    return { migrated: false, reason: 'migration_failed', error: error.message };
  }
}

/**
 * Rename a session folder aside instead of deleting it.
 * Never throws, never removes data — the pairing survives a false logout.
 */
function quarantineDir(target, why) {
  try {
    if (!target || !fs.existsSync(target)) return null;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = target.replace(/[\\/]+$/, '') + '.quarantine-' + stamp;
    fs.renameSync(target, dest);
    try {
      fs.writeFileSync(
        path.join(dest, '.quarantine-reason'),
        String(why || 'unknown') + '\n' + new Date().toISOString() + '\n'
      );
    } catch (e) {}
    console.log('[sessionPaths] quarantined ' + target + ' -> ' + dest + ' (' + (why || 'unknown') + ')');
    return dest;
  } catch (e) {
    console.log('[sessionPaths] quarantine failed for ' + target + ':', e && e.message);
    return null;
  }
}

/** Legacy folders old versions used — migrated into the volume on boot. */

/**
 * Permanently purge a session directory and all its quarantine copies
 * when a user explicitly unlinks / logs out, freeing disk space.
 */
function purgeSession(target, why) {
  try {
    let persistence;
    try { persistence = require('./mias/sessionPersistence.cjs'); } catch {}
    if (persistence && typeof persistence.deleteSessionCompletely === 'function') {
      return persistence.deleteSessionCompletely({ sessionDir: target, reason: why || 'purge' });
    }
  } catch {}
  return null;
}

function legacySessionDirs() {
  return [
    'prezzy_auth',
    'auth_info_baileys',
    'auth_info',
    'session',
    'sessions',
    'baileys_auth_info',
  ].map(function (d) {
    return path.join(REPO_ROOT, d);
  });
}

module.exports = {
  REPO_ROOT: REPO_ROOT,
  isVolumeMounted: isVolumeMounted,
  nexstoreRoot: nexstoreRoot,
  resolveSessionRoot: resolveSessionRoot,
  ensureSessionRoot: ensureSessionRoot,
  sessionDirFor: sessionDirFor,
  migrateLegacySessionDir: migrateLegacySessionDir,
  quarantineDir: quarantineDir,
  purgeSession: purgeSession,
  legacySessionDirs: legacySessionDirs,
};
