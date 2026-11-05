"use strict";
/*
 * TikTok delivery over disk.
 *
 * Every TikTok media file is streamed to a temporary file, validated, and sent
 * from disk. Inline video (1.1-1.3 and the bulk/shortcut video paths) is always
 * re-encoded to a high-quality, WhatsApp-compatible H.264/AAC MP4 (CRF 18, same
 * resolution, faststart). Documents (1.4) keep the provider's original file.
 * Every temporary file is removed in `finally`, after delivery or failure.
 */

const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { spawn, execFile } = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);
const { resolveFfmpeg } = require("./portableVideo.cjs");
const disk = require("./tiktokDiskDelivery.cjs");

const WORK_DIR = path.join(os.tmpdir(), "tt-hd-work");
const STALE_MS = 60 * 60 * 1000;
const MIN_BYTES = 2048;
const DEFAULT_CAP = 300 * 1024 * 1024;
const HD_ENCODE_TIMEOUT_MS = 480000;
const WHATSAPP_VIDEO_MAX_BYTES = disk.WHATSAPP_VIDEO_MAX_BYTES;
// Every TikTok inline video (1.3, 1.8 and the rest) is sent as a video message up to 92 MB.
// Above that it is sent as a document, so the same rule applies to all modes.
const TT_INLINE_VIDEO_MAX_BYTES = 95 * 1024 * 1024;

// HD (1.3): a 1080p60 Full HD WhatsApp file. The short side is 1080 (upscaled from SD, never 4K),
// source fps is preserved via passthrough mode, and the audio is
// resampled to the video clock. Keyframes every 2 s make it start and seek reliably.
const HD_VIDEO_FILTER = "scale='if(gte(iw,ih),-2,1080)':'if(gte(iw,ih),1080,-2)':flags=bicubic,setsar=1";
// Bitrate rule for 1.3 (and every path that calls reencodeHdForWhatsApp: status categories, .hd):
// - The 1.3 state is the reference above: 1080p short side at 18398 kb/s.
// - A source already at that state (short side >= 1080 and video bitrate >= 18398 kb/s) is
//   re-encoded at its own bitrate plus 10%, capped at HD_MAX_KBPS.
// - A source below that state is re-encoded to the 18398 kb/s reference, without the 10%.
const HD_REFERENCE_KBPS = 18398;
const HD_REFERENCE_SHORT_SIDE = 1080;
const HD_BOOST = 1.05;
const HD_MAX_KBPS = 40000;

// Encoder threads scale with the host (2 to 4). Output settings are unchanged.
const HD_THREADS = Math.max(2, Math.min(4, (os.cpus() || []).length || 2));

const HD_ARGS = (inPath, outPath, kbps = HD_REFERENCE_KBPS, opts = {}) => [
  "-y", "-v", "error",
  ...(opts.lowMemory ? ["-filter_threads", "1"] : []),
  "-threads", String(opts.lowMemory ? 2 : HD_THREADS),
  "-i", inPath,
  "-map", "0:v:0", "-map", "0:a:0?",
  "-vf", opts.vf || HD_VIDEO_FILTER,
  // Matches the reference file: H.264 at 18398 kb/s, preserves source fps via passthrough, SAR 1:1.
  // Level 4.2 is the lowest level that allows 1080p at 60 fps (4.0 tops out at 30 fps).
  // veryfast: about 3.5x faster than medium at the same bitrate; the output is visually the same at 18 Mb/s.
  "-c:v", "libx264", "-preset", opts.preset || "superfast",
  "-b:v", `${Math.round(kbps)}k`, "-maxrate", `${Math.round(kbps)}k`, "-bufsize", opts.lowMemory ? "8000k" : `${Math.round(kbps * 2)}k`,
  "-x264-params", opts.lowMemory ? "sliced-threads=1:ref=1:bframes=0:rc-lookahead=0" : "sliced-threads=1:ref=1:bframes=0:rc-lookahead=5",
  "-profile:v", "high", "-level", "4.2", "-pix_fmt", "yuv420p",
  "-fps_mode", "passthrough",
  "-force_key_frames", "expr:gte(t,n_forced*2)",
  // Audio matches the reference: AAC 190 kb/s, 48000 Hz, stereo.
  "-c:a", "aac", "-b:a", "190k", "-ac", "2", "-ar", "48000",
  "-af", "aresample=async=1:first_pts=0",
  "-avoid_negative_ts", "make_zero",
  "-shortest",
  "-movflags", "+faststart", "-f", "mp4",
  outPath,
];

