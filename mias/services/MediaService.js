/**
 * MIAS — Media Service  v1
 *
 * The central orchestrator for all outgoing media.
 * Every image, video, audio, document, and sticker sent by the bot
 * should pass through here.
 *
 * Automatically handles:
 *  ✓ MIME detection
 *  ✓ Thumbnail generation
 *  ✓ Image optimization
 *  ✓ Media compression
 *  ✓ Metadata attachment
 *  ✓ Preview link generation
 *  ✓ Upload / download routing
 *  ✓ Queue management
 *
 * Architecture: Commands → MediaService → Specialized Services → Handlers → WhatsApp
 */

import { sendImage, sendVideo, sendAudio, sendVoiceNote, sendDocument, sendSticker, sendGif, sendAlbum, sendMediaFromUrl } from "../handlers/mediaHandler.js";
import { detectBuffer } from "./MimeService.js";
import { fromImage as thumbFromImage, fromVideo as thumbFromVideo } from "./ThumbnailService.js";
import { optimize as optimizeImage } from "./ImageService.js";
import { compress as compressVideo } from "./VideoService.js";
import { enqueueMedia } from "./QueueService.js";

// ─── Internal helpers ─────────────────────────────────────────────────────────

async function _resolveSource(src) {
  if (!src) throw new Error("Media source required");
  if (Buffer.isBuffer(src)) return src;
  if (typeof src === "string") {
    if (src.startsWith("http://") || src.startsWith("https://")) {
      const { fetchBuffer } = await import("./NetworkService.js");
      return fetchBuffer(src);
    }
    const { readFile } = await import("fs/promises");
    return readFile(src);
  }
  throw new TypeError("Media source must be a Buffer, URL, or file path");
}

async function _autoThumb(buf, isVideo = false) {
  if (!Buffer.isBuffer(buf) || buf.length < 100) return null;
  try {
    return isVideo ? await thumbFromVideo(buf) : await thumbFromImage(buf, { width: 300, height: 150 });
  } catch { return null; }
}

// ─── Public send helpers ──────────────────────────────────────────────────────

/**
 * Send an image. Automatically optimizes + attaches thumbnail.
 *
 * @param {object}         sock
 * @param {string}         jid
 * @param {Buffer|string}  src        - Buffer, URL, or file path
 * @param {object}         [opts]
 * @param {string}         [opts.caption]
 * @param {object}         [opts.quoted]
 * @param {boolean}        [opts.optimize=true]  - Compress if > 1MB
 * @param {object}         [opts.contextInfo]
 * @returns {Promise<object|null>}
 */
export async function sendImageMedia(sock, jid, src, opts = {}) {
  return enqueueMedia(async () => {
    let buf = await _resolveSource(src);
    // Auto-optimize large images
    if (opts.optimize !== false && buf.length > 1_000_000) {
      buf = await optimizeImage(buf, { quality: 82, maxWidth: 1920 }).catch(() => buf);
    }
    const thumb = opts.jpegThumbnail || await _autoThumb(buf);
    return sendImage(sock, jid, buf, {
      ...opts,
      jpegThumbnail: thumb,
    });
  });
}

/**
 * Send a video. Automatically generates thumbnail.
 *
 * @param {object}         sock
 * @param {string}         jid
 * @param {Buffer|string}  src
 * @param {object}         [opts]
 * @param {string}         [opts.caption]
 * @param {boolean}        [opts.compress=false] - Re-encode to reduce size
 * @returns {Promise<object|null>}
 */
export async function sendVideoMedia(sock, jid, src, opts = {}) {
  return enqueueMedia(async () => {
    let buf = await _resolveSource(src);
    if (opts.compress) {
      buf = await compressVideo(buf, "mp4", { crf: 28 }).catch(() => buf);
    }
    const thumb = opts.jpegThumbnail || await _autoThumb(buf, true);
    return sendVideo(sock, jid, buf, { ...opts, jpegThumbnail: thumb });
  });
}

/**
 * Send audio (standard audio message).
 *
 * @param {object}         sock
 * @param {string}         jid
 * @param {Buffer|string}  src
 * @param {object}         [opts]
 * @param {string}         [opts.mimetype]
 * @returns {Promise<object|null>}
 */
export async function sendAudioMedia(sock, jid, src, opts = {}) {
  return enqueueMedia(async () => {
    const buf = await _resolveSource(src);
    return sendAudio(sock, jid, buf, opts);
  });
}

