/**
 * MIAS — Universal Socket Wrapper (v2)
 *
 * Wraps a Baileys `sock` so every downstream module — including legacy
 * mega-files like `case.js` and `mias/index.js` — automatically gets:
 *
 *   1. Auto JPEG thumbnails on image/video sends (Buffer OR URL).
 *   2. URL → Buffer auto-fetch for image/video when a bare URL string
 *      is passed (fixes "grey placeholder when caller sends a URL").
 *   3. Reaction lifecycle safety: pending "loading" reactions
 *      (⌛/⏳/🌀/…) are tracked; watchdog + crash handlers force-clear
 *      them so no message stays permanently on ⌛.
 *   4. Auto ✅ on success: when a command later `sendMessage`s to the
 *      same chat quoting the same message it ⌛'d, wrapper flips the
 *      pending reaction to ✅. Covers legacy `case.js` handlers that
 *      never call a terminal reaction themselves.
 *   5. Audio artwork auto-embed: when an audio Buffer contains an ID3v2
 *      APIC (embedded cover art) and the caller didn't set
 *      externalAdReply, wrapper populates contextInfo.externalAdReply
 *      with the artwork. Fixes the Play / ytmp3 "no album art" bug
 *      without needing pre-bundle source.
 *
 * All hooks are fail-soft: any error inside the wrapper is swallowed
 * and the original send proceeds.
 *
 *   const { wrapSocket } = require('./socketWrapper.cjs');
 *   const sock = makeWASocket({ ... });
 *   wrapSocket(sock);
 */

'use strict';

const os   = require('os');
const path = require('path');
const fs   = require('fs');

// Reactions that mean "still working" — must be cleared later
const LOADING_EMOJIS  = new Set(['⌛', '⏳', '🌀', '⏰', '🔄', '⬇️', '⬆️']);
// Reactions that terminate the lifecycle (any of these clears pending)
const TERMINAL_EMOJIS = new Set(['✅', '❌', '⚠️', '🎉', '', null, undefined]);

// Track { "jid:msgId" → { _origSend, jid, key, ts } } for pending loading reactions
const _pendingReactions = new Map();
let   _globalHandlersInstalled = false;

// ─── Global crash / exit handlers ────────────────────────────────────────────

function _installGlobalHandlers() {
  if (_globalHandlersInstalled) return;
  _globalHandlersInstalled = true;

  const flush = async (finalEmoji = '❌') => {
    const entries = Array.from(_pendingReactions.values());
    _pendingReactions.clear();
    await Promise.all(entries.map(async (e) => {
      try { await e._origSend(e.jid, { react: { text: finalEmoji, key: e.key } }); } catch (_) {}
    }));
  };

  process.on('uncaughtException', (err) => {
    console.error('[socketWrapper] uncaughtException — flushing pending reactions:', err?.message);
    flush('❌').catch(() => {});
  });
  process.on('unhandledRejection', (err) => {
    console.error('[socketWrapper] unhandledRejection — flushing pending reactions:', err?.message || err);
    flush('❌').catch(() => {});
  });
  process.on('SIGINT',  () => { flush('❌').finally(() => process.exit(0)); });
  process.on('SIGTERM', () => { flush('❌').finally(() => process.exit(0)); });

  // Watchdog: any reaction pending > 90s → auto ❌
  setInterval(() => {
    const now = Date.now();
    for (const [id, e] of _pendingReactions.entries()) {
      if (now - e.ts > 90_000) {
        _pendingReactions.delete(id);
        e._origSend(e.jid, { react: { text: '❌', key: e.key } }).catch(() => {});
      }
    }
  }, 30_000).unref?.();
}

// ─── Thumbnail generation (best-effort, fail-soft) ───────────────────────────

let _jimp = null;
function _getJimp() {
  if (_jimp === null) { try { _jimp = require('jimp'); } catch { _jimp = false; } }
  return _jimp || null;
}

async function _imageThumb(buf) {
  const Jimp = _getJimp();
  if (!Jimp || !Buffer.isBuffer(buf) || buf.length < 100) return null;
  try {
    const img = await Jimp.read(buf);
    img.cover(300, 150).quality(70);
    return await img.getBufferAsync(Jimp.MIME_JPEG);
  } catch { return null; }
}

