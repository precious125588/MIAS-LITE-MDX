'use strict';
/* ── AUTO-UPDATE WATCH ────────────────────────────────────────────────────────
   Keeps the running bot on the latest code from GitHub without a manual restart.

   Every AUTO_UPDATE_INTERVAL_MINUTES (default 10) it asks GitHub for the head of
   the branch. When that is ahead of the code on disk, it waits for a quiet moment
   (no new bot output for 60 seconds, or 30 minutes at most), stops the bot, pulls
   the new code, and the supervisor starts the bot again.

   Off with AUTO_UPDATE_WATCH=off, or when AUTO_PULL=off or BUILD_SYNC=off.
   Test hook: opts.deps replaces the GitHub check, the pull and the clock. */

const build = require('./build-sync.cjs');
const codeUpdater = require('./code-updater.cjs');

const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;
const TICK_MS = 60 * 1000;
const QUIET_MS = 60 * 1000;
const MAX_DEFER_MS = 30 * 60 * 1000;

function isEnabled(env = process.env) {
  const flag = (name) => String(env[name] || '').trim().toLowerCase();
  return flag('AUTO_UPDATE_WATCH') !== 'off' && flag('AUTO_PULL') !== 'off' && flag('BUILD_SYNC') !== 'off';
}

function intervalMs(env = process.env) {
  const minutes = Number(env.AUTO_UPDATE_INTERVAL_MINUTES);
  return Number.isFinite(minutes) && minutes >= 1 ? minutes * 60 * 1000 : DEFAULT_INTERVAL_MS;
}

function startAutoUpdateWatch(opts) {
  const { root, env = process.env, log = () => {}, lastOutputAt, stopChild, gate } = opts;
  const deps = opts.deps || {};
  if (!isEnabled(env)) {
    log('[AUTO-UPDATE] Off (AUTO_UPDATE_WATCH, AUTO_PULL or BUILD_SYNC is off).');
    return { stop() {}, tick: async () => {} };
  }

  const every = intervalMs(env);
  const slug = env.REPO_SLUG || 'precious125588/MIAS-LITE-MDX';
  const branch = env.REPO_BRANCH || 'main';
  const checkRemote = deps.checkRemote || (async () => {
    const local = build.readLocalSha();
    const remote = await build.fetchRemoteSha(slug, branch, env.GITHUB_TOKEN || null);
    if (!remote.sha) return { newer: false };
    const same = Boolean(local.sha) && remote.sha.toLowerCase().startsWith(local.sha.toLowerCase());
    return { newer: !same, sha: remote.sha };
  });
  const pull = deps.pull || (() => codeUpdater.syncLatestCode({ root, env, log }));
  const now = deps.now || Date.now;

  let lastCheckAt = now();
  let pendingSince = 0;
  let pendingSha = '';
  let busy = false;

  async function tick() {
    if (busy || gate.updating) return;
    busy = true;
    try {
      if (!pendingSince) {
        if (now() - lastCheckAt < every) return;
        lastCheckAt = now();
        const found = await checkRemote();
        if (!found.newer) return;
        pendingSince = now();
        pendingSha = found.sha || '';
        log('[AUTO-UPDATE] New code on GitHub' + (pendingSha ? ' (' + pendingSha.slice(0, 12) + ')' : '') + '; updating once the bot is quiet.');
      }
      const quiet = now() - lastOutputAt() >= QUIET_MS;
      const overdue = now() - pendingSince >= MAX_DEFER_MS;
      if (!quiet && !overdue) return;

      gate.updating = true;
      try {
        await stopChild();
        const result = await pull();
        if (result && result.updated) {
          log('[AUTO-UPDATE] Updated to ' + String(result.sha || '').slice(0, 12) + '; starting the bot on the new code.');
        } else {
          log('[AUTO-UPDATE] Pull did not apply (' + ((result && result.reason) || 'unknown') + '); starting the bot on the current code.');
        }
      } finally {
        gate.updating = false;
        pendingSince = 0;
        pendingSha = '';
      }
    } catch (e) {
      log('[AUTO-UPDATE] check skipped: ' + (e && e.message));
    } finally {
      busy = false;
    }
  }

  const timer = setInterval(tick, TICK_MS);
  if (timer.unref) timer.unref();
  return { stop() { clearInterval(timer); }, tick };
}

module.exports = { startAutoUpdateWatch, isEnabled, intervalMs };
