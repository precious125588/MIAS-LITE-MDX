'use strict';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * MIAS LITE MDX — Anti-Idle Keep-Alive & Panel Persistence Engine
 * ════════════════════════════════════════════════════════════════════════════
 * Keeps the bot running 24/7 on panel deployments (Optlink, Pterodactyl, BotHost),
 * cloud hosts (Render, Railway, Koyeb, Heroku), and VPS instances.
 * - Anti-idle HTTP pinger (external URL & local health port)
 * - Anti-idle disk heartbeat (.run/panel_heartbeat.json)
 * - V8 heap memory compaction & GC
 * - Stale temporary media cache cleanup (prevents ENOSPC disk-full crashes)
 * - Active event-loop anchor (prevents silent process suspension)
 * ════════════════════════════════════════════════════════════════════════════
 */

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

let _keepAliveTimer = null;
let _eventLoopAnchor = null;
let _pingCounter = 0;
let _lastPingAt = null;
let _lastPingResult = null;

const PANEL_VARS = [
  'OPTLINK',
  'OPTLINK_PANEL',
  'OPTLINK_URL',
  'OPTLINK_EXTERNAL_URL',
  'PTERODACTYL',
  'P_SERVER_UUID',
  'P_SERVER_LOCATION',
  'SERVER_PORT',
  'PANEL_URL',
  'PANEL_EXTERNAL_URL',
  'PANEL_MODE',
  'KEEP_ALIVE_URL',
  'SELF_PING_URL',
];

/**
 * Check if running inside a panel environment (Optlink, Pterodactyl, etc.).
 */
function isPanelEnvironment(env = process.env) {
  return PANEL_VARS.some((v) => {
    const val = String(env[v] ?? '').trim();
    return val !== '' && !/^(0|false|no|off)$/i.test(val);
  });
}

/**
 * Resolve the public external URL of this service.
 * Supports Optlink, Pterodactyl, Render, Railway, Koyeb, Heroku, and custom env variables.
 */
function resolveExternalUrl(env = process.env) {
  const directUrl = (
    env.OPTLINK_URL ||
    env.OPTLINK_EXTERNAL_URL ||
    env.PANEL_URL ||
    env.PANEL_EXTERNAL_URL ||
    env.SELF_PING_URL ||
    env.PING_URL ||
    env.KEEP_ALIVE_URL ||
    env.RENDER_EXTERNAL_URL ||
    env.RENDER_URL ||
    env.APP_URL ||
    env.SERVER_URL ||
    env.PUBLIC_URL ||
    env.BOT_URL ||
    env.URL ||
    env.HOST_URL ||
    env.WEB_URL ||
    env.EXTERNAL_URL ||
    ''
  ).trim();

  if (directUrl) {
    return normalizeUrl(directUrl);
  }

  // Optlink / Panel IP + Port fallback
  if (env.SERVER_IP && (env.PORT || env.SERVER_PORT)) {
    const port = env.PORT || env.SERVER_PORT;
    return 'http://' + env.SERVER_IP.trim() + ':' + port + '/health';
  }

  // Render external hostname
  if (env.RENDER_EXTERNAL_HOSTNAME) {
    return normalizeUrl(env.RENDER_EXTERNAL_HOSTNAME);
  }

  // Railway public domain
  const railwayDomain = (env.RAILWAY_PUBLIC_DOMAIN || env.RAILWAY_STATIC_URL || '').trim();
  if (railwayDomain) {
    return normalizeUrl(railwayDomain);
  }

  // Koyeb public domain & app fallback
  const koyebDomain = (env.KOYEB_PUBLIC_DOMAIN || '').trim();
  if (koyebDomain) {
    return normalizeUrl(koyebDomain);
  }
  if (env.KOYEB_APP_NAME) {
    return 'https://' + env.KOYEB_APP_NAME.trim() + '.koyeb.app/health';
  }

  // Heroku app URL fallback
  if (env.HEROKU_APP_NAME) {
    return 'https://' + env.HEROKU_APP_NAME.trim() + '.herokuapp.com/health';
  }

  return null;
}

/**
 * Normalizes URL string into a full https?:// URL with health endpoint path.
 */
function normalizeUrl(rawUrl, defaultPath = '/health') {
  let urlStr = String(rawUrl || '').trim();
  if (!urlStr) return null;

  if (!/^https?:\/\//i.test(urlStr)) {
    urlStr = 'https://' + urlStr;
  }

  try {
    const parsed = new URL(urlStr);
    if (!parsed.pathname || parsed.pathname === '/') {
      parsed.pathname = defaultPath;
    }
    return parsed.toString();
  } catch {
    return urlStr;
  }
}

/**
 * Format uptime into readable string (e.g. 2h 14m).
 */
