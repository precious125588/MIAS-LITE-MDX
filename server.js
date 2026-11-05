'use strict';

/**
 * MIAS LITE MDX — Web Server & Pairing Dashboard
 * WhatsApp Multi-Device Automation Bot Manager
 */

// Cache cleanup & integrity check
try {
  require('./lib/precious-cache-clear.cjs').clearAll();
  require('./lib/precious-stale-guard.cjs').verify({ name: 'server' });
} catch (_) {}

// Crash shield protection
try {
  require('./lib/crash-shield.cjs').install({ name: 'server' });
} catch (e) {
  console.warn('[server] crash-shield note:', e.message);
}

// Build sync & update verification
try {
  require('./lib/build-sync.cjs').check().catch(() => {});
} catch (_) {}

// Session & runtime orchestrator
try {
  require('./precious-master-fix-boot.cjs').bootParent();
} catch (e) {
  console.warn('[server] orchestrator boot notice:', e.message);
}

// Asset and anime edits preload
try {
  process.env.CREATOR_USERNAME = process.env.CREATOR_USERNAME || 'precious125588';
  require('./mias/lib/creatorPageStatus.cjs').printCreatorStatus();
  require('./mias/precious-anime-edits.cjs').preloadCreatorEdits();
} catch (_) {}

require('dotenv').config();

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const os      = require('os');
const QRCode  = require('qrcode');
const { isJsonOnly } = require('./mias/lib/storageMode.cjs');

const app  = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';

function configuredTelegramToken() {
    return String(process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN || '').trim();
}

function redactSecrets(value = '') {
    let text = String(value);
    for (const secret of [process.env.TELEGRAM_BOT_TOKEN, process.env.BOT_TOKEN]) {
        if (secret) text = text.split(secret).join('<TELEGRAM_BOT_TOKEN>');
    }
    return text.replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot<TELEGRAM_BOT_TOKEN>');
}

function safeErrorMessage(err) {
    const raw = err?.response?.body?.description || err?.message || err?.code || String(err || 'Unknown error');
    return redactSecrets(raw);
}

// v34: precious-session-boot is merged into precious-master-fix-boot.cjs
// (bootParent). ensureSessionRoot() below keeps this module self-sufficient.
const _sessionPaths = require('./sessionPaths');
const NEXSTORE    = _sessionPaths.nexstoreRoot();
// Keep every server-side session read/write on the same configured root as
// pair.js and the MIAS child. SESSION_DIR can override the Railway default.
const PAIRING_DIR = _sessionPaths.ensureSessionRoot();
const ERROR_FILE  = path.join(NEXSTORE, 'web_errors.json');
const PAIR_FILE   = path.join(NEXSTORE, 'web_pairs.json');

[NEXSTORE, PAIRING_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d,{recursive:true}); });

// ── nexstore modules (restored by fix_all.cjs at startup; safe fallback below) ──
let registry, logger;
try {
  registry = require('./nexstore_modules/sessionRegistry');
} catch(e1) {
  try { registry = require('./nexstore/sessionRegistry'); } catch(e) {
    console.error('[server] sessionRegistry unavailable:', e.message);
    registry = { register:()=>{}, updateStatus:()=>{}, unregister:()=>{}, get:()=>null,
                 getAll:()=>[], getBySource:()=>[], has:()=>false, count:()=>0,
                 getAnalytics:()=>({total:0,web:0,telegram:0,today:0,week:0,connected:0}), flush:()=>{} };
  }
}
try {
  logger = require('./nexstore_modules/logger');
} catch(e1) {
  try { logger = require('./nexstore/logger'); } catch(e) {
    console.error('[server] logger unavailable:', e.message);
    const {EventEmitter}=require('events'); const _em=new EventEmitter();
    logger = { log:()=>{}, warn:()=>{}, error:()=>{}, readLog:()=>[], clearLog:()=>{}, emitter:_em };
  }
}

// ── Bot-selection store / deploy manager (optional, never fatal) ─────────────
let _selectionStore = null, _deployMgr = null;
try { _selectionStore = require('./deploy/botSelectionStore'); } catch(e) {
  console.error('[server] botSelectionStore unavailable:', e.message);
}
try { _deployMgr = require('./deploy/deploymentManager'); } catch(e) {
  console.error('[server] deploymentManager unavailable:', e.message);
}

// ── SSE broadcast sets ────────────────────────────────────────────────────────
const logSseClients = new Set();
const pairingSseMap = new Map();

function broadcastLog(entry) {
    if (!logSseClients.size) return;
    const msg = `data: ${JSON.stringify(entry)}\n\n`;
    for (const c of logSseClients) { try { c.write(msg); } catch { logSseClients.delete(c); } }
}
logger.emitter.on('entry', broadcastLog);

function broadcastPairingEvent(jid, event, data) {
    const clients = pairingSseMap.get(jid);
    if (!clients?.size) return;
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) { try { c.write(msg); } catch { clients.delete(c); } }
}

function sendPairingEvent(res, event, data) {
    try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        return true;
    } catch {
        return false;
    }
}

// ── JSON helpers ──────────────────────────────────────────────────────────────
function readJson(f, d=[]) { try { if(fs.existsSync(f)) return JSON.parse(fs.readFileSync(f,'utf8')); } catch{} return d; }
function writeJson(f, d)   { try { fs.writeFileSync(f,JSON.stringify(d,null,2),'utf8'); } catch {} }

let errorLog = readJson(ERROR_FILE, []);
let pairLog  = readJson(PAIR_FILE,  []);

const ADMIN_SETTINGS_FILE = path.join(NEXSTORE, 'admin_settings.json');
let adminSettings = readJson(ADMIN_SETTINGS_FILE, {});
// Railway/.env is the source of truth when it is configured. Only fall back
// to the admin-panel value when no environment token exists; a stale token
// persisted on the volume must never silently override a repaired Railway
// variable.
if (!configuredTelegramToken() && adminSettings.telegramBotToken) {
    process.env.TELEGRAM_BOT_TOKEN = String(adminSettings.telegramBotToken).trim();
}

function logError(number, message, type='pairing') {
    errorLog.unshift({number,message,type,timestamp:new Date().toISOString()});
    if (errorLog.length > 500) errorLog = errorLog.slice(0,500);
    writeJson(ERROR_FILE, errorLog);
}
function logPair(number, status, details='', source='web') {
    const idx = pairLog.findIndex(p=>p.number===number);
    const e   = {number,status,details,source,timestamp:new Date().toISOString()};
    if (idx>=0) pairLog[idx]=e; else pairLog.unshift(e);
    if (pairLog.length > 1000) pairLog = pairLog.slice(0,1000);
    writeJson(PAIR_FILE, pairLog);
}

// ── Lazy module refs ──────────────────────────────────────────────────────────
let _pair = null, _launcher = null, _ready = false;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json({limit:'1mb'}));
app.use(express.urlencoded({extended:true}));
app.use(express.static(path.join(__dirname,'public')));
app.use((_,res,next) => { res.setHeader('X-Content-Type-Options','nosniff'); next(); });

// ── Rate limiting ─────────────────────────────────────────────────────────────
const rlMap = new Map();
function rateLimit(windowMs=60000, max=5) {
    return (req,res,next) => {
        const k=req.ip||'x', now=Date.now();
        const r=rlMap.get(k)||{count:0,start:now};
        if(now-r.start>windowMs){r.count=0;r.start=now;}
        r.count++; rlMap.set(k,r);
        if(r.count>max) return res.status(429).json({ok:false,error:'Too many requests. Wait a minute.'});
        next();
    };
}
setInterval(()=>{const c=Date.now()-60000;for(const[k,v]of rlMap) if(v.start<c) rlMap.delete(k);},300000);

