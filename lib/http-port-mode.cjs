'use strict';
/* ── HTTP PORT MODE ───────────────────────────────────────────────────────────
   The bot's web server (health page and keep-alive target) only needs a fixed
   port on hosts that route traffic to it: Railway, Render and Koyeb.
   Panels do not need it, so there the server is kept off the shared port:
   it binds 127.0.0.1 on a random free port, which nothing else can collide with
   and nothing outside the host can reach.

   BOT_HTTP_SERVER=on | off | auto   (default auto: on only on a detected deploy host)
   ──────────────────────────────────────────────────────────────────────────── */

const net = require('node:net');

const PRELOAD_PATH = __filename;
const LOOPBACK = '127.0.0.1';
const DEPLOY_HOST_VARS = [
  'RAILWAY_ENVIRONMENT', 'RAILWAY_PROJECT_ID', 'RAILWAY_SERVICE_ID',
  'RENDER', 'RENDER_SERVICE_ID',
  'KOYEB_APP_NAME', 'KOYEB_SERVICE_NAME', 'KOYEB_DEPLOYMENT_ID',
];

function isSet(value) {
  const text = String(value ?? '').trim();
  return text !== '' && !/^(0|false|no|off)$/i.test(text);
}

function resolveHttpServerMode(env = process.env) {
  const setting = String(env.BOT_HTTP_SERVER || 'auto').trim().toLowerCase();
  const onDeployHost = DEPLOY_HOST_VARS.some((name) => isSet(env[name]));
  let enabled;
  let reason;
  if (setting === 'on') { enabled = true; reason = 'BOT_HTTP_SERVER=on'; }
  else if (setting === 'off') { enabled = false; reason = 'BOT_HTTP_SERVER=off'; }
  else {
    enabled = onDeployHost;
    reason = onDeployHost ? 'deploy host detected' : 'no deploy host detected (panel)';
  }
  const parsed = Number(env.PORT);
  const port = Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : 3000;
  return { enabled, port, reason, preloadPath: PRELOAD_PATH };
}

/* Rewrites a listen() call so it binds 127.0.0.1 on a random port.
   Unix socket paths and pipes are left untouched. */
function loopbackArgs(args) {
  const first = args[0];
  if (typeof first === 'string' && !/^\d+$/.test(first)) return args;
  if (first && typeof first === 'object' && first.path !== undefined) return args;
  const cb = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
  const options = { port: 0, host: LOOPBACK };
  return cb ? [options, cb] : [options];
}

let applied = false;
function applyLoopbackOnly() {
  if (applied) return false;
  applied = true;
  const original = net.Server.prototype.listen;
  net.Server.prototype.listen = function loopbackListen(...args) {
    return original.apply(this, loopbackArgs(args));
  };
  return true;
}

// Loaded as a preload (node -r) in the bot's child process only.
if (process.env.BOT_HTTP_SERVER_OFF === 'true') applyLoopbackOnly();

module.exports = {
  resolveHttpServerMode,
  loopbackArgs,
  applyLoopbackOnly,
  PRELOAD_PATH,
  DEPLOY_HOST_VARS,
};
