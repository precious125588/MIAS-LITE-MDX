'use strict';
/* ── BUILD SYNC VERIFIER (v36) ────────────────────────────────────────────────
   Truthful "new code" check. It NEVER claims an update was applied unless the
   code actually changed on disk and was verified.

   What it does:
     1. Fetches the remote default-branch HEAD SHA from the GitHub API
        (source of truth — works on Docker/Railway where the clone has no .git).
     2. Reads the LOCAL deployed SHA from lib/precious-build-stamp.json
        (written by scripts/write-build-stamp.cjs at build time) — falling back
        to .git/HEAD if this checkout has one.
     3. Compares them and logs ONE honest verdict:
          [BUILD-SYNC] ✅ APPLIED  — running the latest code (sha …)
          [BUILD-SYNC] ⚠️ STALE    — new code exists on GitHub but is NOT in this
                                      running build. Redeploy/restart to apply it.
          [BUILD-SYNC] ❓ UNKNOWN  — could not verify (offline / no stamp / no repo
                                      ref). The check FAILED — not assumed applied.
     It also prints the mismatch reason, so the log always tells the truth.

   Env:
     REPO_SLUG      e.g. "precious125588/Mais-project-"   (required for remote check)
     REPO_BRANCH    default "main"
     GITHUB_TOKEN   optional — raises the unauthenticated API rate limit
     BUILD_SYNC=off disables the check entirely.                            */

const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.join(__dirname, '..');

function log(line) { try { console.log(line); } catch (_) {} }

function readLocalSha() {
  // 0) platform environment variable (Railway, GitHub Actions, Render)
  const envSha = process.env.RAILWAY_GIT_COMMIT_SHA || process.env.COMMIT_SHA || process.env.GIT_COMMIT_SHA || process.env.SOURCE_COMMIT;
  if (envSha && /^[0-9a-f]{7,40}$/i.test(String(envSha).trim())) {
    return { sha: String(envSha).trim(), source: 'env' };
  }
  // 1) build stamp written at image-build time (most truthful for a container)
  try {
    const stamp = JSON.parse(fs.readFileSync(path.join(ROOT, 'lib', 'precious-build-stamp.json'), 'utf8'));
    const sha = stamp.sha || stamp.commit || stamp.buildSha || stamp.gitSha || null;
    if (sha && /^[0-9a-f]{7,40}$/i.test(String(sha))) return { sha: String(sha), source: 'build-stamp' };
    if (stamp.buildId && /^[0-9a-f]{7,40}$/i.test(String(stamp.buildId))) return { sha: String(stamp.buildId), source: 'build-stamp' };
  } catch (_) {}
  // 2) .git checkout (works when the repo was git-cloned onto a VPS/panel)
  try {
    const head = fs.readFileSync(path.join(ROOT, '.git', 'HEAD'), 'utf8').trim();
    if (head.startsWith('ref:')) {
      const ref = head.slice(4).trim();
      const sha = fs.readFileSync(path.join(ROOT, '.git', ref), 'utf8').trim();
      if (/^[0-9a-f]{7,40}$/i.test(sha)) return { sha, source: '.git' };
    } else if (/^[0-9a-f]{7,40}$/i.test(head)) {
      return { sha: head, source: '.git' };
    }
  } catch (_) {}
  return { sha: null, source: 'none' };
}

function fetchRemoteSha(slug, branch, token) {
  return new Promise((resolve) => {
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
}

async function check(opts) {
  opts = opts || {};
  if (String(process.env.BUILD_SYNC || '').toLowerCase() === 'off') return;
  const slug = process.env.REPO_SLUG || opts.slug || 'precious125588/Mais-project-';
  const branch = process.env.REPO_BRANCH || 'main';

  const local = readLocalSha();
  const remote = await fetchRemoteSha(slug, branch, process.env.GITHUB_TOKEN || null);

  log('[BUILD-SYNC] ─── new-code check ───');
  log(`[BUILD-SYNC] local  : ${local.sha ? local.sha.slice(0, 12) : 'unreadable'} (via ${local.source})`);
  log(`[BUILD-SYNC] remote : ${remote.sha ? remote.sha.slice(0, 12) : 'unreachable' + (remote.error ? ' (' + remote.error + ')' : '')} (github/${slug}@${branch})`);

  if (!remote.sha || !local.sha) {
    // HONEST: we could not verify — say the check FAILED, never claim applied.
    log('[BUILD-SYNC] ❓ UNKNOWN — new-code check FAILED: ' +
        (!remote.sha ? 'GitHub unreachable/offline' : 'no local build SHA found (deploy without build stamp/.git)') +
        '. NOT assuming new code is applied.');
    return { applied: false, verified: false };
  }
  if (remote.sha === local.sha) {
    log('[BUILD-SYNC] ✅ APPLIED — this bot IS running the latest code.');
    return { applied: true, verified: true };
  }
  log('[BUILD-SYNC] ⚠️ STALE — NEW CODE EXISTS ON GITHUB BUT IS NOT IN THIS RUNNING BUILD.');
  log('[BUILD-SYNC] ⚠️ Redeploy/restart to pull ' + remote.sha.slice(0, 12) +
      ' — until then the bot is on OLD code (' + local.sha.slice(0, 12) + ').');
  return { applied: false, verified: true };
}

module.exports = { check, readLocalSha };
