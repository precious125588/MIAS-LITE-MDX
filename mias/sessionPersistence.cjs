'use strict';

const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { normalizePostgresConnectionString } = require('./lib/pgConnection.cjs');
const { railwaySslOptions } = require('./lib/railwayPersistence.cjs');
const { isJsonOnly } = require('./lib/storageMode.cjs');

let _pool = null;
let _poolUrl = null;
let _testPool = null;
const _fileDigests = new Map();

function setPoolForTesting(pool) {
  _testPool = pool;
  _fileDigests.clear();
}

function getPool() {
  if (_testPool) return _testPool;
  if (isJsonOnly()) return null;
  return createPool();
}

function getDatabaseUrl() {
  // An explicit session URL keeps the session store separate. If none is set,
  // Railway deployments may share RAILWAY_DATABASE_URL; existing Neon session
  // URLs remain preferred unless RAILWAY_SESSION_DATABASE_URL is explicitly set.
  return String(
    process.env.RAILWAY_SESSION_DATABASE_URL ||
    process.env.SESSION_DATABASE_URL ||
    process.env.SESSION_DB_URL ||
    process.env.SESSIONS_DATABASE_URL ||
    process.env.RAILWAY_DATABASE_URL ||
    ""
  ).trim();
}

function createPool() {
  const url = getDatabaseUrl();
  if (!url) return null;
  if (_pool && _poolUrl === url) return _pool;

  if (_pool) {
    try { _pool.end().catch(() => {}); } catch {}
  }

  let pg;
  try {
    pg = require('pg');
  } catch (err) {
    console.warn('[session-persistence] pg package not available:', err.message);
    return null;
  }

  const { Pool } = pg;
  const railwayUrl = String(
    process.env.RAILWAY_SESSION_DATABASE_URL || process.env.RAILWAY_DATABASE_URL || '',
  ).trim();
  const isRailway = railwayUrl && railwayUrl === url;
  _pool = new Pool({
    connectionString: normalizePostgresConnectionString(url),
    max: 2,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
    query_timeout: 15000,
    idleTimeoutMillis: 30000,
    allowExitOnIdle: true,
    ssl: isRailway ? railwaySslOptions(url) : { rejectUnauthorized: true },
    application_name: isRailway ? 'mais-session-store-railway' : 'mais-session-store',
  });
  _poolUrl = url;
  _fileDigests.clear();

  _pool.on('error', (err) => {
    console.warn('[session-persistence] Pool background error:', err.message);
  });

  return _pool;
}

// Only the session schema belongs in the second database. Do not run the
// bot-settings migrations here or move settings/prefixes between databases.
let _schemaPool = null;
let _schemaReady = null;
async function readyPool() {
  const pool = getPool();
  if (!pool || pool === _testPool) return pool;
  if (_schemaPool !== pool || !_schemaReady) {
    _schemaPool = pool;
    _schemaReady = pool.query(fs.readFileSync(path.join(__dirname, 'migrations', '0002_create_whatsapp_sessions.sql'), 'utf8'))
      .catch(error => { _schemaReady = null; throw error; });
  }
  await _schemaReady;
  return pool;
}

// Coalesce overlapping directory snapshots: an old snapshot must not race a
// new one and overwrite freshly rotated auth keys.
const _syncs = new Map();
function syncSessionDirToDb(sessionId, sessionDir) {
  const key = path.resolve(String(sessionDir || '.'));
  const current = _syncs.get(key);
  if (current) { current.again = true; return current.promise; }
  const entry = { again: false, promise: null };
  entry.promise = Promise.resolve().then(async () => {
    let result;
    do {
      entry.again = false;
      result = await syncSessionSnapshot(sessionId, sessionDir);
      // A failed DB is retried on the next real auth change, not in a hot loop.
    } while (entry.again && result.ok);
    return result;
  }).finally(() => { if (_syncs.get(key) === entry) _syncs.delete(key); });
  _syncs.set(key, entry);
  return entry.promise;
}

// Parent-owned registry persistence. JSON remains a local recovery copy.
async function saveRegistryEntry(row) {
  const pool = await readyPool();
  if (!pool || !row?.jid) return false;
  const { jid, number } = normalizeSessionKeys(row.jid);
  await pool.query(`INSERT INTO mias_session_registry (jid, number, source, status, telegram_user_id, metadata, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6::jsonb, now())
    ON CONFLICT (jid) DO UPDATE SET source=EXCLUDED.source, status=EXCLUDED.status,
      telegram_user_id=EXCLUDED.telegram_user_id, metadata=EXCLUDED.metadata, updated_at=now()`,
    [jid, number, String(row.source || 'web'), String(row.status || 'connecting'),
     row.telegramUserId == null ? null : String(row.telegramUserId),
     JSON.stringify({ pairedAt: row.pairedAt, lastActivity: row.lastActivity })]);
  return true;
}
async function deleteRegistryEntry(id) {
  const pool = await readyPool();
  if (!pool) return false;
  const { jid, number } = normalizeSessionKeys(id);
  await pool.query('DELETE FROM mias_session_registry WHERE jid = $1 OR number = $2', [jid, number]);
  return true;
}

