'use strict';
/**
 * Shared "1.3 HD" video pipeline for every download command.
 *
 * Runs a downloaded video through the same re-encode the TikTok 1.3 HD command
 * uses (ttDelivery.reencodeHdForWhatsApp: 1080p short side, 1.2 quality boost,
 * faststart). It never throws: if ffmpeg or the encoder is unavailable, or the
 * encode fails, the original media is returned unchanged so the send still works.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_BYTES = 95 * 1024 * 1024;
const HD_OPTIONS = Object.freeze({ maxBytes: MAX_BYTES, boost: 1.2, sourceQualityBoost: 1.2 });
const noop = async () => {};

let encoderModule = null;
function loadEncoder() {
  if (encoderModule === null) {
    try { encoderModule = require('./ttDelivery.cjs'); } catch { encoderModule = false; }
  }
  return encoderModule || null;
}

/**
 * Re-encodes a video file on disk to the 1.3 HD profile.
 * @returns {Promise<{path: string, cleanup: () => Promise<void>, hd: boolean}>}
 *   `path` is the file to send. Call `cleanup()` after sending.
 */
async function reencodeFileHd(inputPath, { encoder } = {}) {
  const fn = encoder !== undefined ? encoder : (loadEncoder() && loadEncoder().reencodeHdForWhatsApp);
  const original = { path: inputPath, cleanup: noop, hd: false };
  if (typeof fn !== 'function' || !inputPath) return original;
  try {
    const res = await fn(inputPath, { ...HD_OPTIONS });
    if (res && res.path && Number(res.bytes) > 0 && fs.existsSync(res.path)) {
      return {
        path: res.path,
        cleanup: typeof res.cleanup === 'function' ? res.cleanup : noop,
        hd: !res.untouched,
      };
    }
  } catch (e) {
    console.warn('[hd-pipeline] 1.3 HD re-encode skipped, sending original:', e && e.message);
  }
  return original;
}

/**
 * Re-encodes an in-memory video buffer to the 1.3 HD profile.
 * @returns {Promise<{buf: Buffer, cleanup: () => Promise<void>, hd: boolean}>}
 */
async function reencodeBufferHd(buf, { encoder } = {}) {
  const original = { buf, cleanup: noop, hd: false };
  if (!Buffer.isBuffer(buf) || !buf.length) return original;
  let dir = null;
  try {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hdvid-'));
    const src = path.join(dir, 'input.mp4');
    await fs.promises.writeFile(src, buf);
    const out = await reencodeFileHd(src, { encoder });
    if (!out.hd) { await out.cleanup().catch(() => {}); return original; }
    const outBuf = await fs.promises.readFile(out.path);
    await out.cleanup().catch(() => {});
    if (!outBuf.length) return original;
    return { buf: outBuf, cleanup: noop, hd: true };
  } catch (e) {
    console.warn('[hd-pipeline] buffer re-encode skipped, sending original:', e && e.message);
    return original;
  } finally {
    if (dir) await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { HD_OPTIONS, reencodeFileHd, reencodeBufferHd };
