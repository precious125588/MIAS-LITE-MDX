'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { constants: osConstants } = require('node:os');
const { normalizePostgresConnectionString } = require('../mias/lib/pgConnection.cjs');
const { railwaySslOptions } = require('../mias/lib/railwayPersistence.cjs');
const { isJsonOnly } = require('../mias/lib/storageMode.cjs');

function resolveDatabaseUrls(env = process.env) {
  const settingsUrl = String(
    env.RAILWAY_DATABASE_URL ||
    env.DATABASE_URL ||
    env.SETTINGS_DATABASE_URL ||
    ''
  ).trim();
  const sessionUrl = String(
    env.RAILWAY_SESSION_DATABASE_URL ||
    env.SESSION_DATABASE_URL ||
    env.SESSION_DB_URL ||
    env.SESSIONS_DATABASE_URL ||
    env.RAILWAY_DATABASE_URL ||
    ''
  ).trim();
  return { settingsUrl, sessionUrl };
}

function databaseSslOptions(connectionString, env = process.env) {
  let hostname = '';
  try {
    hostname = new URL(String(connectionString)).hostname.toLowerCase();
  } catch {}

  // Only honor Railway's certificate-verification override for its private
  // service network. Public database endpoints and other providers stay strict.
  if (!hostname.endsWith('.railway.internal')) {
    return { rejectUnauthorized: true };
  }
  return railwaySslOptions(connectionString, env);
}

async function clearSessionsFromSettingsDb(settingsUrl) {
  if (!settingsUrl) return { cleared: false, reason: 'no_settings_db' };
  let pg;
  try {
    pg = require('pg');
  } catch {
    return { cleared: false, reason: 'pg_missing' };
  }
  const { Pool } = pg;
  let pool;
  try {
    pool = new Pool({
      connectionString: normalizePostgresConnectionString(settingsUrl),
      max: 1,
      connectionTimeoutMillis: 5000,
      statement_timeout: 15000,
      ssl: databaseSslOptions(settingsUrl),
      application_name: 'mais-clear-settings-db-sessions',
    });
    const client = await pool.connect();
    try {
      let clearedRows = 0;
      for (const table of ['mias_session_auth', 'mias_session_registry', 'mias_bot_selections']) {
        const check = await client.query('SELECT to_regclass($1) AS tbl', [`public.${table}`]);
        if (check.rows[0]?.tbl) {
          const countRes = await client.query(`SELECT count(*)::bigint AS cnt FROM public.${table}`);
          const count = Number(countRes.rows[0]?.cnt || 0);
          if (count > 0) {
            await client.query(`TRUNCATE TABLE public.${table} CASCADE`);
            clearedRows += count;
          }
        }
      }
      if (clearedRows > 0) {
        console.log(`[session-startup] Cleared ${clearedRows} legacy session records from Settings DB (DATABASE_URL).`);
      }
      return { cleared: true, clearedRows };
    } finally {
      client.release();
    }
  } catch (err) {
    console.warn(`[session-startup] Notice checking Settings DB for legacy sessions: ${err.message}`);
    return { cleared: false, error: err.message };
  } finally {
    if (pool) {
      try { await pool.end(); } catch {}
    }
  }
}

async function initSessionDatabase(sessionUrl) {
  if (!sessionUrl) return { initialized: false, reason: 'no_session_db' };
  let pg;
  try {
    pg = require('pg');
  } catch {
    return { initialized: false, reason: 'pg_missing' };
  }
  const { Pool } = pg;
  let pool;
  try {
    pool = new Pool({
      connectionString: normalizePostgresConnectionString(sessionUrl),
      max: 1,
      connectionTimeoutMillis: 5000,
      statement_timeout: 15000,
      ssl: databaseSslOptions(sessionUrl),
      application_name: 'mais-init-session-db',
    });
    const client = await pool.connect();
    try {
      const sqlPath = path.join(__dirname, '..', 'mias', 'migrations', '0002_create_whatsapp_sessions.sql');
      if (fs.existsSync(sqlPath)) {
        await client.query(fs.readFileSync(sqlPath, 'utf8'));
      }
      const countRes = await client.query('SELECT count(DISTINCT session_id)::int as count FROM mias_session_auth');
      const count = Number(countRes.rows[0]?.count || 0);
      console.log(`[session-startup] Session DB initialized on SESSION_DATABASE_URL (${count} session(s) present).`);
      return { initialized: true, count };
    } finally {
      client.release();
    }
  } catch (err) {
    console.warn(`[session-startup] Warning initializing Session DB: ${err.message}`);
    return { initialized: false, error: err.message };
  } finally {
    if (pool) {
      try { await pool.end(); } catch {}
    }
  }
}