let _ffmpegBin = null;
function _getFfmpegBin() {
  if (_ffmpegBin === null) {
    try { const ffs = require('ffmpeg-static'); _ffmpegBin = ffs || 'ffmpeg'; }
    catch { _ffmpegBin = 'ffmpeg'; }
  }
  return _ffmpegBin;
}

async function _videoThumb(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 1024) return null;
  const bin  = _getFfmpegBin();
  const tmp  = os.tmpdir();
  const stamp = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const inp  = path.join(tmp, `wrapv_${stamp}.mp4`);
  const outp = path.join(tmp, `wrapv_${stamp}.jpg`);
  try {
    fs.writeFileSync(inp, buf);
    const { execFile } = require('child_process');
    await new Promise((resolve, reject) => {
      execFile(bin, [
        '-ss', '1', '-i', inp, '-vframes', '1',
        '-vf', 'scale=300:150:force_original_aspect_ratio=decrease,pad=300:150:(ow-iw)/2:(oh-ih)/2',
        '-f', 'image2', '-y', outp,
      ], { timeout: 8000 }, (err) => err ? reject(err) : resolve());
    });
    return fs.readFileSync(outp);
  } catch { return null; }
  finally {
    try { fs.unlinkSync(inp);  } catch {}
    try { fs.unlinkSync(outp); } catch {}
  }
}

function _extractBuffer(field) {
  if (Buffer.isBuffer(field)) return field;
  if (field && typeof field === 'object' && Buffer.isBuffer(field.data)) return field.data;
  return null;
}

// ─── URL → Buffer auto-fetch ─────────────────────────────────────────────────

