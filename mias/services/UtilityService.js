/**
 * MIAS — Utility Service
 *
 * General-purpose utilities. Wraps uuid, crypto-js, moment-timezone,
 * emoji-db, yt-search, google-translate-free, and mime-types.
 * Commands never import these packages directly.
 *
 * Architecture: Commands → UtilityService → UtilityEngine → packages
 */

import engineRegistryModule from "../lib/engineRegistry.cjs";

const _engine = engineRegistryModule.getEngineRegistry().get("utility");

// ─── UUID ─────────────────────────────────────────────────────────────────────

/** Generate a random UUID v4. */
export function generateId() { return _engine?.generateId() || crypto.randomUUID?.() || Date.now().toString(36); }

/** Generate a time-based UUID v1. */
export function generateTimedId() { return _engine?.generateTimedId() || generateId(); }

/** Check if a string is a valid UUID. */
export function isValidUuid(s) { return _engine?.isValidUuid(s) ?? /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s); }

// ─── Crypto ───────────────────────────────────────────────────────────────────

/** MD5 hash of a string. */
export function md5(text) { return _engine?.md5(text) ?? text; }

/** SHA-256 hash. */
export function sha256(text) { return _engine?.sha256(text) ?? text; }

/** SHA-1 hash. */
export function sha1(text) { return _engine?.sha1(text) ?? text; }

/** HMAC-SHA256. */
export function hmacSha256(text, secret) { return _engine?.hmacSha256(text, secret) ?? ""; }

/** Base64 encode. */
export function base64Encode(text) { return _engine?.base64Encode(text) ?? Buffer.from(String(text)).toString("base64"); }

/** Base64 decode. */
export function base64Decode(b64) { return _engine?.base64Decode(b64) ?? Buffer.from(String(b64), "base64").toString(); }

/** AES-256 encrypt. */
export function aesEncrypt(text, key) { return _engine?.aesEncrypt(text, key) ?? text; }

/** AES-256 decrypt. */
export function aesDecrypt(cipherText, key) { return _engine?.aesDecrypt(cipherText, key) ?? ""; }

// ─── Moment / time ────────────────────────────────────────────────────────────

/**
 * Get current moment in a timezone.
 * @param {string} [tz]
 * @returns {object} moment instance
 */
export function now(tz) { return _engine?.now(tz) ?? new Date(); }

/**
 * Format a date.
 * @param {Date|string|number} date
 * @param {string} [fmt="YYYY-MM-DD HH:mm:ss"]
 * @param {string} [tz]
 * @returns {string}
 */
export function formatDate(date, fmt, tz) { return _engine?.formatDate(date, fmt, tz) ?? new Date(date).toLocaleString(); }

/** Human-readable "X ago" string. */
export function timeAgo(date) { return _engine?.timeAgo(date) ?? ""; }

/** Add time to a date. */
export function addTime(date, amount, unit) { return _engine?.addTime(date, amount, unit) ?? date; }

/** Difference between two dates. */
export function diffTime(a, b, unit) { return _engine?.diffTime(a, b, unit) ?? 0; }

/** List of all timezone names. */
export function timezoneList() { return _engine?.timezoneList() ?? []; }

// ─── Emoji ────────────────────────────────────────────────────────────────────

/** Find emoji by name. */
export function findEmoji(name) { return _engine?.findEmoji(name) ?? null; }

/** Get emoji character by name. */
export function getEmoji(name) { return _engine?.getEmoji(name) ?? name; }

// ─── YT Search ────────────────────────────────────────────────────────────────

/**
 * Search YouTube.
 * @param {string} query
 * @param {object} [opts]
 * @returns {Promise<Array>} Video results
 */
export async function ytSearch(query, opts = {}) {
  return _engine?.ytSearch ? _engine.ytSearch(query, opts) : [];
}

// ─── Translate ────────────────────────────────────────────────────────────────

/**
 * Translate text using Google Translate (free).
 * @param {string} text
 * @param {string} [to="en"]
 * @param {string} [from="auto"]
 * @returns {Promise<string>}
 */
export async function translate(text, to = "en", from = "auto") {
  return _engine?.translate ? _engine.translate(text, to, from) : text;
}

// ─── MIME ─────────────────────────────────────────────────────────────────────

/** Lookup MIME type from extension. */
export function mimeFromExt(ext) { return _engine?.lookup ? _engine.lookup(ext) : "application/octet-stream"; }

/** Lookup extension from MIME type. */
export function extFromMime(mime) { return _engine?.extension ? _engine.extension(mime) : null; }

// ─── String utilities ─────────────────────────────────────────────────────────

/** Truncate a string. */
export function truncate(str, max = 100, suffix = "...") {
  return _engine?.truncate ? _engine.truncate(str, max, suffix) : (String(str).length > max ? String(str).slice(0, max - suffix.length) + suffix : String(str));
}

/** Slugify a string. */
export function slugify(str) { return _engine?.slugify ? _engine.slugify(str) : String(str).toLowerCase().replace(/\s+/g, "-"); }

/** Capitalize first letter. */
export function capitalize(str) { return _engine?.capitalize ? _engine.capitalize(str) : String(str).charAt(0).toUpperCase() + String(str).slice(1); }

/** Generate a random alphanumeric string. */
export function randomString(length = 8, chars) { return _engine?.randomString ? _engine.randomString(length, chars) : Math.random().toString(36).slice(2, 2 + length); }

/** Sleep for N milliseconds. */
export function sleep(ms) { return _engine?.sleep ? _engine.sleep(ms) : new Promise(r => setTimeout(r, ms)); }

export default {
  generateId, generateTimedId, isValidUuid,
  md5, sha256, sha1, hmacSha256, base64Encode, base64Decode, aesEncrypt, aesDecrypt,
  now, formatDate, timeAgo, addTime, diffTime, timezoneList,
  findEmoji, getEmoji,
  ytSearch, translate,
  mimeFromExt, extFromMime,
  truncate, slugify, capitalize, randomString, sleep,
};