// ── Admin sessions ────────────────────────────────────────────────────────────
const adminSessions = new Map();
function genToken() { return Math.random().toString(36).slice(2)+Date.now().toString(36); }
function isAdmin(req) {
    const t=req.headers['x-admin-token']||req.query.token;
    if(!t||!adminSessions.has(t)) return false;
    const s=adminSessions.get(t);
    if(Date.now()-s.createdAt>86400000){adminSessions.delete(t);return false;}
    return true;
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function _getDirSize(dir) {
    let t=0;
    try { for(const i of fs.readdirSync(dir,{withFileTypes:true})) { const f=path.join(dir,i.name); if(i.isDirectory())t+=_getDirSize(f); else try{t+=fs.statSync(f).size;}catch{} } } catch{}
    return t;
}
function _delDir(p) {
    if(!fs.existsSync(p))return;
    for(const f of fs.readdirSync(p)){const fp=path.join(p,f);fs.lstatSync(fp).isDirectory()?_delDir(fp):fs.unlinkSync(fp);}
    fs.rmdirSync(p);
}
const _sleep = ms => new Promise(r=>setTimeout(r,ms));

// ═════════════════════════════════════════════════════════════════════════════
// ── Database & Volume Persistence Status ─────────────────────────────────────
let _dbStatusCache = {
  checkedAt: 0,
  settingsDb: { attached: false, status: "not_configured", message: "DATABASE_URL is not set", database: null },
  sessionDb: { attached: false, status: "not_configured", message: "SESSION_DATABASE_URL is not set", database: null, sessionsInDb: 0 },
  externalDb: { attached: false, status: "not_configured", message: "RAILWAY_DATABASE_URL is not set", database: null },
  redis: { attached: false, status: "not_configured", message: "REDIS_URL is not set" },
  volumeMounted: false,
  attached: false,
  status: "not_configured",
  message: "Databases not configured",
  database: null,
  sessionsInDb: 0,
};

function jsonOnlyDbStatus(now) {
  const off = { attached: false, status: "json_only", message: "Off (JSON only)", database: null };
  let volumeMounted = false;
  try {
    volumeMounted = Boolean(_sessionPaths && typeof _sessionPaths.isVolumeMounted === "function" ? _sessionPaths.isVolumeMounted() : false);
  } catch {}
  return {
    checkedAt: now,
    settingsDb: { ...off },
    sessionDb: { ...off, sessionsInDb: 0 },
    externalDb: { ...off },
    redis: { ...off },
    volumeMounted,
    storageMode: "json",
    attached: false,
    status: "json_only",
    message: "Storage is JSON only; PostgreSQL and Redis are off",
    database: null,
    sessionsInDb: 0,
    role: "isolated",
  };
}

async function checkDbStatus(force = false) {
  const now = Date.now();
  if (!force && now - _dbStatusCache.checkedAt < 10000) {
    return _dbStatusCache;
  }
  if (isJsonOnly()) {
    _dbStatusCache = jsonOnlyDbStatus(now);
    return _dbStatusCache;
  }

  const { Pool } = require("pg");
  const { normalizePostgresConnectionString } = require("./mias/lib/pgConnection.cjs");
  const { assertRailwayConnection, createRailwayPool, resolveStateDatabase } = require("./mias/lib/railwayPersistence.cjs");
  const { checkRedisStatus } = require("./mias/lib/redisStatus.cjs");
  const { databaseDiagnostic } = require("./mias/lib/databaseDiagnostics.cjs");
  const sessionStore = require("./mias/sessionPersistence.cjs");

  // Use the same Railway-first database selection as the bot process so the
  // status screen probes the database the bot will actually use.
  const settingsDatabase = resolveStateDatabase({
    railwayUrl: process.env.RAILWAY_DATABASE_URL,
    neonUrl: String(process.env.DATABASE_URL || "").trim()
      || String(process.env.SETTINGS_DATABASE_URL || "").trim(),
  });
  const settingsUrl = settingsDatabase.connectionString;
  const sessionUrl = sessionStore.getDatabaseUrl();
  const externalUrl = String(process.env.RAILWAY_DATABASE_URL || "").trim();

  let volumeMounted = false;
  try {
    volumeMounted = Boolean(_sessionPaths && typeof _sessionPaths.isVolumeMounted === "function" ? _sessionPaths.isVolumeMounted() : false);
  } catch {}

  let settingsDb = { attached: false, status: "not_configured", message: "DATABASE_URL is not set", database: null };
  let sessionDb = { attached: false, status: "not_configured", message: "SESSION_DATABASE_URL is not set", database: null, sessionsInDb: 0 };
  let externalDb = { attached: false, status: "not_configured", message: "RAILWAY_DATABASE_URL is not set", database: null };
  let redis = { attached: false, status: "not_configured", message: "REDIS_URL is not set" };

  // 1. Settings Database check
  if (settingsUrl) {
    let pool;
    try {
      const poolOptions = {
        max: 1,
        connectionTimeoutMillis: 5000,
        statement_timeout: 8000,
        application_name: "mais-status-check-settings",
      };
      pool = settingsDatabase.provider === "railway"
        ? createRailwayPool({ connectionString: settingsUrl, ...poolOptions })
        : new Pool({
          connectionString: normalizePostgresConnectionString(settingsUrl),
          ...poolOptions,
          ssl: { rejectUnauthorized: true },
        });
      const res = await pool.query("SELECT 1 as ok, current_database() as db");
      const row = res.rows[0];
      settingsDb = {
        attached: true,
        status: "connected",
        message: "Settings database connected",
        database: row?.db || "neondb",
      };
    } catch (err) {
      const diagnostic = databaseDiagnostic(err, "settings");
      settingsDb = {
        attached: false,
        status: "error",
        message: diagnostic.code,
        diagnostic,
        database: null,
      };
    } finally {
      if (pool) { try { await pool.end(); } catch {} }
    }
  }

  // 2. Session Database check
  if (sessionUrl) {
    try {
      const pool = await sessionStore.readyPool();
      if (pool) {
        const res = await pool.query("SELECT 1 as ok, current_database() as db");
        const sessionsInDb = await sessionStore.getStoredSessionsCount({ strict: true });
        const row = res.rows[0];
        sessionDb = {
          attached: true,
          status: "connected",
          message: "Session database connected",
          database: row?.db || "neondb",
          sessionsInDb,
        };
      } else {
        sessionDb = {
          attached: false,
          status: "error",
          message: "SESSION_POOL_INIT_FAILED",
          database: null,
          sessionsInDb: 0,
        };
      }
    } catch (err) {
      const diagnostic = databaseDiagnostic(err, "session");
      sessionDb = {
        attached: false,
        status: "error",
        message: diagnostic.code,
        diagnostic,
        database: null,
        sessionsInDb: 0,
      };
    }
  }

  // Railway PostgreSQL is checked independently from the existing Neon
  // settings URL. This is read-only and never migrates or writes to Neon.
  if (externalUrl) {
    let pool;
    try {
      pool = createRailwayPool({
        connectionString: externalUrl,
        max: 1,
        connectionTimeoutMillis: 3000,
        query_timeout: 4000,
        statement_timeout: 3000,
        application_name: "mais-webpair-status",
      });
      const probe = await assertRailwayConnection(pool);
      externalDb = {
        attached: true,
        status: "connected",
        message: "Railway PostgreSQL connected",
        database: probe.databaseName,
      };
    } catch (err) {
      const diagnostic = databaseDiagnostic(err, "railway");
      externalDb = {
        attached: false,
        status: "error",
        message: diagnostic.code === "CONNECTION_FAILED" ? "RAILWAY_DATABASE_UNAVAILABLE" : diagnostic.code,
        diagnostic,
        database: null,
      };
    } finally {
      if (pool) { try { await pool.end(); } catch {} }
    }
  }

  try {
    redis = await checkRedisStatus(process.env.REDIS_URL, { timeoutMs: 2500 });
    if (redis.status === "error") {
      redis = { ...redis, diagnostic: databaseDiagnostic(redis.message, "redis") };
    }
  } catch {
    const diagnostic = databaseDiagnostic("REDIS_UNAVAILABLE", "redis");
    redis = { attached: false, status: "error", message: diagnostic.code, diagnostic };
  }

  const databaseAttached = settingsDb.attached || sessionDb.attached || externalDb.attached;
  const databaseError = settingsDb.status === "error" || sessionDb.status === "error"
    || externalDb.status === "error";
  const overallStatus = databaseAttached ? "connected" : (databaseError ? "error" : "not_configured");

  let message = "Databases not configured";
  if (externalDb.attached && settingsDb.attached && sessionDb.attached) {
    message = "Railway PostgreSQL, Settings DB & Session DB connected";
  } else if (externalDb.attached && settingsDb.attached) {
    message = "Railway PostgreSQL & Settings DB connected";
  } else if (externalDb.attached && sessionDb.attached) {
    message = "Railway PostgreSQL & Session DB connected";
  } else if (externalDb.attached) {
    message = "Railway PostgreSQL connected";
  } else if (settingsDb.attached && sessionDb.attached) {
    message = "Settings DB & Session DB connected";
  } else if (sessionDb.attached) {
    message = "Session DB connected (Settings DB on local JSON)";
  } else if (settingsDb.attached) {
    message = "Settings DB connected (Session DB on local files)";
  } else if (databaseError) {
    message = "Database connection error";
  } else if (redis.attached) {
    message = "Redis connected; PostgreSQL persistence is not configured";
  } else if (redis.status === "error") {
    message = "Redis connection error; PostgreSQL persistence is not configured";
  }

  _dbStatusCache = {
    checkedAt: now,
    settingsDb,
    sessionDb,
    externalDb,
    redis,
    volumeMounted,
    // Top-level compatibility fields
    attached: databaseAttached,
    status: overallStatus,
    message,
    database: sessionDb.database || externalDb.database || settingsDb.database,
    sessionsInDb: sessionDb.sessionsInDb || 0,
    role: "isolated",
  };
  return _dbStatusCache;
}

app.get('/api/database/status', async (_, res) => {
  const db = await checkDbStatus();
  res.json({ ok: true, ...db });
});
app.get('/api/health', async (_, res) => {
  const db = await checkDbStatus();
  res.json({
    ok: true,
    ready: _ready,
    uptime: process.uptime(),
    version: process.version,
    port: PORT,
    database: db.status,
    dbAttached: db.attached,
    volumeMounted: db.volumeMounted,
  });
});
app.get('/api/ready', async (_, res) => {
  const db = await checkDbStatus();
  res.json({
    ok: _ready && !!_pair,
    pairReady: !!_pair,
    database: db,
    message: _ready && !!_pair ? 'Server ready' : 'Warming up — try again in 15s',
  });
});

// ── Pair: request a QR or pairing code ───────────────────────────────────────
app.post('/api/pair', rateLimit(60000,10), async (req,res) => {
    if (!_pair) return res.status(503).json({ok:false,error:'Server is still starting up. Please wait 15–30 seconds and try again.'});

    let {number} = req.body;
    const mode = req.body?.mode === 'qr' ? 'qr' : 'code';
    if (!number) return res.status(400).json({ok:false,error:'Phone number required.'});
    number = number.replace(/[^0-9]/g,'');
    if (number.length === 11 && number.startsWith('0')) {
        number = '234' + number.slice(1);
    }
    if (number.length<7||number.length>15) return res.status(400).json({ok:false,error:'Invalid phone number.'});

    const jid = `${number}@s.whatsapp.net`;
    const force = req.body?.force === true || req.body?.force === 'true';

    // An explicit reset must stop the old child and await the database purge
    // before any new pairing state is generated, including rejected sessions.
    const sd = _sessionPaths.sessionDirFor(jid);
    const reauthRequired = fs.existsSync(path.join(sd, '.reauth-required.json'));
    if (force) {
        try {
            await _pair.unpairSession(jid);
            try { registry.remove?.(jid); } catch {}
        } catch (error) {
            return res.status(503).json({ ok: false, error: error.message });
        }
    } else if (reauthRequired) {
        return res.status(409).json({ ok: false, canRepair: true,
            error: 'WhatsApp rejected the saved session. Tap "Re-pair anyway" to reset it and get a new code.' });
    } else if (_pair.hasPairedSession(jid)) {
        const live = _pair.isSessionLive ? _pair.isSessionLive(jid) : true;
        const cleanDigits = String(jid).split('@')[0].replace(/[^0-9]/g, '');
        const botRunning = _launcher ? _launcher.list().some(r => {
            const rDigits = String(r.number).split('@')[0].replace(/[^0-9]/g, '');
            return rDigits === cleanDigits && r.alive;
        }) : false;
        if (!live && !botRunning) {
            try {
                if (!_launcher) return res.status(503).json({ ok: false, error: 'Bot launcher is warming up. Session kept.' });
                if (_launcher.isPaused(jid)) return res.status(409).json({ ok: false, error: 'This bot is paused. Resume it from admin; the session is saved.' });
                await _launcher.launch(jid, sd);
                return res.json({ ok: true, restored: true, number, message: 'Starting from the saved session; no new pairing code is needed.' });
            } catch (e) {
                return res.status(503).json({ ok: false, error: 'Saved-session startup failed. Your credentials were kept. Use Restart bot in admin.' });
            }
        }
        return res.status(409).json({ ok: false, canRepair: true,
            error: 'This number has a saved session. Tap "Re-pair anyway" only if you want to replace it.' });
    }

    // A cached code is only valid if a pairing socket is ACTUALLY live and waiting right now.
    // Serving a dead record from disk causes WhatsApp to reject it as "incorrect code".
    const isLivePairing = _pair.isPairingActive ? _pair.isPairingActive(jid) : false;
    const existing = (!force && isLivePairing)
        ? (mode === 'qr' ? _pair.readPairingQrRecord?.(jid) : _pair.readPairingCodeRecord(jid))
        : null;

    if (mode === 'qr' && existing?.qr) {
        broadcastPairingEvent(jid,'qr_ready',{url:`/api/pair/qr/${number}`,cached:true});
        return res.json({ok:true,mode:'qr',qrUrl:`/api/pair/qr/${number}`,cached:true});
    }
    if (mode === 'code' && existing?.code) {
        const _dbgExisting = _pair?.getPairingRuntimeState?.(jid)?.debug || null;
        broadcastPairingEvent(jid,'code_ready',{code:existing.code,cached:true, debug:_dbgExisting});
        if (_dbgExisting) broadcastPairingEvent(jid,'debug',_dbgExisting);
        return res.json({ok:true,mode:'code',code:existing.code,cached:true});
    }

    // Starting a fresh pairing attempt: clear any old stale records
    try { _pair.clearPairingCodeRecord?.(jid); } catch {}
    try { _pair.clearPairingQrRecord?.(jid); } catch {}

    logger.log('pairing',`Web pair request: ${jid}`);
    broadcastPairingEvent(jid,'connecting',{msg:'Connecting to WhatsApp servers...'});

    // IMPORTANT: never block the HTTP response on the WhatsApp handshake.
    // Waiting ~90s here exceeded proxy/gateway timeouts, so the browser saw a
    // 502/timeout and the user never received a pairing code even though the
    // code had actually been generated. The request now returns immediately
    // and the code is pushed over the SSE stream (and readable via
    // /api/pair/status/:number as a fallback).
    try {
        _pair.startpairing(jid, {mode}).catch(err => {
            logError(jid,err.message,'pairing-init');
            logPair(jid,'failed',err.message,'web');
            broadcastPairingEvent(jid,'failed',{msg:err.message});
        });
        broadcastPairingEvent(jid,'authenticating',{msg:'Authenticating session...'});

        _pair.waitForPairingResult(jid,120000,mode)
            .then(result => {
                try { registry.register(jid,'web'); } catch {}
                const detail = mode === 'qr'
                    ? `/api/pair/qr/${number}`
                    : result.code;
                logPair(jid, mode === 'qr' ? 'qr-sent' : 'code-sent', detail, 'web');
                if (mode === 'qr') {
                    broadcastPairingEvent(jid,'qr_ready',{url:detail});
                } else {
                    const _dbg = _pair?.getPairingRuntimeState?.(jid)?.debug || null;
                    broadcastPairingEvent(jid,'code_ready',{code:result.code, debug:_dbg});
                    if (_dbg) broadcastPairingEvent(jid,'debug',_dbg);
                }
            })
            .catch(err => {
                logError(jid,err.message,'pairing');
                logPair(jid,'failed',err.message,'web');
                broadcastPairingEvent(jid,'failed',{msg:err.message||'Pairing failed. Try again.'});
            });

        return res.status(202).json({
            ok:true,
            pending:true,
            mode,
            msg: mode === 'qr' ? 'Generating your QR code…' : 'Generating your pairing code…'
        });
    } catch(err) {
        logError(jid,err.message,'pairing');
        logPair(jid,'failed',err.message,'web');
        broadcastPairingEvent(jid,'failed',{msg:err.message});
        return res.status(500).json({ok:false,error:err.message||'Pairing failed. Try again.'});
    }
});

// Render the live QR payload as a PNG. The raw WhatsApp payload never needs to
// be exposed to the browser or Telegram client.
app.get('/api/pair/qr/:number', async (req,res) => {
    const number = String(req.params.number || '').replace(/[^0-9]/g,'');
    if (number.length < 7 || number.length > 15 || !_pair) {
        return res.status(404).json({ok:false,error:'QR code not available.'});
    }
    const record = _pair.readPairingQrRecord?.(`${number}@s.whatsapp.net`);
    if (!record?.qr) return res.status(404).json({ok:false,error:'QR code expired. Start a new pairing.'});
    try {
        const png = await QRCode.toBuffer(record.qr, {
            type: 'png',
            width: 420,
            margin: 2,
            errorCorrectionLevel: 'M'
        });
        res.setHeader('Content-Type','image/png');
        res.setHeader('Cache-Control','no-store, no-cache, must-revalidate');
        return res.end(png);
    } catch (error) {
        return res.status(500).json({ok:false,error:'Could not render QR code.'});
    }
});

// ── Pair: SSE stream ──────────────────────────────────────────────────────────
app.get('/api/pair/stream/:number', (req,res) => {
    const number = req.params.number.replace(/[^0-9]/g,'');
    const jid    = `${number}@s.whatsapp.net`;

    res.setHeader('Content-Type','text/event-stream');
    res.setHeader('Cache-Control','no-cache');
    res.setHeader('Connection','keep-alive');
    res.setHeader('X-Accel-Buffering','no');
    res.flushHeaders();

    if (!pairingSseMap.has(jid)) pairingSseMap.set(jid,new Set());
    pairingSseMap.get(jid).add(res);

    const hb = setInterval(()=>{ try{res.write(': ping\n\n');}catch{clearInterval(hb);} },10000);
    let linked = false;
    let botStartupPoll = null;
    const requestedMode = req.query.mode === 'qr' ? 'qr' : null;
    let codeSent = false;
    let lastQrTimestamp = '';
    let sentConnecting = false;
    let sentAuthenticating = false;
    let sentFailure = '';

    // If a code already exists (or arrives while this stream is open) push it
    // straight away — the POST no longer carries the code in its response.
    const sendExistingCode = () => {
        if (codeSent || requestedMode === 'qr' || !_pair) return;
        try {
            // Only stream an existing code if pairing is actively in flight right now
            if (!_pair.isPairingActive?.(jid)) return;
            const rec = _pair.readPairingCodeRecord(jid);
            if (rec?.code) {
                codeSent = true;
                sendPairingEvent(res, 'code_ready', {code:rec.code});
            }
        } catch {}
    };
    const sendExistingQr = () => {
        if (requestedMode !== 'qr' || !_pair) return;
        try {
            const rec = _pair.readPairingQrRecord?.(jid);
            if (rec?.qr && rec.timestamp !== lastQrTimestamp) {
                lastQrTimestamp = rec.timestamp;
                sendPairingEvent(res, 'qr_ready', {url:`/api/pair/qr/${number}`,timestamp:rec.timestamp});
            }
        } catch {}
    };

    // Replay the current runtime state. The browser used to open this stream
    // after POST /api/pair, which meant the first connecting/authenticating
    // events were lost. Replaying state also makes refreshes and flaky mobile
    // networks recover without requiring a second pairing request.
    const sendRuntimeState = () => {
        if (!_pair) {
            sendPairingEvent(res, 'waiting', {msg:'Warming up...'});
            return;
        }
        try {
            const state = _pair.getPairingRuntimeState?.(jid);
            if (!state) return;
            sendPairingEvent(res, 'state', {
                active: !!state.active,
                paired: !!state.paired,
                live: !!state.live,
                mode: state.mode || requestedMode || null,
                debug: state.debug || null,
                stage: state.stage || null,
                lastDisconnectReason: state.lastDisconnectReason || null
            });
            if (state.debug) {
                sendPairingEvent(res, 'debug', state.debug);
            }
            if (state.active && !sentConnecting) {
                sentConnecting = true;
                sendPairingEvent(res, 'connecting', {msg:'Connected to the pairing service.'});
            }
            if (state.active && !sentAuthenticating) {
                sentAuthenticating = true;
                sendPairingEvent(res, 'authenticating', {msg:'Waiting for WhatsApp to approve the link...'});
            }
            if (state.error && state.error !== sentFailure) {
                sentFailure = state.error;
                sendPairingEvent(res, 'failed', {msg:state.error});
            }
        } catch {}
    };
    sendRuntimeState();
    sendExistingCode();
    sendExistingQr();

    const poll = setInterval(async ()=>{
        if (!_pair){res.write(`event: waiting\ndata: ${JSON.stringify({msg:'Warming up...'})}\n\n`);return;}
        sendRuntimeState();
        sendExistingCode();
        sendExistingQr();
        try {
            if (_pair.hasPairedSession(jid)&&!linked) {
                linked=true;
                sendPairingEvent(res, 'linked', {number,msg:'WhatsApp linked! Starting the bot...'});
                // ROOT-CAUSE FIX: pairing used to stop at "session saved" and only
                // HOPE pair.js had spawned the bot — a failed handoff left the monitor
                // on "Linked, bot not running" forever. The stream that confirms the
                // link now starts the bot from the saved session itself. The launcher's
                // single-flight guard makes this idempotent (no duplicate processes).
                if (_launcher){
                    // pair.js owns the socket through companion sync and closes it
                    // before transferring ownership. Start immediately when it
                    // emits the handoff event; never race a second socket here.
                    // The pairing flow starts the bot when the session is safe.
                    // Pairing can legitimately spend up to three minutes completing
                    // companion sync. Allow a further safe startup window instead of
                    // reporting a false failure after 15 seconds.
                    const BOT_STARTUP_OBSERVE_MS = 240_000;
                    const startupDeadline = Date.now() + BOT_STARTUP_OBSERVE_MS;
                    botStartupPoll = setInterval(()=>{
                        let bot;
                        try { bot=_launcher.list().find(r=>r.number===jid); } catch {}
                        if(bot&&bot.alive){
                            clearInterval(botStartupPoll);
                            botStartupPoll = null;
                            sendPairingEvent(res, 'bot_started', {number,pid:bot.pid,msg:'Bot process started; waiting for the WhatsApp connection.'});
                        } else if(Date.now() >= startupDeadline){
                            clearInterval(botStartupPoll);
                            botStartupPoll = null;
                            try {
                                sendPairingEvent(res, 'bot_error', {number,msg:'WhatsApp is linked, but the bot has not started within the safe startup window. Check the admin runtime status; your session is preserved.'});
                            } catch {}
                        }
                    },250);
                }
            }
        } catch {}
    },2000);

    req.on('close',()=>{ clearInterval(hb);clearInterval(poll);clearInterval(botStartupPoll);botStartupPoll=null; const c=pairingSseMap.get(jid); if(c){c.delete(res);if(!c.size)pairingSseMap.delete(jid);} });
    setTimeout(()=>{ clearInterval(poll);clearInterval(hb);try{res.write(`event: timeout\ndata: ${JSON.stringify({msg:'Timeout. Please refresh.'})}\n\n`);res.end();}catch{} },900000);
});

// ── Pair status poll ──────────────────────────────────────────────────────────
// ── Logout notification endpoints (web-pair UI polling) ──────────────────────
// Both endpoints require admin token authentication.
app.get('/api/logout/pending', (req,res) => {
    // Public read-only endpoint — only exposes non-sensitive logout metadata (number, reason, timestamp)
    // Session deletion requires admin auth via /api/logout/delete-session
    const NOTIF_DIR = path.join(__dirname, 'nexstore', 'logout_notifications');
    let items = [];
    try {
        if (!fs.existsSync(NOTIF_DIR)) return res.json([]);
        const files = fs.readdirSync(NOTIF_DIR).filter(f => f.endsWith('.json'));
        for (const f of files) {
            try {
                const p = JSON.parse(fs.readFileSync(path.join(NOTIF_DIR, f), 'utf8'));
                items.push(p);
            } catch {}
        }
    } catch {}
    res.json(items);
});
app.post('/api/logout/delete-session', async (req,res) => {
    if (!isAdmin(req)) return res.status(403).json({ ok: false, error: 'Unauthorized' });
    const num = String(req.body?.number || '').replace(/[^0-9]/g, '');
    if (!num) return res.json({ ok: false, error: 'number required' });
    let deleted = 0;
    try { const result = await _pair.unpairSession(`${num}@s.whatsapp.net`); deleted = result?.filesDeleted || 0; }
    catch (error) { return res.status(503).json({ ok: false, error: error.message }); }
    try { _selectionStore?.clearSelection(num); } catch {}
    res.json({ ok: true, deleted });
});

// ── Unpair / reset a number so it can be paired again ────────────────────────
app.post('/api/pair/reset', rateLimit(60000,10), async (req,res) => {
    if (!_pair) return res.status(503).json({ok:false,error:'Server is still starting up.'});
    let {number} = req.body || {};
    if (!number) return res.status(400).json({ok:false,error:'Phone number required.'});
    number = String(number).replace(/[^0-9]/g,'');
    if (number.length<7||number.length>15) return res.status(400).json({ok:false,error:'Invalid phone number.'});
    const jid = `${number}@s.whatsapp.net`;
    try { await _pair.unpairSession(jid); }
    catch (error) { return res.status(503).json({ ok: false, error: error.message }); }
    try { registry.remove?.(jid); } catch {}
    try { _selectionStore?.clearSelection(number); } catch {}
    logPair(jid,'reset','session cleared','web');
    res.json({ok:true,message:'Session cleared. You can pair this number again.'});
});

function readBotStatus(number){ try { return JSON.parse(fs.readFileSync(path.join(NEXSTORE,'bot_status',String(number).replace(/[^0-9]/g,'')+'.json'),'utf8')); } catch { return null; } }
// Plain-English meaning of the WhatsApp disconnect codes the bot records.
const BOT_CLOSE_HINTS = {
    401:{tone:'warn', text:'WhatsApp rejected authentication. The bot retries briefly; re-pair if recovery fails.'},
    403:{tone:'bad', text:'WhatsApp refused the connection. The number may be restricted.'},
    405:{tone:'warn',text:'WhatsApp rejected the handshake. The bot retries on its own.'},
    408:{tone:'warn',text:'Connection timed out. The bot retries on its own.'},
    411:{tone:'bad', text:'Multi-device mismatch. Pair again if it keeps happening.'},
    428:{tone:'warn',text:'WhatsApp closed the connection. The bot retries on its own.'},
    440:{tone:'bad', text:'Another device took over this session (WhatsApp Web or a new link).'},
    500:{tone:'bad', text:'Stored session data was rejected. Pair again.'},
    503:{tone:'warn',text:'WhatsApp service unavailable. The bot retries on its own.'},
    515:{tone:'ok',  text:'WhatsApp asked for a restart after linking. This is normal.'},
};
// Turns the raw facts (saved session, bot process, bot status record) into one phase
// the monitor can show, plus a checklist of every condition behind it.
function buildPairHealth({paired, live, botRunning, botStarting, startError, active, error, bs}) {
    const code  = (bs && bs.lastCloseCode != null) ? Number(bs.lastCloseCode) : null;
    const state = bs?.state || null;
    const hint  = code != null ? (BOT_CLOSE_HINTS[code] || {tone:'warn', text:`WhatsApp closed the connection with code ${code}.`}) : null;
    let phase, label, tone;
    if (state==='reauth_required')             { phase='logged_out'; label='Session rejected — re-pair required'; tone='bad'; }
    else if (state==='unlinked')                { phase='logged_out'; label='Device unlinked — pair again'; tone='bad'; }
    else if (!paired && !active)                { phase='new';          label='Not linked yet';                       tone='muted'; }
    else if (active && !paired)                 { phase='pairing';      label='Waiting for approval on your phone';   tone='info'; }
    else if (state==='reconnecting' && botRunning) { phase='reconnecting'; label=code===401 ? 'Authentication recovery in progress' : 'Reconnecting to WhatsApp'; tone='warn'; }
    else if (state==='conflict' || code===409 || code===440) { phase='replaced';     label='Taken over by another device';         tone='bad'; }
    else if (botStarting)                       { phase='starting';     label='Starting bot';                         tone='info'; }
    else if (!botRunning && startError)         { phase='start_failed'; label='Startup failed — use Restart bot';     tone='bad'; }
    else if (!botRunning)                       { phase='stopped';      label='Linked, bot not running';              tone='warn'; }
    else if (state==='open')                    { phase='live';         label='Live and connected';                   tone='ok'; }
    else if (state==='closed')                  { phase='reconnecting'; label='Disconnected, reconnecting';           tone='warn'; }
    else                                        { phase='starting';     label='Starting the connection';              tone='info'; }
    const checks = [
        {label:'Session saved',         ok:!!paired,                                   value: paired ? 'yes' : 'no'},
        {label:'Bot process running',   ok:!!botRunning,                               value: botRunning ? 'yes' : 'no'},
        {label:'Connected to WhatsApp', ok:!!botRunning && state==='open', value: !botRunning ? 'offline' : (state || (live ? 'live' : 'waiting'))},
        {label:'Last disconnect',       ok:code==null || code===515,                   value: code != null ? ('code ' + code) : 'none'},
    ];
    if (error) checks.push({label:'Runtime error', ok:false, value:String(error).slice(0,160)});
    if (startError) checks.push({label:'Startup error', ok:false, value:String((startError&&startError.message)||startError).slice(0,160)});
    return {
        phase, label, tone, checks,
        lastClose: code != null ? {code, message: bs?.lastCloseMsg || null, at: bs?.lastCloseAt || null, hint: hint.text} : null,
        openedAt: bs?.openedAt || null,
        updatedAt: bs?.updatedAt || null,
    };
}
app.get('/api/pair/status/:number', (req,res) => {
    const number = req.params.number.replace(/[^0-9]/g,'');
    const jid    = `${number}@s.whatsapp.net`;
    const runtime = _pair?.getPairingRuntimeState?.(jid) || {};
    const paired = _pair?(_pair.hasPairedSession(jid, {clean:false})):false;
    const live   = paired && _pair?.isSessionLive ? _pair.isSessionLive(jid) : false;
    const record = _pair?_pair.readPairingCodeRecord(jid):null;
    const botRunning = _launcher?_launcher.list().some(r=>r.number===jid&&r.alive):false;
    const botStarting = _launcher&&_launcher.isLaunching ? _launcher.isLaunching(jid) : false;
    const startError  = (!botRunning && _launcher && _launcher.lastError) ? (_launcher.lastError(jid)||null) : null;
    const selection = _selectionStore ? _selectionStore.get(number) : null;
    const bs = readBotStatus(number);
    if (registry.get(jid) && botRunning) {
        const status = bs?.state === 'open' ? 'connected' : 'connecting';
        if (registry.get(jid)?.status !== status) registry.updateStatus(jid, status);
    }
    const health = buildPairHealth({paired, live, botRunning, botStarting, startError, active:!!runtime.active, error:runtime.error||null, bs});
    res.json({
        ok:true,paired,live,
        code:record?.code||null,
        qr: !!_pair?.readPairingQrRecord?.(jid),
        mode: _pair?.readPairingQrRecord?.(jid) ? 'qr' : (record?.code ? 'code' : null),
        source:registry.get(jid)?.source||null,
        ready:_ready,botRunning,botStarting,startError,
        active:!!runtime.active,
        error:runtime.error||null,
        debug:runtime.debug||null,
        stage:runtime.stage||null,
        lastDisconnectReason:runtime.lastDisconnectReason||null,
        awaitingSelection: false,
        bot: botRunning ? { id: "mias-mdx", name: "MIAS MDX", locked: true } : null,
        botStatus: bs,
        health,
    });
});

// ── Bots & selections ────────────────────────────────────────────────────────
// Public: which bots this deployment offers.
app.get('/api/bots', (_req,res) => {
    res.json({ok:true,bots:[{id:"mias-mdx",name:"MIAS MDX",tagline:"Stable single-bot runtime"}]});
});

// Admin: every paired number and the bot it is locked to.
app.get('/api/admin/selections', (req,res) => {
    if(!isAdmin(req)) return res.status(403).json({ok:false,error:'Unauthorized'});
    if(!_selectionStore) return res.json({ok:true,selections:[]});
    try {
        const rows = _selectionStore.overview().map(r => ({
            ...r,
            botRunning: _launcher ? _launcher.list().some(x=>x.number===`${r.number}@s.whatsapp.net`&&x.alive) : false,
        }));
        res.json({ok:true,selections:rows});
    } catch(e){ res.status(500).json({ok:false,error:e.message}); }
});

// Admin: choose the bot for a number (respects the one-shot lock).
app.post('/api/admin/selections/:number', async (req,res) => {
    if(!isAdmin(req)) return res.status(403).json({ok:false,error:'Unauthorized'});
    res.status(410).json({ok:false,error:'Bot selection was removed. Every paired number runs MIAS MDX.'});
});

// Admin: unlock a number (only ever done together with an unpair).
app.delete('/api/admin/selections/:number', (req,res) => {
    if(!isAdmin(req)) return res.status(403).json({ok:false,error:'Unauthorized'});
    if(!_selectionStore) return res.status(503).json({ok:false,error:'Selection store unavailable.'});
    const number = String(req.params.number).replace(/[^0-9]/g,'');
    try {
        _selectionStore.clearSelection(number);
        res.json({ok:true,message:'Legacy selection cleared. The number remains assigned to MIAS MDX.'});
    } catch(e){ res.status(500).json({ok:false,error:e.message}); }
});

// ── Admin: clean all DB ───────────────────────────────────────────────────────
async function cleanAllDatabases() {
  const { Pool } = require("pg");
  const { normalizePostgresConnectionString } = require("./mias/lib/pgConnection.cjs");
  const sessionStore = require("./mias/sessionPersistence.cjs");
  const results = { sessionDb: false, settingsDbSessions: false, localSessions: false };

  // 1. Clean Session DB
  const sessionUrl = isJsonOnly() ? "" : sessionStore.getDatabaseUrl();
  if (sessionUrl) {
    try {
      const res = await sessionStore.clearAllSessionRecords();
      results.sessionDb = res.ok;
      if (!res.ok) results.sessionDbError = res.error || res.reason;
    } catch (err) {
      results.sessionDbError = err.message;
    }
  }

  // 2. Clean legacy session tables in Settings DB
  const settingsUrl = isJsonOnly() ? "" : String(process.env.DATABASE_URL || process.env.SETTINGS_DATABASE_URL || "").trim();
  if (settingsUrl) {
    let pool;
    try {
      pool = new Pool({
        connectionString: normalizePostgresConnectionString(settingsUrl),
        max: 1,
        connectionTimeoutMillis: 5000,
        ssl: { rejectUnauthorized: true },
      });
      const client = await pool.connect();
      try {
        for (const table of ["mias_session_auth", "mias_session_registry", "mias_bot_selections"]) {
          const check = await client.query("SELECT to_regclass($1) AS tbl", [`public.${table}`]);
          if (check.rows[0]?.tbl) {
            await client.query(`TRUNCATE TABLE public.${table} CASCADE`);
          }
        }
        results.settingsDbSessions = true;
      } finally {
        client.release();
      }
    } catch (err) {
      results.settingsDbError = err.message;
    } finally {
      if (pool) { try { await pool.end(); } catch {} }
    }
  }

  // 3. Clean local pairing files and in-memory registry
  try {
    if (fs.existsSync(PAIRING_DIR)) {
      const entries = fs.readdirSync(PAIRING_DIR);
      for (const entry of entries) {
        const p = path.join(PAIRING_DIR, entry);
        try {
          if (fs.lstatSync(p).isDirectory()) {
            _delDir(p);
          } else {
            fs.unlinkSync(p);
          }
        } catch {}
      }
    }
    registry.clear();
    registry.flush();
    results.localSessions = true;
  } catch (err) {
    results.localSessionsError = err.message;
  }

  _dbStatusCache.checkedAt = 0;
  return results;
}

app.post("/api/admin/database/clean-all", async (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ ok: false, error: "Unauthorized" });
    try {
        const results = await cleanAllDatabases();
        logger.warn("admin", `Admin cleaned all databases: ${JSON.stringify(results)}`);
        res.json({ ok: true, message: "All databases and sessions cleaned successfully.", details: results });
    } catch (err) {
        logger.error("admin", `Clean all databases failed: ${err.message}`);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ── Admin: login / logout (password only) ──────────────────────────────────────
app.post("/api/admin/login", rateLimit(60000,10), (req,res) => {
    const {password}=req.body;
    if (!password || password !== ADMIN_PASSWORD) {
        logger.warn("admin",`Failed login from ${req.ip}`);
        return res.status(401).json({ok:false,error:"Wrong password."});
    }
    const token=genToken();
    adminSessions.set(token,{createdAt:Date.now(),ip:req.ip});
    logger.log("admin",`Admin login from ${req.ip}`);
    return res.json({ok:true,token});
});
app.post('/api/admin/logout',(req,res)=>{ const t=req.headers['x-admin-token'];if(t)adminSessions.delete(t);res.json({ok:true}); });

// ── Admin: SSE log stream ─────────────────────────────────────────────────────
app.get('/api/admin/logs/stream', (req,res) => {
    if (!isAdmin(req)) return res.status(403).end('Unauthorized');
    res.setHeader('Content-Type','text/event-stream');
    res.setHeader('Cache-Control','no-cache');
    res.setHeader('Connection','keep-alive');
    res.setHeader('X-Accel-Buffering','no');
    res.flushHeaders();
    ['system','pairing','error','admin'].forEach(type=>{
        const lines=logger.readLog(type,30);
        if(lines.length) res.write(`event: bootstrap\ndata: ${JSON.stringify({type,lines})}\n\n`);
    });
    logSseClients.add(res);
    const hb=setInterval(()=>{ try{res.write(': ping\n\n');}catch{clearInterval(hb);logSseClients.delete(res);} },15000);
    req.on('close',()=>{ clearInterval(hb);logSseClients.delete(res); });
});

// ── Admin: bot-status SSE ─────────────────────────────────────────────────────
app.get('/api/bot-status/stream', (req,res) => {
    if (!isAdmin(req)) return res.status(403).end('Unauthorized');
    res.setHeader('Content-Type','text/event-stream');
    res.setHeader('Cache-Control','no-cache');
    res.setHeader('Connection','keep-alive');
    res.setHeader('X-Accel-Buffering','no');
    res.flushHeaders();
    const send=(event,data)=>{ try{res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);}catch{} };
    const sendState=()=>{
        const running=(_launcher?_launcher.listAll():[]).map(r=>({...r,botStatus:readBotStatus(r.number)}));
        const paired =_pair?_pair.listPairedDevices(false):[];
        send('state',{running,totalPaired:paired.length,ready:_ready,uptime:process.uptime(),memory:process.memoryUsage()});
    };
    sendState();
    const interval=setInterval(sendState,3000);
    const hb=setInterval(()=>{ try{res.write(': ping\n\n');}catch{clearInterval(hb);clearInterval(interval);} },20000);
    req.on('close',()=>{ clearInterval(interval);clearInterval(hb); });
});

// ── Admin: stats ──────────────────────────────────────────────────────────────
app.get('/api/admin/stats', (req,res) => {
    if (!isAdmin(req)) return res.status(403).json({ok:false,error:'Unauthorized'});
    const paired=_pair?_pair.listPairedDevices(false):[];
    const running=_launcher?_launcher.listAll():[];
    const mem=process.memoryUsage(), cpu=os.loadavg();
    const analytics=registry.getAnalytics();
    res.json({ok:true,totalPaired:paired.length,failed:pairLog.filter(p=>p.status==='failed').length,
        running:running.filter(r=>r.alive).length,paused:running.filter(r=>r.paused).length,
        uptime:process.uptime(),errors:errorLog.length,memory:mem,
        cpu:{load1:cpu[0],load5:cpu[1],load15:cpu[2],cores:os.cpus().length},
        os:{freemem:os.freemem(),totalmem:os.totalmem(),platform:os.platform()},
        analytics,serverReady:_ready});
});

// ── Admin: users ──────────────────────────────────────────────────────────────
app.get('/api/admin/users', (req,res) => {
    if (!isAdmin(req)) return res.status(403).json({ok:false,error:'Unauthorized'});
    const paired=_pair?_pair.listPairedDevices(false):[];
    const running=_launcher?_launcher.listAll():[];
    const runMap={}; running.forEach(r=>{runMap[r.number]=r;});
    const users=paired.map(jid=>{
        const number=jid.replace('@s.whatsapp.net',''),
              log=pairLog.find(p=>p.number===jid)||pairLog.find(p=>p.number===number),
              r=runMap[jid]||runMap[number],
              reg=registry.get(jid);
        return{jid,number,paired:true,running:r?r.alive:false,paused:r?r.paused:false,
               pid:r?.pid||null,uptimeMs:r?.uptimeMs||null,restarts:r?.restarts||0,
               pairedAt:log?.timestamp||reg?.pairedAt||null,source:reg?.source||log?.source||'web',
               status:reg?.status||(r?.paused?'paused':r?.alive?'connected':'disconnected'),
               botStatus:readBotStatus(number)};
    });
    res.json({ok:true,users});
});

// ── Admin: pause / resume bot ─────────────────────────────────────────────────
app.post('/api/admin/pause/:jid', async (req,res) => {
    if (!isAdmin(req)) return res.status(403).json({ok:false,error:'Unauthorized'});
    if (!_launcher)    return res.status(503).json({ok:false,error:'Launcher not ready.'});
    const rawJid=decodeURIComponent(req.params.jid);
    const digits = String(rawJid).split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
    const canonicalJid = `${digits}@s.whatsapp.net`;
    const ok=_launcher.pause(canonicalJid);
    if (digits && digits !== canonicalJid) _launcher.pause(digits);
    registry.updateStatus(canonicalJid,'paused');
    const row = registry.get(canonicalJid);
    if (row) row.paused = true;
    registry.flush?.();
    logger.log('admin',`Bot paused: ${canonicalJid}`);
    res.json({ok:true,paused:true,jid:canonicalJid,message:ok?'Bot paused.':'Bot was not running (now flagged paused).'});
});

app.post('/api/admin/resume/:jid', async (req,res) => {
    if (!isAdmin(req)) return res.status(403).json({ok:false,error:'Unauthorized'});
    if (!_launcher)    return res.status(503).json({ok:false,error:'Launcher not ready.'});
    const rawJid=decodeURIComponent(req.params.jid);
    const digits = String(rawJid).split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
    const canonicalJid = `${digits}@s.whatsapp.net`;
    try {
        const ok=await _launcher.resume(canonicalJid);
        registry.updateStatus(canonicalJid,'connected');
        const row = registry.get(canonicalJid);
        if (row) row.paused = false;
        registry.flush?.();
        logger.log('admin',`Bot resumed: ${canonicalJid}`);
        res.json({ok:true,resumed:ok,jid:canonicalJid,message:ok?'Bot resumed.':'Could not find session to resume.'});
    } catch(e) { res.status(500).json({ok:false,error:e.message}); }
});

// ── Admin: restart ────────────────────────────────────────────────────────────
app.post('/api/admin/restart/:jid', async (req,res) => {
    if (!isAdmin(req)) return res.status(403).json({ok:false,error:'Unauthorized'});
    if (!_launcher)    return res.status(503).json({ok:false,error:'Launcher not ready.'});
    const rawJid=decodeURIComponent(req.params.jid);
    const digits = String(rawJid).split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
    const canonicalJid = `${digits}@s.whatsapp.net`;
    const _prevErr = _launcher.lastError ? _launcher.lastError(canonicalJid) : null;
    try { const ok=await _launcher.restart(canonicalJid); res.json({ok,message:ok?`Restarted ${canonicalJid} (saved session kept).`:( _prevErr?`Startup failed: ${_prevErr.message}`:'No saved session for this number — pair it first.')}); }
    catch(e){ res.status(500).json({ok:false,error:e.message}); }
});

// ── Admin: delete user ────────────────────────────────────────────────────────
app.delete('/api/admin/user/:jid', async (req,res) => {
    if (!isAdmin(req)) return res.status(403).json({ok:false,error:'Unauthorized'});
    const rawJid = decodeURIComponent(req.params.jid);
    const digits = String(rawJid).split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
    const canonicalJid = `${digits}@s.whatsapp.net`;
    const num = digits || rawJid;

    logger.log('admin', `Admin deleting session: ${canonicalJid} (${num})`);

    // 1. Stop child process completely
    if (_launcher) {
        try { _launcher.cancelRestart?.(canonicalJid); } catch {}
        try { await _launcher.stopForReset(canonicalJid); } catch (err) {
            console.warn(`[admin:delete] stopForReset warning:`, err?.message);
        }
        if (digits && digits !== canonicalJid) {
            try { _launcher.cancelRestart?.(digits); } catch {}
            try { await _launcher.stopForReset(digits); } catch {}
        }
    }

    // 2. Clear registry
    try {
        registry.unregister(canonicalJid);
        if (digits) registry.unregister(digits);
        registry.flush?.();
    } catch {}

    // 3. Clear selection store
    try { _selectionStore?.clearSelection(canonicalJid); } catch {}
    try { _selectionStore?.clearSelection(digits); } catch {}
    try { _selectionStore?.clearPending?.(canonicalJid); } catch {}
    try { _selectionStore?.clearPending?.(digits); } catch {}

    // 4. Unpair in _pair (handles socket retirement and session persistence purge)
    try {
        if (_pair?.unpairSession) {
            await _pair.unpairSession(canonicalJid, { force: true });
        }
    } catch (error) {
        console.warn(`[admin:delete] _pair.unpairSession warning:`, error.message);
    }

    // 5. Purge via sessionPersistence directly (force: true ensures disk cleanup even if DB is offline)
    try {
        const sessionPersistence = require('./mias/sessionPersistence.cjs');
        await sessionPersistence.deleteSessionCompletely({
            jid: canonicalJid,
            number: digits,
            reason: 'admin_delete',
            force: true
        });
    } catch (err) {
        console.warn(`[admin:delete] deleteSessionCompletely warning:`, err?.message);
    }

    // 6. Delete directory files on disk for both JID and digits using canonical paths
    let sessionPathsMod = null;
    try { sessionPathsMod = require('./sessionPaths'); } catch {}
    const sessionDirCanonical = sessionPathsMod ? sessionPathsMod.sessionDirFor(canonicalJid) : null;
    const sessionDirDigits = (sessionPathsMod && digits) ? sessionPathsMod.sessionDirFor(digits) : null;

    const dirsToClean = [
        path.join(PAIRING_DIR, canonicalJid),
        path.join(PAIRING_DIR, digits),
        sessionDirCanonical,
        sessionDirDigits,
        path.join(NEXSTORE_DIR, 'pairing', canonicalJid),
        path.join(NEXSTORE_DIR, 'pairing', digits)
    ].filter(Boolean);

    for (const d of dirsToClean) {
        try { if (fs.existsSync(d)) _delDir(d); } catch {}
    }

    const filesToClean = [
        path.join(PAIRING_DIR, `${digits}.code.json`),
        path.join(PAIRING_DIR, `${canonicalJid}.code.json`),
        path.join(PAIRING_DIR, `${digits}.qr.json`),
        path.join(PAIRING_DIR, `${canonicalJid}.qr.json`),
        path.join(NEXSTORE_DIR, 'bot_status', `${digits}.json`),
        path.join(NEXSTORE_DIR, 'bot_status', `${canonicalJid}.json`),
        path.join(NEXSTORE_DIR, `pairing_code_${digits}.json`),
        path.join(NEXSTORE_DIR, `pairing_code_${canonicalJid}.json`),
        path.join(NEXSTORE_DIR, `pairing_qr_${digits}.json`),
        path.join(NEXSTORE_DIR, `pairing_qr_${canonicalJid}.json`)
    ];
    for (const f of filesToClean) {
        try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {}
    }

    // 7. Clear launcher in-memory and on-disk paused state so it does not linger as 'paused'
    if (_launcher) {
        try { _launcher.clearPaused?.(canonicalJid); } catch {}
        if (digits && digits !== canonicalJid) {
            try { _launcher.clearPaused?.(digits); } catch {}
        }
    }

    // 8. Update pairLog and PAIR_FILE ALWAYS
    pairLog = pairLog.filter(p => {
        const pNum = String(p?.number || '').replace(/[^0-9]/g, '');
        return pNum && pNum !== digits;
    });
    writeJson(PAIR_FILE, pairLog);

    logger.log('admin', `Deleted: ${canonicalJid} (${num})`);
    return res.json({ ok: true, message: `Session for ${num} deleted completely.` });
});

// ── Admin: errors / logs / analytics ─────────────────────────────────────────
app.get('/api/admin/errors',    (req,res)=>{ if(!isAdmin(req))return res.status(403).json({ok:false,error:'Unauthorized'}); res.json({ok:true,errors:errorLog.slice(0,parseInt(req.query.limit)||100)}); });
app.delete('/api/admin/errors', (req,res)=>{ if(!isAdmin(req))return res.status(403).json({ok:false,error:'Unauthorized'}); errorLog=[];writeJson(ERROR_FILE,errorLog);res.json({ok:true}); });
app.get('/api/admin/pairlog',   (req,res)=>{ if(!isAdmin(req))return res.status(403).json({ok:false,error:'Unauthorized'}); res.json({ok:true,log:pairLog.slice(0,200)}); });
app.get('/api/admin/sessions',  (req,res)=>{ if(!isAdmin(req))return res.status(403).json({ok:false,error:'Unauthorized'}); const{source}=req.query;res.json({ok:true,sessions:source?registry.getBySource(source):registry.getAll()}); });
app.get('/api/admin/logs', (req,res)=>{
    if(!isAdmin(req))return res.status(403).json({ok:false,error:'Unauthorized'});
    const type=['system','pairing','error','admin'].includes(req.query.type)?req.query.type:'system';
    res.json({ok:true,logs:logger.readLog(type,parseInt(req.query.limit)||100),type});
});
app.post('/api/admin/cache/clear-logs',(req,res)=>{ if(!isAdmin(req))return res.status(403).json({ok:false,error:'Unauthorized'}); ['system','pairing','error','admin'].forEach(t=>logger.clearLog(t));res.json({ok:true}); });

app.get('/api/admin/analytics', (req,res) => {
    if (!isAdmin(req)) return res.status(403).json({ok:false,error:'Unauthorized'});
    const analytics=registry.getAnalytics(), now=Date.now(), histogram={};
    for(let i=29;i>=0;i--){const d=new Date(now-i*86400000),k=d.toISOString().slice(0,10);histogram[k]={web:0,telegram:0,failed:0};}
    for(const p of pairLog){if(!p.timestamp)continue;const k=p.timestamp.slice(0,10);if(!histogram[k])continue;if(p.status==='failed')histogram[k].failed++;else if(p.source==='telegram')histogram[k].telegram++;else histogram[k].web++;}
    res.json({ok:true,analytics,histogram,failureRate:pairLog.length?((pairLog.filter(p=>p.status==='failed').length/pairLog.length)*100).toFixed(1):0});
});

app.get('/api/admin/system', async (req,res) => {
    if (!isAdmin(req)) return res.status(403).json({ok:false,error:'Unauthorized'});
    const mem=process.memoryUsage(),cpu=os.loadavg(),running=_launcher?_launcher.listAll():[];
    const dbStatus = await checkDbStatus();
    res.json({ok:true,uptime:process.uptime(),nodeVersion:process.version,
        memory:{heapUsedMb:(mem.heapUsed/1048576).toFixed(1),heapTotalMb:(mem.heapTotal/1048576).toFixed(1),rssMb:(mem.rss/1048576).toFixed(1),freeMemMb:(os.freemem()/1048576).toFixed(1),totalMemMb:(os.totalmem()/1048576).toFixed(1)},
        cpu:{load1:cpu[0].toFixed(2),load5:cpu[1].toFixed(2),load15:cpu[2].toFixed(2),cores:os.cpus().length},
        storage:{nexstoreKb:Math.round(_getDirSize(NEXSTORE)/1024)},
        processes:{activeInstances:running.filter(r=>r.alive).length,pausedInstances:running.filter(r=>r.paused).length,pids:running.filter(r=>r.alive).map(r=>r.pid)},
        database: dbStatus,
        volume: { mounted: dbStatus.volumeMounted, root: _sessionPaths ? _sessionPaths.nexstoreRoot() : '/app/nexstore' },
        serverReady:_ready});
});

app.post('/api/admin/reconnect-failed', async (req,res) => {
    if (!isAdmin(req)) return res.status(403).json({ok:false,error:'Unauthorized'});
    if (!_pair||!_launcher) return res.status(503).json({ok:false,error:'Modules not ready.'});
    const paired=_pair.listPairedDevices(false), runSet=new Set(_launcher.list().map(r=>r.number));
    const dead=paired.filter(j=>!runSet.has(j)&&!_launcher.isPaused(j)); let count=0;
    for(const jid of dead){try{const sd=path.join(PAIRING_DIR,jid);if(fs.existsSync(path.join(sd,'creds.json'))){await _launcher.launch(jid,sd);count++;await _sleep(1500);}}catch{}}
    res.json({ok:true,reconnected:count,total:dead.length});
});

app.get('/api/admin/backup', (req,res) => {
    if (!isAdmin(req)) return res.status(403).json({ok:false,error:'Unauthorized'});
    const backup={timestamp:new Date().toISOString(),sessions:registry.getAll(),pairLog:pairLog.slice(0,500),errorLog:errorLog.slice(0,200)};
    res.setHeader('Content-Type','application/json');
    res.setHeader('Content-Disposition',`attachment; filename="mais-backup-${Date.now()}.json"`);
    res.send(JSON.stringify(backup,null,2));
});

// ── Admin: settings ────────────────────────────────────────────────────────
app.get('/api/admin/settings', (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ok:false,error:'Unauthorized'});
    res.json({
        ok: true,
        sessionDir: process.env.SESSION_DIR || '/app/nexstore',
        creatorUsername: process.env.CREATOR_USERNAME || 'precious125588',
        nodeVersion: process.version,
        platform: process.platform,
        uptime: process.uptime()
    });
});

