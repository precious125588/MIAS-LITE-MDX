/**
 * MIAS — Image Service
 *
 * Centralized image processing.
 * Prefers Sharp internally, auto-falls back to Jimp.
 * No command should import sharp or jimp directly.
 *
 * Architecture: Commands → ImageService → ImageEngine (sharp/jimp) → Buffer
 */

import engineRegistryModule from "../lib/engineRegistry.cjs";
import { enqueueImage } from "./QueueService.js";

const _engine = engineRegistryModule.getEngineRegistry().get("image");

// ─── Sharp fallback ───────────────────────────────────────────────────────────

let _sharp = null;
async function _getSharp() {
  if (_sharp !== undefined) return _sharp;
  try {
    const s = await import("sharp");
    _sharp = s.default || s;
  } catch { _sharp = null; }
  return _sharp;
}

// ─── Core: resize ─────────────────────────────────────────────────────────────

/**
 * Resize an image buffer.
 * Queued automatically via the image queue (concurrency: 2).
 *
 * @param {Buffer} buffer
 * @param {number} width
 * @param {number} [height]
 * @param {object} [opts]
 * @param {string} [opts.mime="image/jpeg"]
 * @param {number} [opts.quality=82]
 * @param {string} [opts.fit="cover"]  - sharp fit mode
 * @returns {Promise<Buffer>}
 */
export async function resize(buffer, width, height, opts = {}) {
  return enqueueImage(async () => {
    // Try Jimp engine first
    if (_engine?.resize) {
      try { return await _engine.resize(buffer, width, height ?? null, opts); } catch {}
    }
    // Try Sharp
    const sharp = await _getSharp();
    if (sharp) {
      try {
        return await sharp(buffer)
          .resize(width, height || null, { fit: opts.fit || "cover" })
          .jpeg({ quality: opts.quality ?? 82 })
          .toBuffer();
      } catch {}
    }
    // Return original (no-op fallback)
    return buffer;
  });
}

/**
 * Optimize an image (compress + resize if too large).
 * @param {Buffer} buffer
 * @param {object} [opts]
 * @param {number} [opts.maxWidth=1920]
 * @param {number} [opts.quality=82]
 * @param {string} [opts.mime]
 * @returns {Promise<Buffer>}
 */
export async function optimize(buffer, opts = {}) {
  return enqueueImage(async () => {
    if (_engine?.optimize) {
      try { return await _engine.optimize(buffer, opts); } catch {}
    }
    const sharp = await _getSharp();
    if (sharp) {
      try {
        const maxW = opts.maxWidth || 1920;
        let s = sharp(buffer);
        const meta = await s.metadata();
        if (meta.width > maxW) s = s.resize(maxW);
        return await s.jpeg({ quality: opts.quality ?? 82 }).toBuffer();
      } catch {}
    }
    return buffer;
  });
}

/**
 * Crop an image.
 * @param {Buffer} buffer
 * @param {number} x
 * @param {number} y
 * @param {number} width
 * @param {number} height
 * @param {object} [opts]
 * @returns {Promise<Buffer>}
 */
export async function crop(buffer, x, y, width, height, opts = {}) {
  return enqueueImage(async () => {
    if (_engine?.crop) {
      try { return await _engine.crop(buffer, x, y, width, height, opts); } catch {}
    }
    const sharp = await _getSharp();
    if (sharp) {
      return sharp(buffer).extract({ left: x, top: y, width, height })
        .jpeg({ quality: opts.quality ?? 82 }).toBuffer();
    }
    return buffer;
  });
}

/**
 * Blur an image.
 * @param {Buffer} buffer
 * @param {number} [radius=5]
 * @param {object} [opts]
 * @returns {Promise<Buffer>}
 */
export async function blur(buffer, radius = 5, opts = {}) {
  return enqueueImage(async () => {
    if (_engine?.blur) {
      try { return await _engine.blur(buffer, radius, opts); } catch {}
    }
    const sharp = await _getSharp();
    if (sharp) {
      return sharp(buffer).blur(Math.min(radius, 100)).jpeg({ quality: opts.quality ?? 82 }).toBuffer();
    }
    return buffer;
  });
}

/**
 * Add a watermark to an image.
 * @param {Buffer} buffer
 * @param {Buffer} watermark
 * @param {object} [opts]
 * @returns {Promise<Buffer>}
 */
export async function watermark(buffer, watermarkBuf, opts = {}) {
  return enqueueImage(async () => {
    if (_engine?.watermark) {
      try { return await _engine.watermark(buffer, watermarkBuf, opts); } catch {}
    }
    const sharp = await _getSharp();
    if (sharp) {
      return sharp(buffer)
        .composite([{ input: watermarkBuf, gravity: opts.gravity || "southeast" }])
        .jpeg({ quality: opts.quality ?? 82 })
        .toBuffer();
    }
    return buffer;
  });
}

/**
 * Apply multiple image operations in sequence.
 * @param {Buffer} buffer
 * @param {object} operations
 * @param {object} [operations.resize]   - { width, height }
 * @param {object} [operations.crop]     - { x, y, width, height }
 * @param {number} [operations.blur]
 * @param {string} [operations.mime]
 * @param {number} [operations.quality]
 * @returns {Promise<Buffer>}
 */
export async function process(buffer, operations = {}) {
  return enqueueImage(async () => {
    if (_engine?.processImage) {
      try { return await _engine.processImage(buffer, operations); } catch {}
    }
    // Manual fallback chain
    let buf = buffer;
    if (operations.resize) buf = await resize(buf, operations.resize.width, operations.resize.height, operations);
    if (operations.crop) buf = await crop(buf, operations.crop.x || 0, operations.crop.y || 0, operations.crop.width, operations.crop.height, operations);
    if (operations.blur) buf = await blur(buf, operations.blur, operations);
    return buf;
  });
}

/**
 * Convert an image buffer to a different format.
 * @param {Buffer} buffer
 * @param {"jpeg"|"png"|"webp"} format
 * @param {object} [opts]
 * @returns {Promise<Buffer>}
 */
export async function convert(buffer, format = "jpeg", opts = {}) {
  return enqueueImage(async () => {
    const sharp = await _getSharp();
    if (sharp) {
      return sharp(buffer)[format]({ quality: opts.quality ?? 90 }).toBuffer();
    }
    return buffer;
  });
}

export default { resize, optimize, crop, blur, watermark, process, convert };
