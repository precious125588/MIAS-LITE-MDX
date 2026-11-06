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
  // Ensure nexstore volume directory layout is ready if mounted
  try {
    const sessionPaths = require("../nexstore_modules/sessionPaths");
    const nexRoot = sessionPaths.nexstoreRoot();
    ["logs", "pairing", "admin-requests", "admin-results", "logout_notifications"].forEach(d => {
      const p = path.join(nexRoot, d);
      if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
    });
    // Bootstrap session from SESSION_ID environment variable if provided
    try {
      const { bootstrapSessionFromEnv } = require('./sessionBootstrap.cjs');
      if (!process.env.SESSION_ID) {
        console.log("\n=============================================================");
        console.log("⚠️  [BOT STATUS: WAITING FOR SESSION_ID]");
        console.log("   SESSION_ID is not configured in Railway Environment Variables.");
        console.log("   The web dashboard will run, but the WhatsApp bot stays offline.");
        console.log("   👉 To connect: Pair at https://web-production-0a742.up.railway.app/");
        console.log("   👉 Then add SESSION_ID in Railway Variables and redeploy.");
        console.log("=============================================================\n");
      }
      const bootResult = await bootstrapSessionFromEnv();
      if (bootResult && bootResult.canonicalJid && bootResult.credsObj) {
        const sessionRoot = sessionPaths.resolveSessionRoot();
        for (const targetDir of [
          path.join(sessionRoot, bootResult.canonicalJid),
          path.join(sessionRoot, bootResult.digits),
          path.join(nexRoot, 'pairing', bootResult.canonicalJid),
          path.join(nexRoot, 'pairing', bootResult.digits)
        ]) {
          fs.mkdirSync(targetDir, { recursive: true });
          fs.writeFileSync(path.join(targetDir, 'creds.json'), JSON.stringify(bootResult.credsObj, null, 2), 'utf8');
        }

        const webPairsPath = path.join(nexRoot, 'web_pairs.json');
        let webPairs = [];
        try {
          if (fs.existsSync(webPairsPath)) {
            webPairs = JSON.parse(fs.readFileSync(webPairsPath, 'utf8')) || [];
          }
        } catch {}
        const alreadyHas = webPairs.some(p => String(p?.jid || p?.number || '').includes(bootResult.digits));
        if (!alreadyHas) {
          webPairs.push({
            number: bootResult.digits,
            jid: bootResult.canonicalJid,
            pairedAt: new Date().toISOString(),
            status: 'connected',
            source: 'session_id_bootstrap'
          });
          fs.writeFileSync(webPairsPath, JSON.stringify(webPairs, null, 2), 'utf8');
        }

        // Record active bot session info so web UI shows: "BOT LIVE for <username>"
        const activeBotPath = path.join(nexRoot, 'active_bot.json');
        try {
          fs.writeFileSync(activeBotPath, JSON.stringify({
            live: true,
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
        process.env.BOT_IS_LIVE = 'true';
        if (bootResult.pushName) process.env.BOT_PUSH_NAME = bootResult.pushName;

        console.log(`[session-bootstrap] Injected credentials for ${bootResult.canonicalJid}`);
        console.log(`\n=============================================================`);
        console.log(`🟢 [SESSION BOOTSTRAP] Credentials ready for ${bootResult.canonicalJid}!`);
        console.log(`   Owner: ${bootResult.sessionUserName || "Owner"}`);
        console.log(`=============================================================\n`);
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
  const server = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: process.env,
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
};