function normalizeSessionKeys(input) {
  const raw = String(input || '').trim();
  if (!raw) return { number: '', jid: '', primary: '' };
  const digits = raw.split('@')[0].replace(/[^0-9]/g, '');
  const jid = digits ? `${digits}@s.whatsapp.net` : '';
  const primary = raw.includes('@') ? raw : (jid || digits);
  return { number: digits, jid: jid || raw, primary };
}

/**
 * Persists a single auth file into Neon PostgreSQL.
 * Stored strictly under canonical JID (<number>@s.whatsapp.net) to prevent duplicate session counts.
 */
async function saveSessionFile(sessionId, fileName, content) {
  const pool = await readyPool();
  if (!pool) return false;
  const { number, jid, primary } = normalizeSessionKeys(sessionId);
  const targetId = jid || primary;
  if (!targetId || !fileName) return false;

  const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  const cleanFileName = path.basename(fileName);

  try {
    await pool.query(
      `INSERT INTO mias_session_auth (session_id, file_name, content, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (session_id, file_name)
       DO UPDATE SET content = EXCLUDED.content, updated_at = now()`,
      [targetId, cleanFileName, text]
    );

    // Clean up any legacy bare-number record for this file to prevent duplicate session counts
    if (number && number !== targetId) {
      try {
        await pool.query(
          `DELETE FROM mias_session_auth WHERE session_id = $1 AND file_name = $2`,
          [number, cleanFileName]
        );
      } catch {}
    }
    return true;
  } catch (err) {
    console.warn(`[session-persistence] saveSessionFile error for ${targetId}/${cleanFileName}:`, err.message);
    return false;
  }
}

/**
 * Syncs all valid JSON files in a session directory to Neon PostgreSQL.
 * Uses only canonical JID (<number>@s.whatsapp.net).
 */
async function syncSessionSnapshot(sessionId, sessionDir) {
  const pool = await readyPool();
  if (!pool) return { ok: false, synced: 0, reason: 'db_not_configured' };
  if (!sessionDir || !fs.existsSync(sessionDir)) return { ok: false, synced: 0, reason: 'dir_missing' };

  const { number, jid, primary } = normalizeSessionKeys(sessionId || path.basename(sessionDir));
  const targetId = jid || primary;
  if (!targetId) return { ok: false, synced: 0, reason: 'invalid_session_id' };

  let entries = [];
  try {
    entries = fs.readdirSync(sessionDir, { withFileTypes: true });
  } catch (err) {
    return { ok: false, synced: 0, reason: err.message };
  }

  let count = 0;
  let failed = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const fn = entry.name;
    if (!fn.endsWith('.json')) continue; // unfinished .tmp writes never replace committed auth
    if (fn.startsWith('.')) continue; // skip .owner.json, hidden files
    const cleanFn = path.basename(fn.replace(/\.tmp$/, ''));

    try {
      const fullPath = path.join(sessionDir, fn);
      const content = fs.readFileSync(fullPath, 'utf8');
      if (!content || !content.trim()) { failed++; continue; }
      JSON.parse(content); // never persist a partially written auth document
      const digestKey = `${path.resolve(sessionDir)}:${cleanFn}`;
      const digest = createHash('sha256').update(content).digest('hex');
      if (_fileDigests.get(digestKey) === digest) continue;

      await pool.query(
        `INSERT INTO mias_session_auth (session_id, file_name, content, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (session_id, file_name)
         DO UPDATE SET content = EXCLUDED.content, updated_at = now()`,
        [targetId, cleanFn, content]
      );
      _fileDigests.set(digestKey, digest);
      count++;
    } catch (e) {
      // Baileys can rotate/delete pre-key JSON files between readdirSync and
      // readFileSync. ENOENT is an expected race; the next sync sees the current
      // key set. Keep reporting real filesystem/DB errors.
      if (e?.code !== 'ENOENT') {
        failed++;
        console.warn(`[session-persistence] Error syncing ${cleanFn}:`, e.message);
      }
    }
  }

  // Snapshot cleanup prevents deleted pre-keys from being resurrected after
  // a redeploy. Never prune an incomplete/error snapshot or an empty folder.
  const names = entries.filter(e => e.isFile() && e.name.endsWith('.json') && !e.name.startsWith('.')).map(e => e.name);
  if (failed === 0 && names.includes('creds.json')) {
    try {
      await pool.query('DELETE FROM mias_session_auth WHERE session_id = $1 AND NOT (file_name = ANY($2::text[]))', [targetId, names]);
      const prefix = `${path.resolve(sessionDir)}:`;
      for (const key of _fileDigests.keys()) {
        if (key.startsWith(prefix) && !names.includes(key.slice(prefix.length))) _fileDigests.delete(key);
      }
    } catch (e) { failed++; }
  }

  // Purge any legacy bare-number entries for this session from DB
  if (number && number !== targetId) {
    try {
      await pool.query(
        `DELETE FROM mias_session_auth WHERE session_id = $1`,
        [number]
      );
    } catch {}
  }

  return { ok: failed === 0, synced: count, failed, targetId };
}

