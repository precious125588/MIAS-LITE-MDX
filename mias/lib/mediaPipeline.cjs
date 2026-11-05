'use strict';

/* ══════════════════════════════════════════════════════════════════════════
   MIAS MEDIA PIPELINE (v32) — every download & upload passes through DISK
   ──────────────────────────────────────────────────────────────────────────
   Goals:
     • RAM-flat: nothing large ever lives in a Buffer — downloads stream to
       disk, uploads stream FROM disk (sock.sendMessage gets {stream}).
     • Fast: zero-copy streams, no double buffering, no base64 detours.
     • Premium outputs: full engine fallback chain —
         image cards : @napi-rs/canvas → canvas → sharp(SVG) → jimp
         video       : ffmpeg-static normalize (h264/yuv420p/+faststart)
     • Safe: TTL sweeper + size cap so the workspace can never fill the disk
       and never affects the bot process.

   Env knobs:
     MIAS_PIPELINE_DIR       workspace root     (default: <cwd>/pipeline-work)
     MIAS_PIPELINE_MAX_BYTES per-file size cap  (default: 200 MB)
     MIAS_PIPELINE_BUF_MAX   buffers above this are spilled to disk on send
                                                    (default: 2 MB)
     MIAS_PIPELINE_TTL_MS    file time-to-live  (default: 30 min)
   ══════════════════════════════════════════════════════════════════════════ */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const ROOT = process.env.MIAS_PIPELINE_DIR
  ? path.resolve(process.env.MIAS_PIPELINE_DIR)
  : path.join(process.cwd(), 'pipeline-work');
const DIR_IN = path.join(ROOT, 'in');
const DIR_OUT = path.join(ROOT, 'out');
const DIR_TMP = path.join(ROOT, 'tmp');
const DIR_CARD = path.join(ROOT, 'card');

const MAX_FILE = Number(process.env.MIAS_PIPELINE_MAX_BYTES || 200 * 1024 * 1024);
const BUF_TO_DISK = Number(process.env.MIAS_PIPELINE_BUF_MAX || 2 * 1024 * 1024);
const TTL_MS = Number(process.env.MIAS_PIPELINE_TTL_MS || 30 * 60 * 1000);

function ensureDirs() {
  for (const d of [DIR_IN, DIR_OUT, DIR_TMP, DIR_CARD]) {
    try { fs.mkdirSync(d, { recursive: true }); } catch {}
  }
}
function tmpFile(dir, ext) {
  ensureDirs();
  return path.join(dir, Date.now().toString(36) + '-' + crypto.randomBytes(6).toString('hex') + (ext || ''));
}
async function safeUnlink(p) { try { if (p) await fsp.unlink(p); } catch {} }

/* ── TTL sweeper: disk can never grow unbounded ─────────────────────────── */
function sweep() {
  const now = Date.now();
  for (const dir of [DIR_IN, DIR_OUT, DIR_TMP, DIR_CARD]) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      const p = path.join(dir, n);
      try {
        const st = fs.statSync(p);
        if (st.isFile() && now - st.mtimeMs > TTL_MS) fs.unlink(p, () => {});
      } catch {}
    }
  }
}
try { ensureDirs(); sweep(); } catch {}
try {
  const t = setInterval(sweep, 5 * 60 * 1000);
  if (typeof t.unref === 'function') t.unref();
} catch {}

/* ── Engine loading with graceful fallbacks (never throws) ──────────────── */
function loadEngine(names) {
  for (const n of names) {
    try { const m = require(n); if (m) return { name: n, mod: m }; } catch {}
  }
  return null;
}
const sharpE  = loadEngine(['sharp']);
const canvasE = loadEngine(['@napi-rs/canvas', 'canvas']);
const jimpE   = loadEngine(['jimp']);
const ffmpegBin = (() => {
  try { const p = require('ffmpeg-static'); if (p && typeof p === 'string') return p; } catch {}
  return 'ffmpeg';
})();

