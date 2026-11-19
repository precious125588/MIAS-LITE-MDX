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

// Keep the status index and media on the same persistent Railway volume as sessions.
// The repo-local fallback remains unchanged for local development.
function getStatusStoreDir() {
  try {
    const sessionPaths = require('../nexstore_modules/sessionPaths.js');
    if (sessionPaths?.isVolumeMounted?.()) {
      return path.join(sessionPaths.nexstoreRoot(), 'status-cards');
    }
  } catch {}
  return path.join(__dirname, '..', 'nexstore', 'status-cards');
}
let storeDir = getStatusStoreDir();
function _setStoreDir(dir) { storeDir = dir; }

// Baileys' download helper, loaded lazily (it is an ES module); tests can inject their own.
let _download = null;
function _setDownloader(fn) { _download = fn; }
async function getDownloader() {
  if (!_download) {
    const baileys = await import('@whiskeysockets/baileys');
    _download = baileys.downloadContentFromMessage;
  }
  return _download;
}
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
    for (const jid of ctx?.mentionedJid || []) {
      if (typeof jid === 'string' && jid.endsWith('@g.us') && !seen.has(jid)) {
        seen.add(jid);
        out.push({ groupJid: jid, groupSubject: '' });
      }
    }
    if (typeof ctx?.groupJid === 'string' && ctx.groupJid.endsWith('@g.us') && !seen.has(ctx.groupJid)) {
      seen.add(ctx.groupJid);
      out.push({ groupJid: ctx.groupJid, groupSubject: '' });
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
  if (typeof deps?.download === 'function') {
    _setDownloader(deps.download);
  }
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
 * A `.fetch` reply can quote our card or the status itself (WhatsApp's own group-mention
 * card points at the status), so match on either id.
 */
function findEntry(index, quotedId) {
  const id = String(quotedId);
  if (index[id]) return index[id];
  return Object.values(index).find((e) => e.statusId === id) || null;
}

/**
 * WhatsApp's native "group was mentioned" card points at the status it came from. Depending on
 * the build it sits under groupStatusMentionMessage (field 92) or statusMentionMessage (field 87),
 * or under contextInfo.statusMentionMessageInfo (proto StatusMentionMessage). Each wrapper either
 * carries the status itself (quotedStatus / message) or only a STATUS_MENTION_MESSAGE protocol
 * message whose key is the status id. Returns:
 *   marker   the quoted message is a status-mention card at all
 *   status   the status content, when the card carries it
 *   statusId the status id the card points at, when it only carries a pointer
 */
const STATUS_MENTION_PROTOCOL_TYPE = 25;

function isStatusMentionProtocol(pm) {
  return !!pm && typeof pm === 'object' &&
    (pm.type === STATUS_MENTION_PROTOCOL_TYPE || pm.type === 'STATUS_MENTION_MESSAGE') &&
    !!pm.key?.id;
}

function statusCardOf(node, depth = 0) {
  const out = { marker: false, status: null, statusId: null };
  if (!node || typeof node !== 'object' || depth > 6) return out;

  const info = node.statusMentionMessageInfo;
  if (info && typeof info === 'object') {
    out.marker = true;
    if (info.quotedStatus && typeof info.quotedStatus === 'object') {
      out.status = unwrap(info.quotedStatus);
      return out;
    }
    const sid = info.statusId || info.key?.id || info.protocolMessage?.key?.id;
    if (sid) {
      out.statusId = String(sid);
      return out;
    }
  }

  for (const key of ['statusMentionMessage', 'groupStatusMentionMessage', 'groupStatusMentionMessageV2']) {
    const wrap = node[key];
    if (!wrap || typeof wrap !== 'object') continue;
    out.marker = true;
    if (wrap.quotedStatus && typeof wrap.quotedStatus === 'object') {
      out.status = unwrap(wrap.quotedStatus);
      return out;
    }
    const inner = unwrap(wrap.message || wrap);
    if (isStatusMentionProtocol(inner.protocolMessage)) {
      out.statusId = String(inner.protocolMessage.key.id);
      return out;
    }
    const sid = wrap.statusId || inner.statusId || wrap.key?.id;
    if (sid) {
      out.statusId = String(sid);
      return out;
    }
    if (wrap.message && typeof wrap.message === 'object' && !inner.protocolMessage && Object.keys(inner).length) {
      out.status = inner;
      return out;
    }
  }
  if (out.marker) return out;

  if (isStatusMentionProtocol(node.protocolMessage)) {
    out.marker = true;
    out.statusId = String(node.protocolMessage.key.id);
    return out;
  }

  for (const v of Object.values(node)) {
    if (!v || typeof v !== 'object' || Buffer.isBuffer(v)) continue;
    const found = statusCardOf(v, depth + 1);
    if (found.marker) return found;
  }
  return out;
}

/** Sends the status a native group-mention card carries, downloading its media on demand. */
async function fetchFromCardStatus(sock, chat, quoted, statusMsg, deps = {}) {
  const info = extractStatusContent(statusMsg);
  if (info.kind === 'text') {
    await sock.sendMessage(chat, { text: info.caption || '(empty status)' }, quoted);
    return true;
  }
  let buffer = null;
  const dl = (typeof deps?.download === 'function' ? deps.download : null) || (await getDownloader().catch(() => null));
  if (dl) {
    try {
      buffer = await readMedia(info.content, info.kind, dl);
    } catch {
      buffer = null;
    }
  }
  if (!buffer) {
    await sock.sendMessage(chat, { text: '⌛ Status expired or unavailable.' }, quoted);
    return true;
  }
  const caption = info.caption || undefined;
  if (info.kind === 'image') {
    await sock.sendMessage(chat, { image: buffer, caption }, quoted);
  } else if (info.kind === 'video') {
    await sock.sendMessage(chat, { video: buffer, caption }, quoted);
  } else {
    await sock.sendMessage(chat, { audio: buffer, mimetype: info.mimetype || 'audio/mp4' }, quoted);
  }
  return true;
}

/** True when the quoted message is the bot's own group-mention card text. */
function isBotCardText(quotedMessage) {
  const text = String(unwrap(quotedMessage)?.conversation || unwrap(quotedMessage)?.extendedTextMessage?.text || '');
  return /mentioned this group in a status/i.test(text);
}

/**
 * Called for every `.fetch`. Handles only replies to a status card; returns false otherwise
 * so the normal `.fetch <url>` flow runs unchanged.
 */
async function handleFetchReply(sock, msg, deps = {}) {
  if (typeof deps?.download === 'function') {
    _setDownloader(deps.download);
  }
  const m = unwrap(msg?.message);
  const ctx = Object.values(m).find((v) => v && typeof v === 'object' && v.contextInfo)?.contextInfo;
  const quotedId = ctx?.stanzaId;
  if (!quotedId) return false;

  const now = Date.now();
  const index = loadIndex();
  const chat = msg.key.remoteJid;
  const quoted = { quoted: msg };
  const card = statusCardOf(ctx.quotedMessage);

  // Our own card matches by its message id. WhatsApp's native card matches by the status id it
  // points at. The card may also carry the status itself, which is served even if never stored.
  let entry = findEntry(index, quotedId);
  if (!entry && card.statusId) entry = findEntry(index, card.statusId);
  if (!entry && card.status) return fetchFromCardStatus(sock, chat, quoted, card.status, deps);
  if (!entry && ctx.quotedMessage && (ctx.quotedMessage.imageMessage || ctx.quotedMessage.videoMessage || ctx.quotedMessage.audioMessage)) {
    return fetchFromCardStatus(sock, chat, quoted, ctx.quotedMessage, deps);
  }
  if (!entry && (card.marker || isBotCardText(ctx.quotedMessage))) {
    await sock.sendMessage(chat, { text: '⌛ Status expired or unavailable.' }, quoted);
    return true;
  }
  if (!entry) return false;

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
  statusCardOf,
  _setStoreDir,
  _setDownloader,
};
