/**
 * MIAS — Thumbnail Service
 *
 * Centralized thumbnail generation for images, videos, audio, and cards.
 * Every outgoing media automatically gets a thumbnail via MediaService.
 * Commands should never generate thumbnails manually.
 *
 * Architecture: Commands → ThumbnailService → ImageEngine / ffmpeg → Buffer
 */

import engineRegistryModule from "../lib/engineRegistry.cjs";
import { enqueueThumbnail } from "./QueueService.js";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

const _imageEngine = engineRegistryModule.getEngineRegistry().get("image");

// ─── Internal: Sharp fallback ─────────────────────────────────────────────────

let _sharp = null;
async function _getSharp() {
  if (_sharp !== undefined) return _sharp;
  try { const s = await import("sharp"); _sharp = s.default || s; }
  catch { _sharp = null; }
  return _sharp;
}

// ─── Internal: ffmpeg video thumbnail ─────────────────────────────────────────

async function _ffmpegVideoThumb(videoBuffer, opts = {}) {
  const { createWriteStream, existsSync } = await import("fs");
  const { unlink, writeFile, readFile } = await import("fs/promises");
  const { tmpdir } = await import("os");
  const { join, extname } = await import("path");
  const tmpIn  = join(tmpdir(), `mias_vthumb_${Date.now()}.mp4`);
  const tmpOut = join(tmpdir(), `mias_vthumb_${Date.now()}.jpg`);
  try {
    await writeFile(tmpIn, videoBuffer);
    const ffmpegPath = (() => { try { return require("ffmpeg-static"); } catch { return "ffmpeg"; } })();
    const { execFile } = await import("child_process");
    await new Promise((resolve, reject) => {
      execFile(ffmpegPath, [
        "-i", tmpIn,
        "-ss", String(opts.offsetSec || 1),
        "-frames:v", "1",
        "-vf", `scale=${opts.width || 300}:-1`,
        tmpOut, "-y",
      ], { timeout: 15000 }, (err) => {
        if (err) reject(err); else resolve();
      });
    });
    return await readFile(tmpOut);
  } finally {
    try { await unlink(tmpIn); } catch {}
    try { await unlink(tmpOut); } catch {}
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Generate a JPEG thumbnail from an image buffer.
 * Uses Jimp engine first, then Sharp, then returns original.
 *
 * @param {Buffer} imageBuf
 * @param {object} [opts]
 * @param {number} [opts.width=300]
 * @param {number} [opts.height=150]
 * @param {number} [opts.quality=75]
 * @returns {Promise<Buffer|null>}
 */
export async function fromImage(imageBuf, opts = {}) {
  if (!Buffer.isBuffer(imageBuf) || imageBuf.length < 100) return null;
  return enqueueThumbnail(async () => {
    const w = opts.width  ?? 300;
    const h = opts.height ?? 150;
    // Jimp engine
    if (_imageEngine?.resize) {
      try {
        return await _imageEngine.resize(imageBuf, w, h, {
          mime: "image/jpeg",
          quality: opts.quality ?? 75,
        });
      } catch {}
    }
    // Sharp
    const sharp = await _getSharp();
    if (sharp) {
      try {
        return await sharp(imageBuf)
          .resize(w, h, { fit: "cover" })
          .jpeg({ quality: opts.quality ?? 75 })
          .toBuffer();
      } catch {}
    }
    return imageBuf;
  });
}

/**
 * Generate a JPEG thumbnail from a video buffer.
 * Uses ffmpeg internally.
 *
 * @param {Buffer} videoBuf
 * @param {object} [opts]
 * @param {number} [opts.width=300]
 * @param {number} [opts.offsetSec=1]  - Time offset in seconds
 * @returns {Promise<Buffer|null>}
 */
export async function fromVideo(videoBuf, opts = {}) {
  if (!Buffer.isBuffer(videoBuf) || videoBuf.length < 1000) return null;
  return enqueueThumbnail(async () => {
    try { return await _ffmpegVideoThumb(videoBuf, opts); }
    catch { return null; }
  });
}

/**
 * Auto-detect and generate thumbnail for any media.
 * @param {Buffer} buffer
 * @param {"image"|"video"|"audio"|"document"} [kind]
 * @param {object} [opts]
 * @returns {Promise<Buffer|null>}
 */
export async function autoThumb(buffer, kind, opts = {}) {
  if (!Buffer.isBuffer(buffer)) return null;
  const t = String(kind || "").toLowerCase();
  if (t === "video") return fromVideo(buffer, opts);
  if (t === "image") return fromImage(buffer, opts);
  return null;
}

/**
 * Generate a hero card thumbnail (square crop, larger).
 * @param {Buffer} imageBuf
 * @param {object} [opts]
 * @param {number} [opts.size=512]
 * @returns {Promise<Buffer|null>}
 */
export async function heroCard(imageBuf, opts = {}) {
  const sz = opts.size || 512;
  return fromImage(imageBuf, { width: sz, height: sz, quality: opts.quality ?? 85 });
}

export default { fromImage, fromVideo, autoThumb, heroCard };
