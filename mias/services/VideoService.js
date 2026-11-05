/**
 * MIAS — Video Service
 *
 * Centralized video processing using fluent-ffmpeg.
 * Commands never import ffmpeg directly.
 *
 * Architecture: Commands → VideoService → fluent-ffmpeg → Buffer
 */

import { join } from "path";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
import { tmpdir } from "os";
import { writeFile, readFile, unlink } from "fs/promises";
import { enqueueMedia } from "./QueueService.js";
import { fromVideo as _thumbFromVideo } from "./ThumbnailService.js";

function _ffmpegPath() {
  try { return require("ffmpeg-static"); }
  catch { return "ffmpeg"; }
}

let _ffmpeg = null;
async function _getFluentFfmpeg() {
  if (_ffmpeg) return _ffmpeg;
  try {
    const m = await import("fluent-ffmpeg");
    _ffmpeg = m.default || m;
    _ffmpeg.setFfmpegPath(_ffmpegPath());
  } catch { _ffmpeg = null; }
  return _ffmpeg;
}

async function _process(inputBuf, inputExt, outputExt, buildCmd) {
  const runId = `${Date.now()}_${process.pid}_${Math.random().toString(36).slice(2)}`;
  const tmpIn  = join(tmpdir(), `mias_video_${runId}.${inputExt}`);
  const tmpOut = join(tmpdir(), `mias_video_${runId}.${outputExt}`);
  try {
    await writeFile(tmpIn, inputBuf);
    const ffmpeg = await _getFluentFfmpeg();
    if (!ffmpeg) throw new Error("fluent-ffmpeg not available");
    await new Promise((resolve, reject) => {
      const cmd = ffmpeg(tmpIn).output(tmpOut);
      buildCmd(cmd);
      cmd.on("end", resolve).on("error", reject).run();
    });
    return await readFile(tmpOut);
  } finally {
    try { await unlink(tmpIn); } catch {}
    try { await unlink(tmpOut); } catch {}
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Convert video to MP4.
 * @param {Buffer} buffer
 * @param {string} [inputExt="mkv"]
 * @param {object} [opts]
 * @param {string} [opts.preset="medium"]
 * @param {string} [opts.crf="23"]
 * @returns {Promise<Buffer>}
 */
export async function toMp4(buffer, inputExt = "mkv", opts = {}) {
  return enqueueMedia(() => _process(buffer, inputExt, "mp4", (cmd) => {
    cmd.videoCodec("libx264")
       .outputOptions([`-crf ${opts.crf || 23}`, `-preset ${opts.preset || "medium"}`, "-pix_fmt yuv420p", "-movflags +faststart"])
       .audioCodec("aac");
  }));
}

/**
 * Compress a video (reduce file size).
 * @param {Buffer} buffer
 * @param {string} [inputExt="mp4"]
 * @param {object} [opts]
 * @param {string} [opts.resolution="480x-1"] - target width (height auto)
 * @param {number} [opts.crf=28]
 * @returns {Promise<Buffer>}
 */
export async function compress(buffer, inputExt = "mp4", opts = {}) {
  return enqueueMedia(() => _process(buffer, inputExt, "mp4", (cmd) => {
    cmd.videoCodec("libx264")
       .outputOptions([`-crf ${opts.crf || 28}`, "-preset fast", "-pix_fmt yuv420p", "-movflags +faststart"])
       .audioCodec("aac")
       .audioBitrate("96k");
    if (opts.resolution) cmd.videoFilter(`scale=${opts.resolution}`);
  }));
}

/**
 * Trim a video to a specific range.
 * @param {Buffer} buffer
 * @param {number} startSec
 * @param {number} durationSec
 * @param {string} [ext="mp4"]
 * @returns {Promise<Buffer>}
 */
export async function trim(buffer, startSec, durationSec, ext = "mp4") {
  return enqueueMedia(() => _process(buffer, ext, ext, (cmd) => {
    cmd.seekInput(startSec).duration(durationSec).outputOptions(["-c copy"]);
  }));
}

/**
 * Convert video to GIF.
 * @param {Buffer} buffer
 * @param {string} [inputExt="mp4"]
 * @param {object} [opts]
 * @param {number} [opts.fps=10]
 * @param {number} [opts.width=480]
 * @returns {Promise<Buffer>}
 */
export async function toGif(buffer, inputExt = "mp4", opts = {}) {
  return enqueueMedia(() => _process(buffer, inputExt, "gif", (cmd) => {
    cmd.videoFilter(`fps=${opts.fps || 10},scale=${opts.width || 480}:-1:flags=lanczos`);
  }));
}

/**
 * Extract audio from a video.
 * @param {Buffer} buffer
 * @param {string} [inputExt="mp4"]
 * @param {string} [outputExt="mp3"]
 * @returns {Promise<Buffer>}
 */
export async function extractAudio(buffer, inputExt = "mp4", outputExt = "mp3") {
  return enqueueMedia(() => _process(buffer, inputExt, outputExt, (cmd) => {
    cmd.noVideo().audioCodec("libmp3lame").audioBitrate(128);
  }));
}

/**
 * Generate a thumbnail from a video buffer.
 * Delegates to ThumbnailService.
 * @param {Buffer} videoBuf
 * @param {object} [opts]
 * @returns {Promise<Buffer|null>}
 */
export async function thumbnail(videoBuf, opts = {}) {
  return _thumbFromVideo(videoBuf, opts);
}

/**
 * Get video metadata (duration, resolution, codec).
 * @param {Buffer} buffer
 * @param {string} [ext="mp4"]
 * @returns {Promise<object>}
 */
export async function getMetadata(buffer, ext = "mp4") {
  const tmpIn = join(tmpdir(), `mias_vmeta_${Date.now()}.${ext}`);
  try {
    await writeFile(tmpIn, buffer);
    const ffmpeg = await _getFluentFfmpeg();
    if (!ffmpeg) return {};
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(tmpIn, (err, data) => {
        if (err) reject(err); else resolve(data?.format || data || {});
      });
    });
  } finally {
    try { await unlink(tmpIn); } catch {}
  }
}

export default { toMp4, compress, trim, toGif, extractAudio, thumbnail, getMetadata };
