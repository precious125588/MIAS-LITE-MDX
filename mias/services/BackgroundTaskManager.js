/**
 * MIAS — Background Task Manager
 *
 * Runs non-blocking tasks in the background without impacting command latency.
 * Handles: thumbnail generation, cache cleanup, statistics, temp file cleanup.
 *
 * Architecture: Services → BackgroundTaskManager → QueueService → Workers
 */

import { enqueueBackground } from "./QueueService.js";
import { emit, EVENTS } from "./EventBus.js";

// ─── Task registry ────────────────────────────────────────────────────────────

const _scheduledTasks = new Map();  // name → intervalId

// ─── Core API ─────────────────────────────────────────────────────────────────

/**
 * Run a function in the background (fire-and-forget).
 * Errors are caught and do not propagate.
 *
 * @param {string}   name  - Task label for logging
 * @param {Function} fn    - Async function to run
 */
export function run(name, fn) {
  enqueueBackground(async () => {
    try { await fn(); }
    catch (err) {
      console.error(`[BackgroundTask:${name}]`, err?.message || err);
      await emit(EVENTS.ERROR, { source: `bg:${name}`, error: err });
    }
  }).catch(() => {});
}

/**
 * Schedule a recurring background task.
 * @param {string}   name         - Task name (unique, used to prevent duplicates)
 * @param {Function} fn           - Async function to run
 * @param {number}   intervalMs   - Interval in milliseconds
 * @param {object}   [opts]
 * @param {boolean}  [opts.runImmediately=false] - Run once immediately before starting the interval
 */
export function schedule(name, fn, intervalMs, opts = {}) {
  if (_scheduledTasks.has(name)) return; // prevent duplicates

  if (opts.runImmediately) run(name, fn);

  const id = setInterval(() => { run(name, fn); }, intervalMs);
  _scheduledTasks.set(name, id);
  return id;
}

/**
 * Cancel a scheduled task.
 * @param {string} name
 */
export function cancel(name) {
  const id = _scheduledTasks.get(name);
  if (id) { clearInterval(id); _scheduledTasks.delete(name); }
}

/**
 * Cancel all scheduled tasks.
 */
export function cancelAll() {
  for (const [name, id] of _scheduledTasks.entries()) {
    clearInterval(id);
    _scheduledTasks.delete(name);
  }
}

/**
 * List all active scheduled tasks.
 * @returns {string[]}
 */
export function listTasks() {
  return [..._scheduledTasks.keys()];
}

// ─── Pre-built system tasks ───────────────────────────────────────────────────

/**
 * Start all default background tasks.
 * Called once at bot startup.
 */
export function startDefaultTasks() {
  // Cache cleanup — every 10 minutes
  schedule("cache:cleanup", async () => {
    // CacheService manages TTL automatically via node-cache;
    // this hook exists for additional cleanup if needed.
    const { flush } = await import("./CacheService.js");
    // Flush expired download cache entries (node-cache handles TTL, no-op here)
  }, 10 * 60 * 1000);

  // Metrics collection — every 5 minutes
  schedule("metrics:collect", async () => {
    const { getSummary } = await import("./MetricsService.js");
    await getSummary(); // Trigger internal collection
  }, 5 * 60 * 1000);

  // Temp file cleanup — every 30 minutes
  schedule("temp:cleanup", async () => {
    const { tmpdir } = await import("os");
    const { readdir, unlink, stat } = await import("fs/promises");
    const { join } = await import("path");
    const tmp = tmpdir();
    try {
      const files = await readdir(tmp);
      const miasFiles = files.filter(f => f.startsWith("mias_"));
      const now = Date.now();
      for (const f of miasFiles) {
        const p = join(tmp, f);
        try {
          const s = await stat(p);
          // Delete files older than 30 minutes
          if (now - s.mtimeMs > 30 * 60 * 1000) {
            await unlink(p);
          }
        } catch {}
      }
    } catch {}
  }, 30 * 60 * 1000);

  // Group metadata cache refresh — every 15 minutes
  schedule("cache:group-meta-refresh", async () => {
    // Invalidate stale group meta so next request re-fetches
    const { groupMeta } = await import("./CacheService.js");
    // node-cache handles TTL; nothing extra needed
  }, 15 * 60 * 1000);
}

export default { run, schedule, cancel, cancelAll, listTasks, startDefaultTasks };