/**
 * Restores all session files for sessionId from Neon PostgreSQL into targetDir.
 * Enforces path.basename on all filenames to prevent directory traversal.
 */
async function restoreSessionDirFromDb(sessionId, targetDir) {
  const pool = await readyPool();
  if (!pool) return { ok: false, restored: 0, reason: 'db_not_configured' };
  const { number, jid, primary } = normalizeSessionKeys(sessionId || path.basename(targetDir));
  const targetId = jid || primary;

  try {
    const res = await pool.query(
      `SELECT file_name, content FROM mias_session_auth
       WHERE session_id = $1 OR session_id = $2
       ORDER BY (file_name = 'creds.json') DESC, updated_at DESC`,
      [targetId, number]
    );

    if (!res.rows || res.rows.length === 0) {
      return { ok: true, restored: 0, message: 'no_records_in_db' };
    }

    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    const writtenFiles = new Set();
    let writtenCount = 0;

    for (const row of res.rows) {
      const safeName = path.basename(row.file_name);
      if (!safeName || safeName.startsWith('.') || writtenFiles.has(safeName)) continue;
      const filePath = path.join(targetDir, safeName);
      fs.writeFileSync(filePath, row.content, 'utf8');
      writtenFiles.add(safeName);
      writtenCount++;
    }

    console.log(`[session-persistence] Restored ${writtenCount} files for ${targetId} into ${targetDir}`);
    return { ok: true, restored: writtenCount, files: Array.from(writtenFiles) };
  } catch (err) {
    console.warn(`[session-persistence] Failed to restore session ${targetId}:`, err.message);
    return { ok: false, restored: 0, reason: err.message };
  }
}

/**
 * Restores all sessions from Neon PostgreSQL if they do not exist locally on disk.
 * Runs on container boot / restart to survive container replacement.
 * Always restores into canonical folder name: <number>@s.whatsapp.net
 */
async function restoreAllSessionsFromDb(pairingRoot) {
  const pool = await readyPool();
  if (!pool) return { ok: false, restored: 0, reason: 'db_not_configured' };

  try {
    const res = await pool.query(
      `SELECT DISTINCT session_id FROM mias_session_auth`
    );

    if (!res.rows || res.rows.length === 0) {
      return { ok: true, restored: 0, message: 'no_sessions_stored' };
    }

    if (!fs.existsSync(pairingRoot)) {
      fs.mkdirSync(pairingRoot, { recursive: true });
    }

    let restoredSessions = 0;
    const handledDigits = new Set();

    for (const row of res.rows) {
      const { number, jid } = normalizeSessionKeys(row.session_id);
      if (!number) continue;
      if (handledDigits.has(number)) continue;
      handledDigits.add(number);

      // Always restore into canonical folder name: <number>@s.whatsapp.net
      const folderName = jid || `${number}@s.whatsapp.net`;
      const targetDir = path.join(pairingRoot, folderName);
      const credsPath = path.join(targetDir, 'creds.json');

      if (!fs.existsSync(credsPath)) {
        const result = await restoreSessionDirFromDb(row.session_id, targetDir);
        if (result.ok && result.restored > 0) {
          restoredSessions++;
        }
      }
    }

    // Also restore registry and selections if possible
    await syncRegistryAndSelectionsFromDb();

    console.log(`[session-persistence] Total sessions restored from Neon DB: ${restoredSessions}`);
    return { ok: true, restored: restoredSessions };
  } catch (err) {
    console.warn('[session-persistence] restoreAllSessionsFromDb error:', err.message);
    return { ok: false, restored: 0, reason: err.message };
  }
}

