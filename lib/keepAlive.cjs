'use strict';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * MIAS LITE MDX — Anti-Idle Keep-Alive & Self-Ping Engine
 * ════════════════════════════════════════════════════════════════════════════
 * Prevents containers on free hosting platforms (Render, Railway, Koyeb, etc.)
 * from entering idle sleep / suspension after 15 minutes of inactivity.
 *
 * Why this works:
 * - Render free tier spins down web services after 15 minutes without incoming
 *   HTTP requests to its external ingress router.
 * - By periodically sending an outgoing HTTP GET request to its OWN public URL
 *   every 8 minutes, the request routes through Render's external router,
 *   resetting the 15-minute idle countdown and keeping the bot alive 24/7.
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

  // Railway public domain
  const railwayDomain = (env.RAILWAY_PUBLIC_DOMAIN || env.RAILWAY_STATIC_URL || '').trim();
  if (railwayDomain) {
    return normalizeUrl(railwayDomain);
  }

  // Heroku app URL fallback
  if (env.HEROKU_APP_NAME) {
    return `https://${env.HEROKU_APP_NAME.trim()}.herokuapp.com/api/health`;
  }

  // Koyeb app URL fallback
  if (env.KOYEB_APP_NAME) {
    return `https://${env.KOYEB_APP_NAME.trim()}.koyeb.app/api/health`;
  }

  return null;
}

/**
 * Normalizes URL string into a full https?:// URL with health endpoint path.
 */
function normalizeUrl(rawUrl, defaultPath = '/api/health') {
  let urlStr = String(rawUrl || '').trim();
  if (!urlStr) return null;

  // Add https:// scheme if omitted
  if (!/^https?:\/\//i.test(urlStr)) {
    urlStr = 'https://' + urlStr;
  }

  try {
    const parsed = new URL(urlStr);
    // If no path specified (just domain or /), append default health path
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
 */
function safeHttpGet(targetUrl, timeoutMs = 15000) {
  return new Promise((resolve) => {
    try {
      const urlObj = new URL(targetUrl);
      const isHttps = urlObj.protocol === 'https:';
      const client = isHttps ? https : http;

      const req = client.get(
        targetUrl,
        {
          headers: {
            'User-Agent': 'MIAS-LITE-MDX-KeepAlive/1.0 (+https://github.com/precious125588/MIAS-LITE-MDX)',
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
        req.destroy();
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
 * Execute a single ping round (external URL + local heartbeat).
 */
async function performPing({ port, externalUrl }) {
  _pingCounter++;
  const uptimeStr = formatUptime(process.uptime());

  // 1. External Ping (resets cloud platform idle sleep timer)
  if (externalUrl) {
    try {
      const res = await safeHttpGet(externalUrl);
      if (res.ok) {
        // Routine self-ping 200 OK log silenced to prevent console spam
      } else {
        console.warn(`[KEEP-ALIVE] ⚠️ Self-ping to ${externalUrl} returned ${res.status || res.error || 'unknown'} (uptime: ${uptimeStr})`);
      }
    } catch (err) {
      console.warn(`[KEEP-ALIVE] ⚠️ External ping error: ${err.message}`);
    }
  }

  // 2. Local Heartbeat (verifies internal express loop & port response)
  const localUrl = `http://127.0.0.1:${port}/api/health`;
  try {
    const localRes = await safeHttpGet(localUrl, 5000);
    if (!localRes.ok && !externalUrl) {
      console.warn(`[KEEP-ALIVE] ⚠️ Local health check returned ${localRes.status || localRes.error}`);
    }
  } catch (_) {}
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

  // Interval calculation: default 8 minutes (Render spins down at 15m)
  let intervalMinutes = 8;
  if (process.env.SELF_PING_INTERVAL_MINUTES) {
    const parsed = parseFloat(process.env.SELF_PING_INTERVAL_MINUTES);
    if (!isNaN(parsed) && parsed >= 1 && parsed <= 14) {
      intervalMinutes = parsed;
    }
  }
  let intervalMs = intervalMinutes * 60 * 1000;
  if (process.env.KEEP_ALIVE_INTERVAL_MS) {
    const parsedMs = parseInt(process.env.KEEP_ALIVE_INTERVAL_MS, 10);
    if (!isNaN(parsedMs) && parsedMs >= 60000 && parsedMs <= 840000) {
      intervalMs = parsedMs;
      intervalMinutes = Math.round(intervalMs / 60000);
    }
  }

  console.log('════════════════════════════════════════════════════════════════════');
  console.log('🛡️  MIAS LITE MDX Anti-Idle Keep-Alive Active');
  console.log(`⏱️  Ping Interval : every ${intervalMinutes} minute(s)`);
  if (externalUrl) {
    console.log(`🌐 Target External: ${externalUrl}`);
    console.log('✨ Free-tier idle sleep prevented (Render/Railway/Koyeb)');
  } else {
    console.log(`🏠 Target Local   : http://127.0.0.1:${port}/api/health`);
    console.log('💡 TIP FOR RENDER FREE TIER:');
    console.log('   Set APP_URL or RENDER_EXTERNAL_URL (e.g. https://your-bot.onrender.com)');
    console.log('   so external requests route through Render to prevent 15m idle sleep.');
  }
  console.log('════════════════════════════════════════════════════════════════════');

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
}

module.exports = {
  startKeepAlive,
  stopKeepAlive,
  resolveExternalUrl,
  normalizeUrl,
  performPing,
  safeHttpGet,
};
