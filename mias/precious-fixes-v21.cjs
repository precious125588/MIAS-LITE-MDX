/* ══════════════════════════════════════════════════════════════════════════
   precious-fixes-v21.cjs · PRECIOUS FIX PACK v21 (drop-in, installs LAST)
   ──────────────────────────────────────────────────────────────────────────
   WHY YOUR OLD CODE "CAME BACK":
     .play / .gst / .tgsticker / .shazam are re-registered by SEVERAL blocks
     inside mias/index.js (the base cmd(...) plus the late v20/v21/v23/JINX
     patches). The `commands` map is keyed by name, so the LAST registration
     always wins. Older builds shipped a `.cjs` patch that re-registered
     these commands AFTER your fix — restoring the dead-API handlers.
     This module installs from the very END of index.js (after every other
     patch) and re-registers the four commands ONE FINAL TIME, so the fixed
     handlers are always the ones that survive.

   WHAT IT FIXES:
     • .nkiri <title>  → search (max 20) → native-flow list → season list →
       episode list → download sent as a DOCUMENT (from-URL, so a huge file
       streams straight to WhatsApp and never touches RAM / never lags bot).
     • .tgsticker <t.me pack url> → Telegram sticker pack → WhatsApp stickers
       (animated .tgs and video .webm converted to animated WebP via ffmpeg).
     • .shazam (reply to audio/voice/video) → identifies the song via the
       David Cyril Shazam API (audio uploaded to Catbox first for a URL).
     • .gst — kept from v20 (timeout + watchdog + always-settle reaction).

   ONLY THESE APIS ARE USED:
       https://apis.davidcyril.name.ng/movies/search      (Nkiri search)
       https://apis.davidcyril.name.ng/movies/info        (seasons/episodes)
       https://apis.davidcyril.name.ng/nkiri/download     (direct link)
       https://apis.davidcyril.name.ng/telegram-sticker   (TG sticker packs)
       https://apis.davidcyril.name.ng/shazam             (song identify)
       https://apis.davidcyril.name.ng/uploader/catbox    (audio → URL)
   ══════════════════════════════════════════════════════════════════════════ */

'use strict';

const axios = require('axios');
const zlib  = require('zlib');
const os    = require('os');
const fs    = require('fs');
const path  = require('path');
const { spawn } = require('child_process');

const DC = 'https://apis.davidcyril.name.ng';

/* ── helpers ─────────────────────────────────────────────────────────────── */

const race = (p, ms, tag) => Promise.race([
  Promise.resolve(p),
  new Promise((_, rj) => setTimeout(() => rj(new Error((tag || 'op') + ' timed out after ' + Math.round(ms / 1000) + 's')), ms)),
]);

async function dcGet(p, params, timeout = 25000) {
  const { data } = await axios.get(DC + p, { params, timeout });
  return data;
}

const unwrap = (m) => (!m || typeof m !== 'object') ? m : (
  m.ephemeralMessage?.message ||
  m.viewOnceMessage?.message ||
  m.viewOnceMessageV2?.message ||
  m.viewOnceMessageV2Extension?.message ||
  m.documentWithCaptionMessage?.message || m);

function ffmpegBin() {
  try { const p = require('ffmpeg-static'); if (p && typeof p === 'string') return p; } catch {}
  return 'ffmpeg';
}

function runFfmpeg(args, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    let pr = null;
    try { pr = spawn(ffmpegBin(), args, { stdio: ['ignore', 'ignore', 'pipe'] }); } catch (e) { return reject(e); }
    // Missing/empty stdout|stderr means the binary could not be started —
    // attaching .on to null throws "Cannot read properties of null (reading 'on')".
    if (!pr || !pr.stderr) return reject(new Error(ffmpegBin() + ' could not be started (binary not found)'));
    let err = '';
    try { pr.stderr.on('data', d => { err += d.toString(); }); } catch {}
    const to = setTimeout(() => { try { pr.kill('SIGKILL'); } catch {} reject(new Error('ffmpeg timeout')); }, timeoutMs);
    pr.on('error', e => { clearTimeout(to); reject(e); });
    pr.on('close', c => { clearTimeout(to); c === 0 ? resolve() : reject(new Error('ffmpeg exited ' + c + ': ' + err.slice(-200))); });
  });
}

/* WhatsApp sticker EXIF metadata (pack name / publisher). */
async function tagSticker(webpBuf, pack, author) {
  try {
    const mod = await import('node-webpmux');
    const WebPMux = mod.default || mod;
    if (typeof WebPMux.Image?.initLib === 'function') { try { await WebPMux.Image.initLib(); } catch {} }
    const payload = Buffer.from(JSON.stringify({
      'sticker-pack-id': 'com.mias.tgsticker',
      'sticker-pack-name': String(pack || 'Telegram').slice(0, 120),
      'sticker-pack-publisher': String(author || 'MIAS MDX').slice(0, 120),
      emojis: ['🎭'],
    }), 'utf8');
    const header = Buffer.from([0x49,0x49,0x2A,0x00,0x08,0x00,0x00,0x00,0x01,0x00,0x41,0x57,0x07,0x00,0x00,0x00,0x00,0x00,0x16,0x00,0x00,0x00]);
    header.writeUInt32LE(payload.length, 14);
    const img = new WebPMux.Image();
    await img.load(webpBuf);
    img.exif = Buffer.concat([header, payload]);
    const out = await img.save(null, { exif: true });
    return (out && out.length > 12 && out.slice(0,4).toString() === 'RIFF') ? out : webpBuf;
  } catch { return webpBuf; }
}

