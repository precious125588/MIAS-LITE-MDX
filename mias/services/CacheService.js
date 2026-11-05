/**
 * MIAS — Cache Service
 *
 * Single shared cache for the entire bot.
 * Wraps node-cache internally — no command should create its own cache.
 *
 * Architecture: Commands → CacheService → CacheEngine (node-cache) → Memory
 */

import engineRegistryModule from "../lib/engineRegistry.cjs";

const _engine = engineRegistryModule.getEngineRegistry().get("cache");

// ─── Core helpers ─────────────────────────────────────────────────────────────

/**
 * Get a cached value.
 * @param {string} key
 * @param {string} [store="default"]
 * @returns {any|null}
 */
export function get(key, store = "default") {
  return _engine?.get(key, store) ?? null;
}

/**
 * Set a cached value.
 * @param {string} key
 * @param {any}    value
 * @param {number} [ttl]   - Seconds. Omit to use the store's default.
 * @param {string} [store="default"]
 */
export function set(key, value, ttl, store = "default") {
  return _engine?.set(key, value, ttl, store) ?? false;
}

/**
 * Delete a key.
 */
export function del(key, store = "default") {
  return _engine?.del(key, store) ?? 0;
}

/**
 * Check if a key exists.
 */
export function has(key, store = "default") {
  return _engine?.has(key, store) ?? false;
}

/**
 * Flush one or all stores.
 * @param {string} [store] - Omit to flush all stores.
 */
export function flush(store) {
  _engine?.flush(store);
}

/**
 * Cache-aside pattern: get or compute.
 * @param {string}   key
 * @param {Function} fn      - Async factory called when cache misses
 * @param {number}   [ttl]
 * @param {string}   [store="default"]
 * @returns {Promise<any>}
 */
export async function getOrSet(key, fn, ttl, store = "default") {
  if (!_engine) return fn();
  return _engine.getOrSet(key, fn, ttl, store);
}

/**
 * Invalidate all keys with a given prefix.
 */
export function invalidatePrefix(prefix, store = "default") {
  return _engine?.invalidatePrefix(prefix, store) ?? 0;
}

/**
 * Get cache stats.
 * @param {string} [store]
 */
export function stats(store) {
  return _engine?.stats(store) ?? {};
}

// ─── Domain-specific helpers ──────────────────────────────────────────────────

/** Profile picture cache (TTL: 30min) */
export const profilePic = {
  get:  (jid)      => _engine?.profilePic.get(jid)       ?? null,
  set:  (jid, url) => _engine?.profilePic.set(jid, url),
  del:  (jid)      => _engine?.profilePic.del(jid),
  has:  (jid)      => _engine?.profilePic.has(jid)       ?? false,
  flush:()         => _engine?.profilePic.flush(),
};

/** Group metadata cache (TTL: 10min) */
export const groupMeta = {
  get:  (jid)      => _engine?.groupMeta.get(jid)        ?? null,
  set:  (jid, meta)=> _engine?.groupMeta.set(jid, meta),
  del:  (jid)      => _engine?.groupMeta.del(jid),
  has:  (jid)      => _engine?.groupMeta.has(jid)        ?? false,
  flush:()         => _engine?.groupMeta.flush(),
};

/** API response cache (TTL: 2min) */
export const apiResponse = {
  get:       (key)           => _engine?.apiResponse.get(key)          ?? null,
  set:       (key, data, ttl)=> _engine?.apiResponse.set(key, data, ttl),
  del:       (key)           => _engine?.apiResponse.del(key),
  getOrSet:  (key, fn, ttl)  => _engine ? _engine.apiResponse.getOrSet(key, fn, ttl) : fn(),
};

/** Download result cache (TTL: 5min) */
export const download = {
  get:       (key)           => _engine?.download.get(key)             ?? null,
  set:       (key, data, ttl)=> _engine?.download.set(key, data, ttl),
  del:       (key)           => _engine?.download.del(key),
  getOrSet:  (key, fn, ttl)  => _engine ? _engine.download.getOrSet(key, fn, ttl) : fn(),
};

/** Menu rendering cache (TTL: 1hr) */
export const menu = {
  get:   (key)           => _engine?.menu.get(key)         ?? null,
  set:   (key, data, ttl)=> _engine?.menu.set(key, data, ttl),
  flush: ()              => _engine?.menu.flush(),
};

export default { get, set, del, has, flush, getOrSet, invalidatePrefix, stats, profilePic, groupMeta, apiResponse, download, menu };
