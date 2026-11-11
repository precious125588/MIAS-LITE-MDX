'use strict';

/**
 * ═══════════════════════════════════════════════════════════════════════
 *  MIAS LITE MDX — Media Enhancement Engine (.4k & .hd)
 * ═══════════════════════════════════════════════════════════════════════
 *  - .4k: 4K Ultra HD enhancement for images, videos & TikTok links
 *  - .hd: WhatsApp HD re-encode pipeline (TikTok 1.3 HD 1080p)
 *  - Reactions: 🌀 while processing, ✅ on success, ❌ on failure
 * ═══════════════════════════════════════════════════════════════════════
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const ffBin = (() => {
  for (const p of ['/bin/ffmpeg', '/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg']) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return 'ffmpeg';
})();

function runFfmpeg(args, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    execFile(ffBin, args, { timeout: timeoutMs }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

// ── Reactions & replies ──────────────────────────────────────────────
async function safeReact(sock, msg, emoji) {
  try {
    if (typeof globalThis.react === 'function') {
      return await globalThis.react(sock, msg, emoji);
    }
  } catch {}
  try {
    const jid = msg?.key?.remoteJid;
    if (sock && jid && msg?.key) {
      return await sock.sendMessage(jid, { react: { text: emoji, key: msg.key } });
    }
  } catch {}
}

async function safeReply(sock, msg, text) {
  try {
    if (typeof globalThis.sendReply === 'function') {
      return await globalThis.sendReply(sock, msg, text);
    }
  } catch {}
  try {
    const jid = msg?.key?.remoteJid;
    if (sock && jid) {
      return await sock.sendMessage(jid, { text }, { quoted: msg });
    }
  } catch {}
}

// ── Unwrapping Baileys messages ──────────────────────────────────────
function unwrapMessage(m) {
  let cur = m;
  for (let i = 0; i < 8 && cur && typeof cur === 'object'; i++) {
    const next = cur.ephemeralMessage?.message
      || cur.viewOnceMessage?.message
      || cur.viewOnceMessageV2?.message
      || cur.viewOnceMessageV2Extension?.message
      || cur.documentWithCaptionMessage?.message
      || cur.editedMessage?.message?.protocolMessage?.editedMessage
      || cur.editedMessage?.message
      || cur.deviceSentMessage?.message
      || null;
    if (!next) break;
    cur = next;
  }
  return cur;
}

function findMediaNode(node) {
  if (!node || typeof node !== 'object') return null;
  const u = unwrapMessage(node);
  if (!u) return null;

  if (u.imageMessage) return { kind: 'image', node: u.imageMessage, dlType: 'image' };
  if (u.videoMessage) return { kind: 'video', node: u.videoMessage, dlType: 'video' };
  if (u.ptvMessage)   return { kind: 'video', node: u.ptvMessage, dlType: 'video' };
  if (u.stickerMessage) return { kind: 'image', node: u.stickerMessage, dlType: 'sticker', isSticker: true };
  if (u.documentMessage) {
    const mime = String(u.documentMessage.mimetype || '').toLowerCase();
    const name = String(u.documentMessage.fileName || '').toLowerCase();
    if (mime.startsWith('image/') || /\.(jpg|jpeg|png|webp|bmp|heic)$/i.test(name)) {
      return { kind: 'image', node: u.documentMessage, dlType: 'document', fileName: name };
    }
    if (mime.startsWith('video/') || /\.(mp4|mkv|mov|webm|avi|3gp)$/i.test(name)) {
      return { kind: 'video', node: u.documentMessage, dlType: 'document', fileName: name };
    }
  }
  return null;
}

function extractMediaFromMsg(msg) {
  const m = unwrapMessage(msg?.message);
  if (!m) return null;

  // 1. Quoted message takes priority
  const ctx = m.extendedTextMessage?.contextInfo
    || m.imageMessage?.contextInfo
    || m.videoMessage?.contextInfo
    || m.documentMessage?.contextInfo
    || m.stickerMessage?.contextInfo
    || Object.values(m).find(v => v && typeof v === 'object' && v.contextInfo)?.contextInfo;

  const q = unwrapMessage(ctx?.quotedMessage);
  if (q) {
    const media = findMediaNode(q);
    if (media) return { ...media, isQuoted: true };
  }

  // 2. Direct message
  const directMedia = findMediaNode(m);
  if (directMedia) return { ...directMedia, isQuoted: false };

  return null;
}

async function downloadMedia(sock, media) {
  let dlFn = null;
  if (typeof globalThis.downloadContentFromMessage === 'function') {
    dlFn = globalThis.downloadContentFromMessage;
  } else {
    try {
      const baileys = require('@whiskeysockets/baileys');
      dlFn = baileys.downloadContentFromMessage;
    } catch {}
  }

  if (dlFn) {
    const stream = await dlFn(media.node, media.dlType);
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks);
  }

  if (sock && typeof sock.downloadMediaMessage === 'function') {
    return await sock.downloadMediaMessage({ message: { [media.dlType + 'Message']: media.node } });
  }

  throw new Error('Media downloader not available');
}

// ── URL extraction and classification ────────────────────────────────
function extractUrl(msg, args = []) {
  if (Array.isArray(args)) {
    for (const a of args) {
      const m = String(a || '').match(/https?:\/\/[^\s]+/i);
      if (m) return m[0];
    }
  } else if (typeof args === 'string') {
    const m = args.match(/https?:\/\/[^\s]+/i);
    if (m) return m[0];
  }

  const m = unwrapMessage(msg?.message);
  const candidates = [
    m?.conversation,
    m?.extendedTextMessage?.text,
    m?.imageMessage?.caption,
    m?.videoMessage?.caption,
    m?.documentMessage?.caption,
  ];
  for (const t of candidates) {
    if (t) {
      const match = String(t).match(/https?:\/\/[^\s]+/i);
      if (match) return match[0];
    }
  }

  const ctx = m?.extendedTextMessage?.contextInfo
    || m?.imageMessage?.contextInfo
    || m?.videoMessage?.contextInfo
    || m?.documentMessage?.contextInfo
    || Object.values(m || {}).find(v => v && typeof v === 'object' && v.contextInfo)?.contextInfo;

  const q = unwrapMessage(ctx?.quotedMessage);
  if (q) {
    const qCandidates = [
      q?.conversation,
      q?.extendedTextMessage?.text,
      q?.imageMessage?.caption,
      q?.videoMessage?.caption,
      q?.documentMessage?.caption,
    ];
    for (const t of qCandidates) {
      if (t) {
        const match = String(t).match(/https?:\/\/[^\s]+/i);
        if (match) return match[0];
      }
    }
  }

  return null;
}

function isTikTokUrl(url) {
  if (!url) return false;
  return /tiktok\.com\/|vm\.tiktok\.com\/|vt\.tiktok\.com\//i.test(url);
}

function isVideoUrl(url) {
  if (!url) return false;
  return /\.(mp4|mov|mkv|webm|avi|3gp)(\?.*)?$/i.test(url);
}

function isImageUrl(url) {
  if (!url) return false;
  return /\.(jpg|jpeg|png|webp|gif|bmp|heic)(\?.*)?$/i.test(url);
}

async function downloadUrlToBuffer(url, timeoutMs = 60000) {
  const axios = require('axios');
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: timeoutMs,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
    maxContentLength: 200 * 1024 * 1024,
  });
  return {
    buffer: Buffer.from(res.data),
    contentType: String(res.headers['content-type'] || '').toLowerCase(),
  };
}

async function downloadUrlToFile(url, destPath, timeoutMs = 120000) {
  const axios = require('axios');
  const writer = fs.createWriteStream(destPath);
  const response = await axios({
    method: 'GET',
    url,
    responseType: 'stream',
    timeout: timeoutMs,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
    maxContentLength: 1024 * 1024 * 1024,
  });
  response.data.pipe(writer);
  await new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
    response.data.on('error', reject);
  });
  const stat = fs.statSync(destPath);
  return {
    path: destPath,
    size: stat.size,
    contentType: String(response.headers['content-type'] || '').toLowerCase(),
  };
}

// ── Image Enhancements (4K & HD) ─────────────────────────────────────
async function upscaleImage4k(buf) {
  const tmpIn = path.join(os.tmpdir(), 'img4k_in_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7) + '.jpg');
  const tmpOut = path.join(os.tmpdir(), 'img4k_out_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7) + '.jpg');
  try {
    fs.writeFileSync(tmpIn, buf);
    const filter = "scale='if(gte(iw,ih),3840,-2)':'if(gte(iw,ih),-2,3840)':flags=lanczos,unsharp=5:5:0.8:3:3:0.4";
    await runFfmpeg(['-y', '-v', 'error', '-i', tmpIn, '-vf', filter, '-q:v', '2', tmpOut], 30000);
    if (fs.existsSync(tmpOut)) {
      const res = fs.readFileSync(tmpOut);
      if (res.length > 100) return res;
    }
  } catch (e) {
    console.warn('[4k image ffmpeg fallback]', e?.message || e);
  } finally {
    try { fs.unlinkSync(tmpIn); } catch {}
    try { fs.unlinkSync(tmpOut); } catch {}
  }

  try {
    const sharp = require('sharp');
    const m = await sharp(buf).metadata();
    return await sharp(buf)
      .resize(Math.min((m.width || 1080) * 2, 4000), Math.min((m.height || 1080) * 2, 4000), { kernel: 'lanczos3', fit: 'inside' })
      .sharpen({ sigma: 1.1 })
      .jpeg({ quality: 95, mozjpeg: true })
      .toBuffer();
  } catch {}

  try {
    const Jimp = require('jimp');
    const j = await Jimp.read(buf);
    return await j.scale(2).quality(95).getBufferAsync(Jimp.MIME_JPEG);
  } catch {}

  return buf;
}

async function enhanceImageHd(buf) {
  const tmpIn = path.join(os.tmpdir(), 'imghd_in_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7) + '.jpg');
  const tmpOut = path.join(os.tmpdir(), 'imghd_out_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7) + '.jpg');
  try {
    fs.writeFileSync(tmpIn, buf);
    const filter = "scale='if(gte(iw,ih),1920,-2)':'if(gte(iw,ih),-2,1080)':flags=lanczos,unsharp=3:3:0.5:3:3:0.2";
    await runFfmpeg(['-y', '-v', 'error', '-i', tmpIn, '-vf', filter, '-q:v', '2', tmpOut], 30000);
    if (fs.existsSync(tmpOut)) {
      const res = fs.readFileSync(tmpOut);
      if (res.length > 100) return res;
    }
  } catch (e) {
    console.warn('[hd image ffmpeg fallback]', e?.message || e);
  } finally {
    try { fs.unlinkSync(tmpIn); } catch {}
    try { fs.unlinkSync(tmpOut); } catch {}
  }

  try {
    const sharp = require('sharp');
    return await sharp(buf)
      .resize(1920, 1080, { fit: 'inside', kernel: 'lanczos3' })
      .sharpen({ sigma: 1.0 })
      .jpeg({ quality: 92, mozjpeg: true })
      .toBuffer();
  } catch {}

  return buf;
}

// ── Destination resolution ───────────────────────────────────────────
function resolveTargetJid(msg) {
  const isStatus = msg?.key?.remoteJid === 'status@broadcast';
  if (isStatus) return msg?.key?.participant || msg?.participant;
  return msg?.key?.remoteJid;
}

// ── Handler: TikTok ──────────────────────────────────────────────────
async function handleTikTok(sock, msg, url, modeType) {
  const jid = resolveTargetJid(msg);
  const ttMod = await import('./tiktok.js');
  const ttd = require('../lib/ttDelivery.cjs');

  const info = await ttMod.fetchTikTokInfo(url);
  const is4k = modeType === '4k';
  const selected = ttMod.selectTikTokUrl(info, is4k ? { quality: '4k', upscale4k: true } : { quality: 'hd' });
  if (!selected || !selected.url) {
    throw new Error('Unable to find a downloadable video stream for this TikTok link');
  }

  const downloaded = await ttd.fetchTikTokToDisk(selected.url);
  try {
    const mode = is4k
      ? { id: '1.8', kind: 'video', quality: '4k', upscale4k: true, document: false }
      : { id: '1.3', kind: 'video', quality: 'hd', upscale4k: false, document: false };

    const caption = is4k ? '✨ *TikTok 4K Ultra HD*' : '✨ *TikTok HD 1080p*';
    const fileName = (is4k ? 'tiktok_4k_' : 'tiktok_hd_') + Date.now() + '.mp4';

    await ttd.deliverTikTokFile({
      sock,
      jid,
      quoted: msg,
      file: downloaded,
      kind: 'video',
      mode,
      caption,
      fileName,
      url,
    });
  } finally {
    if (downloaded && typeof downloaded.cleanup === 'function') {
      try { await downloaded.cleanup(); } catch {}
    }
  }
}

// ── Handler: Video 4K ────────────────────────────────────────────────
async function handleVideo4k(sock, msg, inPath) {
  const jid = resolveTargetJid(msg);
  const tt4k = require('../lib/tt4kVideo.cjs');
  const disk = require('../lib/tiktokDiskDelivery.cjs');

  const res = await tt4k.processVideoTo4k(inPath, { timeoutMs: 180000, copyAudio: true });
  try {
    const caption = '✨ *4K Ultra HD Video*';
    if (res.bytes > disk.WHATSAPP_VIDEO_MAX_BYTES) {
      await disk.sendDocumentFromDisk(sock, jid, res.path, '4k_video_' + Date.now() + '.mp4', caption, msg);
    } else {
      await disk.sendVideoFromDisk(sock, jid, res.path, caption, msg);
    }
  } finally {
    if (res && typeof res.cleanup === 'function') {
      try { await res.cleanup(); } catch {}
    }
  }
}

// ── Handler: Video HD (TikTok 1.3 HD Pipeline) ───────────────────────
async function handleVideoHd(sock, msg, inPath) {
  const jid = resolveTargetJid(msg);
  const ttd = require('../lib/ttDelivery.cjs');
  const disk = require('../lib/tiktokDiskDelivery.cjs');

  const res = await ttd.reencodeHdForWhatsApp(inPath, {
    boost: 1.2,
    sourceQualityBoost: 1.2,
    timeoutMs: 180000,
    maxBytes: disk.WHATSAPP_VIDEO_MAX_BYTES,
  });
  try {
    const caption = '✨ *HD 1080p Video (WhatsApp HD)*';
    if (res.bytes > disk.WHATSAPP_VIDEO_MAX_BYTES) {
      await disk.sendDocumentFromDisk(sock, jid, res.path, 'hd_video_' + Date.now() + '.mp4', caption, msg);
    } else {
      await disk.sendVideoFromDisk(sock, jid, res.path, caption, msg);
    }
  } finally {
    if (res && typeof res.cleanup === 'function') {
      try { await res.cleanup(); } catch {}
    }
  }
}

// ── Handler: Image 4K ────────────────────────────────────────────────
async function handleImage4k(sock, msg, inBuf) {
  const jid = resolveTargetJid(msg);
  const outBuf = await upscaleImage4k(inBuf);
  const maxInlineImg = 15 * 1024 * 1024;
  if (outBuf.length > maxInlineImg) {
    await sock.sendMessage(jid, {
      document: outBuf,
      mimetype: 'image/jpeg',
      fileName: '4k_img_' + Date.now() + '.jpg',
      caption: '✨ *4K Ultra HD Enhanced*',
    }, { quoted: msg });
  } else {
    await sock.sendMessage(jid, {
      image: outBuf,
      mimetype: 'image/jpeg',
      caption: '✨ *4K Ultra HD Enhanced*',
    }, { quoted: msg });
  }
}

// ── Handler: Image HD ────────────────────────────────────────────────
async function handleImageHd(sock, msg, inBuf) {
  const jid = resolveTargetJid(msg);
  const outBuf = await enhanceImageHd(inBuf);
  const maxInlineImg = 15 * 1024 * 1024;
  if (outBuf.length > maxInlineImg) {
    await sock.sendMessage(jid, {
      document: outBuf,
      mimetype: 'image/jpeg',
      fileName: 'hd_img_' + Date.now() + '.jpg',
      caption: '✨ *HD Enhanced*',
    }, { quoted: msg });
  } else {
    await sock.sendMessage(jid, {
      image: outBuf,
      mimetype: 'image/jpeg',
      caption: '✨ *HD Enhanced*',
    }, { quoted: msg });
  }
}

// ── Master Command Dispatcher (.4k & .hd) ────────────────────────────
async function executeMediaEnhance(sock, msg, args = [], modeType = 'hd') {
  await safeReact(sock, msg, '🌀');

  let tempDir = null;
  try {
    const url = extractUrl(msg, args);

    if (url) {
      // 1. TikTok URL
      if (isTikTokUrl(url)) {
        await handleTikTok(sock, msg, url, modeType);
        await safeReact(sock, msg, '✅');
        return true;
      }

      // 2. Direct Video URL
      if (isVideoUrl(url)) {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-dl-vid-'));
        const tmpIn = path.join(tempDir, 'in.mp4');
        await downloadUrlToFile(url, tmpIn);
        if (modeType === '4k') await handleVideo4k(sock, msg, tmpIn);
        else await handleVideoHd(sock, msg, tmpIn);
        await safeReact(sock, msg, '✅');
        return true;
      }

      // 3. Direct Image URL
      if (isImageUrl(url)) {
        const { buffer } = await downloadUrlToBuffer(url);
        if (modeType === '4k') await handleImage4k(sock, msg, buffer);
        else await handleImageHd(sock, msg, buffer);
        await safeReact(sock, msg, '✅');
        return true;
      }

      // 4. Other URL: check content type
      try {
        const { buffer, contentType } = await downloadUrlToBuffer(url, 30000);
        if (contentType.startsWith('video/')) {
          tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-dl-vid-'));
          const tmpIn = path.join(tempDir, 'in.mp4');
          fs.writeFileSync(tmpIn, buffer);
          if (modeType === '4k') await handleVideo4k(sock, msg, tmpIn);
          else await handleVideoHd(sock, msg, tmpIn);
          await safeReact(sock, msg, '✅');
          return true;
        } else if (contentType.startsWith('image/')) {
          if (modeType === '4k') await handleImage4k(sock, msg, buffer);
          else await handleImageHd(sock, msg, buffer);
          await safeReact(sock, msg, '✅');
          return true;
        }
      } catch (dlErr) {
        throw new Error('Unsupported media link. Please provide a valid TikTok, video, or image link.');
      }
    }

    // 5. Media in message (quoted or current)
    const media = extractMediaFromMsg(msg);
    if (media) {
      const buf = await downloadMedia(sock, media);
      if (!buf || buf.length < 32) {
        throw new Error('Could not download media or media is empty');
      }

      if (media.kind === 'image') {
        if (modeType === '4k') await handleImage4k(sock, msg, buf);
        else await handleImageHd(sock, msg, buf);
        await safeReact(sock, msg, '✅');
        return true;
      } else if (media.kind === 'video') {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-dl-vid-'));
        const tmpIn = path.join(tempDir, 'in.mp4');
        fs.writeFileSync(tmpIn, buf);
        if (modeType === '4k') await handleVideo4k(sock, msg, tmpIn);
        else await handleVideoHd(sock, msg, tmpIn);
        await safeReact(sock, msg, '✅');
        return true;
      }
    }

    // 6. No media or link found
    await safeReact(sock, msg, '❌');
    const prefix = globalThis.CONFIG?.PREFIX || '.';
    if (modeType === '4k') {
      await safeReply(sock, msg,
        `*4K Ultra HD Enhancement*\n\n` +
        `Reply to an *image*, *video*, or *sticker* (or send with caption *${prefix}4k*).\n` +
        `You can also provide a *TikTok link* or *video/image link*:\n` +
        `• *${prefix}4k https://vm.tiktok.com/...*\n\n` +
        `• *Images*: Upscaled to 4K (Lanczos + Unsharp)\n` +
        `• *Videos*: Upscaled to 4K Ultra HD\n` +
        `• *TikTok*: Downloaded & enhanced to 4K`
      );
    } else {
      await safeReply(sock, msg,
        `*HD 1080p Re-encode (WhatsApp HD)*\n\n` +
        `Reply to a *video*, *image*, or *sticker* (or send with caption *${prefix}hd*).\n` +
        `You can also provide a *TikTok link* or *video/image link*:\n` +
        `• *${prefix}hd https://vm.tiktok.com/...*\n\n` +
        `• *Videos*: Re-encoded with TikTok 1.3 HD pipeline (1080p + 1.2x boost + faststart)\n` +
        `• *Images*: Enhanced to crisp HD\n` +
        `• *TikTok*: Downloaded & re-encoded with 1.3 HD pipeline`
      );
    }
    return true;
  } catch (err) {
    console.error(`[${modeType} error]`, err?.message || err);
    await safeReact(sock, msg, '❌');
    const label = modeType === '4k' ? '4K Enhancement' : 'HD Re-encode';
    await safeReply(sock, msg, `❌ ${label} failed: ${err?.message || err}`);
    return true;
  } finally {
    if (tempDir) {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    }
  }
}

// ── Global grabber replacement ───────────────────────────────────────
async function robustGrabMedia(sock, msg) {
  try {
    const media = extractMediaFromMsg(msg);
    if (!media) return { kind: null, buf: null };
    const buf = await downloadMedia(sock, media);
    return { kind: media.kind, buf, raw: media.node };
  } catch (e) {
    console.error('[robustGrabMedia error]', e?.message || e);
    return { kind: null, buf: null };
  }
}

globalThis._cmfGrabMedia = robustGrabMedia;
globalThis.__mfGrabMedia = robustGrabMedia;

// ── Install commands into commands map ────────────────────────────────
function installMediaEnhance(ctx = {}) {
  const commands = ctx.commands || globalThis.__MIAS_COMMANDS__ || new Map();
  const cmd = ctx.cmd;

  const handler4k = async (sock, msg, args) => executeMediaEnhance(sock, msg, args, '4k');
  const handlerHd = async (sock, msg, args) => executeMediaEnhance(sock, msg, args, 'hd');

  // Register 4K command & aliases
  const desc4k = "4K Ultra HD enhancement for images, videos & TikTok links (Lanczos & 4K transcode)";
  const descHd = "WhatsApp HD re-encode pipeline (TikTok 1.3 HD 1080p) for videos, images & links";

  for (const name of ['4k', 'uhd', '4kvideo', 'remini4k', 'remini', 'enhance', 'upscale']) {
    commands.set(name, {
      name,
      handler: handler4k,
      desc: desc4k,
      category: 'MEDIA',
    });
  }

  for (const name of ['hd', 'hdvideo', 'hd-video', 'tthd']) {
    commands.set(name, {
      name,
      handler: handlerHd,
      desc: descHd,
      category: 'MEDIA',
    });
  }

  // Remove remux
  commands.delete('remux');
  if (typeof ctx.aliases?.delete === 'function') {
    ctx.aliases.delete('remux');
  }

  if (typeof cmd === 'function') {
    try {
      cmd(['4k', 'uhd', '4kvideo', 'remini4k'], { desc: desc4k, category: 'MEDIA' }, handler4k);
      cmd(['hd', 'hdvideo', 'hd-video', 'tthd'], { desc: descHd, category: 'MEDIA' }, handlerHd);
    } catch {}
  }
}

module.exports = {
  installMediaEnhance,
  executeMediaEnhance,
  robustGrabMedia,
  extractMediaFromMsg,
  extractUrl,
  isTikTokUrl,
  isVideoUrl,
  isImageUrl,
  upscaleImage4k,
  enhanceImageHd,
};
