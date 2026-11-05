"use strict";

/**
 * MIAS Queue Engine
 * Wraps p-queue for concurrency-controlled background work.
 * Architecture: Services → QueueEngine (p-queue) → Workers
 */

// p-queue is ESM-only from v7+. We ship a compatibility shim for CJS.
// We use dynamic import with a promise cache so the module is loaded once.

let _PQueue = null;
let _loadPromise = null;

async function _loadPQueue() {
  if (_PQueue) return _PQueue;
  if (_loadPromise) return _loadPromise;
  _loadPromise = import("p-queue")
    .then((m) => {
      _PQueue = m.default || m.PQueue || m;
      return _PQueue;
    })
    .catch(() => {
      // Fallback: tiny sequential queue
      _PQueue = class FallbackQueue {
        constructor(opts = {}) {
          this._concurrency = opts.concurrency || 1;
          this._running = 0;
          this._pending = [];
          this.size = 0;
          this.pending = 0;
        }
        add(fn) {
          return new Promise((resolve, reject) => {
            const run = async () => {
              this._running++;
              this.size = this._pending.length;
              try { resolve(await fn()); } catch (e) { reject(e); }
              this._running--;
              this.size = this._pending.length;
              if (this._pending.length) this._pending.shift()();
            };
            if (this._running < this._concurrency) run();
            else this._pending.push(run);
            this.size = this._pending.length;
          });
        }
        async onIdle() {}
        clear() { this._pending = []; }
      };
      return _PQueue;
    });
  return _loadPromise;
}

// ─── Named queues ─────────────────────────────────────────────────────────────

const _queues = {};

async function getQueue(name = "default", opts = {}) {
  if (_queues[name]) return _queues[name];
  const PQueue = await _loadPQueue();

  const defaults = {
    default: { concurrency: 4 },
    media: { concurrency: 2 },
    download: { concurrency: 3 },
    upload: { concurrency: 2 },
    ai: { concurrency: 1 },
    thumbnail: { concurrency: 2 },
    image: { concurrency: 2 },
    background: { concurrency: 5 },
  };

  const queueOpts = { ...(defaults[name] || { concurrency: 2 }), ...opts };
  _queues[name] = new PQueue(queueOpts);
  return _queues[name];
}

/**
 * Add a task to a named queue.
 * @param {string}   name      - Queue name
 * @param {Function} fn        - Async function to execute
 * @param {object}   [opts]    - Additional queue options
 * @param {number}   [opts.priority]
 * @returns {Promise<any>}
 */
async function enqueue(name, fn, opts = {}) {
  const q = await getQueue(name);
  return q.add(fn, opts);
}

/**
 * Add to the media queue (concurrency: 2).
 */
async function enqueueMedia(fn, opts = {}) {
  return enqueue("media", fn, opts);
}

/**
 * Add to the download queue (concurrency: 3).
 */
async function enqueueDownload(fn, opts = {}) {
  return enqueue("download", fn, opts);
}

/**
 * Add to the upload queue (concurrency: 2).
 */
async function enqueueUpload(fn, opts = {}) {
  return enqueue("upload", fn, opts);
}

/**
 * Add to the AI queue (concurrency: 1, sequential).
 */
async function enqueueAI(fn, opts = {}) {
  return enqueue("ai", fn, opts);
}

/**
 * Add to the thumbnail generation queue.
 */
async function enqueueThumbnail(fn, opts = {}) {
  return enqueue("thumbnail", fn, opts);
}

/**
 * Add to the image processing queue.
 */
async function enqueueImage(fn, opts = {}) {
  return enqueue("image", fn, opts);
}

/**
 * Add to the background tasks queue.
 */
async function enqueueBackground(fn, opts = {}) {
  return enqueue("background", fn, opts);
}

/**
 * Get stats for all named queues.
 */
async function stats() {
  const out = {};
  for (const [name, q] of Object.entries(_queues)) {
    out[name] = {
      size: q.size,
      pending: q.pending,
      concurrency: q._concurrency,
    };
  }
  return out;
}

/**
 * Clear all tasks from a named queue.
 */
async function clearQueue(name) {
  const q = _queues[name];
  if (q) q.clear();
}

module.exports = {
  getQueue,
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
  _loadPQueue,
};
