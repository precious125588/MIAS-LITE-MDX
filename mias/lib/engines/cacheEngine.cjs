"use strict";

/**
 * MIAS Cache Engine
 * Wraps node-cache with named stores, TTL presets, and tag-based invalidation.
 * Architecture: Services → CacheEngine (node-cache) → Memory
 */

const NodeCache = require("node-cache");

// ─── Named cache stores ────────────────────────────────────────────────────────

const STORES = {
  default: new NodeCache({ stdTTL: 300, checkperiod: 60, useClones: false }),
  profilePic: new NodeCache({ stdTTL: 1800, checkperiod: 120, useClones: false }),
  groupMeta: new NodeCache({ stdTTL: 600, checkperiod: 60, useClones: false }),
  apiResponse: new NodeCache({ stdTTL: 120, checkperiod: 30, useClones: false }),
  download: new NodeCache({ stdTTL: 300, checkperiod: 60, useClones: false }),
  menu: new NodeCache({ stdTTL: 3600, checkperiod: 300, useClones: false }),
  command: new NodeCache({ stdTTL: 86400, checkperiod: 3600, useClones: false }),
  session: new NodeCache({ stdTTL: 900, checkperiod: 120, useClones: false }),
};

function _getStore(store) {
  return STORES[store] || STORES.default;
}

// ─── Core API ─────────────────────────────────────────────────────────────────

function get(key, store = "default") {
  return _getStore(store).get(key) ?? null;
}

function set(key, value, ttl, store = "default") {
  if (ttl !== undefined) {
    return _getStore(store).set(key, value, ttl);
  }
  return _getStore(store).set(key, value);
}

function del(key, store = "default") {
  return _getStore(store).del(key);
}

function has(key, store = "default") {
  return _getStore(store).has(key);
}

function flush(store) {
  if (store) {
    _getStore(store).flushAll();
  } else {
    for (const s of Object.values(STORES)) s.flushAll();
  }
}

function keys(store = "default") {
  return _getStore(store).keys();
}

function stats(store) {
  if (store) return _getStore(store).getStats();
  const out = {};
  for (const [name, s] of Object.entries(STORES)) {
    out[name] = s.getStats();
  }
  return out;
}

/**
 * Get or compute a value (cache-aside pattern).
 * If the key exists, return cached. Otherwise call fn() and cache the result.
 */
async function getOrSet(key, fn, ttl, store = "default") {
  const cached = get(key, store);
  if (cached !== null) return cached;
  const value = await fn();
  if (value !== null && value !== undefined) {
    set(key, value, ttl, store);
  }
  return value;
}

/**
 * Invalidate all keys matching a prefix pattern.
 */
function invalidatePrefix(prefix, store = "default") {
  const s = _getStore(store);
  const matching = s.keys().filter(k => k.startsWith(prefix));
  if (matching.length) s.del(matching);
  return matching.length;
}

/**
 * Store-specific helpers for convenience
 */
const profilePic = {
  get: (jid) => get(jid, "profilePic"),
  set: (jid, url) => set(jid, url, undefined, "profilePic"),
  del: (jid) => del(jid, "profilePic"),
  has: (jid) => has(jid, "profilePic"),
  flush: () => flush("profilePic"),
};

const groupMeta = {
  get: (jid) => get(jid, "groupMeta"),
  set: (jid, meta) => set(jid, meta, undefined, "groupMeta"),
  del: (jid) => del(jid, "groupMeta"),
  has: (jid) => has(jid, "groupMeta"),
  flush: () => flush("groupMeta"),
};

const apiResponse = {
  get: (key) => get(key, "apiResponse"),
  set: (key, data, ttl = 120) => set(key, data, ttl, "apiResponse"),
  del: (key) => del(key, "apiResponse"),
  getOrSet: (key, fn, ttl = 120) => getOrSet(key, fn, ttl, "apiResponse"),
};

const downloadCache = {
  get: (key) => get(key, "download"),
  set: (key, data, ttl = 300) => set(key, data, ttl, "download"),
  del: (key) => del(key, "download"),
  getOrSet: (key, fn, ttl = 300) => getOrSet(key, fn, ttl, "download"),
};

const menuCache = {
  get: (key) => get(key, "menu"),
  set: (key, data, ttl = 3600) => set(key, data, ttl, "menu"),
  flush: () => flush("menu"),
};

module.exports = {
  get,
  set,
  del,
  has,
  flush,
  keys,
  stats,
  getOrSet,
  invalidatePrefix,
  stores: STORES,
  profilePic,
  groupMeta,
  apiResponse,
  download: downloadCache,
  menu: menuCache,
};
