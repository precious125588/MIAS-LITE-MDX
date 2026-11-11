'use strict';
/* ── CODE UPDATER ─────────────────────────────────────────────────────────────
   Brings the running folder up to the latest commit on GitHub BEFORE the bot
   starts, so every start/restart loads the newest code.

   Two modes:
     • Git checkout (.git present): fetch + reset to origin/<branch>.
     • Plain folder (panel or zip upload, no .git): download the archive of the
       exact commit from GitHub, copy its files in, then rewrite
       lib/precious-build-stamp.json so the stale-code guard matches the files.

   Never touched: .git, node_modules, nexstore/, database/, sessions/, .run/,
   tmp/, auth folders, .env*, and any local file that is not in the archive.

   Env: AUTO_PULL=off or BUILD_SYNC=off disables it.
   Test hook: UPDATE_ARCHIVE_FILE=<path to .tar.gz> uses a local archive. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');

const DEFAULT_ROOT = path.join(__dirname, '..');
const STAMP_REL = 'lib/precious-build-stamp.json';
const KEEP = [
  '.git', 'node_modules', 'mias/node_modules', '.run', 'nexstore', 'database',
  'sessions', 'tmp', 'prezzy_auth', 'auth', 'storage', 'logs', 'uploads',
];

function isKept(rel) {
  const norm = String(rel).split(path.sep).join('/').replace(/^\.\//, '');
  if (norm === '.env' || norm.startsWith('.env.')) return true;
  return KEEP.some((k) => norm === k || norm.startsWith(k + '/'));
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function walk(dir, base = dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === '.git') continue;
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(abs, base, out);
    else if (ent.isFile()) out.push(path.relative(base, abs).split(path.sep).join('/'));
  }
  return out;
}

function download(url, dest, { timeoutMs = 120000, redirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    // No token is sent: the archive is public and redirects leave GitHub's host.
    const req = https.get(url, { headers: { 'User-Agent': 'mias-code-updater' }, timeout: timeoutMs }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (redirects <= 0) return reject(new Error('too many redirects'));
        return resolve(download(new URL(res.headers.location, url).href, dest, { timeoutMs, redirects: redirects - 1 }));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(dest)));
      file.on('error', reject);
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('download timed out')));
    req.on('error', reject);
  });
}

function extract(archive, dir) {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('tar', ['-xzf', archive, '-C', dir], { stdio: 'ignore', timeout: 120000 });
  const tops = fs.readdirSync(dir).filter((n) => fs.statSync(path.join(dir, n)).isDirectory());
  if (tops.length !== 1) throw new Error('unexpected archive layout');
  return path.join(dir, tops[0]);
}

function buildId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return 'auto-' + d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) + '-' +
    p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds());
}

// Recomputes stamp hashes from files on disk, so the guard matches what is running.
function rewriteStamp(root, stamp, sha) {
  const next = { ...stamp, buildId: buildId(), builtAt: new Date().toISOString(), sha, commit: sha, files: {} };
  for (const rel of Object.keys(stamp.files || {})) {
    next.files[rel] = sha256(path.join(root, rel));
  }
  fs.writeFileSync(path.join(root, STAMP_REL), JSON.stringify(next, null, 2) + '\n');
  return next;
}

function installDependenciesIfNeeded(root, changed, log) {
  if (!changed.some((f) => f === 'package.json')) return;
  log('[CODE-UPDATE] package.json changed, installing dependencies...');
  const r = spawnSync('bash', ['scripts/robust-install.sh', '.'], { cwd: root, stdio: 'ignore', timeout: 600000 });
  if (r.status !== 0) log('[CODE-UPDATE] dependency install did not finish cleanly; startup continues.');
}

async function syncLatestCode(opts = {}) {
  const root = opts.root || DEFAULT_ROOT;
  const env = opts.env || process.env;
  const log = opts.log || (() => {});
  if (String(env.BUILD_SYNC || '').toLowerCase() === 'off' || String(env.AUTO_PULL || '').toLowerCase() === 'off') {
    return { updated: false, reason: 'disabled' };
  }

  const slug = env.REPO_SLUG || 'precious125588/MIAS-LITE-MDX';
  const branch = env.REPO_BRANCH || 'main';
  const build = require('./build-sync.cjs');
  const local = opts.local || build.readLocalSha();
  const remote = opts.remote || await build.fetchRemoteSha(slug, branch, env.GITHUB_TOKEN || null);

  if (!remote.sha) return { updated: false, reason: 'remote-unknown', detail: remote.error || null };
  if (local.sha && remote.sha.toLowerCase().startsWith(local.sha.toLowerCase())) {
    return { updated: false, reason: 'current', sha: remote.sha };
  }

  if (fs.existsSync(path.join(root, '.git'))) {
    try {
      const gitOpts = { cwd: root, stdio: 'ignore', timeout: 180000 };
      execFileSync('git', ['fetch', 'origin', branch, '--quiet'], gitOpts);
      execFileSync('git', ['reset', '--hard', 'origin/' + branch], gitOpts);
    } catch (e) {
      return { updated: false, reason: 'git-failed', detail: e.message };
    }
    const stampPath = path.join(root, STAMP_REL);
    if (fs.existsSync(stampPath)) {
      rewriteStamp(root, JSON.parse(fs.readFileSync(stampPath, 'utf8')), remote.sha);
    }
    log('[CODE-UPDATE] Updated to ' + remote.sha.slice(0, 12) + ' via git.');
    return { updated: true, via: 'git', sha: remote.sha };
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'code-update-'));
  try {
    const archive = path.join(tmp, 'source.tar.gz');
    if (env.UPDATE_ARCHIVE_FILE) fs.copyFileSync(env.UPDATE_ARCHIVE_FILE, archive);
    else await download(`https://codeload.github.com/${slug}/tar.gz/${remote.sha}`, archive);

    const src = extract(archive, path.join(tmp, 'src'));
    const stamp = JSON.parse(fs.readFileSync(path.join(src, STAMP_REL), 'utf8'));
    const listed = Object.keys(stamp.files || {});
    const missing = listed.filter((rel) => !fs.existsSync(path.join(src, rel)));
    if (missing.length) throw new Error('archive is missing ' + missing.join(', '));

    const changed = [];
    for (const rel of walk(src)) {
      if (rel === STAMP_REL || isKept(rel)) continue;
      const from = path.join(src, rel);
      const to = path.join(root, rel);
      if (fs.existsSync(to) && sha256(to) === sha256(from)) continue;
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
      changed.push(rel);
    }

    for (const rel of stamp.mustNotExist || []) {
      const target = path.join(root, rel);
      if (!isKept(rel) && fs.existsSync(target) && fs.statSync(target).isFile()) fs.unlinkSync(target);
    }

    // Stamp last: it only matches once every file above is in place.
    const next = rewriteStamp(root, stamp, remote.sha);
    installDependenciesIfNeeded(root, changed, log);
    log('[CODE-UPDATE] Updated to ' + remote.sha.slice(0, 12) + ' (' + changed.length + ' files changed).');
    return { updated: true, via: 'archive', sha: remote.sha, changed: changed.length, buildId: next.buildId };
  } catch (e) {
    log('[CODE-UPDATE] Could not update (' + (e && e.message) + '). Starting with the current code.');
    return { updated: false, reason: 'archive-failed', detail: e && e.message };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
}

module.exports = { syncLatestCode, isKept, sha256, walk };

if (require.main === module) {
  syncLatestCode({ log: (line) => console.log(line) })
    .then((r) => console.log('[CODE-UPDATE] result: ' + JSON.stringify(r)))
    .catch((e) => console.warn('[CODE-UPDATE] skipped: ' + (e && e.message)))
    .finally(() => process.exit(0));
}
