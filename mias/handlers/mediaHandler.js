/**
 * MIAS — Media Handler  v3
 *
 * Centralized abstraction for sending all media types:
 *  image, video, audio, voice note, sticker, GIF, document, album.
 *
 * v3 improvements:
 *  - Auto-generates jpegThumbnail when not provided (image + video)
 *  - Auto-injects contextInfo / externalAdReply when supplied
 *  - Supports rich media metadata (caption, artwork, source URL)
 *  - Better fallback on failed thumbnail generation
 *  - Quoted reply support on all send functions
 *  - Album improved with configurable delay and partial failures handled
 *
 * Commands never touch Baileys directly.
 * Architecture:  Commands → Handlers → Baileys Adapter → WhatsApp
 */

import {
  fetchBuffer,
  generateImageThumbnail,
  generateVideoThumbnail,
} from "./uploadHandler.js";

// ─── MIME helpers ─────────────────────────────────────────────────────────────

const MIME_MAP = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
  webp: "image/webp", gif: "image/gif",
  mp4: "video/mp4", mkv: "video/x-matroska", mov: "video/quicktime",
  avi: "video/x-msvideo", wmv: "video/x-ms-wmv", flv: "video/x-flv",
  mp3: "audio/mpeg", ogg: "audio/ogg", m4a: "audio/mp4", aac: "audio/aac",
  opus: "audio/ogg; codecs=opus", wav: "audio/wav", flac: "audio/flac",
  pdf: "application/pdf",
  zip: "application/zip", rar: "application/x-rar-compressed",
  "7z": "application/x-7z-compressed",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  txt: "text/plain",
  json: "application/json",
  apk: "application/vnd.android.package-archive",
  ipa: "application/octet-stream",
};

/**
 * Guess MIME type from a filename extension.
 * @param {string} filename
 * @param {string} [fallback="application/octet-stream"]
 * @returns {string}
 */
export function guessMime(filename, fallback = "application/octet-stream") {
  const ext = (filename || "").split(".").pop()?.toLowerCase();
  return MIME_MAP[ext] || fallback;
}

// ─── Source resolver (Buffer | URL | file path) ───────────────────────────────

async function _resolveSource(src) {
  if (!src) throw new Error("Media source is required");
  if (Buffer.isBuffer(src)) return src;
  if (typeof src === "string") {
    if (src.startsWith("http://") || src.startsWith("https://")) {
      return fetchBuffer(src);
    }
    const { readFile } = await import("fs/promises");
    return readFile(src);
  }
  throw new Error("Unsupported media source: expected Buffer, URL string, or file path");
}

// ─── Auto thumbnail helper ────────────────────────────────────────────────────

async function _autoThumb(buf, isVideo = false) {
  if (!Buffer.isBuffer(buf) || buf.length < 100) return null;
  try {
    if (isVideo) return await generateVideoThumbnail(buf);
    return await generateImageThumbnail(buf, { width: 300, height: 150 });
  } catch {
    return null;
  }
}

// ─── ContextInfo / ExternalAdReply builder ────────────────────────────────────

