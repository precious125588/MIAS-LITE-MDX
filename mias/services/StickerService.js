/**
 * MIAS — Sticker Service
 *
 * Centralized sticker creation and metadata.
 * Wraps wa-sticker-formatter internally.
 *
 * Architecture: Commands → StickerService → StickerEngine (wa-sticker-formatter) → Buffer
 */

import engineRegistryModule from "../lib/engineRegistry.cjs";
import { enqueueMedia } from "./QueueService.js";

const _engine = engineRegistryModule.getEngineRegistry().get("sticker");

const DEFAULT_METADATA = {
  pack:   process.env.STICKER_PACK_NAME   || "MIAS",
  author: process.env.STICKER_AUTHOR_NAME || "MIAS Bot",
};

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Create a static (non-animated) sticker from any media.
 *
 * @param {Buffer|string} input  - Buffer or URL/path
 * @param {object}        [opts]
 * @param {string}        [opts.pack]    - Sticker pack name
 * @param {string}        [opts.author] - Pack author
 * @param {string}        [opts.type]   - "full"|"cropped" (default "full")
 * @param {number}        [opts.quality]
 * @returns {Promise<Buffer>}
 */
export async function create(input, opts = {}) {
  return enqueueMedia(async () => {
    if (!_engine) throw new Error("StickerService: sticker engine not available");
    return _engine.createStaticSticker(input, { ...DEFAULT_METADATA, ...opts });
  });
}

/**
 * Create an animated (WebP) sticker.
 *
 * @param {Buffer|string} input
 * @param {object}        [opts]
 * @returns {Promise<Buffer>}
 */
export async function createAnimated(input, opts = {}) {
  return enqueueMedia(async () => {
    if (!_engine) throw new Error("StickerService: sticker engine not available");
    return _engine.createAnimatedSticker(input, { ...DEFAULT_METADATA, ...opts });
  });
}

/**
 * Auto-detect whether input should be animated.
 * Uses createAnimated for video/GIF, createStatic otherwise.
 *
 * @param {Buffer|string} input
 * @param {object}        [opts]
 * @returns {Promise<Buffer>}
 */
export async function auto(input, opts = {}) {
  return enqueueMedia(async () => {
    if (!_engine) throw new Error("StickerService: sticker engine not available");
    const buf = Buffer.isBuffer(input) ? input : null;
    // Check for GIF/video signature
    let isAnimated = false;
    if (buf && buf.length > 6) {
      const head = buf.slice(0, 6).toString("binary");
      isAnimated = head.startsWith("GIF8") ||
        buf.slice(0, 4).toString("hex") === "1a45dfa3"; // WebM/MKV
    }
    if (isAnimated) return _engine.createAnimatedSticker(input, { ...DEFAULT_METADATA, ...opts });
    return _engine.createStaticSticker(input, { ...DEFAULT_METADATA, ...opts });
  });
}

/**
 * Extract metadata from a WebP sticker buffer.
 * @param {Buffer} buffer
 * @returns {Promise<object>}
 */
export async function getMetadata(buffer) {
  if (!_engine?.getStickerMetadata) throw new Error("StickerService: sticker engine not available");
  return _engine.getStickerMetadata(buffer);
}

/**
 * Send a sticker through a Baileys socket.
 * @param {object} sock
 * @param {string} jid
 * @param {Buffer|string} input
 * @param {object} [opts]
 */
export async function send(sock, jid, input, opts = {}) {
  const stickerBuf = opts.animated ? await createAnimated(input, opts) : await create(input, opts);
  return sock.sendMessage(jid, { sticker: stickerBuf }, opts.quoted ? { quoted: opts.quoted } : {});
}

export default { create, createAnimated, auto, getMetadata, send };
