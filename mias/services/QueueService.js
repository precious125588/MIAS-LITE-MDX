/**
 * MIAS — Queue Service
 *
 * Centralized job queue for heavy operations.
 * Commands never manage queues directly.
 *
 * Architecture: Commands → QueueService → QueueEngine (p-queue) → Workers
 */

import engineRegistryModule from "../lib/engineRegistry.cjs";

const _engine = engineRegistryModule.getEngineRegistry().get("queue");

// ─── Direct queue access ───────────────────────────────────────────────────────

/**
 * Add a task to a named queue.
 * @param {string}   name    - Queue name: "media"|"download"|"upload"|"ai"|"thumbnail"|"image"|"background"
 * @param {Function} fn      - Async function to execute
 * @param {object}   [opts]  - p-queue options (priority, signal, etc.)
 * @returns {Promise<any>}
 */
export async function enqueue(name, fn, opts = {}) {
  if (!_engine) return fn();
  return _engine.enqueue(name, fn, opts);
}

/** Queue a media processing task (concurrency: 2). */
export async function enqueueMedia(fn, opts = {}) {
  if (!_engine) return fn();
  return _engine.enqueueMedia(fn, opts);
}

/** Queue a download task (concurrency: 3). */
export async function enqueueDownload(fn, opts = {}) {
  if (!_engine) return fn();
  return _engine.enqueueDownload(fn, opts);
}

/** Queue an upload task (concurrency: 2). */
export async function enqueueUpload(fn, opts = {}) {
  if (!_engine) return fn();
  return _engine.enqueueUpload(fn, opts);
}

/** Queue an AI request (concurrency: 1, sequential). */
export async function enqueueAI(fn, opts = {}) {
  if (!_engine) return fn();
  return _engine.enqueueAI(fn, opts);
}

/** Queue a thumbnail generation task. */
export async function enqueueThumbnail(fn, opts = {}) {
  if (!_engine) return fn();
  return _engine.enqueueThumbnail(fn, opts);
}

/** Queue an image processing task. */
export async function enqueueImage(fn, opts = {}) {
  if (!_engine) return fn();
  return _engine.enqueueImage(fn, opts);
}

/** Queue a background / non-critical task. */
export async function enqueueBackground(fn, opts = {}) {
  if (!_engine) {
    // fire-and-forget if no engine
    Promise.resolve().then(() => fn()).catch(() => {});
    return;
  }
  return _engine.enqueueBackground(fn, opts);
}

/** Get stats for all named queues. */
export async function stats() {
  if (!_engine) return {};
  return _engine.stats();
}

/** Clear all pending tasks in a named queue. */
export async function clearQueue(name) {
  if (_engine) await _engine.clearQueue(name);
}

export default {
  enqueue,
  enqueueMedia,
  enqueueDownload,
  enqueueUpload,
  enqueueAI,
  enqueueThumbnail,
  enqueueImage,
  enqueueBackground,
  stats,
  clearQueue,
};
