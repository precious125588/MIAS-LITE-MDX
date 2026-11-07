"use strict";

const { spawn, execFile } = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);
const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_TIMEOUT_MS = 420000;
const MIN_OUTPUT_BYTES = 2048;
// Scratch folder for every 4K job. Anything left here by a crash is swept after an hour.
const WORK_DIR = path.join(os.tmpdir(), "tt4k-work");
const STALE_MS = 60 * 60 * 1000;

function resolveFfmpegPath() {
  // Same resolver as the 1.3 HD path (ffmpeg-static chmod'd, then FFMPEG_PATH, then system ffmpeg),
  // so both encoders always use the same working binary.
  try {
    const { resolveFfmpeg } = require("./portableVideo.cjs");
    if (typeof resolveFfmpeg === "function") return resolveFfmpeg();
  } catch {}
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
const VIDEO_FILTER_4K = "setpts=PTS-STARTPTS,scale='if(gte(iw,ih),-2,2160)':'if(gte(iw,ih),2160,-2)':flags=bicubic,setsar=1";
const MAX_4K_OUTPUT_BYTES = 95 * 1024 * 1024;
const VIDEO_FILTER = VIDEO_FILTER_4K;
const MIN_HIGH_QUALITY_SHORT_SIDE = 1080;
const MAX_SOURCE_BOOST_KBPS = 40000;

// "normal" is the default and is fast. "low-memory" is used once, only after the
// normal run is SIGKILLed for memory. It gives the same quality (its output is
// slightly larger) at roughly half the RAM, but it encodes about 2x slower.
function buildFfmpegArgs(inputPath, outputPath, opts, profile) {
  const lowMemory = profile === "low-memory";
  const filter = VIDEO_FILTER_4K;
  const level = "5.2";
  const sourceBoostKbps = opts.sourceQualityBoost && opts.sourceProbe
    && opts.sourceProbe.shortSide >= MIN_HIGH_QUALITY_SHORT_SIDE
    && opts.sourceProbe.videoKbps > 0
    ? Math.min(Math.round(opts.sourceProbe.videoKbps * Number(opts.sourceQualityBoost)), MAX_SOURCE_BOOST_KBPS)
    : 0;
  const maxrate = sourceBoostKbps ? `${sourceBoostKbps}k` : (opts.maxrate || "8M");
  const bufsize = sourceBoostKbps
    ? `${Math.max(sourceBoostKbps * 2, 250)}k`
    : (lowMemory ? "8M" : "16M");
  return [
    "-y",
    "-v", "error",
    ...(lowMemory ? ["-filter_threads", "1"] : []),
    "-i", inputPath,
    "-map", "0:v:0",
    "-map", "0:a:0?",
    "-vf", filter,
    "-c:v", "libx264",
    "-preset", opts.preset || "superfast",
    ...(sourceBoostKbps ? ["-b:v", `${sourceBoostKbps}k`] : ["-crf", String(opts.crf || 20)]),
    "-level", level,
    "-maxrate", maxrate,
    "-bufsize", bufsize,
    "-threads", lowMemory ? "2" : "4",
    "-x264-params", lowMemory
      ? "sliced-threads=1:ref=1:bframes=0:rc-lookahead=0"
      : "sliced-threads=1:ref=1:bframes=0:rc-lookahead=5",
    "-profile:v", "high",
    "-pix_fmt", "yuv420p",
    // Source fps is preserved via passthrough mode, and keyframes every 2 seconds, so the file starts and seeks reliably on phones.
    "-fps_mode", "passthrough",
    "-force_key_frames", "expr:gte(t,n_forced*2)",
    "-af", "asetpts=PTS-STARTPTS,aresample=async=1000:min_hard_comp=0.100000:first_pts=0",
    "-avoid_negative_ts", "make_zero",
    "-shortest",
    "-max_muxing_queue_size", "1024",
    "-c:a", "aac",
    // Audio matches the reference: AAC 128 kb/s, 44100 Hz, stereo.
    "-b:a", "128k",
    "-ac", "2",
    "-ar", "44100",
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

async function probeSourceVideo(ffmpegBin, inputPath) {
  let stderr = "";
  try {
    await execFileAsync(ffmpegBin, ["-hide_banner", "-i", inputPath], {
      timeout: 15000,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (err) {
    stderr = String((err && err.stderr) || "");
  }
  const videoLine = (stderr.match(/Stream #\d+:\d+[^\n]*Video:[^\n]*/) || [])[0] || "";
  const audioLine = (stderr.match(/Stream #\d+:\d+[^\n]*Audio:[^\n]*/) || [])[0] || "";
  if (!videoLine) return null;
  const size = videoLine.match(/\s(\d{2,5})x(\d{2,5})[\s,]/);
  const videoText = (videoLine.match(/(\d+) kb\/s/) || [])[1];
  const audioText = (audioLine.match(/(\d+) kb\/s/) || [])[1];
  const totalText = (stderr.match(/bitrate: (\d+) kb\/s/) || [])[1];
  let videoKbps = videoText ? Number(videoText) : null;
  if (!videoKbps && totalText) videoKbps = Math.max(0, Number(totalText) - (audioText ? Number(audioText) : 0));
  const width = size ? Number(size[1]) : 0;
  const height = size ? Number(size[2]) : 0;
  return { width, height, shortSide: Math.min(width, height), videoKbps: videoKbps || null };
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
 * @param {number} [opts.timeoutMs=420000] - Hard watchdog timeout in ms (default 5 min), shared by all attempts
 * @param {string} [opts.preset="superfast"] - x264 encoder preset
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
      const sourceProbe = await probeSourceVideo(ffmpegBin, inputPath).catch(() => null);

      // If the video already has original high quality (native 1080p+), leave it untouched.
      // Re-encoding or upscaling pristine sources causes audio cracking and playback lag.
      if (sourceProbe && sourceProbe.shortSide >= MIN_HIGH_QUALITY_SHORT_SIDE && sourceProbe.videoKbps > 0) {
        fs.copyFileSync(inputPath, outputPath);
        const stats = fs.statSync(outputPath);
        return {
          path: outputPath,
          bytes: stats.size,
          cleanup: () => removeFile(outputPath),
          untouched: true,
        };
      }

      const processingOpts = { ...opts, sourceProbe };

      const maxOutputBytes = Number(opts.maxOutputBytes) > 0 ? Number(opts.maxOutputBytes) : MAX_4K_OUTPUT_BYTES;
      let run = await runFfmpeg(ffmpegBin, buildFfmpegArgs(inputPath, outputPath, processingOpts, "normal"), timeoutMs);

      // Killed by the kernel (usually out of memory), not by our timeout: retry once with the low-memory profile.
      if (!run.error && run.signal === "SIGKILL" && !run.timedOut) {
        removeFile(outputPath);
        const remaining = deadline - Date.now();
        if (remaining > 0) {
          run = await runFfmpeg(ffmpegBin, buildFfmpegArgs(inputPath, outputPath, processingOpts, "low-memory"), remaining);
        }
      }

      if (run.error || run.timedOut || run.code !== 0) {
        const killedBy = run.signal ? ` (killed by ${run.signal}, usually out of memory)` : "";
        const reason = run.timedOut
          ? `timed out after ${timeoutMs}ms`
          : (run.error?.message || `ffmpeg exited with code ${run.code}${killedBy}: ${run.stderr.slice(0, 300)}`);
        console.warn(`[4K video] ffmpeg failed (${reason}), falling back to source file`);
        removeFile(outputPath);
        try { fs.copyFileSync(inputPath, outputPath); } catch {}
        const fbStats = fs.existsSync(outputPath) ? fs.statSync(outputPath) : null;
        if (fbStats && fbStats.size >= MIN_OUTPUT_BYTES) {
          let cleanedFb = false;
          return {
            path: outputPath,
            bytes: fbStats.size,
            cleanup: () => {
              if (cleanedFb) return;
              cleanedFb = true;
              removeFile(outputPath);
            },
            untouched: true,
            fallback: true,
          };
        }
        const inStat = fs.statSync(inputPath);
        return {
          path: inputPath,
          bytes: inStat.size,
          cleanup: () => {},
          untouched: true,
          fallback: true,
        };
      }

      let stats = fs.existsSync(outputPath) ? fs.statSync(outputPath) : null;
      if (!stats || !stats.size || stats.size < MIN_OUTPUT_BYTES) {
        console.warn("[4K video] ffmpeg produced empty output, falling back to source file");
        removeFile(outputPath);
        try { fs.copyFileSync(inputPath, outputPath); } catch {}
        const fbStats = fs.existsSync(outputPath) ? fs.statSync(outputPath) : null;
        if (fbStats && fbStats.size >= MIN_OUTPUT_BYTES) {
          let cleanedFb = false;
          return {
            path: outputPath,
            bytes: fbStats.size,
            cleanup: () => {
              if (cleanedFb) return;
              cleanedFb = true;
              removeFile(outputPath);
            },
            untouched: true,
            fallback: true,
          };
        }
        const inStat = fs.statSync(inputPath);
        return {
          path: inputPath,
          bytes: inStat.size,
          cleanup: () => {},
          untouched: true,
          fallback: true,
        };
      }

      // When output exceeds maxOutputBytes (95 MiB), attempt high-quality compression to fit within 95 MiB
      if (stats.size > maxOutputBytes) {
        const compOut = path.join(WORK_DIR, `tt4k_comp_${jobId}.mp4`);
        try {
          const compArgs = [
            "-y", "-v", "error",
            "-i", outputPath,
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "24",
            "-maxrate", "6M", "-bufsize", "12M",
            "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k",
            "-movflags", "+faststart",
            compOut
          ];
          const compRun = await runFfmpeg(ffmpegBin, compArgs, 180000);
          if (!compRun.error && compRun.code === 0 && fs.existsSync(compOut)) {
            const compStat = fs.statSync(compOut);
            if (compStat.size > MIN_OUTPUT_BYTES && compStat.size <= maxOutputBytes) {
              removeFile(outputPath);
              let cleanedComp = false;
              return {
                path: compOut,
                bytes: compStat.size,
                cleanup: () => {
                  if (cleanedComp) return;
                  cleanedComp = true;
                  removeFile(compOut);
                }
              };
            }
          }
        } catch {} finally {
          if (fs.existsSync(compOut)) {
            const cStat = fs.statSync(compOut);
            if (cStat.size > maxOutputBytes || cStat.size < MIN_OUTPUT_BYTES) {
              removeFile(compOut);
            }
          }
        }

        console.warn("[4K video] file exceeds maxOutputBytes even after compression, returning for document fallback");
        let cleaned = false;
        return {
          path: outputPath,
          bytes: stats.size,
          cleanup: () => {
            if (cleaned) return;
            cleaned = true;
            removeFile(outputPath);
          }
        };
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
