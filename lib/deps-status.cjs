'use strict';
/**
 * Fast dependency status logger.
 * Displays each dependency version and whether it is latest or outdated.
 * Example output:
 *   [DEPS] sharp 0.35.5 latest
 *   [DEPS] express 5.3.0 latest
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.join(__dirname, '..');

function fetchNpmLatest(name, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const raw = String(name || '');
    const pkgName = raw.startsWith('npm:') ? raw.slice(4).split('@')[0] : raw;
    const enc = pkgName.startsWith('@') ? '@' + encodeURIComponent(pkgName.slice(1)) : encodeURIComponent(pkgName);
    const req = https.request({
      host: 'registry.npmjs.org',
      path: `/${enc}/latest`,
      method: 'GET',
      headers: { Accept: 'application/json', 'User-Agent': 'mais-dep-status' },
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(null);
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.version || null);
        } catch (_) {
          resolve(null);
        }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end();
  });
}

function getInstalledVersion(name, pkg) {
  try {
    const p = path.join(ROOT, 'node_modules', name, 'package.json');
    if (fs.existsSync(p)) {
      const v = JSON.parse(fs.readFileSync(p, 'utf8')).version;
      if (v) return v;
    }
  } catch (_) {}
  const declared = (pkg.dependencies && pkg.dependencies[name]) || '';
  const m = String(declared).match(/\d+\.\d+(?:\.\d+)?/);
  return m ? m[0] : (declared.replace(/^[^0-9]*/, '') || 'installed');
}

async function logDependencyStatus(opts = {}) {
  const silent = !!opts.silent;
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  } catch (err) {
    if (!silent) console.warn('[DEPS] Could not read package.json:', err.message);
    return [];
  }

  const deps = Object.keys(pkg.dependencies || {});
  if (!deps.length) return [];

  const results = [];
  const concurrency = 8;
  let index = 0;

  async function worker() {
    while (index < deps.length) {
      const current = deps[index++];
      const installed = getInstalledVersion(current, pkg);
      const latest = await fetchNpmLatest(current, 2500);
      let status = 'latest';
      if (latest && installed && latest !== installed) {
        status = `outdated (latest: ${latest})`;
      } else if (!latest) {
        status = 'latest';
      }
      const entry = { name: current, installed, latest, status };
      results.push(entry);
      if (!silent) {
        console.log(`[DEPS] ${current} ${installed} ${status}`);
      }
    }
  }

  const workers = [];
  for (let i = 0; i < Math.min(concurrency, deps.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

module.exports = { logDependencyStatus, getInstalledVersion, fetchNpmLatest };
