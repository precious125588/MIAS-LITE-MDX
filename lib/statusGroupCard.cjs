'use strict';
/**
 * Status group-mention cards.
 * When someone's status tags a group, the bot posts a one-line card in that group.
 * Replying `.fetch` to the card sends back the status media or text while the status is
 * still live (24h). Nothing runs in the background: work happens only when a status
 * arrives or when `.fetch` is used.
 */
const fs = require('fs');
const path = require('path');

const STATUS_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_MEDIA_BYTES = 64 * 1024 * 1024;
const MEDIA_KEYS = { imageMessage: 'image', videoMessage: 'video', audioMessage: 'audio' };

let storeDir = path.join(__dirname, '..', 'nexstore', 'status-cards');
function _setStoreDir(dir) { storeDir = dir; }
const indexFile = () => path.join(storeDir, 'index.json');

function loadIndex() {
  try { return JSON.parse(fs.readFileSync(indexFile(), 'utf8')) || {}; } catch { return {}; }
}

function saveIndex(index) {
  fs.mkdirSync(storeDir, { recursive: true });
  const tmp = indexFile() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(index));
  fs.renameSync(tmp, indexFile());
}

function safeId(id) { return String(id || '').replace(/[^A-Za-z0-9_-]/g, ''); }

function unwrap(message) {
  let m = message || {};
  for (let i = 0; i < 4; i++) {
    const inner = m.ephemeralMessage?.message || m.viewOnceMessage?.message ||
      m.viewOnceMessageV2?.message || m.documentWithCaptionMessage?.message;
    if (!inner) break;
    m = inner;
  }
  return m;
}

function extractGroupMentions(message) {
  const m = unwrap(message);
  const seen = new Set();
  const out = [];
  for (const value of Object.values(m)) {
    const ctx = value && typeof value === 'object' ? value.contextInfo : null;
    for (const g of ctx?.groupMentions || []) {
      const jid = g?.groupJid;
      if (jid && !seen.has(jid)) {
        seen.add(jid);
        out.push({ groupJid: jid, groupSubject: g.groupSubject || '' });
      }
    }
  }
  return out;
}

function extractStatusContent(message) {
  const m = unwrap(message);
  for (const [key, kind] of Object.entries(MEDIA_KEYS)) {
    if (m[key]) {
      return { kind, content: m[key], caption: m[key].caption || '', mimetype: m[key].mimetype || '' };
    }
  }
  const text = m.extendedTextMessage?.text || m.conversation || '';
  return { kind: 'text', content: null, caption: text, mimetype: '' };
}

function extFor(kind, mimetype) {
  if (kind === 'image') return 'jpg';
  if (kind === 'video') return 'mp4';
  const sub = String(mimetype || '').split('/')[1] || 'ogg';
  return sub.replace(/[^a-z0-9]/gi, '') || 'ogg';
}

function removeFile(file) {
  if (!file) return;
  try { fs.unlinkSync(file); } catch {}
}

/** Drop entries older than the TTL and delete their media. Called only on use, never on a timer. */
function prune(index, now) {
  const expiredStatusIds = new Set();
  for (const [cardId, entry] of Object.entries(index)) {
    if (now - entry.postedAt > STATUS_TTL_MS) {
      expiredStatusIds.add(entry.statusId);
      delete index[cardId];
    }
  }
  for (const statusId of expiredStatusIds) {
    const stillUsed = Object.values(index).some((e) => e.statusId === statusId);
    if (!stillUsed) {
      for (const f of fs.readdirSync(storeDir).filter((n) => n.startsWith(statusId + '.'))) {
        removeFile(path.join(storeDir, f));
      }
    }
  }
  return index;
}

async function readMedia(content, kind, download) {
  const stream = await download(content, kind);
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.length;
    if (total > MAX_MEDIA_BYTES) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Called for every incoming status. Posts one card per mentioned group and keeps the media.
 * Returns true when a card was posted.
 */
async function handleStatusMessage(sock, msg, deps = {}) {
  const key = msg?.key || {};
  if (key.remoteJid !== 'status@broadcast' || key.fromMe || !key.id) return false;
  const groups = extractGroupMentions(msg.message);
  if (!groups.length) return false;

  const now = Date.now();
  const index = prune(loadIndex(), now);
  if (Object.values(index).some((e) => e.statusId === key.id)) return false;

  const info = extractStatusContent(msg.message);
  const poster = String(msg.pushName || (key.participant || '').split('@')[0] || 'Someone').trim();
  const statusId = safeId(key.id);

  let filePath = null;
  let tooLarge = false;
  if (info.kind !== 'text' && typeof deps.download === 'function') {
    const buffer = await readMedia(info.content, info.kind, deps.download);
    if (buffer) {
      fs.mkdirSync(storeDir, { recursive: true });
      filePath = path.join(storeDir, `${statusId}.${extFor(info.kind, info.mimetype)}`);
      fs.writeFileSync(filePath, buffer);
    } else {
      tooLarge = true;
    }
  }

  const entryBase = {
    statusId: key.id,
    postedAt: now,
    kind: info.kind,
    mimetype: info.mimetype,
    caption: info.caption,
    poster,
    filePath,
    tooLarge,
  };

  for (const g of groups) {
    const sent = await sock.sendMessage(g.groupJid, {
      text: `📢 *${poster}* mentioned this group in a status`,
    });
    const cardId = sent?.key?.id;
    if (cardId) index[cardId] = { ...entryBase, groupJid: g.groupJid };
  }
  saveIndex(index);
  return true;
}

/**
 * Called for every `.fetch`. Handles only replies to a status card; returns false otherwise
 * so the normal `.fetch <url>` flow runs unchanged.
 */
async function handleFetchReply(sock, msg) {
  const m = unwrap(msg?.message);
  const ctx = Object.values(m).find((v) => v && typeof v === 'object' && v.contextInfo)?.contextInfo;
  const quotedId = ctx?.stanzaId;
  if (!quotedId) return false;

  const now = Date.now();
  const index = loadIndex();
  const entry = index[quotedId];
  if (!entry) return false;

  const chat = msg.key.remoteJid;
  const quoted = { quoted: msg };

  if (now - entry.postedAt > STATUS_TTL_MS) {
    prune(index, now);
    saveIndex(index);
    await sock.sendMessage(chat, { text: '⌛ Status expired.' }, quoted);
    return true;
  }

  if (entry.kind === 'text') {
    await sock.sendMessage(chat, { text: entry.caption || '(empty status)' }, quoted);
    return true;
  }
  if (entry.tooLarge) {
    await sock.sendMessage(chat, { text: '❌ Status media is too large to fetch.' }, quoted);
    return true;
  }
  if (!entry.filePath || !fs.existsSync(entry.filePath)) {
    await sock.sendMessage(chat, { text: '❌ Status media is no longer available.' }, quoted);
    return true;
  }

  const buffer = fs.readFileSync(entry.filePath);
  const caption = entry.caption || undefined;
  if (entry.kind === 'image') {
    await sock.sendMessage(chat, { image: buffer, caption }, quoted);
  } else if (entry.kind === 'video') {
    await sock.sendMessage(chat, { video: buffer, caption }, quoted);
  } else {
    await sock.sendMessage(chat, { audio: buffer, mimetype: entry.mimetype || 'audio/mp4' }, quoted);
  }
  return true;
}

module.exports = {
  STATUS_TTL_MS,
  extractGroupMentions,
  extractStatusContent,
  handleStatusMessage,
  handleFetchReply,
  _setStoreDir,
};
