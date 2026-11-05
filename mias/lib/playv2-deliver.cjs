// =========================================================================
//  playv2-deliver.cjs  · drop-in replacement for the inlined _p2Deliver
//  in mias/index.js (was at lines 8918-8978).
//
//  ROOT CAUSE FIX:
//   - audio was wrapped in payload.contextInfo.externalAdReply.thumbnail
//     (mias/index.js:8965), causing WhatsApp to embed a thumbnail and to
//     fail playback in self-chat ("this audio is not available…").
//   - video was sent with payload.jpegThumbnail = thumb (mias/index.js:8933),
//     causing the inline image to exceed WA's 32 KB renderer cap and the
//     video bytes to fail the streaming muxer ("video file wrong…").
//
//  THIS MODULE:
//   1. Sends ALL three audio modes (1 = audio, 2 = document, 3 = ptt) with
//      ZERO contextInfo, ZERO jpegThumbnail, ZERO externalAdReply.
//   2. Sniffs the first 12 bytes and matches MIME + extension exactly so
//      WhatsApp never sees a "dangerous/corrupt" document.
//   3. Uses the streaming worker (mias/lib/download-worker.cjs) so files
//      up to 5 GB can be received without OOM-killing the bot.
// =========================================================================

'use strict';
const fs   = require('fs');
const path = require('path');

const _AUDIO_OK = { mp3: 'audio/mpeg', ogg: 'audio/ogg; codecs=opus',
                    m4a: 'audio/mp4',  aac: 'audio/aac' };
const _VIDEO_OK = { mp4: 'video/mp4',  mov: 'video/quicktime' };

function _safeName(s) {
  return String(s || 'audio')
    .replace(/[^a-zA-Z0-9 _.-]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 60) || 'audio';
}

/**
 * Sniff the first bytes of a Buffer (or path) and return
 * { mime, ext, kind: 'audio'|'video'|'unknown' }.
 * Truth comes from the bytes; we never trust a caller-supplied MIME.
 */
function _p2Sniff(bufOrPath) {
  let head;
  if (Buffer.isBuffer(bufOrPath)) head = bufOrPath.subarray(0, 16);
  else if (typeof bufOrPath === 'string' && fs.existsSync(bufOrPath))
    head = fs.readFileSync(bufOrPath).subarray(0, 16);
  else return { mime: 'application/octet-stream', ext: 'bin', kind: 'unknown' };

  // ---------- AUDIO ----------
  // ID3v2 tag → MP3 container
  if (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) {
    return { mime: 'audio/mpeg', ext: 'mp3', kind: 'audio' };
  }
  // 0xFF 0xFB / 0xFF 0xFA → MP3 frame sync
  if (head[0] === 0xFF && (head[1] & 0xE0) === 0xE0) {
    return { mime: 'audio/mpeg', ext: 'mp3', kind: 'audio' };
  }
  // OggS → Vorbis/Opus container
  if (head[0] === 0x4F && head[1] === 0x67 && head[2] === 0x67 && head[3] === 0x53) {
    return { mime: 'audio/ogg; codecs=opus', ext: 'ogg', kind: 'audio' };
  }
  // 'ftyp' box
  if (head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70) {
    const brand = head.subarray(8, 12).toString('ascii').trim();
    if (brand === 'M4A ' || brand === 'M4B ' || brand === 'mp42')
      return { mime: 'audio/mp4', ext: 'm4a', kind: 'audio' };
    if (brand === 'isom' || brand === 'mp41' || brand === 'mp42' ||
        brand === 'qt  ' || brand === 'avc1')
      return { mime: 'video/mp4', ext: 'mp4', kind: 'video' };
    return { mime: _VIDEO_OK[brand] || 'video/mp4', ext: 'mp4', kind: 'video' };
  }
  return { mime: 'application/octet-stream', ext: 'bin', kind: 'unknown' };
}

/**
 * Internal: send audio. NEVER attaches thumbnail / contextInfo.
 * @param {object} sock
 * @param {string} jid
 * @param {Buffer|string} audio          Buffer or absolute path.
 * @param {string} quotedKey             WA quoted-message key, optional.
 * @param {object} opts                  { ptt:boolean, ext:string, title:string }
 */
async function _p2SendAudioRaw(sock, jid, audio, quotedKey, opts) {
  const sniff = _p2Sniff(audio);
  const isPtt = !!opts?.ptt;
  // PTT can only be sent with the binary Blob array; WhatsApp rejects
  // path-only PTT and bytes-only PTT inside contextInfo.
  const fileName = `${_safeName(opts?.title)}.${sniff.ext}`;
  // PTT requires audio/ogg; codecs=opus, mimetype must be exact.
  const mimetype = isPtt ? 'audio/ogg; codecs=opus' : sniff.mime;
  const payload  = { audio, mimetype, ptt: isPtt, fileName };
  // intentionally NO contextInfo, NO jpegThumbnail, NO externalAdReply
  return sock.sendMessage(jid, payload, quotedKey ? { quoted: quotedKey } : {});
}

