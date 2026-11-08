// videoTools.js — shared ffmpeg helpers for .tomp4, .split and .remux.
// Everything is stream-copy first (no re-encode) and every ffmpeg run has a
// hard timeout that kills the process, so a conversion can never hang forever.
import { spawn } from "child_process";
import { createRequire } from "module";
import fs from "fs";
import path from "path";

const require = createRequire(import.meta.url);

export const SPLIT_SECONDS = 90;
export const WA_VIDEO_MAX_BYTES = 64 * 1024 * 1024;
export const WA_DOC_MAX_BYTES = 2 * 1024 * 1024 * 1024;
export const VIDEO_DOC_EXTS = ["mp4", "mkv", "mov", "avi", "webm", "3gp", "m4v", "ts", "flv", "wmv", "mpeg", "mpg"];

export function resolveFfmpeg() {
  try {
    const p = require("ffmpeg-static");
    if (p && typeof p === "string" && fs.existsSync(p)) return p;
  } catch {}
  return "ffmpeg";
}

const lastLine = (text) => String(text || "").trim().split("\n").filter(Boolean).pop() || "";

// Runs a binary and collects stderr+stdout. Never rejects on a non-zero exit
// (ffmpeg -i exits 1 when it only probes), only on spawn failure or timeout.
function runCapture(bin, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    let out = "";
    let child;
    try {
      child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) { return reject(e); }
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      const e = new Error("ffmpeg timed out");
      e.code = "ETIMEDOUT";
      reject(e);
    }, timeoutMs);
    const onData = (d) => { out = (out + d.toString()).slice(-16000); };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

// Runs ffmpeg for real output. Rejects with the last ffmpeg error line.
export async function runFfmpeg(args, { timeoutMs = 240000 } = {}) {
  const res = await runCapture(resolveFfmpeg(), ["-hide_banner", "-loglevel", "error", ...args], timeoutMs);
  if (res.code !== 0) {
    const e = new Error(lastLine(res.out) || `ffmpeg exited with code ${res.code}`);
    e.stderr = res.out;
    throw e;
  }
  return res;
}

