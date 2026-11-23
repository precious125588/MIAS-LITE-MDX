'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_CAPACITY = 2;
const REJECTED_HISTORY_LIMIT = 5000;

function videoId(item) {
  const text = String(item && (item.url || item.cid) || '');
  const match = text.match(/\/video\/(\d{6,})/) || text.match(/(?:^|\D)(\d{15,})(?:\D|$)/);
  return match ? match[1] : '';
}

function compactItem(item) {
  if (!item || typeof item !== 'object') return null;
  const id = videoId(item);
  if (!id || !/^https?:\/\//i.test(String(item.url || ''))) return null;
  return {
    id,
    url: String(item.url),
    play: String(item.play || '').slice(0, 2000),
    caption: String(item.caption || item.title || '').replace(/\s+/g, ' ').trim().slice(0, 120),
    hashtags: String(item.hashtags || '').slice(0, 300),
    cid: String(item.cid || `video_${id}`).slice(0, 180),
    src: String(item.src || 'other').slice(0, 24),
    creator: String(item.creator || '').slice(0, 80),
  };
}

class StatusEditQueue {
  constructor({ categories, filePath, capacity = DEFAULT_CAPACITY, logger = console } = {}) {
    this.categories = new Set(Object.keys(categories || {}));
    this.filePath = filePath || path.join(process.env.NEXSTORE_DIR || path.join(process.cwd(), 'nexstore'), 'status-edit-queue.json');
    this.capacity = Math.max(1, Math.min(5, Number(capacity) || DEFAULT_CAPACITY));
    this.logger = logger;
    this.queues = new Map([...this.categories].map(key => [key, []]));
    this.inflight = new Map();
    this.used = new Set();
    this.rejected = new Set();
    this.locks = new Map();
    this.timer = null;
    this.stopped = false;
    this.load();
  }

  load() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      this.used = new Set((Array.isArray(saved.used) ? saved.used : []).filter(x => /^\d{6,}$/.test(String(x))));
      this.rejected = new Set((Array.isArray(saved.rejected) ? saved.rejected : []).filter(x => /^\d{6,}$/.test(String(x))).slice(-REJECTED_HISTORY_LIMIT));
      const savedQueues = saved.queues && typeof saved.queues === 'object' ? saved.queues : {};
      for (const [key, list] of Object.entries(savedQueues)) {
        if (!this.categories.has(key) || !Array.isArray(list)) continue;
        for (const raw of list) this.enqueue(key, raw, false);
      }
      // A crash may happen after leasing but before WhatsApp confirms delivery.
      // Return those leases to the queue; no media blobs are persisted.
      const leases = Array.isArray(saved.inflight) ? saved.inflight : [];
      for (const lease of leases) {
        if (this.categories.has(lease.category)) this.enqueue(lease.category, lease.item, false);
      }
    } catch {}
  }

  persist() {
    const data = {
      version: 1,
      savedAt: new Date().toISOString(),
      queues: Object.fromEntries([...this.queues].map(([k, v]) => [k, v])),
      inflight: [...this.inflight.values()],
      used: [...this.used],
      rejected: [...this.rejected].slice(-REJECTED_HISTORY_LIMIT),
    };
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
      fs.renameSync(tmp, this.filePath);
      return true;
    } catch (error) {
      this.logger?.warn?.('[status-queue] persistence failed:', error?.message || error);
      return false;
    }
  }

  enqueue(category, item, save = true) {
    if (!this.categories.has(category)) return false;
    const compact = compactItem(item);
    if (!compact || this.used.has(compact.id) || this.rejected.has(compact.id)) return false;
    if (this.queues.get(category).some(x => x.id === compact.id)) return false;
    if ([...this.inflight.values()].some(x => x.item.id === compact.id)) return false;
    for (const [otherKey, list] of this.queues) {
      if (otherKey !== category && list.some(x => x.id === compact.id)) return false;
    }
    const list = this.queues.get(category);
    if (list.length >= this.capacity) return false;
    list.push(compact);
    if (save) this.persist();
    return true;
  }

  count(category) { return (this.queues.get(category) || []).length; }
  snapshot() { return Object.fromEntries([...this.queues].map(([k, v]) => [k, v.length])); }

  reserve(category, count = 1) {
    const list = this.queues.get(category);
    if (!list) return [];
    const out = [];
    while (list.length && out.length < count) {
      const item = list.shift();
      const token = `${category}:${item.id}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
      this.inflight.set(token, { token, category, item });
      out.push({ token, ...item });
    }
    if (out.length) this.persist();
    return out;
  }

  settle(token, delivered) {
    const lease = this.inflight.get(token);
    if (!lease) return false;
    this.inflight.delete(token);
    if (delivered) this.used.add(lease.item.id);
    else this.rejected.add(lease.item.id);
    this.persist();
    return true;
  }

  async refill(category, fetchCandidates, { force = false } = {}) {
    if (!this.categories.has(category) || this.stopped || typeof fetchCandidates !== 'function') return this.count(category);
    if (!force && this.count(category) >= this.capacity) return this.count(category);
    if (this.locks.has(category)) return this.locks.get(category);
    const task = (async () => {
      try {
        const candidates = await fetchCandidates(category);
        const list = [...(force ? (this.queues.get(category) || []) : []), ...(Array.isArray(candidates) ? candidates : [])];
        for (let i = list.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [list[i], list[j]] = [list[j], list[i]];
        }
        if (force) this.queues.set(category, []);
        for (const item of list) {
          if (this.count(category) >= this.capacity) break;
          this.enqueue(category, item, false);
        }
        this.persist();
      } catch (error) {
        this.logger?.warn?.(`[status-queue] ${category} refill failed:`, error?.message || error);
      }
      return this.count(category);
    })();
    this.locks.set(category, task);
    try { return await task; } finally { this.locks.delete(category); }
  }

  async prefillAll(fetchCandidates, concurrency = 2, force = false) {
    const keys = [...this.categories];
    let cursor = 0;
    const workers = Array.from({ length: Math.max(1, Math.min(4, concurrency)) }, async () => {
      while (!this.stopped && cursor < keys.length) {
        const key = keys[cursor++];
        if (force || this.count(key) < this.capacity) await this.refill(key, fetchCandidates, { force });
      }
    });
    await Promise.all(workers);
    return this.snapshot();
  }

  start(fetchCandidates, { intervalMs = 30000, concurrency = 2 } = {}) {
    if (this.timer || this.stopped) return;
    void this.prefillAll(fetchCandidates, concurrency, true);
    this.timer = setInterval(() => {
      void this.prefillAll(fetchCandidates, concurrency, false);
    }, Math.max(30000, intervalMs));
    this.timer.unref?.();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = { StatusEditQueue, videoId, compactItem, DEFAULT_CAPACITY };