async function cleanLockedAndStaleSessions({ sessionUrl, settingsUrl, preserveSessionJid } = {}) {
  const { sessionDigits, parseDiscardSessions, shouldPruneSession } = require('./sessionPolicy.cjs');
  const protectedDigits = sessionDigits(preserveSessionJid);
  const discardSet = parseDiscardSessions(process.env.DISCARD_SESSIONS);
  if (protectedDigits) discardSet.delete(protectedDigits);
  const purgeAll = [process.env.RESET_SESSIONS, process.env.PURGE_ALL_SESSIONS]
    .some(value => String(value || '').toLowerCase() === 'true');
  // SESSION_ID selects an import, NEVER an implicit delete-all-other-bots policy.
  if (!purgeAll && discardSet.size === 0) return { cleaned: false, reason: 'no_explicit_reset' };
  const sessionPaths = require('../sessionPaths');
  const nexRoot = sessionPaths.nexstoreRoot();
  const roots = new Set([sessionPaths.resolveSessionRoot(), path.join(nexRoot, 'pairing')]);
  const shouldRemove = value => shouldPruneSession(value, protectedDigits, discardSet, purgeAll);
  // Only an explicit reset reaches any deletion, and the active env identity is protected.
  for (const dbUrl of new Set([sessionUrl, settingsUrl].filter(Boolean))) {
    let pool;
    try {
      const { Pool } = require('pg');
      pool = new Pool({ connectionString: normalizePostgresConnectionString(dbUrl), max: 1,
        connectionTimeoutMillis: 5000, statement_timeout: 15000, ssl: databaseSslOptions(dbUrl) });
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const [table, column] of [['mias_session_auth', 'session_id'], ['mias_session_registry', 'jid'], ['mias_bot_selections', 'number']]) {
          const found = await client.query('SELECT to_regclass($1) AS tbl', ['public.' + table]);
          if (!found.rows[0]?.tbl) continue;
          const rows = await client.query('SELECT DISTINCT ' + column + ' AS identity FROM public.' + table);
          for (const row of rows.rows) if (shouldRemove(row.identity)) {
            await client.query('DELETE FROM public.' + table + ' WHERE ' + column + ' = $1', [row.identity]);
          }
        }
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    } catch (error) {
      console.warn('[session-startup] Explicit database cleanup failed:', error.code || error.name);
    } finally { if (pool) await pool.end().catch(() => {}); }
  }
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory() && shouldRemove(entry.name)) {
        fs.rmSync(path.join(root, entry.name), { recursive: true, force: true });
        console.log('[session-startup] Explicitly discarded session: ' + entry.name);
      }
    }
  }
  for (const name of ['web_pairs.json', 'bot_selections.json', 'pending_selections.json']) {
    const target = path.join(nexRoot, name);
    if (!fs.existsSync(target)) continue;
    const data = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (Array.isArray(data)) {
      fs.writeFileSync(target, JSON.stringify(data.filter(row => !shouldRemove(row?.jid || row?.number)), null, 2));
    } else if (data && typeof data === 'object') {
      for (const key of Object.keys(data)) if (shouldRemove(key)) delete data[key];
      fs.writeFileSync(target, JSON.stringify(data, null, 2));
    }
  }
  const activePath = path.join(nexRoot, 'active_bot.json');
  if (fs.existsSync(activePath)) {
    const active = JSON.parse(fs.readFileSync(activePath, 'utf8'));
    if (shouldRemove(active?.jid || active?.digits)) fs.writeFileSync(activePath, JSON.stringify({ live: false, updatedAt: new Date().toISOString() }));
  }
  const statusRoot = path.join(nexRoot, 'bot_status');
  if (fs.existsSync(statusRoot)) for (const name of fs.readdirSync(statusRoot)) {
    if (name.endsWith('.json') && shouldRemove(name.slice(0, -5))) fs.rmSync(path.join(statusRoot, name), { force: true });
  }
  return { cleaned: true };
}

