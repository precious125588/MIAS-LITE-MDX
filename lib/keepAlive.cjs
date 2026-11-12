'use strict';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * MIAS LITE MDX — Anti-Idle Keep-Alive & Self-Ping Engine
 * ════════════════════════════════════════════════════════════════════════════
 * Performs an optional external HTTP ping when a public URL is configured.
 * A local heartbeat cannot prevent a hosting provider from suspending a process;
 * services without an external URL simply run quietly without fake keep-alive claims.
 * ════════════════════════════════════════════════════════════════════════════
 */

const http = require('node:http');
const https = require('node:https');

let _keepAliveTimer = null;
let _pingCounter = 0;

/**
 * Resolve the public external URL of this service.
 * Supports Render, Railway, Koyeb, Heroku, and custom env variables.
 */
function resolveExternalUrl(env = process.env) {
  const directUrl = (
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
    ''
  ).trim();

  if (directUrl) {
    return normalizeUrl(directUrl);
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
    return `https://${env.KOYEB_APP_NAME.trim()}.koyeb.app/health`;
  }

  // Heroku app URL fallback
  if (env.HEROKU_APP_NAME) {
    return `https://${env.HEROKU_APP_NAME.trim()}.herokuapp.com/health`;
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
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s % 60}s`;
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
        resolve({ ok: false, error: `timeout (${timeoutMs}ms)` });
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
 * Execute a single ping round. Completely silent.
 */
async function performPing({ port, externalUrl }) {
  _pingCounter++;

  // Periodic memory compaction if V8 expose-gc is active
  if (typeof global.gc === 'function') {
    try { global.gc(); } catch (_) {}
  }

  // 1. External Ping (resets cloud platform idle sleep timer if configured)
  if (externalUrl) {
    try {
      await safeHttpGet(externalUrl);
    } catch (_) {}
  }

  // 2. Local Heartbeat (verifies internal express loop without warning on failure)
  if (port) {
    const localUrl = `http://127.0.0.1:${port}/health`;
    try {
      await safeHttpGet(localUrl, 3000);
    } catch (_) {}
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

  const port = Number(options.port || process.env.PORT || 3000);
  const externalUrl = resolveExternalUrl(process.env);

  // Interval calculation: default 2.5 minutes (prevents cloud container idle freeze)
  let intervalMinutes = 2.5;
  if (process.env.SELF_PING_INTERVAL_MINUTES) {
    const parsed = parseFloat(process.env.SELF_PING_INTERVAL_MINUTES);
    if (!isNaN(parsed) && parsed >= 1 && parsed <= 14) {
      intervalMinutes = parsed;
    }
  }
  // No public URL on Railway/Render: a ping cannot reach the service, so say so
  // clearly and use Prince MDX's 12-minute cadence instead of the default.
  const onRailwayOrRender = Boolean(process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_ENVIRONMENT || process.env.RENDER);
  if (!externalUrl && onRailwayOrRender && !process.env.SELF_PING_INTERVAL_MINUTES) {
    intervalMinutes = 12;
    console.warn('[KEEP-ALIVE] No public URL found. Generate a Railway domain or set RENDER_URL so the keep-alive ping can reach this service. Using the 12-minute fallback interval.');
  }
  let intervalMs = intervalMinutes * 60 * 1000;
  if (process.env.KEEP_ALIVE_INTERVAL_MS) {
    const parsedMs = parseInt(process.env.KEEP_ALIVE_INTERVAL_MS, 10);
    if (!isNaN(parsedMs) && parsedMs >= 30000 && parsedMs <= 840000) {
      intervalMs = parsedMs;
      intervalMinutes = Math.round(intervalMs / 60000);
    }
  }

  // Initial ping delayed by 30 seconds to allow full server bind
  const initialDelayMs = 30 * 1000;
  const initialTimer = setTimeout(() => {
    void performPing({ port, externalUrl });
  }, initialDelayMs);
  if (typeof initialTimer.unref === 'function') initialTimer.unref();

  // Recurring ping interval
  _keepAliveTimer = setInterval(() => {
    void performPing({ port, externalUrl });
  }, intervalMs);
  if (typeof _keepAliveTimer.unref === 'function') _keepAliveTimer.unref();

  return {
    started: true,
    port,
    externalUrl,
    intervalMinutes,
    intervalMs,
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
  globalThis.__KEEP_ALIVE_ACTIVE__ = false;
  return { stopped: true };
}

module.exports = {
  startKeepAlive,
  stopKeepAlive,
  resolveExternalUrl,
  normalizeUrl,
  performPing,
  safeHttpGet,
};