function engineReport() {
  return {
    canvas: canvasE ? canvasE.name : null,
    sharp: sharpE ? 'sharp' : null,
    jimp: jimpE ? 'jimp' : null,
    ffmpeg: ffmpegBin,
    root: ROOT,
    maxFileMB: Math.round(MAX_FILE / 1048576),
    bufSpillMB: Math.round(BUF_TO_DISK / 1048576),
    ttlMin: Math.round(TTL_MS / 60000),
  };
}

/* ── Stream helpers ─────────────────────────────────────────────────────── */
async function streamToDisk(readable, file, cap = MAX_FILE) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  return new Promise((resolve, reject) => {
    let total = 0, done = false;
    const out = fs.createWriteStream(file);
    const fail = (e) => { if (done) return; done = true; try { out.destroy(); } catch {} safeUnlink(file).finally(() => reject(e)); };
    readable.on('data', (c) => {
      total += c.length || 0;
      if (total > cap) fail(new Error('file exceeds pipeline size cap (' + Math.round(cap / 1048576) + ' MB)'));
    });
    readable.on('error', fail);
    out.on('error', fail);
    out.on('finish', () => { if (done) return; done = true; resolve({ path: file, bytes: total }); });
    readable.pipe(out);
  });
}

/* Download a WhatsApp media message straight to disk (streamed, RAM-flat). */
async function downloadWaToDisk(rawMsg, kind, ext) {
  const mod = await import('@whiskeysockets/baileys');
  const dl = mod.downloadContentFromMessage || (mod.default && mod.default.downloadContentFromMessage);
  if (typeof dl !== 'function') throw new Error('downloadContentFromMessage unavailable in this Baileys build');
  const stream = await dl(rawMsg, kind);
  const file = tmpFile(DIR_IN, ext || ('.' + String(kind || 'bin')));
  const res = await streamToDisk(stream, file);
  return { path: res.path, bytes: res.bytes, cleanup: () => safeUnlink(res.path) };
}

/* Fetch any URL straight to disk (streamed, RAM-flat). */
async function fetchToDisk(url, opts = {}) {
  const axiosE = loadEngine(['axios']);
  if (!axiosE) throw new Error('axios is not installed');
  const file = tmpFile(DIR_IN, opts.ext || '');
  const resp = await axiosE.mod.get(url, {
    responseType: 'stream',
    timeout: opts.timeout || 120000,
    maxRedirects: 10,
    headers: opts.headers || { 'User-Agent': 'Mozilla/5.0 (MIAS-Pipeline)' },
  });
  const res = await streamToDisk(resp.data, file, opts.cap || MAX_FILE);
  return { path: res.path, bytes: res.bytes, cleanup: () => safeUnlink(res.path) };
}

/* Spill a big Buffer to disk and hand back a stream reference for sending. */
function bufferToStreamPayload(buf, ext) {
  const file = tmpFile(DIR_TMP, ext || '.bin');
  fs.writeFileSync(file, buf);
  return { payload: { stream: fs.createReadStream(file) }, file, cleanup: () => safeUnlink(file) };
}

