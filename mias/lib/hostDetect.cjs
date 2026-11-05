'use strict';
/**
 * ══════════════════════════════════════════════════════════════
 *  mias/lib/hostDetect.cjs — Host and Runtime Detection Module
 * ══════════════════════════════════════════════════════════════
 * Detects the hosting environment using reliable environment
 * indicators without crashing when optional variables are absent.
 * Distinguishes confirmed platforms from inferred or unknown.
 */

const os = require('os');

function detectHostEnvironment(env = process.env) {
  if (!env || typeof env !== 'object') env = {};

  // Confirmed platforms via canonical environment variables
  if (env.REPL_ID || env.REPLIT_DB_URL || env.REPL_SLUG) {
    return { platform: 'Replit', confidence: 'confirmed', indicator: 'REPL_ID' };
  }
  if (env.HEROKU_APP_ID || env.HEROKU_DYNO_ID || env.DYNO) {
    return { platform: 'Heroku', confidence: 'confirmed', indicator: 'DYNO' };
  }
  if (env.RAILWAY_ENVIRONMENT || env.RAILWAY_STATIC_URL || env.RAILWAY_PROJECT_ID) {
    return { platform: 'Railway', confidence: 'confirmed', indicator: 'RAILWAY_ENVIRONMENT' };
  }
  if (env.RENDER || env.RENDER_SERVICE_ID || env.RENDER_INSTANCE_ID) {
    return { platform: 'Render', confidence: 'confirmed', indicator: 'RENDER' };
  }
  if (env.KOYEB_APP_NAME || env.KOYEB_SERVICE_ID) {
    return { platform: 'Koyeb', confidence: 'confirmed', indicator: 'KOYEB_SERVICE_ID' };
  }
  if (env.FLY_ALLOC_ID || env.FLY_APP_NAME) {
    return { platform: 'Fly.io', confidence: 'confirmed', indicator: 'FLY_APP_NAME' };
  }
  if (env.VERCEL || env.VERCEL_ENV) {
    return { platform: 'Vercel', confidence: 'confirmed', indicator: 'VERCEL' };
  }
  if (env.NETLIFY || env.NETLIFY_IMAGES_CDN_DOMAIN) {
    return { platform: 'Netlify', confidence: 'confirmed', indicator: 'NETLIFY' };
  }
  if (env.CODESPACES || env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN) {
    return { platform: 'GitHub Codespaces', confidence: 'confirmed', indicator: 'CODESPACES' };
  }
  if (env.GITPOD_WORKSPACE_ID || env.GITPOD_WORKSPACE_URL) {
    return { platform: 'Gitpod', confidence: 'confirmed', indicator: 'GITPOD_WORKSPACE_ID' };
  }
  if (env.CYCLIC_URL || env.CYCLIC_APP_ID) {
    return { platform: 'Cyclic', confidence: 'confirmed', indicator: 'CYCLIC_APP_ID' };
  }
  if (env.TERMUX_VERSION || (typeof env.PREFIX === 'string' && env.PREFIX.includes('com.termux'))) {
    return { platform: 'Termux', confidence: 'confirmed', indicator: 'TERMUX_VERSION' };
  }
  if (env.AWS_LAMBDA_FUNCTION_NAME || env.AWS_EXECUTION_ENV) {
    return { platform: 'AWS Lambda', confidence: 'confirmed', indicator: 'AWS_LAMBDA_FUNCTION_NAME' };
  }
  if (env.K_SERVICE || env.FUNCTION_NAME) {
    return { platform: 'Google Cloud Run/Functions', confidence: 'confirmed', indicator: 'K_SERVICE' };
  }
  if (env.WEBSITE_SITE_NAME || env.APPSETTING_WEBSITE_SITE_NAME) {
    return { platform: 'Azure App Service', confidence: 'confirmed', indicator: 'WEBSITE_SITE_NAME' };
  }
  if (env.ANDROID_ROOT || env.ANDROID_DATA) {
    return { platform: 'Android', confidence: 'inferred', indicator: 'ANDROID_ROOT' };
  }

  // Fallback to OS platform (local development / self-hosted VPS)
  try {
    const p = os.platform();
    if (p === 'linux') return { platform: 'Linux (VPS/Local)', confidence: 'inferred', indicator: 'os.platform' };
    if (p === 'win32') return { platform: 'Windows', confidence: 'inferred', indicator: 'os.platform' };
    if (p === 'darwin') return { platform: 'macOS', confidence: 'inferred', indicator: 'os.platform' };
    if (p) return { platform: p, confidence: 'inferred', indicator: 'os.platform' };
  } catch (_) {}

  return { platform: 'Unknown / Self-hosted', confidence: 'unknown', indicator: 'none' };
}

function getHostName(env) {
  return detectHostEnvironment(env).platform;
}

module.exports = {
  detectHostEnvironment,
  getHostName,
};
