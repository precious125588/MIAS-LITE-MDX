/**
 * MIAS — Link Preview Service
 *
 * Extracts rich metadata from any URL: title, description, thumbnail,
 * site name, images, videos, favicons, and media type.
 *
 * Wraps linkPreview.cjs (link-preview-js) behind the MIAS service layer
 * with caching, queued fetch, WhatsApp card formatting, and auto-send.
 *
 * Usage:
 *   import { preview, sendPreview, extractUrl } from "./LinkPreviewService.js";
 *
 *   const meta = await preview("https://example.com");
 *   await sendPreview(sock, jid, "https://example.com", { quoted: msg });
 */

import { getOrSet as cacheGetOrSet } from "./CacheService.js";
import { enqueueBackground } from "./QueueService.js";
import { warn, debug } from "./LoggerService.js";
import { buildAdReply } from "./ContextService.js";
import { getJson } from "./NetworkService.js";

// ── CJS engine shim ────────────────────────────────────────────────────────────
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const linkPreviewEngine = require("../lib/engines/linkPreview.cjs");

// ── Constants ──────────────────────────────────────────────────────────────────
const CACHE_TTL   = 60 * 30;        // 30 minutes
const DEFAULT_UA  = "MIAS Link Preview Bot/2.0 (compatible; WhatsApp Bot)";
const TIMEOUT_MS  = 12_000;

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Extract the first HTTP(S) URL found in text.
 * @param {string} text
 * @returns {string|null}
 */
export function extractUrl(text) {
  return linkPreviewEngine.extractUrl(String(text || ""));
}

/**
 * Check if a string is a valid HTTP(S) URL.
 * @param {string} input
 * @returns {boolean}
 */
export function isUrl(input) {
  return /^https?:\/\/.+/i.test(String(input || "").trim());
}

// ── Core preview ───────────────────────────────────────────────────────────────

/**
 * Fetch rich metadata for a URL.
 * Result is cached for 30 minutes per URL.
 *
 * @param {string} urlOrText - Full URL or text containing a URL
 * @param {object} [opts]
 * @param {number} [opts.timeout]    - Fetch timeout in ms (default 12 000)
 * @param {string} [opts.userAgent]  - Custom User-Agent header
 * @param {boolean} [opts.noCache]   - Skip cache and force fresh fetch
 * @returns {Promise<LinkPreviewResult>}
 *
 * @typedef {object} LinkPreviewResult
 * @property {string}   url
 * @property {string}   title
 * @property {string}   description
 * @property {string}   siteName
 * @property {string}   author
 * @property {string|null} thumbnail  - First image URL (best for cards)
 * @property {string[]} images
 * @property {string[]} videos
 * @property {string[]} favicons
 * @property {string}   mediaType    - "website" | "image" | "video" | "audio" | "application" | "unknown"
 * @property {string|null} contentType
 */
export async function preview(urlOrText, opts = {}) {
  const url = extractUrl(urlOrText) || urlOrText;
  if (!isUrl(url)) throw new TypeError(`LinkPreviewService: Not a valid URL — "${url}"`);

  const cacheKey = `link_preview:${url}`;

  if (opts.noCache) {
    return _fetch(url, opts);
  }

  return cacheGetOrSet(cacheKey, () => _fetch(url, opts), CACHE_TTL);
}

async function _fetch(url, opts = {}) {
  debug(`[LinkPreview] Fetching: ${url}`);
  try {
    return await linkPreviewEngine.previewLink(url, {
      timeout:   opts.timeout   || TIMEOUT_MS,
      userAgent: opts.userAgent || DEFAULT_UA,
      headers:   opts.headers   || {},
    });
  } catch (err) {
    warn(`[LinkPreview] Failed for ${url}: ${err?.message}`);
    // Return a minimal safe object instead of throwing, so commands can
    // still send something rather than crashing.
    return {
      url,
      title:       _domainOf(url),
      description: "",
      siteName:    _domainOf(url),
      author:      "",
      thumbnail:   null,
      images:      [],
      videos:      [],
      favicons:    [],
      mediaType:   "unknown",
      contentType: null,
      _error:      err?.message || String(err),
    };
  }
}

function _domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); }
  catch { return url; }
}

// ── Batch preview ──────────────────────────────────────────────────────────────

/**
 * Preview multiple URLs in parallel (max 5 at once).
 * @param {string[]} urls
 * @param {object}   [opts]
 * @returns {Promise<LinkPreviewResult[]>}
 */