function _extractUrl(field) {
  if (typeof field === 'string' && /^https?:\/\//i.test(field)) return field;
  if (field && typeof field === 'object' && typeof field.url === 'string' && /^https?:\/\//i.test(field.url)) return field.url;
  return null;
}

async function _fetchToBuffer(url) {
  try {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) return null;
    const ab = await res.arrayBuffer();
    const b  = Buffer.from(ab);
    if (b.length < 100 || b.length > 100 * 1024 * 1024) return null; // sanity cap 100MB
    return b;
  } catch { return null; }
}

// ─── ID3v2 APIC (embedded cover art) parser — dep-free ───────────────────────

function _extractId3Apic(buf) {
  try {
    if (!Buffer.isBuffer(buf) || buf.length < 20) return null;
    if (buf.toString('ascii', 0, 3) !== 'ID3') return null;
    const versionMajor = buf[3];
    // synchsafe size at bytes 6..9
    const tagSize = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    const end = Math.min(10 + tagSize, buf.length);
    let off = 10;
    while (off + 10 < end) {
      const frameId = buf.toString('ascii', off, off + 4);
      if (!/^[A-Z0-9]{4}$/.test(frameId)) break;
      let frameSize;
      if (versionMajor === 4) {
        frameSize = ((buf[off+4] & 0x7f) << 21) | ((buf[off+5] & 0x7f) << 14) | ((buf[off+6] & 0x7f) << 7) | (buf[off+7] & 0x7f);
      } else {
        frameSize = (buf[off+4] << 24) | (buf[off+5] << 16) | (buf[off+6] << 8) | buf[off+7];
      }
      if (frameSize <= 0 || off + 10 + frameSize > end) break;
      if (frameId === 'APIC') {
        let p = off + 10;
        p += 1; // text encoding
        // MIME (null-terminated ASCII)
        const mimeStart = p;
        while (p < end && buf[p] !== 0) p++;
        const mime = buf.toString('ascii', mimeStart, p) || 'image/jpeg';
        p += 1; // null term
        p += 1; // picture type
        // Description (null-terminated, encoding-dependent — skip until 0x00)
        while (p < end && buf[p] !== 0) p++;
        p += 1;
        const picture = buf.slice(p, off + 10 + frameSize);
        if (picture && picture.length > 100) return { mime, picture };
        return null;
      }
      off += 10 + frameSize;
    }
  } catch {}
  return null;
}

// ─── Reaction tracking ───────────────────────────────────────────────────────

function _trackReaction(origSend, jid, content) {
  try {
    const react = content && content.react;
    if (!react || !react.key || !react.key.id) return;
    const emoji = String(react.text || '');
    const id    = `${react.key.remoteJid || jid}:${react.key.id}`;
    if (LOADING_EMOJIS.has(emoji)) {
      _pendingReactions.set(id, { _origSend: origSend, jid, key: react.key, ts: Date.now() });
    } else if (TERMINAL_EMOJIS.has(emoji)) {
      _pendingReactions.delete(id);
    }
  } catch {}
}

// If this send is a reply (quoted) to a message we ⌛'d, auto-fire ✅.
function _maybeAutoSuccess(origSend, jid, content, options) {
  try {
    if (!content || content.react) return; // don't loop on reaction sends
    const quoted = options && options.quoted;
    const qKey   = quoted && quoted.key;
    if (!qKey || !qKey.id) return;
    const id = `${qKey.remoteJid || jid}:${qKey.id}`;
    if (!_pendingReactions.has(id)) return;
    const e = _pendingReactions.get(id);
    _pendingReactions.delete(id);
    // Fire-and-forget ✅
    setImmediate(() => {
      e._origSend(e.jid, { react: { text: '✅', key: e.key } }).catch(() => {});
    });
  } catch {}
}

// ─── Audio artwork auto-embed ────────────────────────────────────────────────

async function _maybeEmbedAudioArtwork(content) {
  try {
    if (!content.audio) return;
    const already = content.contextInfo && content.contextInfo.externalAdReply
                 && content.contextInfo.externalAdReply.thumbnail;
    if (already) return;
    const buf = _extractBuffer(content.audio);
    if (!buf) return;
    const art = _extractId3Apic(buf);
    if (!art) return;
    // Downscale artwork to a thumbnail for externalAdReply
    let thumb = art.picture;
    const Jimp = _getJimp();
    if (Jimp) {
      try {
        const img = await Jimp.read(art.picture);
        img.cover(300, 300).quality(75);
        thumb = await img.getBufferAsync(Jimp.MIME_JPEG);
      } catch {}
    }
    content.contextInfo = content.contextInfo || {};
    content.contextInfo.externalAdReply = Object.assign({
      showAdAttribution: false,
      renderLargerThumbnail: true,
      title: content.fileName || 'Audio',
      body:  'MIAS Bot',
      mediaType: 2,
      thumbnail: thumb,
    }, content.contextInfo.externalAdReply || {});
  } catch {}
}

// ─── Main wrap ───────────────────────────────────────────────────────────────

function wrapSocket(sock) {
  if (!sock || typeof sock.sendMessage !== 'function') return sock;
  if (sock.__miasWrapped) return sock;
  sock.__miasWrapped = true;

  _installGlobalHandlers();

  const origSend = sock.sendMessage.bind(sock);

  sock.sendMessage = async function patchedSendMessage(jid, content, options) {
    try {
      if (content && typeof content === 'object') {
        // 1. Reaction tracker (register ⌛ / clear on ✅❌)
        if (content.react) _trackReaction(origSend, jid, content);

        // 2. Auto ✅ when replying to a previously ⌛'d message
        _maybeAutoSuccess(origSend, jid, content, options);

        // 3. URL → Buffer auto-fetch (image / video)
        if (content.image) {
          const url = _extractUrl(content.image);
          if (url && !_extractBuffer(content.image)) {
            const fetched = await _fetchToBuffer(url);
            if (fetched) content.image = fetched;
          }
        }
        if (content.video) {
          const url = _extractUrl(content.video);
          if (url && !_extractBuffer(content.video)) {
            const fetched = await _fetchToBuffer(url);
            if (fetched) content.video = fetched;
          }
        }

        // 4. Auto-thumbnails (image / video Buffers)
        if (content.image && !content.jpegThumbnail) {
          const buf = _extractBuffer(content.image);
          if (buf) { const t = await _imageThumb(buf); if (t) content.jpegThumbnail = t; }
        }
        if (content.video && !content.jpegThumbnail) {
          const buf = _extractBuffer(content.video);
          if (buf) { const t = await _videoThumb(buf); if (t) content.jpegThumbnail = t; }
        }

        // 5. Audio ID3 APIC → externalAdReply artwork (Play / ytmp3 fix)
        if (content.audio) await _maybeEmbedAudioArtwork(content);
      }
    } catch (e) {
      console.error('[socketWrapper] pre-send hook error:', e?.message);
    }

    return origSend(jid, content, options);
  };

  return sock;
}

module.exports = {
  wrapSocket,
  _pendingReactions, // exposed for tests / diagnostics
};