/* Convert a TG sticker buffer (.tgs lottie / .webm video / static image) → WhatsApp animated/static WebP. */
async function tgToWebp(buffer, url) {
  const isTgs  = /\.tgs(\?|$)/i.test(url || '');
  const isWebm = /\.webm(\?|$)/i.test(url || '');
  const isAnim = isTgs || isWebm;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgstk-'));
  try {
    let input = buffer;
    let inExt = isWebm ? 'webm' : (isTgs ? 'tgs' : 'img');
    if (isTgs) {
      // .tgs is gzip-compressed Lottie JSON — ffmpeg's lottie decoder wants it raw.
      try { input = zlib.gunzipSync(buffer); inExt = 'json'; } catch { inExt = 'tgs'; }
    }
    const inPath  = path.join(dir, 'in.' + inExt);
    const outPath = path.join(dir, 'out.webp');
    fs.writeFileSync(inPath, input);

    if (!isAnim) {
      // static image → 512x512 static webp
      await runFfmpeg(['-y', '-i', inPath, '-vf', 'scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000', '-c:v', 'libwebp', '-lossless', '0', '-q:v', '70', '-preset', 'picture', '-loop', '0', outPath], 60000);
      return fs.readFileSync(outPath);
    }

    // animated → try progressively smaller encodes until < 500 KiB
    const attempts = [
      { fps: 15, t: 6, q: 58 }, { fps: 12, t: 5, q: 45 },
      { fps: 10, t: 4, q: 36 }, { fps: 8,  t: 3, q: 26 },
    ];
    let smallest = null, lastErr = null;
    for (const a of attempts) {
      try {
        await runFfmpeg(['-y', '-i', inPath, '-t', String(a.t), '-vf',
          'fps=' + a.fps + ',scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000',
          '-c:v', 'libwebp', '-lossless', '0', '-q:v', String(a.q), '-loop', '0', '-an', outPath], 90000);
        const enc = fs.readFileSync(outPath);
        if (!smallest || enc.length < smallest.length) smallest = enc;
        if (enc.length <= 500 * 1024) break;
      } catch (e) { lastErr = e; }
    }
    if (!smallest) throw lastErr || new Error('animated encode failed');
    return smallest;
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

const NKIRI_PICK_TTL_MS = 10 * 60 * 1000;
const _nkiriPickStore = new Map();
const JX_PLAY_TTL_MS = 20 * 60 * 1000;
const _jxPlayPending = new Map();
const _jxPlayLatestByChat = new Map();
const MOVIE_PICK_TTL_MS = 10 * 60 * 1000;
const _moviePickStore = new Map();
const BOOST6_TTL_MS = 10 * 60 * 1000;
const _boost6Store = new Map();
const GST_PICK_TTL_MS = 10 * 60 * 1000;
const _gstPickStore = new Map();
const YTMATE_TTL_MS = 10 * 60 * 1000;
const _ytmateStore = new Map();
let _v21BoostNumericHandler = null;
let _v21GstNumericHandler = null;

function _nkiriGetState(jid) {
  const state = _nkiriPickStore.get(jid);
  if (!state) return null;
  if (Date.now() - Number(state.ts || 0) > NKIRI_PICK_TTL_MS) {
    _nkiriPickStore.delete(jid);
    return null;
  }
  return state;
}

function _nkiriSetState(jid, next) {
  if (!jid || !next || typeof next !== 'object') return null;
  const state = { ...next, ts: Date.now() };
  _nkiriPickStore.set(jid, state);
  setTimeout(() => {
    const current = _nkiriPickStore.get(jid);
    if (current && current.ts === state.ts) _nkiriPickStore.delete(jid);
  }, NKIRI_PICK_TTL_MS + 1000).unref?.();
  return state;
}

function _nkiriClearState(jid) {
  if (jid) _nkiriPickStore.delete(jid);
}

function _jxPlaySweep() {
  const now = Date.now();
  for (const [key, entry] of _jxPlayPending.entries()) {
    if (!entry || now - Number(entry.ts || 0) > JX_PLAY_TTL_MS) _jxPlayPending.delete(key);
  }
  for (const [chatKey, key] of _jxPlayLatestByChat.entries()) {
    if (!_jxPlayPending.has(key)) _jxPlayLatestByChat.delete(chatKey);
  }
}

function _getTimedState(store, jid, ttlMs) {
  const state = store.get(jid);
  if (!state) return null;
  if (Date.now() - Number(state.ts || 0) > ttlMs) {
    store.delete(jid);
    return null;
  }
  return state;
}

function _setTimedState(store, jid, next, ttlMs) {
  if (!jid || !next || typeof next !== 'object') return null;
  const state = { ...next, ts: Date.now() };
  store.set(jid, state);
  const t = setTimeout(() => {
    const cur = store.get(jid);
    if (cur && cur.ts === state.ts) store.delete(jid);
  }, ttlMs + 1000);
  t?.unref?.();
  return state;
}

function _clearTimedState(store, jid) {
  if (jid) store.delete(jid);
}

function _safeBaseName(name, fallback = 'file', limit = 80) {
  const out = String(name || fallback)
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (out || fallback).slice(0, limit);
}

function _extFromUrl(url) {
  try {
    const clean = String(url || '').split(/[?#]/)[0];
    const ext = path.extname(clean || '').toLowerCase();
    return ext || '';
  } catch {
    return '';
  }
}

function _mimeFromExt(ext = '') {
  const value = String(ext || '').toLowerCase().replace(/^\./, '');
  return value == 'mp3' ? 'audio/mpeg'
    : value == 'm4a' ? 'audio/mp4'
    : value == 'ogg' ? 'audio/ogg; codecs=opus'
    : value == 'wav' ? 'audio/wav'
    : value == 'mp4' ? 'video/mp4'
    : value == 'mkv' ? 'video/x-matroska'
    : value == 'webm' ? 'video/webm'
    : value == 'avi' ? 'video/x-msvideo'
    : 'application/octet-stream';
}

function _looksLikeHtmlOrJson(buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) return false;
  const head = buf.subarray(0, 512).toString('utf8').trim().toLowerCase();
  return /^<!doctype/.test(head) || /^<html/.test(head) || /^\{/.test(head) || /^\[/.test(head);
}

function _audioMetaFromHead(head, contentType = '', url = '') {
  const buf = Buffer.isBuffer(head) ? head : Buffer.from(head || []);
  const ct = String(contentType || '').toLowerCase();
  const extHint = _extFromUrl(url);
  const ftyp = buf.length >= 12 ? buf.subarray(4, 8).toString('ascii') : '';
  const box = buf.length >= 16 ? buf.subarray(8, 16).toString('ascii').toLowerCase() : '';
  if (buf.length >= 3 && buf.subarray(0, 3).toString('ascii') === 'ID3') return { ok: true, ext: '.mp3', mimetype: 'audio/mpeg' };
  if (buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return { ok: true, ext: '.mp3', mimetype: 'audio/mpeg' };
  if (buf.length >= 4 && buf.subarray(0, 4).toString('ascii') === 'OggS') return { ok: true, ext: '.ogg', mimetype: 'audio/ogg; codecs=opus' };
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WAVE') return { ok: true, ext: '.wav', mimetype: 'audio/wav' };
  if (ftyp === 'ftyp' && (/m4a|mp4|isom|mp42|dash/.test(box) || /audio\/mp4|audio\/aac|audio\/x-m4a/.test(ct) || extHint === '.m4a')) return { ok: true, ext: '.m4a', mimetype: 'audio/mp4' };
  if (buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return { ok: true, ext: '.webm', mimetype: /audio\//.test(ct) ? ct : 'audio/webm' };
  if (/audio\//.test(ct)) return { ok: true, ext: extHint || '.bin', mimetype: ct };
  return { ok: false, ext: extHint || '.bin', mimetype: ct || 'application/octet-stream' };
}

function _videoMetaFromHead(head, contentType = '', url = '') {
  const buf = Buffer.isBuffer(head) ? head : Buffer.from(head || []);
  const ct = String(contentType || '').toLowerCase();
  const extHint = _extFromUrl(url);
  const ftyp = buf.length >= 12 ? buf.subarray(4, 8).toString('ascii') : '';
  if (ftyp === 'ftyp') return { ok: true, ext: '.mp4', mimetype: 'video/mp4' };
  if (buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
    const mime = /audio\//.test(ct) ? 'video/webm' : (/video\//.test(ct) ? ct : 'video/webm');
    return { ok: true, ext: extHint == '.mkv' ? '.mkv' : '.webm', mimetype: mime };
  }
  if (/video\//.test(ct)) return { ok: true, ext: extHint || '.mp4', mimetype: ct };
  return { ok: false, ext: extHint || '.bin', mimetype: ct || 'application/octet-stream' };
}

async function _writeTempFile(prefix, ext, buf) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
  const filePath = path.join(dir, 'media' + (ext || '.bin'));
  await fs.promises.writeFile(filePath, buf);
  return { dir, filePath, size: buf.length };
}

async function _fetchBinaryToTemp(url, { maxBytes = 80 * 1024 * 1024, timeout = 180000, prefix = 'v21bin-' } = {}) {
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout,
    maxRedirects: 5,
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: '*/*' },
    validateStatus: (code) => code >= 200 && code < 400,
  });
  const contentType = String(res.headers?.['content-type'] || '').toLowerCase();
  const advertisedSize = Number(res.headers?.['content-length'] || 0);
  if (advertisedSize && advertisedSize > maxBytes) throw new Error('file is larger than allowed size');
  const buf = Buffer.from(res.data || []);
  if (!buf.length) throw new Error('provider returned an empty file');
  if (buf.length > maxBytes) throw new Error('file is larger than allowed size');
  if (_looksLikeHtmlOrJson(buf) && !/audio\/|video\/|octet-stream|application\/x-matroska/.test(contentType)) {
    throw new Error('provider returned a web page instead of media');
  }
  const tmp = await _writeTempFile(prefix, _extFromUrl(url) || '.bin', buf);
  return { ...tmp, contentType, advertisedSize: advertisedSize || buf.length, url, head: buf.subarray(0, 8192) };
}

async function _sendFilePath(sock, jid, kind, filePath, extra = {}, quoted) {
  const buf = Buffer.isBuffer(filePath) ? filePath : await fs.promises.readFile(filePath);
  return await sock.sendMessage(jid, { [kind]: buf, ...extra }, { quoted });
}

async function _transcodeAudioFile(inputPath, targetExt) {
  const target = String(targetExt || '').toLowerCase() === 'ogg' ? 'ogg' : 'mp3';
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'v21aud-'));
  const outPath = path.join(dir, 'out.' + target);
  const args = target === 'ogg'
    ? ['-y', '-i', inputPath, '-vn', '-ac', '2', '-ar', '48000', '-c:a', 'libopus', '-b:a', '128k', outPath]
    : ['-y', '-i', inputPath, '-vn', '-ac', '2', '-ar', '44100', '-c:a', 'libmp3lame', '-b:a', '192k', outPath];
  await runFfmpeg(args, 180000);
  return { dir, filePath: outPath, ext: target === 'ogg' ? '.ogg' : '.mp3', mimetype: target === 'ogg' ? 'audio/ogg; codecs=opus' : 'audio/mpeg' };
}

async function _transcodeVideoToMp4(inputPath) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'v21vid-'));
  const outPath = path.join(dir, 'out.mp4');
  await runFfmpeg(['-y', '-i', inputPath, '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-c:a', 'aac', '-b:a', '128k', outPath], 300000);
  return { dir, filePath: outPath, ext: '.mp4', mimetype: 'video/mp4' };
}

function _probeParseFfprobeJson(out) {
  try {
    const j = JSON.parse(out);
    const streams = (j && j.streams) || [];
    const v = streams.find((s) => s && s.codec_type === 'video');
    const a = streams.find((s) => s && s.codec_type === 'audio');
    if (!v) return null;
    return { hasVideo: true, vcodec: String(v.codec_name || '').toLowerCase(), acodec: String((a && a.codec_name) || '').toLowerCase(), hasAudio: !!a };
  } catch { return null; }
}
function _probeParseFfmpegStderr(err) {
  try {
    // ffmpeg prints "Stream #0:0[0x1](und): Video: h264 (High) ..." on modern
    // builds and "Stream #0:0: Video: h264 ..." on older ones — parse per-line
    // and match the codec token after "Video:"/"Audio:" regardless of the
    // [index](lang) decoration between the stream id and the colon.
    const lines = String(err || '').split(/\r?\n/);
    let v = null;
    let a = null;
    for (const line of lines) {
      if (!/Stream #\d+:\d+/.test(line)) continue;
      const vm = line.match(/:\s*Video:\s*([^,\s(]+)/i);
      const am = line.match(/:\s*Audio:\s*([^,\s(]+)/i);
      if (vm && v === null) v = String(vm[1]).toLowerCase();
      if (am && a === null) a = String(am[1]).toLowerCase();
    }
    if (!v) return null;
    return { hasVideo: true, vcodec: v, acodec: a || '', hasAudio: !!a };
  } catch { return null; }
}
// ffprobe-less fallback: some hosts ship ffmpeg but NOT ffprobe, and a missing
// ffprobe used to crash the video path with "Cannot read properties of null
// (reading 'on')" (spawn returns a child with a null stdout). Parse the stream
// lines out of `ffmpeg -i` stderr instead of crashing.
function _probeVideoCodecsViaFfmpeg(filePath) {
  return new Promise((resolve) => {
    let pr = null;
    try { pr = spawn(ffmpegBin(), ['-i', filePath], { stdio: ['ignore', 'ignore', 'pipe'] }); } catch { return resolve(null); }
    if (!pr || !pr.stderr) return resolve(null);
    let err = '';
    try { pr.stderr.on('data', (d) => { err += d.toString(); }); } catch {}
    pr.on('error', () => resolve(_probeParseFfmpegStderr(err)));
    pr.on('close', () => resolve(_probeParseFfmpegStderr(err)));
  });
}
function _probeVideoCodecs(filePath) {
  return new Promise((resolve) => {
    let bin = 'ffprobe';
    try { const fp = require('ffprobe-static'); if (fp && fp.path) bin = fp.path; } catch {}
    let pr = null;
    try { pr = spawn(bin, ['-v', 'error', '-print_format', 'json', '-show_streams', filePath], { stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return _probeVideoCodecsViaFfmpeg(filePath).then(resolve); }
    if (!pr || !pr.stdout) return _probeVideoCodecsViaFfmpeg(filePath).then(resolve);
    let out = '';
    let err = '';
    try { pr.stdout.on('data', (d) => { out += d.toString(); }); } catch {}
    try { pr.stderr.on('data', (d) => { err += d.toString(); }); } catch {}
    const to = setTimeout(() => { try { pr.kill('SIGKILL'); } catch {} resolve(null); }, 20000);
    pr.on('error', () => { clearTimeout(to); _probeVideoCodecsViaFfmpeg(filePath).then(resolve); });
    pr.on('close', (c) => {
      clearTimeout(to);
      if (c !== 0) return _probeVideoCodecsViaFfmpeg(filePath).then(resolve);
      resolve(_probeParseFfprobeJson(out));
    });
  });
}

// Guarantee a WhatsApp-playable MP4: H.264 video + AAC audio + faststart moov.
// WHATSAPP FIX (black screen with sound): WhatsApp mobile only reliably plays
// H.264 **Baseline/Main profile** — YouTube and most APIs serve High profile,
// which renders as a black video with audio. We therefore ALWAYS re-encode to
// Main profile + yuv420p + even dimensions + faststart. The old `-c copy`
// fast path was removed: it preserved the High profile and caused the bug.
async function _ensureWaVideo(inputPath, { timeoutMs = 300000 } = {}) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wavid-'));
  const outPath = path.join(dir, 'wa.mp4');
  await runFfmpeg(['-y', '-i', inputPath,
    '-c:v', 'libx264', '-profile:v', 'main', '-level', '3.1',
    '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2:force_original_aspect_ratio=decrease',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100',
    '-movflags', '+faststart', outPath], timeoutMs);
  return { dir, filePath: outPath };
}

function _messageContextInfo(msg) {
  return msg?.message?.extendedTextMessage?.contextInfo
    || msg?.message?.imageMessage?.contextInfo
    || msg?.message?.videoMessage?.contextInfo
    || msg?.message?.audioMessage?.contextInfo
    || msg?.message?.documentMessage?.contextInfo
    || msg?.message?.buttonsResponseMessage?.contextInfo
    || msg?.message?.listResponseMessage?.contextInfo
    || msg?.message?.interactiveResponseMessage?.contextInfo
    || msg?.message?.messageContextInfo
    || null;
}

function _quotedMessageOf(msg) {
  const ctxi = _messageContextInfo(msg);
  return ctxi?.quotedMessage ? unwrap(ctxi.quotedMessage) : null;
}

function _innerMediaOf(messageNode) {
  const m = unwrap(messageNode || {});
  if (!m || typeof m !== 'object') return null;
  if (m.imageMessage) return { kind: 'image', raw: m.imageMessage };
  if (m.videoMessage) return { kind: 'video', raw: m.videoMessage };
  if (m.audioMessage) return { kind: 'audio', raw: m.audioMessage };
  if (m.stickerMessage) return { kind: 'sticker', raw: m.stickerMessage };
  if (m.documentMessage) return { kind: 'document', raw: m.documentMessage };
  return null;
}

function _textOfMessage(messageNode) {
  const m = unwrap(messageNode || {});
  return m?.conversation || m?.extendedTextMessage?.text || m?.imageMessage?.caption || m?.videoMessage?.caption || '';
}

async function _bufferFromInner(ctx, inner) {
  const dl = ctx.downloadContentFromMessage;
  if (typeof dl !== 'function') return null;
  let out = Buffer.from([]);
  const stream = await dl(inner.raw, inner.kind === 'document' ? 'document' : inner.kind);
  for await (const chunk of stream) out = Buffer.concat([out, chunk]);
  return out;
}

function _parseCountText(raw) {
  const norm = String(raw || '').trim().replace(/[ ,]+/g, '');
  if (!/^\d{1,9}$/.test(norm)) return NaN;
  return Number(norm);
}

function _boostLabel(kind) {
  const value = String(kind || '').toLowerCase();
  return value === 'followers' ? 'Followers' : value === 'likes' ? 'Likes' : 'Views';
}


function _imageMetaFromHead(buf, contentType = '', url = '') {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  const ct = String(contentType || '').toLowerCase();
  const ext = _extFromUrl(url) || '.jpg';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ok: true, ext: '.jpg', mimetype: 'image/jpeg' };
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { ok: true, ext: '.png', mimetype: 'image/png' };
  if (b.length >= 12 && b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP') return { ok: true, ext: '.webp', mimetype: 'image/webp' };
  if (b.length >= 6 && (b.subarray(0, 6).toString('ascii') === 'GIF87a' || b.subarray(0, 6).toString('ascii') === 'GIF89a')) return { ok: true, ext: '.gif', mimetype: 'image/gif' };
  if (/^image\//.test(ct)) return { ok: true, ext, mimetype: ct.split(';')[0] || _mimeFromExt(ext) };
  return { ok: false, ext: '', mimetype: '' };
}

function _binaryMetaFromHead(buf, contentType = '', url = '') {
  const image = _imageMetaFromHead(buf, contentType, url);
  if (image.ok) return { ...image, kind: 'image' };
  const video = _videoMetaFromHead(buf, contentType, url);
  if (video.ok) return { ...video, kind: 'video' };
  const audio = _audioMetaFromHead(buf, contentType, url);
  if (audio.ok) return { ...audio, kind: 'audio' };
  const ext = _extFromUrl(url) || '.bin';
  const ct = String(contentType || '').toLowerCase();
  if (/^application\//.test(ct) || /\.(apk|zip|pdf|docx?|xlsx?|pptx?)(?:$|[?#])/i.test(String(url || ''))) {
    return { ok: true, ext, mimetype: ct.split(';')[0] || _mimeFromExt(ext), kind: 'document' };
  }
  return { ok: false, ext, mimetype: ct || _mimeFromExt(ext), kind: 'document' };
}

function _collectHttpUrls(value, out = [], seen = new Set()) {
  if (!value) return out;
  if (typeof value === 'string') {
    if (/^https?:\/\//i.test(value)) out.push(value);
    return out;
  }
  if (typeof value !== 'object') return out;
  if (seen.has(value)) return out;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) _collectHttpUrls(item, out, seen);
    return out;
  }
  for (const v of Object.values(value)) _collectHttpUrls(v, out, seen);
  return out;
}

async function _probeRemoteMedia(url, kind = 'any') {
  try {
    const res = await axios.get(url, {
      responseType: 'stream',
      timeout: 45000,
      maxRedirects: 5,
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: '*/*' },
      validateStatus: () => true,
    });
    if (!(res.status >= 200 && res.status < 400)) {
      res.data?.destroy?.();
      return null;
    }
    const contentType = String(res.headers?.['content-type'] || '').toLowerCase();
    const chunks = [];
    let total = 0;
    for await (const chunk of res.data) {
      if (!chunk?.length) continue;
      chunks.push(chunk);
      total += chunk.length;
      if (total >= 8192) break;
    }
    res.data?.destroy?.();
    const head = Buffer.concat(chunks);
    if (!head.length) return null;
    const meta = _binaryMetaFromHead(head, contentType, url);
    if (!meta.ok) return null;
    if (kind !== 'any' && meta.kind !== kind) return null;
    return { url, contentType, meta };
  } catch {
    return null;
  }
}

async function _downloadFirstWorkingMedia(urls, { kind = 'any', maxBytes = 180 * 1024 * 1024, timeout = 240000, prefix = 'v21dl-' } = {}) {
  let lastErr = null;
  const list = [...new Set((urls || []).filter((u) => /^https?:\/\//i.test(String(u || ''))))];
  for (const url of list) {
    try {
      const fetched = await _fetchBinaryToTemp(url, { maxBytes, timeout, prefix });
      const meta = _binaryMetaFromHead(fetched.head, fetched.contentType, url);
      if (!meta.ok) {
        await fs.promises.rm(fetched.dir, { recursive: true, force: true }).catch(() => {});
        continue;
      }
      if (kind !== 'any' && meta.kind !== kind) {
        await fs.promises.rm(fetched.dir, { recursive: true, force: true }).catch(() => {});
        continue;
      }
      return { url, fetched, meta };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('no working media file was returned');
}

async function _thumbBufferFromUrl(url) {
  if (!/^https?:\/\//i.test(String(url || ''))) return null;
  try {
    const res = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 20000,
      maxRedirects: 5,
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'image/*,*/*;q=0.8' },
      validateStatus: (code) => code >= 200 && code < 400,
    });
    const buf = Buffer.from(res.data || []);
    return buf.length ? buf : null;
  } catch {
    return null;
  }
}


/* ── module ──────────────────────────────────────────────────────────────── */

function install(ctx) {
  const report = { nkiri: false, movie: false, play: false, upload8: false, boost6: false, tgsticker: false, shazam: false, gst: false };
  const { cmd, CONFIG, sendReply, react } = ctx;
  const PREFIX = (CONFIG && CONFIG.PREFIX) || '.';

  const safeReact = (sock, msg, emoji) => { try { return react(sock, msg, emoji); } catch { return Promise.resolve(); } };

  /* ── PRECIOUS v22 hot-fix ──────────────────────────────────────────────────
     Player helpers were previously `const`-declared inside the .play try-block,
     which made them invisible to the .ytmate try-block -> ReferenceError floods
     in Railway logs ("playEnrich is not defined"). Forward-declare them at
     install() scope (let) so both try-blocks share them; .play try-block
     reassigns them with the real bodies. */

  const __normalizePlayJid = (jid) => String(jid || '').replace(/:\d+(?=@)/, '');

  const PLAY_HEADER_22 = '───── 𝑷𝑹𝑬𝑪𝑰𝑶𝑼𝑺 x PLAYER ─────';
  const JX_PLAY_TTL_MS_22 = 10 * 60 * 1000;
  const _jxPlayPending_22 = new Map();
  const _jxPlayLatestByChat_22 = new Map();
  const _jxPlaySweep_22 = () => {
    const now = Date.now();
    for (const [key, entry] of _jxPlayPending_22.entries()) {
      if (!entry || now - Number(entry.ts || 0) > JX_PLAY_TTL_MS_22) _jxPlayPending_22.delete(key);
    }
    for (const [chatKey, key] of _jxPlayLatestByChat_22.entries()) {
      if (!_jxPlayPending_22.has(key)) _jxPlayLatestByChat_22.delete(chatKey);
    }
  };

  // forward declarations — reassigned in .play try-block, used by .ytmate
  let playEnrich = async () => ({});
  let playYtId = () => '';
  let playThumb = async () => null;
  let playResolveAudioUrl = async () => null;
  let playResolveVideoUrl = async () => null;
  let playExtract = (p) => ({});
  let playSameChat = (a, b) => __normalizePlayJid(a) === __normalizePlayJid(b);
  let playNormChat = __normalizePlayJid;
  let playStore = () => {};
  let playFind = () => null;
  /* ── end hot-fix ─────────────────────────────────────────────────────────── */

  const hardBind = (names, meta, handler) => {
    try { cmd(names, meta, handler); } catch {}
    const list = Array.isArray(names) ? names : [names];
    if (ctx.commands && typeof ctx.commands.set === 'function') {
      for (const name of list) {
        const previous = ctx.commands.get(name) || {};
        ctx.commands.set(name, { ...previous, ...meta, handler });
      }
    }
  };
  const getPrevHandler = (...names) => {
    for (const name of names.flat()) {
      const h = ctx.commands?.get?.(name)?.handler;
      if (typeof h === 'function') return h;
    }
    return null;
  };
  const previousMovieHandler = getPrevHandler('movie');
  const previousMoviedlHandler = getPrevHandler('moviedl');
  const previousFacebookHandler = getPrevHandler('facebook', 'fb');
  const previousTeraboxHandler = getPrevHandler('terabox', 'tera', 'teradl');
  const previousApkHandler = getPrevHandler('apk');
  const previousAioHandler = getPrevHandler('aio', 'alldl', 'universaldl');


  /* ══════════════════════════════════════════════════════════════════════
     .nkiri — search → seasons → episodes → download-as-document
     ══════════════════════════════════════════════════════════════════════ */
  try {
    const nkiriSearch = async (sock, msg, args) => {
      const q = (args || []).join(' ').trim();
      if (!q) return sendReply(sock, msg, `🎬 *Nkiri Movies & Series*\n\nUsage: *${PREFIX}nkiri <title>*\nExample: *${PREFIX}nkiri avengers*`);
      await safeReact(sock, msg, '🎬');
      const statusMsg = await sock.sendMessage(msg.key.remoteJid, { text: `🎬 *Nkiri Search*\n\n⏳ Searching for *${q}* ...` }, { quoted: msg }).catch(() => null);
      const skey = statusMsg?.key;
      try {
        let results = [];
        for (let i = 0; i < 3 && !results.length; i++) {
          try {
            const d = await dcGet('/movies/search', { q, limit: 20 }, 30000);
            const arr = d?.results || d?.data?.results || d?.data || [];
            if (Array.isArray(arr) && arr.length) results = arr.slice(0, 20);
          } catch {}
        }
        if (!results.length) {
          if (skey) await ctx.editMessage?.(sock, msg.key.remoteJid, skey, `❌ No results for *${q}* (or the server is busy — try again).`).catch(() => {});
          else await sendReply(sock, msg, `❌ No results for *${q}*. Try again.`);
          return safeReact(sock, msg, '❌');
        }

        const chat = msg.key.remoteJid;
        _nkiriSetState(chat, {
          stage: 'results',
          query: q,
          results: results.map((r) => ({
            title: String(r.title || r.name || 'Unknown'),
            url: r.url || r.link || '',
            categories: Array.isArray(r.categories) ? r.categories.slice(0, 3) : [],
            date: r.date || '',
          })),
        });
        const rows = results.map((r, i) => ({
          title: `${i + 1}. ${String(r.title || r.name || 'Unknown').slice(0, 60)}`,
          description: (r.categories || []).slice(0, 3).join(' • ') || (r.date || ''),
          id: `${PREFIX}nkpick ${i + 1}`,
          rowId: `${PREFIX}nkpick ${i + 1}`,
        }));
        const body = `🎬 *Nkiri — "${q}"*\n\nFound *${results.length}* result${results.length > 1 ? 's' : ''}. Reply with a number:\n${results.slice(0, 10).map((r, i2) => `*${i2 + 1}.* ${String(r.title || r.name || 'Unknown')}`).join('\n')}`;
        if (skey) await sock.sendMessage(msg.key.remoteJid, { delete: skey }).catch(() => {});
        if (typeof ctx.sendNativeFlowListMenu === 'function') {
          await ctx.sendNativeFlowListMenu(sock, msg.key.remoteJid, msg, body, [{ title: 'Search Results', rows }], [{ text: '❌ Cancel', id: `${PREFIX}nkcancel` }]);
        } else {
          await sendReply(sock, msg, body + '\n\n' + rows.map(r => r.title).join('\n'));
        }
        return safeReact(sock, msg, '✅');
      } catch (e) {
        if (skey) await ctx.editMessage?.(sock, msg.key.remoteJid, skey, `❌ Search error: ${e.message}`).catch(() => {});
        return safeReact(sock, msg, '❌');
      }
    };

    const nkPick = async (sock, msg, args) => {
      const chat = msg.key.remoteJid;
      const token = (args || []).join(' ').trim();
      let url = token;
      let pickedTitle = '';
      if (/^\d+$/.test(token)) {
        const state = _nkiriGetState(chat);
        const idx = Number(token) - 1;
        const picked = state?.stage === 'results' ? state.results?.[idx] : null;
        if (!picked?.url) return sendReply(sock, msg, `❌ That picker expired. Run *${PREFIX}nkiri <title>* again.`);
        url = picked.url;
        pickedTitle = picked.title || '';
      }
      if (!url || !/^https?:\/\//i.test(url)) return sendReply(sock, msg, `❌ Invalid selection.`);
      await safeReact(sock, msg, '⏳');
      try {
        const d = await dcGet('/movies/info', { url }, 30000);
        const r = d?.result || d?.data || {};
        const links = Array.isArray(r.downloadLinks) ? r.downloadLinks : [];
        if (!links.length) return sendReply(sock, msg, `❌ No download links found for *${r.title || url}*.`);
        const bySeason = {};
        const movieLinks = [];
        for (const l of links) {
          const m = decodeURIComponent(l).match(/S(\d{1,2})E(\d{1,3})/i);
          if (m) {
            const s = parseInt(m[1], 10);
            (bySeason[s] = bySeason[s] || []).push({ ep: parseInt(m[2], 10), url: l });
          } else movieLinks.push(l);
        }
        const seasons = Object.keys(bySeason).map(Number).sort((a, b) => a - b);
        if (seasons.length) {
          const seasonRows = seasons.map((s) => ({ season: s, episodes: (bySeason[s] || []).slice().sort((a, b) => a.ep - b.ep) }));
          _nkiriSetState(chat, { stage: 'seasons', title: r.title || pickedTitle || 'Series', sourceUrl: url, seasons: seasonRows });
          const rows = seasons.map((s) => ({
            title: `📺 Season ${s}`,
            description: `${bySeason[s].length} episode${bySeason[s].length > 1 ? 's' : ''}`,
            id: `${PREFIX}nkseason ${s}`,
            rowId: `${PREFIX}nkseason ${s}`,
          }));
          const body = `🎬 *${r.title || pickedTitle || 'Series'}*\n\nThis is a TV series with *${seasons.length}* season${seasons.length > 1 ? 's' : ''}. Pick a season:`;
          if (typeof ctx.sendNativeFlowListMenu === 'function') {
            await ctx.sendNativeFlowListMenu(sock, msg.key.remoteJid, msg, body, [{ title: 'Seasons', rows }], [{ text: '❌ Cancel', id: `${PREFIX}nkcancel` }]);
          } else {
            await sendReply(sock, msg, body + '\n\n' + rows.map(x => x.title).join('\n'));
          }
          return safeReact(sock, msg, '✅');
        }
        _nkiriClearState(chat);
        return nkDeliver(sock, msg, movieLinks[0] || links[0], r.title || pickedTitle || 'Movie');
      } catch (e) {
        return sendReply(sock, msg, `❌ Error loading title: ${e.message}`);
      }
    };

    const nkSeason = async (sock, msg, args) => {
      const chat = msg.key.remoteJid;
      const payload = (args || []).join(' ').trim();
      let season = NaN;
      let title = 'Series';
      let eps = [];
      if (/^\d+$/.test(payload)) {
        const state = _nkiriGetState(chat);
        season = parseInt(payload, 10);
        const seasonEntry = state?.stage === 'seasons' ? (state.seasons || []).find((entry) => Number(entry.season) === season) : null;
        if (!seasonEntry) return sendReply(sock, msg, `❌ That season picker expired. Run *${PREFIX}nkiri <title>* again.`);
        title = state.title || title;
        eps = (seasonEntry.episodes || []).slice().sort((a, b) => a.ep - b.ep);
      } else {
        const [url, sStr] = payload.split('|');
        season = parseInt(sStr, 10);
        if (!url || isNaN(season)) return sendReply(sock, msg, `❌ Invalid season selection.`);
        await safeReact(sock, msg, '⏳');
        try {
          const d = await dcGet('/movies/info', { url }, 30000);
          const r = d?.result || d?.data || {};
          title = r.title || title;
          const links = Array.isArray(r.downloadLinks) ? r.downloadLinks : [];
          for (const l of links) {
            const m = decodeURIComponent(l).match(/S(\d{1,2})E(\d{1,3})/i);
            if (m && parseInt(m[1], 10) === season) eps.push({ ep: parseInt(m[2], 10), url: l });
          }
          eps.sort((a, b) => a.ep - b.ep);
        } catch (e) {
          return sendReply(sock, msg, `❌ Error loading season: ${e.message}`);
        }
      }
      if (isNaN(season)) return sendReply(sock, msg, `❌ Invalid season selection.`);
      await safeReact(sock, msg, '⏳');
      try {
        if (!eps.length) return sendReply(sock, msg, `❌ No episodes found for Season ${season}.`);
        _nkiriSetState(chat, { stage: 'episodes', title, season, episodes: eps });
        const rows = eps.map((e) => ({
          title: `🎞️ Episode ${e.ep}`,
          description: 'Tap to download',
          id: `${PREFIX}nkep ${e.ep}`,
          rowId: `${PREFIX}nkep ${e.ep}`,
        }));
        const body = `📺 *${title} — Season ${season}*\n\n*${eps.length}* episode${eps.length > 1 ? 's' : ''}. Pick an episode to download (sent as a document):`;
        if (typeof ctx.sendNativeFlowListMenu === 'function') {
          await ctx.sendNativeFlowListMenu(sock, msg.key.remoteJid, msg, body, [{ title: `Season ${season} Episodes`, rows }], [{ text: '❌ Cancel', id: `${PREFIX}nkcancel` }]);
        } else {
          await sendReply(sock, msg, body + '\n\n' + rows.map(x => x.title).join('\n'));
        }
        return safeReact(sock, msg, '✅');
      } catch (e) {
        return sendReply(sock, msg, `❌ Error loading season: ${e.message}`);
      }
    };

    const nkEp = async (sock, msg, args) => {
      const chat = msg.key.remoteJid;
      const token = (args || []).join(' ').trim();
      let dlPage = token;
      let titleHint = null;
      if (/^\d+$/.test(token)) {
        const state = _nkiriGetState(chat);
        const picked = state?.stage === 'episodes' ? (state.episodes || []).find((entry) => Number(entry.ep) === Number(token)) : null;
        if (!picked?.url) return sendReply(sock, msg, `❌ That episode picker expired. Run *${PREFIX}nkiri <title>* again.`);
        dlPage = picked.url;
        titleHint = state.title ? `${state.title} S${String(state.season || '').padStart(2, '0')}E${String(picked.ep).padStart(2, '0')}` : null;
      }
      if (!dlPage) return sendReply(sock, msg, `❌ Invalid episode selection.`);
      await safeReact(sock, msg, '⬇️');
      return nkDeliver(sock, msg, dlPage, titleHint);
    };

    async function nkDeliver(sock, msg, dlPageUrl, titleHint) {
      const chat = msg.key.remoteJid;
      const statusMsg = await sock.sendMessage(chat, { text: `⬇️ *Nkiri Download*\n\n⏳ Resolving direct link...` }, { quoted: msg }).catch(() => null);
      const skey = statusMsg?.key;
      try {
        const d = await dcGet('/nkiri/download', { url: dlPageUrl }, 45000);
        if (!d?.success || !d?.download_url) throw new Error(d?.error || d?.message || 'no download url');
        const directUrl = d.download_url;
        const ext = _extFromUrl(directUrl) || '.mkv';
        const filename = d.filename || `${_safeBaseName(titleHint || 'nkiri')}${ext}`;
        const size = d.size || '';
        const caption = `🎬 *${titleHint || filename.replace(/\.(mkv|mp4|avi|webm)$/i, '')}*${size ? `\n📦 Size: ${size}` : ''}\n\n_Sent as document_`;
        if (skey) await sock.sendMessage(chat, { delete: skey }).catch(() => {});
        await race(sock.sendMessage(chat, { document: { url: directUrl }, fileName: filename, mimetype: _mimeFromExt(ext), caption }, { quoted: msg }), 120000, 'document send');
        return safeReact(sock, msg, '✅');
      } catch (e) {
        if (skey) await ctx.editMessage?.(sock, chat, skey, `❌ Download failed: ${e.message}\n\n_The file may be too large or the link expired._`).catch(() => {});
        else await sendReply(sock, msg, `❌ Download failed: ${e.message}`);
        return safeReact(sock, msg, '❌');
      }
    }

    const nkCancel = async (sock, msg) => {
      _nkiriClearState(msg?.key?.remoteJid);
      return safeReact(sock, msg, '👍');
    };

    cmd(['nkiri', 'nkiri2', 'movie2'], { desc: 'Search & download Nkiri movies/series — .nkiri <title>', category: 'DOWNLOAD' }, nkiriSearch);
    cmd(['nkpick'], { desc: 'Internal: nkiri title pick', category: 'DOWNLOAD' }, nkPick);
    cmd(['nkseason'], { desc: 'Internal: nkiri season pick', category: 'DOWNLOAD' }, nkSeason);
    cmd(['nkep'], { desc: 'Internal: nkiri episode pick', category: 'DOWNLOAD' }, nkEp);
    cmd(['nkcancel'], { desc: 'Internal: nkiri cancel', category: 'DOWNLOAD' }, nkCancel);
    report.nkiri = true;
  } catch (e) { console.log('[precious-v21] nkiri error:', e && e.message); }

  /* ══════════════════════════════════════════════════════════════════════
     .movie — netnaija/native movie picker (separate from nkiri)
     ══════════════════════════════════════════════════════════════════════ */
  try {
    const MOVIE_API_BASE = String(process.env.MYNETNAIJA_API || CONFIG.MYNETNAIJA_API || '').replace(/\/+$/, '');
    const movieJson = async (suffix, params, timeout = 30000) => {
      if (!MOVIE_API_BASE) throw new Error('MYNETNAIJA_API is not configured');
      const res = await axios.get(MOVIE_API_BASE + suffix, {
        params,
        timeout,
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
        validateStatus: () => true,
      });
      const contentType = String(res.headers?.['content-type'] || '').toLowerCase();
      const data = res.data;
      if (/html/.test(contentType) || (typeof data === 'string' && /<!doctype|<html/i.test(data))) {
        throw new Error(`Netnaija API returned HTTP ${res.status}`);
      }
      return data;
    };
    const movieList = (data) => {
      const list = data?.results || data?.data?.results || data?.data || data?.movies || [];
      return Array.isArray(list) ? list.filter((item) => item && (item.url || item.link)) : [];
    };
    const movieInfo = (data) => {
      const d = data?.result || data?.data || data || {};
      const download = d?.download || {};
      const directCandidates = [download?.url, download?.download_url, download?.direct_url, d?.download_url, d?.file_url, d?.fileUrl, d?.downloadLink, d?.download_link];
      const fileUrl = directCandidates.find((u) => typeof u === 'string' && /^https?:\/\//i.test(u)) || null;
      return {
        title: d?.title || d?.name || 'Movie',
        fileUrl: typeof fileUrl === 'string' && /^https?:\/\//i.test(fileUrl) ? fileUrl : null,
        fileName: download?.file_name || d?.file_name || '',
        fileExt: String(download?.file_ext || d?.file_ext || '').toLowerCase(),
        fileSize: download?.file_size || d?.file_size || '',
        host: download?.host || d?.host || '',
        thumbnail: d?.thumbnail || d?.image || '',
        downloadLinks: [ ...(Array.isArray(d?.downloadLinks) ? d.downloadLinks : []), d?.downloadLink, d?.download_link ].filter((u) => typeof u === 'string' && /^https?:\/\//i.test(String(u || ''))),
      };
    };
    const movieSearch = async (sock, msg, args) => {
      const q = (args || []).join(' ').trim();
      if (!q) return sendReply(sock, msg, `🎬 *Movie Search*\n\nUsage: *${PREFIX}movie <title>*\nExample: *${PREFIX}movie extraction 3*`);
      await safeReact(sock, msg, '🎬');
      const chat = msg.key.remoteJid;
      const statusMsg = await sock.sendMessage(chat, { text: `🎬 *Movie Search*\n\n⏳ Searching for *${q}* ...` }, { quoted: msg }).catch(() => null);
      const skey = statusMsg?.key;
      try {
        let results = [];
        for (const params of [{ q }, { query: q }]) {
          try {
            const data = await movieJson('/search', params, 30000);
            const arr = movieList(data).slice(0, 20);
            if (arr.length) { results = arr; break; }
          } catch {}
        }
        if (!results.length) {
          if (skey) await ctx.editMessage?.(sock, chat, skey, `❌ No Netnaija results for *${q}*.`).catch(() => {});
          else await sendReply(sock, msg, `❌ No Netnaija results for *${q}*.`);
          return safeReact(sock, msg, '❌');
        }
        _setTimedState(_moviePickStore, chat, {
          stage: 'results',
          sender: msg?.key?.participant || msg?.key?.remoteJid || '',
          query: q,
          results: results.map((item) => ({
            title: String(item.title || item.name || 'Untitled movie'),
            url: item.url || item.link || '',
            year: item.year || item.date || '',
            rating: item.rating || item.score || '',
            thumbnail: item.thumbnail || '',
            downloadLinks: [ ...(Array.isArray(item.downloadLinks) ? item.downloadLinks : []), item.downloadLink, item.download_link, item.download ].filter((u) => typeof u === 'string' && /^https?:\/\//i.test(String(u || ''))),
          })),
        }, MOVIE_PICK_TTL_MS);
        const rows = results.map((item, index) => ({
          title: `${index + 1}. ${String(item.title || item.name || 'Untitled movie').slice(0, 60)}`,
          description: [item.year || item.date || '', item.rating ? `⭐ ${item.rating}` : ''].filter(Boolean).join(' • ') || 'Tap to open',
          id: `${PREFIX}movpick ${index + 1}`,
          rowId: `${PREFIX}movpick ${index + 1}`,
        }));
        const body = `🎬 *Movie Search — "${q}"*\n\nFound *${results.length}* result${results.length > 1 ? 's' : ''}. Tap *Open Categories* and choose your movie.`;
        if (skey) await sock.sendMessage(chat, { delete: skey }).catch(() => {});
        if (typeof ctx.sendNativeFlowListMenu === 'function') {
          await ctx.sendNativeFlowListMenu(sock, chat, msg, body, [{ title: 'Movie Results', rows }], [{ text: '❌ Cancel', id: `${PREFIX}movcancel` }]);
        } else {
          await sendReply(sock, msg, body + '\n\n' + rows.map((r) => r.title).join('\n'));
        }
        return safeReact(sock, msg, '✅');
      } catch (e) {
        if (skey) await ctx.editMessage?.(sock, chat, skey, `❌ Movie search failed: ${e.message}`).catch(() => {});
        else await sendReply(sock, msg, `❌ Movie search failed: ${e.message}`);
        return safeReact(sock, msg, '❌');
      }
    };
    const movPick = async (sock, msg, args) => {
      const chat = msg.key.remoteJid;
      const token = (args || []).join(' ').trim();
      let picked = null;
      if (/^\d+$/.test(token)) {
        const state = _getTimedState(_moviePickStore, chat, MOVIE_PICK_TTL_MS);
        const idx = Number(token) - 1;
        picked = state?.stage === 'results' ? state.results?.[idx] : null;
      } else if (/^https?:\/\//i.test(token)) {
        picked = { title: 'Movie', url: token };
      }
      if (!picked?.url) return sendReply(sock, msg, `❌ That movie picker expired. Run *${PREFIX}movie <title>* again.`);
      await safeReact(sock, msg, '⬇️');
      const statusMsg = await sock.sendMessage(chat, { text: `🎬 *Movie Download*\n\n⏳ Opening *${picked.title || 'movie'}* ...` }, { quoted: msg }).catch(() => null);
      const skey = statusMsg?.key;
      try {
        const data = await movieJson('/info', { url: picked.url }, 35000);
        let info = movieInfo(data);
        if (!info.fileUrl) {
          const firstDl = info.downloadLinks?.[0] || picked.downloadLinks?.[0] || '';
          if (/^https?:\/\//i.test(firstDl)) {
            try {
              const d = await dcGet('/nkiri/download', { url: firstDl }, 45000);
              if (d?.success === true && /^https?:\/\//i.test(String(d?.download_url || ''))) {
                const resolvedExt = path.extname(String(d?.filename || '')) || _extFromUrl(d.download_url) || '.mkv';
                info = {
                  ...info,
                  title: info.title || picked.title || 'Movie',
                  fileUrl: d.download_url,
                  fileName: info.fileName || d.filename || `${_safeBaseName(info.title || picked.title || 'movie')}${resolvedExt}`,
                  fileExt: info.fileExt || resolvedExt,
                  fileSize: info.fileSize || d.size || '',
                  host: info.host || 'downloadwella',
                };
              }
            } catch {}
          }
        }
        if (!info.fileUrl && typeof previousMoviedlHandler === 'function') return previousMoviedlHandler(sock, msg, [picked.title || picked.url]);
        if (!info.fileUrl) throw new Error('movie file url missing from current API response');
        const ext = info.fileExt ? (String(info.fileExt).startsWith('.') ? String(info.fileExt) : `.${info.fileExt}`) : (_extFromUrl(info.fileUrl) || '.mp4');
        const fileName = info.fileName || `${_safeBaseName(info.title || picked.title || 'movie')}${ext}`;
        const caption = `🎬 *${info.title || picked.title || 'Movie'}*${info.fileSize ? `\n📦 Size: ${info.fileSize}` : ''}${info.host ? `\n🌐 Host: ${info.host}` : ''}`;
        if (skey) await sock.sendMessage(chat, { delete: skey }).catch(() => {});
        await race(sock.sendMessage(chat, { document: { url: info.fileUrl }, fileName, mimetype: _mimeFromExt(ext), caption }, { quoted: msg }), 120000, 'movie document send');
        _clearTimedState(_moviePickStore, chat);
        return safeReact(sock, msg, '✅');
      } catch (e) {
        if (skey) await ctx.editMessage?.(sock, chat, skey, `❌ Movie download failed: ${e.message}`).catch(() => {});
        else await sendReply(sock, msg, `❌ Movie download failed: ${e.message}`);
        return safeReact(sock, msg, '❌');
      }
    };
    const movCancel = async (sock, msg) => {
      _clearTimedState(_moviePickStore, msg?.key?.remoteJid);
      return safeReact(sock, msg, '👍');
    };
    hardBind(['movie'], { desc: 'Search & download Netnaija movies — .movie <title>', category: 'DOWNLOAD' }, movieSearch);
    hardBind(['movpick'], { desc: 'Internal: movie title pick', category: 'DOWNLOAD' }, movPick);
    hardBind(['movcancel'], { desc: 'Internal: movie cancel', category: 'DOWNLOAD' }, movCancel);
    hardBind(['moviedl'], { desc: 'Use .movie native picker instead', category: 'DOWNLOAD' }, async (sock, msg) => {
      await sendReply(sock, msg, `🎬 Use *${PREFIX}movie <title>* and pick from the native movie list.\n\n_This movie flow now stays on the native picker — no ${PREFIX}moviedl step needed._`);
    });
    report.movie = true;
  } catch (e) { console.log('[precious-v21] movie error:', e && e.message); }

  /* ══════════════════════════════════════════════════════════════════════
     .play — native picker with verified local media delivery
     ══════════════════════════════════════════════════════════════════════ */
  try {
    const PLAY_HEADER = PLAY_HEADER_22;
    playNormChat = __normalizePlayJid;
    const playSender = (msg) => String(msg?.key?.participant || msg?.key?.remoteJid || '');
    playSameChat = (a, b) => __normalizePlayJid(a) === __normalizePlayJid(b);
    const playQuotedId = (msg) => {
      const c = _messageContextInfo(msg);
      return c?.stanzaId || c?.quotedMessage?.key?.id || null;
    };
    playYtId = (input) => {
      const raw = String(input || '').trim();
      if (!raw) return '';
      const m = raw.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|shorts\/|embed\/))([A-Za-z0-9_-]{6,})/i);
      if (m) return m[1];
      if (/^[A-Za-z0-9_-]{6,}$/.test(raw)) return raw;
      return '';
    };
    playExtract = (payload) => {
      const source = payload?.result || payload?.data || payload || {};
      const nested = source?.result || source?.data || source;
      const dlUrl = nested?.download_url || nested?.dl_url || nested?.url || nested?.audio || nested?.mp3 || nested?.link || null;
      const videoUrl = nested?.video_url || nested?.source || nested?.video || nested?.watch_url || nested?.youtube_url || null;
      return {
        title: nested?.title || nested?.song || nested?.name || null,
        artists: nested?.artist || nested?.artists || nested?.author || nested?.channel || null,
        duration: nested?.duration || nested?.length || nested?.timestamp || null,
        views: nested?.views || nested?.view_count || null,
        dlUrl: typeof dlUrl === 'string' && /^https?:\/\//i.test(dlUrl) ? dlUrl : null,
        videoUrl: typeof videoUrl === 'string' && /^https?:\/\//i.test(videoUrl) ? videoUrl : null,
        videoId: playYtId(videoUrl || nested?.videoId || nested?.id || ''),
        thumb: nested?.thumbnail || nested?.thumb || nested?.image || null,
      };
    };
    playStore = (keyId, jid, msg, meta) => {
      if (!keyId || !jid || !meta) return;
      _jxPlaySweep();
      const entry = { jid: playNormChat(jid), user: playSender(msg), meta: { ...meta }, ts: Date.now() };
      _jxPlayPending.set(String(keyId), entry);
      _jxPlayLatestByChat.set(playNormChat(jid), String(keyId));
      const timer = setTimeout(() => {
        const cur = _jxPlayPending.get(String(keyId));
        if (cur && cur.ts === entry.ts) _jxPlayPending.delete(String(keyId));
        const latest = _jxPlayLatestByChat.get(playNormChat(jid));
        if (latest === String(keyId)) _jxPlayLatestByChat.delete(playNormChat(jid));
      }, JX_PLAY_TTL_MS + 1000);
      timer?.unref?.();
    };
    playFind = (msg) => {
      _jxPlaySweep();
      const jid = msg?.key?.remoteJid || '';
      const user = playSender(msg);
      const quoted = playQuotedId(msg);
      if (quoted) {
        const entry = _jxPlayPending.get(String(quoted));
        if (entry && playSameChat(entry.jid, jid)) return entry;
      }
      try {
        const _qm = msg?.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        const _qStr = JSON.stringify(_qm || '');
        if (/player|reply here with a number|duration/i.test(_qStr)) {
          const latestKey = _jxPlayLatestByChat.get(playNormChat(jid));
          if (latestKey) {
            const entry = _jxPlayPending.get(String(latestKey));
            if (entry && playSameChat(entry.jid, jid)) return entry;
          }
        }
      } catch {}
      const latestKey = _jxPlayLatestByChat.get(playNormChat(jid));
      if (!latestKey) return null;
      const latest = _jxPlayPending.get(String(latestKey));
      if (!latest || !playSameChat(latest.jid, jid)) return null;
      return latest;
    };
    const playDur = (v) => typeof ctx._p2Dur === 'function' ? ctx._p2Dur(v) : String(v || '0:00');
    const playViews = (v) => typeof ctx._p2Views === 'function' ? ctx._p2Views(v) : String(v || '0');
    playThumb = async (meta) => {
      if (typeof ctx._p2ThumbBuf === 'function') {
        try {
          const b = await ctx._p2ThumbBuf(meta);
          if (Buffer.isBuffer(b) && b.length) return b;
        } catch {}
      }
      if (meta?.thumb) {
        try {
          const r = await axios.get(meta.thumb, { responseType: 'arraybuffer', timeout: 20000 });
          const b = Buffer.from(r.data || []);
          if (b.length) return b;
        } catch {}
      }
      return null;
    };
    playEnrich = async (meta, query) => {
      const out = { ...(meta || {}) };
      if (!out.videoUrl && out.videoId) out.videoUrl = `https://www.youtube.com/watch?v=${out.videoId}`;
      if (!out.videoId && out.videoUrl) out.videoId = playYtId(out.videoUrl);
      if ((!out.title || !out.artists || !out.views || !out.duration) && out.videoUrl) {
        try {
          const { data } = await axios.get(`https://www.youtube.com/oembed?url=${encodeURIComponent(out.videoUrl)}&format=json`, { timeout: 15000 });
          if (data?.title && !out.title) out.title = data.title;
          if (data?.author_name && !out.artists) out.artists = data.author_name;
          if (data?.thumbnail_url && !out.thumb) out.thumb = data.thumbnail_url;
        } catch {}
      }
      if ((!out.title || !out.artists || !out.videoUrl) && query) {
        try {
          const ytSearch = require('yt-search');
          const res = await ytSearch(query);
          const hit = Array.isArray(res?.videos) ? res.videos[0] : (Array.isArray(res) ? res[0] : null);
          if (hit) {
            if (!out.title && hit.title) out.title = hit.title;
            if (!out.artists && (hit.author?.name || hit.author)) out.artists = hit.author?.name || hit.author;
            if (!out.duration && (hit.timestamp || hit.duration?.timestamp)) out.duration = hit.timestamp || hit.duration?.timestamp;
            if (!out.views && hit.views) out.views = hit.views;
            if (!out.videoUrl && hit.url) out.videoUrl = hit.url;
            if (!out.videoId && hit.videoId) out.videoId = hit.videoId;
            if (!out.thumb && hit.thumbnail) out.thumb = hit.thumbnail;
          }
        } catch {}
      }
      if (!out.title) out.title = query || out.videoUrl || 'Unknown title';
      if (!out.artists) out.artists = 'Unknown';
      return out;
    };
    const playCardText = (meta) => [
      PLAY_HEADER,
      '',
      'TITLE     : ' + (meta.title || 'Unknown title'),
      'AUTHOR    : ' + (meta.artists || 'Unknown'),
      'DURATION  : ' + playDur(meta.duration),
      'VIEWS     : ' + playViews(meta.views),
      '',
      '────────────────────────',
      'Reply here with a number:',
      '  1 - Audio',
      '  2 - Document (.mp3)',
      '  3 - Voice note',
      '  4 - Video (.mp4)',
    ].join('\n');
    const playSections = () => [{
      title: 'Formats',
      rows: [
        { id: `${PREFIX}jxplaypick 1`, rowId: `${PREFIX}jxplaypick 1`, title: 'Audio', description: 'Send standard audio' },
        { id: `${PREFIX}jxplaypick 2`, rowId: `${PREFIX}jxplaypick 2`, title: 'Document (.mp3)', description: 'Send MP3 as document' },
        { id: `${PREFIX}jxplaypick 3`, rowId: `${PREFIX}jxplaypick 3`, title: 'Voice note', description: 'Send as push-to-talk' },
        { id: `${PREFIX}jxplaypick 4`, rowId: `${PREFIX}jxplaypick 4`, title: 'Video (.mp4)', description: 'Send MP4 video' },
      ],
    }];
    playResolveAudioUrl = async (meta) => {
      const tries = [];
      const ytUrl = meta?.videoUrl || (meta?.videoId ? `https://www.youtube.com/watch?v=${meta.videoId}` : '');
      if (/^https?:\/\//i.test(String(meta?.dlUrl || ''))) tries.push(async () => meta.dlUrl);
      if (ytUrl) tries.push(async () => playExtract(await dcGet('/download/ytmp3', { url: ytUrl }, 35000)).dlUrl || null);
      if (ytUrl) tries.push(async () => playExtract(await dcGet('/play', { query: ytUrl }, 35000)).dlUrl || null);
      // INDEPENDENT PROVIDERS — must NOT share the David Cyril host, so a
      // David Cyril / y2mate outage (HTTP 502) can no longer kill the chain.
      if (ytUrl) tries.push(async () => {
        try {
          const { data } = await axios.get(`https://api.siputzx.my.id/api/d/ytmp3?url=${encodeURIComponent(ytUrl)}`, { timeout: 45000, validateStatus: () => true });
          const r = data?.data || data?.result || data;
          const u = r?.download || r?.dl || r?.url;
          return /^https?:\/\//i.test(String(u || '')) ? u : null;
        } catch { return null; }
      });
      if (ytUrl) tries.push(async () => {
        try {
          const { data } = await axios.get(`https://api.nexoracle.com/downloader/ytmp3?apikey=free_key@maher_apis&url=${encodeURIComponent(ytUrl)}`, { timeout: 45000, validateStatus: () => true });
          const r = data?.result || data;
          const u = r?.dllink || r?.download_url || r?.url;
          return /^https?:\/\//i.test(String(u || '')) ? u : null;
        } catch { return null; }
      });
      if (CONFIG.GIFTED_API && CONFIG.GIFTED_KEY && ytUrl) tries.push(async () => {
        const { data } = await axios.get(`${CONFIG.GIFTED_API}/api/download/ytmp3?apikey=${CONFIG.GIFTED_KEY}&url=${encodeURIComponent(ytUrl)}`, { timeout: 60000 });
        return data?.result?.download_url || data?.result?.url || data?.result?.audio || data?.result?.mp3 || null;
      });
      // Nexray YouTube Downloader API
      if (ytUrl) tries.push(async () => {
        try {
          const { data } = await axios.get(`https://api.nexray.eu.cc/downloader/youtube?url=${encodeURIComponent(ytUrl)}`, { timeout: 30000 });
          const d = data?.result || data?.data || data;
          const u = d?.audio || d?.mp3 || d?.download_url || d?.url;
          return /^https?:\/\//i.test(String(u || '')) ? u : null;
        } catch { return null; }
      });
      // Prexzy YouTube Downloader API
      if (ytUrl) tries.push(async () => {
        try {
          const { data } = await axios.get(`https://apis.prexzyvilla.site/download/ytmp3?url=${encodeURIComponent(ytUrl)}`, { timeout: 30000 });
          const d = data?.result || data?.data || data;
          const u = d?.download_url || d?.url || d?.audio;
          return /^https?:\/\//i.test(String(u || '')) ? u : null;
        } catch { return null; }
      });
      // SaveTube audio fallback
      if (ytUrl) tries.push(async () => {
        try {
          if (typeof globalThis.__saveTubeResolve === 'function') {
            const res = await globalThis.__saveTubeResolve(ytUrl, 'audio', '128', 'mp3').catch(() => null);
            if (res?.downloadUrl) return res.downloadUrl;
          }
          const { data } = await axios.get(`https://api.savetube.me/download?url=${encodeURIComponent(ytUrl)}&format=mp3`, { timeout: 30000, validateStatus: () => true });
          const u = data?.data?.downloadUrl || data?.download || data?.url;
          return /^https?:\/\//i.test(String(u || '')) ? u : null;
        } catch { return null; }
      });
      for (const fn of tries) {
        try {
          const candidate = await fn();
          if (!candidate) continue;
          const ok = await _probeRemoteMedia(candidate, 'audio');
          if (ok?.url) return ok.url;
        } catch {}
      }
      return null;
    };
    playResolveVideoUrl = async (meta) => {
      const tries = [];
      const ytUrl = meta?.videoUrl || (meta?.videoId ? `https://www.youtube.com/watch?v=${meta.videoId}` : '');
      if (/^https?:\/\//i.test(String(meta?.videoDlUrl || meta?.videoUrlDirect || ''))) tries.push(async () => meta.videoDlUrl || meta.videoUrlDirect);
      if (ytUrl) tries.push(async () => playExtract(await dcGet('/download/ytmp4', { url: ytUrl }, 40000)).dlUrl || null);
      if (ytUrl) tries.push(async () => playExtract(await dcGet('/play', { query: ytUrl, type: 'video' }, 40000)).dlUrl || null);
      // INDEPENDENT PROVIDERS — must NOT share the David Cyril host, so a
      // David Cyril / y2mate outage (HTTP 502) can no longer kill the chain.
      if (ytUrl) tries.push(async () => {
        try {
          const { data } = await axios.get(`https://api.siputzx.my.id/api/d/ytmp4?url=${encodeURIComponent(ytUrl)}`, { timeout: 45000, validateStatus: () => true });
          const r = data?.data || data?.result || data;
          const u = r?.download || r?.dl || r?.url;
          return /^https?:\/\//i.test(String(u || '')) ? u : null;
        } catch { return null; }
      });
      if (ytUrl) tries.push(async () => {
        try {
          const { data } = await axios.get(`https://api.nexoracle.com/downloader/ytmp4?apikey=free_key@maher_apis&url=${encodeURIComponent(ytUrl)}`, { timeout: 45000, validateStatus: () => true });
          const r = data?.result || data;
          const u = r?.dllink || r?.download_url || r?.url;
          return /^https?:\/\//i.test(String(u || '')) ? u : null;
        } catch { return null; }
      });
      if (CONFIG.GIFTED_API && CONFIG.GIFTED_KEY && ytUrl) tries.push(async () => {
        const { data } = await axios.get(`${CONFIG.GIFTED_API}/api/download/ytmp4?apikey=${CONFIG.GIFTED_KEY}&url=${encodeURIComponent(ytUrl)}`, { timeout: 60000 });
        return data?.result?.download_url || data?.result?.url || data?.result?.video || data?.result?.mp4 || null;
      });
      for (const fn of tries) {
        try {
          const candidate = await fn();
          if (!candidate) continue;
          const ok = await _probeRemoteMedia(candidate, 'video');
          if (ok?.url) return ok.url;
        } catch {}
      }
      return null;
    };
    const playSearch = async (sock, msg, args) => {
      const jid = msg.key.remoteJid;
      const query = (args || []).join(' ').trim();
      if (!query) return sendReply(sock, msg, `${PLAY_HEADER}\n\nUsage: ${PREFIX}play <song name or link>`);
      await safeReact(sock, msg, '⏳');
      const status = await sock.sendMessage(jid, { text: `${PLAY_HEADER}\nSearching "${query}" ...` }, { quoted: msg }).catch(() => null);
      try {
        const isUrl = /^https?:\/\//i.test(query);
        let meta = null;
        if (isUrl) {
          try {
            meta = playExtract(await dcGet('/download/ytmp3', { url: query }, 30000));
            if (query && !meta.videoUrl) meta.videoUrl = query;
          } catch {}
        } else {
          try {
            meta = playExtract(await dcGet('/play', { query }, 30000));
          } catch {}
          if (!meta?.title && !meta?.videoUrl) {
            try {
              const ytSearch = require('yt-search');
              const res = await ytSearch(query);
              const hit = Array.isArray(res?.videos) ? res.videos[0] : (Array.isArray(res) ? res[0] : null);
              if (hit) meta = { title: hit.title || query, artists: hit.author?.name || hit.author || 'Unknown', duration: hit.timestamp || hit.duration?.timestamp || null, views: hit.views || null, videoUrl: hit.url || '', videoId: hit.videoId || playYtId(hit.url || ''), thumb: hit.thumbnail || null };
            } catch {}
          }
        }
        meta = await playEnrich(meta || {}, query);
        const card = playCardText(meta);
        const thumb = await playThumb(meta);
        if (status?.key) await sock.sendMessage(jid, { delete: status.key }).catch(() => {});
        let sent = null;
        if (typeof ctx.sendNativeFlowListMenu === 'function') {
          sent = await ctx.sendNativeFlowListMenu(sock, jid, msg, card, playSections(), [{ text: '❌ Cancel', id: `${PREFIX}jxplaycancel` }], `${CONFIG.BOT_NAME} • Player`, thumb ? { headerImage: thumb, headerText: 'PLAYER' } : {});
        }
        if (!sent?.key?.id) {
          sent = thumb ? await sock.sendMessage(jid, { image: thumb, caption: card }, { quoted: msg }).catch(() => null) : await sock.sendMessage(jid, { text: card }, { quoted: msg }).catch(() => null);
        }
        if (!sent?.key?.id) throw new Error('could not send player card');
        playStore(sent.key.id, jid, msg, meta);
        await safeReact(sock, msg, '✅');
      } catch (e) {
        if (status?.key) await ctx.editMessage?.(sock, jid, status.key, `❌ Play search failed: ${e.message}`).catch(() => {});
        else await sendReply(sock, msg, `❌ Play search failed: ${e.message}`);
        await safeReact(sock, msg, '❌');
      }
    };
    const playDeliver = async (sock, msg, mode) => {
      const entry = playFind(msg);
      if (!entry?.meta) return sendReply(sock, msg, `❌ That player card expired. Run *${PREFIX}play <song>* again.`);
      const meta = entry.meta;
      const jid = msg.key.remoteJid;
      const title = _safeBaseName(meta.title || 'audio');
      const status = await sock.sendMessage(jid, { text: `⬇️ ${PLAY_HEADER}\nPreparing *${title}* ...` }, { quoted: msg }).catch(() => null);
      const cleanup = new Set();
      try {
        if (mode === 4) {
          const videoUrl = await playResolveVideoUrl(meta);
          if (!videoUrl) throw new Error('no valid video file url');
          let fetched = await _fetchBinaryToTemp(videoUrl, { maxBytes: 180 * 1024 * 1024, timeout: 240000, prefix: 'jxvid-' });
          cleanup.add(fetched.dir);
          let info = _videoMetaFromHead(fetched.head, fetched.contentType, videoUrl);
          if (!info.ok) throw new Error('provider returned invalid video bytes');
          if (info.ext !== '.mp4') {
            const converted = await _transcodeVideoToMp4(fetched.filePath);
            cleanup.add(converted.dir);
            fetched = { ...fetched, filePath: converted.filePath };
            info = converted;
          }
          // WhatsApp-compatible video pass — guarantees H.264 + AAC audio and a
          // faststart moov atom. DASH-style YouTube MP4s fail WhatsApp's codec
          // rules: audio plays, video stays BLACK, or WhatsApp says
          // "This video file isn't available". Never send the raw stream.
          const ready = await _ensureWaVideo(fetched.filePath, { timeoutMs: 420000 });
          cleanup.add(ready.dir);
          await _sendFilePath(sock, jid, 'video', ready.filePath, { mimetype: 'video/mp4', fileName: `${title}.mp4` }, msg);
        } else {
          const audioUrl = await playResolveAudioUrl(meta);
          if (!audioUrl) throw new Error('no valid audio file url');
          let fetched = await _fetchBinaryToTemp(audioUrl, { maxBytes: 80 * 1024 * 1024, timeout: 240000, prefix: 'jxaud-' });
          cleanup.add(fetched.dir);
          let info = _audioMetaFromHead(fetched.head, fetched.contentType, audioUrl);
          if (!info.ok) throw new Error('provider returned invalid audio bytes');
          let sendPath = fetched.filePath;
          let sendMime = info.mimetype;
          let sendExt = info.ext || '.mp3';
          // Modes 1 (audio) and 2 (audio document) ALWAYS go through the mp3
          // transcoder. WhatsApp rejects raw m4a/webm as "audio"
          // attachments and m4a from DASH YouTube streams is the #1 cause
          // of "This file isn't available".
          if (mode === 1 || mode === 2) {
            const converted = await _transcodeAudioFile(fetched.filePath, 'mp3');
            cleanup.add(converted.dir);
            sendPath = converted.filePath;
            sendMime = converted.mimetype;
            sendExt = converted.ext;
          }
          if (mode === 3) {
            if (sendExt !== '.ogg') {
              const converted = await _transcodeAudioFile(sendPath, 'ogg');
              cleanup.add(converted.dir);
              sendPath = converted.filePath;
              sendMime = converted.mimetype;
              sendExt = converted.ext;
            }
            await _sendFilePath(sock, jid, 'audio', sendPath, { mimetype: 'audio/ogg; codecs=opus', ptt: true }, msg);
          } else if (mode === 2) {
            await _sendFilePath(sock, jid, 'document', sendPath, { mimetype: 'audio/mpeg', fileName: `${title}.mp3` }, msg);
          } else {
            await _sendFilePath(sock, jid, 'audio', sendPath, { mimetype: sendMime, ptt: false, fileName: `${title}${sendExt}` }, msg);
          }
        }
        if (status?.key) await sock.sendMessage(jid, { delete: status.key }).catch(() => {});
        await safeReact(sock, msg, '✅');
      } catch (e) {
        if (status?.key) await ctx.editMessage?.(sock, jid, status.key, `❌ Download failed: ${e.message}`).catch(() => {});
        else await sendReply(sock, msg, `❌ Download failed: ${e.message}`);
        await safeReact(sock, msg, '❌');
      } finally {
        for (const dir of cleanup) await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    };
    const playPick = async (sock, msg, args) => {
      const token = Number(String((args || []).join(' ').trim() || '0'));
      if (!Number.isInteger(token) || token < 1 || token > 4) return sendReply(sock, msg, `❌ Invalid player option. Use 1-4.`);
      return playDeliver(sock, msg, token);
    };
    const playCancel = async (sock, msg) => {
      const jid = playNormChat(msg?.key?.remoteJid || '');
      const latestKey = _jxPlayLatestByChat.get(jid);
      if (latestKey) _jxPlayPending.delete(latestKey);
      _jxPlayLatestByChat.delete(jid);
      return safeReact(sock, msg, '👍');
    };
    // hardBind(['play', 'music', 'song']) removed: main ads player (__rdlPlayCard) in mias/index.js is authoritative
    hardBind(['jxplaypick'], { desc: 'Internal: player format pick', category: 'DOWNLOAD' }, playPick);
    hardBind(['jxplaycancel'], { desc: 'Internal: player cancel', category: 'DOWNLOAD' }, playCancel);
    report.play = true;
  } catch (e) { console.log('[precious-v21] play error:', e && e.message); }


  /* ══════════════════════════════════════════════════════════════════════
     .ytmate — image card + native format → bitrate picker
     ══════════════════════════════════════════════════════════════════════ */
  try {
    const ytmateCardText = (entry) => [
      '🎵 *YTMate*',
      '',
      'TITLE     : ' + (entry.title || 'Unknown title'),
      'AUTHOR    : ' + (entry.author || 'Unknown'),
      'SOURCE    : YouTube',
      '',
      'Choose a format from the menu.',
    ].join('\n');
    const ytmateRows = [
      { id: `${PREFIX}ytmatepick mp4`, rowId: `${PREFIX}ytmatepick mp4`, title: 'MP4 Video', description: 'Send as video' },
      { id: `${PREFIX}ytmatepick mp3`, rowId: `${PREFIX}ytmatepick mp3`, title: 'MP3 Audio', description: 'Send as audio' },
      { id: `${PREFIX}ytmatepick mp4doc`, rowId: `${PREFIX}ytmatepick mp4doc`, title: 'MP4 Document', description: 'Send MP4 as document' },
      { id: `${PREFIX}ytmatepick mp3doc`, rowId: `${PREFIX}ytmatepick mp3doc`, title: 'MP3 Document', description: 'Send MP3 as document' },
    ];
    const ytmateStart = async (sock, msg, args) => {
      const raw = (args || []).join(' ').trim();
      if (!raw) return sendReply(sock, msg, `🎵 *YTMate*\n\nUsage: *${PREFIX}ytmate <youtube url or song name>*`);
      await safeReact(sock, msg, '🎵');
      const chat = msg.key.remoteJid;
      const statusMsg = await sock.sendMessage(chat, { text: `🎵 *YTMate*\n\n⏳ Resolving *${raw}* ...` }, { quoted: msg }).catch(() => null);
      const skey = statusMsg?.key;
      try {
        const base = await playEnrich({}, raw);
        const ytUrl = /^https?:\/\/(?:www\.)?(?:youtube\.com|youtu\.be)\//i.test(raw) ? raw : base.videoUrl;
        if (!ytUrl) throw new Error('could not resolve a YouTube video from your input');
        // YTMate's upstream (y2mate) 502s often — never block the picker on it.
        let entry = null;
        try {
          const res = await axios.get(`${DC}/download/y2mate`, {
            params: { url: ytUrl },
            timeout: 45000,
            headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json,text/plain,*/*' },
            validateStatus: () => true,
          });
          const data = res.data;
          const result = data?.result || {};
          const contentType = String(res.headers?.['content-type'] || '').toLowerCase();
          const isHtml = /html/.test(contentType) || (typeof data === 'string' && /<!doctype|<html/i.test(data));
          if (!isHtml && (data?.success === true) && result?.title) {
            entry = {
              stage: 'format',
              sender: msg?.key?.participant || msg?.key?.remoteJid || '',
              ytUrl,
              videoId: result.id || base.videoId || playYtId(ytUrl),
              title: result.title || base.title || raw,
              author: result.author || base.artists || 'Unknown',
              thumbnail: result.thumbnail || base.thumb || '',
              source: result.source || ytUrl,
            };
          }
        } catch {}
        if (!entry) {
          if (!base.videoUrl && !base.videoId) throw new Error('YTMate is temporarily down (HTTP 502) and no video could be resolved — try again in a few minutes.');
          entry = {
            stage: 'format',
            sender: msg?.key?.participant || msg?.key?.remoteJid || '',
            ytUrl: base.videoUrl || ytUrl,
            videoId: base.videoId || playYtId(ytUrl),
            title: base.title || raw,
            author: base.artists || 'Unknown',
            thumbnail: base.thumb || '',
            source: ytUrl,
          };
        }
        _setTimedState(_ytmateStore, chat, entry, YTMATE_TTL_MS);
        if (skey) await sock.sendMessage(chat, { delete: skey }).catch(() => {});
        const card = ytmateCardText(entry);
        const thumb = await _thumbBufferFromUrl(entry.thumbnail);
        if (thumb) await sock.sendMessage(chat, { image: thumb, caption: card }, { quoted: msg }).catch(() => sendReply(sock, msg, card));
        else await sendReply(sock, msg, card);
        if (typeof ctx.sendNativeFlowListMenu === 'function') {
          await ctx.sendNativeFlowListMenu(sock, chat, msg, 'Choose the output format.', [{ title: 'YTMate Formats', rows: ytmateRows }], [{ text: '❌ Cancel', id: `${PREFIX}ytmatecancel` }]);
        } else {
          await sendReply(sock, msg, 'Choose the output format.\n\nMP4 Video\nMP3 Audio\nMP4 Document\nMP3 Document');
        }
        return safeReact(sock, msg, '✅');
      } catch (e) {
        if (skey) await ctx.editMessage?.(sock, chat, skey, `❌ YTMate failed: ${e.message}`).catch(() => {});
        else await sendReply(sock, msg, `❌ YTMate failed: ${e.message}`);
        return safeReact(sock, msg, '❌');
      }
    };
    const ytmatePick = async (sock, msg, args) => {
      const chat = msg.key.remoteJid;
      const state = _getTimedState(_ytmateStore, chat, YTMATE_TTL_MS);
      const mode = String((args || []).join(' ').trim() || '').toLowerCase();
      if (!state || state.stage !== 'format') return sendReply(sock, msg, `❌ That YTMate picker expired. Run *${PREFIX}ytmate <youtube url>* again.`);
      if (!['mp4', 'mp3', 'mp4doc', 'mp3doc'].includes(mode)) return sendReply(sock, msg, '❌ Invalid YTMate format.');
      const quality = mode.startsWith('mp4') ? '720p' : '128kbps';
      _setTimedState(_ytmateStore, chat, { ...state, stage: 'quality', mode, quality }, YTMATE_TTL_MS);
      const rows = [{ id: `${PREFIX}ytmatequality ${quality}`, rowId: `${PREFIX}ytmatequality ${quality}`, title: quality, description: mode.startsWith('mp4') ? 'Available video quality from current API' : 'Available audio bitrate from current API' }];
      if (typeof ctx.sendNativeFlowListMenu === 'function') {
        await ctx.sendNativeFlowListMenu(sock, chat, msg, `Choose the available ${mode.startsWith('mp4') ? 'video quality' : 'audio bitrate'}.`, [{ title: mode.startsWith('mp4') ? 'Video Quality' : 'Audio Bitrate', rows }], [{ text: '❌ Cancel', id: `${PREFIX}ytmatecancel` }]);
      } else {
        await sendReply(sock, msg, `Available ${mode.startsWith('mp4') ? 'video quality' : 'audio bitrate'}: ${quality}`);
      }
      return safeReact(sock, msg, '✅');
    };
    const ytmateQuality = async (sock, msg, args) => {
      const chat = msg.key.remoteJid;
      const state = _getTimedState(_ytmateStore, chat, YTMATE_TTL_MS);
      const pickedQuality = String((args || []).join(' ').trim() || '');
      if (!state || state.stage !== 'quality') return sendReply(sock, msg, `❌ That YTMate picker expired. Run *${PREFIX}ytmate <youtube url>* again.`);
      const mode = state.mode;
      const quality = pickedQuality || state.quality;
      const format = mode.startsWith('mp4') ? 'mp4' : 'mp3';
      const title = _safeBaseName(state.title || 'youtube');
      const meta = { videoUrl: state.ytUrl, videoId: state.videoId, title: state.title, artists: state.author, thumb: state.thumbnail };
      const status = await sock.sendMessage(chat, { text: `⬇️ *YTMate*\n\nPreparing *${title}* (${quality}) ...` }, { quoted: msg }).catch(() => null);
      const cleanup = new Set();
      try {
        // YTMate 502 fallback: try the y2mate provider, then the independent
        // resolvers (siputzx / nexoracle / gifted) inside playResolve*Url, so
        // a David Cyril outage no longer kills the whole chain.
        let finalUrl = '';
        let y2mateFailed = false;
        try {
          const res = await axios.get(`${DC}/download/y2mate`, {
            params: { url: state.ytUrl, format, quality },
            timeout: 45000,
            headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json,text/plain,*/*' },
            validateStatus: () => true,
          });
          if (res.status >= 500) y2mateFailed = true;
          const data = res.data;
          const result = data?.result || {};
          const contentType = String(res.headers?.['content-type'] || '').toLowerCase();
          const isHtml = /html/.test(contentType) || (typeof data === 'string' && /<!doctype|<html/i.test(data));
          if (!isHtml && (data?.success === true) && /^https?:\/\//i.test(String(result?.download || ''))) {
            const ok = await _probeRemoteMedia(result.download, format === 'mp4' ? 'video' : 'audio');
            if (ok?.url) finalUrl = ok.url;
          }
        } catch { y2mateFailed = true; }
        if (y2mateFailed) console.log('[precious-v21] YTMate upstream 502/down — switching to independent fallback providers');
        if (!finalUrl) finalUrl = format === 'mp4' ? await playResolveVideoUrl(meta) : await playResolveAudioUrl(meta);
        if (!finalUrl) throw new Error('YTMate is down (HTTP 502) and no fallback stream could be found — try again in a few minutes.');
        if (format === 'mp4') {
          let fetched = await _fetchBinaryToTemp(finalUrl, { maxBytes: 180 * 1024 * 1024, timeout: 240000, prefix: 'ytmatev-' });
          cleanup.add(fetched.dir);
          let info = _videoMetaFromHead(fetched.head, fetched.contentType, finalUrl);
          if (!info.ok) throw new Error('provider returned invalid video bytes');
          if (info.ext !== '.mp4') {
            const converted = await _transcodeVideoToMp4(fetched.filePath);
            cleanup.add(converted.dir);
            fetched = { ...fetched, filePath: converted.filePath };
          }
          if (mode === 'mp4doc') {
            await _sendFilePath(sock, chat, 'document', fetched.filePath, { mimetype: 'video/mp4', fileName: `${title}.mp4` }, msg);
          } else {
            // Same WhatsApp-playable pass as .play — fixes black video and
            // "this video file isn't available" on YTMate MP4s.
            const ready = await _ensureWaVideo(fetched.filePath, { timeoutMs: 420000 });
            cleanup.add(ready.dir);
            await _sendFilePath(sock, chat, 'video', ready.filePath, { mimetype: 'video/mp4', fileName: `${title}.mp4`, caption: `🎬 *${state.title}*` }, msg);
          }
        } else {
          let fetched = await _fetchBinaryToTemp(finalUrl, { maxBytes: 80 * 1024 * 1024, timeout: 240000, prefix: 'ytmatea-' });
          cleanup.add(fetched.dir);
          let sendPath = fetched.filePath;
          let info = _audioMetaFromHead(fetched.head, fetched.contentType, finalUrl);
          if (!info.ok) throw new Error('provider returned invalid audio bytes');
          if (info.ext !== '.mp3') {
            const converted = await _transcodeAudioFile(fetched.filePath, 'mp3');
            cleanup.add(converted.dir);
            sendPath = converted.filePath;
          }
          if (mode === 'mp3doc') await _sendFilePath(sock, chat, 'document', sendPath, { mimetype: 'audio/mpeg', fileName: `${title}.mp3` }, msg);
          else await _sendFilePath(sock, chat, 'audio', sendPath, { mimetype: 'audio/mpeg', ptt: false, fileName: `${title}.mp3` }, msg);
        }
        _clearTimedState(_ytmateStore, chat);
        if (status?.key) await sock.sendMessage(chat, { delete: status.key }).catch(() => {});
        return safeReact(sock, msg, '✅');
      } catch (e) {
        if (status?.key) await ctx.editMessage?.(sock, chat, status.key, `❌ YTMate download failed: ${e.message}`).catch(() => {});
        else await sendReply(sock, msg, `❌ YTMate download failed: ${e.message}`);
        return safeReact(sock, msg, '❌');
      } finally {
        for (const dir of cleanup) await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    };
    const ytmateCancel = async (sock, msg) => {
      _clearTimedState(_ytmateStore, msg?.key?.remoteJid);
      return safeReact(sock, msg, '👍');
    };
    hardBind(['ytmate'], { desc: 'YouTube via YTMate — image card + format/bitrate picker', category: 'DOWNLOAD' }, ytmateStart);
    hardBind(['ytmatepick'], { desc: 'Internal: YTMate format pick', category: 'DOWNLOAD' }, ytmatePick);
    hardBind(['ytmatequality'], { desc: 'Internal: YTMate quality pick', category: 'DOWNLOAD' }, ytmateQuality);
    hardBind(['ytmatecancel'], { desc: 'Internal: YTMate cancel', category: 'DOWNLOAD' }, ytmateCancel);
  } catch (e) { console.log('[precious-v21] ytmate error:', e && e.message); }

  /* ══════════════════════════════════════════════════════════════════════
     facebook / terabox / apk / aio — David Cyril primary chains
     ══════════════════════════════════════════════════════════════════════ */
  try {
    const dcJson = async (url, params, timeout = 45000) => {
      const res = await axios.get(url, {
        params,
        timeout,
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json,text/plain,*/*' },
        validateStatus: () => true,
      });
      const data = res.data;
      const contentType = String(res.headers?.['content-type'] || '').toLowerCase();
      if (/html/.test(contentType) || (typeof data === 'string' && /david cyril api docs|<!doctype|<html/i.test(data))) throw new Error(`provider returned HTTP ${res.status}`);
      return data;
    };
    const sendByFetched = async (sock, msg, fetchedPack, fallbackName, caption = '') => {
      const { fetched, meta } = fetchedPack;
      try {
        if (meta.kind === 'video') return await _sendFilePath(sock, msg.key.remoteJid, 'video', fetched.filePath, { mimetype: 'video/mp4', fileName: fallbackName || `video${meta.ext || '.mp4'}`, caption }, msg);
        if (meta.kind === 'audio') return await _sendFilePath(sock, msg.key.remoteJid, 'audio', fetched.filePath, { mimetype: meta.mimetype || 'audio/mpeg', ptt: false, fileName: fallbackName || `audio${meta.ext || '.mp3'}` }, msg);
        if (meta.kind === 'image') return await _sendFilePath(sock, msg.key.remoteJid, 'image', fetched.filePath, { mimetype: meta.mimetype || 'image/jpeg', caption }, msg);
        return await _sendFilePath(sock, msg.key.remoteJid, 'document', fetched.filePath, { mimetype: meta.mimetype || 'application/octet-stream', fileName: fallbackName || `file${meta.ext || '.bin'}`, caption }, msg);
      } finally {
        await fs.promises.rm(fetched.dir, { recursive: true, force: true }).catch(() => {});
      }
    };
    const facebookHandler = async (sock, msg, args) => {
      const url = String((args || [])[0] || '').trim();
      if (!/^https?:\/\//i.test(url)) return sendReply(sock, msg, `📘 *Facebook*\n\nUsage: *${PREFIX}facebook <facebook url>*`);
      await safeReact(sock, msg, '📘');
      try {
        const data = await dcJson(`${DC}/facebook`, { url }, 45000);
        if (!(data?.success === true)) throw new Error(data?.message || 'facebook api failed');
        const pickedUrl = data?.result?.downloads?.hd?.url || data?.result?.downloads?.sd?.url || '';
        if (!/^https?:\/\//i.test(String(pickedUrl || ''))) throw new Error('facebook api returned no media url');
        const fetched = await _downloadFirstWorkingMedia([pickedUrl], { kind: 'video', maxBytes: 180 * 1024 * 1024, prefix: 'fbdc-' });
        await sendByFetched(sock, msg, fetched, `${_safeBaseName(data?.result?.title || 'facebook')}.mp4`, `📘 *${data?.result?.title || 'Facebook Video'}*`);
        return safeReact(sock, msg, '✅');
      } catch (e) {
        if (typeof previousFacebookHandler === 'function') return previousFacebookHandler(sock, msg, args);
        await sendReply(sock, msg, `❌ Facebook failed: ${e.message}`);
        return safeReact(sock, msg, '❌');
      }
    };
    const teraboxHandler = async (sock, msg, args) => {
      const url = String((args || [])[0] || '').trim();
      if (!/^https?:\/\//i.test(url)) return sendReply(sock, msg, `📦 *Terabox*\n\nUsage: *${PREFIX}terabox <terabox url>*`);
      await safeReact(sock, msg, '📦');
      try {
        const data = await dcJson(`${DC}/download/terabox`, { url }, 50000);
        if (data?.success === false && data?.message) throw new Error(data.message);
        const candidates = _collectHttpUrls(data).filter((u) => u != url);
        const fetched = await _downloadFirstWorkingMedia(candidates, { kind: 'any', maxBytes: 350 * 1024 * 1024, prefix: 'teradc-' });
        await sendByFetched(sock, msg, fetched, `${_safeBaseName('terabox_file')}${fetched.meta.ext || '.bin'}`, '📦 *Terabox Download*');
        return safeReact(sock, msg, '✅');
      } catch (e) {
        if (typeof previousTeraboxHandler === 'function') return previousTeraboxHandler(sock, msg, args);
        await sendReply(sock, msg, `❌ Terabox failed: ${e.message}`);
        return safeReact(sock, msg, '❌');
      }
    };
    const apkHandler = async (sock, msg, args) => {
      const query = (args || []).join(' ').trim();
      if (!query) return sendReply(sock, msg, `📱 *APK*\n\nUsage: *${PREFIX}apk <app name>*`);
      await safeReact(sock, msg, '📱');
      try {
        const primary = await dcJson(`${DC}/download/apk`, { text: query }, 45000);
        if (primary?.status === true && /^https?:\/\//i.test(String(primary?.apk?.downloadLink || ''))) {
          const fetched = await _downloadFirstWorkingMedia([primary.apk.downloadLink], { kind: 'document', maxBytes: 300 * 1024 * 1024, prefix: 'apkdc-' });
          const icon = await _thumbBufferFromUrl(primary?.apk?.icon);
          const caption = `📱 *${primary?.apk?.name || query}*${primary?.apk?.package ? `\n📦 Package: ${primary.apk.package}` : ''}${primary?.apk?.lastUpdated ? `\n🆕 Version: ${primary.apk.lastUpdated}` : ''}`;
          if (icon) await sock.sendMessage(msg.key.remoteJid, { image: icon, caption }, { quoted: msg }).catch(() => {});
          await sendByFetched(sock, msg, fetched, `${_safeBaseName(primary?.apk?.name || query)}.apk`, caption);
          return safeReact(sock, msg, '✅');
        }
        const secondary = await dcJson(`${DC}/download/android1`, { q: query }, 45000);
        if (secondary?.success === true && Array.isArray(secondary?.data) && secondary.data.length && typeof previousApkHandler === 'function') return previousApkHandler(sock, msg, [secondary.data[0]?.name || query]);
        throw new Error(primary?.error || primary?.message || secondary?.message || 'no working apk download was returned');
      } catch (e) {
        if (typeof previousApkHandler === 'function') return previousApkHandler(sock, msg, args);
        await sendReply(sock, msg, `❌ APK failed: ${e.message}`);
        return safeReact(sock, msg, '❌');
      }
    };
    const aioHandler = async (sock, msg, args) => {
      const url = String((args || [])[0] || '').trim();
      if (!/^https?:\/\//i.test(url)) return sendReply(sock, msg, `📥 *AIO Downloader*\n\nUsage: *${PREFIX}aio <social url>*`);
      await safeReact(sock, msg, '📥');
      const endpoints = [`${DC}/download/aio`, `${DC}/download/aiov2`, `${DC}/download/aiov3`];
      let lastErr = null;
      for (const endpoint of endpoints) {
        try {
          const data = await dcJson(endpoint, { url }, 50000);
          const candidates = _collectHttpUrls(data).filter((u) => u != url && !/ytimg|googleusercontent|\.jpg(?:$|[?#])|\.jpeg(?:$|[?#])|\.png(?:$|[?#])|\.webp(?:$|[?#])/i.test(String(u || '')));
          const fetched = await _downloadFirstWorkingMedia(candidates, { kind: 'any', maxBytes: 180 * 1024 * 1024, prefix: 'aiodc-' });
          await sendByFetched(sock, msg, fetched, `${_safeBaseName('aio_download')}${fetched.meta.ext || '.bin'}`, '📥 *AIO Download*');
          return safeReact(sock, msg, '✅');
        } catch (e) {
          lastErr = e;
        }
      }
      if (typeof previousAioHandler === 'function') return previousAioHandler(sock, msg, args);
      await sendReply(sock, msg, `❌ AIO failed: ${(lastErr && lastErr.message) || 'no downloadable media found'}`);
      return safeReact(sock, msg, '❌');
    };
    hardBind(['facebook', 'fb'], { desc: 'Download best-quality Facebook media', category: 'DOWNLOAD' }, facebookHandler);
    hardBind(['terabox', 'tera', 'teradl'], { desc: 'Download Terabox media', category: 'DOWNLOAD' }, teraboxHandler);
    hardBind(['apk'], { desc: 'Download APK with David Cyril primary/secondary/legacy fallback', category: 'DOWNLOAD' }, apkHandler);
    hardBind(['aio', 'alldl', 'universaldl'], { desc: 'Universal downloader via David Cyril v1/v2/v3 then legacy fallback', category: 'DOWNLOAD' }, aioHandler);
  } catch (e) { console.log('[precious-v21] social downloaders error:', e && e.message); }

  /* ══════════════════════════════════════════════════════════════════════
     .8upload — exact endpoint probe with honest provider errors
     ══════════════════════════════════════════════════════════════════════ */
  try {
    const upload8 = async (sock, msg, args) => {
      const url = (args || []).join(' ').trim();
      if (!/^https?:\/\//i.test(url)) return sendReply(sock, msg, `📤 *8Upload*\n\nUsage: *${PREFIX}8upload <direct file url>*`);
      await safeReact(sock, msg, '📤');
      const chat = msg.key.remoteJid;
      const statusMsg = await sock.sendMessage(chat, { text: `📤 *8Upload*\n\n⏳ Sending your file link to the provider...` }, { quoted: msg }).catch(() => null);
      const skey = statusMsg?.key;
      try {
        const res = await axios.get(`${DC}/8upload`, {
          params: { url },
          timeout: 45000,
          headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json,text/html;q=0.9,*/*;q=0.8' },
          validateStatus: () => true,
        });
        const data = res.data;
        const contentType = String(res.headers?.['content-type'] || '').toLowerCase();
        if (/html/.test(contentType) || (typeof data === 'string' && /david cyril api docs|<!doctype|<html/i.test(data))) {
          throw new Error('the 8upload endpoint currently returns a 404/blocked docs page');
        }
        const result = data?.result || data?.data || data || {};
        if (!(data?.success === true || data?.status === true)) {
          throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
        }
        const outUrl = result?.url || result?.download_url || result?.file || result?.link || '';
        const lines = [
          '✅ *8Upload*',
          outUrl ? `🔗 ${outUrl}` : null,
          result?.id ? `🆔 ${result.id}` : null,
          result?.message ? String(result.message) : null,
        ].filter(Boolean).join('\n');
        if (skey) await sock.sendMessage(chat, { delete: skey }).catch(() => {});
        await sendReply(sock, msg, lines || '✅ 8Upload finished.');
        return safeReact(sock, msg, '✅');
      } catch (e) {
        if (skey) await ctx.editMessage?.(sock, chat, skey, `❌ 8Upload failed: ${e.message}`).catch(() => {});
        else await sendReply(sock, msg, `❌ 8Upload failed: ${e.message}`);
        return safeReact(sock, msg, '❌');
      }
    };
    cmd(['8upload'], { desc: 'Upload a direct file URL through the 8upload endpoint', category: 'TOOLS' }, upload8);
    report.upload8 = true;
  } catch (e) { console.log('[precious-v21] 8upload error:', e && e.message); }

  /* ══════════════════════════════════════════════════════════════════════
     .boost6 — native flow: choose type, then reply with a count
     ══════════════════════════════════════════════════════════════════════ */
  try {
    const boost6Start = async (sock, msg, args) => {
      const url = (args || []).join(' ').trim();
      if (!/^https?:\/\//i.test(url) || !/tiktok\.com|vm\.tiktok\.com|vt\.tiktok\.com/i.test(url)) {
        return sendReply(sock, msg, `⚡ *Boost6*\n\nUsage: *${PREFIX}boost6 <TikTok video/profile link>*`);
      }
      const chat = msg.key.remoteJid;
      _setTimedState(_boost6Store, chat, { stage: 'kind', sender: msg?.key?.participant || msg?.key?.remoteJid || '', url }, BOOST6_TTL_MS);
      const rows = [
        { id: `${PREFIX}boost6pick likes`, rowId: `${PREFIX}boost6pick likes`, title: '👍 Likes', description: 'Increase likes' },
        { id: `${PREFIX}boost6pick followers`, rowId: `${PREFIX}boost6pick followers`, title: '👥 Followers', description: 'Increase followers' },
        { id: `${PREFIX}boost6pick views`, rowId: `${PREFIX}boost6pick views`, title: '👀 Views', description: 'Increase views' },
      ];
      const body = `⚡ *Boost6*\n\nTarget: ${url}\n\nPick what you want to boost.`;
      if (typeof ctx.sendNativeFlowListMenu === 'function') {
        await ctx.sendNativeFlowListMenu(sock, chat, msg, body, [{ title: 'Boost Type', rows }], [{ text: '❌ Cancel', id: `${PREFIX}boost6cancel` }]);
      } else {
        await sendReply(sock, msg, body + '\n\n1. Likes\n2. Followers\n3. Views');
      }
      return safeReact(sock, msg, '✅');
    };
    const boost6Pick = async (sock, msg, args) => {
      const chat = msg.key.remoteJid;
      const state = _getTimedState(_boost6Store, chat, BOOST6_TTL_MS);
      const kind = String((args || []).join(' ').trim() || '').toLowerCase();
      if (!state || state.stage !== 'kind' || !['likes', 'followers', 'views'].includes(kind)) {
        return sendReply(sock, msg, `❌ That Boost6 picker expired. Run *${PREFIX}boost6 <link>* again.`);
      }
      _setTimedState(_boost6Store, chat, { stage: 'count', sender: state.sender, url: state.url, kind }, BOOST6_TTL_MS);
      await sendReply(sock, msg, `⚡ *Boost6*\n\nReply with the *${_boostLabel(kind)}* count you want for:\n${state.url}`);
      return safeReact(sock, msg, '✅');
    };
    const boost6Submit = async (sock, msg, countValue) => {
      const chat = msg.key.remoteJid;
      const state = _getTimedState(_boost6Store, chat, BOOST6_TTL_MS);
      if (!state || state.stage !== 'count') return false;
      const count = Number(countValue);
      if (!Number.isFinite(count) || count <= 0) {
        await sendReply(sock, msg, '❌ Send a valid numeric count.');
        return true;
      }
      await safeReact(sock, msg, '⚡');
      const statusMsg = await sock.sendMessage(chat, { text: `⚡ *Boost6*\n\n⏳ Sending ${count} ${_boostLabel(state.kind).toLowerCase()} request...` }, { quoted: msg }).catch(() => null);
      const skey = statusMsg?.key;
      try {
        const attempts = [
          { url: state.url, type: state.kind, count },
          { url: state.url, type: state.kind, amount: count },
          { url: state.url, action: state.kind, count },
          { url: state.url, service: state.kind, amount: count },
        ];
        let finalData = null;
        let finalMessage = '';
        for (const params of attempts) {
          const res = await axios.get(`${DC}/api/tiktok/boost6`, {
            params,
            timeout: 45000,
            headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json,text/html;q=0.9,*/*;q=0.8' },
            validateStatus: () => true,
          });
          const data = res.data;
          const contentType = String(res.headers?.['content-type'] || '').toLowerCase();
          if (/html/.test(contentType) || (typeof data === 'string' && /<!doctype|<html/i.test(data))) {
            throw new Error(`Boost6 endpoint returned HTTP ${res.status}`);
          }
          finalData = data;
          finalMessage = String(data?.message || data?.error || `HTTP ${res.status}`);
          if (data?.success === true || data?.status === true) break;
          if (!/missing required parameter/i.test(finalMessage)) break;
        }
        _clearTimedState(_boost6Store, chat);
        if (!(finalData?.success === true || finalData?.status === true)) {
          throw new Error(finalMessage || 'provider rejected the request');
        }
        const result = finalData?.result || finalData?.data || finalData || {};
        const lines = [
          '✅ *Boost6*',
          `🎯 Type: ${_boostLabel(state.kind)}`,
          `🔢 Count: ${count}`,
          result?.message ? String(result.message) : null,
          result?.task_id ? `🆔 Task: ${result.task_id}` : null,
        ].filter(Boolean).join('\n');
        if (skey) await sock.sendMessage(chat, { delete: skey }).catch(() => {});
        await sendReply(sock, msg, lines);
        return safeReact(sock, msg, '✅');
      } catch (e) {
        _clearTimedState(_boost6Store, chat);
        if (skey) await ctx.editMessage?.(sock, chat, skey, `❌ Boost6 failed: ${e.message}`).catch(() => {});
        else await sendReply(sock, msg, `❌ Boost6 failed: ${e.message}`);
        await safeReact(sock, msg, '❌');
        return true;
      }
    };
    const boost6Count = async (sock, msg, args) => {
      const count = _parseCountText((args || []).join(' '));
      return boost6Submit(sock, msg, count);
    };
    const boost6Cancel = async (sock, msg) => {
      _clearTimedState(_boost6Store, msg?.key?.remoteJid);
      return safeReact(sock, msg, '👍');
    };
    _v21BoostNumericHandler = async (sock, msg, body) => {
      const chat = msg?.key?.remoteJid || '';
      const state = _getTimedState(_boost6Store, chat, BOOST6_TTL_MS);
      if (!state || state.stage !== 'count') return false;
      const sender = msg?.key?.participant || msg?.key?.remoteJid || '';
      if (state.sender && sender && state.sender !== sender) return false;
      const count = _parseCountText(body);
      if (!Number.isFinite(count) || count <= 0) return false;
      await boost6Submit(sock, msg, count);
      return true;
    };
    hardBind(['boost6'], { desc: 'Boost TikTok likes/followers/views with a native flow', category: 'TOOLS' }, boost6Start);
    hardBind(['boost6pick'], { desc: 'Internal: boost6 type pick', category: 'TOOLS' }, boost6Pick);
    hardBind(['boost6count'], { desc: 'Internal: boost6 count input', category: 'TOOLS' }, boost6Count);
    hardBind(['boost6cancel'], { desc: 'Internal: boost6 cancel', category: 'TOOLS' }, boost6Cancel);
    report.boost6 = true;
  } catch (e) { console.log('[precious-v21] boost6 error:', e && e.message); }

  try {
    if (typeof ctx.setSettingsReply === 'function') {
      const previousSettingsReply = typeof globalThis.__PRECIOUS_SETTINGS_REPLY__ === 'function' ? globalThis.__PRECIOUS_SETTINGS_REPLY__ : null;
      ctx.setSettingsReply(async (sock, msg, body) => {
        // OWN-CARD-FIRST ROUTING FIX: a plain numeric reply that QUOTES one of
        // our download cards (.nkiri / .play / .movie / .tt / .savetube) belongs
        // to that card — never to the settings panel. Previously this hook fell
        // straight through to the v20 settings validator, which answered
        // "⚠️ *1* is not a settings option" when the user quoted the play card
        // and typed 1 to get the audio file.
        try {
          const _chat = msg?.key?.remoteJid || '';
          const _choice = String(body || '').trim().replace(/^[.\-*`\s]+/, '').replace(/[\s*`]+$/, '');
          const _isNumeric = /^\d{1,2}(\.\d{1,2})?$/.test(_choice);
          if (_isNumeric) {
            // nkiri: bare result number while a search is pending
            const _nk = _nkiriGetState(_chat);
            if (_nk && _nk.stage === 'results' && /^\d+$/.test(_choice)) {
              const _idx = Number(_choice);
              if (_idx >= 1 && _idx <= (_nk.results || []).length) {
                const _nkEntry = ctx.commands && ctx.commands.get('nkpick');
                if (_nkEntry?.handler) return await _nkEntry.handler(sock, msg, [_choice]);
              }
            }
            // tiktok: 1.1-3.2 or 1-3 while tiktok picker is pending or quoting tiktok
            if (/^(1\.[1-7]|2\.[1-3]|3\.[1-2]|[1-3])$/.test(_choice)) {
              let _isTt = false;
              try {
                if (typeof globalThis.__ttGetSelection === "function" && globalThis.__ttGetSelection(_chat)) _isTt = true;
                const _qm = msg?.message?.extendedTextMessage?.contextInfo?.quotedMessage;
                const _txt = JSON.stringify(_qm || "");
                if (/tiktok|tikwm|vt\.tiktok|📂 open categories/i.test(_txt)) _isTt = true;
              } catch {}
              if (_isTt) {
                const _pk = ctx.commands && ctx.commands.get("pick");
                if (_pk?.handler) return await _pk.handler(sock, msg, [_choice]);
              }
            }

            // play (v21 native picker): 1-4 output choice via playFind
            if (/^\d+$/.test(_choice) && typeof playFind === 'function') {
              const _entry = playFind(msg);
              if (_entry?.meta) {
                const _n = Number(_choice);
                if (_n >= 1 && _n <= 4) {
                  const _plEntry = ctx.commands && ctx.commands.get('jxplaypick');
                  if (_plEntry?.handler) return await _plEntry.handler(sock, msg, [_choice]);
                }
              }
            }
          }
        } catch (_routeErr) { console.log('[precious-v21] card routing:', _routeErr && _routeErr.message); }
        if (typeof _v21BoostNumericHandler === 'function') {
          try { if (await _v21BoostNumericHandler(sock, msg, body)) return true; } catch {}
        }
        if (typeof _v21GstNumericHandler === 'function') {
          try { if (await _v21GstNumericHandler(sock, msg, body)) return true; } catch {}
        }
        if (typeof previousSettingsReply === 'function') return previousSettingsReply(sock, msg, body);
        return false;
      });
    }
  } catch (e) { console.log('[precious-v21] numeric hook error:', e && e.message); }

  /* ══════════════════════════════════════════════════════════════════════
     .tgsticker — Telegram sticker pack → WhatsApp stickers
     ══════════════════════════════════════════════════════════════════════ */
  try {
    const normaliseTelegramPack = (payload, fallbackName) => {
      const root = payload?.result || payload?.data || payload;
      const raw = Array.isArray(root?.sticker)
        ? root.sticker
        : Array.isArray(root?.stickers)
          ? root.stickers
          : [];
      const sticker = raw.map((item) => {
        if (typeof item === 'string') return { url: item };
        return {
          url: item?.url || item?.download_url || item?.file_url || "",
          is_animated: !!item?.is_animated,
          is_video: !!item?.is_video,
        };
      }).filter((item) => /^https?:\/\//i.test(item.url));
      return {
        status: sticker.length > 0,
        result: {
          title: root?.title || root?.name || fallbackName,
          sticker,
        },
      };
    };

    // The old DavidCyril endpoint is currently returning a hard 503
    // (service suspended). Retry transient failures, then use the official
    // Telegram Bot API when TELEGRAM_BOT_TOKEN is configured. This keeps the
    // command working without baking a third-party service into the bot.
    const fetchTelegramPack = async (shortName) => {
      let lastError = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const response = await dcGet('/telegram-sticker', {
            url: `https://t.me/addstickers/${shortName}`,
          }, 30000);
          const normalized = normaliseTelegramPack(response?.data, shortName);
          if (response?.ok && normalized.result.sticker.length) return normalized;
          lastError = new Error(
            response?.status
              ? `Telegram sticker provider returned HTTP ${response.status}`
              : (response?.error || 'Telegram sticker provider returned no stickers'),
          );
          if (![408, 425, 429, 500, 502, 503, 504].includes(Number(response?.status))) break;
        } catch (error) {
          lastError = error;
        }
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
      }

      const token = String(process.env.TELEGRAM_BOT_TOKEN || process.env.TG_BOT_TOKEN || '').trim();
      if (token) {
        // Telegram bot tokens contain a colon; keep it in the path because
        // the Bot API expects the literal bot<id>:<secret> form.
        const api = `https://api.telegram.org/bot${token}`;
        const setResponse = await axios.get(`${api}/getStickerSet`, {
          params: { name: shortName },
          timeout: 30000,
        });
        if (!setResponse.data?.ok || !setResponse.data?.result) {
          throw new Error(setResponse.data?.description || 'Telegram getStickerSet failed');
        }
        const set = setResponse.data.result;
        const sticker = [];
        for (const item of (set.stickers || []).slice(0, 30)) {
          const fileResponse = await axios.get(`${api}/getFile`, {
            params: { file_id: item.file_id },
            timeout: 30000,
          });
          const filePath = fileResponse.data?.result?.file_path;
          if (filePath) {
            sticker.push({
              url: `https://api.telegram.org/file/bot${token}/${filePath}`,
              is_animated: !!item.is_animated,
              is_video: !!item.is_video,
            });
          }
        }
        if (sticker.length) {
          return {
            status: true,
            result: { title: set.title || shortName, sticker },
          };
        }
        throw new Error('Telegram returned an empty sticker set');
      }

      const status = lastError?.message || 'provider unavailable';
      throw new Error(
        `${status}. The old sticker provider is unavailable; configure TELEGRAM_BOT_TOKEN for the official Telegram fallback.`,
      );
    };

    const tgHandler = async (sock, msg, args) => {
      const input = (args || []).join(' ').trim();
      const m = input.match(/(?:https?:\/\/)?t\.me\/addstickers\/([A-Za-z0-9_]+)/i) || input.match(/^([A-Za-z0-9_]{3,})$/);
      if (!m) return sendReply(sock, msg, `🎭 *Telegram Sticker → WhatsApp*\n\nUsage: *${PREFIX}tgsticker <pack link>*\nExample: *${PREFIX}tgsticker https://t.me/addstickers/HotCherry*`);
      const packUrl = `https://t.me/addstickers/${m[1]}`;
      await safeReact(sock, msg, '🎭');
      const chat = msg.key.remoteJid;
      const statusMsg = await sock.sendMessage(chat, { text: `🎭 *TG Sticker*\n\n⏳ Fetching pack *${m[1]}* ...` }, { quoted: msg }).catch(() => null);
      const skey = statusMsg?.key;
      try {
        const d = await fetchTelegramPack(m[1]);
        if (!d?.status || !d?.result?.sticker?.length) throw new Error(d?.message || 'pack not found or empty');
        const packName = d.result.title || d.result.name || m[1];
        const stickers = d.result.sticker.slice(0, 30); // cap to keep it fast
        if (skey) await ctx.editMessage?.(sock, chat, skey, `🎭 *${packName}*\n\n⬇️ Converting ${stickers.length} sticker${stickers.length > 1 ? 's' : ''} ...`).catch(() => {});

        let sent = 0, failed = 0;
        for (const st of stickers) {
          try {
            const resp = await race(axios.get(st.url, { responseType: 'arraybuffer', timeout: 25000 }), 30000, 'sticker fetch');
            const buf = Buffer.from(resp.data);
            const webp = await tgToWebp(buf, st.url);
            const tagged = await tagSticker(webp, packName, CONFIG.BOT_NAME || 'MIAS MDX');
            await race(sock.sendMessage(chat, { sticker: tagged }, { quoted: msg }), 30000, 'sticker send');
            sent++;
            // small gap so WhatsApp doesn't rate-limit a burst
            await new Promise(r => setTimeout(r, 600));
          } catch (e) { failed++; console.log('[tgsticker] one sticker failed:', e && e.message); }
        }
        if (skey) await sock.sendMessage(chat, { delete: skey }).catch(() => {});
        await sendReply(sock, msg, `🎭 *${packName}*\n\n✅ Sent *${sent}* sticker${sent !== 1 ? 's' : ''}${failed ? ` (${failed} failed)` : ''}.`);
        return safeReact(sock, msg, sent ? '✅' : '❌');
      } catch (e) {
        if (skey) await ctx.editMessage?.(sock, chat, skey, `❌ TG Sticker error: ${e.message}`).catch(() => {});
        else await sendReply(sock, msg, `❌ TG Sticker error: ${e.message}`);
        return safeReact(sock, msg, '❌');
      }
    };
    cmd(['tgsticker', 'tgstickers', 'tgs'], { desc: 'Telegram sticker pack → WhatsApp stickers', category: 'STICKER' }, tgHandler);

    // .tgpack — download full Telegram sticker pack as a zip bundle
    const tgPackHandler = async (sock, msg, args) => {
      const input = (args || []).join(' ').trim();
      const m = input.match(/(?:https?:\/\/)?t\.me\/addstickers\/([A-Za-z0-9_]+)/i) || input.match(/^([A-Za-z0-9_]{3,})$/);
      if (!m) return sendReply(sock, msg, `📦 *Telegram Sticker Pack Downloader*\n\nUsage: *${PREFIX}tgpack <pack link or name>*\nExample: *${PREFIX}tgpack https://t.me/addstickers/HotCherry*`);
      await safeReact(sock, msg, '📦');
      const chat = msg.key.remoteJid;
      const statusMsg = await sock.sendMessage(chat, { text: `📦 *TG Sticker Pack*\n\n⏳ Fetching pack *${m[1]}* ...` }, { quoted: msg }).catch(() => null);
      const skey = statusMsg?.key;
      try {
        const d = await fetchTelegramPack(m[1]);
        if (!d?.status || !d?.result?.sticker?.length) throw new Error(d?.message || 'pack not found or empty');
        const packName = d.result.title || d.result.name || m[1];
        // Native WhatsApp sticker packs support up to 60 stickers
        const stickers = d.result.sticker.slice(0, 60);
        if (skey) await ctx.editMessage?.(sock, chat, skey, `📦 *${packName}*\n\n⬇️ Downloading and converting ${stickers.length} stickers ...`).catch(() => {});

        const webpBuffers = [];
        const batchSize = 6;
        for (let i = 0; i < stickers.length; i += batchSize) {
          const slice = stickers.slice(i, i + batchSize);
          const batchResults = await Promise.all(slice.map(async (st) => {
            try {
              const resp = await race(axios.get(st.url, { responseType: 'arraybuffer', timeout: 15000 }), 18000, 'sticker fetch');
              const buf = Buffer.from(resp.data);
              return await tgToWebp(buf, st.url);
            } catch (_) { return null; }
          }));
          for (const b of batchResults) {
            if (b && b.length) webpBuffers.push(b);
          }
          if (skey && (i + batchSize) % 12 === 0) {
            await ctx.editMessage?.(sock, chat, skey, `📦 *${packName}*

⬇️ Processed ${webpBuffers.length}/${stickers.length} stickers...`).catch(() => {});
          }
        }

        if (!webpBuffers.length) throw new Error('no stickers could be converted');

        // 1. Try NATIVE sticker pack message. The protocol needs the exif
        // sticker-pack-id + publisher + name embedded in every webp so the
        // client groups them into ONE pack with a "View sticker pack" button.
        let sentNative = false;
        try {
          const coverBuf = webpBuffers[0];
          const stickerItems = [];
          for (const b of webpBuffers) {
            stickerItems.push({ data: await tagSticker(b, packName, 'Signed : †sir Demont') });
          }
          await sock.sendMessage(chat, {
            stickerPackMessage: {
              name: packName,
              publisher: 'Signed : †sir Demont',
              stickerPackId: 'com.mias.tgpack.' + String(m[1]).toLowerCase(),
              packDescription: `Telegram pack: ${packName}`,
              cover: coverBuf,
              stickers: stickerItems,
            }
          }, { quoted: msg });
          sentNative = true;
          console.log(`[tgpack] sent native stickerPackMessage with ${stickerItems.length} stickers`);
        } catch (nativeErr) {
          console.log('[tgpack] native stickerPackMessage failed, trying legacy stickerPack:', nativeErr && nativeErr.message);
          try {
            const coverBuf = webpBuffers[0];
            const stickerItems = [];
            for (const b of webpBuffers) {
              stickerItems.push({ data: await tagSticker(b, packName, 'Signed : †sir Demont') });
            }
            await sock.sendMessage(chat, {
              stickerPack: {
                name: packName,
                publisher: 'Signed : †sir Demont',
                cover: coverBuf,
                stickers: stickerItems,
                description: `Telegram pack: ${packName}`,
              }
            }, { quoted: msg });
            sentNative = true;
            console.log(`[tgpack] sent legacy stickerPack with ${stickerItems.length} stickers`);
          } catch (legacyErr) {
            console.log('[tgpack] native delivery failed, falling back to zip document:', legacyErr && legacyErr.message);
          }
        }

        // 2. Fallback to ZIP document if native sticker pack fails
        if (!sentNative) {
          const archiver = require('archiver');
          const { PassThrough } = require('stream');
          const pass = new PassThrough();
          const archive = archiver('zip', { zlib: { level: 6 } });
          const chunks = [];
          pass.on('data', c => chunks.push(c));
          archive.pipe(pass);
          for (let i = 0; i < webpBuffers.length; i++) {
            const num = String(i + 1).padStart(3, '0');
            archive.append(webpBuffers[i], { name: `${num}.webp` });
          }
          await archive.finalize();
          await new Promise((resolve, reject) => {
            pass.on('end', resolve);
            pass.on('error', reject);
          });
          const zipBuffer = Buffer.concat(chunks);
          const safeFilename = `${packName.replace(/[^a-zA-Z0-9_-]/g, '_')}_stickers.zip`;
          await sock.sendMessage(chat, {
            document: zipBuffer,
            mimetype: 'application/zip',
            fileName: safeFilename,
            caption: `🎭 *${packName}*\n\n📦 Bundled *${webpBuffers.length}* stickers!\nSigned : †sir Demont`,
          }, { quoted: msg });
        }

        if (skey) await sock.sendMessage(chat, { delete: skey }).catch(() => {});
        return safeReact(sock, msg, '✅');
      } catch (e) {
        if (skey) await ctx.editMessage?.(sock, chat, skey, `❌ TG Pack error: ${e.message}`).catch(() => {});
        else await sendReply(sock, msg, `❌ TG Pack error: ${e.message}`);
        return safeReact(sock, msg, '❌');
      }
    };
    cmd(['tgpack', 'tgstickerpack', 'tgp', 'tgszip'], { desc: 'Download entire Telegram sticker pack as a single ZIP file', category: 'STICKER' }, tgPackHandler);

    report.tgsticker = true;
  } catch (e) { console.log('[precious-v21] tgsticker error:', e && e.message); }

  /* ══════════════════════════════════════════════════════════════════════
     .shazam — identify a song from a replied audio / voice / video
     ══════════════════════════════════════════════════════════════════════ */
  try {
    const shazamHandler = async (sock, msg) => {
      const chat = msg.key.remoteJid;
      const q = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
      const src = unwrap(q || msg.message || {});
      const aud = src?.audioMessage, vid = src?.videoMessage;
      if (!aud && !vid) return sendReply(sock, msg, `🎵 *Shazam*\n\nReply to an *audio, voice note or video* with *${PREFIX}shazam* to identify the song.`);
      await safeReact(sock, msg, '🎵');
      const statusMsg = await sock.sendMessage(chat, { text: `🎵 *Shazam*\n\n⬡ Downloading audio...\n◻ Identifying song...` }, { quoted: msg }).catch(() => null);
      const skey = statusMsg?.key;
      try {
        const dl = ctx.downloadContentFromMessage;
        if (typeof dl !== 'function') throw new Error('media downloader unavailable');
        let buf = Buffer.from([]);
        const stream = await dl(aud || vid, aud ? 'audio' : 'video');
        for await (const chunk of stream) buf = Buffer.concat([buf, chunk]);
        if (!buf || buf.length < 15000) throw new Error('audio too short — need at least ~5 seconds');
        if (buf.length > 8 * 1024 * 1024) buf = buf.slice(0, 8 * 1024 * 1024); // keep it light

        if (skey) await ctx.editMessage?.(sock, chat, skey, `🎵 *Shazam*\n\n⬢ Audio ready ✅\n⬡ Identifying song...`).catch(() => {});

        // 1) upload to Catbox to get a public URL  2) ask the Shazam API
        let audioUrl = null;
        try {
          const FD = (await import('form-data')).default;
          const form = new FD();
          form.append('file', buf, { filename: aud ? 'audio.ogg' : 'audio.mp4', contentType: aud ? 'audio/ogg' : 'video/mp4' });
          const up = await race(axios.post(`${DC}/uploader/catbox`, form, { headers: form.getHeaders(), timeout: 45000 }), 50000, 'catbox upload');
          if (up.data?.success && up.data?.url) audioUrl = up.data.url;
        } catch (e) { console.log('[shazam] catbox upload failed:', e && e.message); }
        if (!audioUrl) throw new Error('could not upload audio for identification');

        const d = await dcGet('/shazam', { url: audioUrl }, 40000);
        if (!d?.success || !d?.result) throw new Error(d?.message || 'song not recognised');
        const r = d.result;
        const title = r.title || r.track || 'Unknown';
        const artist = r.artist || r.subtitle || 'Unknown artist';
        const lines = [
          `🎵 *Song Identified!*`, ``,
          `🎤 *Title:* ${title}`,
          `👤 *Artist:* ${artist}`,
          r.album ? `💿 *Album:* ${r.album}` : null,
          r.genre ? `🎼 *Genre:* ${r.genre}` : null,
          r.release_date ? `📅 *Released:* ${r.release_date}` : null,
          r.shazam_url ? `🔗 ${r.shazam_url}` : null,
        ].filter(Boolean).join('\n');

        if (skey) await sock.sendMessage(chat, { delete: skey }).catch(() => {});
        // send cover art if present
        if (r.cover) {
          try {
            await race(sock.sendMessage(chat, { image: { url: r.cover }, caption: lines }, { quoted: msg }), 30000, 'cover send');
          } catch { await sendReply(sock, msg, lines); }
        } else {
          await sendReply(sock, msg, lines);
        }
        return safeReact(sock, msg, '✅');
      } catch (e) {
        if (skey) await ctx.editMessage?.(sock, chat, skey, `🎵 *Shazam*\n\n❌ ${e.message}`).catch(() => {});
        else await sendReply(sock, msg, `🎵 *Shazam*\n\n❌ ${e.message}`);
        return safeReact(sock, msg, '❌');
      }
    };
    cmd(['shazam', 'whatmusic', 'findsong'], { desc: 'Identify a song from audio/voice note', category: 'TOOLS' }, shazamHandler);
    report.shazam = true;
  } catch (e) { console.log('[precious-v21] shazam error:', e && e.message); }


  /* ══════════════════════════════════════════════════════════════════════
     .gst — direct group post, or DM native group picker
     ══════════════════════════════════════════════════════════════════════ */
  try {
    const genId = () => 'PREC' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    const isGroupJid = (jid) => /@g\.us$/i.test(String(jid || ''));
    async function postStatus(sock, targetChat, memberJids, payload, { allowChatFallback = true } = {}) {
      const opts = { statusJidList: memberJids, messageId: genId() };
      const errs = [];
      try {
        await race(sock.sendMessage('status@broadcast', { ...payload, contextInfo: { isGroupStatus: true, mentionedJid: [] } }, opts), 45000, 'status upload');
        return true;
      } catch (e) { errs.push('broadcast: ' + (e && e.message)); }
      if (!allowChatFallback) throw new Error(errs.join(' | ') || 'status upload failed');
      try {
        await race(sock.sendMessage(targetChat, { ...payload, contextInfo: { isGroupStatus: true } }), 30000, 'in-chat');
        return true;
      } catch (e) { errs.push('in-chat: ' + (e && e.message)); }
      throw new Error(errs.join(' | ') || 'all posting failed');
    }
    async function memberList(sock, targetChat) {
      let memberJids = [];
      try {
        const meta = await race(sock.groupMetadata(targetChat), 15000, 'groupMetadata');
        memberJids = (meta?.participants || []).map((p) => (typeof p.id === 'string' ? p.id : String(p.id || ''))).filter(Boolean);
      } catch {}
      return memberJids;
    }
    async function buildPayload(sock, msg, args) {
      const text = (args || []).join(' ').trim();
      const quoted = _quotedMessageOf(msg);
      const qInner = _innerMediaOf(quoted) || _innerMediaOf(unwrap(msg.message || {}));
      const quotedText = quoted ? _textOfMessage(quoted) : '';
      if (!qInner && !text && !quotedText) return { error: `📢 *Group Status*\n\nReply to media + *${PREFIX}gst*, or *${PREFIX}gst <text>* for a text status.` };
      if (qInner) {
        const buf = await race(_bufferFromInner(ctx, qInner), 60000, 'media download');
        if (!buf || !buf.length) throw new Error('could not download the media');
        const payload = qInner.kind === 'image' ? { image: buf, caption: text || qInner.raw.caption || '' }
          : qInner.kind === 'video' ? { video: buf, caption: text || qInner.raw.caption || '' }
          : qInner.kind === 'audio' ? { audio: buf, mimetype: qInner.raw.mimetype || 'audio/mpeg' }
          : qInner.kind === 'sticker' ? { sticker: buf }
          : { document: buf, mimetype: qInner.raw.mimetype || 'application/octet-stream', fileName: qInner.raw.fileName || 'file' };
        return { payload };
      }
      return { payload: { text: text || quotedText } };
    }
    async function listJoinedGroups(sock) {
      const all = await sock.groupFetchAllParticipating().catch(() => ({}));
      return Object.values(all || {})
        .filter((g) => g && isGroupJid(g.id))
        .map((g) => ({ id: g.id, subject: g.subject || g.name || g.id }))
        .sort((a, b) => String(a.subject).localeCompare(String(b.subject)));
    }
    const gstPick = async (sock, msg, args) => {
      const chat = msg.key.remoteJid;
      const state = _getTimedState(_gstPickStore, chat, GST_PICK_TTL_MS);
      if (!state || state.stage !== 'pick') return sendReply(sock, msg, `❌ That group picker expired. Run *${PREFIX}gst* again.`);
      const sender = msg?.key?.participant || msg?.key?.remoteJid || '';
      if (state.sender && sender && state.sender !== sender) return sendReply(sock, msg, '❌ This picker belongs to a different user.');
      const token = String((args || []).join(' ').trim() || '0');
      const idx = Number(token) - 1;
      const picked = Number.isInteger(idx) ? state.groups?.[idx] : null;
      if (!picked?.id) return sendReply(sock, msg, '❌ Invalid group choice.');
      await safeReact(sock, msg, '🌀');
      const statusMsg = await sock.sendMessage(chat, { text: `📢 *Group Status*\n\n⏳ Uploading to *${picked.subject}* ...` }, { quoted: msg }).catch(() => null);
      const skey = statusMsg?.key;
      try {
        const memberJids = await memberList(sock, picked.id);
        await postStatus(sock, picked.id, memberJids, state.payload, { allowChatFallback: false });
        _clearTimedState(_gstPickStore, chat);
        if (skey) await sock.sendMessage(chat, { delete: skey }).catch(() => {});
        await sendReply(sock, msg, `✅ Posted to *${picked.subject}*.`).catch(() => {});
        return safeReact(sock, msg, '✅');
      } catch (e) {
        if (skey) await ctx.editMessage?.(sock, chat, skey, `❌ Group status failed: ${e.message}`).catch(() => {});
        else await sendReply(sock, msg, `❌ Group status failed: ${e.message}`).catch(() => {});
        return safeReact(sock, msg, '❌');
      }
    };
    const gstCancel = async (sock, msg) => {
      _clearTimedState(_gstPickStore, msg?.key?.remoteJid);
      return safeReact(sock, msg, '👍');
    };
    _v21GstNumericHandler = async (sock, msg, body) => {
      const chat = msg?.key?.remoteJid || '';
      const state = _getTimedState(_gstPickStore, chat, GST_PICK_TTL_MS);
      if (!state || state.stage !== 'pick') return false;
      const sender = msg?.key?.participant || msg?.key?.remoteJid || '';
      if (state.sender && sender && state.sender !== sender) return false;
      const pick = _parseCountText(body);
      if (!Number.isInteger(pick) || pick < 1 || pick > (state.groups || []).length) return false;
      await gstPick(sock, msg, [String(pick)]);
      return true;
    };
    const gstHandler = async (sock, msg, args) => {
      const chat = msg.key.remoteJid;
      const inGroup = isGroupJid(chat);
      let settled = false;
      const reactOnce = async (emoji) => { if (settled) return; settled = true; try { await (ctx.forceReaction || react)(sock, msg, emoji); } catch {} };
      await reactOnce('🌀'); settled = false;
      const watchdog = setTimeout(() => reactOnce('❌'), 90000);
      try {
        const prepared = await buildPayload(sock, msg, args);
        if (prepared.error) {
          clearTimeout(watchdog);
          await reactOnce('❌');
          return sendReply(sock, msg, prepared.error);
        }
        if (inGroup) {
          // Group chats must post immediately — never open the DM/native picker here.
          const memberJids = await memberList(sock, chat);
          await postStatus(sock, chat, memberJids, prepared.payload, { allowChatFallback: true });
          clearTimeout(watchdog);
          await reactOnce('✅');
          await sendReply(sock, msg, '✅ Posted to group status.').catch(() => {});
          return;
        }
        const groups = await listJoinedGroups(sock);
        if (!groups.length) {
          clearTimeout(watchdog);
          await reactOnce('❌');
          return sendReply(sock, msg, '❌ No joined groups found for GST.');
        }
        _setTimedState(_gstPickStore, chat, { stage: 'pick', sender: msg?.key?.participant || msg?.key?.remoteJid || '', payload: prepared.payload, groups }, GST_PICK_TTL_MS);
        const rows = groups.slice(0, 50).map((g, i) => ({ title: `${i + 1}. ${String(g.subject).slice(0, 60)}`, description: g.id, id: `${PREFIX}gstpick ${i + 1}`, rowId: `${PREFIX}gstpick ${i + 1}` }));
        const body = `📢 *Group Status*\n\nPick the group you want to post this status to.`;
        if (typeof ctx.sendNativeFlowListMenu === 'function') {
          try {
            // Native list menus are silently DROPPED by WhatsApp when the
            // payload is oversized or the session cannot carry native flow —
            // that made DM .gst go completely silent. Race it against a
            // short window; if nothing lands, fall back to a plain numbered
            // text list (the numeric handler below understands the replies).
            const nativeSent = await Promise.race([
              ctx.sendNativeFlowListMenu(sock, chat, msg, body, [{ title: 'Your Groups', rows }], [{ text: '❌ Cancel', id: `${PREFIX}gstcancel` }]).catch(() => null),
              new Promise((r) => setTimeout(() => r(null), 8000)),
            ]);
            if (!nativeSent?.key?.id) throw new Error('native flow menu not delivered');
          } catch {
            const numList = rows.map((r, i) => `${i + 1} - ${String(r.title).replace(/^\d+\.\s*/, '')}`).join('\n');
            await sendReply(sock, msg, `${body}\n\nReply with a NUMBER to choose:\n\n${numList}\n\nReply ${PREFIX}gstcancel to stop.`).catch(() => {});
          }
        } else {
          const numList = rows.map((r, i) => `${i + 1} - ${String(r.title).replace(/^\d+\.\s*/, '')}`).join('\n');
          await sendReply(sock, msg, `${body}\n\nReply with a NUMBER to choose:\n\n${numList}\n\nReply ${PREFIX}gstcancel to stop.`);
        }
        clearTimeout(watchdog);
        await reactOnce('✅');
        return;
      } catch (e) {
        clearTimeout(watchdog);
        await reactOnce('❌');
        await sendReply(sock, msg, `❌ Group status failed: ${e.message}`).catch(() => {});
      }
    };
    hardBind(['gst', 'gstatus', 'groupstatus'], { desc: 'Post to group status or choose a group in DM', category: 'GROUP' }, gstHandler);
    hardBind(['gstpick'], { desc: 'Internal: GST group pick', category: 'GROUP' }, gstPick);
    hardBind(['gstcancel'], { desc: 'Internal: GST cancel', category: 'GROUP' }, gstCancel);
    report.gst = true;
  } catch (e) { console.log('[precious-v21] gst error:', e && e.message); }

  console.log('[precious-v21] installed → nkiri:' + report.nkiri + ' tgsticker:' + report.tgsticker + ' shazam:' + report.shazam + ' gst:' + report.gst);
  return report;
}

module.exports = { install };