/**
 * Restores session_registry.json and bot selections from Neon DB if present.
 */
async function syncRegistryAndSelectionsFromDb() {
  const pool = await readyPool();
  if (!pool) return;

  try {
    const regRes = await pool.query('SELECT jid, number, source, status, telegram_user_id, metadata, updated_at FROM mias_session_registry');
    if (regRes.rows && regRes.rows.length > 0) {
      try {
        const registry = (() => {
          try { return require('../nexstore_modules/sessionRegistry'); } catch {}
          try { return require('../nexstore/sessionRegistry'); } catch {}
          return null;
        })();
        if (!registry) return;
        for (const r of regRes.rows) {
          if (!registry.has(r.jid)) {
            registry.register(r.jid, r.source || 'web', {
              number: r.number,
              source: r.source,
              status: r.status,
              telegramUserId: r.telegram_user_id,
              ...(r.metadata || {})
            });
          }
        }
        registry.flush?.();
      } catch {}
    }
  } catch {}

  try {
    const selRes = await pool.query('SELECT number, bot_id, bot_name, source, chosen_by, locked, deployed FROM mias_bot_selections');
    if (selRes.rows && selRes.rows.length > 0) {
      try {
        const botStore = require('../deploy/botSelectionStore');
        for (const s of selRes.rows) {
          botStore.setSelection(s.number, { id: s.bot_id, name: s.bot_name }, {
            source: s.source,
            chosenBy: s.chosen_by,
            locked: s.locked,
            deployed: s.deployed
          });
        }
      } catch {}
    }
  } catch {}
}

/**
 * Gets count of unique physical sessions stored in Neon PostgreSQL.
 * Deduplicates canonical JID and legacy bare-number aliases by phone number.
 */
async function getStoredSessionsCount({ strict = false } = {}) {
  const pool = await readyPool();
  if (!pool) return 0;
  try {
    const res = await pool.query(
      `SELECT DISTINCT session_id FROM mias_session_auth WHERE file_name = 'creds.json'`
    );
    const seen = new Set();
    for (const r of (res.rows || [])) {
      const num = String(r.session_id || '').split('@')[0].replace(/\D/g, '');
      if (num) seen.add(num);
    }
    return seen.size;
  } catch (error) {
    if (strict) throw error;
    return 0;
  }
}

/**
 * Completely purges a session upon confirmed user logout, unlinking, or explicit reset.
 * Deletes from Neon PostgreSQL, purges disk files, and purges all .quarantine-* folders
 * for that specific session to retain disk space.
 */