export async function previewMany(urls, opts = {}) {
  const unique = [...new Set(urls.map(u => extractUrl(u) || u).filter(isUrl))];
  const chunks = [];
  for (let i = 0; i < unique.length; i += 5) chunks.push(unique.slice(i, i + 5));

  const results = [];
  for (const chunk of chunks) {
    const batch = await Promise.all(chunk.map(u => preview(u, opts)));
    results.push(...batch);
  }
  return results;
}

// ── WhatsApp formatting ────────────────────────────────────────────────────────

/**
 * Format a preview result as a readable text block.
 * @param {LinkPreviewResult} meta
 * @param {object} [opts]
 * @param {boolean} [opts.includeDescription=true]
 * @param {boolean} [opts.includeUrl=true]
 * @param {boolean} [opts.includeSiteName=true]
 * @returns {string}
 */
export function formatPreview(meta, opts = {}) {
  const show = { description: true, url: true, siteName: true, ...opts };
  const lines = [];
  if (meta.title)                                lines.push(`*${meta.title}*`);
  if (show.siteName && meta.siteName)            lines.push(`🌐 ${meta.siteName}${meta.author ? ` • ${meta.author}` : ""}`);
  if (show.description && meta.description)      lines.push(`\n${meta.description}`);
  if (show.url)                                  lines.push(`\n🔗 ${meta.url}`);
  return lines.join("\n");
}

/**
 * Build a WhatsApp ExternalAdReply contextInfo card from a preview result.
 * Drop this into any message's opts to show a rich link card.
 *
 * @param {LinkPreviewResult} meta
 * @param {object} [overrides] - Override any field in the ad reply
 * @returns {object} contextInfo object for use in message opts
 */
export function toAdReply(meta, overrides = {}) {
  return buildAdReply({
    title:       overrides.title       || meta.title       || _domainOf(meta.url),
    body:        overrides.body        || meta.description || meta.siteName || "",
    sourceUrl:   overrides.sourceUrl   || meta.url,
    mediaType:   overrides.mediaType   || (meta.thumbnail ? 1 : 2),
    thumbnailUrl: overrides.thumbnailUrl || meta.thumbnail || null,
    ...overrides,
  });
}

// ── High-level send helpers ────────────────────────────────────────────────────

/**
 * Fetch a URL's preview and send it as a text message with an ad-reply card.
 *
 * @param {object} sock
 * @param {string} jid
 * @param {string} urlOrText
 * @param {object} [opts]
 * @param {object} [opts.quoted]      - Message to quote
 * @param {string} [opts.caption]     - Override caption (default: formatted preview)
 * @param {boolean} [opts.sendImage]  - If true AND thumbnail exists, send as image; default false
 * @param {boolean} [opts.noCache]    - Skip cache
 * @returns {Promise<void>}
 */
export async function sendPreview(sock, jid, urlOrText, opts = {}) {
  const meta       = await preview(urlOrText, { noCache: opts.noCache });
  const contextInfo = toAdReply(meta);
  const caption    = opts.caption || formatPreview(meta, { description: true, url: false });

  if (opts.sendImage && meta.thumbnail) {
    // Fetch thumbnail buffer and send as image with rich card
    try {
      const { fetchBuffer } = await import("./NetworkService.js");
      const thumbBuf = await fetchBuffer(meta.thumbnail);
      await sock.sendMessage(jid, {
        image:       thumbBuf,
        caption,
        contextInfo,
        ...(opts.quoted ? { quoted: opts.quoted } : {}),
      });
      return;
    } catch {
      // Fall through to text send
    }
  }

  // Plain text + ad-reply card
  await sock.sendMessage(jid, {
    text: caption,
    contextInfo,
    ...(opts.quoted ? { quoted: opts.quoted } : {}),
  });
}

/**
 * Pre-fetch a URL's preview in the background (warms the cache).
 * Use this when you expect a URL will be needed soon.
 * @param {string} urlOrText
 */
export function prefetch(urlOrText) {
  enqueueBackground(() => preview(urlOrText)).catch(() => {});
}

/**
 * Auto-detect all URLs in a message body and prefetch their previews.
 * @param {string} text
 */
export function prefetchFromText(text) {
  const urls = (String(text || "").match(/https?:\/\/[^\s<>"']+/gi) || [])
    .map(u => u.replace(/[),.;!?]+$/, ""))
    .filter(isUrl);
  for (const url of urls) prefetch(url);
}

export default {
  extractUrl,
  isUrl,
  preview,
  previewMany,
  formatPreview,
  toAdReply,
  sendPreview,
  prefetch,
  prefetchFromText,
};