async function prepareSessionDatabase() {
  const jsonOnly = isJsonOnly();
  const { settingsUrl, sessionUrl } = jsonOnly ? { settingsUrl: '', sessionUrl: '' } : resolveDatabaseUrls();
  if (jsonOnly) console.log('[DB] STORAGE_MODE=json: PostgreSQL and Redis are off; using JSON files.');

  // Startup is non-destructive. Settings and sessions may use the same
  // Railway database (including different URLs for the same database).
  // Automatically truncating 'legacy' tables here destroys the live auth
  // backup on every deploy. Cleanup belongs to an explicit admin action.

  // Ensure Session DB schema is ready if configured
  if (sessionUrl) {
    await initSessionDatabase(sessionUrl);
  }

  console.log(`[DB] Settings Database : ${settingsUrl ? 'Attached' : 'Not Attached (local JSON)'}`);
  console.log(`[DB] Session Database  : ${sessionUrl ? 'Attached' : 'Not Attached (local files)'}`);
  // Resolve SESSION_ID before cleanup so a reset can preserve the credentials
  // the bot is actually about to run. Only explicit reset/discard flags may prune.
  let envBootResult = null;
  const sessionIdConfigured = Boolean(String(process.env.SESSION_ID || '').trim());
  if (sessionIdConfigured) {
    try {
      const { bootstrapSessionFromEnv } = require('./sessionBootstrap.cjs');
      envBootResult = await bootstrapSessionFromEnv();
    } catch (bootErr) {
      console.warn('[session-bootstrap] Notice:', bootErr.message);
    }
  }

  // Never perform destructive cleanup if SESSION_ID is configured but could
  // not be resolved; keep credentials intact and surface the bootstrap issue.
  if (sessionIdConfigured && !envBootResult?.canonicalJid) {
    console.warn('[session-startup] SESSION_ID was set but could not be resolved; skipping session pruning to protect saved credentials.');
  } else {
    await cleanLockedAndStaleSessions({ sessionUrl, settingsUrl, preserveSessionJid: envBootResult?.canonicalJid });
  }

  // Ensure nexstore volume directory layout is ready if mounted
  try {
    let sessionPaths;
    try { sessionPaths = require("../sessionPaths"); } catch { sessionPaths = require("../nexstore_modules/sessionPaths"); }
    const nexRoot = sessionPaths.nexstoreRoot ? sessionPaths.nexstoreRoot() : path.join(__dirname, "..", "nexstore");
    ["logs", "pairing", "admin-requests", "admin-results", "logout_notifications"].forEach(d => {
      const p = path.join(nexRoot, d);
      if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
    });
    // Bootstrap session from SESSION_ID environment variable if provided
    try {
      const bootResult = envBootResult;
      if (bootResult && bootResult.canonicalJid && bootResult.credsObj) {
        const sessionRoot = sessionPaths.resolveSessionRoot();
        const targetDirs = new Set([
          path.join(sessionRoot, bootResult.canonicalJid)
        ]);
        for (const targetDir of targetDirs) {
          await require('./sessionBootstrap.cjs').prepareBootSession(targetDir, bootResult);
        }


        const webPairsPath = path.join(nexRoot, 'web_pairs.json');
        let webPairs = [];
        try {
          if (fs.existsSync(webPairsPath)) {
            webPairs = JSON.parse(fs.readFileSync(webPairsPath, 'utf8')) || [];
          }
        } catch {}
        const alreadyHas = webPairs.some(p => require('./sessionPolicy.cjs').sessionDigits(p?.jid || p?.number) === bootResult.digits);
        if (!alreadyHas) {
          webPairs.push({
            number: bootResult.digits,
            jid: bootResult.canonicalJid,
            pairedAt: new Date().toISOString(),
            status: 'starting',
            source: 'session_id_bootstrap'
          });
          fs.writeFileSync(webPairsPath, JSON.stringify(webPairs, null, 2), 'utf8');
        }

        // Imported credentials are not proof of a live WhatsApp connection.
        const activeBotPath = path.join(nexRoot, 'active_bot.json');
        try {
          fs.writeFileSync(activeBotPath, JSON.stringify({
            live: false,
            username: bootResult.sessionUserName || 'User',
            pushName: bootResult.pushName || null,
            jid: bootResult.canonicalJid,
            digits: bootResult.digits,
            mode: 'SESSION_ID',
            updatedAt: new Date().toISOString()
          }, null, 2), 'utf8');
        } catch {}

        process.env.BOT_ACTIVE_USER = bootResult.sessionUserName || 'User';
        process.env.BOT_ACTIVE_JID = bootResult.canonicalJid;
        process.env.BOT_IS_LIVE = 'false';

        console.log(`[session-bootstrap] Injected credentials for ${bootResult.canonicalJid}`);
      }
    } catch (bootErr) {
      console.warn('[session-bootstrap] Notice:', bootErr.message);
    }

    const adminDest = path.join(nexRoot, "admin.json");
    const adminSrc = path.join(__dirname, "..", "nexstore_modules", "admin.json");
    if (!fs.existsSync(adminDest) && fs.existsSync(adminSrc)) {
      try { fs.copyFileSync(adminSrc, adminDest); } catch {}
    }
  } catch (err) {
    console.warn("[session-startup] Notice initializing volume layout:", err.message);
  }


  return {
    mode: 'isolated',
    settingsAttached: Boolean(settingsUrl),
    sessionAttached: Boolean(sessionUrl),
  };
}