function formatUptime(seconds) {
  const s = Math.floor(seconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return d + 'd ' + h + 'h ' + m + 'm';
  if (h > 0) return h + 'h ' + m + 'm';
  return m + 'm ' + (s % 60) + 's';
}

/**
 * Perform a single safe HTTP GET request with a strict timeout.
 * Errors are swallowed quietly to avoid log spam.
 */
function safeHttpGet(targetUrl, timeoutMs = 10000) {
  return new Promise((resolve) => {
    try {
      const urlObj = new URL(targetUrl);
      const isHttps = urlObj.protocol === 'https:';
      const client = isHttps ? https : http;

      const req = client.get(
        targetUrl,
        {
          headers: {
            'User-Agent': 'MIAS-LITE-MDX-KeepAlive/2.0 (+https://github.com/precious125588/MIAS-LITE-MDX)',
            'Accept': 'application/json, text/plain, */*',
            'Cache-Control': 'no-cache',
          },
          timeout: timeoutMs,
        },
        (res) => {
          let data = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            if (data.length < 500) data += chunk;
          });
          res.on('end', () => {
            resolve({
              ok: res.statusCode >= 200 && res.statusCode < 400,
              status: res.statusCode,
              body: data,
            });
          });
        }
      );

      req.on('timeout', () => {
        try { req.destroy(); } catch (_) {}
        resolve({ ok: false, error: 'timeout (' + timeoutMs + 'ms)' });
      });

      req.on('error', (err) => {
        resolve({ ok: false, error: err.message || 'request error' });
      });
    } catch (err) {
      resolve({ ok: false, error: err.message || 'invalid url' });
    }
  });
}

/**
 * Write a disk heartbeat record to .run/panel_heartbeat.json to create active disk I/O,
 * preventing container hypervisors / panel daemons from flagging the container as dormant.
 */
function touchPanelHeartbeat(info = {}) {
  try {
    const runDir = path.join(__dirname, '..', '.run');
    if (!fs.existsSync(runDir)) {
      fs.mkdirSync(runDir, { recursive: true });
    }
    const heartbeatPath = path.join(runDir, 'panel_heartbeat.json');
    const mem = process.memoryUsage();
    const data = {
      timestamp: Date.now(),
      iso: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
      uptimeFormatted: formatUptime(process.uptime()),
      pings: _pingCounter,
      lastPingAt: _lastPingAt,
      memory: {
        rssMB: Math.round(mem.rss / 1048576),
        heapUsedMB: Math.round(mem.heapUsed / 1048576),
        heapTotalMB: Math.round(mem.heapTotal / 1048576),
      },
      panel: isPanelEnvironment(),
      ...info,
    };
    fs.writeFileSync(heartbeatPath, JSON.stringify(data, null, 2), 'utf8');
  } catch (_) {}
}

/**
 * Clean temporary files and media caches older than 30 minutes in os.tmpdir()
 * to prevent disk space exhaustion (ENOSPC) on panel hosts with small disk limits.
 */
function cleanStaleTempFiles() {
  try {
    const tmp = os.tmpdir();
    const now = Date.now();
    const MAX_AGE_MS = 30 * 60 * 1000;
    const prefixPattern = /^(img4k_|imghd_|media-dl-|split-|mias-spot-|mias-tthd-|mias_vthumb_|hd13_src_|p2vt-|miasfmt-|p2ptt-|mias-movie-|ytmp4-|igdl-|apkdl-|aio-apk-|precious_audio_|precious_voice_|cmf_|tomp4-|hd_in_|re_in_|re_out_|p2-dl|tt4k-work|tt-hd-work|tg-|tgstk-|v21aud-|v21vid-|wavid-|v_remux_|v36_|v37_|mais_status_|mias-hd-cmd-)/i;

    const entries = fs.readdirSync(tmp);
    for (const name of entries) {
      if (!prefixPattern.test(name)) continue;
      const fullPath = path.join(tmp, name);
      try {
        const stat = fs.statSync(fullPath);
        if (now - stat.mtimeMs > MAX_AGE_MS) {
          if (stat.isDirectory()) {
            fs.rmSync(fullPath, { recursive: true, force: true });
          } else {
            fs.unlinkSync(fullPath);
          }
        }
      } catch (_) {}
    }
  } catch (_) {}
}

/**
 * Execute a single ping round.
 */
async function performPing({ port, externalUrl }) {
  _pingCounter++;
  _lastPingAt = new Date().toISOString();

  // Periodic memory compaction if V8 expose-gc is active
  if (typeof global.gc === 'function') {
    try { global.gc(); } catch (_) {}
  }

  // 1. External Ping (resets cloud platform / panel idle sleep timer if configured)
  let extResult = null;
  if (externalUrl) {
    try {
      extResult = await safeHttpGet(externalUrl);
    } catch (_) {}
  }

  // 2. Local Heartbeat (verifies internal express loop without warning on failure)
  let localResult = null;
  if (port && port > 0) {
    const localUrl = 'http://127.0.0.1:' + port + '/health';
    try {
      localResult = await safeHttpGet(localUrl, 3000);
      if (!localResult.ok) {
        await safeHttpGet('http://127.0.0.1:' + port + '/ping', 2000);
      }
    } catch (_) {}
  }

  _lastPingResult = {
    external: extResult,
    local: localResult,
  };

  // 3. Touch panel heartbeat file to prove active disk activity to Pterodactyl / Optlink daemon
  touchPanelHeartbeat({
    externalUrl: externalUrl || null,
    port: port || null,
    externalOk: extResult?.ok ?? null,
    localOk: localResult?.ok ?? null,
  });

  // 4. Stale temp files cleanup (every 10 pings = ~20-25 mins)
  if (_pingCounter % 10 === 0) {
    cleanStaleTempFiles();
  }

  // 5. Proactive memory leak guard
  const mem = process.memoryUsage();
  if (mem.rss > 350 * 1024 * 1024) {
    if (typeof global.gc === 'function') {
      try { global.gc(); } catch (_) {}
    }
  }
}

