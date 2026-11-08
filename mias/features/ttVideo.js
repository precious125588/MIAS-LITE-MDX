// Makes a TikTok download playable in WhatsApp.
// The provider's MP4 can carry broken H.264 access units, which WhatsApp shows as
// "something is wrong with the video file". Every TikTok video is therefore
// re-encoded or remuxed with +faststart to clean H.264/AAC with the moov atom at the front.
// If normalization fails, times out, or ffmpeg is unavailable, it gracefully returns
// the source video buffer so the user still receives their video.
import { createRequire } from "module";
import fs from "fs";
import os from "os";
import path from "path";

const require = createRequire(import.meta.url);
const { normalizeVideoBuffer, createSliderVideo } = require("../lib/portableVideo.cjs");
const { processVideoTo4k } = require("../lib/tt4kVideo.cjs");
const TTD = require("../lib/ttDelivery.cjs");

// The same HD boost the disk delivery path uses (lib/ttDelivery.cjs HD_BOOST / HIGH_QUALITY_HD_BOOST).
const BOT_HD_BOOST = 1.2;
const BOT_MAX_INLINE_BYTES = 95 * 1024 * 1024;

export const TT_VIDEO_ENCODE = Object.freeze({
  preset: "veryfast",
  crf: 26,
  maxrate: "6M",
  bufsize: "12M",
  maxInputBytes: 120 * 1024 * 1024,
  timeoutMs: 120000,
  maxBuffer: 32 * 1024 * 1024,
});

// Re-encodes the downloaded HD file with the bot's own HD settings (the same encoder the
// disk delivery path uses: H.264 High 4.2, 1080p, bitrate from the bot's HD rule, bt709 tv).
// Returns null when that is not possible, so the caller falls back to the older path.
async function encodeWithBotHd(buf) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mias-tthd-"));
  const inPath = path.join(dir, "source.mp4");
  let result = null;
  try {
    await fs.promises.writeFile(inPath, buf);
    result = await TTD.reencodeHdForWhatsApp(inPath, {
      boost: BOT_HD_BOOST,
      sourceQualityBoost: BOT_HD_BOOST,
    });
    if (!result || result.untouched || result.fallback) return null;
    if (!result.bytes || result.bytes > BOT_MAX_INLINE_BYTES) return null;
    const out = await fs.promises.readFile(result.path);
    return out.length >= 1024 ? out : null;
  } catch (err) {
    try { console.warn("[tiktok] bot HD encode failed, using fallback:", err?.message || err); } catch (_) {}
    return null;
  } finally {
    try { if (result && typeof result.cleanup === "function") await result.cleanup(); } catch (_) {}
    try { await fs.promises.rm(dir, { recursive: true, force: true }); } catch (_) {}
  }
}

export async function prepareTikTokVideo(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 1024) {
    throw new Error("TikTok returned an empty video, so nothing was sent.");
  }
  const botHd = await encodeWithBotHd(buf);
  if (botHd) return botHd;
  try {
    const out = await normalizeVideoBuffer(buf, TT_VIDEO_ENCODE);
    if (out && Buffer.isBuffer(out) && out.length >= 1024) {
      return out;
    }
  } catch (err) {
    try { console.warn("[tiktok] video normalization failed, falling back to source:", err?.message || err); } catch (_) {}
  }
  // Graceful fallback: never abort sending if ffmpeg/re-encode fails
  return buf;
}

export async function createTikTokSliderVideo(opts) {
  return createSliderVideo(opts);
}

export { createSliderVideo, processVideoTo4k };
