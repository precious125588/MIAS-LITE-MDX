// Makes a TikTok download playable in WhatsApp.
// The provider's MP4 can carry broken H.264 access units, which WhatsApp shows as
// "something is wrong with the video file". Every TikTok video is therefore
// re-encoded or remuxed with +faststart to clean H.264/AAC with the moov atom at the front.
// If normalization fails, times out, or ffmpeg is unavailable, it gracefully returns
// the source video buffer so the user still receives their video.
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { normalizeVideoBuffer, createSliderVideo } = require("../lib/portableVideo.cjs");
const { processVideoTo4k } = require("../lib/tt4kVideo.cjs");

export const TT_VIDEO_ENCODE = Object.freeze({
  preset: "veryfast",
  crf: 26,
  maxrate: "6M",
  bufsize: "12M",
  maxInputBytes: 120 * 1024 * 1024,
  timeoutMs: 120000,
  maxBuffer: 32 * 1024 * 1024,
});

export async function prepareTikTokVideo(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 1024) {
    throw new Error("TikTok returned an empty video, so nothing was sent.");
  }
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
