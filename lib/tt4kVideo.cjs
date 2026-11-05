"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_TIMEOUT_MS = 300000;
const MIN_OUTPUT_BYTES = 2048;
// Scratch folder for every 4K job. Anything left here by a crash is swept after an hour.
const WORK_DIR = path.join(os.tmpdir(), "tt4k-work");
const STALE_MS = 60 * 60 * 1000;

function resolveFfmpegPath() {
  try {
    const staticPkg = require("ffmpeg-static");
    if (staticPkg && typeof staticPkg === "string" && fs.existsSync(staticPkg)) {
      return staticPkg;
    }
  } catch {}
  return "ffmpeg";
}

// Only one 4K encode runs at a time in this process. Each encode needs several
// hundred MB of RAM, so two at once is what pushes a small host into the OOM killer.
let encodeQueue = Promise.resolve();
function runExclusive(task) {
  const run = encodeQueue.then(task, task);
  encodeQueue = run.catch(() => {});
  return run;
}

function removeFile(file) {
  try { fs.unlinkSync(file); } catch {}
}

function sweepStaleFiles() {
  try {
    const now = Date.now();
    for (const name of fs.readdirSync(WORK_DIR)) {
      if (!name.startsWith("tt4k_")) continue;
      const file = path.join(WORK_DIR, name);
      try {
        if (now - fs.statSync(file).mtimeMs > STALE_MS) fs.unlinkSync(file);
      } catch {}
    }
  } catch {}
}

// Lanczos 4K scaling: 2160p on the primary axis (3840x2160 for landscape, 2160x3840 for portrait),
// with divisible-by-2 guarantees, square pixels (setsar=1), and unsharp edge enhancement.
const VIDEO_FILTER = "scale='if(gte(iw,ih),-2,2160)':'if(gte(iw,ih),2160,-2)':flags=lanczos,unsharp=5:5:0.8:3:3:0.4,setsar=1";

// "normal" is the default and is fast. "low-memory" is used once, only after the
// normal run is SIGKILLed for memory. It gives the same quality (its output is
// slightly larger) at roughly half the RAM, but it encodes about 2x slower.
function buildFfmpegArgs(inputPath, outputPath, opts, profile) {
  const lowMemory = profile === "low-memory";
  return [
    "-y",
    "-v", "error",
    "-threads", "1",
    ...(lowMemory ? ["-filter_threads", "1"] : []),
    "-i", inputPath,
    "-vf", VIDEO_FILTER,
    "-c:v", "libx264",
    "-preset", opts.preset || "veryfast",
    "-crf", String(opts.crf || 20),
    // Cap the bitrate at 8 Mbps and set level 5.1 so the 4K file stays within what WhatsApp status and phone decoders play smoothly.
    "-level", "5.1",
    "-maxrate", "8M",
    "-bufsize", lowMemory ? "8M" : "16M",
    "-threads", lowMemory ? "2" : "4",
    "-x264-params", lowMemory
      ? "sliced-threads=1:ref=1:bframes=0:rc-lookahead=0"
      : "sliced-threads=1:ref=1:bframes=0:rc-lookahead=5",
    "-profile:v", "high",
    "-pix_fmt", "yuv420p",
    // Source frame rate is preserved via passthrough mode, and keyframes every 2 seconds, so the file starts and seeks reliably on phones.
    "-fps_mode", "passthrough",
    "-force_key_frames", "expr:gte(t,n_forced*2)",
    "-c:a", "aac",
    "-b:a", "192k",
    "-ac", "2",
    "-ar", "48000",
    "-movflags", "+faststart",
    outputPath,
  ];
}

