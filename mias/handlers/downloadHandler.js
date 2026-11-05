/**
 * MIAS — Download Handler  v2
 *
 * Centralized media download abstraction.
 * Commands must never call downloadContentFromMessage directly.
 *
 * Architecture:  Commands → Handlers → Baileys Adapter → WhatsApp
 */

import { downloadContentFromMessage as _dlContent, getContentType } from "./gktwAdapter.js";
import { fetchBuffer } from "./uploadHandler.js";
import messageContent from "../lib/messageContent.cjs";

const { unwrapMessage, getContextInfo, findMediaNode } = messageContent;

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** Maps Baileys message keys to their media type strings */
const TYPE_MAP = {
  imageMessage:    "image",
  videoMessage:    "video",
  audioMessage:    "audio",
  documentMessage: "document",
  stickerMessage:  "sticker",
  ptvMessage:      "video",   // picture-in-picture video
};

/** Unwrap nested message wrappers (ephemeral, device-sent, viewOnce, edit, documentWithCaption) */
function _unwrap(message = {}) {
  return unwrapMessage(message);
}

async function _streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk instanceof Uint8Array ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function _downloadContent(msgContent, baileysType) {
  const stream = await _dlContent(msgContent, baileysType);
  return _streamToBuffer(stream);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Download media from a WAMessage object.
 *
 * @param {object} msg          - WAMessage (the full message object)
 * @param {string} [mediaType]  - "image"|"video"|"audio"|"document"|"sticker"
 *                                (auto-detected if omitted)
 * @returns {Promise<Buffer|null>}
 */
export async function downloadMedia(msg, mediaType) {
  try {
    const raw = msg?.message;
    if (!raw) return null;

    // Unwrap nested message types (ephemeral, device-sent, etc.)
    const m = _unwrap(raw);

    // Prefer the actual message node so document-wrapped images are fetched
    // with Baileys' "document" transport while still being recognized as images.
    const mediaNode = findMediaNode(m);
    if (
      mediaNode &&
      (!mediaType || mediaType === mediaNode.type || mediaType === mediaNode.messageType || mediaType === mediaNode.downloadType)
    ) {
      return await _downloadContent(mediaNode.content, mediaNode.downloadType);
    }

    // Determine content type
    const type = mediaType ||
      (await getContentType(m)) ||
      Object.keys(m).find(k => TYPE_MAP[k]) ||
      Object.keys(m)[0];

    const baileysType = TYPE_MAP[type] || type?.replace?.("Message", "") || "image";
    const msgContent  = m[type] || m;

    if (!msgContent || typeof msgContent !== "object") return null;

    return await _downloadContent(msgContent, baileysType);
  } catch (err) {
    console.error("[downloadMedia] Error:", err?.message);
    return null;
  }
}

/**
 * Download media from a quoted (replied-to) message.
 *
 * @param {object} msg   - WAMessage that quotes another
 * @returns {Promise<{buffer: Buffer, type: string}|null>}
 */
export async function downloadQuotedMedia(msg) {
  try {
    const raw = msg?.message;
    if (!raw) return null;

    const quotedMsg = getContextInfo(msg)?.quotedMessage || msg?.quoted?.message || msg?.quoted?.msg;
    if (!quotedMsg) return null;

    const mediaNode = findMediaNode(quotedMsg);
    if (!mediaNode) return null;

    const buffer = await _downloadContent(mediaNode.content, mediaNode.downloadType);
    return {
      buffer,
      type: mediaNode.type,
      messageType: mediaNode.messageType,
      mimetype: mediaNode.mimetype,
      fileName: mediaNode.fileName,
    };
  } catch (err) {
    console.error("[downloadQuotedMedia] Error:", err?.message);
    return null;
  }
}

/**
 * Download a view-once message, bypassing the restriction.
 *
 * @param {object} msg   - WAMessage containing a view-once message
 * @returns {Promise<{buffer: Buffer, type: string}|null>}
 */
export async function downloadViewOnce(msg) {
  try {
    const raw = msg?.message;
    if (!raw) return null;

    // View-once wrappers
    const wrapper =
      raw.viewOnceMessage ||
      raw.viewOnceMessageV2 ||
      raw.viewOnceMessageV2Extension;

    const inner = _unwrap(wrapper?.message || raw);
    const type  = Object.keys(inner).find(k => TYPE_MAP[k]) || Object.keys(inner)[0];
    if (!type) return null;

    const baileysType = TYPE_MAP[type] || type.replace("Message", "");
    const content = inner[type];
    if (!content) return null;

    const buffer = await _downloadContent(content, baileysType);
    return { buffer, type: baileysType };
  } catch (err) {
    console.error("[downloadViewOnce] Error:", err?.message);
    return null;
  }
}

/**
 * Fetch a remote URL into a Buffer (re-export for convenience).
 * @param {string} url
 * @param {object} [opts]
 * @returns {Promise<Buffer>}
 */
export { fetchBuffer };

/**
 * Alias for fetchBuffer — download any URL to a Buffer.
 * @param {string} url
 * @param {object} [opts]
 * @returns {Promise<Buffer>}
 */
export async function downloadFromUrl(url, opts = {}) {
  return fetchBuffer(url, opts);
}

/**
 * Get the content type string of a message.
 * @param {object} msg  - WAMessage (full object)
 * @returns {Promise<string|null>}
 */
export async function getMessageType(msg) {
  try {
    const raw = msg?.message;
    if (!raw) return null;
    const m = _unwrap(raw);
    return findMediaNode(m)?.messageType || (await getContentType(m)) || Object.keys(m)[0] || null;
  } catch {
    return null;
  }
}

/**
 * Check whether a message contains media that can be downloaded.
 * @param {object} msg - WAMessage (full object)
 * @returns {boolean}
 */
export function hasMedia(msg) {
  try {
    return Boolean(findMediaNode(msg?.message || {}));
  } catch {
    return false;
  }
}