async function deleteSessionCompletely(options = {}) {
  const { jid: rawJid, number: rawNumber, sessionDir: explicitDir, reason = 'logout' } = options;
  const { number, jid, primary } = normalizeSessionKeys(rawJid || rawNumber || (explicitDir ? path.basename(explicitDir) : ''));

  if (!number && !jid) {
    return { ok: false, error: 'session_identifier_required' };
  }

  console.log(`[session-persistence] Purging all session files and database records for ${number || jid} (reason: ${reason})`);

  // Wait for an already queued snapshot before deleting its rows. Otherwise
  // a late INSERT can resurrect the old identity after reset returns.
  for (const [dir, entry] of _syncs) {
    if (normalizeSessionKeys(path.basename(dir)).number === number
      || (explicitDir && path.resolve(explicitDir) === dir)) {
      await entry.promise.catch(() => {});
    }
  }
  let dbRowsDeleted = 0;
  const pool = await readyPool();
  if (pool) {
    try {
      const authDel = await pool.query(
        `DELETE FROM mias_session_auth WHERE session_id = $1 OR session_id = $2`,
        [jid || primary, number]
      );
      dbRowsDeleted += (authDel.rowCount || 0);

      const regDel = await pool.query(
        `DELETE FROM mias_session_registry WHERE jid = $1 OR number = $2`,
        [jid, number]
      );
      dbRowsDeleted += (regDel.rowCount || 0);

      const selDel = await pool.query(
        `DELETE FROM mias_bot_selections WHERE number = $1`,
        [number]
      );
      dbRowsDeleted += (selDel.rowCount || 0);

      // Bot settings/prefixes live in the configured state store. A session
      // logout must not wipe unrelated settings or query bot-state tables here.
    } catch (err) {
      console.warn(`[session-persistence] Error deleting DB records for ${number}:`, err.message);
      if (!options.force) {
        throw new Error('Session database cleanup failed. Credentials kept; retry reset when the database is reachable.');
      }
    }
  }

  for (const key of _fileDigests.keys()) {
    if (explicitDir && key.startsWith(`${path.resolve(explicitDir)}:`)) _fileDigests.delete(key);
  }

  // Teardown disk files and quarantine directories
  let filesDeleted = 0;
  let sessionPathsMod = null;
  try { sessionPathsMod = require('../sessionPaths'); } catch {}

  const pairingRoot = sessionPathsMod
    ? sessionPathsMod.resolveSessionRoot()
    : path.resolve(__dirname, '..', 'nexstore', 'pairing');

  const targets = new Set();
  if (explicitDir) targets.add(path.resolve(explicitDir));
  if (number) {
    targets.add(path.join(pairingRoot, number));
    targets.add(path.join(pairingRoot, `${number}@s.whatsapp.net`));
  }
  if (jid) {
    targets.add(path.join(pairingRoot, jid));
  }

  // 1. Delete target session directories
  for (const dir of targets) {
    try {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
        filesDeleted++;
      }
    } catch (e) {
      console.warn(`[session-persistence] Error removing ${dir}:`, e.message);
    }
  }

  // 2. Scan pairing root and parent of explicit directory for matching .quarantine-* folders and permanently remove them to retain space
  const scanRoots = new Set();
  if (fs.existsSync(pairingRoot)) scanRoots.add(pairingRoot);
  if (explicitDir && fs.existsSync(path.dirname(path.resolve(explicitDir)))) {
    scanRoots.add(path.dirname(path.resolve(explicitDir)));
  }

  if (number) {
    for (const sRoot of scanRoots) {
      try {
        const items = fs.readdirSync(sRoot);
        for (const item of items) {
          if (item.includes(number) && item.includes('.quarantine-')) {
            const qDir = path.join(sRoot, item);
            try {
              fs.rmSync(qDir, { recursive: true, force: true });
              filesDeleted++;
              console.log(`[session-persistence] Purged quarantine directory: ${item}`);
            } catch {}
          }
        }
      } catch {}
    }
  }

  // 3. Clear temporary files and notifications for this number
  const repoRoot = path.resolve(__dirname, '..');
  const tempCleanups = [
    path.join(repoRoot, 'nexstore', 'bot_status', `${number}.json`),
    path.join(repoRoot, 'nexstore', `pairing_code_${number}.json`),
    path.join(repoRoot, 'nexstore', `pairing_qr_${number}.json`),
  ];

  for (const p of tempCleanups) {
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
  }

  // Remove logout notifications
  const notifDir = path.join(repoRoot, 'nexstore', 'logout_notifications');
  if (fs.existsSync(notifDir) && number) {
    try {
      const files = fs.readdirSync(notifDir);
      for (const f of files) {
        if (f.startsWith(`${number}_`) && f.endsWith('.json')) {
          try { fs.unlinkSync(path.join(notifDir, f)); } catch {}
        }
      }
    } catch {}
  }

  // 4. Clear in-memory caches and stores
  try {
    const registry = (() => {
      try { return require('../nexstore_modules/sessionRegistry'); } catch {}
      try { return require('../nexstore/sessionRegistry'); } catch {}
      return null;
    })();
    if (jid) registry?.unregister(jid);
    if (number) registry?.unregister(number);
    registry?.flush?.();
  } catch {}

  try {
    const selections = require('../deploy/botSelectionStore');
    if (number) {
      selections.clearSelection(number);
      selections.clearPending?.(number);
      selections.clearOwner?.(number);
    }
  } catch {}

  try {
    const ownership = require('../sessionOwnership');
    if (explicitDir) ownership.release(explicitDir);
    if (number) ownership.release(number);
    if (jid) ownership.release(jid);
  } catch {}

  // Writers must be stopped by the caller BEFORE deletion. A timer which
  // deletes this path again can erase the next pairing's freshly generated keys.

  return {
    ok: true,
    number,
    jid,
    filesDeleted,
    dbRowsDeleted,
    message: `Session ${number || jid} completely deleted from disk and database.`
  };
}


async function clearAllSessionRecords() {
  const pool = await readyPool();
  if (!pool) return { ok: false, reason: "db_not_configured" };
  try {
    await pool.query("TRUNCATE TABLE mias_session_auth, mias_session_registry, mias_bot_selections CASCADE");
    _fileDigests.clear();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  createPool,
  readyPool,
  getDatabaseUrl,
  saveRegistryEntry,
  deleteRegistryEntry,
  setPoolForTesting,
  saveSessionFile,
  syncSessionDirToDb,
  restoreSessionDirFromDb,
  restoreAllSessionsFromDb,
  syncRegistryAndSelectionsFromDb,
  getStoredSessionsCount,
  deleteSessionCompletely,
  normalizeSessionKeys,
  clearAllSessionRecords,
};