export function parseProbe(text) {
  const t = String(text || "");
  const d = t.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const duration = d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : 0;
  const v = t.match(/Stream #\d+:\d+[^\n]*?: Video: ([a-z0-9_]+)([^\n]*)/i);
  const a = t.match(/Stream #\d+:\d+[^\n]*?: Audio: ([a-z0-9_]+)/i);
  return {
    duration,
    videoCodec: v ? v[1].toLowerCase() : "",
    videoInfo: v ? v[2] : "",
    audioCodec: a ? a[1].toLowerCase() : "",
  };
}

// Reads duration and codecs from ffmpeg's stream report (no output file).
export async function probeFile(file) {
  const res = await runCapture(resolveFfmpeg(), ["-hide_banner", "-i", file], 60000);
  return parseProbe(res.out);
}

export const fmtDuration = (sec) => {
  const s = Math.round(Number(sec) || 0);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m ? `${m}m ${r}s` : `${r}s`;
};

// Whether a split is needed, and how many parts it makes.
export function splitPlan(duration, segSec = SPLIT_SECONDS) {
  const d = Number(duration) || 0;
  if (d <= segSec) return { needed: false, parts: 1 };
  return { needed: true, parts: Math.ceil(d / segSec) };
}

const H264_OK = (info) => info.videoCodec === "h264" && /yuv420p/.test(info.videoInfo) && !/10(le|be)/.test(info.videoInfo);
const COPYABLE_VIDEO = (info) => ["h264", "hevc", "h265"].includes(info.videoCodec);
const COPYABLE_AUDIO = (info) => !info.audioCodec || ["aac", "mp3"].includes(info.audioCodec);

function videoArgs(info) {
  if (!info.videoCodec) return [];
  if (COPYABLE_VIDEO(info)) return ["-c:v", "copy"];
  return ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p"];
}
function audioArgs(info) {
  if (!info.audioCodec) return [];
  if (COPYABLE_AUDIO(info)) return ["-c:a", "copy"];
  return ["-c:a", "aac", "-b:a", "160k", "-ac", "2"];
}

// Remux one file into MP4 (stream copy whenever the codecs allow it).
export async function remuxToMp4(inPath, outPath, info, { timeoutMs = 240000 } = {}) {
  await runFfmpeg([
    "-y", "-i", inPath, "-map", "0:v:0?", "-map", "0:a:0?", "-sn", "-dn",
    ...videoArgs(info), ...audioArgs(info), "-movflags", "+faststart", outPath,
  ], { timeoutMs });
  return outPath;
}

function getSplitParts(outDir) {
  return fs.readdirSync(outDir)
    .filter((file) => /^part_\d+\.mp4$/.test(file))
    .sort()
    .map((file) => path.join(outDir, file));
}

async function getPartDurations(parts) {
  return Promise.all(parts.map(async (part) => ({
    path: part,
    duration: (await probeFile(part)).duration,
  })));
}

function clearSplitParts(outDir) {
  for (const part of getSplitParts(outDir)) {
    try { fs.unlinkSync(part); } catch {}
  }
}

// Keep the fast, lossless stream-copy cut when its keyframes respect the limit.
// Some inputs have very sparse keyframes; those are re-encoded only for .split
// with forced keyframes and a two-second safety margin, then probed again.
// TikTok and other downloader/video pipelines do not use this function.
export async function splitVideoFile(inPath, outDir, info, segSec = SPLIT_SECONDS, { timeoutMs = 600000 } = {}) {
  await runFfmpeg([
    "-y", "-i", inPath, "-map", "0:v:0?", "-map", "0:a:0?", "-sn", "-dn",
    ...videoArgs(info), ...audioArgs(info),
    "-f", "segment", "-segment_time", String(segSec), "-reset_timestamps", "1",
    "-avoid_negative_ts", "make_zero",
    "-segment_format", "mp4", "-segment_format_options", "movflags=+faststart",
    path.join(outDir, "part_%03d.mp4"),
  ], { timeoutMs });
  let parts = getSplitParts(outDir);
  if (!parts.length) throw new Error("ffmpeg did not create any split parts");

  let durations = await getPartDurations(parts);
  if (durations.every(({ duration }) => duration > 0 && duration <= segSec)) return parts;

  clearSplitParts(outDir);
  const safetyMargin = Math.min(2, Math.max(0.25, segSec * 0.02));
  const targetSec = Math.max(0.25, segSec - safetyMargin);
  await runFfmpeg([
    "-y", "-i", inPath, "-map", "0:v:0?", "-map", "0:a:0?", "-sn", "-dn",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
    ...(info.audioCodec ? ["-c:a", "aac", "-b:a", "160k", "-ac", "2"] : ["-an"]),
    // A sparse/VFR source can have multi-second frame durations. Keyframe
    // forcing alone cannot cut between those frames, and B-frame reordering
    // adds timestamp padding. Normalize cadence ONLY in this .split fallback.
    "-vf", "fps=25", "-bf", "0",
    // Do not flush future audio packets before the corresponding video cut.
    // With sparse source frames the default 10s mux queue can let audio from
    // the NEXT part leak into this one, despite forced video keyframes.
    "-max_interleave_delta", "0",
    "-force_key_frames", `expr:gte(t,n_forced*${targetSec})`,
    "-f", "segment", "-segment_time", String(targetSec), "-reset_timestamps", "1",
    "-avoid_negative_ts", "make_zero",
    "-segment_format", "mp4", "-segment_format_options", "movflags=+faststart",
    path.join(outDir, "part_%03d.mp4"),
  ], { timeoutMs });

  parts = getSplitParts(outDir);
  durations = await getPartDurations(parts);
  if (!parts.length || durations.some(({ duration }) => !(duration > 0) || duration > segSec)) {
    throw Object.assign(new Error(`Could not guarantee split parts are at most ${segSec} seconds`), {
      code: "SPLIT_DURATION_LIMIT",
    });
  }
  return parts;
}

// Converts any supported input to MP4 for .tomp4. Returns { ok, error }.
export async function convertToMp4(inPath, outPath, { kind = "video", timeoutMs = 240000 } = {}) {
  const scaleEven = "scale=trunc(iw/2)*2:trunc(ih/2)*2";
  let lastErr = "";
  const attempt = async (args) => {
    try { await runFfmpeg(["-y", ...args, outPath], { timeoutMs }); return true; }
    catch (e) {
      if (e?.code === "ENOENT") throw e;
      lastErr = lastLine(e?.stderr) || e?.message || "";
      return false;
    }
  };
  let ok = false;
  if (kind === "sticker") {
    ok = await attempt(["-i", inPath, "-movflags", "+faststart", "-pix_fmt", "yuv420p", "-vf", `${scaleEven},fps=15`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "20"])
      || await attempt(["-loop", "1", "-t", "3", "-i", inPath, "-movflags", "+faststart", "-pix_fmt", "yuv420p", "-vf", scaleEven, "-c:v", "libx264", "-preset", "veryfast", "-crf", "20"]);
  } else if (kind === "image") {
    ok = await attempt(["-loop", "1", "-t", "5", "-i", inPath, "-vf", scaleEven, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-preset", "veryfast", "-crf", "20"]);
  } else if (kind === "audio") {
    ok = await attempt(["-f", "lavfi", "-i", "color=c=black:s=720x720:r=25", "-i", inPath, "-c:v", "libx264", "-tune", "stillimage", "-c:a", "aac", "-b:a", "192k", "-pix_fmt", "yuv420p", "-shortest", "-movflags", "+faststart"]);
  } else {
    const info = await probeFile(inPath);
    if (H264_OK(info)) {
      // Already H.264 in a compatible pixel format: copy, which finishes almost instantly.
      const a = !info.audioCodec ? ["-an"] : info.audioCodec === "aac" ? ["-c:a", "copy"] : ["-c:a", "aac", "-b:a", "160k", "-ac", "2"];
      ok = await attempt(["-i", inPath, "-map", "0:v:0", "-map", "0:a:0?", "-c:v", "copy", ...a, "-movflags", "+faststart"]);
    }
    if (!ok) {
      ok = await attempt(["-i", inPath, "-map", "0:v:0", "-map", "0:a:0?", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-vf", scaleEven, "-c:a", "aac", "-b:a", "160k", "-ac", "2", "-movflags", "+faststart"]);
    }
    if (!ok) {
      ok = await attempt(["-i", inPath, "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-vf", scaleEven, "-an", "-movflags", "+faststart"]);
    }
  }

  // HD logic: re-encode converted MP4 with clean WhatsApp HD faststart and 1.2 boost
  if (ok && fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
    try {
      let TTD = null;
      try {
        TTD = require("./ttDelivery.cjs");
      } catch {}
      if (TTD && typeof TTD.reencodeHdForWhatsApp === "function") {
        const hdRes = await TTD.reencodeHdForWhatsApp(outPath, {
          maxBytes: 95 * 1024 * 1024,
          boost: 1.2,
          sourceQualityBoost: 1.2,
        });
        if (hdRes && hdRes.path && hdRes.bytes > 0 && hdRes.path !== outPath) {
          fs.copyFileSync(hdRes.path, outPath);
          if (typeof hdRes.cleanup === "function") await hdRes.cleanup().catch(() => {});
        }
      }
    } catch (hdErr) {
      // Keep existing outPath if HD re-encode encounters an issue
    }
  }

  return { ok, error: lastErr };
}
