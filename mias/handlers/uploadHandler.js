/**
 * MIAS — Upload Handler  v2
 *
 * Centralized media upload and thumbnail generation.
 * Supports HTTP fetch (with retry), image thumbnail (Jimp/sharp),
 * and video thumbnail (ffmpeg).
 *
 * Architecture:  Commands → Handlers → Baileys Adapter → WhatsApp
 */

import { createWriteStream } from "fs";
import { unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  httpClient,
  image as imageEngine,
} from "../lib/engineAccess.js";

// ─── Simple LRU cache for upload results ─────────────────────────────────────

const CACHE_MAX = 200;
const _uploadCache = new Map();

function _cacheGet(key) {
  return _uploadCache.get(key) ?? null;
}

function _cacheSet(key, value) {
  if (_uploadCache.size >= CACHE_MAX) {
    const oldest = _uploadCache.keys().next().value;
    _uploadCache.delete(oldest);
  }
  _uploadCache.set(key, value);
}

// ─── HTTP fetch ───────────────────────────────────────────────────────────────

/**
 * Fetch a remote URL into a Buffer.
 * Retries up to `opts.retries` times on failure.
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=30000]
 * @param {object} [opts.headers]
 * @param {number} [opts.retries=2]       - Number of retry attempts on failure
 * @param {boolean}[opts.noCache]         - Skip the URL cache
 * @returns {Promise<Buffer>}
 */
export async function fetchBuffer(url, opts = {}) {
  const cachedKey = `fetch:${url}`;
  if (!opts.noCache) {
    const cached = _cacheGet(cachedKey);
    if (cached) return cached;
  }

  const timeout   = opts.timeoutMs ?? 30_000;
  const maxRetries = opts.retries ?? 2;

  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await httpClient.get(url, {
        timeout,
        signal: controller.signal,
        headers: {
          "User-Agent": "MIAS-Bot/5.3 (+https://github.com/precious125588/fantastic-waddle)",
          ...(opts.headers || {}),
        },
        responseType: "arraybuffer",
        maxContentLength: opts.maxBytes || 50 * 1024 * 1024,
        maxBodyLength: opts.maxBytes || 50 * 1024 * 1024,
      });

      const buf = Buffer.isBuffer(response.data)
        ? response.data
        : Buffer.from(response.data);
      if (!opts.noCache) _cacheSet(cachedKey, buf);
      return buf;
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`[fetchBuffer] Failed after ${maxRetries + 1} attempts: ${lastErr?.message}`);
}

// ─── Image thumbnail ──────────────────────────────────────────────────────────

/**
 * Generate a JPEG thumbnail from an image buffer using Jimp or sharp.
 * Falls back to the original buffer if both libraries fail.
 *
 * @param {Buffer} imageBuf
 * @param {object} [opts]
 * @param {number} [opts.width=300]
 * @param {number} [opts.height=150]
 * @returns {Promise<Buffer>}
 */
export async function generateImageThumbnail(imageBuf, opts = {}) {
  const w = opts.width  ?? 300;
  const h = opts.height ?? 150;

  // Use the registered Jimp engine first.
  try {
    if (imageEngine) {
      return await imageEngine.resize(imageBuf, w, h, {
        mime: "image/jpeg",
        quality: 75,
      });
    }
  } catch {}

  // Try sharp
  try {
    const sharp = await import("sharp");
    const sharpFn = sharp.default || sharp;
    return await sharpFn(imageBuf)
      .resize(w, h, { fit: "cover" })
      .jpeg({ quality: 75 })
      .toBuffer();
  } catch {}

  // Fallback: return original
  return imageBuf;
}

// ─── Video thumbnail ──────────────────────────────────────────────────────────

/**
 * Generate a JPEG thumbnail from a video buffer using ffmpeg.
 * Returns null if ffmpeg is unavailable or the extraction fails.
 *
 * @param {Buffer} videoBuf
 * @param {object} [opts]
 * @param {number} [opts.width=300]
 * @param {number} [opts.height=150]
 * @param {number} [opts.timeOffset=1]  - Second offset to capture frame
 * @returns {Promise<Buffer|null>}
 */
