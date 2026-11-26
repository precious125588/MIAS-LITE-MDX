'use strict';
/* ── BUILD SYNC VERIFIER (v38) ────────────────────────────────────────────────
   Truthful "new code" check with automatic sync.

   What it does:
     1. Fetches the remote default-branch HEAD SHA from the GitHub API
        (source of truth — works on Docker/Railway where the clone has no .git).
     2. Reads the LOCAL deployed SHA:
        - from .git checkout if present (authoritative for VPS / panel clones)
        - from platform environment variables (Railway, Render, etc.)
        - from lib/precious-build-stamp.json (for Docker image builds)
     3. Compares them and logs verdict:
          [BUILD-SYNC] ✅ APPLIED  — running the latest code (sha …)
          [BUILD-SYNC] 🔄 AUTO-PULL — pulls latest commit from GitHub if behind
          [BUILD-SYNC] ⚠️ STALE    — new code exists on GitHub and auto-pull was
                                      skipped or failed.
          [BUILD-SYNC] ❓ UNKNOWN  — could not verify (offline / unreachable).

   Env:
     REPO_SLUG      e.g. "precious125588/MIAS-LITE-MDX"
     REPO_BRANCH    default "main"
     GITHUB_TOKEN   optional — raises the unauthenticated API rate limit
     AUTO_PULL      default on (set AUTO_PULL=off to disable auto-pull)
     BUILD_SYNC     set BUILD_SYNC=off to disable the check entirely. */

const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.join(__dirname, '..');

function log(line) { try { console.log(line); } catch (_) {} }

function readLocalSha() {
  // 0) .git checkout (if present on disk, this is the authoritative local state)
  try {
    const headPath = path.join(ROOT, '.git', 'HEAD');
    if (fs.existsSync(headPath)) {
      const head = fs.readFileSync(headPath, 'utf8').trim();
      if (head.startsWith('ref:')) {
        const ref = head.slice(4).trim();
        const refPath = path.join(ROOT, '.git', ref);
        if (fs.existsSync(refPath)) {
          const sha = fs.readFileSync(refPath, 'utf8').trim();
          if (/^[0-9a-f]{7,40}$/i.test(sha)) return { sha, source: '.git' };
        }
      } else if (/^[0-9a-f]{7,40}$/i.test(head)) {
        return { sha: head, source: '.git' };
      }
    }
  } catch (_) {}

  // 1) build stamp written at image-build or update time (on Railway/Docker, this reflects
  // the actual files on disk, especially after runtime updates where RAILWAY_GIT_COMMIT_SHA is stale)
  try {
    const stamp = JSON.parse(fs.readFileSync(path.join(ROOT, 'lib', 'precious-build-stamp.json'), 'utf8'));
    const sha = stamp.sha || stamp.commit || stamp.buildSha || stamp.gitSha || null;
    if (sha && /^[0-9a-f]{7,40}$/i.test(String(sha))) return { sha: String(sha), source: 'build-stamp' };
    if (stamp.buildId && /^[0-9a-f]{7,40}$/i.test(String(stamp.buildId))) return { sha: String(stamp.buildId), source: 'build-stamp' };
  } catch (_) {}

  // 2) platform environment variable fallback (Railway, GitHub Actions, Render)
  const envSha = process.env.RAILWAY_GIT_COMMIT_SHA || process.env.COMMIT_SHA || process.env.GIT_COMMIT_SHA || process.env.SOURCE_COMMIT;
  if (envSha && /^[0-9a-f]{7,40}$/i.test(String(envSha).trim())) {
    return { sha: String(envSha).trim(), source: 'env' };
  }

  return { sha: null, source: 'none' };
}

