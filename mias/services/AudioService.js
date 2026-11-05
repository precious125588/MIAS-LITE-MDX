/**
 * MIAS — Audio Service
 *
 * Centralized audio processing using fluent-ffmpeg.
 * Commands never import ffmpeg or fluent-ffmpeg directly.
 *
 * Architecture: Commands → AudioService → fluent-ffmpeg → Buffer
 */

import { join } from "path";
import { tmpdir } from "os";
import { writeFile, readFile, unlink } from "fs/promises";
import { enqueueMedia } from "./QueueService.js";

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

// ─── Internal helper: run ffmpeg on buffer ────────────────────────────────────

async function _process(inputBuf, inputExt, outputExt, buildCmd) {
  const tmpIn  = join(tmpdir(), `mias_audio_${Date.now()}.${inputExt}`);
  const tmpOut = join(tmpdir(), `mias_audio_${Date.now()}.${outputExt}`);
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
 * Convert audio to MP3.
 * @param {Buffer} buffer
 * @param {string} [inputExt="mp4"]
 * @param {object} [opts]
 * @param {number} [opts.bitrate=128]
 * @returns {Promise<Buffer>}
 */
export async function toMp3(buffer, inputExt = "mp4", opts = {}) {
  return enqueueMedia(() => _process(buffer, inputExt, "mp3", (cmd) => {
    cmd.audioCodec("libmp3lame").audioBitrate(opts.bitrate || 128);
  }));
}

/**
 * Convert audio to Opus (WhatsApp voice note format).
 * @param {Buffer} buffer
 * @param {string} [inputExt="mp3"]
 * @param {object} [opts]
 * @returns {Promise<Buffer>}
 */
export async function toOpus(buffer, inputExt = "mp3", opts = {}) {
  return enqueueMedia(() => _process(buffer, inputExt, "ogg", (cmd) => {
    cmd.audioCodec("libopus").audioFrequency(48000).audioChannels(1);
  }));
}

/**
 * Convert any audio to a WhatsApp-compatible voice note (PTT).
 * @param {Buffer} buffer
 * @param {string} [inputExt="mp3"]
 * @returns {Promise<Buffer>}
 */
export async function toVoiceNote(buffer, inputExt = "mp3") {
  return enqueueMedia(() => _process(buffer, inputExt, "ogg", (cmd) => {
    cmd.audioCodec("libopus")
       .audioFrequency(16000)
       .audioChannels(1)
       .audioBitrate(32);
  }));
}

/**
 * Extract audio from a video file.
 * @param {Buffer} videoBuf
 * @param {string} [inputExt="mp4"]
 * @param {string} [outputExt="mp3"]
 * @param {object} [opts]
 * @returns {Promise<Buffer>}
 */
export async function extractFromVideo(videoBuf, inputExt = "mp4", outputExt = "mp3", opts = {}) {
  return enqueueMedia(() => _process(videoBuf, inputExt, outputExt, (cmd) => {
    cmd.noVideo().audioBitrate(opts.bitrate || 128);
    if (outputExt === "mp3") cmd.audioCodec("libmp3lame");
  }));
}

/**
 * Trim audio to a specific duration.
 * @param {Buffer} buffer
 * @param {number} startSec
 * @param {number} durationSec
 * @param {string} [ext="mp3"]
 * @returns {Promise<Buffer>}
 */
export async function trim(buffer, startSec, durationSec, ext = "mp3") {
  return enqueueMedia(() => _process(buffer, ext, ext, (cmd) => {
    cmd.seekInput(startSec).duration(durationSec);
  }));
}

/**
 * Get audio metadata (duration, bitrate, codec).
 * @param {Buffer} buffer
 * @param {string} [ext="mp3"]
 * @returns {Promise<object>}
 */
export async function getMetadata(buffer, ext = "mp3") {
  const tmpIn = join(tmpdir(), `mias_ameta_${Date.now()}.${ext}`);
  try {
    await writeFile(tmpIn, buffer);
    const ffmpeg = await _getFluentFfmpeg();
    if (!ffmpeg) return {};
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(tmpIn, (err, data) => {
        if (err) reject(err);
        else resolve(data?.format || data || {});
      });
    });
  } finally {
    try { await unlink(tmpIn); } catch {}
  }
}

export default { toMp3, toOpus, toVoiceNote, extractFromVideo, trim, getMetadata };
