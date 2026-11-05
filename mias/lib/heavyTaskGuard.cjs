// =========================================================================
//  heavyTaskGuard.cjs — bounded concurrency + safe logging for heavy tasks
// ─────────────────────────────────────────────────────────────────────────
//  Why this exists (root cause of "heavy download → bot restarts"):
//  The bot already HAS an out-of-process streaming downloader
//  (downloadWorker.js) and per-operation ffmpeg timeouts. What it did NOT
//  have is a *global* bound on how many heavy operations (video downloads,
//  media conversion, image processing) can run at once. On a memory-capped
//  host (Railway/Replit), N simultaneous downloads each buffering media +
//  a resident session spikes RSS past the cgroup limit → the kernel /
//  platform OOM-kills or health-check-restarts the process. That is the
//  restart the user sees; it is a resource-exhaustion restart, not a JS
//  exception (the existing uncaughtException shields already catch JS).
//
//  This module provides:
//   • a bounded FIFO queue (no unbounded concurrency → no RSS spike)
//   • a timeout + finally-cleanup wrapper so a failed/timed-out heavy task
//     releases its slot, cleans its temp files and leaves the process alive
//   • a startup stability summary (real config, no invented values)
//   • safe [DOWNLOAD]/[MEDIA]/[RECOVERY] logging with no message content
// =========================================================================
'use strict';

const os   = require('os');
const fs   = require('fs');
const path = require('path');

// ── configuration (env overridable; defaults chosen for small containers) ──
const CONCURRENCY = Math.max(1, Number(process.env.HEAVY_TASK_CONCURRENCY || process.env.DOWNLOAD_CONCURRENCY || 2));
const TASK_TIMEOUT_MS = Math.max(10000, Number(process.env.HEAVY_TASK_TIMEOUT_MS || 300000)); // 5 min
const TMP_DIR = process.env.DOWNLOAD_DIR || path.join(os.tmpdir(), 'p2-dl');

// ── bounded FIFO queue ────────────────────────────────────────────────────
const _queue = [];
let _running = 0;
let _done = 0, _failed = 0, _timedOut = 0;

function _pump() {
  while (_running < CONCURRENCY && _queue.length) {
    const job = _queue.shift();
    _running++;
    _execute(job)
      .finally(() => { _running--; setImmediate(_pump); });
  }
}

async function _execute(job) {
  const tag = job.tag || 'TASK';
  let timer = null;
  try {
    const result = await Promise.race([
      Promise.resolve().then(job.fn),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), job.timeoutMs || TASK_TIMEOUT_MS); }),
    ]);
    _done++;
    job.resolve(result);
  } catch (e) {
    _failed++;
    const isTimeout = e && e.message === 'timeout';
    if (isTimeout) _timedOut++;
    // never log message bodies / secrets — only the reason
    try { console.log(`[DOWNLOAD] failed`); } catch {}
    try { console.log(`[DOWNLOAD] reason: ${isTimeout ? 'timeout' : (e && e.message ? String(e.message).slice(0, 160) : 'unknown')}`); } catch {}
    try { job.reject(e); } catch {}
  } finally {
    if (timer) clearTimeout(timer);
    // deterministic temp cleanup for this job (success / failure / timeout)
    if (Array.isArray(job.cleanup)) {
      for (const f of job.cleanup) { try { if (f && /tmp|p2-dl/.test(String(f))) fs.unlinkSync(f); } catch {} }
    }
    try { console.log(`[DOWNLOAD] cleanup: complete (${tag})`); } catch {}
  }
}

/**
 * Run a heavy operation under the global concurrency budget with a timeout.
 * @param {Function} fn      async () => result   — the heavy work
 * @param {Object}   opts    { tag, timeoutMs, cleanup:[paths] }
 * @returns {Promise<any>}   resolves with fn()'s result; rejects on failure
 */
function runHeavy(fn, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    _queue.push({
      fn,
      resolve,
      reject,
      tag: opts.tag || 'heavy',
      timeoutMs: Math.max(1000, Number(opts.timeoutMs || 0)),
      cleanup: Array.isArray(opts.cleanup) ? opts.cleanup : [],
    });
    setImmediate(_pump);
  });
}

/** Non-blocking: is the queue saturated? (caller can decide to shed load) */
function saturated() { return _running >= CONCURRENCY; }

function stats() {
  return {
    concurrency: CONCURRENCY,
    timeoutMs: TASK_TIMEOUT_MS,
    queued: _queue.length,
    inflight: _running,
    completed: _done,
    failed: _failed,
    timedOut: _timedOut,
    tmpDir: TMP_DIR,
  };
}

// ── temp-dir sweeper: remove orphaned download temp files older than 1h ──
let _sweeperStarted = false;
function startSweeper() {
  if (_sweeperStarted) return;
  _sweeperStarted = true;
  const sweep = () => {
    try {
      const cutoff = Date.now() - 60 * 60 * 1000;
      for (const dir of [TMP_DIR]) {
        let files = [];
        try { files = fs.readdirSync(dir); } catch { continue; }
        for (const f of files) {
          try {
            const p = path.join(dir, f);
            const st = fs.statSync(p);
            if (st.isFile() && st.mtimeMs < cutoff && /^(dl_|cmf_)/.test(f)) fs.unlinkSync(p);
          } catch {}
        }
      }
    } catch {}
  };
  const t = setInterval(sweep, 15 * 60 * 1000);
  if (t.unref) t.unref();
  sweep();
}

// ── startup stability summary (real values only) ──────────────────────────
function stabilityLines() {
  return [
    '🛡️ HEAVY-TASK PROTECTION',
    `⚙️ Download concurrency: ${CONCURRENCY}`,
    `💾 Storage: ${TMP_DIR}`,
    '🧹 Temp cleanup: ACTIVE',
  ];
}
function printStabilityBanner() {
  try { console.log(stabilityLines().join('\n')); } catch {}
}

module.exports = { runHeavy, saturated, stats, startSweeper, stabilityLines, printStabilityBanner, CONCURRENCY, TASK_TIMEOUT_MS };
