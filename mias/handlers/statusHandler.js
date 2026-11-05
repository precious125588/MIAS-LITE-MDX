/**
 * MIAS — Status Handler  v2
 *
 * Centralized WhatsApp Status (Story) posting abstraction.
 * Commands must never post statuses directly via sock.sendMessage.
 *
 * Now routes through gktwAdapter instead of importing Baileys directly.
 *
 * Architecture:  Commands → Handlers → Baileys Adapter → WhatsApp
 */

import { jidNormalizedUser } from "./gktwAdapter.js";
import { fetchBuffer } from "./uploadHandler.js";

// ─── Constants ────────────────────────────────────────────────────────────────
const STATUS_JID = "status@broadcast";

// ─── Internal helper ──────────────────────────────────────────────────────────

async function _normalizeJid(jid) {
  try {
    return await jidNormalizedUser(jid);
  } catch {
    const str = String(jid || "");
    const at = str.indexOf("@");
    if (at === -1) return `${str}@s.whatsapp.net`;
    return `${str.slice(0, at)}@s.whatsapp.net`;
  }
}

async function _resolveSource(src) {
  if (Buffer.isBuffer(src)) return src;
  if (typeof src === "string") return fetchBuffer(src);
  throw new Error("Invalid media source: expected Buffer or URL string");
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Get audience JIDs for a status post (normalises the contact list).
 *
 * @param {string[]} jids   - JID list of status viewers
 * @returns {Promise<string[]>}
 */
export async function getStatusAudience(jids = []) {
  const normalized = [];
  for (const jid of jids) {
    try {
      normalized.push(await _normalizeJid(jid));
    } catch {
      normalized.push(jid);
    }
  }
  return normalized;
}

/**
 * Post a text status (story).
 *
 * @param {object}   sock
 * @param {string}   text
 * @param {object}   [opts]
 * @param {string}   [opts.backgroundColor]  - hex color e.g. "#075E54"
 * @param {number}   [opts.font]             - Font index 0–9
 * @param {string[]} [opts.audience]         - JIDs who can see the status
 * @returns {Promise<object|null>}
 */
export async function postTextStatus(sock, text, opts = {}) {
  try {
    const content = {
      text: String(text || ""),
      backgroundColor: opts.backgroundColor || "#075E54",
      font: opts.font ?? 0,
    };
    const sendOpts = {};
    if (opts.audience?.length) {
      sendOpts.statusJidList = await getStatusAudience(opts.audience);
    }
    return await sock.sendMessage(STATUS_JID, content, sendOpts);
  } catch (err) {
    console.error("[postTextStatus] Error:", err?.message);
    return null;
  }
}

/**
 * Post an image status (story).
 *
 * @param {object}        sock
 * @param {Buffer|string} image       - Buffer or URL
 * @param {object}        [opts]
 * @param {string}        [opts.caption]
 * @param {string}        [opts.mimetype]
 * @param {string[]}      [opts.audience]
 * @returns {Promise<object|null>}
 */
export async function postImageStatus(sock, image, opts = {}) {
  try {
    const buf = await _resolveSource(image);
    const content = {
      image: buf,
      caption: opts.caption || "",
      mimetype: opts.mimetype || "image/jpeg",
    };

    const sendOpts = {};
    if (opts.audience?.length) {
      sendOpts.statusJidList = await getStatusAudience(opts.audience);
    }
    return await sock.sendMessage(STATUS_JID, content, sendOpts);
  } catch (err) {
    console.error("[postImageStatus] Error:", err?.message);
    return null;
  }
}

/**
 * Post a video status (story).
 *
 * @param {object}        sock
 * @param {Buffer|string} video
 * @param {object}        [opts]
 * @param {string}        [opts.caption]
 * @param {string}        [opts.mimetype]
 * @param {string[]}      [opts.audience]
 * @returns {Promise<object|null>}
 */
export async function postVideoStatus(sock, video, opts = {}) {
  try {
    const buf = await _resolveSource(video);
    const content = {
      video: buf,
      caption: opts.caption || "",
      mimetype: opts.mimetype || "video/mp4",
    };

    const sendOpts = {};
    if (opts.audience?.length) {
      sendOpts.statusJidList = await getStatusAudience(opts.audience);
    }
    return await sock.sendMessage(STATUS_JID, content, sendOpts);
  } catch (err) {
    console.error("[postVideoStatus] Error:", err?.message);
    return null;
  }
}

/**
 * Post an audio status (story).
 *
 * @param {object}        sock
 * @param {Buffer|string} audio
 * @param {object}        [opts]
 * @param {string}        [opts.mimetype]
 * @param {string[]}      [opts.audience]
 * @returns {Promise<object|null>}
 */
export async function postAudioStatus(sock, audio, opts = {}) {
  try {
    const buf = await _resolveSource(audio);
    const content = {
      audio: buf,
      mimetype: opts.mimetype || "audio/mpeg",
      ptt: false,
    };

    const sendOpts = {};
    if (opts.audience?.length) {
      sendOpts.statusJidList = await getStatusAudience(opts.audience);
    }
    return await sock.sendMessage(STATUS_JID, content, sendOpts);
  } catch (err) {
    console.error("[postAudioStatus] Error:", err?.message);
    return null;
  }
}

/**
 * Post a sticker status (story).
 *
 * @param {object}        sock
 * @param {Buffer|string} sticker     - WebP buffer or URL
 * @param {object}        [opts]
 * @param {string[]}      [opts.audience]
 * @returns {Promise<object|null>}
 */
export async function postStickerStatus(sock, sticker, opts = {}) {
  try {
    const buf = await _resolveSource(sticker);
    const content = {
      sticker: buf,
      mimetype: "image/webp",
    };

    const sendOpts = {};
    if (opts.audience?.length) {
      sendOpts.statusJidList = await getStatusAudience(opts.audience);
    }
    return await sock.sendMessage(STATUS_JID, content, sendOpts);
  } catch (err) {
    console.error("[postStickerStatus] Error:", err?.message);
    return null;
  }
}

/**
 * Post a document status (story).
 *
 * @param {object}        sock
 * @param {Buffer|string} document
 * @param {object}        [opts]
 * @param {string}        [opts.caption]
 * @param {string}        [opts.mimetype]
 * @param {string}        [opts.filename]
 * @param {string[]}      [opts.audience]
 * @returns {Promise<object|null>}
 */
export async function postDocumentStatus(sock, document, opts = {}) {
  try {
    const buf = await _resolveSource(document);
    const content = {
      document: buf,
      caption: opts.caption || "",
      mimetype: opts.mimetype || "application/pdf",
      fileName: opts.filename || "document.pdf",
    };

    const sendOpts = {};
    if (opts.audience?.length) {
      sendOpts.statusJidList = await getStatusAudience(opts.audience);
    }
    return await sock.sendMessage(STATUS_JID, content, sendOpts);
  } catch (err) {
    console.error("[postDocumentStatus] Error:", err?.message);
    return null;
  }
}