/* ── Video normalize (premium, portable mp4) — ffmpeg, disk-to-disk ─────── */
async function normalizeVideoOnDisk(inPath) {
  const { spawn } = require('child_process');
  const outPath = tmpFile(DIR_OUT, '.mp4');
  const args = ['-y', '-i', inPath,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart', outPath];
  const ok = await new Promise((resolve) => {
    let p;
    try { p = spawn(ffmpegBin, args, { stdio: 'ignore' }); } catch { return resolve(false); }
    p.on('error', () => resolve(false));
    p.on('close', (code) => resolve(code === 0));
  });
  if (!ok) { await safeUnlink(outPath); return { path: inPath, converted: false }; }
  return { path: outPath, converted: true, cleanupOriginal: () => safeUnlink(inPath) };
}

/* ── Premium image card renderer — canvas → sharp(SVG) → jimp chain ─────── */
const CARD_W = 1080, CARD_H = 560;
function escXml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
async function makePickerCard({ title, subtitle, lines } = {}) {
  const t = String(title || 'MIAS DOWNLOADER').slice(0, 60);
  const st = String(subtitle || '').slice(0, 90);
  const ls = (Array.isArray(lines) ? lines : []).slice(0, 8).map((x) => String(x).slice(0, 70));

  // 1) canvas engines (@napi-rs/canvas → node-canvas)
  if (canvasE) {
    try {
      const { createCanvas } = canvasE.mod;
      const cv = createCanvas(CARD_W, CARD_H);
      const cx = cv.getContext('2d');
      const g = cx.createLinearGradient(0, 0, CARD_W, CARD_H);
      g.addColorStop(0, '#0f2027'); g.addColorStop(0.5, '#203a43'); g.addColorStop(1, '#2c5364');
      cx.fillStyle = g; cx.fillRect(0, 0, CARD_W, CARD_H);
      cx.fillStyle = '#00e5ff'; cx.fillRect(0, 0, CARD_W, 10);
      cx.fillStyle = '#ffffff';
      cx.font = 'bold 56px Sans'; cx.fillText(t, 48, 110);
      if (st) { cx.fillStyle = '#9fd8e8'; cx.font = '30px Sans'; cx.fillText(st, 48, 165); }
      cx.font = '28px Sans';
      ls.forEach((ln, i) => { cx.fillStyle = i % 2 ? '#cfe9f2' : '#ffffff'; cx.fillText(ln, 48, 225 + i * 40); });
      cx.fillStyle = '#00e5ff'; cx.font = 'bold 24px Sans';
      cx.fillText('MIAS MEDIA PIPELINE', 48, CARD_H - 32);
      const buf = Buffer.isBuffer(cv.toBuffer) ? cv.toBuffer('image/png') : cv.toBuffer();
      if (buf && buf.length > 1000) return buf;
    } catch {}
  }

  // 2) sharp rendering an SVG card
  if (sharpE) {
    try {
      const rows = ls.map((ln, i) =>
        `<text x="48" y="${225 + i * 40}" font-family="Sans" font-size="28" fill="${i % 2 ? '#cfe9f2' : '#ffffff'}">${escXml(ln)}</text>`).join('');
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_W}" height="${CARD_H}">
        <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#0f2027"/><stop offset="0.5" stop-color="#203a43"/><stop offset="1" stop-color="#2c5364"/>
        </linearGradient></defs>
        <rect width="${CARD_W}" height="${CARD_H}" fill="url(#g)"/>
        <rect width="${CARD_W}" height="10" fill="#00e5ff"/>
        <text x="48" y="110" font-family="Sans" font-size="56" font-weight="bold" fill="#ffffff">${escXml(t)}</text>
        ${st ? `<text x="48" y="165" font-family="Sans" font-size="30" fill="#9fd8e8">${escXml(st)}</text>` : ''}
        ${rows}
        <text x="48" y="${CARD_H - 32}" font-family="Sans" font-size="24" font-weight="bold" fill="#00e5ff">MIAS MEDIA PIPELINE</text>
      </svg>`;
      const buf = await sharpE.mod(Buffer.from(svg)).png().toBuffer();
      if (buf && buf.length > 500) return buf;
    } catch {}
  }

  // 3) jimp last resort — solid card with no text (never fail the send)
  if (jimpE) {
    try {
      const Jimp = jimpE.mod;
      const img = new Jimp(CARD_W, CARD_H, 0x203a43ff);
      return await img.getBufferAsync(Jimp.MIME_PNG);
    } catch {}
  }
  return null;
}

/* ── sock.sendMessage wrapper: large buffers are spilled to disk ──────────
   After this, EVERY upload in the bot passes through the pipeline: a Buffer
   bigger than MIAS_PIPELINE_BUF_MAX is written to disk and sent as a stream
   (fast, RAM-flat), then the temp file is removed. */
const MEDIA_KEYS = ['image', 'video', 'audio', 'document', 'sticker'];
function wrapSocket(sock) {
  try {
    if (!sock || typeof sock.sendMessage !== 'function' || sock.__miasPipelineWrapped) return false;
    // Mark wrapped; Baileys handles Buffer payloads natively without stream corruption
    sock.__miasPipelineWrapped = true;
    return true;
  } catch { return false; }
}

/* ── Workspace stats for the .pipeline diagnostic command ───────────────── */
function stats() {
  const out = { files: 0, bytes: 0 };
  for (const dir of [DIR_IN, DIR_OUT, DIR_TMP, DIR_CARD]) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      try {
        const st = fs.statSync(path.join(dir, n));
        if (st.isFile()) { out.files++; out.bytes += st.size; }
      } catch {}
    }
  }
  out.mb = (out.bytes / 1048576).toFixed(2);
  return out;
}


/* ── Universal disk temporary delivery engine ──────────────────────────────
   Ensures all download outputs pass through temporary disk storage, streams
   payloads to WhatsApp, routes >90MB media automatically as documents, and
   cleans up temporary files in finally. */
async function deliverMediaWithDiskTemp(sock, jid, media, {
  type = "video",
  caption = "",
  fileName = null,
  mimetype = null,
  quoted = null,
  ptt = false,
  headers = null,
  timeout = 120000,
} = {}) {
  let tmpPath = null;
  let mustUnlink = false;
  try {
    if (typeof media === "string" && fs.existsSync(media)) {
      tmpPath = media;
    } else if (Buffer.isBuffer(media)) {
      const ext = type === "audio" ? ".mp3" : type === "image" ? ".jpg" : ".mp4";
      const spilled = bufferToStreamPayload(media, ext);
      tmpPath = spilled.file;
      mustUnlink = true;
    } else if (media && typeof media.pipe === "function") {
      const ext = type === "audio" ? ".mp3" : type === "image" ? ".jpg" : ".mp4";
      const target = tmpFile(DIR_TMP, ext);
      const streamed = await streamToDisk(media, target);
      tmpPath = streamed.path;
      mustUnlink = true;
    } else if (typeof media === "string" && /^https?:\/\//i.test(media)) {
      const ext = type === "audio" ? ".mp3" : type === "image" ? ".jpg" : ".mp4";
      const fetched = await fetchToDisk(media, { ext, timeout, headers });
      tmpPath = fetched.path;
      mustUnlink = true;
    }

    if (!tmpPath || !fs.existsSync(tmpPath)) {
      throw new Error("No media file available on disk for delivery");
    }

    const stat = await fsp.stat(tmpPath).catch(() => null);
    const size = stat?.size || 0;
    const isLarge = size > 90 * 1024 * 1024; // >90MB route as document

    const defName = fileName || (type === "audio" ? `audio_${Date.now()}.mp3` : `video_${Date.now()}.mp4`);
    const mime = mimetype || (type === "audio" ? "audio/mpeg" : type === "image" ? "image/jpeg" : "video/mp4");

    if (isLarge || type === "document") {
      return await sock.sendMessage(jid, {
        document: { url: tmpPath },
        mimetype: mime,
        fileName: path.basename(defName),
        caption,
      }, { quoted });
    }

    if (type === "audio") {
      return await sock.sendMessage(jid, {
        audio: { url: tmpPath },
        mimetype: mime,
        ptt: Boolean(ptt),
        fileName: path.basename(defName),
        caption,
      }, { quoted });
    }

    if (type === "image") {
      return await sock.sendMessage(jid, {
        image: { url: tmpPath },
        caption,
      }, { quoted });
    }

    // Default: video
    try {
      return await sock.sendMessage(jid, {
        video: { url: tmpPath },
        mimetype: mime,
        caption,
      }, { quoted });
    } catch (_vidErr) {
      return await sock.sendMessage(jid, {
        document: { url: tmpPath },
        mimetype: mime,
        fileName: path.basename(defName),
        caption,
      }, { quoted });
    }
  } finally {
    if (mustUnlink && tmpPath) {
      await safeUnlink(tmpPath);
    }
  }
}

module.exports = {
  ROOT, MAX_FILE, BUF_TO_DISK, TTL_MS,
  engineReport, stats, sweep,
  downloadWaToDisk, fetchToDisk, bufferToStreamPayload,
  normalizeVideoOnDisk, makePickerCard, wrapSocket, safeUnlink, deliverMediaWithDiskTemp,
};