function fetchAtomSha(slug, branch) {
  return new Promise((resolve) => {
    const req = https.get(
      `https://github.com/${slug}/commits/${branch}.atom`,
      { headers: { 'User-Agent': 'mais-build-sync' }, timeout: 8000 },
      (res) => {
        if (res.statusCode !== 200) return resolve(null);
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          const m = body.match(/Commit\/([0-9a-f]{40})/i) || body.match(/\/commit\/([0-9a-f]{40})/i);
          resolve(m ? m[1].toLowerCase() : null);
        });
      }
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

function fetchLsRemoteSha(slug, branch) {
  try {
    const { execSync } = require('child_process');
    const out = execSync(`git ls-remote https://github.com/${slug}.git refs/heads/${branch}`, {
      encoding: 'utf8',
      timeout: 8000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const m = out.match(/^([0-9a-f]{40})/i);
    return m ? m[1].toLowerCase() : null;
  } catch {
    return null;
  }
}

async function fetchRemoteSha(slug, branch, token) {
  token = token || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null;
  const fromRest = await new Promise((resolve) => {
    const req = https.request({
      host: 'api.github.com',
      path: `/repos/${slug}/commits/${encodeURIComponent(branch)}`,
      method: 'GET',
      timeout: 8000,
      headers: {
        'User-Agent': 'mais-build-sync',
        'Accept': 'application/vnd.github+json',
        ...(token ? { 'Authorization': 'Bearer ' + token } : {}),
      },
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve({ sha: null, error: 'HTTP ' + res.statusCode });
        try { resolve({ sha: (JSON.parse(body) || {}).sha || null }); }
        catch (e) { resolve({ sha: null, error: 'bad json' }); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', (e) => resolve({ sha: null, error: e.message }));
    req.end();
  });

  if (fromRest?.sha) return fromRest;

  // Fallback 1: GitHub Atom feed (immune to REST API 60 req/hr 403 rate limits)
  const atomSha = await fetchAtomSha(slug, branch);
  if (atomSha) return { sha: atomSha, source: 'atom-feed' };

  // Fallback 2: git ls-remote (smart HTTP)
  const lsSha = fetchLsRemoteSha(slug, branch);
  if (lsSha) return { sha: lsSha, source: 'git-ls-remote' };

  return fromRest;
}

async function check(opts) {
  opts = opts || {};
  if (String(process.env.BUILD_SYNC || '').toLowerCase() === 'off') return;
  const slug = process.env.REPO_SLUG || opts.slug || 'precious125588/MIAS-LITE-MDX';
  const branch = process.env.REPO_BRANCH || 'main';

  let local = readLocalSha();
  const remote = await fetchRemoteSha(slug, branch, process.env.GITHUB_TOKEN || null);

  log('[BUILD-SYNC] ─── new-code check ───');
  log(`[BUILD-SYNC] local  : ${local.sha ? local.sha.slice(0, 12) : 'unreadable'} (via ${local.source})`);
  log(`[BUILD-SYNC] remote : ${remote.sha ? remote.sha.slice(0, 12) : 'unreachable' + (remote.error ? ' (' + remote.error + ')' : '')} (github/${slug}@${branch})`);

  if (!remote.sha || !local.sha) {
    log('[BUILD-SYNC] ❓ UNKNOWN — new-code check FAILED: ' +
        (!remote.sha ? 'GitHub unreachable/offline' : 'no local build SHA found') +
        '. NOT assuming new code is applied.');
    return { applied: false, verified: false };
  }

  if (remote.sha === local.sha) {
    log('[BUILD-SYNC] ✅ APPLIED — this bot IS running the latest code.');
    return { applied: true, verified: true };
  }

  log('[BUILD-SYNC] ⚠️ STALE — NEW CODE EXISTS ON GITHUB (' + remote.sha.slice(0, 12) + ') vs local (' + local.sha.slice(0, 12) + ').');

  let autoPullSetting = true;
  try {
    const { getSetting } = require('../setting/Settings.js');
    const sVal = getSetting('bot', 'autoUpdate', null);
    if (sVal !== null) autoPullSetting = Boolean(sVal);
  } catch (_) {}

  if (autoPullSetting && String(process.env.AUTO_PULL || '').toLowerCase() !== 'off' && fs.existsSync(path.join(ROOT, '.git'))) {
    log('[BUILD-SYNC] 🔄 Auto-pulling latest changes from GitHub (' + branch + ')...');
    try {
      const { execSync } = require('child_process');
      execSync('git config pull.rebase false', { cwd: ROOT, stdio: 'ignore' });
      execSync(`git fetch origin ${branch} --depth=1 --quiet || git fetch origin ${branch} --quiet`, { cwd: ROOT, stdio: 'ignore' });
      execSync(`git reset --hard origin/${branch} || git pull origin ${branch}`, { cwd: ROOT, stdio: 'ignore' });
      local = readLocalSha();
      if (local.sha === remote.sha) {
        log('[BUILD-SYNC] ✅ APPLIED — successfully pulled latest code (' + remote.sha.slice(0, 12) + ').');
        return { applied: true, verified: true, pulled: true };
      }
    } catch (err) {
      log('[BUILD-SYNC] ⚠️ Auto-pull failed (' + (err && err.message) + ').');
    }
  }

  log('[BUILD-SYNC] ⚠️ Redeploy/restart to pull ' + remote.sha.slice(0, 12) +
      ' — until then the bot is on OLD code (' + local.sha.slice(0, 12) + ').');
  return { applied: false, verified: true };
}

module.exports = { check, readLocalSha, fetchRemoteSha };