function runFfmpeg(ffmpegBin, args, timeoutMs) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(ffmpegBin, args, { stdio: ["ignore", "ignore", "pipe"] });
    } catch (error) {
      return resolve({ error, stderr: "", timedOut: false });
    }

    let stderr = "";
    let timedOut = false;
    if (proc.stderr) {
      proc.stderr.on("data", (chunk) => {
        if (stderr.length < 2000) stderr += chunk.toString();
      });
    }

    const timer = timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          try { proc.kill("SIGKILL"); } catch {}
        }, timeoutMs)
      : null;

    proc.on("error", (error) => {
      if (timer) clearTimeout(timer);
      resolve({ error, stderr, timedOut });
    });
    proc.on("exit", (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ code, signal, stderr, timedOut });
    });
  });
}

/**
 * Upscales and processes any input video (SD, HD, portrait, or landscape) into true 4K (2160p)
 * resolution with high-fidelity Lanczos interpolation, subtle unsharp edge enhancement,
 * and WhatsApp-compliant faststart MP4 encoding.
 *
 * Everything runs file-to-file on disk. Temporary files are removed on success, failure,
 * and timeout. The returned cleanup() removes the 4K output once it has been delivered.
 *
 * @param {Buffer|string} input - Video buffer or path to an MP4 file. A path is never deleted here.
 * @param {Object} [opts] - Processing options
 * @param {number} [opts.timeoutMs=300000] - Hard watchdog timeout in ms (default 5 min), shared by all attempts
 * @param {string} [opts.preset="veryfast"] - x264 encoder preset
 * @param {number} [opts.crf=20] - Constant Rate Factor (18-22 is visually lossless)
 * @returns {Promise<{path: string, bytes: number, cleanup: () => void}>}
 */
async function processVideoTo4k(input, opts = {}) {
  if (!input) throw new Error("processVideoTo4k: missing input video");
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const isPath = typeof input === "string";

  if (!isPath && (!Buffer.isBuffer(input) || input.length < 1024)) {
    throw new Error("processVideoTo4k: input buffer is too small or invalid");
  }

  fs.mkdirSync(WORK_DIR, { recursive: true });
  sweepStaleFiles();

  const jobId = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const ownsInput = !isPath;
  const inputPath = isPath ? input : path.join(WORK_DIR, `tt4k_in_${jobId}.mp4`);
  const outputPath = path.join(WORK_DIR, `tt4k_out_${jobId}.mp4`);

  return runExclusive(async () => {
    try {
      if (ownsInput) fs.writeFileSync(inputPath, input);

      const ffmpegBin = resolveFfmpegPath();
      const deadline = Date.now() + timeoutMs;

      let run = await runFfmpeg(ffmpegBin, buildFfmpegArgs(inputPath, outputPath, opts, "normal"), timeoutMs);

      // Killed by the kernel (usually out of memory), not by our timeout: retry once with the low-memory profile.
      if (!run.error && run.signal === "SIGKILL" && !run.timedOut) {
        removeFile(outputPath);
        const remaining = deadline - Date.now();
        if (remaining > 0) {
          run = await runFfmpeg(ffmpegBin, buildFfmpegArgs(inputPath, outputPath, opts, "low-memory"), remaining);
        }
      }

      if (run.error) throw run.error;
      if (run.timedOut) throw new Error(`4K video processing timed out after ${timeoutMs}ms`);
      if (run.code !== 0) {
        const killedBy = run.signal ? ` (killed by ${run.signal}, usually out of memory)` : "";
        throw new Error(`ffmpeg 4K conversion exited with code ${run.code}${killedBy}: ${run.stderr.slice(0, 300)}`);
      }

      const stats = fs.statSync(outputPath);
      if (!stats.size || stats.size < MIN_OUTPUT_BYTES) {
        throw new Error("ffmpeg produced an empty 4K output file");
      }

      let cleaned = false;
      return {
        path: outputPath,
        bytes: stats.size,
        cleanup: () => {
          if (cleaned) return;
          cleaned = true;
          removeFile(outputPath);
        },
      };
    } catch (err) {
      removeFile(outputPath);
      throw err;
    } finally {
      if (ownsInput) removeFile(inputPath);
    }
  });
}

module.exports = {
  processVideoTo4k,
  resolveFfmpegPath,
};