async function main() {
  await prepareSessionDatabase();
  try {
    const sessionDebug = require('./sessionDebug.cjs');
    const SP = require(path.join(__dirname, '..', 'sessionPaths.js'));
    sessionDebug.logSessionDebug(SP.ensureSessionRoot());
  } catch (e) {
    console.warn('[session-debug] could not inspect sessions:', e && e.message);
  }
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    cwd: path.join(__dirname, '..'),
    // Keep dotenv's "injected env" banner out of the logs; env values still load.
    env: {
      DOTENV_CONFIG_QUIET: 'true',
      ...process.env,
      // node:sqlite prints an experimental-feature warning on every start; it is expected here.
      NODE_OPTIONS: [process.env.NODE_OPTIONS, '--disable-warning=ExperimentalWarning'].filter(Boolean).join(' '),
    },
    stdio: 'inherit',
  });

  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      if (!stopping && server.exitCode === null) {
        stopping = true;
        server.kill(signal);
      }
    });
  }

  server.on('error', (error) => {
    const code = String(error?.code || error?.name || 'UNKNOWN').replace(/[^A-Z0-9_-]/gi, '').slice(0, 80);
    console.error(`[session-startup] Could not launch server (${code}).`);
    process.exitCode = 1;
  });
  server.on('exit', (code, signal) => {
    if (signal) {
      process.removeAllListeners(signal);
      process.exitCode = 128 + (osConstants.signals[signal] || 1);
      return;
    }
    process.exitCode = code ?? 1;
  });
}

if (require.main === module) {
  main().catch((error) => {
    const code = String(error?.code || error?.name || 'UNKNOWN').replace(/[^A-Z0-9_-]/gi, '').slice(0, 80);
    console.error(`[session-startup] Startup preparation failed (${code}).`);
    process.exitCode = 1;
  });
}

module.exports = {
  prepareSessionDatabase,
  clearSessionsFromSettingsDb,
  initSessionDatabase,
  resolveDatabaseUrls,
  databaseSslOptions,
  cleanLockedAndStaleSessions,
  main,
};