function ensureWorkDir() {
  fs.mkdirSync(WORK_DIR, { recursive: true });
  try {
    const now = Date.now();
    for (const name of fs.readdirSync(WORK_DIR)) {
      if (!name.startsWith("tt_")) continue;
      const file = path.join(WORK_DIR, name);
      try { if (now - fs.statSync(file).mtimeMs > STALE_MS) fs.unlinkSync(file); } catch {}
    }
  } catch {}
}

function tempPath(tag, ext) {
  return path.join(WORK_DIR, `tt_${tag}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
}

// Returns the mimetype for a valid media prefix, or null if it is not playable media.
function sniffMimetype(prefix, kind) {
  if (!Buffer.isBuffer(prefix) || prefix.length < 12) return null;
  const ftyp = prefix.subarray(4, 8).toString("ascii") === "ftyp";
  if (kind === "audio") {
    if (prefix.subarray(0, 3).toString("latin1") === "ID3") return "audio/mpeg";
    if (prefix.subarray(0, 4).toString("ascii") === "OggS") return "audio/ogg; codecs=opus";
    if (prefix[0] === 0xff && (prefix[1] & 0xe0) === 0xe0) return "audio/mpeg";
    if (ftyp) return "audio/mp4";
    return null;
  }
  return ftyp ? "video/mp4" : null;
}

/**
 * Streams a TikTok media URL to disk and validates it.
 * @returns {Promise<{path: string, bytes: number, mimetype: string, cleanup: () => Promise<void>}>}
 */
async function fetchTikTokToDisk(pipeline, url, { kind = "video", cap = DEFAULT_CAP, timeout = 120000, headers } = {}) {
  if (!pipeline || typeof pipeline.fetchToDisk !== "function") {
    throw new TypeError("A media pipeline with fetchToDisk is required");
  }
  const dl = await pipeline.fetchToDisk(url, {
    cap,
    timeout,
    headers: headers || { "User-Agent": "Mozilla/5.0 (MIAS-Pipeline)", Referer: "https://www.tiktok.com/" },
  });
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    if (typeof dl.cleanup === "function") await dl.cleanup();
    else await fsp.rm(dl.path, { force: true }).catch(() => {});
  };
  try {
    const bytes = Number(dl.bytes) || (await fsp.stat(dl.path)).size;
    if (bytes < MIN_BYTES) {
      throw new Error(`TikTok returned an empty or tiny ${kind} file (${bytes} bytes). Nothing was sent.`);
    }
    const fh = await fsp.open(dl.path, "r");
    let prefix;
    try {
      prefix = Buffer.alloc(Math.min(64, bytes));
      await fh.read(prefix, 0, prefix.length, 0);
    } finally {
      await fh.close();
    }
    const mimetype = sniffMimetype(prefix, kind);
    if (!mimetype) {
      throw new Error(`TikTok returned a file that is not a playable ${kind === "audio" ? "audio" : "MP4 video"}. Nothing was sent.`);
    }
    return { path: dl.path, bytes, mimetype, cleanup };
  } catch (error) {
    await cleanup().catch(() => {});
    throw error;
  }
}

function runFfmpeg(args, timeoutMs) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(resolveFfmpeg(), args, { stdio: ["ignore", "ignore", "pipe"] });
    } catch (error) {
      return resolve({ error, stderr: "" });
    }
    let stderr = "";
    let timedOut = false;
    proc.stderr.on("data", (chunk) => { if (stderr.length < 2000) stderr += chunk.toString(); });
    const timer = setTimeout(() => { timedOut = true; try { proc.kill("SIGKILL"); } catch {} }, timeoutMs);
    proc.on("error", (error) => { clearTimeout(timer); resolve({ error, stderr, timedOut }); });
    proc.on("exit", (code, signal) => { clearTimeout(timer); resolve({ code, signal, stderr, timedOut }); });
  });
}

const { processVideoTo4k } = require("./tt4kVideo.cjs");
const TT4K_TIMEOUT_MS = 420000;

// Reads the first video stream's size and bitrate with ffmpeg (no output file). Never throws.
async function probeSourceVideo(inPath) {
  let stderr = "";
  try {
    await execFileAsync(resolveFfmpeg(), ["-hide_banner", "-i", inPath], { timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
  } catch (err) {
    // ffmpeg with no output target exits non-zero but prints the stream list to stderr.
    stderr = String((err && err.stderr) || "");
  }
  const videoLine = (stderr.match(/Stream #\d+:\d+[^\n]*Video:[^\n]*/) || [])[0] || "";
  const audioLine = (stderr.match(/Stream #\d+:\d+[^\n]*Audio:[^\n]*/) || [])[0] || "";
  if (!videoLine) return null;
  const size = videoLine.match(/\s(\d{2,5})x(\d{2,5})[\s,]/);
  const videoKbpsText = (videoLine.match(/(\d+) kb\/s/) || [])[1];
  const audioKbpsText = (audioLine.match(/(\d+) kb\/s/) || [])[1];
  const totalKbpsText = (stderr.match(/bitrate: (\d+) kb\/s/) || [])[1];
  let videoKbps = videoKbpsText ? Number(videoKbpsText) : null;
  if (!videoKbps && totalKbpsText) {
    videoKbps = Math.max(0, Number(totalKbpsText) - (audioKbpsText ? Number(audioKbpsText) : 0));
  }
  const width = size ? Number(size[1]) : 0;
  const height = size ? Number(size[2]) : 0;
  return { width, height, shortSide: Math.min(width, height), videoKbps: videoKbps || null };
}

// Picks the H.264 bitrate for the 1.3 encode from the source probe. Unknown source = reference rate.
function pickHdBitrate(probe, boost = HD_BOOST) {
  if (!probe || !probe.shortSide || !probe.videoKbps) return HD_REFERENCE_KBPS;
  const alreadyAtHdState = probe.shortSide >= HD_REFERENCE_SHORT_SIDE && probe.videoKbps >= HD_REFERENCE_KBPS;
  if (!alreadyAtHdState) return HD_REFERENCE_KBPS;
  return Math.min(Math.round(probe.videoKbps * boost), HD_MAX_KBPS);
}

/**
 * Re-encodes a video file on disk to a high-quality WhatsApp MP4.
 * The input is never deleted here; the caller owns it.
 * @returns {Promise<{path: string, bytes: number, cleanup: () => Promise<void>}>}
 */
async function reencodeHdForWhatsApp(input, { timeoutMs = HD_ENCODE_TIMEOUT_MS, maxBytes = TT_INLINE_VIDEO_MAX_BYTES, boost = HD_BOOST } = {}) {
  const inPath = typeof input === "string" ? input : input.path;
  ensureWorkDir();
  const out = tempPath("hd", ".mp4");
  const cleanup = async () => { await fsp.rm(out, { force: true }).catch(() => {}); };
  const probe = await probeSourceVideo(inPath).catch(() => null);
  const kbps = pickHdBitrate(probe, boost);
  const deadline = Date.now() + timeoutMs;
  let run = await runFfmpeg(HD_ARGS(inPath, out, kbps), timeoutMs);
  // Killed by the kernel (usually out of memory), not by our timeout: the same encode once more with the low-memory settings.
  if (!run.error && run.signal === "SIGKILL" && !run.timedOut) {
    await fsp.rm(out, { force: true }).catch(() => {});
    const remaining = deadline - Date.now();
    if (remaining > 0) run = await runFfmpeg(HD_ARGS(inPath, out, Math.min(kbps, HD_REFERENCE_KBPS), { lowMemory: true }), remaining);
  }
  if (run.error || run.timedOut || run.code !== 0) {
    await cleanup();
    const killed = run.signal ? ` (killed by ${run.signal}${run.signal === "SIGKILL" ? ", usually out of memory" : ""})` : "";
    const stderrText = run.stderr.trim().slice(0, 200);
    const reason = run.timedOut
      ? "timed out"
      : (run.error?.message || `ffmpeg exited with code ${run.code}${killed}${stderrText ? `: ${stderrText}` : ""}`);
    throw new Error(`HD re-encode failed: ${reason}. Nothing was sent.`);
  }
  let stat = await fsp.stat(out).catch(() => null);
  if (!stat || stat.size < MIN_BYTES) {
    await cleanup();
    throw new Error("HD re-encode produced an empty file. Nothing was sent.");
  }

  // No fallback: if output exceeds maxBytes, throw error so caller can use document mode
  if (stat.size > maxBytes) {
    await cleanup();
    throw new Error("HD video exceeds the 95 MiB size limit. Choose the document option (1.4) to download it.");
  }

  return { path: out, bytes: stat.size, cleanup };
}

/**
 * Delivers one TikTok file from disk.
 * - audio: sent as audio from disk with the sniffed mimetype.
 * - video: re-encoded to HD, then sent as video. Over 92 MB it is sent as a document.
 * - document (mode.document): the provider's original file is sent as a document.
 * The caller owns `file` and must clean it up. Re-encoded temp files are removed here.
 */
async function deliverTikTokFile({
  sock, jid, quoted = null, file, kind = "video", mode = {}, caption = "", fileName = "tiktok.mp4",
}) {
  if (kind === "audio") {
    const audioName = fileName.replace(/\.[a-z0-9]+$/i, "") + (file.mimetype === "audio/mp4" ? ".m4a" : ".mp3");
    const sent = await disk.sendWithRateLimitRetry(async () => {
      const result = await sock.sendMessage(jid, {
        audio: { url: file.path }, mimetype: file.mimetype, ptt: false, fileName: audioName,
      }, { quoted });
      if (!result?.key?.id) throw new Error("WhatsApp did not confirm the audio send; delivery is unconfirmed.");
      return result;
    });
    return { type: "audio", bytes: file.bytes, sent };
  }

  // 1.4: the provider's original file, as a document, untouched.
  if (mode && mode.document && !mode.upscale4k) {
    const sent = await disk.sendDocumentFromDisk(sock, jid, file.path, fileName, caption, quoted);
    return { type: "document", bytes: file.bytes, sent };
  }

  // 1.8 / 1.9: the 4K encoder the picker uses. 1.3 and the rest: 1080p HD re-encode.
  const encoded = mode && mode.upscale4k
    ? await processVideoTo4k(file.path, { timeoutMs: TT4K_TIMEOUT_MS })
    : await reencodeHdForWhatsApp(file);
  try {
    if (mode && mode.document) {
      const sent = await disk.sendDocumentFromDisk(
        sock, jid, encoded.path, fileName, caption, quoted,
      );
      return { type: "document", bytes: encoded.bytes, sent };
    }
    if (encoded.bytes > TT_INLINE_VIDEO_MAX_BYTES) {
      throw new Error("The video exceeds the 95 MiB size limit. Choose an explicit document option to send it as a document.");
    }
    const sent = await disk.sendVideoFromDisk(sock, jid, encoded.path, caption, quoted);
    return { type: "video", bytes: encoded.bytes, sent };
  } finally {
    try { await encoded.cleanup(); } catch {}  // 4K cleanup is synchronous; both kinds are safe here
  }
}

module.exports = {
  HD_ARGS,
  HD_REFERENCE_KBPS,
  HD_BOOST,
  HD_MAX_KBPS,
  pickHdBitrate,
  probeSourceVideo,
  TT_INLINE_VIDEO_MAX_BYTES,
  WORK_DIR,
  deliverTikTokFile,
  fetchTikTokToDisk,
  reencodeHdForWhatsApp,
  sniffMimetype,
};
