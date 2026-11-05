/**
 * MIAS — Download Service
 *
 * Centralized media download hub.
 * No command should call downloadContentFromMessage directly.
 *
 * Architecture: Commands → DownloadService → DownloadHandler → Baileys → WhatsApp
 */

import { downloadMedia as _dlMedia, downloadQuotedMedia as _dlQuoted, downloadFromUrl as _dlUrl, downloadViewOnce as _dlViewOnce } from "../handlers/downloadHandler.js";
import { enqueueDownload } from "./QueueService.js";
import { get as cacheGet, set as cacheSet } from "./CacheService.js";

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Download media from a WAMessage.
 * Queued via the download queue.
 *
 * @param {object} msg          - WAMessage object
 * @param {string} [mediaType]  - "image"|"video"|"audio"|"document"|"sticker" (auto-detected)
 * @returns {Promise<Buffer|null>}
 */
export async function downloadMedia(msg, mediaType) {
  return enqueueDownload(() => _dlMedia(msg, mediaType));
}

/**
 * Download quoted (replied-to) media from a WAMessage.
 *
 * @param {object} msg - WAMessage that quotes another
 * @returns {Promise<{buffer: Buffer, type: string}|null>}
 */
export async function downloadQuotedMedia(msg) {
  return enqueueDownload(() => _dlQuoted(msg));
}

/**
 * Download a view-once media message (auto-destructing).
 *
 * @param {object} msg
 * @returns {Promise<Buffer|null>}
 */
export async function downloadViewOnce(msg) {
  return enqueueDownload(() => _dlViewOnce(msg));
}

/**
 * Download a remote URL to a Buffer.
 * Results are cached by URL for 5 minutes.
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {boolean}[opts.noCache] - Skip cache
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<Buffer>}
 */
export async function downloadFromUrl(url, opts = {}) {
  const cacheKey = `dl:${url}`;
  if (!opts.noCache) {
    const cached = cacheGet(cacheKey, "download");
    if (cached) return cached;
  }
  return enqueueDownload(async () => {
    const buf = await _dlUrl(url, opts);
    if (buf && !opts.noCache) cacheSet(cacheKey, buf, 300, "download");
    return buf;
  });
}

/**
 * Alias: fetch any URL as a Buffer.
 */
export const fetchBuffer = downloadFromUrl;

/**
 * Download and detect media from message.
 * Returns buffer + MIME type + media kind.
 *
 * @param {object} msg
 * @returns {Promise<{buffer: Buffer, mime: string, type: string}|null>}
 */
export async function downloadWithInfo(msg) {
  return enqueueDownload(async () => {
    const result = await _dlMedia(msg);
    if (!result) return null;
    // Import MimeService lazily to avoid circular deps
    const { detectBuffer } = await import("./MimeService.js");
    const info = await detectBuffer(result).catch(() => ({ mime: "application/octet-stream", ext: "bin" }));
    return { buffer: result, mime: info.mime, type: info.category };
  });
}

export default { downloadMedia, downloadQuotedMedia, downloadViewOnce, downloadFromUrl, fetchBuffer, downloadWithInfo };