export async function generateVideoThumbnail(videoBuf, opts = {}) {
  const w = opts.width      ?? 300;
  const h = opts.height     ?? 150;
  const t = opts.timeOffset ?? 1;

  const tmpIn  = join(tmpdir(), `mias_vthumb_in_${Date.now()}.mp4`);
  const tmpOut = join(tmpdir(), `mias_vthumb_out_${Date.now()}.jpg`);

  try {
    const { writeFile, readFile } = await import("fs/promises");
    await writeFile(tmpIn, videoBuf);

    const ffmpegStatic = await import("ffmpeg-static").then(m => m.default || m).catch(() => "ffmpeg");
    const { execFile }  = await import("child_process");
    const { promisify } = await import("util");
    const execFileAsync = promisify(execFile);

    await execFileAsync(ffmpegStatic, [
      "-ss", String(t),
      "-i", tmpIn,
      "-vframes", "1",
      "-vf", `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2`,
      "-f", "image2",
      "-y", tmpOut,
    ]);

    const thumb = await readFile(tmpOut);
    return thumb;
  } catch {
    return null;
  } finally {
    for (const p of [tmpIn, tmpOut]) {
      unlink(p).catch(() => {});
    }
  }
}

// ─── Temp file cleanup helper ─────────────────────────────────────────────────

/**
 * Delete a temporary file, silently ignoring errors.
 * @param {string|null} filePath
 */
export async function cleanupTemp(filePath) {
  if (!filePath) return;
  try {
    await unlink(filePath);
  } catch {}
}

// ─── Catbox upload ────────────────────────────────────────────────────────────

/**
 * Upload a file to catbox.moe and return the public URL.
 *
 * @param {Buffer} buf
 * @param {string} [filename="file.bin"]
 * @param {string} [mimetype="application/octet-stream"]
 * @returns {Promise<string>}
 */
export async function uploadToCatbox(buf, filename = "file.bin", mimetype = "application/octet-stream") {
  const cacheKey = `catbox:${buf.length}:${filename}`;
  const cached = _cacheGet(cacheKey);
  if (cached) return cached;

  try {
    const FormData = await import("form-data").then(m => m.default || m);
    const form = new FormData();
    form.append("reqtype", "fileupload");
    form.append("fileToUpload", buf, { filename, contentType: mimetype });

    const fetchFn = (await import("node-fetch").catch(() => ({ default: fetch }))).default || fetch;
    const res = await fetchFn("https://catbox.moe/user/api.php", {
      method: "POST",
      body: form,
      headers: form.getHeaders ? form.getHeaders() : {},
    });

    if (!res.ok) throw new Error(`Catbox HTTP ${res.status}`);
    const url = (await res.text()).trim();
    if (!url.startsWith("https://")) throw new Error("Invalid catbox response");
    _cacheSet(cacheKey, url);
    return url;
  } catch (err) {
    throw new Error(`[uploadToCatbox] Failed: ${err?.message}`);
  }
}

/**
 * Upload media using the Baileys built-in upload mechanism.
 * Wraps prepareWAMessageMedia for cases where a media URL is needed.
 *
 * @param {object}   sock
 * @param {Buffer}   buf
 * @param {"image"|"video"|"audio"|"document"|"sticker"} type
 * @param {object}   [opts]
 * @returns {Promise<object>} - Prepared media object with mediaUrl
 */
export async function uploadMedia(sock, buf, type = "image", opts = {}) {
  try {
    const { prepareWAMessageMedia: prep } = await import("./gktwAdapter.js");
    const content = { [type]: buf, ...opts };
    return await prep(content, { upload: sock.waUploadToServer });
  } catch (err) {
    throw new Error(`[uploadMedia] Failed: ${err?.message}`);
  }
}