app.get('/admin', (_,res) => {
    const f=path.join(__dirname,'public','admin.html');
    if(fs.existsSync(f)) res.sendFile(f); else res.status(404).send('Admin panel not found.');
});

app.use((_,res) => res.status(404).json({ok:false,error:'Not found'}));

// ═════════════════════════════════════════════════════════════════════════════
// STARTUP — bind PORT immediately, then lazy-load heavy modules
// ═════════════════════════════════════════════════════════════════════════════
const httpServer = app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 MAIS MDX listening on 0.0.0.0:${PORT}`);
    setImmediate(async () => {
        try { require('./setting/config'); console.log('✓ Config'); } catch(e){ console.error('✗ Config:',e.message); }
        try { _launcher=require('./mais_launcher'); console.log('✓ Launcher'); } catch(e){ console.error('✗ Launcher:',e.message); }
        try {
            _pair = require('./pair');
            if (_pair?.pairEvents) {
                _pair.pairEvents.on('event', ({ jid, event, data }) => {
                    try { broadcastPairingEvent(jid, event, data); } catch {}
                });
            }
            console.log('✓ Pair module');
        } catch(e) { console.error('✗ Pair:', e.message); }
        _ready=true;
        logger.log('system',`Server started port=${PORT} pair=${!!_pair} launcher=${!!_launcher}`);
        checkDbStatus(true).then(dbStatus => {
            const stgMsg = dbStatus.settingsDb.attached ? `Attached (${dbStatus.settingsDb.database})` : (dbStatus.settingsDb.status === 'error' ? 'Error' : 'Not Attached');
            const sessMsg = dbStatus.sessionDb.attached ? `Attached (${dbStatus.sessionDb.database} • ${dbStatus.sessionDb.sessionsInDb || 0} sessions)` : (dbStatus.sessionDb.status === 'error' ? 'Error' : 'Not Attached');
            console.log(`[DB] Settings Database : ${stgMsg}`);
            console.log(`[DB] Session Database  : ${sessMsg}`);
            logger.log('system', `Settings DB: ${stgMsg} | Session DB: ${sessMsg}`);
        }).catch(() => {});
        console.log('✅ Server READY\n');
        
        setTimeout(()=>_autoLoadPairs(),6000);
    });
});

httpServer.on('error',e=>{ console.error('[HTTP server error]',e.message,' — staying alive, will retry'); if(e.code==='EADDRINUSE'){ setTimeout(()=>httpServer.listen(PORT,'0.0.0.0'),3000); } });

async function _autoLoadPairs() {
    if (!_pair||!_launcher) return;
    try {
        // Restore sessions from Neon Database first if configured (survives redeploy/container restart)
        try {
            const sessionPersistence = require("./mias/sessionPersistence.cjs");
            await sessionPersistence.restoreAllSessionsFromDb(PAIRING_DIR);
        } catch (e) {
            console.warn("[AutoLoad] Neon session restore skipped:", e.message);
        }
        const paired=_pair.listPairedDevices(false);
        let launched=0;
        for(const jid of paired){
            if(_launcher.isPaused(jid)) continue;
            const sd=path.join(PAIRING_DIR,jid);
            if(!fs.existsSync(path.join(sd,'creds.json'))) continue;
            try {
                if(!_launcher.list().find(r=>r.number===jid&&r.alive)){
                    await _launcher.launch(jid,sd);registry.updateStatus(jid,'connecting');launched++;await _sleep(2000);
                }
            } catch(e){ registry.updateStatus(jid,'disconnected'); }
        }
        logger.log('system',`AutoLoad: ${launched}/${paired.length} started`);
    } catch(e){ console.error('[AutoLoad]',e.message); }
}

// ── Scheduled restart: once every SCHEDULED_RESTART_HOURS (default 48) ───────
// Long uptime slowly degrades the free tier. The restart waits for a quiet
// window (no bot output for 15 minutes, no open pairing screen, no launch in
// progress) so an active download is never cut off. If the window never opens,
// it is forced 3 hours later. Exit code 1 makes Railway's ON_FAILURE policy
// start the service again; the paired bots relaunch from disk on boot.
const SCHEDULED_RESTART_HOURS = Number(process.env.SCHEDULED_RESTART_HOURS ?? 48);
if (SCHEDULED_RESTART_HOURS > 0) {
    const RESTART_AFTER_MS = SCHEDULED_RESTART_HOURS * 3600 * 1000;
    const FORCE_AFTER_MS = RESTART_AFTER_MS + 3 * 3600 * 1000;
    const QUIET_WINDOW_MS = 15 * 60 * 1000;
    let _restartPending = false;
    setInterval(() => {
        if (_restartPending) return;
        const uptimeMs = process.uptime() * 1000;
        if (uptimeMs < RESTART_AFTER_MS) return;
        const forced = uptimeMs >= FORCE_AFTER_MS;
        const quiet = !_launcher || (Date.now() - _launcher.lastActivityAt()) >= QUIET_WINDOW_MS;
        const busy = pairingSseMap.size > 0 || (_launcher ? _launcher.launchesInFlight() > 0 : false);
        if (!forced && (!quiet || busy)) return;
        _restartPending = true;
        console.log(`🔁 Scheduled restart after ${SCHEDULED_RESTART_HOURS}h uptime (${forced ? 'forced' : 'quiet window'}).`);
        try { logger.log('system', `Scheduled restart (${forced ? 'forced' : 'quiet window'}) after ${SCHEDULED_RESTART_HOURS}h`); } catch {}
        try { registry.flush(); } catch {}
        void shutdownServer(1);
    }, 60 * 1000);
}

let serverShutdown = null;
function shutdownServer(exitCode = 0) {
    if (serverShutdown) return serverShutdown;
    serverShutdown = (async () => {
        const deadline = setTimeout(() => process.exit(1), 25000);
        deadline.unref?.();
        registry.flush();
        await _pair?.shutdownPairing?.();
        await _launcher?.shutdown?.();
        httpServer.close(() => process.exit(exitCode));
        // Active SSE/keepalive HTTP clients must not delay process shutdown.
        httpServer.closeAllConnections?.();
        clearTimeout(deadline);
        process.exit(exitCode);
    })();
    return serverShutdown;
}
require('./lib/crash-shield.cjs').onCleanup(shutdownServer);
process.on('SIGTERM', () => { void shutdownServer(); });
process.on('SIGINT', () => { void shutdownServer(); });
process.on('uncaughtException',e=>{ const msg=safeErrorMessage(e); console.error('[uncaughtException]',msg);logger.error('system','Uncaught: '+msg); });
process.on('unhandledRejection',r=>{ const msg=safeErrorMessage(r); console.error('[unhandledRejection]',msg);logger.error('system','Rejection: '+msg); });
