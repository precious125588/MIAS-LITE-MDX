'use strict';
const LYRICS = require('./lib/lyricsResolver.cjs');
/**
 * mias_bot.cjs — Complete NexRay-powered commands for MIAS MDX bot
 * API Source : https://api.nexray.eu.cc  (369 endpoints)
 * Prefixes   : /  and  ,  (set process.env.PREFIX=/ or PREFIX=, in .env)
 *
 * Categories:
 *   AI(69)  Anime(19)  Berita(10)  Canvas(10)  Downloader(42)
 *   Editor(2)  Ephoto(27)  Fun(2)  Games(8)  Information(10)
 *   Maker(22)  Payment(3)  Primbon(10)  Random(10)  Search(34)
 *   Stalker(15)  Textpro(22)  Tools(57)  Uploader(1)
 *
 * Usage: loaded from mias/index.js as:
 *   require('./mias_bot.cjs')(cmd, CONFIG, sendReply, react, downloadContentFromMessage, axios, nx)
 */

// ═══════════════════════════════════════════════════════════════════════════════
// RESPONSE HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function _txt(r) {
  if (!r) return null;
  // When result is an object with a text field (e.g. Gemini returns {text:"...",session_id:"..."})
  if (r?.result && typeof r.result === 'object' && typeof r.result.text === 'string') return r.result.text;
  return r?.result ?? r?.data?.result ?? r?.data?.message ?? r?.answer ?? r?.text ?? r?.message ?? r?.output ?? null;
}

function _jsonFmt(r) {
  if (!r) return null;
  if (typeof r === 'string') return r;
  const t = _txt(r);
  if (t && typeof t === 'string') return t;
  // Format object as readable key-value text
  const skip = ['status', 'code', 'creator', 'dev'];
  return Object.entries(r)
    .filter(([k, v]) => !skip.includes(k) && v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `*${k}:* ${typeof v === 'object' ? JSON.stringify(v) : v}`)
    .join('\n');
}

