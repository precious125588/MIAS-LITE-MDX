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
    const pr = spawn(ffmpegBin(), args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    pr.stderr.on('data', d => { err += d.toString(); });
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
  try {
    return await sock.sendMessage(jid, { [kind]: { url: filePath }, ...extra }, { quoted });
  } catch (firstError) {
    try {
      return await sock.sendMessage(jid, { [kind]: fs.createReadStream(filePath), ...extra }, { quoted });
    } catch {
      throw firstError;
    }
  }
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


/* ── module ──────────────────────────────────────────────────────────────── */

function install(ctx) {
  const report = { nkiri: false, movie: false, play: false, upload8: false, boost6: false, tgsticker: false, shazam: false, gst: false };
  const { cmd, CONFIG, sendReply, react } = ctx;
  const PREFIX = (CONFIG && CONFIG.PREFIX) || '.';

  const safeReact = (sock, msg, emoji) => { try { return react(sock, msg, emoji); } catch { return Promise.resolve(); } };


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
        const body = `🎬 *Nkiri — "${q}"*\n\nFound *${results.length}* result${results.length > 1 ? 's' : ''}. Tap *Open Results* and pick one.`;
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
      const d = data?.data || data?.result || data || {};
      const download = d?.download || {};
      const fileUrl = download?.url || download?.download_url || download?.direct_url || d?.download_url || d?.file_url || d?.fileUrl || null;
      return {
        title: d?.title || d?.name || 'Movie',
        fileUrl: typeof fileUrl === 'string' && /^https?:\/\//i.test(fileUrl) ? fileUrl : null,
        fileName: download?.file_name || d?.file_name || '',
        fileExt: String(download?.file_ext || d?.file_ext || '').toLowerCase(),
        fileSize: download?.file_size || d?.file_size || '',
        host: download?.host || d?.host || '',
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
        const info = movieInfo(data);
        if (!info.fileUrl) throw new Error('movie file url missing from Netnaija response');
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
    cmd(['movie'], { desc: 'Search & download Netnaija movies — .movie <title>', category: 'DOWNLOAD' }, movieSearch);
    cmd(['movpick'], { desc: 'Internal: movie title pick', category: 'DOWNLOAD' }, movPick);
    cmd(['movcancel'], { desc: 'Internal: movie cancel', category: 'DOWNLOAD' }, movCancel);
    cmd(['moviedl'], { desc: 'Use .movie native picker instead', category: 'DOWNLOAD' }, async (sock, msg) => {
      await sendReply(sock, msg, `🎬 Use *${PREFIX}movie <title>* and pick from the native movie list.\n\n_This movie flow now stays on the native picker — no ${PREFIX}moviedl step needed._`);
    });
    report.movie = true;
  } catch (e) { console.log('[precious-v21] movie error:', e && e.message); }

  /* ══════════════════════════════════════════════════════════════════════
     .play — native picker with verified local media delivery
     ══════════════════════════════════════════════════════════════════════ */
  try {
    const PLAY_HEADER = '───── 𝑷𝑹𝑬𝑪𝑰𝑶𝑼𝑺 x PLAYER ─────';
    const playNormChat = (jid) => String(jid || '').replace(/:\d+(?=@)/, '');
    const playSender = (msg) => String(msg?.key?.participant || msg?.key?.remoteJid || '');
    const playSameChat = (a, b) => playNormChat(a) === playNormChat(b);
    const playQuotedId = (msg) => {
      const c = _messageContextInfo(msg);
      return c?.stanzaId || c?.quotedMessage?.key?.id || null;
    };
    const playYtId = (input) => {
      const raw = String(input || '').trim();
      if (!raw) return '';
      const m = raw.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|shorts\/|embed\/))([A-Za-z0-9_-]{6,})/i);
      if (m) return m[1];
      if (/^[A-Za-z0-9_-]{6,}$/.test(raw)) return raw;
      return '';
    };
    const playExtract = (payload) => {
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
    const playStore = (keyId, jid, msg, meta) => {
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
    const playFind = (msg) => {
      _jxPlaySweep();
      const jid = msg?.key?.remoteJid || '';
      const user = playSender(msg);
      const quoted = playQuotedId(msg);
      if (quoted) {
        const entry = _jxPlayPending.get(String(quoted));
        if (entry && playSameChat(entry.jid, jid) && (!entry.user || !user || entry.user === user)) return entry;
      }
      const latestKey = _jxPlayLatestByChat.get(playNormChat(jid));
      if (!latestKey) return null;
      const latest = _jxPlayPending.get(String(latestKey));
      if (!latest || !playSameChat(latest.jid, jid)) return null;
      if (latest.user && user && latest.user !== user) return null;
      return latest;
    };
    const playDur = (v) => typeof ctx._p2Dur === 'function' ? ctx._p2Dur(v) : String(v || '0:00');
    const playViews = (v) => typeof ctx._p2Views === 'function' ? ctx._p2Views(v) : String(v || '0');
    const playThumb = async (meta) => {
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
    const playEnrich = async (meta, query) => {
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
      '  1️⃣ - Audio',
      '  2️⃣ - Document (.mp3)',
      '  3️⃣ - Voice note',
      '  4️⃣ - Video (.mp4)',
    ].join('\n');
    const playSections = () => [{
      title: 'Formats',
      rows: [
        { id: `${PREFIX}jxplaypick 1`, rowId: `${PREFIX}jxplaypick 1`, title: '1️⃣ Audio', description: 'Send standard audio' },
        { id: `${PREFIX}jxplaypick 2`, rowId: `${PREFIX}jxplaypick 2`, title: '2️⃣ Document (.mp3)', description: 'Send MP3 as document' },
        { id: `${PREFIX}jxplaypick 3`, rowId: `${PREFIX}jxplaypick 3`, title: '3️⃣ Voice note', description: 'Send as push-to-talk' },
        { id: `${PREFIX}jxplaypick 4`, rowId: `${PREFIX}jxplaypick 4`, title: '4️⃣ Video (.mp4)', description: 'Send MP4 video' },
      ],
    }];
    const playResolveAudioUrl = async (meta) => {
      const tries = [];
      const ytUrl = meta?.videoUrl || (meta?.videoId ? `https://www.youtube.com/watch?v=${meta.videoId}` : '');
      if (/^https?:\/\//i.test(String(meta?.dlUrl || ''))) tries.push(async () => meta.dlUrl);
      if (ytUrl) tries.push(async () => playExtract(await dcGet('/download/ytmp3', { url: ytUrl }, 35000)).dlUrl || null);
      if (ytUrl) tries.push(async () => playExtract(await dcGet('/play', { query: ytUrl }, 35000)).dlUrl || null);
      if (CONFIG.GIFTED_API && CONFIG.GIFTED_KEY && ytUrl) tries.push(async () => {
        const { data } = await axios.get(`${CONFIG.GIFTED_API}/api/download/ytmp3?apikey=${CONFIG.GIFTED_KEY}&url=${encodeURIComponent(ytUrl)}`, { timeout: 60000 });
        return data?.result?.download_url || data?.result?.url || data?.result?.audio || data?.result?.mp3 || null;
      });
      // ── Extra providers: fixes 'Download failed: no valid audio file url' ──
      if (ytUrl) tries.push(async () => {
        const { data } = await axios.get(`https://api.nexray.eu.cc/downloader/ytaudio?url=${encodeURIComponent(ytUrl)}`, { timeout: 45000 });
        const d = data?.result || data?.data || data;
        return d?.url || d?.audio || d?.download_url || d?.dl || d?.mp3 || null;
      });
      if (ytUrl) tries.push(async () => {
        const { data } = await axios.get(`https://api.nexray.eu.cc/downloader/ytmp3?url=${encodeURIComponent(ytUrl)}`, { timeout: 45000 });
        const d = data?.result || data?.data || data;
        return d?.url || d?.audio || d?.download_url || d?.dl || d?.mp3 || null;
      });
      if (ytUrl) tries.push(async () => {
        const { data } = await axios.get(`https://api.nexoracle.com/downloader/ytmp3?apikey=free_key@maher_apis&url=${encodeURIComponent(ytUrl)}`, { timeout: 45000 });
        return data?.result?.download_url || data?.result?.url || data?.result?.audio || data?.download_url || null;
      });
      if (ytUrl) tries.push(async () => {
        const { data } = await axios.get(`https://api.siputzx.my.id/api/d/ytmp3?url=${encodeURIComponent(ytUrl)}`, { timeout: 45000 });
        return data?.data?.dl || data?.data?.url || data?.url || null;
      });
      if (ytUrl) tries.push(async () => {
        const { data } = await axios.get(`https://api.ryzendesu.vip/api/downloader/ytmp3?url=${encodeURIComponent(ytUrl)}`, { timeout: 45000 });
        return data?.url || data?.result?.url || data?.data?.url || null;
      });
      if (ytUrl) tries.push(async () => {
        const { data } = await axios.get(`https://api.princetechn.com/api/download/ytmp3?apikey=prince&url=${encodeURIComponent(ytUrl)}`, { timeout: 45000 });
        return data?.result?.download_url || data?.result?.url || data?.result?.audio || null;
      });
      if (ytUrl) tries.push(async () => {
        const { data } = await axios.post("https://co.wuk.sh/api/json", { url: ytUrl, downloadMode: "audio", audioFormat: "mp3", filenameStyle: "basic" }, { headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "Mozilla/5.0" }, timeout: 40000 });
        return data?.url || data?.audio || null;
      });
      for (const fn of tries) {
        try {
          const out = await fn();
          if (typeof out === 'string' && /^https?:\/\//i.test(out)) return out;
        } catch {}
      }
      return null;
    };
    const playResolveVideoUrl = async (meta) => {
      const tries = [];
      const ytUrl = meta?.videoUrl || (meta?.videoId ? `https://www.youtube.com/watch?v=${meta.videoId}` : '');
      if (ytUrl) tries.push(async () => {
        const d = await dcGet('/download/ytmp4', { url: ytUrl }, 40000);
        return d?.result?.download_url || d?.result?.url || d?.download_url || d?.url || null;
      });
      if (ytUrl) tries.push(async () => {
        const d = await dcGet('/play', { query: ytUrl, type: 'video' }, 35000);
        return d?.result?.download_url || d?.result?.url || d?.download_url || d?.url || null;
      });
      if (CONFIG.GIFTED_API && CONFIG.GIFTED_KEY && ytUrl) tries.push(async () => {
        const { data } = await axios.get(`${CONFIG.GIFTED_API}/api/download/ytmp4?apikey=${CONFIG.GIFTED_KEY}&url=${encodeURIComponent(ytUrl)}`, { timeout: 60000 });
        return data?.result?.download_url || data?.result?.url || data?.result?.video || data?.result?.mp4 || null;
      });
      for (const fn of tries) {
        try {
          const out = await fn();
          if (typeof out === 'string' && /^https?:\/\//i.test(out)) return out;
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
          await _sendFilePath(sock, jid, 'video', fetched.filePath, { mimetype: 'video/mp4', fileName: `${title}.mp4` }, msg);
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
          if (mode === 2 || (mode === 1 && !['.mp3', '.m4a', '.ogg'].includes(sendExt))) {
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
    cmd(['play', 'music', 'song'], { desc: 'Play song — native picker with working local media delivery', category: 'DOWNLOAD' }, playSearch);
    cmd(['jxplaypick'], { desc: 'Internal: player format pick', category: 'DOWNLOAD' }, playPick);
    cmd(['jxplaycancel'], { desc: 'Internal: player cancel', category: 'DOWNLOAD' }, playCancel);
    report.play = true;
  } catch (e) { console.log('[precious-v21] play error:', e && e.message); }

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
    cmd(['boost6'], { desc: 'Boost TikTok likes/followers/views with a native flow', category: 'TOOLS' }, boost6Start);
    cmd(['boost6pick'], { desc: 'Internal: boost6 type pick', category: 'TOOLS' }, boost6Pick);
    cmd(['boost6count'], { desc: 'Internal: boost6 count input', category: 'TOOLS' }, boost6Count);
    cmd(['boost6cancel'], { desc: 'Internal: boost6 cancel', category: 'TOOLS' }, boost6Cancel);
    report.boost6 = true;
  } catch (e) { console.log('[precious-v21] boost6 error:', e && e.message); }

  try {
    if (typeof ctx.setSettingsReply === 'function') {
      const previousSettingsReply = typeof globalThis.__PRECIOUS_SETTINGS_REPLY__ === 'function' ? globalThis.__PRECIOUS_SETTINGS_REPLY__ : null;
      ctx.setSettingsReply(async (sock, msg, body) => {
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
        const d = await dcGet('/telegram-sticker', { url: packUrl }, 30000);
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
          await ctx.sendNativeFlowListMenu(sock, chat, msg, body, [{ title: 'Your Groups', rows }], [{ text: '❌ Cancel', id: `${PREFIX}gstcancel` }]);
        } else {
          await sendReply(sock, msg, body + '\n\n' + rows.map((r) => r.title).join('\n'));
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
    cmd(['gst', 'gstatus', 'groupstatus'], { desc: 'Post to group status or choose a group in DM', category: 'GROUP' }, gstHandler);
    cmd(['gstpick'], { desc: 'Internal: GST group pick', category: 'GROUP' }, gstPick);
    cmd(['gstcancel'], { desc: 'Internal: GST cancel', category: 'GROUP' }, gstCancel);
    report.gst = true;
  } catch (e) { console.log('[precious-v21] gst error:', e && e.message); }

  console.log('[precious-v21] installed → nkiri:' + report.nkiri + ' tgsticker:' + report.tgsticker + ' shazam:' + report.shazam + ' gst:' + report.gst);
  return report;
}

module.exports = { install };
