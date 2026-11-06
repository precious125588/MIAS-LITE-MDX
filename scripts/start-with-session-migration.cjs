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
  try {
    let sessionPaths;
    try { sessionPaths = require("../sessionPaths"); } catch { sessionPaths = require("../nexstore_modules/sessionPaths"); }
    const nexRoot = sessionPaths.nexstoreRoot ? sessionPaths.nexstoreRoot() : path.join(__dirname, "..", "nexstore");
    const sessionRoot = sessionPaths.resolveSessionRoot ? sessionPaths.resolveSessionRoot() : path.join(nexRoot, "pairing");

    const scanDirs = new Set([
      sessionRoot,
      path.join(nexRoot, "pairing"),
      "/app/nexstore/pairing",
      path.join(__dirname, "..", "nexstore", "pairing")
    ]);

    const { sessionDigits, parseDiscardSessions } = require('./sessionPolicy.cjs');
    const envSessionDigits = sessionDigits(preserveSessionJid);
    const discardSet = parseDiscardSessions(process.env.DISCARD_SESSIONS);
    // An explicitly loaded SESSION_ID is authoritative. Never discard the
    // live env identity even if DISCARD_SESSIONS accidentally contains it.
    if (envSessionDigits) discardSet.delete(envSessionDigits);
    const keepEnvSessionOnly = Boolean(envSessionDigits);
    const purgeAll = String(process.env.RESET_SESSIONS || process.env.PURGE_ALL_SESSIONS || "").toLowerCase() === "true";

    console.log(`[session-startup] Checking sessions${keepEnvSessionOnly ? ` (keeping only SESSION_ID ${envSessionDigits})` : ` (discard list: ${[...discardSet].join(", ")})`}${purgeAll ? "; RESET requested" : ""}...`);

    // 1. Purge from PostgreSQL if connected
    for (const dbUrl of [sessionUrl, settingsUrl].filter(Boolean)) {
      let pg;
      try { pg = require("pg"); } catch { break; }
      const { Pool } = pg;
      let pool;
      try {
        pool = new Pool({
          connectionString: normalizePostgresConnectionString(dbUrl),
          max: 1,
          connectionTimeoutMillis: 5000,
          statement_timeout: 15000,
          ssl: databaseSslOptions(dbUrl),
          application_name: "mais-clean-locked-sessions",
        });
        const client = await pool.connect();
        try {
          if (keepEnvSessionOnly) {
            const keepJid = `${envSessionDigits}@s.whatsapp.net`;
            const auth = await client.query("SELECT to_regclass($1) AS tbl", ["public.mias_session_auth"]);
            if (auth.rows[0]?.tbl) {
              await client.query("DELETE FROM public.mias_session_auth WHERE session_id NOT IN ($1, $2)", [keepJid, envSessionDigits]);
            }
            const registry = await client.query("SELECT to_regclass($1) AS tbl", ["public.mias_session_registry"]);
            if (registry.rows[0]?.tbl) {
              await client.query("DELETE FROM public.mias_session_registry WHERE jid <> $1 OR number <> $2", [keepJid, envSessionDigits]);
            }
            const selections = await client.query("SELECT to_regclass($1) AS tbl", ["public.mias_bot_selections"]);
            if (selections.rows[0]?.tbl) {
              await client.query("DELETE FROM public.mias_bot_selections WHERE number <> $1", [envSessionDigits]);
            }
          } else if (purgeAll) {
            for (const table of ["mias_session_auth", "mias_session_registry", "mias_bot_selections"]) {
              const check = await client.query("SELECT to_regclass($1) AS tbl", [`public.${table}`]);
              if (check.rows[0]?.tbl) {
                await client.query(`TRUNCATE TABLE public.${table} CASCADE`);
              }
            }
          } else {
            for (const num of discardSet) {
              const jid = `${num}@s.whatsapp.net`;
              const checkAuth = await client.query("SELECT to_regclass($1) AS tbl", ["public.mias_session_auth"]);
              if (checkAuth.rows[0]?.tbl) {
                await client.query("DELETE FROM mias_session_auth WHERE session_id = $1 OR session_id = $2", [jid, num]);
              }
              const checkReg = await client.query("SELECT to_regclass($1) AS tbl", ["public.mias_session_registry"]);
              if (checkReg.rows[0]?.tbl) {
                await client.query("DELETE FROM mias_session_registry WHERE jid = $1 OR number = $2", [jid, num]);
              }
              const checkSel = await client.query("SELECT to_regclass($1) AS tbl", ["public.mias_bot_selections"]);
              if (checkSel.rows[0]?.tbl) {
                await client.query("DELETE FROM mias_bot_selections WHERE number = $1", [num]);
              }
            }
          }
        } finally {
          client.release();
        }
      } catch (dbErr) {
        // Advisory cleanup; ignore unreachable DB
      } finally {
        if (pool) try { await pool.end(); } catch {}
      }
    }

    // 2. Scan disk folders across all session roots
    for (const dir of scanDirs) {
      if (!fs.existsSync(dir)) continue;
      let entries = [];
      try { entries = fs.readdirSync(dir); } catch {}
      for (const ent of entries) {
        const fullPath = path.join(dir, ent);
        let isDirectory = false;
        try { isDirectory = fs.statSync(fullPath).isDirectory(); } catch {}
        if (!isDirectory) continue;

        const digits = ent.split("@")[0].split(":")[0].replace(/[^0-9]/g, "");

        // A. Remove if in discard list or full reset requested
        const looksLikeSessionFolder = Boolean(digits) && (ent.includes("@") || /^\d/.test(ent) || ent.includes(".quarantine-"));
        if ((keepEnvSessionOnly && looksLikeSessionFolder && digits !== envSessionDigits) || (!keepEnvSessionOnly && purgeAll) || (digits && discardSet.has(digits))) {
          try {
            fs.rmSync(fullPath, { recursive: true, force: true });
            console.log(`[session-startup] Permanently removed discarded session: ${ent}`);
          } catch {}
          continue;
        }

        // B. Remove quarantine copies of discarded numbers
        if (ent.includes(".quarantine-")) {
          for (const num of discardSet) {
            if (ent.includes(num)) {
              try { fs.rmSync(fullPath, { recursive: true, force: true }); } catch {}
              break;
            }
          }
        }

        // C. Clear stale connection paused markers (.connection-paused.json)
        // On container startup, no bot worker process exists yet from previous runs
        const connPaused = path.join(fullPath, ".connection-paused.json");
        if (fs.existsSync(connPaused)) {
          try {
            fs.rmSync(connPaused, { force: true });
            console.log(`[session-startup] Cleared stale connection pause marker in ${ent}`);
          } catch {}
        }

        // D. Clear stale runtime locks
        const runtimeLock = path.join(fullPath, ".runtime.lock");
        if (fs.existsSync(runtimeLock)) {
          try { fs.rmSync(runtimeLock, { force: true }); } catch {}
        }

        // E. Clean incomplete / broken creds older than 3 minutes
        const credsFile = path.join(fullPath, "creds.json");
        if (fs.existsSync(credsFile)) {
          try {
            const data = JSON.parse(fs.readFileSync(credsFile, "utf8"));
            if (!data || (data.registered === false && !data.me)) {
              const stat = fs.statSync(credsFile);
              if (Date.now() - stat.mtimeMs > 3 * 60 * 1000) {
                fs.rmSync(fullPath, { recursive: true, force: true });
                console.log(`[session-startup] Cleaned incomplete stale session folder: ${ent}`);
              }
            }
          } catch {
            fs.rmSync(fullPath, { recursive: true, force: true });
            console.log(`[session-startup] Cleaned corrupt session folder: ${ent}`);
          }
        }
      }
    }

    // 3. Clean web_pairs.json
    const webPairsPath = path.join(nexRoot, "web_pairs.json");
    try {
      if (fs.existsSync(webPairsPath)) {
        let webPairs = JSON.parse(fs.readFileSync(webPairsPath, "utf8")) || [];
        if (Array.isArray(webPairs)) {
          const beforeLen = webPairs.length;
          webPairs = purgeAll && !keepEnvSessionOnly ? [] : webPairs.filter(p => {
            const num = sessionDigits(p?.number || p?.jid || "");
            if (keepEnvSessionOnly) return num === envSessionDigits;
            return num && !discardSet.has(num);
          });
          if (webPairs.length !== beforeLen) {
            fs.writeFileSync(webPairsPath, JSON.stringify(webPairs, null, 2), "utf8");
            console.log(`[session-startup] Cleaned web_pairs.json (${beforeLen - webPairs.length} removed)`);
          }
        }
      }
    } catch {}

    // 4. Clean active_bot.json
    const activeBotPath = path.join(nexRoot, "active_bot.json");
    try {
      if (fs.existsSync(activeBotPath)) {
        const activeBot = JSON.parse(fs.readFileSync(activeBotPath, "utf8")) || {};
        const actNum = String(activeBot.digits || activeBot.jid || "").split("@")[0].replace(/[^0-9]/g, "");
        if ((keepEnvSessionOnly && actNum !== envSessionDigits) || (purgeAll && !keepEnvSessionOnly) || (actNum && discardSet.has(actNum))) {
          fs.writeFileSync(activeBotPath, JSON.stringify({
            live: false,
            username: null,
            pushName: null,
            jid: null,
            digits: null,
            updatedAt: new Date().toISOString()
          }, null, 2), "utf8");
          console.log("[session-startup] Reset active_bot.json to unlinked state");
        }
      }
    } catch {}

    // 5. Clean botSelectionStore (bot_selections.json, pending_selections.json)
    try {
      const selStore = require("../deploy/botSelectionStore");
      for (const num of discardSet) {
        selStore.clearSelection(num);
        selStore.clearPending(num);
      }
      if (keepEnvSessionOnly) {
        for (const filename of ["bot_selections.json", "pending_selections.json"]) {
          const target = path.join(nexRoot, filename);
          try {
            if (!fs.existsSync(target)) continue;
            const data = JSON.parse(fs.readFileSync(target, "utf8")) || {};
            for (const key of Object.keys(data)) {
              if (sessionDigits(key) !== envSessionDigits) delete data[key];
            }
            fs.writeFileSync(target, JSON.stringify(data, null, 2), "utf8");
          } catch {}
        }
      }
      if (purgeAll && !keepEnvSessionOnly) {
        const selFile = path.join(nexRoot, "bot_selections.json");
        const penFile = path.join(nexRoot, "pending_selections.json");
        if (fs.existsSync(selFile)) fs.writeFileSync(selFile, "{}", "utf8");
        if (fs.existsSync(penFile)) fs.writeFileSync(penFile, "{}", "utf8");
      }
    } catch {}

    // 6. Clean bot_status/
    try {
      const statusDir = path.join(nexRoot, "bot_status");
      if (fs.existsSync(statusDir)) {
        if (keepEnvSessionOnly) {
          for (const entry of fs.readdirSync(statusDir)) {
            if (entry.endsWith('.json') && sessionDigits(entry) !== envSessionDigits) {
              try { fs.rmSync(path.join(statusDir, entry), { force: true }); } catch {}
            }
          }
        } else {
          for (const num of discardSet) {
            const p = path.join(statusDir, `${num}.json`);
            if (fs.existsSync(p)) fs.rmSync(p, { force: true });
          }
        }
      }
    } catch {}

  } catch (err) {
    console.warn("[session-startup] Notice running session cleanup:", err.message);
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
  // Resolve SESSION_ID before cleanup so a reset can preserve the credentials
  // the bot is actually about to run, and remove only non-matching sessions.
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
          path.join(sessionRoot, bootResult.canonicalJid),
          path.join(nexRoot, 'pairing', bootResult.canonicalJid)
        ]);
        for (const targetDir of targetDirs) {
          fs.mkdirSync(targetDir, { recursive: true });
          fs.writeFileSync(path.join(targetDir, 'creds.json'), JSON.stringify(bootResult.credsObj, null, 2), 'utf8');
        }
        for (const legacyDir of [
          path.join(sessionRoot, bootResult.digits),
          path.join(nexRoot, 'pairing', bootResult.digits)
        ]) {
          try {
            if (fs.existsSync(legacyDir) && !targetDirs.has(legacyDir)) {
              fs.rmSync(legacyDir, { recursive: true, force: true });
            }
          } catch {}
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