/**
 * Send a voice note (PTT).
 *
 * @param {object}         sock
 * @param {string}         jid
 * @param {Buffer|string}  src
 * @param {object}         [opts]
 * @returns {Promise<object|null>}
 */
export async function sendVoiceMedia(sock, jid, src, opts = {}) {
  return enqueueMedia(async () => {
    const buf = await _resolveSource(src);
    return sendVoiceNote(sock, jid, buf, opts);
  });
}

/**
 * Send a document with auto MIME detection.
 *
 * @param {object}         sock
 * @param {string}         jid
 * @param {Buffer|string}  src
 * @param {object}         [opts]
 * @param {string}         [opts.fileName]
 * @param {string}         [opts.mimetype]
 * @returns {Promise<object|null>}
 */
export async function sendDocumentMedia(sock, jid, src, opts = {}) {
  return enqueueMedia(async () => {
    const buf = await _resolveSource(src);
    let mime = opts.mimetype;
    if (!mime) {
      const info = await detectBuffer(buf).catch(() => null);
      mime = info?.mime || "application/octet-stream";
    }
    return sendDocument(sock, jid, buf, { ...opts, mimetype: mime });
  });
}

/**
 * Send a sticker (auto-creates from image/video if raw buffer).
 *
 * @param {object}         sock
 * @param {string}         jid
 * @param {Buffer|string}  src
 * @param {object}         [opts]
 * @param {boolean}        [opts.animated]
 * @returns {Promise<object|null>}
 */
export async function sendStickerMedia(sock, jid, src, opts = {}) {
  return enqueueMedia(async () => {
    const buf = await _resolveSource(src);
    // If already a WebP sticker, send directly
    const info = await detectBuffer(buf).catch(() => null);
    if (info?.mime === "image/webp") {
      return sendSticker(sock, jid, buf, opts);
    }
    // Otherwise create sticker first
    const { auto: autoSticker } = await import("./StickerService.js");
    const stickerBuf = await autoSticker(buf, opts);
    return sendSticker(sock, jid, stickerBuf, opts);
  });
}

/**
 * Send a GIF / animated image.
 */
export async function sendGifMedia(sock, jid, src, opts = {}) {
  return enqueueMedia(async () => {
    const buf = await _resolveSource(src);
    return sendGif(sock, jid, buf, opts);
  });
}

/**
 * Auto-detect media type and send appropriately.
 * The universal send function — commands use this when they don't know the type.
 *
 * @param {object}         sock
 * @param {string}         jid
 * @param {Buffer|string}  src
 * @param {object}         [opts]
 * @param {string}         [opts.caption]
 * @param {string}         [opts.forceType]  - Force a specific type
 * @returns {Promise<object|null>}
 */
export async function sendMedia(sock, jid, src, opts = {}) {
  return enqueueMedia(async () => {
    const buf = await _resolveSource(src);
    const type = opts.forceType || (await detectBuffer(buf).catch(() => null))?.category || "document";

    switch (type) {
      case "image":    return sendImageMedia(sock, jid, buf, opts);
      case "video":    return sendVideoMedia(sock, jid, buf, opts);
      case "audio":    return sendAudioMedia(sock, jid, buf, opts);
      case "sticker":  return sendStickerMedia(sock, jid, buf, opts);
      default:         return sendDocumentMedia(sock, jid, buf, opts);
    }
  });
}

/**
 * Send media from a remote URL.
 * Handles download + MIME detection + send in one call.
 *
 * @param {object}  sock
 * @param {string}  jid
 * @param {string}  url
 * @param {object}  [opts]
 * @returns {Promise<object|null>}
 */
export async function sendFromUrl(sock, jid, url, opts = {}) {
  return sendMedia(sock, jid, url, opts);
}

/**
 * Send an album of media (multiple items).
 *
 * @param {object}           sock
 * @param {string}           jid
 * @param {Array<Buffer|{buffer,caption}>} items
 * @param {object}           [opts]
 * @returns {Promise<object[]>}
 */
export async function sendAlbumMedia(sock, jid, items, opts = {}) {
  return enqueueMedia(() => sendAlbum(sock, jid, items, opts));
}

export default {
  sendImageMedia,
  sendVideoMedia,
  sendAudioMedia,
  sendVoiceMedia,
  sendDocumentMedia,
  sendStickerMedia,
  sendGifMedia,
  sendMedia,
  sendFromUrl,
  sendAlbumMedia,
};