async function _p2SendDocumentRaw(sock, jid, doc, quotedKey, opts) {
  const sniff = _p2Sniff(doc);
  const fileName = `${_safeName(opts?.title)}.${sniff.ext}`;
  const payload  = { document: doc, mimetype: sniff.mime, fileName };
  return sock.sendMessage(jid, payload, quotedKey ? { quoted: quotedKey } : {});
}

async function _p2SendVideoRaw(sock, jid, video, quotedKey, opts) {
  const sniff = _p2Sniff(video);
  const fileName = `${_safeName(opts?.title)}.${sniff.ext}`;
  // NO jpegThumbnail — payload is exactly what WA expects for a video file.
  const payload  = {
    video,
    mimetype: sniff.mime,
    fileName,
    caption:  opts?.caption || undefined,
  };
  return sock.sendMessage(jid, payload, quotedKey ? { quoted: quotedKey } : {});
}

/**
 * Public entry point used by mias/index.js (the inlined _p2Deliver is
 * reduced to one line:  const { _p2Deliver } = require("./playv2-deliver.cjs");).
 *
 * @param sock      Baileys socket
 * @param entry     anchor object with .url, .title, .body, .kind(video|audio)
 * @param n         choice 1=audio 2=doc 3=ptt 4=video
 * @param quotedKey optional WA message key for quoted delivery
 */
async function _p2Deliver(sock, entry, n, quotedKey) {
  const jid = entry?.jid || entry?.chatJid;
  if (!jid) throw new Error('_p2Deliver: missing jid');

  // Lazy-load the streaming worker so this module stays cheap to import.
  let worker = null;
  try {
    worker = require('./download-worker.cjs'); /* sibling worker, exists ✓ */
  } catch (_e) {
    worker = null;
  }

  // Select the URL (entry may already have a Buffer/_path).
  async function _materialise() {
    if (Buffer.isBuffer(entry?.buf) && entry.buf.length > 1024) return entry.buf;
    if (entry?.path && fs.existsSync(entry.path))              return entry.path;
    const url = entry?.audioUrl || entry?.videoUrl || entry?.url;
    if (!url) throw new Error('_p2Deliver: no media url/buf');
    if (worker) {
      const r = await worker.fetch({
        url,
        timeoutMs: 120000,
        hintMime:  n === 4 ? 'video/mp4' : 'audio/mpeg',
      });
      if (!r.ok) throw new Error('worker: ' + r.error);
      return r.path;
    }
    // legacy fallback (buffered, capped at 200 MB to prevent OOM; the worker path streams to disk)
    const axios = require('axios');
    const r = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 90000,
      maxContentLength: 200 * 1024 * 1024,   // buffered fallback: cap RAM use at 200 MB
      maxBodyLength:    200 * 1024 * 1024,
    });
    return Buffer.from(r.data);
  }

  const data = await _materialise();
  const baseOpts = { title: entry?.title || 'media' };

  try {
    if (n === 1) {                       // pure audio, no thumb
      await _p2SendAudioRaw(sock, jid, data, quotedKey, { ...baseOpts, ptt: false });
      return { ok: true, kind: 'audio' };
    }
    if (n === 2) {                       // safe-as-document, mime matches ext
      await _p2SendDocumentRaw(sock, jid, data, quotedKey, baseOpts);
      return { ok: true, kind: 'document' };
    }
    if (n === 3) {                       // voice note (PTT)
      await _p2SendAudioRaw(sock, jid, data, quotedKey, { ...baseOpts, ptt: true });
      return { ok: true, kind: 'ptt' };
    }
    if (n === 4) {                       // video, no thumbnail
      await _p2SendVideoRaw(sock, jid, data, quotedKey, { ...baseOpts, caption: entry?.caption });
      return { ok: true, kind: 'video' };
    }
    throw new Error(`_p2Deliver: invalid n=${n}`);
  } finally {
    // If we materialised a temp path through the worker, free disk space.
    if (typeof data === 'string' && data.includes('/p2-dl/')) {
      try { fs.unlinkSync(data); } catch (_e) {}
    }
  }
}

module.exports = { _p2Deliver, _p2Sniff, _p2SendAudioRaw, _p2SendDocumentRaw, _p2SendVideoRaw };