async function _media(r, ax) {
  if (!r) return null;
  if (r.type === 'media' && Buffer.isBuffer(r.buffer) && r.buffer.length > 500) return { buf: r.buffer, ct: r.contentType || 'image/jpeg' };
  const url =
    r?.result?.url   ?? r?.result?.image ?? r?.result?.media ??
    (typeof r?.result === 'string' && /^https?:\/\//i.test(r.result) ? r.result : null) ??
    r?.data?.url     ?? r?.data?.image   ??
    r?.url           ?? r?.image         ?? r?.media          ?? null;
  if (url && typeof url === 'string' && url.startsWith('http')) {
    try {
      const resp = await ax.get(url, { responseType: 'arraybuffer', timeout: 60000 });
      const ct   = (resp.headers['content-type'] || 'image/jpeg').split(';')[0].trim();
      return { buf: Buffer.from(resp.data), ct };
    } catch {}
  }
  return null;
}

function _unwrapBaileysMsg(m) {
  let cur = m;
  for (let i = 0; i < 5 && cur; i++) {
    const next =
      cur.ephemeralMessage?.message ||
      cur.viewOnceMessage?.message ||
      cur.viewOnceMessageV2?.message ||
      cur.viewOnceMessageV2Extension?.message ||
      cur.documentWithCaptionMessage?.message;
    if (next) cur = next;
    else break;
  }
  return cur || {};
}

async function _getImgFromMsg(msg, dlFn, sock) {
  if (!msg) return null;

  // 1. Direct smsg helpers (most reliable when smsg is used)
  if (typeof msg.quoted?.download === 'function') {
    try {
      const b = await msg.quoted.download();
      if (Buffer.isBuffer(b) && b.length > 50) return b;
    } catch {}
  }
  if (typeof msg.download === 'function' && (msg.mtype === 'imageMessage' || msg.type === 'image')) {
    try {
      const b = await msg.download();
      if (Buffer.isBuffer(b) && b.length > 50) return b;
    } catch {}
  }

  // 2. Unwrap Baileys wrappers
  const root = msg.message ? _unwrapBaileysMsg(msg.message) : {};

  // Check if current message is an image
  let imgMsg = root.imageMessage || null;

  // Check contextInfo quotedMessage
  if (!imgMsg) {
    for (const key of Object.keys(root)) {
      const quoted = root[key]?.contextInfo?.quotedMessage;
      if (quoted) {
        const unwrappedQuoted = _unwrapBaileysMsg(quoted);
        if (unwrappedQuoted.imageMessage) {
          imgMsg = unwrappedQuoted.imageMessage;
          break;
        }
        if (unwrappedQuoted.documentMessage && unwrappedQuoted.documentMessage.mimetype?.startsWith('image/')) {
          imgMsg = unwrappedQuoted.documentMessage;
          break;
        }
      }
    }
  }

  // Also check msg.quoted?.message directly
  if (!imgMsg && msg.quoted?.message) {
    const q = _unwrapBaileysMsg(msg.quoted.message);
    if (q.imageMessage) imgMsg = q.imageMessage;
    else if (q.documentMessage && q.documentMessage.mimetype?.startsWith('image/')) imgMsg = q.documentMessage;
  }

  if (!imgMsg) return null;

  // 3. Download via dlFn (downloadContentFromMessage)
  if (typeof dlFn === 'function') {
    try {
      const stream = await dlFn(imgMsg, 'image');
      let buf = Buffer.from([]);
      for await (const chunk of stream) buf = Buffer.concat([buf, chunk]);
      if (buf.length > 50) return buf;
    } catch {}
  }

  // 4. Download via sock.downloadMediaMessage
  if (typeof sock?.downloadMediaMessage === 'function') {
    try {
      const buf = await sock.downloadMediaMessage({ message: { imageMessage: imgMsg } });
      if (Buffer.isBuffer(buf) && buf.length > 50) return buf;
    } catch {}
    if (msg.quoted) {
      try {
        const buf = await sock.downloadMediaMessage(msg.quoted);
        if (Buffer.isBuffer(buf) && buf.length > 50) return buf;
      } catch {}
    }
  }

  return null;
}

async function _uploadImageBuf(buf, ax) {
  if (!Buffer.isBuffer(buf) || buf.length < 50) return null;

  // Provider 1: uguu.se via native fetch
  try {
    if (typeof FormData !== 'undefined' && typeof Blob !== 'undefined' && typeof fetch !== 'undefined') {
      const form = new FormData();
      form.append('files[]', new Blob([buf], { type: 'image/jpeg' }), 'image.jpg');
      const r = await fetch('https://uguu.se/upload.php', { method: 'POST', body: form, signal: AbortSignal.timeout(15000) });
      if (r.ok) {
        const j = await r.json();
        const u = j?.files?.[0]?.url;
        if (u && typeof u === 'string' && u.startsWith('http')) return u;
      }
    }
  } catch {}

  // Provider 2: qu.ax via native fetch
  try {
    if (typeof FormData !== 'undefined' && typeof Blob !== 'undefined' && typeof fetch !== 'undefined') {
      const form = new FormData();
      form.append('files[]', new Blob([buf], { type: 'image/jpeg' }), 'image.jpg');
      const r = await fetch('https://qu.ax/upload.php', { method: 'POST', body: form, signal: AbortSignal.timeout(15000) });
      if (r.ok) {
        const j = await r.json();
        const u = j?.files?.[0]?.url;
        if (u && typeof u === 'string' && u.startsWith('http')) return u;
      }
    }
  } catch {}

  // Provider 3: uguu.se via form-data / axios
  try {
    const FormDataPkg = require('form-data');
    const form = new FormDataPkg();
    form.append('files[]', buf, { filename: 'image.jpg', contentType: 'image/jpeg' });
    const r = await (ax || require('axios')).post('https://uguu.se/upload.php', form, {
      headers: form.getHeaders(),
      timeout: 15000
    });
    const u = r?.data?.files?.[0]?.url;
    if (u && typeof u === 'string' && u.startsWith('http')) return u;
  } catch {}

  // Provider 4: catbox via form-data / axios
  try {
    const FormDataPkg = require('form-data');
    const form = new FormDataPkg();
    form.append('reqtype', 'fileupload');
    form.append('fileToUpload', buf, { filename: 'image.jpg', contentType: 'image/jpeg' });
    const r = await (ax || require('axios')).post('https://catbox.moe/user/api.php', form, {
      headers: { ...form.getHeaders(), 'User-Agent': 'Mozilla/5.0' },
      timeout: 15000
    });
    if (typeof r?.data === 'string' && r.data.startsWith('http')) return r.data.trim();
  } catch {}

  return null;
}

async function _resolveImgMedia(sock, msg, args, dlFn, ax, nx) {
  // 1. Direct HTTP URL in args
  const argUrl = (args || []).find(a => typeof a === 'string' && /^https?:\/\//i.test(a.trim()));
  if (argUrl) return { url: argUrl.trim(), buf: null };

  // 2. Replied or attached image
  let buf = null;
  try {
    buf = await _getImgFromMsg(msg, dlFn, sock);
  } catch {}

  if (buf && buf.length > 50) {
    // Upload buffer to get a public URL for API endpoints
    const cdnUrl = await _uploadImageBuf(buf, ax);
    if (cdnUrl) return { url: cdnUrl, buf };

    // Fallback: nx.uploader
    try {
      if (nx?.uploader?.upload) {
        const up = await nx.uploader.upload({ file: buf });
        const u = up?.result?.url || up?.data?.url || up?.url;
        if (u && typeof u === 'string' && /^https?:\/\//i.test(u)) return { url: u, buf };
      }
    } catch {}

    return { url: null, buf };
  }

  // 3. Quoted text containing a URL
  try {
    const q = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    const qTxt = q?.conversation || q?.extendedTextMessage?.text || msg.quoted?.text || '';
    const m = qTxt.match(/https?:\/\/\S+/i);
    if (m) return { url: m[0], buf: null };
  } catch {}

  return { url: null, buf: null };
}

async function _sendImg(sock, msg, buf, caption) {
  await sock.sendMessage(msg.key.remoteJid, { image: buf, caption }, { quoted: msg });
}

async function _sendAudio(sock, msg, buf, ptt = false) {
  await sock.sendMessage(msg.key.remoteJid, { audio: buf, mimetype: 'audio/mpeg', ptt }, { quoted: msg });
}

async function _sendVideo(sock, msg, buf, caption) {
  await sock.sendMessage(msg.key.remoteJid, { video: buf, caption }, { quoted: msg });
}

async function _sendDoc(sock, msg, buf, filename, mimetype) {
  await sock.sendMessage(msg.key.remoteJid, { document: buf, mimetype, fileName: filename }, { quoted: msg });
}

async function _convertMediaToWebpSticker(buf, filename = 'sticker.webp') {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return buf;
  if (typeof filename === 'string' && filename.toLowerCase().endsWith('.webp')) return buf;

  // 1. Try sharp
  try {
    let sharp;
    try { sharp = require('sharp'); } catch {}
    if (sharp) {
      return await sharp(buf)
        .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .webp({ quality: 80 })
        .toBuffer();
    }
  } catch {}

  // 2. Try ffmpeg
  try {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    const { execFile } = require('child_process');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-'));
    const inExt = typeof filename === 'string' && filename.toLowerCase().endsWith('.tgs') ? 'tgs' : (typeof filename === 'string' && filename.toLowerCase().endsWith('.webm') ? 'webm' : 'png');
    const inPath = path.join(tmpDir, 'in.' + inExt);
    const outPath = path.join(tmpDir, 'out.webp');
    fs.writeFileSync(inPath, buf);

    await new Promise((resolve, reject) => {
      execFile('ffmpeg', [
        '-y', '-i', inPath,
        '-vf', 'scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000',
        '-c:v', 'libwebp', '-lossless', '0', '-q:v', '70', '-loop', '0',
        outPath
      ], { timeout: 30000 }, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    if (fs.existsSync(outPath)) {
      const out = fs.readFileSync(outPath);
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      return out;
    }
  } catch {}

  return buf;
}

// Generic handler for text AI cmds
function _textAI(nx_fn, name, emoji) {
  return async (sock, msg, args, P) => {
    _handle(sock, msg);
    if (!args.length) return _noArgs(sock, msg, name.toLowerCase().replace(/ /g, '') + ' <text>');
    await _textAICore(sock, msg, args.join(' '), nx_fn, name, emoji, sendReply);
  };
}

async function _textAICore(sock, msg, query, nx_fn, label, emoji, _srFn) {
  const _rep = typeof _srFn === 'function' ? (t) => _srFn(sock, msg, t) : (t) => msg._sendReply ? msg._sendReply(t) : Promise.resolve();
  try {
    const r  = await nx_fn({ text: query });
    const t  = _jsonFmt(r);
    if (!t) throw new Error('Empty response');
    await _rep(`${emoji} *${label}*\n\n${t}`);
  } catch (e) {
    await _rep(`❌ *${label} Error:* ${e.message}`);
    throw e;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN EXPORT
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = function registerNexrayCmds(cmd, CONFIG, sendReply, react, downloadContentFromMessage, axios, nx) {
  if (!nx) {
    console.error('[mias_bot] ❌ nx is null — NexRay wrapper not loaded. Commands skipped.');
    return;
  }

  const _origCmd = cmd;
  cmd = function(names, opts, handler) {
    const list = [].concat(names || []).map(n => String(n || '').trim().toLowerCase()).filter(Boolean);
    if (!list.length) return;
    const cat = String(opts?.category || '').toLowerCase();
    if (cat.includes('anime') || cat.includes('random') || cat.includes('primbon') || cat.includes('canvas')) return;
    if (list.some(n =>
      n.startsWith('canvas-') ||
      n.startsWith('ramalan') ||
      n.startsWith('random') ||
      n.startsWith('dc') ||
      ['wasted', 'editor-wasted', 'ewasted', 'musiccard', 'music-card', 'spotifycard', 'mcard', 'nomer-hoki', 'nomerhoki', 'arti-nama', 'artinama', 'weton', 'fb-dl', 'fbdl', 'facebook-dl'].includes(n)
    )) return;
    return _origCmd(names, opts, handler);
  };

  const P = CONFIG.PREFIX || '/';

  // Convenience wrapper so handlers get clean sendReply bound to sock+msg
  function _handle(sock, msg) {
    msg._sendReply = (text) => sendReply(sock, msg, text);
  }

  function _noArgs(sock, msg, usage) {
    return sendReply(sock, msg, `📌 *Usage:* ${P}${usage}\n_Also works with ,${usage.split(' ')[0]}_`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ██████╗  AI  — 69 endpoints
  // ═══════════════════════════════════════════════════════════════════════════

  cmd(['alisia'], { desc: 'Chat with Alisia AI', category: 'AI' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'alisia <text>');
    await react(sock, msg, '🤖');
    try {
      const r = await nx.ai.alisia({ text: args.join(' ') });
      const t = _jsonFmt(r); if (!t) throw new Error('No response');
      await sendReply(sock, msg, `🤖 *Alisia AI*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['andisearch', 'andi'], { desc: 'Andi AI web search', category: 'AI' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'andisearch <query>');
    await react(sock, msg, '🔍');
    try {
      const r = await nx.ai.andisearch({ text: args.join(' ') });
      const t = _jsonFmt(r); if (!t) throw new Error('No response');
      await sendReply(sock, msg, `🔍 *AndiSearch AI*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['bypass-ai', 'aibypass'], { desc: 'Bypass AI detection / humanize text', category: 'AI' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'bypass-ai <text>');
    await react(sock, msg, '🛡️');
    try {
      const r = await nx.ai.bypass({ text: args.join(' ') });
      const t = _jsonFmt(r); if (!t) throw new Error('No response');
      await sendReply(sock, msg, `🛡️ *AI Bypass / Humanizer*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['chatgpt', 'gpt'], { desc: 'Chat with ChatGPT', category: 'AI' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'chatgpt <question>');
    await react(sock, msg, '🤖');
    try {
      const r = await nx.ai.chatgpt({ text: args.join(' ') });
      const t = _jsonFmt(r); if (!t) throw new Error('No response');
      await sendReply(sock, msg, `🤖 *ChatGPT*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['claude'], { desc: 'Chat with Claude AI', category: 'AI' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'claude <text>');
    await react(sock, msg, '🧠');
    try {
      const r = await nx.ai.claude({ text: args.join(' ') });
      const t = _jsonFmt(r); if (!t) throw new Error('No response');
      await sendReply(sock, msg, `🧠 *Claude AI*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['copilot'], { desc: 'Chat with Microsoft Copilot', category: 'AI' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'copilot <text>');
    await react(sock, msg, '🤖');
    try {
      const r = await nx.ai.copilot({ text: args.join(' ') });
      const t = _jsonFmt(r); if (!t) throw new Error('No response');
      await sendReply(sock, msg, `🤖 *Copilot AI*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['deepimg'], { desc: 'Generate image with DeepImg AI', category: 'AI' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'deepimg <prompt>');
    await react(sock, msg, '🎨');
    try {
      const r   = await nx.ai.deepimg({ prompt: args.join(' ') });
      const m   = await _media(r, axios);
      if (m) { await _sendImg(sock, msg, m.buf, `🎨 *DeepImg AI*\nPrompt: ${args.join(' ')}`); await react(sock, msg, '✅'); }
      else { const t = _jsonFmt(r); await sendReply(sock, msg, `🎨 *DeepImg:* ${t || 'No image generated'}`); }
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['deepsearch'], { desc: 'Deep search with AI', category: 'AI' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'deepsearch <query>');
    await react(sock, msg, '🔎');
    try {
      const r = await nx.ai.deepsearch({ text: args.join(' ') });
      const t = _jsonFmt(r); if (!t) throw new Error('No response');
      await sendReply(sock, msg, `🔎 *DeepSearch AI*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['deepseek'], { desc: 'Chat with DeepSeek AI', category: 'AI' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'deepseek <text>');
    await react(sock, msg, '🤖');
    try {
      const r = await nx.ai.deepseek({ text: args.join(' ') });
      const t = _jsonFmt(r); if (!t) throw new Error('No response');
      await sendReply(sock, msg, `🤖 *DeepSeek AI*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['dgaf'], { desc: 'Chat with Dgaf AI', category: 'AI' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'dgaf <text>');
    await react(sock, msg, '🤖');
    try {
      const r = await nx.ai.dgaf({ text: args.join(' ') });
      const t = _jsonFmt(r); if (!t) throw new Error('No response');
      await sendReply(sock, msg, `🤖 *Dgaf AI*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['dolphin'], { desc: 'Chat with Dolphin AI', category: 'AI' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'dolphin <text>');
    await react(sock, msg, '🐬');
    try {
      const r = await nx.ai.dolphin({ text: args.join(' ') });
      const t = _jsonFmt(r); if (!t) throw new Error('No response');
      await sendReply(sock, msg, `🐬 *Dolphin AI*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['dracintts', 'dracin-tts'], { desc: 'Dracin Text-to-Speech', category: 'AI' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'dracintts <text>');
    await react(sock, msg, '🎙️');
    try {
      const r = await nx.ai.dracinTts({ text: args.join(' ') });
      const m = await _media(r, axios);
      if (m) { await _sendAudio(sock, msg, m.buf); await react(sock, msg, '✅'); }
      else throw new Error('No audio returned');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['dreamanalyze', 'dream'], { desc: 'Analyze dream with AI', category: 'AI' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'dreamanalyze <describe your dream>');
    await react(sock, msg, '🌙');
    try {
      const r = await nx.ai.dreamanalyze({ text: args.join(' ') });
      const t = _jsonFmt(r); if (!t) throw new Error('No response');
      await sendReply(sock, msg, `🌙 *Dream Analysis*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['duck', 'duckai'], { desc: 'Chat with Duck AI', category: 'AI' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'duck <text>');
    await react(sock, msg, '🦆');
    try {
      const r = await nx.ai.duck({ text: args.join(' ') });
      const t = _jsonFmt(r); if (!t) throw new Error('No response');
      await sendReply(sock, msg, `🦆 *Duck AI*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['epsilon'], { desc: 'Academic search with Epsilon AI', category: 'AI' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'epsilon <query>');
    await react(sock, msg, '📚');
    try {
      const r = await nx.ai.epsilon({ text: args.join(' ') });
      const t = _jsonFmt(r); if (!t) throw new Error('No response');
      await sendReply(sock, msg, `📚 *Epsilon AI*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['felo'], { desc: 'Chat with Felo AI', category: 'AI' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'felo <text>');
    await react(sock, msg, '🤖');
    try {
      const r = await nx.ai.felo({ text: args.join(' ') });
      const t = _jsonFmt(r); if (!t) throw new Error('No response');
      await sendReply(sock, msg, `🤖 *Felo AI*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['flux', 'fluxai'], { desc: 'Generate image with Flux AI v1', category: 'AI' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'flux <prompt>');
    await react(sock, msg, '🎨');
    try {
      const r = await nx.ai.fluxV1({ prompt: args.join(' ') });
      const m = await _media(r, axios);
      if (m) { await _sendImg(sock, msg, m.buf, `🎨 *Flux AI*\nPrompt: ${args.join(' ')}`); await react(sock, msg, '✅'); }
      else { const t = _jsonFmt(r); await sendReply(sock, msg, `🎨 *Flux:* ${t || 'No image generated'}`); }
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['geminitts', 'gemini-tts'], { desc: 'Gemini Text-to-Speech', category: 'AI' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'geminitts <text>');
    await react(sock, msg, '🎙️');
    try {
      const r = await nx.ai.geminiTts({ text: args.join(' ') });
      const m = await _media(r, axios);
      if (m) { await _sendAudio(sock, msg, m.buf); await react(sock, msg, '✅'); }
      else throw new Error('No audio returned');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['gemini'], { desc: 'Chat with Google Gemini', category: 'AI' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'gemini <text>');
    await react(sock, msg, '💎');
    try {
      const r = await nx.ai.gemini({ text: args.join(' ') });
      const t = _jsonFmt(r); if (!t) throw new Error('No response');
      await sendReply(sock, msg, `💎 *Google Gemini*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['gitagpt', 'gita'], { desc: 'Bhagavad Gita AI Q&A', category: 'AI' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'gitagpt <question>');
    await react(sock, msg, '📖');
    try {
      const r = await nx.ai.gitagpt({ text: args.join(' ') });
      const t = _jsonFmt(r); if (!t) throw new Error('No response');
      await sendReply(sock, msg, `📖 *GitaGPT*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['glm'], { desc: 'Chat with GLM AI', category: 'AI' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'glm <text>');
    await react(sock, msg, '🤖');
    try {
      const r = await nx.ai.glm({ text: args.join(' ') });
      const t = _jsonFmt(r); if (!t) throw new Error('No response');
      await sendReply(sock, msg, `🤖 *GLM AI*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['gpt35', 'gpt3'], { desc: 'Chat with GPT-3.5 Turbo', category: 'AI' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'gpt35 <text>');
    await react(sock, msg, '🤖');
    try {
      const r = await nx.ai.gpt35({ text: args.join(' ') });
      const t = _jsonFmt(r); if (!t) throw new Error('No response');
      await sendReply(sock, msg, `🤖 *GPT-3.5 Turbo*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['gptimage', 'editimg'], { desc: 'Edit image with GPT Vision (reply to an image)', category: 'AI' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'gptimage <prompt> (reply to an image)');
    await react(sock, msg, '🎨');
    try {
      const imgBuf = await _getImgFromMsg(msg, downloadContentFromMessage);
      if (!imgBuf) return sendReply(sock, msg, '⚠️ Please reply to an image with your prompt!');
      const r = await nx.ai.gptimage({ image: imgBuf, param: args.join(' ') });
      const m = await _media(r, axios);
      if (m) { await _sendImg(sock, msg, m.buf, `🎨 *GPT Image Edit*`); await react(sock, msg, '✅'); }
      else throw new Error('No image returned');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['grammarcheck', 'grammar'], { desc: 'Check and fix grammar', category: 'AI' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'grammarcheck <text>');
    await react(sock, msg, '✏️');
    try {
      const r = await nx.ai.grammarcheck({ text: args.join(' ') });
      const t = _jsonFmt(r); if (!t) throw new Error('No response');
      await sendReply(sock, msg, `✏️ *Grammar Check*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['hammer', 'hammerai'], { desc: 'Chat with Hammer AI', category: 'AI' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'hammer <text>');
    await react(sock, msg, '🔨');
    try {
      const r = await nx.ai.hammer({ text: args.join(' ') });
      const t = _jsonFmt(r); if (!t) throw new Error('No response');
      await sendReply(sock, msg, `🔨 *Hammer AI*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['heck'], { desc: 'Chat with Heck AI', category: 'AI' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'heck <text>');
    await react(sock, msg, '🤖');
    try {
      const r = await nx.ai.heck({ text: args.join(' ') });
      const t = _jsonFmt(r); if (!t) throw new Error('No response');
      await sendReply(sock, msg, `🤖 *Heck AI*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['ideogram'], { desc: 'Generate image with Ideogram AI', category: 'AI' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'ideogram <prompt>');
    await react(sock, msg, '🎨');
    try {
      const r = await nx.ai.ideogram({ prompt: args.join(' ') });
      const m = await _media(r, axios);
      if (m) { await _sendImg(sock, msg, m.buf, `🎨 *Ideogram AI*\nPrompt: ${args.join(' ')}`); await react(sock, msg, '✅'); }
      else { const t = _jsonFmt(r); await sendReply(sock, msg, `🎨 *Ideogram:* ${t || 'No image generated'}`); }
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['image2prompt', 'img2prompt'], { desc: 'Generate prompt from image URL', category: 'AI' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'image2prompt <image-url>');
    await react(sock, msg, '🔍');
    try {
      const r = await nx.ai.image2prompt({ url: args[0] });
      const t = _jsonFmt(r); if (!t) throw new Error('No response');
      await sendReply(sock, msg, `🔍 *Image to Prompt*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['islamcity'], { desc: 'Islamic Q&A with IslamCity AI', category: 'AI' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'islamcity <question>');
    await react(sock, msg, '☪️');
    try {
      const r = await nx.ai.islamcity({ text: args.join(' ') });
      const t = _jsonFmt(r); if (!t) throw new Error('No response');
      await sendReply(sock, msg, `☪️ *IslamCity AI*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['islamicai', 'islamic-ai'], { desc: 'Islamic AI chat', category: 'AI' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'islamicai <question>');
    await react(sock, msg, '☪️');
    try {
      const r = await nx.ai.islamic({ text: args.join(' ') });
      const t = _jsonFmt(r); if (!t) throw new Error('No response');
      await sendReply(sock, msg, `☪️ *Islamic AI*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['jadve'], { desc: 'Chat with Jadve AI', category: 'AI' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'jadve <text>');
    await react(sock, msg, '🤖');
    try {
      const r = await nx.ai.jadve({ text: args.join(' ') });
      const t = _jsonFmt(r); if (!t) throw new Error('No response');
      await sendReply(sock, msg, `🤖 *Jadve AI*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['jeeves'], { desc: 'Chat with Jeeves AI', category: 'AI' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'jeeves <text>');
    await react(sock, msg, '🧐');
    try {
      const r = await nx.ai.jeeves({ text: args.join(' ') });
      const t = _jsonFmt(r); if (!t) throw new Error('No response');
      await sendReply(sock, msg, `🧐 *Jeeves AI*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['kimi'], { desc: 'Chat with Kimi AI', category: 'AI' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'kimi <text>');
    await react(sock, msg, '🤖');
    try {
      const r = await nx.ai.kimi({ text: args.join(' ') });
      const t = _jsonFmt(r); if (!t) throw new Error('No response');
      await sendReply(sock, msg, `🤖 *Kimi AI*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['llamacoder', 'llama'], { desc: 'Chat with LlamaCoder AI', category: 'AI' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'llamacoder <text>');
    await react(sock, msg, '🦙');
    try {
      const r = await nx.ai.llamacoder({ text: args.join(' ') });
      const t = _jsonFmt(r); if (!t) throw new Error('No response');
      await sendReply(sock, msg, `🦙 *LlamaCoder AI*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['lumin'], { desc: 'Chat with Lumin AI', category: 'AI' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'lumin <text>');
    await react(sock, msg, '💡');
    try {
      const r = await nx.ai.lumin({ text: args.join(' ') });
      const t = _jsonFmt(r); if (!t) throw new Error('No response');
      await sendReply(sock, msg, `💡 *Lumin AI*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['magicstudio'], { desc: 'Generate image with MagicStudio AI', category: 'AI' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'magicstudio <prompt>');
    await react(sock, msg, '🪄');
    try {
      const r = await nx.ai.magicstudio({ prompt: args.join(' ') });
      const m = await _media(r, axios);
      if (m) { await _sendImg(sock, msg, m.buf, `🪄 *MagicStudio AI*\nPrompt: ${args.join(' ')}`); await react(sock, msg, '✅'); }
      else { const t = _jsonFmt(r); await sendReply(sock, msg, `🪄 *MagicStudio:* ${t || 'No image generated'}`); }
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['mathgpt', 'math'], { desc: 'Solve math with MathGPT AI', category: 'AI' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'mathgpt <math problem>');
    await react(sock, msg, '🧮');
    try {
      const r = await nx.ai.mathgpt({ text: args.join(' ') });
      const t = _jsonFmt(r); if (!t) throw new Error('No response');
      await sendReply(sock, msg, `🧮 *MathGPT*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['monica'], { desc: 'Chat with Monica AI', category: 'AI' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'monica <text>');
    await react(sock, msg, '🤖');
    try {
      const r = await nx.ai.monica({ text: args.join(' ') });
      const t = _jsonFmt(r); if (!t) throw new Error('No response');
      await sendReply(sock, msg, `🤖 *Monica AI*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['morphic'], { desc: 'Chat with Morphic AI', category: 'AI' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'morphic <text>');
    await react(sock, msg, '🔮');
    try {
      const r = await nx.ai.morphic({ text: args.join(' ') });
      const t = _jsonFmt(r); if (!t) throw new Error('No response');
      await sendReply(sock, msg, `🔮 *Morphic AI*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['muslim', 'muslimbot'], { desc: 'Islamic AI chat (Muslim)', category: 'AI' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'muslim <question>');
    await react(sock, msg, '☪️');
    try {
      const r = await nx.ai.muslim({ text: args.join(' ') });
      const t = _jsonFmt(r); if (!t) throw new Error('No response');
      await sendReply(sock, msg, `☪️ *Muslim AI*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['nanobanana', 'imgprompt'], { desc: 'Modify image with prompt (reply to image)', category: 'AI' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'nanobanana <prompt> (reply to an image)');
    await react(sock, msg, '🎨');
    try {
      const imgBuf = await _getImgFromMsg(msg, downloadContentFromMessage);
      if (!imgBuf) return sendReply(sock, msg, '⚠️ Please reply to an image with your prompt!');
      const r = await nx.ai.nanobanana({ image: imgBuf, param: args.join(' ') });
      const m = await _media(r, axios);
      if (m) { await _sendImg(sock, msg, m.buf, `🎨 *Nanobanana AI Edit*`); await react(sock, msg, '✅'); }
      else throw new Error('No image returned');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['natalie', 'natalieai'], { desc: 'Chat with Natalie AI', category: 'AI' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'natalie <text>');
    await react(sock, msg, '🤖');
    try {
      const r = await nx.ai.natalie({ text: args.join(' ') });
      const t = _jsonFmt(r); if (!t) throw new Error('No response');
      await sendReply(sock, msg, `🤖 *Natalie AI*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['nexrayai', 'nx-ai'], { desc: 'Chat with MIAS AI', category: 'AI' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'nexrayai <text>');
    await react(sock, msg, '⚡');
    try {
      const r = await nx.ai.nexray({ text: args.join(' ') });
      const t = _jsonFmt(r); if (!t) throw new Error('No response');
      await sendReply(sock, msg, `⚡ *MIAS AI*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['nowtech'], { desc: 'Chat with Nowtech AI', category: 'AI' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'nowtech <text>');
    await react(sock, msg, '🤖');
    try {
      const r = await nx.ai.nowtech({ text: args.join(' ') });
      const t = _jsonFmt(r); if (!t) throw new Error('No response');
      await sendReply(sock, msg, `🤖 *Nowtech AI*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['openai', 'openaibot'], { desc: 'Chat with OpenAI', category: 'AI' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'openai <text>');
    await react(sock, msg, '🤖');
    try {
      const r = await nx.ai.openai({ text: args.join(' ') });
      const t = _jsonFmt(r); if (!t) throw new Error('No response');
      await sendReply(sock, msg, `🤖 *OpenAI*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['overchat'], { desc: 'Chat with Overchat AI', category: 'AI' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'overchat <text>');
    await react(sock, msg, '🤖');
    try {
      const r = await nx.ai.overchat({ text: args.join(' ') });
      const t = _jsonFmt(r); if (!t) throw new Error('No response');
      await sendReply(sock, msg, `🤖 *Overchat AI*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['perplexity'], { desc: 'Chat with Perplexity AI', category: 'AI' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'perplexity <query>');
    await react(sock, msg, '🔮');
    try {
      const r = await nx.ai.perplexity({ text: args.join(' ') });
      const t = _jsonFmt(r); if (!t) throw new Error('No response');
      await sendReply(sock, msg, `🔮 *Perplexity AI*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['powerbrain'], { desc: 'Chat with PowerBrain AI', category: 'AI' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'powerbrain <text>');
    await react(sock, msg, '🧠');
    try {
      const r = await nx.ai.powerbrain({ text: args.join(' ') });
      const t = _jsonFmt(r); if (!t) throw new Error('No response');
      await sendReply(sock, msg, `🧠 *PowerBrain AI*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['publicai', 'pub-ai'], { desc: 'Chat with Public AI', category: 'AI' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'publicai <text>');
    await react(sock, msg, '🌐');
    try {
      const r = await nx.ai.public({ text: args.join(' ') });
      const t = _jsonFmt(r); if (!t) throw new Error('No response');
      await sendReply(sock, msg, `🌐 *Public AI*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['quillbot', 'paraphrase'], { desc: 'Paraphrase text with QuillBot AI', category: 'AI' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'quillbot <text>');
    await react(sock, msg, '✏️');
    try {
      const r = await nx.ai.quillbot({ text: args.join(' ') });
      const t = _jsonFmt(r); if (!t) throw new Error('No response');
      await sendReply(sock, msg, `✏️ *QuillBot AI*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['riple'], { desc: 'Chat with Riple AI', category: 'AI' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'riple <text>');
    await react(sock, msg, '🤖');
    try {
      const r = await nx.ai.riple({ text: args.join(' ') });
      const t = _jsonFmt(r); if (!t) throw new Error('No response');
      await sendReply(sock, msg, `🤖 *Riple AI*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['schoolhub', 'school'], { desc: 'Chat with SchoolHub AI', category: 'AI' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'schoolhub <question>');
    await react(sock, msg, '🏫');
    try {
      const r = await nx.ai.schoolhub({ text: args.join(' ') });
      const t = _jsonFmt(r); if (!t) throw new Error('No response');
      await sendReply(sock, msg, `🏫 *SchoolHub AI*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['screnapp'], { desc: 'Chat with Screnapp AI', category: 'AI' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'screnapp <text>');
    await react(sock, msg, '🤖');
    try {
      const r = await nx.ai.screnapp({ text: args.join(' ') });
      const t = _jsonFmt(r); if (!t) throw new Error('No response');
      await sendReply(sock, msg, `🤖 *Screnapp AI*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['simisimi', 'simi'], { desc: 'Chat with Simi Simi', category: 'AI' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'simisimi <text>');
    await react(sock, msg, '💬');
    try {
      const r = await nx.ai.simisimi({ text: args.join(' ') });
      const t = _jsonFmt(r); if (!t) throw new Error('No response');
      await sendReply(sock, msg, `💬 *Simi Simi*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['skole'], { desc: 'Chat with Skole AI', category: 'AI' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'skole <text>');
    await react(sock, msg, '🤖');
    try {
      const r = await nx.ai.skole({ text: args.join(' ') });
      const t = _jsonFmt(r); if (!t) throw new Error('No response');
      await sendReply(sock, msg, `🤖 *Skole AI*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['sologo'], { desc: 'Generate logo with AI', category: 'AI' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'sologo <prompt>');
    await react(sock, msg, '🎨');
    try {
      const r = await nx.ai.sologo({ prompt: args.join(' ') });
      const m = await _media(r, axios);
      if (m) { await _sendImg(sock, msg, m.buf, `🎨 *Sologo AI*\nPrompt: ${args.join(' ')}`); await react(sock, msg, '✅'); }
      else { const t = _jsonFmt(r); await sendReply(sock, msg, `🎨 *Sologo:* ${t || 'No image generated'}`); }
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['story-ai', 'aistory'], { desc: 'Generate a story with AI', category: 'AI' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'story-ai <topic>');
    await react(sock, msg, '📖');
    try {
      const r = await nx.ai.story({ text: args.join(' ') });
      const t = _jsonFmt(r); if (!t) throw new Error('No response');
      await sendReply(sock, msg, `📖 *AI Story*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['suno', 'aimusic'], { desc: 'Generate music with Suno AI', category: 'AI' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'suno <prompt>');
    await react(sock, msg, '🎵');
    try {
      const r = await nx.ai.suno({ text: args.join(' ') });
      const m = await _media(r, axios);
      if (m && (m.ct.includes('audio') || m.ct.includes('mp'))) {
        await _sendAudio(sock, msg, m.buf); await react(sock, msg, '✅');
      } else {
        const t = _jsonFmt(r); await sendReply(sock, msg, `🎵 *Suno AI*\n\n${t || 'No audio generated'}`);
      }
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['text2image', 'txt2img'], { desc: 'Generate image from text', category: 'AI' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'text2image <prompt>');
    await react(sock, msg, '🎨');
    try {
      const r = await nx.ai.text2image({ prompt: args.join(' ') });
      const m = await _media(r, axios);
      if (m) { await _sendImg(sock, msg, m.buf, `🎨 *Text to Image*\nPrompt: ${args.join(' ')}`); await react(sock, msg, '✅'); }
      else { const t = _jsonFmt(r); await sendReply(sock, msg, `🎨 *Text2Image:* ${t || 'No image generated'}`); }
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['turbochat', 'turbo'], { desc: 'Chat with TurboChat AI', category: 'AI' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'turbochat <text>');
    await react(sock, msg, '⚡');
    try {
      const r = await nx.ai.turbochat({ text: args.join(' ') });
      const t = _jsonFmt(r); if (!t) throw new Error('No response');
      await sendReply(sock, msg, `⚡ *TurboChat AI*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['turboseek'], { desc: 'Chat with TurboSeek AI', category: 'AI' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'turboseek <query>');
    await react(sock, msg, '🔎');
    try {
      const r = await nx.ai.turboseek({ text: args.join(' ') });
      const t = _jsonFmt(r); if (!t) throw new Error('No response');
      await sendReply(sock, msg, `🔎 *TurboSeek AI*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['venice'], { desc: 'Chat with Venice AI', category: 'AI' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'venice <text>');
    await react(sock, msg, '🤖');
    try {
      const r = await nx.ai.venice({ text: args.join(' ') });
      const t = _jsonFmt(r); if (!t) throw new Error('No response');
      await sendReply(sock, msg, `🤖 *Venice AI*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['veo2'], { desc: 'Generate video with Veo2 AI', category: 'AI' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'veo2 <prompt>');
    await react(sock, msg, '🎬');
    try {
      const r = await nx.ai.veo2({ prompt: args.join(' ') });
      const m = await _media(r, axios);
      if (m && m.ct.includes('video')) { await _sendVideo(sock, msg, m.buf, `🎬 *Veo2 AI*`); await react(sock, msg, '✅'); }
      else if (m) { await _sendImg(sock, msg, m.buf, `🎬 *Veo2 AI*`); await react(sock, msg, '✅'); }
      else { const t = _jsonFmt(r); await sendReply(sock, msg, `🎬 *Veo2:* ${t || 'No media generated'}`); }
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['veo3'], { desc: 'Generate video with Veo3 AI', category: 'AI' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'veo3 <prompt>');
    await react(sock, msg, '🎬');
    try {
      const r = await nx.ai.veo3({ prompt: args.join(' ') });
      const m = await _media(r, axios);
      if (m && m.ct.includes('video')) { await _sendVideo(sock, msg, m.buf, `🎬 *Veo3 AI*`); await react(sock, msg, '✅'); }
      else if (m) { await _sendImg(sock, msg, m.buf, `🎬 *Veo3 AI*`); await react(sock, msg, '✅'); }
      else { const t = _jsonFmt(r); await sendReply(sock, msg, `🎬 *Veo3:* ${t || 'No media generated'}`); }
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['vider'], { desc: 'Chat with Vider AI', category: 'AI' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'vider <text>');
    await react(sock, msg, '🤖');
    try {
      const r = await nx.ai.vider({ text: args.join(' ') });
      const t = _jsonFmt(r); if (!t) throw new Error('No response');
      await sendReply(sock, msg, `🤖 *Vider AI*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['webpilot'], { desc: 'Browse web with WebPilot AI', category: 'AI' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'webpilot <url or question>');
    await react(sock, msg, '🌐');
    try {
      const r = await nx.ai.webpilot({ text: args.join(' ') });
      const t = _jsonFmt(r); if (!t) throw new Error('No response');
      await sendReply(sock, msg, `🌐 *WebPilot AI*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['whiterabbitneo', 'wrn'], { desc: 'Chat with WhiteRabbitNeo AI', category: 'AI' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'whiterabbitneo <text>');
    await react(sock, msg, '🐇');
    try {
      const r = await nx.ai.whiterabbitneo({ text: args.join(' ') });
      const t = _jsonFmt(r); if (!t) throw new Error('No response');
      await sendReply(sock, msg, `🐇 *WhiteRabbitNeo AI*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['writesonic'], { desc: 'Chat with Writesonic AI', category: 'AI' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'writesonic <text>');
    await react(sock, msg, '✍️');
    try {
      const r = await nx.ai.writesonic({ text: args.join(' ') });
      const t = _jsonFmt(r); if (!t) throw new Error('No response');
      await sendReply(sock, msg, `✍️ *Writesonic AI*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['youchat', 'you'], { desc: 'Chat with You.com AI', category: 'AI' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'youchat <text>');
    await react(sock, msg, '🤖');
    try {
      const r = await nx.ai.youchat({ text: args.join(' ') });
      const t = _jsonFmt(r); if (!t) throw new Error('No response');
      await sendReply(sock, msg, `🤖 *You.com AI*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 📺  ANIME  — 19 endpoints
  // ═══════════════════════════════════════════════════════════════════════════

  cmd(['anichin', 'anichin-search'], { desc: 'Search anime on Anichin', category: 'ANIME' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'anichin <anime name>');
    await react(sock, msg, '🎌');
    try {
      const r = await nx.anime.anichinSearch({ text: args.join(' ') });
      const t = _jsonFmt(r); if (!t) throw new Error('No results');
      await sendReply(sock, msg, `🎌 *Anichin Search*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['anichin-detail'], { desc: 'Get anime detail from Anichin', category: 'ANIME' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'anichin-detail <url>');
    await react(sock, msg, '🎌');
    try {
      const r = await nx.anime.anichinDetail({ url: args[0] });
      const t = _jsonFmt(r); if (!t) throw new Error('No data');
      await sendReply(sock, msg, `🎌 *Anichin Detail*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['anichin-genre'], { desc: 'Browse anime by genre on Anichin', category: 'ANIME' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'anichin-genre <genre>');
    await react(sock, msg, '🎌');
    try {
      const r = await nx.anime.anichinGenre({ genre: args.join(' ') });
      const t = _jsonFmt(r); if (!t) throw new Error('No data');
      await sendReply(sock, msg, `🎌 *Anichin Genre: ${args.join(' ')}*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['anichin-genres'], { desc: 'List all Anichin genres', category: 'ANIME' }, async (sock, msg, args) => {
    await react(sock, msg, '🎌');
    try {
      const r = await nx.anime.anichinGenreList();
      const t = _jsonFmt(r); if (!t) throw new Error('No data');
      await sendReply(sock, msg, `🎌 *Anichin Genres*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['anichin-latest'], { desc: 'Latest anime on Anichin', category: 'ANIME' }, async (sock, msg, args) => {
    await react(sock, msg, '🎌');
    try {
      const r = await nx.anime.anichinLatest();
      const t = _jsonFmt(r); if (!t) throw new Error('No data');
      await sendReply(sock, msg, `🎌 *Anichin Latest*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['anichin-episode'], { desc: 'Get episode from Anichin', category: 'ANIME' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'anichin-episode <url>');
    await react(sock, msg, '🎌');
    try {
      const r = await nx.anime.anichinEpisode({ url: args[0] });
      const t = _jsonFmt(r); if (!t) throw new Error('No data');
      await sendReply(sock, msg, `🎌 *Anichin Episode*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['otakudesu', 'otaku-search'], { desc: 'Search anime on Otakudesu', category: 'ANIME' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'otakudesu <anime name>');
    await react(sock, msg, '🎌');
    try {
      const r = await nx.anime.otakudesuSearch({ text: args.join(' ') });
      const t = _jsonFmt(r); if (!t) throw new Error('No results');
      await sendReply(sock, msg, `🎌 *Otakudesu Search*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['otakudesu-detail'], { desc: 'Get anime detail from Otakudesu', category: 'ANIME' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'otakudesu-detail <url>');
    await react(sock, msg, '🎌');
    try {
      const r = await nx.anime.otakudesuDetail({ url: args[0] });
      const t = _jsonFmt(r); if (!t) throw new Error('No data');
      await sendReply(sock, msg, `🎌 *Otakudesu Detail*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['otakudesu-ongoing'], { desc: 'Ongoing anime on Otakudesu', category: 'ANIME' }, async (sock, msg, args) => {
    await react(sock, msg, '🎌');
    try {
      const r = await nx.anime.otakudesuOngoing();
      const t = _jsonFmt(r); if (!t) throw new Error('No data');
      await sendReply(sock, msg, `🎌 *Otakudesu Ongoing*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['otakudesu-complete'], { desc: 'Completed anime on Otakudesu', category: 'ANIME' }, async (sock, msg, args) => {
    await react(sock, msg, '🎌');
    try {
      const r = await nx.anime.otakudesuComplete();
      const t = _jsonFmt(r); if (!t) throw new Error('No data');
      await sendReply(sock, msg, `🎌 *Otakudesu Completed*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['otakudesu-episode'], { desc: 'Get episode from Otakudesu', category: 'ANIME' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'otakudesu-episode <url>');
    await react(sock, msg, '🎌');
    try {
      const r = await nx.anime.otakudesuEpisode({ url: args[0] });
      const t = _jsonFmt(r); if (!t) throw new Error('No data');
      await sendReply(sock, msg, `🎌 *Otakudesu Episode*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['samehadaku', 'same-search'], { desc: 'Search anime on Samehadaku', category: 'ANIME' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'samehadaku <anime name>');
    await react(sock, msg, '🎌');
    try {
      const r = await nx.anime.samehadakuSearch({ text: args.join(' ') });
      const t = _jsonFmt(r); if (!t) throw new Error('No results');
      await sendReply(sock, msg, `🎌 *Samehadaku Search*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['samehadaku-detail'], { desc: 'Get anime detail from Samehadaku', category: 'ANIME' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'samehadaku-detail <url>');
    await react(sock, msg, '🎌');
    try {
      const r = await nx.anime.samehadakuDetail({ url: args[0] });
      const t = _jsonFmt(r); if (!t) throw new Error('No data');
      await sendReply(sock, msg, `🎌 *Samehadaku Detail*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['samehadaku-episode'], { desc: 'Get episode from Samehadaku', category: 'ANIME' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'samehadaku-episode <url>');
    await react(sock, msg, '🎌');
    try {
      const r = await nx.anime.samehadakuEpisode({ url: args[0] });
      const t = _jsonFmt(r); if (!t) throw new Error('No data');
      await sendReply(sock, msg, `🎌 *Samehadaku Episode*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['samehadaku-latest'], { desc: 'Latest anime on Samehadaku', category: 'ANIME' }, async (sock, msg, args) => {
    await react(sock, msg, '🎌');
    try {
      const r = await nx.anime.samehadakuLatest();
      const t = _jsonFmt(r); if (!t) throw new Error('No data');
      await sendReply(sock, msg, `🎌 *Samehadaku Latest*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['kusonime', 'kuso-search'], { desc: 'Search anime on Kusonime', category: 'ANIME' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'kusonime <anime name>');
    await react(sock, msg, '🎌');
    try {
      const r = await nx.anime.kusonimeSearch({ text: args.join(' ') });
      const t = _jsonFmt(r); if (!t) throw new Error('No results');
      await sendReply(sock, msg, `🎌 *Kusonime Search*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['kusonime-detail'], { desc: 'Get anime detail from Kusonime', category: 'ANIME' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'kusonime-detail <url>');
    await react(sock, msg, '🎌');
    try {
      const r = await nx.anime.kusonimeDetail({ url: args[0] });
      const t = _jsonFmt(r); if (!t) throw new Error('No data');
      await sendReply(sock, msg, `🎌 *Kusonime Detail*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['kusonime-latest'], { desc: 'Latest anime on Kusonime', category: 'ANIME' }, async (sock, msg, args) => {
    await react(sock, msg, '🎌');
    try {
      const r = await nx.anime.kusonimeLatest();
      const t = _jsonFmt(r); if (!t) throw new Error('No data');
      await sendReply(sock, msg, `🎌 *Kusonime Latest*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['animequote', 'anime-quote'], { desc: 'Get random anime quote', category: 'ANIME' }, async (sock, msg, args) => {
    await react(sock, msg, '💬');
    try {
      const r = await nx.anime.quote();
      const t = _jsonFmt(r); if (!t) throw new Error('No data');
      await sendReply(sock, msg, `💬 *Anime Quote*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 📰  BERITA / NEWS  — 10 endpoints
  // ═══════════════════════════════════════════════════════════════════════════

  cmd(['berita-antara', 'antara'], { desc: 'Latest news from Antara', category: 'NEWS' }, async (sock, msg, args) => {
    await react(sock, msg, '📰');
    try {
      const r = await nx.berita.antara();
      const t = _jsonFmt(r); if (!t) throw new Error('No news');
      await sendReply(sock, msg, `📰 *Antara News*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['berita-cnbc', 'cnbcindonesia'], { desc: 'Latest news from CNBC Indonesia', category: 'NEWS' }, async (sock, msg, args) => {
    await react(sock, msg, '📰');
    try {
      const r = await nx.berita.cnbcindonesia();
      const t = _jsonFmt(r); if (!t) throw new Error('No news');
      await sendReply(sock, msg, `📰 *CNBC Indonesia*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['berita-cnn', 'cnn-news'], { desc: 'Latest news from CNN Indonesia', category: 'NEWS' }, async (sock, msg, args) => {
    await react(sock, msg, '📰');
    try {
      const r = await nx.berita.cnn();
      const t = _jsonFmt(r); if (!t) throw new Error('No news');
      await sendReply(sock, msg, `📰 *CNN Indonesia*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['berita-detik', 'detik'], { desc: 'Latest news from Detik', category: 'NEWS' }, async (sock, msg, args) => {
    await react(sock, msg, '📰');
    try {
      const r = await nx.berita.detik();
      const t = _jsonFmt(r); if (!t) throw new Error('No news');
      await sendReply(sock, msg, `📰 *Detik News*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['berita-kompas', 'kompas'], { desc: 'Latest news from Kompas', category: 'NEWS' }, async (sock, msg, args) => {
    await react(sock, msg, '📰');
    try {
      const r = await nx.berita.kompas();
      const t = _jsonFmt(r); if (!t) throw new Error('No news');
      await sendReply(sock, msg, `📰 *Kompas News*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['berita-liputan6', 'liputan6'], { desc: 'Latest news from Liputan6', category: 'NEWS' }, async (sock, msg, args) => {
    await react(sock, msg, '📰');
    try {
      const r = await nx.berita.liputan6();
      const t = _jsonFmt(r); if (!t) throw new Error('No news');
      await sendReply(sock, msg, `📰 *Liputan6 News*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['berita-republika', 'republika'], { desc: 'Latest news from Republika', category: 'NEWS' }, async (sock, msg, args) => {
    await react(sock, msg, '📰');
    try {
      const r = await nx.berita.republika();
      const t = _jsonFmt(r); if (!t) throw new Error('No news');
      await sendReply(sock, msg, `📰 *Republika News*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['berita-tempo', 'tempo'], { desc: 'Latest news from Tempo', category: 'NEWS' }, async (sock, msg, args) => {
    await react(sock, msg, '📰');
    try {
      const r = await nx.berita.tempo();
      const t = _jsonFmt(r); if (!t) throw new Error('No news');
      await sendReply(sock, msg, `📰 *Tempo News*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['berita-tribun', 'tribun'], { desc: 'Latest news from Tribun', category: 'NEWS' }, async (sock, msg, args) => {
    await react(sock, msg, '📰');
    try {
      const r = await nx.berita.tribun();
      const t = _jsonFmt(r); if (!t) throw new Error('No news');
      await sendReply(sock, msg, `📰 *Tribun News*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['berita-viva', 'viva'], { desc: 'Latest news from Viva', category: 'NEWS' }, async (sock, msg, args) => {
    await react(sock, msg, '📰');
    try {
      const r = await nx.berita.viva();
      const t = _jsonFmt(r); if (!t) throw new Error('No news');
      await sendReply(sock, msg, `📰 *Viva News*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 🖼️  CANVAS  — 10 endpoints
  // ═══════════════════════════════════════════════════════════════════════════

  cmd(['canvas-gura', 'gura'], { desc: 'Gura template canvas (reply/send image URL)', category: 'CANVAS' }, async (sock, msg, args) => {
    const url = args[0]; if (!url) return _noArgs(sock, msg, 'canvas-gura <image-url>');
    await react(sock, msg, '🖼️');
    try {
      const r = await nx.canvas.gura({ url }); const m = await _media(r, axios);
      if (m) { await _sendImg(sock, msg, m.buf, '🖼️ *Canvas Gura*'); await react(sock, msg, '✅'); }
      else throw new Error('No image returned');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['canvas-jmk', 'jmk48'], { desc: 'JMK48 Tribun twibbon canvas', category: 'CANVAS' }, async (sock, msg, args) => {
    const url = args[0]; if (!url) return _noArgs(sock, msg, 'canvas-jmk <image-url>');
    await react(sock, msg, '🖼️');
    try {
      const r = await nx.canvas.jmk({ url }); const m = await _media(r, axios);
      if (m) { await _sendImg(sock, msg, m.buf, '🖼️ *Canvas JMK48*'); await react(sock, msg, '✅'); }
      else throw new Error('No image returned');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['canvas-lirik', 'lirik-canvas'], { desc: 'Music lyrics canvas', category: 'CANVAS' }, async (sock, msg, args) => {
    if (args.length < 2) return _noArgs(sock, msg, 'canvas-lirik <image-url> <lyrics text>');
    const url = args[0]; const text = args.slice(1).join(' ');
    await react(sock, msg, '🎵');
    try {
      const r = await nx.canvas.lirik({ url, text }); const m = await _media(r, axios);
      if (m) { await _sendImg(sock, msg, m.buf, '🎵 *Canvas Lirik*'); await react(sock, msg, '✅'); }
      else throw new Error('No image returned');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['canvas-ship', 'ship'], { desc: 'Ship/couple canvas (2 image URLs)', category: 'CANVAS' }, async (sock, msg, args) => {
    if (args.length < 2) return _noArgs(sock, msg, 'canvas-ship <url1> <url2>');
    await react(sock, msg, '❤️');
    try {
      const r = await nx.canvas.ship({ url1: args[0], url2: args[1] }); const m = await _media(r, axios);
      if (m) { await _sendImg(sock, msg, m.buf, '❤️ *Canvas Ship*'); await react(sock, msg, '✅'); }
      else throw new Error('No image returned');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['canvas-wanted', 'wanted'], { desc: 'Wanted poster canvas', category: 'CANVAS' }, async (sock, msg, args) => {
    const url = args[0]; if (!url) return _noArgs(sock, msg, 'canvas-wanted <image-url>');
    await react(sock, msg, '🤠');
    try {
      const r = await nx.canvas.wanted({ url }); const m = await _media(r, axios);
      if (m) { await _sendImg(sock, msg, m.buf, '🤠 *Wanted Poster*'); await react(sock, msg, '✅'); }
      else throw new Error('No image returned');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['canvas-wasted', 'wasted'], { desc: 'Wasted overlay canvas — reply to an image or pass URL', category: 'CANVAS' }, async (sock, msg, args) => {
    await react(sock, msg, '💀');
    try {
      // Resolve image URL: arg URL → replied image (download+CDN) → quoted text URL
      let url = args.find(a => /^https?:\/\//i.test(a)) || null;

      if (!url) {
        try {
          const imgBuf = await _getImgFromMsg(msg, downloadContentFromMessage);
          if (imgBuf && imgBuf.length > 500) {
            const up = await nx.uploader.upload({ file: imgBuf });
            const u  = up?.result?.url || up?.data?.url || up?.url;
            if (u && /^https?:\/\//i.test(u)) url = u;
          }
        } catch {}
      }

      if (!url) {
        try {
          const qt =
            msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.conversation ||
            msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.extendedTextMessage?.text || '';
          const m2 = qt.match(/https?:\/\/\S+/i);
          if (m2) url = m2[0];
        } catch {}
      }

      if (!url) return _noArgs(sock, msg, 'canvas-wasted <image-url>  — or reply to an image');

      const r = await nx.canvas.wasted({ url });
      const m = await _media(r, axios);
      if (m) { await _sendImg(sock, msg, m.buf, ''); await react(sock, msg, '✅'); }
      else throw new Error('No image returned');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['musiccard', 'music-card'], { desc: 'Generate music card — .musiccard <song> <artist> [image-url]', category: 'CANVAS' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'musiccard <song name> <artist>');
    // 🌀 processing — react only, no text output
    await react(sock, msg, '🌀');
    try {
      // Separate image URL from text args
      const _imgArg  = args.find(a => /^https?:\/\//i.test(a)) || null;
      const _txtArgs = args.filter(a => !/^https?:\/\//i.test(a));
      const judul = _txtArgs[0] || args[0] || 'Unknown';
      const nama  = _txtArgs.slice(1).join(' ') || _txtArgs[0] || 'Unknown';

      // Resolve image_url:
      // 1) URL passed as arg
      // 2) Replied/quoted image → download → upload to nexray CDN
      // 3) URL found in quoted message text
      // 4) Fallback Spotify placeholder
      let image_url = _imgArg;

      if (!image_url) {
        try {
          const _imgBuf = await _getImgFromMsg(msg, downloadContentFromMessage);
          if (_imgBuf && _imgBuf.length > 500) {
            const _up = await nx.uploader.upload({ file: _imgBuf });
            const _u  = _up?.result?.url || _up?.data?.url || _up?.url;
            if (_u && typeof _u === 'string' && /^https?:\/\//i.test(_u)) image_url = _u;
          }
        } catch {}
      }

      if (!image_url) {
        try {
          const _qTxt =
            msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.conversation ||
            msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.extendedTextMessage?.text || '';
          const _m = _qTxt.match(/https?:\/\/\S+/i);
          if (_m) image_url = _m[0];
        } catch {}
      }

      if (!image_url) image_url = 'https://i.scdn.co/image/ab67616d0000b273c5649add07ed3720be9d5526';

      // Direct nexray canvas/musiccard — no tiktokcrd / ytcard fallbacks
      const r = await nx.canvas.musiccard({ judul, nama, image_url });

      let cardBuf = null;
      if (r?.type === 'media' && Buffer.isBuffer(r.buffer) && r.buffer.length > 500) {
        cardBuf = r.buffer;
      } else {
        const _u = r?.result?.url ?? r?.data?.url
          ?? (typeof r?.result === 'string' && r.result.startsWith('http') ? r.result : null)
          ?? r?.url ?? null;
        if (_u) {
          try {
            const rb = await axios.get(_u, { responseType: 'arraybuffer', timeout: 30000 });
            const b  = Buffer.from(rb.data);
            if (b.length > 500) cardBuf = b;
          } catch {}
        }
      }

      if (!cardBuf || cardBuf.length < 500) return react(sock, msg, '❌');

      // ✅ done — send image, no caption text
      await sock.sendMessage(msg.key.remoteJid, { image: cardBuf }, { quoted: msg });
      await react(sock, msg, '✅');
    } catch { await react(sock, msg, '❌'); }
  });

  cmd(['canvas-pixelate', 'pixelate'], { desc: 'Pixelate image canvas', category: 'CANVAS' }, async (sock, msg, args) => {
    const url = args[0]; if (!url) return _noArgs(sock, msg, 'canvas-pixelate <image-url>');
    await react(sock, msg, '🔲');
    try {
      const r = await nx.canvas.pixelate({ url }); const m = await _media(r, axios);
      if (m) { await _sendImg(sock, msg, m.buf, '🔲 *Pixelate Canvas*'); await react(sock, msg, '✅'); }
      else throw new Error('No image returned');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['canvas-glass', 'glass-fx'], { desc: 'Glass effect canvas', category: 'CANVAS' }, async (sock, msg, args) => {
    const url = args[0]; if (!url) return _noArgs(sock, msg, 'canvas-glass <image-url>');
    await react(sock, msg, '🪟');
    try {
      const r = await nx.canvas.glass({ url }); const m = await _media(r, axios);
      if (m) { await _sendImg(sock, msg, m.buf, '🪟 *Glass Effect*'); await react(sock, msg, '✅'); }
      else throw new Error('No image returned');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['canvas-rainbow', 'rainbow-fx'], { desc: 'Rainbow effect canvas', category: 'CANVAS' }, async (sock, msg, args) => {
    const url = args[0]; if (!url) return _noArgs(sock, msg, 'canvas-rainbow <image-url>');
    await react(sock, msg, '🌈');
    try {
      const r = await nx.canvas.rainbow({ url }); const m = await _media(r, axios);
      if (m) { await _sendImg(sock, msg, m.buf, '🌈 *Rainbow Effect*'); await react(sock, msg, '✅'); }
      else throw new Error('No image returned');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ⬇️  DOWNLOADER  — 42 endpoints
  // ═══════════════════════════════════════════════════════════════════════════

  // Helper: format downloader result
  function _dlFmt(r, name) {
    const t = _jsonFmt(r);
    return t ? `⬇️ *${name} Downloader*\n\n${t}` : `⬇️ *${name}:* Could not retrieve link`;
  }

  cmd(['dl', 'aio-dl'], { desc: 'All-in-one downloader (any URL)', category: 'DOWNLOAD' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'dl <url>');
    await react(sock, msg, '⬇️');
    try {
      const r = await nx.downloader.aio({ url: args[0] });
      await sendReply(sock, msg, _dlFmt(r, 'AIO')); await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['applemusic-dl', 'amdl'], { desc: 'Download Apple Music', category: 'DOWNLOAD' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'applemusic-dl <url>');
    await react(sock, msg, '🍎');
    try {
      const r = await nx.downloader.applemusic({ url: args[0] });
      await sendReply(sock, msg, _dlFmt(r, 'Apple Music')); await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['capcut-dl', 'capcutdl'], { desc: 'Download CapCut video', category: 'DOWNLOAD' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'capcut-dl <url>');
    await react(sock, msg, '🎬');
    try {
      const r = await nx.downloader.capcut({ url: args[0] });
      await sendReply(sock, msg, _dlFmt(r, 'CapCut')); await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['douyin-dl', 'douyindl'], { desc: 'Download Douyin video', category: 'DOWNLOAD' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'douyin-dl <url>');
    await react(sock, msg, '⬇️');
    try {
      const r = await nx.downloader.douyin({ url: args[0] });
      await sendReply(sock, msg, _dlFmt(r, 'Douyin')); await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['fb-dl', 'fbdl', 'facebook-dl'], { desc: 'Download Facebook video', category: 'DOWNLOAD' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'fb-dl <url>');
    await react(sock, msg, '📘');
    try {
      const r = await nx.downloader.facebook({ url: args[0] });
      await sendReply(sock, msg, _dlFmt(r, 'Facebook')); await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['gdrive-dl', 'gdrived'], { desc: 'Download Google Drive file', category: 'DOWNLOAD' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'gdrive-dl <url>');
    await react(sock, msg, '📂');
    try {
      const r = await nx.downloader.gdrive({ url: args[0] });
      await sendReply(sock, msg, _dlFmt(r, 'Google Drive')); await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['github-dl', 'gitdl'], { desc: 'Download GitHub repository', category: 'DOWNLOAD' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'github-dl <url>');
    await react(sock, msg, '💾');
    try {
      const r = await nx.downloader.github({ url: args[0] });
      await sendReply(sock, msg, _dlFmt(r, 'GitHub')); await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['gofile-dl', 'gofile'], { desc: 'Download from GoFile', category: 'DOWNLOAD' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'gofile-dl <url>');
    await react(sock, msg, '📥');
    try {
      const r = await nx.downloader.gofile({ url: args[0] });
      await sendReply(sock, msg, _dlFmt(r, 'GoFile')); await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['googledrive-dl', 'gdl'], { desc: 'Download from Google Drive (alt)', category: 'DOWNLOAD' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'googledrive-dl <url>');
    await react(sock, msg, '📂');
    try {
      const r = await nx.downloader.googledrive({ url: args[0] });
      await sendReply(sock, msg, _dlFmt(r, 'Google Drive')); await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['ig-dl', 'igdl', 'instagram-dl'], { desc: 'Download Instagram post/reel', category: 'DOWNLOAD' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'ig-dl <url>');
    await react(sock, msg, '📸');
    try {
      const r = await nx.downloader.instagram({ url: args[0] });
      await sendReply(sock, msg, _dlFmt(r, 'Instagram')); await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['igstory-dl', 'igstory'], { desc: 'Download Instagram Story', category: 'DOWNLOAD' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'igstory-dl <url>');
    await react(sock, msg, '📸');
    try {
      const r = await nx.downloader.igstory({ url: args[0] });
      await sendReply(sock, msg, _dlFmt(r, 'Instagram Story')); await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['likee-dl', 'likeedl'], { desc: 'Download Likee video', category: 'DOWNLOAD' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'likee-dl <url>');
    await react(sock, msg, '⬇️');
    try {
      const r = await nx.downloader.likee({ url: args[0] });
      await sendReply(sock, msg, _dlFmt(r, 'Likee')); await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['mediafire-dl', 'mfdl'], { desc: 'Download from MediaFire', category: 'DOWNLOAD' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'mediafire-dl <url>');
    await react(sock, msg, '🔥');
    try {
      const r = await nx.downloader.mediafire({ url: args[0] });
      await sendReply(sock, msg, _dlFmt(r, 'MediaFire')); await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['mega-dl', 'megadl'], { desc: 'Download from MEGA', category: 'DOWNLOAD' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'mega-dl <url>');
    await react(sock, msg, '📦');
    try {
      const r = await nx.downloader.mega({ url: args[0] });
      await sendReply(sock, msg, _dlFmt(r, 'MEGA')); await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['mlskin-dl', 'mlskindl'], { desc: 'Download MLBB skin', category: 'DOWNLOAD' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'mlskin-dl <url>');
    await react(sock, msg, '🎮');
    try {
      const r = await nx.downloader.mlskin({ url: args[0] });
      await sendReply(sock, msg, _dlFmt(r, 'MLBB Skin')); await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['pinterest-dl', 'pindl'], { desc: 'Download Pinterest image/video', category: 'DOWNLOAD' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'pinterest-dl <url>');
    await react(sock, msg, '📌');
    try {
      const r = await nx.downloader.pinterest({ url: args[0] });
      const m = await _media(r, axios);
      if (m) { await _sendImg(sock, msg, m.buf, '📌 *Pinterest Download*'); await react(sock, msg, '✅'); }
      else { await sendReply(sock, msg, _dlFmt(r, 'Pinterest')); await react(sock, msg, '✅'); }
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['pinterest-search-dl', 'pinsdl'], { desc: 'Download Pinterest image from search', category: 'DOWNLOAD' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'pinterest-search-dl <query>');
    await react(sock, msg, '📌');
    try {
      const r = await nx.downloader.pinterestSearch({ text: args.join(' ') });
      await sendReply(sock, msg, _dlFmt(r, 'Pinterest Search')); await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['pixiv-dl', 'pixivdl'], { desc: 'Download Pixiv artwork', category: 'DOWNLOAD' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'pixiv-dl <url>');
    await react(sock, msg, '🎨');
    try {
      const r = await nx.downloader.pixiv({ url: args[0] });
      await sendReply(sock, msg, _dlFmt(r, 'Pixiv')); await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['playstore-dl', 'apkdl'], { desc: 'Download APK from Play Store', category: 'DOWNLOAD' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'playstore-dl <url>');
    await react(sock, msg, '📱');
    try {
      const r = await nx.downloader.playstore({ url: args[0] });
      await sendReply(sock, msg, _dlFmt(r, 'Play Store')); await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['reddit-dl', 'redditdl'], { desc: 'Download Reddit video/image', category: 'DOWNLOAD' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'reddit-dl <url>');
    await react(sock, msg, '🤖');
    try {
      const r = await nx.downloader.reddit({ url: args[0] });
      await sendReply(sock, msg, _dlFmt(r, 'Reddit')); await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['reels-dl', 'reelsdl'], { desc: 'Download Instagram Reels', category: 'DOWNLOAD' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'reels-dl <url>');
    await react(sock, msg, '📱');
    try {
      const r = await nx.downloader.reels({ url: args[0] });
      await sendReply(sock, msg, _dlFmt(r, 'Reels')); await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['saavn-dl', 'saavndl'], { desc: 'Download Saavn music', category: 'DOWNLOAD' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'saavn-dl <url>');
    await react(sock, msg, '🎵');
    try {
      const r = await nx.downloader.saavn({ url: args[0] });
      await sendReply(sock, msg, _dlFmt(r, 'Saavn')); await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['savefrom-dl', 'sfrom'], { desc: 'Download via SaveFrom', category: 'DOWNLOAD' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'savefrom-dl <url>');
    await react(sock, msg, '⬇️');
    try {
      const r = await nx.downloader.savefrom({ url: args[0] });
      await sendReply(sock, msg, _dlFmt(r, 'SaveFrom')); await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['soundcloud-dl', 'scdl'], { desc: 'Download SoundCloud track', category: 'DOWNLOAD' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'soundcloud-dl <url>');
    await react(sock, msg, '🎵');
    try {
      const r = await nx.downloader.soundcloud({ url: args[0] });
      await sendReply(sock, msg, _dlFmt(r, 'SoundCloud')); await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['spotify-dl', 'spotifydl'], { desc: 'Download Spotify track', category: 'DOWNLOAD' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'spotify-dl <url>');
    await react(sock, msg, '🎵');
    try {
      const r = await nx.downloader.spotify({ url: args[0] });
      await sendReply(sock, msg, _dlFmt(r, 'Spotify')); await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['stickerwa-dl', 'stickerwadl'], { desc: 'Download WhatsApp sticker', category: 'DOWNLOAD' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'stickerwa-dl <url>');
    await react(sock, msg, '🎭');
    try {
      const r = await nx.downloader.stickerwa({ url: args[0] });
      await sendReply(sock, msg, _dlFmt(r, 'StickerWA')); await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['threads-dl', 'threadsdl'], { desc: 'Download Threads post', category: 'DOWNLOAD' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'threads-dl <url>');
    await react(sock, msg, '🧵');
    try {
      const r = await nx.downloader.threads({ url: args[0] });
      await sendReply(sock, msg, _dlFmt(r, 'Threads')); await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  // v19: the 'ttdl' alias was removed — it shadowed the image-card .tt/.tiktok handler
  cmd(['tt-dl', 'tiktok-dl'], { desc: 'Download TikTok video (no watermark)', category: 'DOWNLOAD' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'tt-dl <url>');
    await react(sock, msg, '🎵');
    try {
      const r = await nx.downloader.tiktok({ url: args[0] });
      await sendReply(sock, msg, _dlFmt(r, 'TikTok')); await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['tt-dl2', 'ttdlv1'], { desc: 'Download TikTok video v1', category: 'DOWNLOAD' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'tt-dl2 <url>');
    await react(sock, msg, '🎵');
    try {
      const r = await nx.downloader.tiktokV1({ url: args[0] });
      await sendReply(sock, msg, _dlFmt(r, 'TikTok v1')); await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['tt-dl3', 'ttdlv2'], { desc: 'Download TikTok video v2', category: 'DOWNLOAD' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'tt-dl3 <url>');
    await react(sock, msg, '🎵');
    try {
      const r = await nx.downloader.tiktokV2({ url: args[0] });
      await sendReply(sock, msg, _dlFmt(r, 'TikTok v2')); await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['twit-dl', 'xdl', 'twitter-dl'], { desc: 'Download Twitter/X video', category: 'DOWNLOAD' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'twit-dl <url>');
    await react(sock, msg, '🐦');
    try {
      const r = await nx.downloader.twitter({ url: args[0] });
      await sendReply(sock, msg, _dlFmt(r, 'Twitter/X')); await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['twit-dl2', 'xdlv1'], { desc: 'Download Twitter/X video v1', category: 'DOWNLOAD' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'twit-dl2 <url>');
    await react(sock, msg, '🐦');
    try {
      const r = await nx.downloader.twitterV1({ url: args[0] });
      await sendReply(sock, msg, _dlFmt(r, 'Twitter/X v1')); await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['video-dl', 'videodl'], { desc: 'Download online video (generic)', category: 'DOWNLOAD' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'video-dl <url>');
    await react(sock, msg, '🎬');
    try {
      const r = await nx.downloader.video({ url: args[0] });
      await sendReply(sock, msg, _dlFmt(r, 'Video')); await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['vimeo-dl', 'vimeodl'], { desc: 'Download Vimeo video', category: 'DOWNLOAD' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'vimeo-dl <url>');
    await react(sock, msg, '🎬');
    try {
      const r = await nx.downloader.vimeo({ url: args[0] });
      await sendReply(sock, msg, _dlFmt(r, 'Vimeo')); await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['wetv-dl', 'wetvdl'], { desc: 'Download WeTV video', category: 'DOWNLOAD' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'wetv-dl <url>');
    await react(sock, msg, '📺');
    try {
      const r = await nx.downloader.wetv({ url: args[0] });
      await sendReply(sock, msg, _dlFmt(r, 'WeTV')); await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['yt-audio', 'ytaudio'], { desc: 'Download YouTube audio (MP3)', category: 'DOWNLOAD' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'yt-audio <url>');
    await react(sock, msg, '🎵');
    try {
      const r = await nx.downloader.ytAudio({ url: args[0] });
      await sendReply(sock, msg, _dlFmt(r, 'YouTube Audio')); await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['yt-video', 'ytvideo'], { desc: 'Download YouTube video (MP4)', category: 'DOWNLOAD' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'yt-video <url>');
    await react(sock, msg, '🎬');
    try {
      const r = await nx.downloader.ytVideo({ url: args[0] });
      await sendReply(sock, msg, _dlFmt(r, 'YouTube Video')); await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['ytmp3'], { desc: 'Download YouTube as MP3', category: 'DOWNLOAD' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'ytmp3 <url>');
    await react(sock, msg, '🎵');
    try {
      const r = await nx.downloader.ytmp3({ url: args[0] });
      await sendReply(sock, msg, _dlFmt(r, 'YouTube MP3')); await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['nxytmp4'], { desc: 'Download YouTube as MP4 (MIAS)', category: 'DOWNLOAD' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'ytmp4 <url>');
    await react(sock, msg, '🎬');
    try {
      const r = await nx.downloader.ytmp4({ url: args[0] });
      await sendReply(sock, msg, _dlFmt(r, 'YouTube MP4')); await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['ytv1', 'ytdl1'], { desc: 'Download YouTube video v1', category: 'DOWNLOAD' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'ytv1 <url>');
    await react(sock, msg, '🎬');
    try {
      const r = await nx.downloader.ytV1({ url: args[0] });
      await sendReply(sock, msg, _dlFmt(r, 'YouTube v1')); await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['ytv2', 'ytdl2'], { desc: 'Download YouTube video v2', category: 'DOWNLOAD' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'ytv2 <url>');
    await react(sock, msg, '🎬');
    try {
      const r = await nx.downloader.ytV2({ url: args[0] });
      await sendReply(sock, msg, _dlFmt(r, 'YouTube v2')); await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['zoho-dl', 'zohodl'], { desc: 'Download from Zoho WorkDrive', category: 'DOWNLOAD' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'zoho-dl <url>');
    await react(sock, msg, '📥');
    try {
      const r = await nx.downloader.zoho({ url: args[0] });
      await sendReply(sock, msg, _dlFmt(r, 'Zoho')); await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 🎭  EDITOR  — 2 endpoints
  // ═══════════════════════════════════════════════════════════════════════════

  cmd(['editor-wanted', 'ewanted'], { desc: 'Wanted poster editor effect', category: 'TOOLS' }, async (sock, msg, args) => {
    const url = args[0]; if (!url) return _noArgs(sock, msg, 'editor-wanted <image-url>');
    await react(sock, msg, '🤠');
    try {
      const r = await nx.editor.wanted({ url }); const m = await _media(r, axios);
      if (m) { await _sendImg(sock, msg, m.buf, '🤠 *Wanted Poster*'); await react(sock, msg, '✅'); }
      else throw new Error('No image returned');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['editor-wasted', 'ewasted'], { desc: 'Wasted overlay editor effect', category: 'TOOLS' }, async (sock, msg, args) => {
    const url = args[0]; if (!url) return _noArgs(sock, msg, 'editor-wasted <image-url>');
    await react(sock, msg, '💀');
    try {
      const r = await nx.editor.wasted({ url }); const m = await _media(r, axios);
      if (m) { await _sendImg(sock, msg, m.buf, '💀 *Wasted Effect*'); await react(sock, msg, '✅'); }
      else throw new Error('No image returned');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 📸  EPHOTO  — 27 photo effects
  // ═══════════════════════════════════════════════════════════════════════════

  const _ephoto = (fn, label, emoji) => async (sock, msg, args) => {
    const url = args[0]; if (!url) return _noArgs(sock, msg, `ephoto-${label.toLowerCase()} <image-url>`);
    await react(sock, msg, emoji);
    try {
      const r = await fn({ url }); const m = await _media(r, axios);
      if (m) { await _sendImg(sock, msg, m.buf, `${emoji} *Ephoto ${label}*`); await react(sock, msg, '✅'); }
      else throw new Error('No image returned');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  };

  cmd(['ephoto-real', 'phreal'], { desc: 'Ephoto real effect', category: 'PHOTO' }, _ephoto(o => nx.ephoto.real(o), 'Real', '📷'));
  cmd(['ephoto-anime', 'phanime'], { desc: 'Ephoto anime effect', category: 'PHOTO' }, _ephoto(o => nx.ephoto.anime(o), 'Anime', '🎌'));
  cmd(['ephoto-art', 'phart'], { desc: 'Ephoto art effect', category: 'PHOTO' }, _ephoto(o => nx.ephoto.art(o), 'Art', '🎨'));
  cmd(['ephoto-blood', 'phblood'], { desc: 'Ephoto blood effect', category: 'PHOTO' }, _ephoto(o => nx.ephoto.blood(o), 'Blood', '🩸'));
  cmd(['ephoto-blur', 'phblur'], { desc: 'Ephoto blur effect', category: 'PHOTO' }, _ephoto(o => nx.ephoto.blur(o), 'Blur', '🌫️'));
  cmd(['ephoto-bokeh', 'phbokeh'], { desc: 'Ephoto bokeh effect', category: 'PHOTO' }, _ephoto(o => nx.ephoto.bokeh(o), 'Bokeh', '✨'));
  cmd(['ephoto-broken', 'phbroken'], { desc: 'Ephoto broken glass effect', category: 'PHOTO' }, _ephoto(o => nx.ephoto.brokenglass(o), 'Broken Glass', '🪟'));
  cmd(['ephoto-cartoon', 'phcartoon'], { desc: 'Ephoto cartoon effect', category: 'PHOTO' }, _ephoto(o => nx.ephoto.cartoon(o), 'Cartoon', '🎭'));
  cmd(['ephoto-fire', 'phfire'], { desc: 'Ephoto fire effect', category: 'PHOTO' }, _ephoto(o => nx.ephoto.fire(o), 'Fire', '🔥'));
  cmd(['ephoto-galaxy', 'phgalaxy'], { desc: 'Ephoto galaxy effect', category: 'PHOTO' }, _ephoto(o => nx.ephoto.galaxy(o), 'Galaxy', '🌌'));
  cmd(['ephoto-glitch', 'phglitch'], { desc: 'Ephoto glitch effect', category: 'PHOTO' }, _ephoto(o => nx.ephoto.glitch(o), 'Glitch', '📺'));
  cmd(['ephoto-gold', 'phgold'], { desc: 'Ephoto gold effect', category: 'PHOTO' }, _ephoto(o => nx.ephoto.gold(o), 'Gold', '✨'));
  cmd(['ephoto-graffiti', 'phgraffiti'], { desc: 'Ephoto graffiti effect', category: 'PHOTO' }, _ephoto(o => nx.ephoto.graffiti(o), 'Graffiti', '🎨'));
  cmd(['ephoto-hacker', 'phhacker'], { desc: 'Ephoto hacker effect', category: 'PHOTO' }, _ephoto(o => nx.ephoto.hacker(o), 'Hacker', '💻'));
  cmd(['ephoto-ice', 'phice'], { desc: 'Ephoto ice effect', category: 'PHOTO' }, _ephoto(o => nx.ephoto.ice(o), 'Ice', '❄️'));
  cmd(['ephoto-lava', 'phlava'], { desc: 'Ephoto lava effect', category: 'PHOTO' }, _ephoto(o => nx.ephoto.lava(o), 'Lava', '🌋'));
  cmd(['ephoto-lightning', 'phlightning'], { desc: 'Ephoto lightning effect', category: 'PHOTO' }, _ephoto(o => nx.ephoto.lightning(o), 'Lightning', '⚡'));
  cmd(['ephoto-matrix', 'phmatrix'], { desc: 'Ephoto matrix effect', category: 'PHOTO' }, _ephoto(o => nx.ephoto.matrix(o), 'Matrix', '💊'));
  cmd(['ephoto-metal', 'phmetal'], { desc: 'Ephoto metal effect', category: 'PHOTO' }, _ephoto(o => nx.ephoto.metal(o), 'Metal', '🔩'));
  cmd(['ephoto-neon', 'phneon'], { desc: 'Ephoto neon effect', category: 'PHOTO' }, _ephoto(o => nx.ephoto.neon(o), 'Neon', '💡'));
  cmd(['ephoto-ocean', 'phocean'], { desc: 'Ephoto ocean effect', category: 'PHOTO' }, _ephoto(o => nx.ephoto.ocean(o), 'Ocean', '🌊'));
  cmd(['ephoto-pixel', 'phpixel'], { desc: 'Ephoto pixel effect', category: 'PHOTO' }, _ephoto(o => nx.ephoto.pixel(o), 'Pixel', '🔲'));
  cmd(['ephoto-rainbow', 'phrainbow'], { desc: 'Ephoto rainbow effect', category: 'PHOTO' }, _ephoto(o => nx.ephoto.rainbow(o), 'Rainbow', '🌈'));
  cmd(['ephoto-retro', 'phretro'], { desc: 'Ephoto retro effect', category: 'PHOTO' }, _ephoto(o => nx.ephoto.retro(o), 'Retro', '📺'));
  cmd(['ephoto-smoke', 'phsmoke'], { desc: 'Ephoto smoke effect', category: 'PHOTO' }, _ephoto(o => nx.ephoto.smoke(o), 'Smoke', '💨'));
  cmd(['ephoto-space', 'phspace'], { desc: 'Ephoto space effect', category: 'PHOTO' }, _ephoto(o => nx.ephoto.space(o), 'Space', '🚀'));
  cmd(['ephoto-wood', 'phwood'], { desc: 'Ephoto wood effect', category: 'PHOTO' }, _ephoto(o => nx.ephoto.wood(o), 'Wood', '🪵'));

  // ═══════════════════════════════════════════════════════════════════════════
  // 😄  FUN  — 2 endpoints
  // ═══════════════════════════════════════════════════════════════════════════

  cmd(['alay', 'alaytext'], { desc: 'Convert text to alay style', category: 'FUN' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'alay <text>');
    await react(sock, msg, '😂');
    try {
      const r = await nx.fun.alay({ text: args.join(' ') });
      const t = _jsonFmt(r); if (!t) throw new Error('No response');
      await sendReply(sock, msg, `😂 *Alay Text*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['funfact', 'livefunfact'], { desc: 'Get a live fun fact', category: 'FUN' }, async (sock, msg, args) => {
    await react(sock, msg, '💡');
    try {
      const r = await nx.fun.livefunfact();
      const t = _jsonFmt(r); if (!t) throw new Error('No response');
      await sendReply(sock, msg, `💡 *Fun Fact*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 🎮  GAMES  — 8 endpoints
  // ═══════════════════════════════════════════════════════════════════════════

  cmd(['asahotak', 'soal-otak'], { desc: 'Brain teaser quiz game', category: 'GAMES' }, async (sock, msg, args) => {
    await react(sock, msg, '🧠');
    try {
      const r = await nx.games.asahotak();
      const t = _jsonFmt(r); if (!t) throw new Error('No data');
      await sendReply(sock, msg, `🧠 *Asah Otak*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['tebak-islam', 'islamgame'], { desc: 'Islamic quiz game', category: 'GAMES' }, async (sock, msg, args) => {
    await react(sock, msg, '☪️');
    try {
      const r = await nx.games.islamic();
      const t = _jsonFmt(r); if (!t) throw new Error('No data');
      await sendReply(sock, msg, `☪️ *Islamic Quiz*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['siapakahaku', 'tebak-tokoh'], { desc: 'Who am I? character guessing game', category: 'GAMES' }, async (sock, msg, args) => {
    await react(sock, msg, '🕵️');
    try {
      const r = await nx.games.siapakahaku();
      const t = _jsonFmt(r); if (!t) throw new Error('No data');
      await sendReply(sock, msg, `🕵️ *Siapakah Aku?*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['susunkata', 'susun-kata'], { desc: 'Word arrangement game', category: 'GAMES' }, async (sock, msg, args) => {
    await react(sock, msg, '🔤');
    try {
      const r = await nx.games.susunkata();
      const t = _jsonFmt(r); if (!t) throw new Error('No data');
      await sendReply(sock, msg, `🔤 *Susun Kata*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['tebak-bendera', 'tebabendera'], { desc: 'Guess the flag game', category: 'GAMES' }, async (sock, msg, args) => {
    await react(sock, msg, '🚩');
    try {
      const r = await nx.games.tebakbendera();
      const t = _jsonFmt(r); if (!t) throw new Error('No data');
      await sendReply(sock, msg, `🚩 *Tebak Bendera*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['tebak-gambar', 'tebagambar'], { desc: 'Guess the picture game', category: 'GAMES' }, async (sock, msg, args) => {
    await react(sock, msg, '🖼️');
    try {
      const r = await nx.games.tebakgambar();
      const m = await _media(r, axios);
      const t = _jsonFmt(r);
      if (m) { await _sendImg(sock, msg, m.buf, `🖼️ *Tebak Gambar*\n${t || ''}`); }
      else if (t) { await sendReply(sock, msg, `🖼️ *Tebak Gambar*\n\n${t}`); }
      else throw new Error('No data');
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['tebak-kata', 'tebakata'], { desc: 'Word guessing game', category: 'GAMES' }, async (sock, msg, args) => {
    await react(sock, msg, '🔤');
    try {
      const r = await nx.games.tebakkata();
      const t = _jsonFmt(r); if (!t) throw new Error('No data');
      await sendReply(sock, msg, `🔤 *Tebak Kata*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['tebak-lirik', 'tebalirik'], { desc: 'Guess the song lyrics game', category: 'GAMES' }, async (sock, msg, args) => {
    await react(sock, msg, '🎵');
    try {
      const r = await nx.games.tebaklirik();
      const t = _jsonFmt(r); if (!t) throw new Error('No data');
      await sendReply(sock, msg, `🎵 *Tebak Lirik*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ℹ️  INFORMATION  — 10 endpoints
  // ═══════════════════════════════════════════════════════════════════════════

  cmd(['tagihan-pln', 'plncek'], { desc: 'Cek tagihan PLN listrik', category: 'INFO' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'tagihan-pln <nomor-pelanggan>');
    await react(sock, msg, '💡');
    try {
      const r = await nx.information.cektagihanpln({ id: args[0] });
      const t = _jsonFmt(r); if (!t) throw new Error('No data');
      await sendReply(sock, msg, `💡 *Tagihan PLN*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['cek-rekening', 'rekening'], { desc: 'Cek info rekening bank', category: 'INFO' }, async (sock, msg, args) => {
    if (args.length < 2) return _noArgs(sock, msg, 'cek-rekening <bank> <nomor>');
    await react(sock, msg, '🏦');
    try {
      const r = await nx.information.checkRekening({ bank: args[0], number: args[1] });
      const t = _jsonFmt(r); if (!t) throw new Error('No data');
      await sendReply(sock, msg, `🏦 *Cek Rekening*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['cuaca', 'weather-id'], { desc: 'Cek cuaca kota (Indonesia)', category: 'INFO' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'cuaca <kota>');
    await react(sock, msg, '🌤️');
    try {
      const r = await nx.information.cuaca({ city: args.join(' ') });
      const t = _jsonFmt(r); if (!t) throw new Error('No data');
      await sendReply(sock, msg, `🌤️ *Cuaca ${args.join(' ')}*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['weather', 'cuaca-en'], { desc: 'Get weather info (English)', category: 'INFO' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'weather <city>');
    await react(sock, msg, '🌤️');
    try {
      const r = await nx.information.weather({ city: args.join(' ') });
      const t = _jsonFmt(r); if (!t) throw new Error('No data');
      await sendReply(sock, msg, `🌤️ *Weather: ${args.join(' ')}*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['kodepos', 'postal-code'], { desc: 'Cek kode pos Indonesia', category: 'INFO' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'kodepos <kelurahan/desa>');
    await react(sock, msg, '📮');
    try {
      const r = await nx.information.kodepos({ text: args.join(' ') });
      const t = _jsonFmt(r); if (!t) throw new Error('No data');
      await sendReply(sock, msg, `📮 *Kode Pos*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['gempa', 'earthquake'], { desc: 'Info gempa bumi terkini (BMKG)', category: 'INFO' }, async (sock, msg, args) => {
    await react(sock, msg, '🌍');
    try {
      const r = await nx.information.gempa();
      const t = _jsonFmt(r); if (!t) throw new Error('No data');
      await sendReply(sock, msg, `🌍 *Gempa Terkini (BMKG)*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['hari-libur', 'libur'], { desc: 'Jadwal hari libur nasional', category: 'INFO' }, async (sock, msg, args) => {
    await react(sock, msg, '📅');
    try {
      const r = await nx.information.hariLibur();
      const t = _jsonFmt(r); if (!t) throw new Error('No data');
      await sendReply(sock, msg, `📅 *Hari Libur Nasional*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['kurs', 'exchange-rate'], { desc: 'Info kurs mata uang hari ini', category: 'INFO' }, async (sock, msg, args) => {
    await react(sock, msg, '💱');
    try {
      const r = await nx.information.kurs();
      const t = _jsonFmt(r); if (!t) throw new Error('No data');
      await sendReply(sock, msg, `💱 *Kurs Mata Uang*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['prakiraan', 'forecast'], { desc: 'Prakiraan cuaca Indonesia', category: 'INFO' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'prakiraan <kota>');
    await react(sock, msg, '🌥️');
    try {
      const r = await nx.information.prakiraan({ city: args.join(' ') });
      const t = _jsonFmt(r); if (!t) throw new Error('No data');
      await sendReply(sock, msg, `🌥️ *Prakiraan Cuaca: ${args.join(' ')}*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['sholat', 'jadwal-sholat'], { desc: 'Jadwal sholat berdasarkan kota', category: 'INFO' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'sholat <kota>');
    await react(sock, msg, '🕌');
    try {
      const r = await nx.information.sholat({ city: args.join(' ') });
      const t = _jsonFmt(r); if (!t) throw new Error('No data');
      await sendReply(sock, msg, `🕌 *Jadwal Sholat: ${args.join(' ')}*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 🏗️  MAKER  — 22 endpoints
  // ═══════════════════════════════════════════════════════════════════════════

  const _makerImg = (fn, label, emoji, params) => async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, `${label.toLowerCase().replace(/ /g,'-')} ${params}`);
    await react(sock, msg, emoji);
    try {
      const r = await fn(args); const m = await _media(r, axios);
      if (m) { await _sendImg(sock, msg, m.buf, `${emoji} *${label}*`); await react(sock, msg, '✅'); }
      else { const t = _jsonFmt(r); await sendReply(sock, msg, `${emoji} *${label}*\n\n${t || 'No image'}`); }
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  };

  cmd(['attp', 'attp-sticker'], { desc: 'Buat sticker animasi teks', category: 'MAKER' },
    _makerImg(args => nx.maker.attp({ text: args.join(' ') }), 'ATTP Sticker', '✨', '<text>'));

  cmd(['balogo', 'ba-logo'], { desc: 'Buat logo style BA', category: 'MAKER' },
    _makerImg(args => nx.maker.balogo({ text: args.join(' ') }), 'BA Logo', '🎨', '<text>'));

  cmd(['banner-blur', 'bannerblur'], { desc: 'Buat banner blur keren', category: 'MAKER' },
    _makerImg(args => nx.maker.bannerBlur({ text: args.join(' ') }), 'Banner Blur', '🖼️', '<text>'));

  cmd(['maker-card', 'mcard'], { desc: 'Buat kartu ucapan', category: 'MAKER' },
    _makerImg(args => nx.maker.card({ text: args.join(' ') }), 'Maker Card', '🃏', '<text>'));

  cmd(['fakechat', 'fake-chat'], { desc: 'Buat fake chat WhatsApp', category: 'MAKER' },
    _makerImg(args => nx.maker.fakechat({ text: args.join(' ') }), 'Fake Chat WA', '💬', '<text>'));

  cmd(['fakegram', 'fake-gram'], { desc: 'Buat fake Instagram post (username + text)', category: 'MAKER' }, async (sock, msg, args) => {
    if (args.length < 2) return _noArgs(sock, msg, 'fakegram <username> <text>');
    await react(sock, msg, '📸');
    try {
      const r = await nx.maker.fakegram({ username: args[0], text: args.slice(1).join(' ') });
      const m = await _media(r, axios);
      if (m) { await _sendImg(sock, msg, m.buf, '📸 *Fake Instagram*'); await react(sock, msg, '✅'); }
      else throw new Error('No image returned');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['faketweet', 'fake-tweet'], { desc: 'Buat fake tweet (username + text)', category: 'MAKER' }, async (sock, msg, args) => {
    if (args.length < 2) return _noArgs(sock, msg, 'faketweet <username> <text>');
    await react(sock, msg, '🐦');
    try {
      const r = await nx.maker.faketweet({ username: args[0], text: args.slice(1).join(' ') });
      const m = await _media(r, axios);
      if (m) { await _sendImg(sock, msg, m.buf, '🐦 *Fake Tweet*'); await react(sock, msg, '✅'); }
      else throw new Error('No image returned');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['kaligrafi'], { desc: 'Buat kaligrafi dari teks Arab', category: 'MAKER' },
    _makerImg(args => nx.maker.kaligrafi({ text: args.join(' ') }), 'Kaligrafi', '🕌', '<text-arab>'));

  cmd(['kartunama', 'name-card'], { desc: 'Buat kartu nama', category: 'MAKER' },
    _makerImg(args => nx.maker.kartunama({ text: args.join(' ') }), 'Kartu Nama', '💼', '<text>'));

  cmd(['maker-meme', 'mmeme'], { desc: 'Buat meme dari teks', category: 'MAKER' },
    _makerImg(args => nx.maker.meme({ text: args.join(' ') }), 'Meme Maker', '😂', '<top|bottom>'));

  cmd(['nulis', 'handwriting'], { desc: 'Konversi teks ke tulisan tangan', category: 'MAKER' },
    _makerImg(args => nx.maker.nulis({ text: args.join(' ') }), 'Nulis (Handwriting)', '✍️', '<text>'));

  cmd(['maker-profil', 'mprofil'], { desc: 'Buat profil keren (url + text)', category: 'MAKER' }, async (sock, msg, args) => {
    if (args.length < 2) return _noArgs(sock, msg, 'maker-profil <image-url> <text>');
    await react(sock, msg, '👤');
    try {
      const r = await nx.maker.profil({ url: args[0], text: args.slice(1).join(' ') });
      const m = await _media(r, axios);
      if (m) { await _sendImg(sock, msg, m.buf, '👤 *Profil Maker*'); await react(sock, msg, '✅'); }
      else throw new Error('No image returned');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['qrcode', 'make-qr'], { desc: 'Buat QR code dari teks/link', category: 'MAKER' },
    _makerImg(args => nx.maker.qrcode({ text: args.join(' ') }), 'QR Code', '📱', '<text/url>'));

  cmd(['maker-quote', 'mquote'], { desc: 'Buat gambar quote keren', category: 'MAKER' },
    _makerImg(args => nx.maker.quote({ text: args.join(' ') }), 'Quote Maker', '💬', '<text>'));

  cmd(['sertifikat', 'certificate'], { desc: 'Buat sertifikat', category: 'MAKER' },
    _makerImg(args => nx.maker.sertifikat({ text: args.join(' ') }), 'Sertifikat', '🏆', '<name>'));

  cmd(['maker-sticker', 'msticker'], { desc: 'Buat sticker dari teks', category: 'MAKER' },
    _makerImg(args => nx.maker.sticker({ text: args.join(' ') }), 'Sticker Maker', '🎭', '<text>'));

  cmd(['storify', 'story-maker'], { desc: 'Buat gambar story dari teks', category: 'MAKER' },
    _makerImg(args => nx.maker.storify({ text: args.join(' ') }), 'Storify', '📱', '<text>'));

  cmd(['tiktokcrd', 'tt-card'], { desc: 'Buat TikTok card', category: 'MAKER' },
    _makerImg(args => nx.maker.tiktokcrd({ text: args.join(' ') }), 'TikTok Card', '🎵', '<text>'));

  cmd(['watermark', 'add-watermark'], { desc: 'Tambah watermark ke gambar', category: 'MAKER' }, async (sock, msg, args) => {
    if (args.length < 2) return _noArgs(sock, msg, 'watermark <image-url> <text>');
    await react(sock, msg, '💧');
    try {
      const r = await nx.maker.watermark({ url: args[0], text: args.slice(1).join(' ') });
      const m = await _media(r, axios);
      if (m) { await _sendImg(sock, msg, m.buf, '💧 *Watermark*'); await react(sock, msg, '✅'); }
      else throw new Error('No image returned');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['welcome-card', 'welcomecard'], { desc: 'Buat kartu welcome grup', category: 'MAKER' },
    _makerImg(args => nx.maker.welcome({ text: args.join(' ') }), 'Welcome Card', '👋', '<text>'));

  cmd(['ytthumb', 'yt-thumbnail'], { desc: 'Buat YouTube thumbnail', category: 'MAKER' },
    _makerImg(args => nx.maker.ytthumb({ text: args.join(' ') }), 'YouTube Thumbnail', '🎬', '<text>'));

  cmd(['ytcard', 'yt-card'], { desc: 'Buat YouTube card', category: 'MAKER' },
    _makerImg(args => nx.maker.ytcard({ text: args.join(' ') }), 'YouTube Card', '▶️', '<text>'));

  // ═══════════════════════════════════════════════════════════════════════════
  // 💳  PAYMENT  — 3 endpoints
  // ═══════════════════════════════════════════════════════════════════════════

  cmd(['qris', 'make-qris'], { desc: 'Buat QRIS dari gambar/url', category: 'TOOLS' }, async (sock, msg, args) => {
    await react(sock, msg, '💳');
    try {
      let r;
      if (args[0] && args[0].startsWith('http')) {
        r = await nx.payment.qris({ url: args[0] });
      } else {
        const imgBuf = await _getImgFromMsg(msg, downloadContentFromMessage);
        if (!imgBuf) return sendReply(sock, msg, '⚠️ Reply to a QRIS image, or send /qris <url>');
        r = await nx.payment.qris({ file: imgBuf });
      }
      const m = await _media(r, axios);
      if (m) { await _sendImg(sock, msg, m.buf, '💳 *QRIS*'); await react(sock, msg, '✅'); }
      else { const t = _jsonFmt(r); await sendReply(sock, msg, `💳 *QRIS*\n\n${t || 'Done'}`); await react(sock, msg, '✅'); }
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['saweria-cek', 'saweria-check'], { desc: 'Cek donasi Saweria', category: 'TOOLS' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'saweria-cek <username>');
    await react(sock, msg, '💰');
    try {
      const r = await nx.payment.saweriaCheck({ username: args[0] });
      const t = _jsonFmt(r); if (!t) throw new Error('No data');
      await sendReply(sock, msg, `💰 *Saweria: ${args[0]}*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['saweria-donate', 'saweria-dl'], { desc: 'Donasi via Saweria', category: 'TOOLS' }, async (sock, msg, args) => {
    if (args.length < 2) return _noArgs(sock, msg, 'saweria-donate <username> <amount>');
    await react(sock, msg, '💸');
    try {
      const r = await nx.payment.saweriaDonate({ username: args[0], amount: args[1] });
      const t = _jsonFmt(r); if (!t) throw new Error('No data');
      await sendReply(sock, msg, `💸 *Saweria Donate*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 🔮  PRIMBON  — 10 endpoints
  // ═══════════════════════════════════════════════════════════════════════════

  cmd(['arti-nama', 'artinama'], { desc: 'Arti nama berdasarkan primbon Jawa', category: 'FUN' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'arti-nama <nama>');
    await react(sock, msg, '🔮');
    try {
      const r = await nx.primbon.artinama({ name: args.join(' ') });
      const t = _jsonFmt(r); if (!t) throw new Error('No data');
      await sendReply(sock, msg, `🔮 *Arti Nama: ${args.join(' ')}*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['nomer-hoki', 'nomerhoki'], { desc: 'Nomer hoki berdasarkan nama', category: 'FUN' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'nomer-hoki <nama>');
    await react(sock, msg, '🎰');
    try {
      const r = await nx.primbon.nomerhoki({ name: args.join(' ') });
      const t = _jsonFmt(r); if (!t) throw new Error('No data');
      await sendReply(sock, msg, `🎰 *Nomer Hoki: ${args.join(' ')}*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['ramalan-bintang', 'zodiak'], { desc: 'Ramalan bintang/zodiak', category: 'FUN' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'ramalan-bintang <zodiak>');
    await react(sock, msg, '⭐');
    try {
      const r = await nx.primbon.ramalanbintang({ bintang: args.join(' ') });
      const t = _jsonFmt(r); if (!t) throw new Error('No data');
      await sendReply(sock, msg, `⭐ *Ramalan Bintang: ${args.join(' ')}*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['ramalan-jodoh', 'jodoh'], { desc: 'Ramalan jodoh dua nama', category: 'FUN' }, async (sock, msg, args) => {
    if (args.length < 2) return _noArgs(sock, msg, 'ramalan-jodoh <nama1> <nama2>');
    await react(sock, msg, '❤️');
    try {
      const r = await nx.primbon.ramalanjodoh({ name1: args[0], name2: args.slice(1).join(' ') });
      const t = _jsonFmt(r); if (!t) throw new Error('No data');
      await sendReply(sock, msg, `❤️ *Ramalan Jodoh*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['ramalan-mimpi', 'tafsirmimpi'], { desc: 'Tafsir ramalan mimpi', category: 'FUN' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'ramalan-mimpi <mimpi>');
    await react(sock, msg, '😴');
    try {
      const r = await nx.primbon.ramalanmimpi({ text: args.join(' ') });
      const t = _jsonFmt(r); if (!t) throw new Error('No data');
      await sendReply(sock, msg, `😴 *Ramalan Mimpi*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['ramalan-nama', 'ramalannama'], { desc: 'Ramalan berdasarkan nama', category: 'FUN' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'ramalan-nama <nama>');
    await react(sock, msg, '🔮');
    try {
      const r = await nx.primbon.ramalannama({ name: args.join(' ') });
      const t = _jsonFmt(r); if (!t) throw new Error('No data');
      await sendReply(sock, msg, `🔮 *Ramalan Nama: ${args.join(' ')}*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['ramalan-rezeki', 'rezeki'], { desc: 'Ramalan rezeki berdasarkan nama', category: 'FUN' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'ramalan-rezeki <nama>');
    await react(sock, msg, '💰');
    try {
      const r = await nx.primbon.ramalanrezeki({ name: args.join(' ') });
      const t = _jsonFmt(r); if (!t) throw new Error('No data');
      await sendReply(sock, msg, `💰 *Ramalan Rezeki: ${args.join(' ')}*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['ramalan-shio', 'shio'], { desc: 'Ramalan shio berdasarkan tahun', category: 'FUN' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'ramalan-shio <tahun>');
    await react(sock, msg, '🐉');
    try {
      const r = await nx.primbon.ramalanshio({ year: args[0] });
      const t = _jsonFmt(r); if (!t) throw new Error('No data');
      await sendReply(sock, msg, `🐉 *Ramalan Shio ${args[0]}*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['weton', 'ramalan-weton'], { desc: 'Ramalan weton Jawa', category: 'FUN' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'weton <tanggal-lahir>');
    await react(sock, msg, '🗓️');
    try {
      const r = await nx.primbon.ramalanweton({ date: args.join(' ') });
      const t = _jsonFmt(r); if (!t) throw new Error('No data');
      await sendReply(sock, msg, `🗓️ *Ramalan Weton*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['ramalan-zodiak', 'zodiak2'], { desc: 'Ramalan zodiak berdasarkan tanggal lahir', category: 'FUN' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'ramalan-zodiak <tanggal-lahir>');
    await react(sock, msg, '♈');
    try {
      const r = await nx.primbon.ramalanzodiak({ date: args.join(' ') });
      const t = _jsonFmt(r); if (!t) throw new Error('No data');
      await sendReply(sock, msg, `♈ *Ramalan Zodiak*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 🎲  RANDOM  — 10 endpoints
  // ═══════════════════════════════════════════════════════════════════════════

  const _random = (fn, label, emoji, isImg = false) => async (sock, msg, args) => {
    await react(sock, msg, emoji);
    try {
      const r = await fn();
      if (isImg) {
        const m = await _media(r, axios);
        if (m) { await _sendImg(sock, msg, m.buf, `${emoji} *${label}*`); }
        else { const t = _jsonFmt(r); await sendReply(sock, msg, `${emoji} *${label}*\n\n${t || 'No image'}`); }
      } else {
        const t = _jsonFmt(r); if (!t) throw new Error('No data');
        await sendReply(sock, msg, `${emoji} *${label}*\n\n${t}`);
      }
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  };

  cmd(['random-anime', 'ranime'], { desc: 'Random anime image', category: 'FUN' }, _random(() => nx.random.anime(), 'Random Anime', '🎌', true));
  cmd(['random-ba', 'rba'], { desc: 'Random Blue Archive image', category: 'FUN' }, _random(() => nx.random.ba(), 'Random BA', '🎮', true));
  cmd(['random-cat', 'rcat'], { desc: 'Random cat image', category: 'FUN' }, _random(() => nx.random.cat(), 'Random Cat', '🐱', true));
  cmd(['random-dog', 'rdog'], { desc: 'Random dog image', category: 'FUN' }, _random(() => nx.random.dog(), 'Random Dog', '🐶', true));
  cmd(['random-fact', 'rfact'], { desc: 'Random fact', category: 'FUN' }, _random(() => nx.random.fact(), 'Random Fact', '💡'));
  cmd(['random-fox', 'rfox'], { desc: 'Random fox image', category: 'FUN' }, _random(() => nx.random.fox(), 'Random Fox', '🦊', true));
  cmd(['random-meme', 'rmeme'], { desc: 'Random meme image', category: 'FUN' }, _random(() => nx.random.meme(), 'Random Meme', '😂', true));
  cmd(['random-quote', 'rquote'], { desc: 'Random quote', category: 'FUN' }, _random(() => nx.random.quote(), 'Random Quote', '💬'));
  cmd(['random-waifu', 'rwaifu'], { desc: 'Random waifu image', category: 'FUN' }, _random(() => nx.random.waifu(), 'Random Waifu', '🎌', true));
  cmd(['random-word', 'rword'], { desc: 'Random word of the day', category: 'FUN' }, _random(() => nx.random.word(), 'Random Word', '📖'));

  // ═══════════════════════════════════════════════════════════════════════════
  // 🔍  SEARCH  — 34 endpoints
  // ═══════════════════════════════════════════════════════════════════════════

  const _search = (fn, label, emoji, argKey = 'text') => async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, `search-${label.toLowerCase().replace(/ /g,'-')} <query>`);
    await react(sock, msg, emoji);
    try {
      const q = args.join(' ');
      const param = { text: q, query: q, q };
      param[argKey] = q;
      const r = await fn(param);
      const t = _jsonFmt(r); if (!t) throw new Error('No results');
      await sendReply(sock, msg, `${emoji} *${label}*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  };

  cmd(['search-font8', 'font8'], { desc: 'Search fonts on 8font', category: 'SEARCH' }, _search(o => nx.search.font8(o), '8Font Search', '🔤'));
  cmd(['search-applemusic', 'srch-amusic'], { desc: 'Search Apple Music', category: 'SEARCH' }, _search(o => nx.search.applemusic(o), 'Apple Music Search', '🍎', 'query'));
  cmd(['search-apkpure', 'srch-apk'], { desc: 'Search APK on APKPure', category: 'SEARCH' }, _search(o => nx.search.apkpure(o), 'APKPure Search', '📱'));
  cmd(['search-canva', 'srch-canva'], { desc: 'Search templates on Canva', category: 'SEARCH' }, _search(o => nx.search.canva(o), 'Canva Search', '🎨'));
  cmd(['search-capcut', 'srch-capcut'], { desc: 'Search CapCut templates', category: 'SEARCH' }, _search(o => nx.search.capcut(o), 'CapCut Search', '🎬'));
  cmd(['search-deezer', 'srch-deezer'], { desc: 'Search music on Deezer', category: 'SEARCH' }, _search(o => nx.search.deezer(o), 'Deezer Search', '🎵'));
  cmd(['search-font', 'srch-font'], { desc: 'Search fonts', category: 'SEARCH' }, _search(o => nx.search.font(o), 'Font Search', '🔤'));
  cmd(['search-github', 'srch-github'], { desc: 'Search GitHub repositories', category: 'SEARCH' }, _search(o => nx.search.github(o), 'GitHub Search', '💻'));
  cmd(['search-google', 'srch-google'], { desc: 'Search on Google', category: 'SEARCH' }, _search(o => nx.search.google(o), 'Google Search', '🔍', 'query'));
  cmd(['search-gimage', 'srch-gimg'], { desc: 'Search Google Images', category: 'SEARCH' }, _search(o => nx.search.googleImages(o), 'Google Images', '🖼️', 'query'));
  cmd(['search-scholar', 'srch-scholar'], { desc: 'Search Google Scholar papers', category: 'SEARCH' }, _search(o => nx.search.googleScholar(o), 'Google Scholar', '📚', 'query'));
  cmd(['search-gnews', 'srch-gnews'], { desc: 'Search Google News', category: 'SEARCH' }, _search(o => nx.search.googlenews(o), 'Google News', '📰', 'query'));
  cmd(['search-instagram', 'srch-ig'], { desc: 'Search Instagram users', category: 'SEARCH' }, _search(o => nx.search.instagram(o), 'Instagram Search', '📸'));
  cmd(['search-islamqa', 'islamqa'], { desc: 'Search Islamic Q&A', category: 'SEARCH' }, _search(o => nx.search.islamqa(o), 'IslamQA Search', '☪️'));
  cmd(['search-jkt48', 'jkt48'], { desc: 'Search JKT48 info', category: 'SEARCH' }, _search(o => nx.search.jkt48(o), 'JKT48 Search', '🎤'));
  // Lyrics: NexRay /search/lyrics?q= with LRCLIB fallback. The old nexray lirik route now returns 404 "Endpoint not found".
  const _lyricsCmd = (usage, emoji) => async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, `${usage} <song title>`);
    await react(sock, msg, emoji);
    try {
      const found = await LYRICS.resolveLyrics(args.join(' '));
      // Music card: cover art with the lyrics as one caption. Text-only when no artwork is found.
      let art = null;
      try { art = await LYRICS.fetchArtwork(found.title, found.artist); } catch { art = null; }
      let buf = null;
      if (art) {
        try {
          const r = await axios.get(art, { responseType: 'arraybuffer', timeout: 15000, validateStatus: () => true });
          if (r.status < 400 && r.data && r.data.byteLength > 500) buf = Buffer.from(r.data);
        } catch { buf = null; }
      }
      if (buf) {
        await _sendImg(sock, msg, buf, LYRICS.buildLyricsCaption(found));
      } else {
        await sendReply(sock, msg, LYRICS.formatLyricsMessage(found));
      }
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  };
  cmd(['search-lirik', 'srch-lirik'], { desc: 'Search song lyrics', category: 'SEARCH' }, _lyricsCmd('search-lirik', '🎵'));
  cmd(['lyrics', 'srch-lyrics'], { desc: 'Search song lyrics (English)', category: 'Nexray-Search' }, _lyricsCmd('lyrics', '🎶'));
  cmd(['search-npm', 'srch-npm'], { desc: 'Search NPM packages', category: 'SEARCH' }, _search(o => nx.search.npm(o), 'NPM Search', '📦'));
  cmd(['search-pinterest', 'srch-pin'], { desc: 'Search Pinterest images', category: 'SEARCH' }, _search(o => nx.search.pinterest(o), 'Pinterest Search', '📌'));
  cmd(['search-playstore', 'srch-play'], { desc: 'Search Google Play Store apps', category: 'SEARCH' }, _search(o => nx.search.playstore(o), 'Play Store Search', '📱'));
  cmd(['search-reddit', 'srch-reddit'], { desc: 'Search Reddit posts', category: 'SEARCH' }, _search(o => nx.search.reddit(o), 'Reddit Search', '🤖'));
  cmd(['search-shopee', 'srch-shopee'], { desc: 'Search products on Shopee', category: 'SEARCH' }, _search(o => nx.search.shopee(o), 'Shopee Search', '🛒'));
  cmd(['search-soundcloud', 'srch-sc'], { desc: 'Search SoundCloud tracks', category: 'SEARCH' }, _search(o => nx.search.soundcloud(o), 'SoundCloud Search', '🎵'));
  cmd(['search-spotify', 'srch-spotify'], { desc: 'Search Spotify tracks', category: 'SEARCH' }, _search(o => nx.search.spotify(o), 'Spotify Search', '🎵'));
  cmd(['search-stickerwa', 'srch-sticker'], { desc: 'Search WhatsApp stickers', category: 'SEARCH' }, _search(o => nx.search.stickerwa(o), 'Sticker WA Search', '🎭'));
  cmd(['search-tiktok', 'srch-tt'], { desc: 'Search TikTok videos', category: 'SEARCH' }, _search(o => nx.search.tiktok(o), 'TikTok Search', '🎵'));
  cmd(['search-twitter', 'srch-x'], { desc: 'Search Twitter/X posts', category: 'SEARCH' }, _search(o => nx.search.twitter(o), 'Twitter/X Search', '🐦'));
  cmd(['search-wikipedia', 'wiki'], { desc: 'Search Wikipedia', category: 'SEARCH' }, _search(o => nx.search.wikipedia(o), 'Wikipedia', '📖'));
  cmd(['search-wiktionary', 'wiktionary'], { desc: 'Search Wiktionary dictionary', category: 'SEARCH' }, _search(o => nx.search.wiktionary(o), 'Wiktionary', '📖'));
  cmd(['search-youtube', 'srch-yt'], { desc: 'Search YouTube videos', category: 'SEARCH' }, _search(o => nx.search.youtube(o), 'YouTube Search', '▶️'));
  cmd(['search-ytmusic', 'srch-ytm'], { desc: 'Search YouTube Music', category: 'SEARCH' }, _search(o => nx.search.youtubeMusic(o), 'YouTube Music Search', '🎵'));
  cmd(['search-bukalapak', 'srch-buka'], { desc: 'Search products on Bukalapak', category: 'SEARCH' }, _search(o => nx.search.bukalapak(o), 'Bukalapak Search', '🛒'));
  cmd(['search-tokopedia', 'srch-toped'], { desc: 'Search products on Tokopedia', category: 'SEARCH' }, _search(o => nx.search.tokopedia(o), 'Tokopedia Search', '🛒'));
  cmd(['search-wallpaper', 'wallpaper'], { desc: 'Search wallpapers', category: 'SEARCH' }, _search(o => nx.search.wallpaper(o), 'Wallpaper Search', '🖼️'));

  // ═══════════════════════════════════════════════════════════════════════════
  // 👁️  STALKER  — 15 endpoints
  // ═══════════════════════════════════════════════════════════════════════════

  cmd(['stalk-ff', 'ffstalk', 'freefireid'], { desc: 'Stalk Free Fire player by UID — .stalk-ff <uid> [region]', category: 'STALKER' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'stalk-ff <uid> [region]  e.g. stalk-ff 123456789 IND');
    await react(sock, msg, '🎮');
    const uid    = String(args[0]).replace(/[^0-9]/g, '');
    const region = (args[1] || 'IND').toUpperCase();
    const _s = (v, def = 'N/A') => (v !== null && v !== undefined && v !== '' && v !== 'null') ? String(v) : def;
    const _n = (v, def = 'N/A') => (v !== null && v !== undefined && v !== '') ? Number(v).toLocaleString() : def;
    try {
      const r = await nx.stalker.freefire({ uid, region });
      if (!r || r.status === false) throw new Error(r?.message || r?.error || 'No data returned');
      // Support both flat and nested API shapes
      const top  = r?.result || r?.data || r;
      const _ai  = top?.basicInfo        || top?.AccountInfo        || {};
      const _api = top?.AccountProfileInfo || top?.profileInfo      || {};
      const _si  = top?.socialInfo       || top?.SocialInfo         || {};
      const _gi  = top?.clanBasicInfo    || top?.GuildInfo          || top?.guildInfo || {};
      const _pi  = top?.petInfo          || top?.PetInfo            || {};
      const _ci  = top?.creditScoreInfo  || top?.CreditScoreInfo    || {};
      const _raw = (typeof top?.raw_data === 'string' ? (() => { try { return JSON.parse(top.raw_data); } catch { return {}; } })() : top?.raw_data) || {};
      // Core fields — prefer nested then flat
      const ffName    = _s(_ai.nickname || _ai.name || top.name || top.nickname);
      const ffUid     = _s(_ai.accountId || _ai.uid || top.uid || uid);
      const ffLevel   = _s(_ai.level || top.level);
      const ffExp     = _n(_ai.exp || top.exp || top.experience);
      const ffRegion  = _s(_ai.region || top.region || region);
      const ffLikes   = _n(_si.liked || _si.likeCount || top.likes);
      const ffSig     = _s(_si.signature || _si.bio || top.signature || top.bio);
      const ffTitle   = _s(_ai.title || top.title);
      const ffSeason  = _s(_ai.seasonId || _api.seasonId || top.season_id || top.seasonId);
      const ffVersion = _s(top.releaseVersion || top.release_version || _raw.ReleaseVersion);
      const ffGender  = _s(_si.gender || top.gender || '').replace(/Gender_/i,'').toLowerCase();
      const ffMode    = _s(_si.modePrefer || top.mode_prefer || '').replace(/ModePrefer_/i,'');
      const ffBadges  = _s(_ai.badgeCnt || _ai.AccountBadgeCnt || top.badge_count || top.badgeCount);
      const ffCredit  = _s(_ci.creditScore || top.credit_score);
      const ffPrime   = _s(top.primeStatus || top.prime || _ai.primeStatus);
      // Rank
      const brPts   = _n(_api.BrRankPoint   || _ai.rankingPoints    || top.br_rank_point);
      const brPeak  = _s(_api.BrMaxRank      || top.br_max_rank      || top.brMaxRank);
      const csPts   = _n(_api.CsRankPoint   || _ai.csRankingPoints  || top.cs_rank_point);
      const csPeak  = _s(_api.CsMaxRank      || top.cs_max_rank      || top.csMaxRank);
      // Guild / Clan
      const gName   = _s(_gi.clanName || _gi.GuildName || top.guild_name || top.clanName || top.clan);
      const gLevel  = _s(_gi.clanLevel || _gi.GuildLevel || top.guild_level);
      const gMem    = _gi.memberNum || _gi.GuildMember || top.guild_member || top.guild_members;
      const gCap    = _gi.clanCapacity || _gi.GuildCapacity || top.guild_capacity;
      const gMemStr = gMem ? `${gMem}${gCap ? '/'+gCap : ''}` : 'N/A';
      const gLeader = _s(top.guild_leader_name || _raw.GuildLeaderName);
      const gLeaderLv = _s(top.guild_leader_level || _raw.GuildLeaderLevel);
      // Pet
      const petName = _s(_pi.name || _pi.PetName || top.pet_name);
      const petLv   = _s(_pi.level || _pi.PetLevel || top.pet_level);
      const petExp  = _n(_pi.exp || _pi.PetExp || top.pet_exp);
      const petSkill= _s(_pi.skillName || top.pet_skill);
      // Last login + joined date
      const _fmtTs = (v) => {
        if (!v) return 'N/A';
        const n = Number(v);
        if (isNaN(n) || n === 0) return 'N/A';
        const ms = n < 1e10 ? n * 1000 : n;
        const d = new Date(ms);
        if (isNaN(d.getTime())) return 'N/A';
        return d.toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' });
      };
      // Try every possible field-name variant the nexray /stalker/freefire endpoint may use
      const lastLogin = _fmtTs(
        top.lastLoginAt      || top.LastLoginAt      || top.lastLogin      ||
        top.last_login       || top.last_login_at    || top.loginAt        ||
        _ai.lastLoginAt      || _ai.LastLoginAt      || _ai.lastLogin      ||
        _ai.last_login       || _raw.AccountLastLoginTime || _raw.lastLoginAt ||
        _raw.lastLogin
      );
      const joinedAt = _fmtTs(
        top.createAt         || top.CreateAt         || top.createdAt      ||
        top.created_at       || top.accountCreated   || top.joinedAt       ||
        top.joined_at        || top.create_at        ||
        _ai.createAt         || _ai.CreateAt         || _ai.createdAt      ||
        _ai.created_at       || _raw.AccountCreateTime || _raw.createAt    ||
        _raw.created_at
      );

      const out =
`🔫 *FREE FIRE ACCOUNT INFO*
━━━━━━━━━━━━━━━━━━━━━━━━━━━
👤 *Name:* ${ffName}
🆔 *UID:* ${ffUid}
🌍 *Region:* ${ffRegion}
🎯 *Level:* ${ffLevel}
⭐ *EXP:* ${ffExp}
❤️ *Likes:* ${ffLikes}
${ffTitle !== 'N/A' ? '🎖️ *Title:* ' + ffTitle + '\n' : ''}${ffSeason !== 'N/A' ? '🏅 *Season:* ' + ffSeason + '\n' : ''}${ffVersion !== 'N/A' ? '📦 *Version:* ' + ffVersion + '\n' : ''}${ffPrime !== 'N/A' ? '💎 *Prime:* ' + ffPrime + '\n' : ''}${ffBadges !== 'N/A' ? '🏆 *Badges:* ' + ffBadges + '\n' : ''}
━━━━━━━━━━━━━━━━━━━━━━━━━━━
🎮 *RANKED STATS*
🏆 *BR Points:* ${brPts}  |  Peak: ${brPeak}
⚔️ *CS Points:* ${csPts}  |  Peak: ${csPeak}
${ffGender ? '⚥ *Gender:* ' + ffGender + '\n' : ''}${ffMode && ffMode !== 'N/A' ? '🕹️ *Mode Pref:* ' + ffMode + '\n' : ''}
━━━━━━━━━━━━━━━━━━━━━━━━━━━
🛡️ *GUILD / CLAN*
🏰 *Name:* ${gName}
📊 *Level:* ${gLevel}  |  👥 *Members:* ${gMemStr}
${gLeader !== 'N/A' ? '👑 *Leader:* ' + gLeader + (gLeaderLv !== 'N/A' ? ' (Lv.' + gLeaderLv + ')' : '') + '\n' : ''}
━━━━━━━━━━━━━━━━━━━━━━━━━━━
🐾 *PET*
🐕 *Name:* ${petName}  |  📈 *Level:* ${petLv}  |  ✨ *EXP:* ${petExp}
${petSkill !== 'N/A' ? '🎯 *Pet Skill:* ' + petSkill + '\n' : ''}
━━━━━━━━━━━━━━━━━━━━━━━━━━━
📋 *OTHER INFO*
💳 *Credit Score:* ${ffCredit}
🕐 *Last Login:* ${lastLogin}
📅 *Joined FF:* ${joinedAt}
${ffSig !== 'N/A' ? '💬 *Bio:* ' + ffSig : ''}`.trim();

      await sendReply(sock, msg, out);
      await react(sock, msg, '✅');
    } catch (e) {
      await sendReply(sock, msg, `❌ Free Fire lookup failed: ${e.message}\nTip: ${CONFIG.PREFIX}stalk-ff <uid> [IND|BR|VN|TH|ID|SG|MY|PH]`);
      await react(sock, msg, '❌');
    }
  });

    cmd(['stalk-genshin', 'genshinstalk'], { desc: 'Stalk Genshin Impact player by UID', category: 'STALKER' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'stalk-genshin <uid>');
    await react(sock, msg, '⚔️');
    try {
      const r = await nx.stalker.genshin({ uid: args[0] });
      const t = _jsonFmt(r); if (!t) throw new Error('No data');
      await sendReply(sock, msg, `⚔️ *Genshin: ${args[0]}*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['stalk-github', 'githubstalk'], { desc: 'Stalk GitHub user profile', category: 'STALKER' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'stalk-github <username>');
    await react(sock, msg, '💻');
    try {
      const r = await nx.stalker.github({ username: args[0] });
      const t = _jsonFmt(r); if (!t) throw new Error('No data');
      await sendReply(sock, msg, `💻 *GitHub: @${args[0]}*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['stalk-ig', 'igstalk', 'instagramstalk'], { desc: 'Stalk Instagram user profile', category: 'STALKER' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'stalk-ig <username>');
    await react(sock, msg, '📸');
    try {
      const r = await nx.stalker.instagram({ username: args[0] });
      const t = _jsonFmt(r); if (!t) throw new Error('No data');
      await sendReply(sock, msg, `📸 *Instagram: @${args[0]}*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['stalk-ml', 'mlstalk', 'mobilelegendsstalk'], { desc: 'Stalk Mobile Legends player by ID+ZoneID', category: 'STALKER' }, async (sock, msg, args) => {
    if (args.length < 2) return _noArgs(sock, msg, 'stalk-ml <id> <zone-id>');
    await react(sock, msg, '🎮');
    try {
      const r = await nx.stalker.ml({ id: args[0], zoneid: args[1] });
      const t = _jsonFmt(r); if (!t) throw new Error('No data');
      await sendReply(sock, msg, `🎮 *Mobile Legends: ${args[0]}*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['stalk-npm', 'npmstalk'], { desc: 'Stalk NPM package details', category: 'STALKER' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'stalk-npm <package-name>');
    await react(sock, msg, '📦');
    try {
      const r = await nx.stalker.npm({ package: args[0] });
      const t = _jsonFmt(r); if (!t) throw new Error('No data');
      await sendReply(sock, msg, `📦 *NPM: ${args[0]}*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['stalk-pinterest', 'pinstalk'], { desc: 'Stalk Pinterest user profile', category: 'STALKER' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'stalk-pinterest <username>');
    await react(sock, msg, '📌');
    try {
      const r = await nx.stalker.pinterest({ username: args[0] });
      const t = _jsonFmt(r); if (!t) throw new Error('No data');
      await sendReply(sock, msg, `📌 *Pinterest: @${args[0]}*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['stalk-pubg', 'pubgstalk'], { desc: 'Stalk PUBG player profile', category: 'STALKER' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'stalk-pubg <username>');
    await react(sock, msg, '🎮');
    try {
      const r = await nx.stalker.pubg({ username: args[0] });
      const t = _jsonFmt(r); if (!t) throw new Error('No data');
      await sendReply(sock, msg, `🎮 *PUBG: ${args[0]}*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['stalk-reddit', 'redditstalk'], { desc: 'Stalk Reddit user profile', category: 'STALKER' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'stalk-reddit <username>');
    await react(sock, msg, '🤖');
    try {
      const r = await nx.stalker.reddit({ username: args[0] });
      const t = _jsonFmt(r); if (!t) throw new Error('No data');
      await sendReply(sock, msg, `🤖 *Reddit: u/${args[0]}*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['stalk-snackvideo', 'snackvideostalk'], { desc: 'Stalk Snack Video user', category: 'STALKER' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'stalk-snackvideo <username>');
    await react(sock, msg, '📱');
    try {
      const r = await nx.stalker.snackvideo({ username: args[0] });
      const t = _jsonFmt(r); if (!t) throw new Error('No data');
      await sendReply(sock, msg, `📱 *Snack Video: @${args[0]}*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['stalk-spotify', 'spotifystalk'], { desc: 'Stalk Spotify user profile', category: 'STALKER' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'stalk-spotify <username>');
    await react(sock, msg, '🎵');
    try {
      const r = await nx.stalker.spotify({ username: args[0] });
      const t = _jsonFmt(r); if (!t) throw new Error('No data');
      await sendReply(sock, msg, `🎵 *Spotify: ${args[0]}*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['stalk-tiktok', 'tiktokstalk'], { desc: 'Stalk TikTok user profile', category: 'STALKER' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'stalk-tiktok <username>');
    await react(sock, msg, '🎵');
    try {
      const r = await nx.stalker.tiktok({ username: args[0] });
      const t = _jsonFmt(r); if (!t) throw new Error('No data');
      await sendReply(sock, msg, `🎵 *TikTok: @${args[0]}*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['stalk-twitter', 'xstalk', 'twitterstalk'], { desc: 'Stalk Twitter/X user profile', category: 'STALKER' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'stalk-twitter <username>');
    await react(sock, msg, '🐦');
    try {
      const r = await nx.stalker.twitter({ username: args[0] });
      const t = _jsonFmt(r); if (!t) throw new Error('No data');
      await sendReply(sock, msg, `🐦 *Twitter/X: @${args[0]}*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['stalk-youtube', 'ytstalk'], { desc: 'Stalk YouTube channel', category: 'STALKER' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'stalk-youtube <username>');
    await react(sock, msg, '▶️');
    try {
      const r = await nx.stalker.youtube({ username: args[0] });
      const t = _jsonFmt(r); if (!t) throw new Error('No data');
      await sendReply(sock, msg, `▶️ *YouTube: ${args[0]}*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['stalk-wa', 'wastalk', 'whatsappstalk'], { desc: 'Stalk WhatsApp number info', category: 'STALKER' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'stalk-wa <phone-number>');
    await react(sock, msg, '📱');
    try {
      const r = await nx.stalker.whatsapp({ number: args[0] });
      const t = _jsonFmt(r); if (!t) throw new Error('No data');
      await sendReply(sock, msg, `📱 *WhatsApp: ${args[0]}*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 🔠  TEXTPRO  — 22 text effect endpoints (return images)
  // ═══════════════════════════════════════════════════════════════════════════

  const _textpro = (fn, label, emoji) => async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, `textpro-${label.toLowerCase()} <text>`);
    await react(sock, msg, emoji);
    try {
      const r = await fn({ text: args.join(' ') }); const m = await _media(r, axios);
      if (m) { await _sendImg(sock, msg, m.buf, `${emoji} *TextPro ${label}*`); await react(sock, msg, '✅'); }
      else { const t = _jsonFmt(r); await sendReply(sock, msg, `${emoji} *TextPro ${label}*\n${t || 'No image'}`); }
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  };

  cmd(['tp-avengers', 'textpro-avengers'], { desc: 'Avengers text effect', category: 'MAKER' }, _textpro(o => nx.textpro.avengers(o), 'Avengers', '🦸'));
  cmd(['tp-bear', 'textpro-bear'], { desc: 'Bear text effect', category: 'MAKER' }, _textpro(o => nx.textpro.bear(o), 'Bear', '🐻'));
  cmd(['tp-candy', 'textpro-candy'], { desc: 'Candy text effect', category: 'MAKER' }, _textpro(o => nx.textpro.candy(o), 'Candy', '🍬'));
  cmd(['tp-chrome', 'textpro-chrome'], { desc: 'Chrome text effect', category: 'MAKER' }, _textpro(o => nx.textpro.chrome(o), 'Chrome', '⚪'));
  cmd(['tp-diamond', 'textpro-diamond'], { desc: 'Diamond text effect', category: 'MAKER' }, _textpro(o => nx.textpro.diamond(o), 'Diamond', '💎'));
  cmd(['tp-fire', 'textpro-fire'], { desc: 'Fire text effect', category: 'MAKER' }, _textpro(o => nx.textpro.fire(o), 'Fire', '🔥'));
  cmd(['tp-glitch', 'textpro-glitch'], { desc: 'Glitch text effect', category: 'MAKER' }, _textpro(o => nx.textpro.glitch(o), 'Glitch', '📺'));
  cmd(['tp-gold', 'textpro-gold'], { desc: 'Gold text effect', category: 'MAKER' }, _textpro(o => nx.textpro.gold(o), 'Gold', '✨'));
  cmd(['tp-gradient', 'textpro-gradient'], { desc: 'Gradient text effect', category: 'MAKER' }, _textpro(o => nx.textpro.gradient(o), 'Gradient', '🌈'));
  cmd(['tp-ice', 'textpro-ice'], { desc: 'Ice text effect', category: 'MAKER' }, _textpro(o => nx.textpro.ice(o), 'Ice', '❄️'));
  cmd(['tp-lava', 'textpro-lava'], { desc: 'Lava text effect', category: 'MAKER' }, _textpro(o => nx.textpro.lava(o), 'Lava', '🌋'));
  cmd(['tp-lightning', 'textpro-lightning'], { desc: 'Lightning text effect', category: 'MAKER' }, _textpro(o => nx.textpro.lightning(o), 'Lightning', '⚡'));
  cmd(['tp-minecraft', 'textpro-minecraft'], { desc: 'Minecraft text effect', category: 'MAKER' }, _textpro(o => nx.textpro.minecraft(o), 'Minecraft', '⛏️'));
  cmd(['tp-neon', 'textpro-neon'], { desc: 'Neon text effect', category: 'MAKER' }, _textpro(o => nx.textpro.neon(o), 'Neon', '💡'));
  cmd(['tp-ocean', 'textpro-ocean'], { desc: 'Ocean text effect', category: 'MAKER' }, _textpro(o => nx.textpro.ocean(o), 'Ocean', '🌊'));
  cmd(['tp-phantom', 'textpro-phantom'], { desc: 'Phantom text effect', category: 'MAKER' }, _textpro(o => nx.textpro.phantom(o), 'Phantom', '👻'));
  cmd(['tp-retro', 'textpro-retro'], { desc: 'Retro text effect', category: 'MAKER' }, _textpro(o => nx.textpro.retro(o), 'Retro', '📺'));
  cmd(['tp-shadow', 'textpro-shadow'], { desc: 'Shadow text effect', category: 'MAKER' }, _textpro(o => nx.textpro.shadow(o), 'Shadow', '🌑'));
  cmd(['tp-smoke', 'textpro-smoke'], { desc: 'Smoke text effect', category: 'MAKER' }, _textpro(o => nx.textpro.smoke(o), 'Smoke', '💨'));
  cmd(['tp-space', 'textpro-space'], { desc: 'Space text effect', category: 'MAKER' }, _textpro(o => nx.textpro.space(o), 'Space', '🚀'));
  cmd(['tp-superstar', 'textpro-superstar'], { desc: 'Superstar text effect', category: 'MAKER' }, _textpro(o => nx.textpro.superstar(o), 'Superstar', '⭐'));
  cmd(['tp-unicorn', 'textpro-unicorn'], { desc: 'Unicorn text effect', category: 'MAKER' }, _textpro(o => nx.textpro.unicorn(o), 'Unicorn', '🦄'));

  // ═══════════════════════════════════════════════════════════════════════════
  // 🛠️  TOOLS  — 57 endpoints
  // ═══════════════════════════════════════════════════════════════════════════

  cmd(['alightmotion', 'alight-motion'], { desc: 'Generate Alight Motion preset', category: 'TOOLS' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'alightmotion <text>');
    await react(sock, msg, '🎬');
    try {
      const r = await nx.tools.alightmotion({ text: args.join(' ') });
      const t = _jsonFmt(r); if (!t) throw new Error('No response');
      await sendReply(sock, msg, `🎬 *Alight Motion Preset*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['blurface', 'blur-face', 'blur'], { desc: 'Blur faces or image (reply to image or pass URL)', category: 'TOOLS' }, async (sock, msg, args) => {
    const { url, buf } = await _resolveImgMedia(sock, msg, args, downloadContentFromMessage, axios, nx);
    if (!url && !buf) {
      return sendReply(sock, msg, `📌 *Usage:* ${P}blur <reply to image or url>\n_Reply to an image or provide an image URL._`);
    }
    await react(sock, msg, '😶');
    try {
      let imageBuffer = buf;
      if (!imageBuffer && url) {
        try {
          const dl = await axios.get(url, { responseType: 'arraybuffer', timeout: 15000 });
          if (dl?.data) imageBuffer = Buffer.from(dl.data);
        } catch {}
      }

      let resultBuf = null;

      // 1. Try MIAS AI face blur endpoint if URL is available
      if (url && nx?.tools?.blurface) {
        try {
          const r = await nx.tools.blurface({ url });
          const m = await _media(r, axios);
          if (m?.buf) resultBuf = m.buf;
        } catch {}
      }

      if (resultBuf) {
        await _sendImg(sock, msg, resultBuf, '😶 *Face Blurred*');
        await react(sock, msg, '✅');
        return;
      }

      // 2. Fallback: apply general image blur so blur always succeeds
      if (imageBuffer) {
        try {
          let sharp;
          try { sharp = require('sharp'); } catch {}
          if (sharp) {
            resultBuf = await sharp(imageBuffer).blur(12).toBuffer();
          }
        } catch {}

        if (!resultBuf) {
          try {
            let Jimp;
            try { Jimp = require('jimp'); } catch {}
            if (Jimp) {
              const j = await Jimp.read(imageBuffer);
              j.blur(10);
              resultBuf = await j.getBufferAsync(Jimp.MIME_JPEG);
            }
          } catch {}
        }

        if (resultBuf) {
          await _sendImg(sock, msg, resultBuf, '😶 *Image Blurred*');
          await react(sock, msg, '✅');
          return;
        }
      }

      throw new Error('Failed to blur image. Please ensure the image is accessible and try again.');
    } catch (e) {
      await sendReply(sock, msg, `❌ Error: ${e.message}`);
      await react(sock, msg, '❌');
    }
  });

  // Levanter photoEditor engine handler
  const _runLevanterPhotoEditor = async (sock, msg, args, { method, emoji, title, failMsg, cmdName }) => {
    const { url, buf } = await _resolveImgMedia(sock, msg, args, downloadContentFromMessage, axios, nx);
    if (!url && !buf) {
      return sendReply(sock, msg, `📌 *Usage:* ${P}${cmdName} <reply to image or url>\n_Reply to an image or provide an image URL._`);
    }
    await react(sock, msg, emoji);
    try {
      let targetUrl = url;
      if (!targetUrl && buf) {
        targetUrl = await _uploadImageBuf(buf, axios);
      }
      if (!targetUrl) {
        throw new Error('Could not upload image for processing. Please try again.');
      }

      const editorUrl = `https://levanter.onrender.com/editor?method=${encodeURIComponent(method)}&url=${encodeURIComponent(targetUrl)}`;
      const res = await axios.get(editorUrl, { timeout: 35000 });
      const data = res?.data;

      if (data?.status && data?.result) {
        const imgRes = await axios.get(data.result, { responseType: 'arraybuffer', timeout: 25000 });
        if (imgRes?.data) {
          await _sendImg(sock, msg, Buffer.from(imgRes.data), `${emoji} *${title}*`);
          await react(sock, msg, '✅');
          return;
        }
      }

      const errMsg = data?.result || failMsg || 'Face or subject not detected. Please use a clear portrait photo.';
      await sendReply(sock, msg, `❌ ${errMsg}`);
      await react(sock, msg, '❌');
    } catch (e) {
      await sendReply(sock, msg, `❌ Error: ${e.message}`);
      await react(sock, msg, '❌');
    }
  };

  // 1. Enhance
  cmd(['enhance', 'enhancer'], { desc: 'Enhance image quality (reply to image or pass URL)', category: 'TOOLS' }, async (sock, msg, args) => {
    return _runLevanterPhotoEditor(sock, msg, args, {
      method: 'enhance',
      emoji: '✨',
      title: 'Image Enhanced',
      failMsg: 'Failed to enhance image. Please ensure image is accessible.',
      cmdName: 'enhance'
    });
  });

  // 2. Kiss
  cmd(['kiss', 'kissme', 'kiss-photo'], { desc: 'Kiss photo effect on faces (reply to image or pass URL)', category: 'TOOLS' }, async (sock, msg, args) => {
    return _runLevanterPhotoEditor(sock, msg, args, {
      method: 'kisses_on_face_photo_effect',
      emoji: '💋',
      title: 'Kiss Photo Effect',
      failMsg: 'Face not detected in image. Please use a clear portrait photo.',
      cmdName: 'kiss'
    });
  });

  // 3. Sketch
  cmd(['sketch', 'sketch-photo'], { desc: 'Convert photo to sketch drawing (reply to image or pass URL)', category: 'TOOLS' }, async (sock, msg, args) => {
    return _runLevanterPhotoEditor(sock, msg, args, {
      method: 'sketch',
      emoji: '🎨',
      title: 'Sketch Photo Effect',
      failMsg: 'Failed to apply sketch effect. Please ensure image is accessible.',
      cmdName: 'sketch'
    });
  });

  // 4. Pencil
  cmd(['pencil', 'pencil-sketch'], { desc: 'Graphite pencil sketch effect (reply to image or pass URL)', category: 'TOOLS' }, async (sock, msg, args) => {
    return _runLevanterPhotoEditor(sock, msg, args, {
      method: 'graphite_pencil_sketch',
      emoji: '✏️',
      title: 'Pencil Sketch Effect',
      failMsg: 'Failed to apply pencil effect. Please ensure image is accessible.',
      cmdName: 'pencil'
    });
  });

  // 5. Color
  cmd(['color', 'color-sketch'], { desc: 'Color pencil sketch effect (reply to image or pass URL)', category: 'TOOLS' }, async (sock, msg, args) => {
    return _runLevanterPhotoEditor(sock, msg, args, {
      method: 'color_pencil_sketch',
      emoji: '🖍️',
      title: 'Color Sketch Effect',
      failMsg: 'Failed to apply color sketch effect. Please ensure image is accessible.',
      cmdName: 'color'
    });
  });

  // 6. Bokeh
  cmd(['bokeh', 'bokeh-effect'], { desc: 'Bokeh blur photo effect (reply to image or pass URL)', category: 'TOOLS' }, async (sock, msg, args) => {
    return _runLevanterPhotoEditor(sock, msg, args, {
      method: 'christmas_bokeh',
      emoji: '✨',
      title: 'Bokeh Photo Effect',
      failMsg: 'Failed to apply bokeh effect. Please ensure image is accessible.',
      cmdName: 'bokeh'
    });
  });

  // 7. Wanted
  cmd(['wanted', 'wanted-poster'], { desc: 'Put photo in a Wanted poster (reply to image or pass URL)', category: 'TOOLS' }, async (sock, msg, args) => {
    return _runLevanterPhotoEditor(sock, msg, args, {
      method: 'wanted',
      emoji: '📜',
      title: 'Wanted Poster Effect',
      failMsg: 'Failed to create wanted poster. Please ensure image is accessible.',
      cmdName: 'wanted'
    });
  });

  // 8. Look
  cmd(['look', 'dramatic-look'], { desc: 'Dramatic cinematic photo look (reply to image or pass URL)', category: 'TOOLS' }, async (sock, msg, args) => {
    return _runLevanterPhotoEditor(sock, msg, args, {
      method: 'dramatic_look',
      emoji: '🎭',
      title: 'Dramatic Look Effect',
      failMsg: 'Failed to apply dramatic look. Please ensure image is accessible.',
      cmdName: 'look'
    });
  });

  // 9. Gandm (Glasses & Mustache)
  cmd(['gandm', 'mustache', 'glasses-mustache'], { desc: 'Hipster glasses and mustache overlay (reply to image or pass URL)', category: 'TOOLS' }, async (sock, msg, args) => {
    return _runLevanterPhotoEditor(sock, msg, args, {
      method: 'hipster_glasses_and_mustache',
      emoji: '🥸',
      title: 'Glasses & Mustache Effect',
      failMsg: 'Face not detected. Please use a clear portrait photo.',
      cmdName: 'gandm'
    });
  });

  // 10. Dark
  cmd(['dark', 'dark-knight'], { desc: 'The Dark Knight photo effect (reply to image or pass URL)', category: 'TOOLS' }, async (sock, msg, args) => {
    return _runLevanterPhotoEditor(sock, msg, args, {
      method: 'the_dark_knight',
      emoji: '🦇',
      title: 'Dark Knight Effect',
      failMsg: 'Failed to apply dark knight effect. Please ensure image is accessible.',
      cmdName: 'dark'
    });
  });

  // 11. Makeup
  cmd(['makeup', 'beauty-makeup'], { desc: 'Beauty and makeup portrait filter (reply to image or pass URL)', category: 'TOOLS' }, async (sock, msg, args) => {
    return _runLevanterPhotoEditor(sock, msg, args, {
      method: 'makeup',
      emoji: '💄',
      title: 'Makeup Photo Effect',
      failMsg: 'Face not detected. Please use a clear portrait photo.',
      cmdName: 'makeup'
    });
  });

  // 12. Cartoon
  cmd(['cartoon', 'cartoon-photo'], { desc: 'Cartoon style portrait transformation (reply to image or pass URL)', category: 'TOOLS' }, async (sock, msg, args) => {
    return _runLevanterPhotoEditor(sock, msg, args, {
      method: 'cartoon',
      emoji: '🖼️',
      title: 'Cartoon Photo Effect',
      failMsg: 'Failed to apply cartoon effect. Please ensure image is accessible.',
      cmdName: 'cartoon'
    });
  });

  // 13. Demon
  cmd(['demon', 'demon-eyes'], { desc: 'Demon eyes photo transformation (reply to image or pass URL)', category: 'TOOLS' }, async (sock, msg, args) => {
    return _runLevanterPhotoEditor(sock, msg, args, {
      method: 'demon_eyes_effect',
      emoji: '😈',
      title: 'Demon Eyes Effect',
      failMsg: 'Face or eyes not detected. Please use a clear portrait photo.',
      cmdName: 'demon'
    });
  });

  // 14. Bloody
  cmd(['bloody', 'halloween-mask'], { desc: 'Halloween bloody mask photo effect (reply to image or pass URL)', category: 'TOOLS' }, async (sock, msg, args) => {
    return _runLevanterPhotoEditor(sock, msg, args, {
      method: 'halloween_mask',
      emoji: '🩸',
      title: 'Bloody Mask Effect',
      failMsg: 'Face not detected. Please use a clear portrait photo.',
      cmdName: 'bloody'
    });
  });

  // 15. Zombie
  cmd(['zombie', 'zombie-face'], { desc: 'Zombie horror transformation (reply to image or pass URL)', category: 'TOOLS' }, async (sock, msg, args) => {
    return _runLevanterPhotoEditor(sock, msg, args, {
      method: 'zombie',
      emoji: '🧟',
      title: 'Zombie Photo Effect',
      failMsg: 'Face not detected. Please use a clear portrait photo.',
      cmdName: 'zombie'
    });
  });

  // 16. Horned
  cmd(['horned', 'horned-goblin'], { desc: 'Horned goblin face transformation (reply to image or pass URL)', category: 'TOOLS' }, async (sock, msg, args) => {
    return _runLevanterPhotoEditor(sock, msg, args, {
      method: 'horned_goblin',
      emoji: '👺',
      title: 'Horned Goblin Effect',
      failMsg: 'Face not detected. Please use a clear portrait photo.',
      cmdName: 'horned'
    });
  });

  // 17. Skull
  cmd(['skull', 'skull-makeup'], { desc: 'Skull face makeup effect (reply to image or pass URL)', category: 'TOOLS' }, async (sock, msg, args) => {
    return _runLevanterPhotoEditor(sock, msg, args, {
      method: 'skull_makeup',
      emoji: '💀',
      title: 'Skull Makeup Effect',
      failMsg: 'Face not detected. Please use a clear portrait photo.',
      cmdName: 'skull'
    });
  });

  cmd(['brokenlink', 'check-link'], { desc: 'Check for broken links on a website', category: 'TOOLS' }, async (sock, msg, args) => {
    const url = args[0]; if (!url) return _noArgs(sock, msg, 'brokenlink <url>');
    await react(sock, msg, '🔗');
    try {
      const r = await nx.tools.brokenlink({ url });
      const t = _jsonFmt(r); if (!t) throw new Error('No response');
      await sendReply(sock, msg, `🔗 *Broken Link Check*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['currency', 'convert-currency'], { desc: 'Convert currency', category: 'TOOLS' }, async (sock, msg, args) => {
    if (args.length < 3) return _noArgs(sock, msg, 'currency <amount> <from> <to>  e.g. currency 100 USD IDR');
    await react(sock, msg, '💱');
    try {
      const r = await nx.tools.currency({ amount: args[0], from: args[1].toUpperCase(), to: args[2].toUpperCase() });
      const t = _jsonFmt(r); if (!t) throw new Error('No response');
      await sendReply(sock, msg, `💱 *Currency Converter*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['dnslookup', 'dns-lookup'], { desc: 'DNS lookup for a domain', category: 'TOOLS' }, async (sock, msg, args) => {
    const domain = args[0]; if (!domain) return _noArgs(sock, msg, 'dnslookup <domain>');
    await react(sock, msg, '🌐');
    try {
      const r = await nx.tools.dnslookup({ domain });
      const t = _jsonFmt(r); if (!t) throw new Error('No response');
      await sendReply(sock, msg, `🌐 *DNS Lookup: ${domain}*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['emojigif', 'emoji-gif'], { desc: 'Convert emoji to GIF', category: 'TOOLS' }, async (sock, msg, args) => {
    const emoji = args[0]; if (!emoji) return _noArgs(sock, msg, 'emojigif <emoji>');
    await react(sock, msg, '😀');
    try {
      const r = await nx.tools.emojigif({ emoji }); const m = await _media(r, axios);
      if (m) { await _sendImg(sock, msg, m.buf, `😀 *Emoji GIF: ${emoji}`); await react(sock, msg, '✅'); }
      else { const t = _jsonFmt(r); await sendReply(sock, msg, `😀 *Emoji GIF*\n${t || 'No result'}`); }
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['emojimix', 'emoji-mix'], { desc: 'Mix two emojis together', category: 'TOOLS' }, async (sock, msg, args) => {
    if (args.length < 2) return _noArgs(sock, msg, 'emojimix <emoji1> <emoji2>');
    await react(sock, msg, '🎨');
    try {
      const r = await nx.tools.emojimix({ emoji1: args[0], emoji2: args[1] }); const m = await _media(r, axios);
      if (m) { await _sendImg(sock, msg, m.buf, `🎨 *Emoji Mix: ${args[0]}+${args[1]}*`); await react(sock, msg, '✅'); }
      else throw new Error('No image returned');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['enhance2', 'enhancerv1'], { desc: 'Enhance image quality v1', category: 'TOOLS' }, async (sock, msg, args) => {
    const url = args[0]; if (!url) return _noArgs(sock, msg, 'enhance2 <image-url>');
    await react(sock, msg, '✨');
    try {
      const r = await nx.tools.enhancerV1({ url }); const m = await _media(r, axios);
      if (m) { await _sendImg(sock, msg, m.buf, '✨ *Image Enhanced v1*'); await react(sock, msg, '✅'); }
      else throw new Error('No image returned');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['enhance3', 'enhancerv2'], { desc: 'Enhance image quality v2', category: 'TOOLS' }, async (sock, msg, args) => {
    const url = args[0]; if (!url) return _noArgs(sock, msg, 'enhance3 <image-url>');
    await react(sock, msg, '✨');
    try {
      const r = await nx.tools.enhancerV2({ url }); const m = await _media(r, axios);
      if (m) { await _sendImg(sock, msg, m.buf, '✨ *Image Enhanced v2*'); await react(sock, msg, '✅'); }
      else throw new Error('No image returned');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['faceswap', 'face-swap'], { desc: 'Swap faces between two image URLs', category: 'TOOLS' }, async (sock, msg, args) => {
    if (args.length < 2) return _noArgs(sock, msg, 'faceswap <url1> <url2>');
    await react(sock, msg, '🔄');
    try {
      const r = await nx.tools.faceswap({ url1: args[0], url2: args[1] }); const m = await _media(r, axios);
      if (m) { await _sendImg(sock, msg, m.buf, '🔄 *Face Swap*'); await react(sock, msg, '✅'); }
      else throw new Error('No image returned');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['hd', 'hdvideo', 'hd-video'], { desc: 'Enhance video to HD quality', category: 'TOOLS' }, async (sock, msg, args) => {
    const url = args[0]; if (!url) return _noArgs(sock, msg, 'hdvideo <video-url>');
    await react(sock, msg, '📹');
    try {
      const r = await nx.tools.hdvideo({ url });
      const t = _jsonFmt(r); if (!t) throw new Error('No response');
      await sendReply(sock, msg, `📹 *HD Video*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['hdvideo2', 'hd-video2'], { desc: 'Enhance video to HD quality v1', category: 'TOOLS' }, async (sock, msg, args) => {
    const url = args[0]; if (!url) return _noArgs(sock, msg, 'hdvideo2 <video-url>');
    await react(sock, msg, '📹');
    try {
      const r = await nx.tools.hdvideoV1({ url });
      const t = _jsonFmt(r); if (!t) throw new Error('No response');
      await sendReply(sock, msg, `📹 *HD Video v1*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['html2img', 'html-to-image'], { desc: 'Convert HTML to image', category: 'TOOLS' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'html2img <html-code>');
    await react(sock, msg, '🌐');
    try {
      const r = await nx.tools.html2img({ html: args.join(' ') }); const m = await _media(r, axios);
      if (m) { await _sendImg(sock, msg, m.buf, '🌐 *HTML to Image*'); await react(sock, msg, '✅'); }
      else throw new Error('No image returned');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['img2qr', 'image-to-qr'], { desc: 'Convert image to QR code', category: 'TOOLS' }, async (sock, msg, args) => {
    const url = args[0]; if (!url) return _noArgs(sock, msg, 'img2qr <image-url>');
    await react(sock, msg, '📱');
    try {
      const r = await nx.tools.image2qr({ url }); const m = await _media(r, axios);
      if (m) { await _sendImg(sock, msg, m.buf, '📱 *Image to QR*'); await react(sock, msg, '✅'); }
      else throw new Error('No image returned');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['nikparse', 'cek-nik'], { desc: 'Parse Indonesian NIK ID number', category: 'TOOLS' }, async (sock, msg, args) => {
    const nik = args[0]; if (!nik) return _noArgs(sock, msg, 'nikparse <nik>');
    await react(sock, msg, '🪪');
    try {
      const r = await nx.tools.nikparse({ nik });
      const t = _jsonFmt(r); if (!t) throw new Error('No response');
      await sendReply(sock, msg, `🪪 *NIK Parse*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['nsfw-check', 'nsfwcheck', 'cek-nsfw'], { desc: 'Check if image contains NSFW content', category: 'TOOLS' }, async (sock, msg, args) => {
    const url = args[0]; if (!url) return _noArgs(sock, msg, 'nsfw-check <image-url>');
    await react(sock, msg, '🔞');
    try {
      const r = await nx.tools.nsfwChecker({ url });
      const t = _jsonFmt(r); if (!t) throw new Error('No response');
      await sendReply(sock, msg, `🔞 *NSFW Check*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['ocr', 'image-to-text'], { desc: 'Extract text from image (OCR)', category: 'TOOLS' }, async (sock, msg, args) => {
    const url = args[0]; if (!url) return _noArgs(sock, msg, 'ocr <image-url>');
    await react(sock, msg, '📝');
    try {
      const r = await nx.tools.ocr({ url });
      const t = _jsonFmt(r); if (!t) throw new Error('No text found');
      await sendReply(sock, msg, `📝 *OCR Result*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['remini'], { desc: 'Enhance image with Remini AI', category: 'TOOLS' }, async (sock, msg, args) => {
    const url = args[0]; if (!url) return _noArgs(sock, msg, 'remini <image-url>');
    await react(sock, msg, '✨');
    try {
      const r = await nx.tools.remini({ url }); const m = await _media(r, axios);
      if (m) { await _sendImg(sock, msg, m.buf, '✨ *Remini Enhanced*'); await react(sock, msg, '✅'); }
      else throw new Error('No image returned');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['rmbg', 'removebg', 'rmwbg', 'remove-bg', 'bgremove'], { desc: 'Remove background from image (reply to image or pass URL)', category: 'TOOLS' }, async (sock, msg, args) => {
    const { url, buf } = await _resolveImgMedia(sock, msg, args, downloadContentFromMessage, axios, nx);
    if (!url && !buf) {
      return sendReply(sock, msg, `📌 *Usage:* ${P}rmbg <reply to image or url>\n_Reply to an image or provide an image URL._`);
    }
    await react(sock, msg, '✂️');
    try {
      let imageBuffer = buf;
      if (!imageBuffer && url) {
        try {
          const dl = await axios.get(url, { responseType: 'arraybuffer', timeout: 15000 });
          if (dl?.data) imageBuffer = Buffer.from(dl.data);
        } catch {}
      }

      const apiKey = process.env.RMBG_KEY || CONFIG?.RMBG_KEY || process.env.REMOVEBG_KEY || CONFIG?.REMOVEBG_KEY;
      let resultBuf = null;

      // 1. If RMBG_KEY is configured, call Levanter remove.bg API endpoint directly
      if (apiKey) {
        try {
          let FormDataPkg;
          try { FormDataPkg = require('form-data'); } catch {
            const imp = await import('form-data');
            FormDataPkg = imp.default || imp;
          }
          const form = new FormDataPkg();
          form.append('size', 'auto');
          if (imageBuffer) {
            form.append('image_file', imageBuffer, { filename: 'image.png', contentType: 'image/png' });
          } else if (url) {
            form.append('image_url', url);
          }
          const res = await axios.post('https://api.remove.bg/v1.0/removebg', form, {
            headers: {
              'X-Api-Key': apiKey,
              ...form.getHeaders()
            },
            responseType: 'arraybuffer',
            timeout: 30000
          });
          if (res?.data && res.data.length > 50) {
            resultBuf = Buffer.from(res.data);
          }
        } catch (err) {
          console.warn('[rmbg] remove.bg API call failed, falling back to providers:', err?.message || err);
        }
      }

      // 2. Fallback providers if remove.bg key not set or failed
      if (!resultBuf && url && nx?.tools?.removebg) {
        try {
          const r = await nx.tools.removebg({ url });
          const m = await _media(r, axios);
          if (m?.buf) resultBuf = m.buf;
        } catch {}
      }

      if (!resultBuf && imageBuffer) {
        try {
          let FormDataPkg;
          try { FormDataPkg = require('form-data'); } catch {
            const imp = await import('form-data');
            FormDataPkg = imp.default || imp;
          }
          const providers = [
            'https://api.ryzendesu.vip/api/tools/removebg',
            'https://api.siputzx.my.id/api/tools/removebg'
          ];
          for (const pUrl of providers) {
            try {
              const form = new FormDataPkg();
              form.append('image', imageBuffer, { filename: 'image.jpg', contentType: 'image/jpeg' });
              const r = await axios.post(pUrl, form, {
                headers: form.getHeaders(),
                responseType: 'arraybuffer',
                timeout: 15000
              });
              if (r?.data && r.data.length > 500 && r.data[0] === 0x89) {
                resultBuf = Buffer.from(r.data);
                break;
              }
            } catch {}
          }
        } catch {}
      }

      if (!resultBuf && !apiKey) {
        return sendReply(sock, msg, `❌ *RMBG API Key Required*\n_Set RMBG_KEY in environment or remove.bg API key to use remove.bg._`);
      }

      if (resultBuf) {
        await _sendImg(sock, msg, resultBuf, '✂️ *Background Removed*');
        await react(sock, msg, '✅');
        return;
      }

      throw new Error('Failed to remove background. Please ensure image is accessible and try again.');
    } catch (e) {
      await sendReply(sock, msg, `❌ Error: ${e.message}`);
      await react(sock, msg, '❌');
    }
  });

  cmd(['removebg2', 'remove-bgv1'], { desc: 'Remove background from image v1', category: 'TOOLS' }, async (sock, msg, args) => {
    const url = args[0]; if (!url) return _noArgs(sock, msg, 'removebg2 <image-url>');
    await react(sock, msg, '✂️');
    try {
      const r = await nx.tools.removebgV1({ url }); const m = await _media(r, axios);
      if (m) { await _sendImg(sock, msg, m.buf, '✂️ *BG Removed v1*'); await react(sock, msg, '✅'); }
      else throw new Error('No image returned');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['removebg3', 'remove-bgv2'], { desc: 'Remove background from image v2', category: 'TOOLS' }, async (sock, msg, args) => {
    const url = args[0]; if (!url) return _noArgs(sock, msg, 'removebg3 <image-url>');
    await react(sock, msg, '✂️');
    try {
      const r = await nx.tools.removebgV2({ url }); const m = await _media(r, axios);
      if (m) { await _sendImg(sock, msg, m.buf, '✂️ *BG Removed v2*'); await react(sock, msg, '✅'); }
      else throw new Error('No image returned');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['removevocal', 'remove-vocal'], { desc: 'Remove vocal track from audio/video', category: 'TOOLS' }, async (sock, msg, args) => {
    const url = args[0]; if (!url) return _noArgs(sock, msg, 'removevocal <audio-url>');
    await react(sock, msg, '🎵');
    try {
      const r = await nx.tools.removevokal({ url }); const m = await _media(r, axios);
      if (m && (m.ct.includes('audio') || m.ct.includes('mp'))) {
        await _sendAudio(sock, msg, m.buf); await react(sock, msg, '✅');
      } else {
        const t = _jsonFmt(r); await sendReply(sock, msg, `🎵 *Remove Vocal*\n\n${t || 'Done'}`);
      }
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['skip-adlinksumo', 'skipadlink'], { desc: 'Skip Adlinksumo shortened link', category: 'TOOLS' }, async (sock, msg, args) => {
    const url = args[0]; if (!url) return _noArgs(sock, msg, 'skip-adlinksumo <adlinksumo-url>');
    await react(sock, msg, '⏭️');
    try {
      const r = await nx.tools.skipAdlinksumo({ url });
      const t = _jsonFmt(r); if (!t) throw new Error('No response');
      await sendReply(sock, msg, `⏭️ *Skip Adlinksumo*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['spamngl', 'spam-ngl'], { desc: 'Spam NGL link', category: 'TOOLS' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'spamngl <ngl-text>');
    await react(sock, msg, '📨');
    try {
      const r = await nx.tools.spamngl({ text: args.join(' ') });
      const t = _jsonFmt(r); if (!t) throw new Error('No response');
      await sendReply(sock, msg, `📨 *Spam NGL*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['ssweb', 'screenshot-web'], { desc: 'Take screenshot of a website', category: 'TOOLS' }, async (sock, msg, args) => {
    const url = args[0]; if (!url) return _noArgs(sock, msg, 'ssweb <url>');
    await react(sock, msg, '📸');
    try {
      const r = await nx.tools.ssweb({ url }); const m = await _media(r, axios);
      if (m) { await _sendImg(sock, msg, m.buf, `📸 *Screenshot: ${url}`); await react(sock, msg, '✅'); }
      else throw new Error('No screenshot returned');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['subdomain-finder', 'subdomainfinder'], { desc: 'Find subdomains of a domain', category: 'TOOLS' }, async (sock, msg, args) => {
    const domain = args[0]; if (!domain) return _noArgs(sock, msg, 'subdomain-finder <domain>');
    await react(sock, msg, '🌐');
    try {
      const r = await nx.tools.subdomainfinder({ domain });
      const t = _jsonFmt(r); if (!t) throw new Error('No response');
      await sendReply(sock, msg, `🌐 *Subdomain Finder: ${domain}*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  // .settoken: owner saves the Telegram bot token persistently (lib/telegramTokenStore.cjs)
  try { require('../lib/telegramTokenStore.cjs').loadIntoEnv(); } catch (_) {}
  const _setTokenHandler = require('../lib/telegramTokenCommand.cjs').createSetTokenHandler({ sendReply, react, axios });
  cmd(['settoken', 'settgtoken'], { desc: 'Save the Telegram bot token used by .tgs (owner only, kept across restarts and updates)', category: 'OWNER', ownerOnly: true }, _setTokenHandler);

  cmd(['tg-sticker', 'tgsticker', 'telegramsticker', 'tgs', 'tgstickers', 'tg-stickers'], { desc: 'Download Telegram sticker pack or convert image to Telegram sticker format', category: 'TOOLS' }, async (sock, msg, args) => {
    // 0. Load the saved token (.settoken) into the environment before resolving it
    try { require('../lib/telegramTokenStore.cjs').loadIntoEnv(); } catch (_) {}
    // 1. Resolve Telegram Bot Token from env, config, config.json, or direct .env file scan
    let tgToken = '';
    try {
      tgToken = String(process.env.TELEGRAM_BOT_TOKEN || process.env.TGS_BOT_TOKEN || process.env.TG_BOT_TOKEN || process.env.BOT_TOKEN || process.env.TELEGRAM_TOKEN || CONFIG?.TELEGRAM_BOT_TOKEN || global.TELEGRAM_BOT_TOKEN || '').trim();
    } catch {}

    if (!tgToken) {
      try {
        const fs = require('fs');
        const path = require('path');
        const jsonCandidates = [
          path.resolve(process.cwd(), 'config.json'),
          path.resolve(__dirname, '..', 'config.json'),
          path.resolve(__dirname, 'config.json')
        ];
        for (const jp of jsonCandidates) {
          if (fs.existsSync(jp)) {
            const jdata = JSON.parse(fs.readFileSync(jp, 'utf8'));
            const val = String(jdata?.TELEGRAM_BOT_TOKEN || jdata?.TGS_BOT_TOKEN || '').trim();
            if (val) {
              tgToken = val;
              process.env.TELEGRAM_BOT_TOKEN = tgToken;
              break;
            }
          }
        }
      } catch {}
    }

    if (!tgToken) {
      try {
        const fs = require('fs');
        const path = require('path');
        const candidates = [
          path.resolve(process.cwd(), '.env'),
          path.resolve(__dirname, '..', '.env'),
          path.resolve(__dirname, '.env')
        ];
        for (const cp of candidates) {
          if (fs.existsSync(cp)) {
            const lines = fs.readFileSync(cp, 'utf8').split(/\r?\n/);
            for (const line of lines) {
              const m = line.match(/^\s*(?:export\s+)?(TELEGRAM_BOT_TOKEN|TGS_BOT_TOKEN|TG_BOT_TOKEN|BOT_TOKEN)\s*=\s*(.*)$/);
              if (m) {
                let val = m[2].trim();
                if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
                  val = val.slice(1, -1).trim();
                }
                if (val) {
                  tgToken = val;
                  process.env.TELEGRAM_BOT_TOKEN = tgToken;
                  break;
                }
              }
            }
            if (tgToken) break;
          }
        }
      } catch {}
    }

    const tokenIdx = (args || []).findIndex(a => /^\d{8,12}:[A-Za-z0-9_-]{35,}$/.test(String(a || '').trim()));
    if (tokenIdx !== -1) {
      tgToken = args[tokenIdx].trim();
      args.splice(tokenIdx, 1);
    }

    const input = (args || []).join(' ').trim();
    const packMatch = input.match(/(?:https?:\/\/)?t\.me\/addstickers\/([A-Za-z0-9_]+)/i) ||
      (input && !input.startsWith('http') && /^[A-Za-z0-9_]{3,}$/.test(input) ? [null, input] : null);

    // CASE A: Telegram Sticker Pack Link or Name
    if (packMatch) {
      const packShortName = packMatch[1];
      await react(sock, msg, '🎭');

      if (!tgToken) {
        // Try fallback mirror if no token configured
        try {
          const packUrl = `https://t.me/addstickers/${packShortName}`;
          const r = await nx.tools.telegramSticker({ url: packUrl });
          const m = await _media(r, axios);
          if (m) {
            await _sendImg(sock, msg, m.buf, `🎭 *Telegram Sticker: ${packShortName}*`);
            await react(sock, msg, '✅');
            return;
          }
        } catch {}

        await sendReply(sock, msg, `🎭 *Telegram Stickers*\n⚠️ Token missing. Owner: send .settoken <bot token> to save it`);
        await react(sock, msg, '❌');
        return;
      }

      try {
        const api = `https://api.telegram.org/bot${tgToken}`;
        const res = await axios.get(`${api}/getStickerSet`, {
          params: { name: packShortName },
          timeout: 30000,
          validateStatus: () => true
        });

        if (res.data?.ok && res.data?.result) {
          const set = res.data.result;
          const packTitle = set.title || packShortName;
          const stickers = (set.stickers || []).slice(0, 15);

          if (!stickers.length) {
            return sendReply(sock, msg, `🎭 *${packTitle}*\n⚠️ No stickers found in this pack.`);
          }

          await sendReply(sock, msg, `🎭 *${packTitle}*\n⏳ Downloading ${stickers.length} stickers...`);

          let sent = 0;
          for (const item of stickers) {
            try {
              const fileRes = await axios.get(`${api}/getFile`, {
                params: { file_id: item.file_id },
                timeout: 20000
              });
              const filePath = fileRes.data?.result?.file_path;
              if (!filePath) continue;

              const fileBytes = await axios.get(`https://api.telegram.org/file/bot${tgToken}/${filePath}`, {
                responseType: 'arraybuffer',
                timeout: 25000
              });
              const rawBuf = Buffer.from(fileBytes.data);
              const stickerBuf = await _convertMediaToWebpSticker(rawBuf, filePath);

              await sock.sendMessage(msg.key.remoteJid, { sticker: stickerBuf }, { quoted: msg });
              sent++;
              await new Promise(r => setTimeout(r, 600));
            } catch (e) {
              console.error('[tgsticker] Error converting/sending sticker:', e && e.message);
            }
          }

          if (sent > 0) {
            await react(sock, msg, '✅');
            return;
          }
          await sendReply(sock, msg, `❌ *Telegram Error*\nFailed to send converted stickers.`);
          await react(sock, msg, '❌');
          return;
        } else if (res.data?.error_code === 401) {
          await sendReply(sock, msg, `❌ *Telegram Error*\nInvalid bot token. Owner: send .settoken <new token> to replace it`);
          await react(sock, msg, '❌');
          return;
        } else if (res.data?.description) {
          await sendReply(sock, msg, `❌ *Telegram Error*\n${res.data.description}`);
          await react(sock, msg, '❌');
          return;
        }
      } catch (err) {
        console.error('[tgsticker] Token fetch failed:', err.message);
        await sendReply(sock, msg, `❌ *Telegram Error*\n${err?.response?.data?.description || err.message || 'Connection failed.'}`);
        await react(sock, msg, '❌');
        return;
      }
    }

    // CASE B: Image conversion to Telegram sticker format (512x512)
    const { url, buf } = await _resolveImgMedia(sock, msg, args, downloadContentFromMessage, axios, nx);
    if (!url && !buf) {
      return sendReply(sock, msg, `🎭 *Telegram Stickers*\nUsage: ${P}tgs <pack link or reply to image>`);
    }

    await react(sock, msg, '🎭');
    try {
      let stickerBuf = null;

      // 1. If buffer is available from replied image, convert to 512x512 TG sticker format
      if (buf) {
        try {
          stickerBuf = await _convertMediaToWebpSticker(buf, 'image.png');
        } catch {}
      }

      // 2. If URL is available, try fetching or NexRay
      if (!stickerBuf && url) {
        try {
          const r = await nx.tools.telegramSticker({ url });
          const m = await _media(r, axios);
          if (m?.buf) stickerBuf = m.buf;
        } catch {}

        if (!stickerBuf) {
          try {
            const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 20000 });
            stickerBuf = await _convertMediaToWebpSticker(Buffer.from(resp.data), url);
          } catch {}
        }
      }

      if (stickerBuf) {
        await sock.sendMessage(msg.key.remoteJid, { sticker: stickerBuf }, { quoted: msg });
        await react(sock, msg, '✅');
        return;
      }

      throw new Error('Could not convert image to Telegram sticker format.');
    } catch (e) {
      await sendReply(sock, msg, `❌ *Telegram Error*\n${e.message || 'Conversion failed.'}`);
      await react(sock, msg, '❌');
    }
  });

    cmd(['tiktok-earnings', 'ttearnings'], { desc: 'Estimate TikTok creator earnings', category: 'TOOLS' }, async (sock, msg, args) => {
    const username = args[0]; if (!username) return _noArgs(sock, msg, 'tiktok-earnings <username>');
    await react(sock, msg, '💰');
    try {
      const r = await nx.tools.tiktokearnings({ username });
      const t = _jsonFmt(r); if (!t) throw new Error('No response');
      await sendReply(sock, msg, `💰 *TikTok Earnings: @${username}*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['tiktok-hashtags', 'tthashtags'], { desc: 'Search TikTok trending hashtags', category: 'TOOLS' }, async (sock, msg, args) => {
    const hashtag = args[0]; if (!hashtag) return _noArgs(sock, msg, 'tiktok-hashtags <hashtag>');
    await react(sock, msg, '#️⃣');
    try {
      const r = await nx.tools.tiktokhashtags({ hashtag });
      const t = _jsonFmt(r); if (!t) throw new Error('No response');
      await sendReply(sock, msg, `#️⃣ *TikTok Hashtags: ${hashtag}*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['trackip', 'track-ip'], { desc: 'Track IP address location', category: 'TOOLS' }, async (sock, msg, args) => {
    const ip = args[0]; if (!ip) return _noArgs(sock, msg, 'trackip <ip-address>');
    await react(sock, msg, '📍');
    try {
      const r = await nx.tools.trackip({ ip });
      const t = _jsonFmt(r); if (!t) throw new Error('No response');
      await sendReply(sock, msg, `📍 *Track IP: ${ip}*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['translate', 'trans'], { desc: 'Translate text', category: 'TOOLS' }, async (sock, msg, args) => {
    if (args.length < 2) return _noArgs(sock, msg, 'translate <lang> <text>  e.g. translate en Halo dunia');
    await react(sock, msg, '🌐');
    try {
      const to = args[0]; const text = args.slice(1).join(' ');
      const r = await nx.tools.translate({ text, to });
      const t = _jsonFmt(r); if (!t) throw new Error('No response');
      await sendReply(sock, msg, `🌐 *Translate → ${to.toUpperCase()}*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['tts', 'google-tts'], { desc: 'Text to speech (Google TTS)', category: 'TOOLS' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'tts <text>  (or: tts en <text>)');
    await react(sock, msg, '🔊');
    try {
      const hasLang = args[0].length === 2 && /^[a-z]+$/.test(args[0]);
      const lang = hasLang ? args[0] : 'id';
      const text = hasLang ? args.slice(1).join(' ') : args.join(' ');
      const r = await nx.tools.ttsGoogle({ text, lang }); const m = await _media(r, axios);
      if (m) { await _sendAudio(sock, msg, m.buf); await react(sock, msg, '✅'); }
      else throw new Error('No audio returned');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['unblur', 'deblur', 'un-blur'], { desc: 'Unblur and enhance a blurry image (reply to image or pass URL)', category: 'TOOLS' }, async (sock, msg, args) => {
    await react(sock, msg, '🔍');
    try {
      const { url, buf } = await _resolveImgMedia(sock, msg, args, downloadContentFromMessage, axios, nx);
      if (!url && !buf) return _noArgs(sock, msg, 'unblur <image-url>  — or reply to an image with .unblur');

      let resultBuf = null;

      // 1. Primary: NexRay unblur endpoint
      if (url) {
        try {
          const r = await nx.tools.unblur({ url });
          const m = await _media(r, axios);
          if (m?.buf) resultBuf = m.buf;
        } catch {}
      }

      // 2. Secondary fallback: NexRay Remini AI enhancer
      if (!resultBuf && url) {
        try {
          const r = await nx.tools.remini({ url });
          const m = await _media(r, axios);
          if (m?.buf) resultBuf = m.buf;
        } catch {}
      }

      // 3. Tertiary fallback: NexRay enhancer
      if (!resultBuf && url) {
        try {
          const r = await nx.tools.enhancer({ url });
          const m = await _media(r, axios);
          if (m?.buf) resultBuf = m.buf;
        } catch {}
      }

      if (resultBuf) {
        await _sendImg(sock, msg, resultBuf, '🔍 *Image Unblurred*');
        await react(sock, msg, '✅');
        return;
      }

      throw new Error('Failed to unblur image. Please ensure the image is accessible and try again.');
    } catch (e) {
      await sendReply(sock, msg, `❌ Error: ${e.message}`);
      await react(sock, msg, '❌');
    }
  });

  cmd(['upscale', 'upscale-img'], { desc: 'Upscale image resolution', category: 'TOOLS' }, async (sock, msg, args) => {
    const url = args[0]; if (!url) return _noArgs(sock, msg, 'upscale <image-url>');
    await react(sock, msg, '📐');
    try {
      const r = await nx.tools.upscale({ url }); const m = await _media(r, axios);
      if (m) { await _sendImg(sock, msg, m.buf, '📐 *Image Upscaled*'); await react(sock, msg, '✅'); }
      else throw new Error('No image returned');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['upscale2', 'upscalev1'], { desc: 'Upscale image resolution v1', category: 'TOOLS' }, async (sock, msg, args) => {
    const url = args[0]; if (!url) return _noArgs(sock, msg, 'upscale2 <image-url>');
    await react(sock, msg, '📐');
    try {
      const r = await nx.tools.upscaleV1({ url }); const m = await _media(r, axios);
      if (m) { await _sendImg(sock, msg, m.buf, '📐 *Upscaled v1*'); await react(sock, msg, '✅'); }
      else throw new Error('No image returned');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['upscale3', 'upscalev2'], { desc: 'Upscale image resolution v2', category: 'TOOLS' }, async (sock, msg, args) => {
    const url = args[0]; if (!url) return _noArgs(sock, msg, 'upscale3 <image-url>');
    await react(sock, msg, '📐');
    try {
      const r = await nx.tools.upscaleV2({ url }); const m = await _media(r, axios);
      if (m) { await _sendImg(sock, msg, m.buf, '📐 *Upscaled v2*'); await react(sock, msg, '✅'); }
      else throw new Error('No image returned');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['upscale4', 'upscalev3'], { desc: 'Upscale image resolution v3', category: 'TOOLS' }, async (sock, msg, args) => {
    const url = args[0]; if (!url) return _noArgs(sock, msg, 'upscale4 <image-url>');
    await react(sock, msg, '📐');
    try {
      const r = await nx.tools.upscaleV3({ url }); const m = await _media(r, axios);
      if (m) { await _sendImg(sock, msg, m.buf, '📐 *Upscaled v3*'); await react(sock, msg, '✅'); }
      else throw new Error('No image returned');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['upscale5', 'upscalev4'], { desc: 'Upscale image resolution v4', category: 'TOOLS' }, async (sock, msg, args) => {
    const url = args[0]; if (!url) return _noArgs(sock, msg, 'upscale5 <image-url>');
    await react(sock, msg, '📐');
    try {
      const r = await nx.tools.upscaleV4({ url }); const m = await _media(r, axios);
      if (m) { await _sendImg(sock, msg, m.buf, '📐 *Upscaled v4*'); await react(sock, msg, '✅'); }
      else throw new Error('No image returned');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['upscale6', 'upscalev5'], { desc: 'Upscale image resolution v5', category: 'TOOLS' }, async (sock, msg, args) => {
    const url = args[0]; if (!url) return _noArgs(sock, msg, 'upscale6 <image-url>');
    await react(sock, msg, '📐');
    try {
      const r = await nx.tools.upscaleV5({ url }); const m = await _media(r, axios);
      if (m) { await _sendImg(sock, msg, m.buf, '📐 *Upscaled v5*'); await react(sock, msg, '✅'); }
      else throw new Error('No image returned');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['usernamegen', 'username-gen'], { desc: 'Generate username ideas', category: 'TOOLS' }, async (sock, msg, args) => {
    if (!args.length) return _noArgs(sock, msg, 'usernamegen <name>');
    await react(sock, msg, '👤');
    try {
      const r = await nx.tools.usernamegen({ name: args.join(' ') });
      const t = _jsonFmt(r); if (!t) throw new Error('No response');
      await sendReply(sock, msg, `👤 *Username Ideas for: ${args.join(' ')}*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['vcc', 'virtual-cc'], { desc: 'Generate virtual credit card info', category: 'TOOLS' }, async (sock, msg, args) => {
    await react(sock, msg, '💳');
    try {
      const r = await nx.tools.vcc();
      const t = _jsonFmt(r); if (!t) throw new Error('No response');
      await sendReply(sock, msg, `💳 *Virtual CC*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['virtual-number', 'virtualnumber'], { desc: 'Get virtual number for OTP', category: 'TOOLS' }, async (sock, msg, args) => {
    await react(sock, msg, '📲');
    try {
      const r = await nx.tools.virtualNumber({ number: args[0] });
      const t = _jsonFmt(r); if (!t) throw new Error('No response');
      await sendReply(sock, msg, `📲 *Virtual Number*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['virtual-number2', 'virtualnum2'], { desc: 'Get virtual number for OTP v1', category: 'TOOLS' }, async (sock, msg, args) => {
    await react(sock, msg, '📲');
    try {
      const r = await nx.tools.virtualNumberV1();
      const t = _jsonFmt(r); if (!t) throw new Error('No response');
      await sendReply(sock, msg, `📲 *Virtual Number v1*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['webphishing', 'phishing-check'], { desc: 'Check if a website is phishing', category: 'TOOLS' }, async (sock, msg, args) => {
    const url = args[0]; if (!url) return _noArgs(sock, msg, 'webphishing <url>');
    await react(sock, msg, '🛡️');
    try {
      const r = await nx.tools.webphishing({ url });
      const t = _jsonFmt(r); if (!t) throw new Error('No response');
      await sendReply(sock, msg, `🛡️ *Phishing Check: ${url}*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['webtozip', 'website-to-zip'], { desc: 'Download a website as a ZIP file', category: 'TOOLS' }, async (sock, msg, args) => {
    const url = args[0]; if (!url) return _noArgs(sock, msg, 'webtozip <url>');
    await react(sock, msg, '📦');
    try {
      const r = await nx.tools.webtozip({ url });
      const t = _jsonFmt(r); if (!t) throw new Error('No response');
      await sendReply(sock, msg, `📦 *Website to ZIP*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['whatsmusic', 'identify-music'], { desc: 'Identify music from audio/video URL', category: 'TOOLS' }, async (sock, msg, args) => {
    const url = args[0]; if (!url) return _noArgs(sock, msg, 'whatsmusic <audio-url>');
    await react(sock, msg, '🎵');
    try {
      const r = await nx.tools.whatsmusic({ url });
      const t = _jsonFmt(r); if (!t) throw new Error('No response');
      await sendReply(sock, msg, `🎵 *Music Identified*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['wink', 'wink-effect'], { desc: 'Wink enhance image or video', category: 'TOOLS' }, async (sock, msg, args) => {
    const url = args[0]; if (!url) return _noArgs(sock, msg, 'wink <image/video-url>');
    await react(sock, msg, '✨');
    try {
      const r = await nx.tools.wink({ url }); const m = await _media(r, axios);
      if (m) { await _sendImg(sock, msg, m.buf, '✨ *Wink Enhanced*'); await react(sock, msg, '✅'); }
      else { const t = _jsonFmt(r); await sendReply(sock, msg, `✨ *Wink*\n${t}`); }
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['winrate-mlbb', 'winrateml'], { desc: 'MLBB win-rate calculator', category: 'TOOLS' }, async (sock, msg, args) => {
    await react(sock, msg, '🎮');
    try {
      const r = await nx.tools.winrateMLBB();
      const t = _jsonFmt(r); if (!t) throw new Error('No response');
      await sendReply(sock, msg, `🎮 *MLBB Win-Rate*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['yt-summarize', 'ytsummarize'], { desc: 'Summarize a YouTube video', category: 'TOOLS' }, async (sock, msg, args) => {
    const url = args[0]; if (!url) return _noArgs(sock, msg, 'yt-summarize <youtube-url>');
    await react(sock, msg, '📝');
    try {
      const r = await nx.tools.ytSummarizeV1({ url });
      const t = _jsonFmt(r); if (!t) throw new Error('No response');
      await sendReply(sock, msg, `📝 *YouTube Summary*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['yt-summarize2', 'ytsummarize2'], { desc: 'Summarize a YouTube video v2', category: 'TOOLS' }, async (sock, msg, args) => {
    const url = args[0]; if (!url) return _noArgs(sock, msg, 'yt-summarize2 <youtube-url>');
    await react(sock, msg, '📝');
    try {
      const r = await nx.tools.ytSummarizeV2({ url });
      const t = _jsonFmt(r); if (!t) throw new Error('No response');
      await sendReply(sock, msg, `📝 *YouTube Summary v2*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  cmd(['yt-transcribe', 'yttranscribe'], { desc: 'Transcribe YouTube video to text', category: 'TOOLS' }, async (sock, msg, args) => {
    const url = args[0]; if (!url) return _noArgs(sock, msg, 'yt-transcribe <youtube-url>');
    await react(sock, msg, '📝');
    try {
      const r = await nx.tools.ytTranscribe({ url });
      const t = _jsonFmt(r); if (!t) throw new Error('No response');
      await sendReply(sock, msg, `📝 *YouTube Transcript*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ☁️  UPLOADER  — 1 endpoint
  // ═══════════════════════════════════════════════════════════════════════════

  cmd(['upload-nx', 'nxupload'], { desc: 'Upload file to MIAS CDN (reply to a file/image)', category: 'DOWNLOAD' }, async (sock, msg, args) => {
    await react(sock, msg, '☁️');
    try {
      let fileBuf = await _getImgFromMsg(msg, downloadContentFromMessage);
      if (!fileBuf) {
        // Try other message types
        const docMsg = msg.message?.documentMessage ??
          msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.documentMessage ?? null;
        if (docMsg) {
          const stream = await downloadContentFromMessage(docMsg, 'document');
          let buf = Buffer.from([]);
          for await (const chunk of stream) buf = Buffer.concat([buf, chunk]);
          fileBuf = buf.length > 100 ? buf : null;
        }
      }
      if (!fileBuf) return sendReply(sock, msg, '⚠️ Please reply to an image or document to upload!');
      const r = await nx.uploader.upload({ file: fileBuf });
      const t = _jsonFmt(r); if (!t) throw new Error('Upload failed');
      await sendReply(sock, msg, `☁️ *Nexray CDN Upload*\n\n${t}`);
      await react(sock, msg, '✅');
    } catch (e) { await sendReply(sock, msg, `❌ Error: ${e.message}`); await react(sock, msg, '❌'); }
  });
}; // end registerNexrayCmds