function _buildContextInfo(opts = {}) {
  if (!opts.contextInfo && !opts.externalAdReply && !opts.title && !opts.sourceUrl) return {};
  if (opts.contextInfo) return opts.contextInfo;

  const ext = {};
  if (opts.title || opts.sourceUrl || opts.thumbnail) {
    ext.externalAdReply = {
      title:                opts.title       || "",
      body:                 opts.body        || "",
      sourceUrl:            opts.sourceUrl   || "https://whatsapp.com",
      mediaType:            opts.mediaType   ?? 1,
      thumbnail:            opts.thumbnail   || null,
      renderLargerThumbnail: opts.renderLarger !== false,
      showAdAttribution:    false,
    };
  }
  return Object.keys(ext).length ? ext : {};
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Send an image.
 *
 * @param {object}        sock
 * @param {string}        jid
 * @param {Buffer|string} image       - Buffer, URL, or file path
 * @param {object}        [opts]
 * @param {string}        [opts.caption]
 * @param {string}        [opts.mimetype]
 * @param {object}        [opts.quoted]
 * @param {object}        [opts.contextInfo]     - Full contextInfo override
 * @param {string}        [opts.title]           - Auto-build externalAdReply title
 * @param {string}        [opts.sourceUrl]       - Auto-build externalAdReply sourceUrl
 * @param {Buffer}        [opts.thumbnail]       - Custom JPEG thumbnail (auto-generated if omitted)
 * @param {boolean}       [opts.viewOnce]
 * @param {string[]}      [opts.mentions]
 * @param {boolean}       [opts.autoThumb=true]  - Auto-generate thumbnail if not provided
 * @returns {Promise<object|null>}
 */
export async function sendImage(sock, jid, image, opts = {}) {
  try {
    const buf = await _resolveSource(image);
    const content = {
      image:    buf,
      caption:  opts.caption  || "",
      mimetype: opts.mimetype || "image/jpeg",
    };

    if (opts.viewOnce) content.viewOnce = true;
    if (opts.mentions?.length) content.mentions = opts.mentions;

    // Auto-generate thumbnail if not explicitly supplied
    const autoThumb = opts.autoThumb !== false;
    if (autoThumb && !opts.thumbnail) {
      const thumb = await _autoThumb(buf, false);
      if (thumb) content.jpegThumbnail = thumb;
    } else if (opts.thumbnail) {
      content.jpegThumbnail = opts.thumbnail;
    }

    // ContextInfo
    const ctxInfo = _buildContextInfo(opts);
    if (Object.keys(ctxInfo).length) content.contextInfo = ctxInfo;

    const sendOpts = {};
    if (opts.quoted) sendOpts.quoted = opts.quoted;
    return await sock.sendMessage(jid, content, sendOpts);
  } catch (err) {
    console.error("[sendImage] Error:", err?.message);
    return null;
  }
}

/**
 * Send a video.
 *
 * @param {object}        sock
 * @param {string}        jid
 * @param {Buffer|string} video
 * @param {object}        [opts]
 * @param {string}        [opts.caption]
 * @param {string}        [opts.mimetype]
 * @param {object}        [opts.quoted]
 * @param {Buffer}        [opts.thumbnail]    - Custom thumbnail (auto-generated if omitted)
 * @param {boolean}       [opts.gifPlayback]  - Play as auto-looping GIF
 * @param {boolean}       [opts.viewOnce]
 * @param {object}        [opts.contextInfo]
 * @param {string[]}      [opts.mentions]
 * @param {boolean}       [opts.autoThumb=true]
 * @returns {Promise<object|null>}
 */
export async function sendVideo(sock, jid, video, opts = {}) {
  try {
    let content;
    if (typeof video === "string" && !video.startsWith("http://") && !video.startsWith("https://")) {
      const { stat } = await import("fs/promises");
      const st = await stat(video).catch(() => null);
      if (st && st.size > 90 * 1024 * 1024) {
        return await sendDocument(sock, jid, video, {
          ...opts,
          fileName: opts.fileName || `video_${Date.now()}.mp4`,
          mimetype: opts.mimetype || "video/mp4",
        });
      }
      content = {
        video:    { url: video },
        caption:  opts.caption  || "",
        mimetype: opts.mimetype || "video/mp4",
      };
    } else {
      const buf = await _resolveSource(video);
      if (buf && buf.length > 90 * 1024 * 1024) {
        return await sendDocument(sock, jid, buf, {
          ...opts,
          fileName: opts.fileName || `video_${Date.now()}.mp4`,
          mimetype: opts.mimetype || "video/mp4",
        });
      }
      content = {
        video:    buf,
        caption:  opts.caption  || "",
        mimetype: opts.mimetype || "video/mp4",
      };
    }

    if (opts.gifPlayback) content.gifPlayback = true;
    if (opts.viewOnce)    content.viewOnce    = true;
    if (opts.mentions?.length) content.mentions = opts.mentions;

    const autoThumb = opts.autoThumb !== false;
    if (autoThumb && !opts.thumbnail) {
      const thumb = await _autoThumb(buf, true);
      if (thumb) content.jpegThumbnail = thumb;
    } else if (opts.thumbnail) {
      content.jpegThumbnail = opts.thumbnail;
    }

    const ctxInfo = _buildContextInfo(opts);
    if (Object.keys(ctxInfo).length) content.contextInfo = ctxInfo;

    const sendOpts = {};
    if (opts.quoted) sendOpts.quoted = opts.quoted;
    return await sock.sendMessage(jid, content, sendOpts);
  } catch (err) {
    console.error("[sendVideo] Error:", err?.message);
    return null;
  }
}

/**
 * Send a GIF (video with gifPlayback).
 *
 * @param {object}        sock
 * @param {string}        jid
 * @param {Buffer|string} gif
 * @param {object}        [opts]
 */
export async function sendGif(sock, jid, gif, opts = {}) {
  return sendVideo(sock, jid, gif, {
    ...opts,
    mimetype:    opts.mimetype || "video/mp4",
    gifPlayback: true,
  });
}

/**
 * Send an audio message.
 *
 * @param {object}        sock
 * @param {string}        jid
 * @param {Buffer|string} audio
 * @param {object}        [opts]
 * @param {string}        [opts.mimetype]
 * @param {object}        [opts.quoted]
 * @param {boolean}       [opts.ptt]       - Send as voice note / PTT
 * @param {number}        [opts.seconds]   - Duration hint in seconds
 */
export async function sendAudio(sock, jid, audio, opts = {}) {
  try {
    let content;
    if (typeof audio === "string" && !audio.startsWith("http://") && !audio.startsWith("https://")) {
      content = {
        audio:    { url: audio },
        mimetype: opts.mimetype || "audio/mpeg",
      };
    } else {
      const buf = await _resolveSource(audio);
      content = {
        audio:    buf,
        mimetype: opts.mimetype || "audio/mpeg",
      };
    }
    if (opts.ptt)     content.ptt     = true;
    if (opts.seconds) content.seconds = opts.seconds;

    const sendOpts = {};
    if (opts.quoted) sendOpts.quoted = opts.quoted;
    return await sock.sendMessage(jid, content, sendOpts);
  } catch (err) {
    console.error("[sendAudio] Error:", err?.message);
    return null;
  }
}

/**
 * Send a voice note (PTT audio).
 */
export async function sendVoiceNote(sock, jid, audio, opts = {}) {
  return sendAudio(sock, jid, audio, {
    ...opts,
    mimetype: opts.mimetype || "audio/ogg; codecs=opus",
    ptt:      true,
  });
}

/**
 * Send a sticker.
 *
 * @param {object}        sock
 * @param {string}        jid
 * @param {Buffer|string} sticker  - WebP buffer, URL, or file path
 * @param {object}        [opts]
 * @param {object}        [opts.quoted]
 * @param {object}        [opts.contextInfo]
 */
export async function sendSticker(sock, jid, sticker, opts = {}) {
  try {
    const buf = await _resolveSource(sticker);
    const content = { sticker: buf, mimetype: "image/webp" };

    const ctxInfo = _buildContextInfo(opts);
    if (Object.keys(ctxInfo).length) content.contextInfo = ctxInfo;

    const sendOpts = {};
    if (opts.quoted) sendOpts.quoted = opts.quoted;
    return await sock.sendMessage(jid, content, sendOpts);
  } catch (err) {
    console.error("[sendSticker] Error:", err?.message);
    return null;
  }
}

/**
 * Send a document / file.
 *
 * @param {object}        sock
 * @param {string}        jid
 * @param {Buffer|string} document
 * @param {object}        [opts]
 * @param {string}        [opts.filename]
 * @param {string}        [opts.mimetype]
 * @param {string}        [opts.caption]
 * @param {object}        [opts.quoted]
 * @param {Buffer}        [opts.thumbnail]  - Auto-generated for images/videos if omitted
 * @param {object}        [opts.contextInfo]
 */
export async function sendDocument(sock, jid, document, opts = {}) {
  try {
    let content;
    const filename = opts.filename || opts.fileName || (typeof document === "string" ? document.split("/").pop() : "file");
    const mimetype = opts.mimetype || guessMime(filename, "application/octet-stream");
    if (typeof document === "string" && !document.startsWith("http://") && !document.startsWith("https://")) {
      content = {
        document: { url: document },
        filename,
        mimetype,
        caption:  opts.caption  || "",
      };
    } else {
      const buf = await _resolveSource(document);
      content = {
        document: buf,
        filename,
        mimetype,
        caption:  opts.caption  || "",
      };
    }

    if (opts.thumbnail) content.jpegThumbnail = opts.thumbnail;

    const ctxInfo = _buildContextInfo(opts);
    if (Object.keys(ctxInfo).length) content.contextInfo = ctxInfo;

    const sendOpts = {};
    if (opts.quoted) sendOpts.quoted = opts.quoted;
    return await sock.sendMessage(jid, content, sendOpts);
  } catch (err) {
    console.error("[sendDocument] Error:", err?.message);
    return null;
  }
}

/**
 * Send a media file from a URL — auto-detects type.
 *
 * @param {object} sock
 * @param {string} jid
 * @param {string} url
 * @param {object} [opts]
 * @param {"image"|"video"|"audio"|"document"|"sticker"} [opts.type]  - Auto-detected if omitted
 * @param {string} [opts.caption]
 * @param {string} [opts.filename]
 * @param {object} [opts.quoted]
 */
export async function sendMediaFromUrl(sock, jid, url, opts = {}) {
  try {
    const buf  = await fetchBuffer(url);
    const mime = opts.mimetype || guessMime(url.split("?")[0], "application/octet-stream");
    const type = opts.type || _typeFromMime(mime);

    switch (type) {
      case "image":    return sendImage(sock, jid, buf, { ...opts, mimetype: mime });
      case "video":    return sendVideo(sock, jid, buf, { ...opts, mimetype: mime });
      case "audio":    return sendAudio(sock, jid, buf, { ...opts, mimetype: mime });
      case "sticker":  return sendSticker(sock, jid, buf, opts);
      default:         return sendDocument(sock, jid, buf, { ...opts, mimetype: mime });
    }
  } catch (err) {
    console.error("[sendMediaFromUrl] Error:", err?.message);
    return null;
  }
}

function _typeFromMime(mime = "") {
  if (mime.startsWith("image/webp")) return "sticker";
  if (mime.startsWith("image/"))     return "image";
  if (mime.startsWith("video/"))     return "video";
  if (mime.startsWith("audio/"))     return "audio";
  return "document";
}

/**
 * Send an album — a sequence of images/videos.
 * Each item is sent individually with a small delay.
 *
 * @param {object}   sock
 * @param {string}   jid
 * @param {object[]} items
 * @param {"image"|"video"} items[].type
 * @param {Buffer|string}   items[].data
 * @param {string}          [items[].caption]
 * @param {object}   [opts]
 * @param {string}   [opts.caption]    - Caption for first item (if item has none)
 * @param {object}   [opts.quoted]
 * @param {number}   [opts.delayMs=200]
 * @returns {Promise<void>}
 */
export async function sendAlbum(sock, jid, items, opts = {}) {
  if (!items?.length) return;
  const delay = opts.delayMs ?? 200;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const itemOpts = {
      caption: i === 0
        ? (item.caption || opts.caption || "")
        : (item.caption || ""),
      quoted:  i === 0 ? opts.quoted : undefined,
    };
    try {
      if (item.type === "video") {
        await sendVideo(sock, jid, item.data, itemOpts);
      } else {
        await sendImage(sock, jid, item.data, itemOpts);
      }
    } catch (err) {
      console.error(`[sendAlbum] Item ${i} failed:`, err?.message);
    }
    if (i < items.length - 1 && delay > 0) {
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

/**
 * Prepare a JPEG thumbnail Buffer from an image source.
 *
 * @param {Buffer|string} image
 * @param {object}        [opts]
 * @param {number}        [opts.width=300]
 * @param {number}        [opts.height=150]
 * @returns {Promise<Buffer|null>}
 */
export async function prepareThumbnail(image, opts = {}) {
  try {
    const buf = await _resolveSource(image);
    return await generateImageThumbnail(buf, opts);
  } catch {
    return null;
  }
}

/**
 * Build a prepareExternalAdReply contextInfo object.
 * Named export so commands can use it for enriched messages.
 *
 * @param {object} opts
 * @param {string} [opts.title]
 * @param {string} [opts.body]
 * @param {string} [opts.sourceUrl]
 * @param {Buffer} [opts.thumbnail]
 * @param {number} [opts.mediaType=1]
 * @returns {object}
 */
export function prepareExternalAdReply(opts = {}) {
  return {
    externalAdReply: {
      title:                opts.title       || "",
      body:                 opts.body        || "",
      sourceUrl:            opts.sourceUrl   || "https://whatsapp.com",
      mediaType:            opts.mediaType   ?? 1,
      thumbnail:            opts.thumbnail   || null,
      renderLargerThumbnail: opts.renderLarger !== false,
      showAdAttribution:    false,
    },
  };
}

/**
 * Alias: prepare a contextInfo with externalAdReply.
 * Matches the name exposed from baileysHandler.js.
 * @param {object} opts
 * @returns {object}
 */
export function prepareContextInfo(opts = {}) {
  return prepareExternalAdReply(opts);
}