/**
 * Start the keep-alive / anti-idle ping service.
 */
function startKeepAlive(options = {}) {
  // Prevent duplicate instances in the same process
  if (globalThis.__KEEP_ALIVE_ACTIVE__) {
    return { alreadyRunning: true };
  }
  // If parent supervisor process is already running the keep-alive, skip in child
  if (process.env.KEEP_ALIVE_SUPERVISOR_ACTIVE === 'true' && !options.isSupervisor) {
    return { managedBySupervisor: true };
  }
  globalThis.__KEEP_ALIVE_ACTIVE__ = true;

  const port = Number(options.port || process.env.PORT || process.env.SERVER_PORT || 3000);
  const externalUrl = resolveExternalUrl(process.env);
  const isPanel = isPanelEnvironment(process.env);

  // Interval calculation: default 2 minutes on panels (2.5m on others)
  let intervalMinutes = isPanel ? 2.0 : 2.5;
  if (process.env.SELF_PING_INTERVAL_MINUTES) {
    const parsed = parseFloat(process.env.SELF_PING_INTERVAL_MINUTES);
    if (!isNaN(parsed) && parsed >= 0.5 && parsed <= 14) {
      intervalMinutes = parsed;
    }
  }

  // No public URL on Railway/Render: use 12-minute fallback interval
  const onRailwayOrRender = Boolean(process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_ENVIRONMENT || process.env.RENDER);
  if (!externalUrl && onRailwayOrRender && !process.env.SELF_PING_INTERVAL_MINUTES) {
    intervalMinutes = 12;
    console.warn('[KEEP-ALIVE] No public URL found. Generate a Railway domain or set RENDER_URL so the keep-alive ping can reach this service. Using the 12-minute fallback interval.');
  }
  let intervalMs = Math.round(intervalMinutes * 60 * 1000);
  if (process.env.KEEP_ALIVE_INTERVAL_MS) {
    const parsedMs = parseInt(process.env.KEEP_ALIVE_INTERVAL_MS, 10);
    if (!isNaN(parsedMs) && parsedMs >= 15000 && parsedMs <= 840000) {
      intervalMs = parsedMs;
      intervalMinutes = Math.round(intervalMs / 60000 * 10) / 10;
    }
  }

  // Initial heartbeat written immediately
  touchPanelHeartbeat({
    status: 'initializing',
    externalUrl: externalUrl || null,
    port,
  });

  // Initial ping delayed by 15 seconds to allow full server bind
  const initialDelayMs = 15 * 1000;
  const initialTimer = setTimeout(() => {
    void performPing({ port, externalUrl });
  }, initialDelayMs);
  if (typeof initialTimer.unref === 'function') initialTimer.unref();

  // Recurring ping interval
  _keepAliveTimer = setInterval(() => {
    void performPing({ port, externalUrl });
  }, intervalMs);
  if (typeof _keepAliveTimer.unref === 'function') _keepAliveTimer.unref();

  // Active event-loop anchor: keeps Node.js event loop spinning so container daemons don't suspend it
  if (!_eventLoopAnchor) {
    _eventLoopAnchor = setInterval(() => {}, 60000);
  }

  return {
    started: true,
    port,
    externalUrl,
    intervalMinutes,
    intervalMs,
    isPanel,
  };
}

/**
 * Stop keep alive timer (for clean tests or graceful exit).
 */
function stopKeepAlive() {
  if (_keepAliveTimer) {
    clearInterval(_keepAliveTimer);
    _keepAliveTimer = null;
  }
  if (_eventLoopAnchor) {
    clearInterval(_eventLoopAnchor);
    _eventLoopAnchor = null;
  }
  globalThis.__KEEP_ALIVE_ACTIVE__ = false;
  return { stopped: true };
}

/**
 * Retrieve current keep-alive diagnostics.
 */
function getKeepAliveStatus() {
  return {
    active: Boolean(globalThis.__KEEP_ALIVE_ACTIVE__),
    pings: _pingCounter,
    lastPingAt: _lastPingAt,
    lastPingResult: _lastPingResult,
    isPanel: isPanelEnvironment(),
    uptime: Math.floor(process.uptime()),
    uptimeFormatted: formatUptime(process.uptime()),
  };
}

module.exports = {
  startKeepAlive,
  stopKeepAlive,
  resolveExternalUrl,
  normalizeUrl,
  performPing,
  safeHttpGet,
  isPanelEnvironment,
  touchPanelHeartbeat,
  cleanStaleTempFiles,
  getKeepAliveStatus,
};
