'use strict';
/**
 * Status group-mention cards & target status fetcher.
 * 1. When someone's status tags a group, the bot posts a one-line card in that group.
 *    Replying `.fetch` to the card sends back the status media or text.
 * 2. When someone uses `.fetch <target_number>` (e.g. `.fetch 2349068551055`), the bot
 *    fetches and sends all active statuses the target posted within 24 hours.
 * Everything is preserved (TTL 24h) and media is kept on the persistent volume.
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
    if (!entry || typeof entry !== 'object') {
      delete index[cardId];
      continue;
    }
    if (now - (entry.postedAt || 0) > STATUS_TTL_MS) {
      if (entry.statusId) expiredStatusIds.add(entry.statusId);
      delete index[cardId];
    }
  }
  for (const statusId of expiredStatusIds) {
    const stillUsed = Object.values(index).some((e) => e && e.statusId === statusId);
    if (!stillUsed) {
      try {
        for (const f of fs.readdirSync(storeDir).filter((n) => n.startsWith(statusId + '.'))) {
          removeFile(path.join(storeDir, f));
        }
      } catch {}
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
 * Called for every incoming status. Stores status indexed by sender and status ID,
 * and posts one card per mentioned group (if any).
 * Returns true when a group card was posted.
 */
async function handleStatusMessage(sock, msg, deps = {}) {
  if (typeof deps?.download === 'function') {
    _setDownloader(deps.download);
  }
  const key = msg?.key || {};
  if (key.remoteJid !== 'status@broadcast' || key.fromMe || !key.id) return false;

  const now = Date.now();
  const index = prune(loadIndex(), now);

  const statusId = safeId(key.id);
  const alreadyStored = Object.values(index).some((e) => e && e.statusId === key.id);

  // Extract author / participant info
  const rawPart = deps?.rawPart || deps?.participant || key.participant || msg?.participant || key.participantPn || msg?.participantPn || '';
  const stdJid = deps?.stdJid || (typeof rawPart === 'string' && rawPart.includes('@') ? rawPart : '');
  const cleanPhone = String(deps?.cleanNum || deps?.senderPhone || stdJid || rawPart).replace(/[^0-9]/g, '');
  const poster = String(msg?.pushName || deps?.pushName || cleanPhone || 'Someone').trim();

  let entryBase = null;
  if (!alreadyStored) {
    const info = extractStatusContent(msg?.message);
    let filePath = null;
    let tooLarge = false;
    const dl = (typeof deps?.download === 'function' ? deps.download : null) || _download;
    if (info.kind !== 'text' && typeof dl === 'function') {
      const buffer = await readMedia(info.content, info.kind, dl).catch(() => null);
      if (buffer) {
        fs.mkdirSync(storeDir, { recursive: true });
        filePath = path.join(storeDir, `${statusId}.${extFor(info.kind, info.mimetype)}`);
        fs.writeFileSync(filePath, buffer);
      } else {
        tooLarge = true;
      }
    }

    entryBase = {
      statusId: key.id,
      postedAt: now,
      kind: info.kind,
      mimetype: info.mimetype,
      caption: info.caption,
      poster,
      senderPhone: cleanPhone,
      senderJid: stdJid || (cleanPhone ? `${cleanPhone}@s.whatsapp.net` : ''),
      filePath,
      tooLarge,
      rawContent: info.content,
    };
  } else {
    entryBase = Object.values(index).find((e) => e && e.statusId === key.id);
  }

  // If there are group mentions, post group cards and index by cardId.
  // Otherwise index by statusId so target fetches can retrieve them.
  const groups = extractGroupMentions(msg?.message);
  let cardPosted = false;
  if (groups.length && entryBase && sock && typeof sock.sendMessage === 'function') {
    for (const g of groups) {
      const alreadyPostedGroup = Object.values(index).some(e => e && e.statusId === key.id && e.groupJid === g.groupJid);
      if (alreadyPostedGroup) continue;
      const sent = await sock.sendMessage(g.groupJid, {
        text: `📢 *${poster}* mentioned this group in a status`,
      });
      const cardId = sent?.key?.id;
      if (cardId) {
        index[cardId] = { ...entryBase, groupJid: g.groupJid };
        cardPosted = true;
      }
    }
  } else if (!alreadyStored && entryBase) {
    index[statusId] = entryBase;
  }
  saveIndex(index);
  return cardPosted;
}

/**
 * A `.fetch` reply can quote our card or the status itself (WhatsApp's own group-mention
 * card points at the status), so match on either id.
 */
function findEntry(index, quotedId) {
  const id = String(quotedId);
  if (index[id]) return index[id];
  return Object.values(index).find((e) => e && e.statusId === id) || null;
}

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

function isBotCardText(quotedMessage) {
  const text = String(unwrap(quotedMessage)?.conversation || unwrap(quotedMessage)?.extendedTextMessage?.text || '');
  return /mentioned this group in a status/i.test(text);
}

/**
 * Called for every `.fetch`. Handles only replies to a status card; returns false otherwise
 * so the normal `.fetch <url>` or `.fetch <target>` flow runs.
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

/**
 * Extracts a target contact phone/JID from command arguments or quoted message.
 * Returns null if the argument is a URL or not a contact identifier.
 */
function extractTarget(msg, args, deps = {}) {
  const m = unwrap(msg?.message);
  const ctx = Object.values(m || {}).find((v) => v && typeof v === 'object' && v.contextInfo)?.contextInfo;

  // 1. Tagged user in contextInfo.mentionedJid
  if (ctx?.mentionedJid?.length) {
    for (const jid of ctx.mentionedJid) {
      if (jid && !jid.endsWith('@g.us')) {
        const clean = String(jid).replace(/[^0-9]/g, '');
        if (clean.length >= 7) return { phone: clean, jid: `${clean}@s.whatsapp.net` };
      }
    }
  }

  // 2. Check raw string argument from args
  const rawArg = Array.isArray(args) ? args.join(' ').trim() : String(args || '').trim();
  if (rawArg) {
    // If it is a URL, return null so URL fetch handles it
    if (/^https?:\/\//i.test(rawArg)) return null;
    if (rawArg.includes('.') && !rawArg.includes('@')) {
      // Domain-like string (e.g. catbox.moe/abc, tmpfiles.org/dl)
      return null;
    }

    // Clean out formatting characters: +, @, space, -, (, )
    const clean = rawArg.replace(/[@+\s\-()]/g, '');
    const numOnly = clean.replace(/@s\.whatsapp\.net$/i, '');
    if (/^\d{7,16}$/.test(numOnly)) {
      return { phone: numOnly, jid: `${numOnly}@s.whatsapp.net` };
    }

    // 2b. Name resolution: check if rawArg is a contact name or handle (e.g. @⁨Just Xavier...⁩)
    const normArg = String(rawArg).normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[\u200B-\u200D\u200E\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '')
      .replace(/^@+/, '')
      .replace(/\.+$/, '')
      .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

    if (normArg && normArg.length >= 2) {
      // Check contacts Map
      if (deps?.contacts && typeof deps.contacts.entries === 'function') {
        for (const [phone, name] of deps.contacts.entries()) {
          const normName = String(name || '').normalize('NFKD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[\u200B-\u200D\u200E\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '')
            .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
          if (normName === normArg || (Math.min(normName.length, normArg.length) >= 3 && (normName.includes(normArg) || normArg.includes(normName)))) {
            const cleanPhone = String(phone).replace(/[^0-9]/g, '');
            if (cleanPhone.length >= 7) return { phone: cleanPhone, jid: `${cleanPhone}@s.whatsapp.net`, matchedName: name };
          }
        }
      }

      // Check socket store contacts
      if (deps?.sock?.store?.contacts) {
        for (const [jid, contact] of Object.entries(deps.sock.store.contacts)) {
          const cName = contact?.name || contact?.notify || '';
          const normName = String(cName).normalize('NFKD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[\u200B-\u200D\u200E\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '')
            .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
          if (normName === normArg || (Math.min(normName.length, normArg.length) >= 3 && (normName.includes(normArg) || normArg.includes(normName)))) {
            const cleanPhone = String(jid).replace(/[^0-9]/g, '');
            if (cleanPhone.length >= 7) return { phone: cleanPhone, jid: `${cleanPhone}@s.whatsapp.net`, matchedName: cName };
          }
        }
      }

      // Check VCF lookup helper if supplied
      if (typeof deps?.lookupContactByFn === 'function') {
        const found = deps.lookupContactByFn(normArg);
        if (found?.waid) {
          const cleanPhone = String(found.waid).replace(/[^0-9]/g, '');
          if (cleanPhone.length >= 7) return { phone: cleanPhone, jid: `${cleanPhone}@s.whatsapp.net`, matchedName: found.fn };
        }
      }
    }
  }

  // 3. Quoted message participant (when replying .fetch to a contact's message, not a status card)
  if (!rawArg && ctx?.participant && !ctx.participant.endsWith('@g.us')) {
    const clean = String(ctx.participant).replace(/[^0-9]/g, '');
    if (clean.length >= 7) return { phone: clean, jid: `${clean}@s.whatsapp.net` };
  }

  return null;
}

/**
 * Finds all active (unexpired) statuses posted by a target phone number or JID.
 * Checks both the persistent status store and live message store.
 * Returns statuses sorted chronologically (oldest first).
 */
function findStatusesByTarget(index, target, deps = {}) {
  const targetPhone = typeof target === 'string' ? target.replace(/[^0-9]/g, '') : (target?.phone || '').replace(/[^0-9]/g, '');
  if (!targetPhone) return [];

  // Contact names let us match statuses whose participant is an opaque WhatsApp LID
  // rather than the phone-number JID used by the saved contact.
  const knownContactName = String(
    (target && typeof target === 'object' && target.matchedName) ||
    (deps?.contacts && typeof deps.contacts.get === 'function' && deps.contacts.get(targetPhone)) ||
    (deps?.pushNames && typeof deps.pushNames.get === 'function' && deps.pushNames.get(targetPhone)) ||
    deps?.sock?.store?.contacts?.[`${targetPhone}@s.whatsapp.net`]?.name ||
    deps?.sock?.store?.contacts?.[`${targetPhone}@s.whatsapp.net`]?.notify || ''
  ).trim().toLowerCase();
  const normalizeName = (value) => String(value || '').normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u200B-\u200D\u200E\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const nameMatches = (left, right) => {
    const a = normalizeName(left);
    const b = normalizeName(right);
    return !!a && !!b && (a === b || (Math.min(a.length, b.length) >= 5 && (a.includes(b) || b.includes(a))));
  };

  const now = Date.now();
  const seen = new Set();
  const matched = [];
  const targetSuffix = targetPhone.length >= 10 ? targetPhone.slice(-10) : targetPhone;

  // 1. Search persistent index
  for (const entry of Object.values(index || {})) {
    if (!entry || typeof entry !== 'object' || !entry.statusId) continue;
    if (seen.has(entry.statusId)) continue;
    if (now - (entry.postedAt || 0) > STATUS_TTL_MS) continue;

    const entryPhone = String(entry.senderPhone || '').replace(/[^0-9]/g, '');
    const entryJid = String(entry.senderJid || '').replace(/[^0-9]/g, '');

    const exactMatch = (entryPhone && entryPhone === targetPhone) ||
                    (entryJid && entryJid === targetPhone) ||
                    (targetSuffix.length >= 7 && entryPhone && (entryPhone.endsWith(targetSuffix) || targetPhone.endsWith(entryPhone.slice(-10)))) ||
                    (targetSuffix.length >= 7 && entryJid && (entryJid.endsWith(targetSuffix) || targetPhone.endsWith(entryJid.slice(-10))));
    const nameMatch = knownContactName && nameMatches(entry.poster || entry.contactName, knownContactName);
    const isMatch = exactMatch || nameMatch;

    if (isMatch) {
      seen.add(entry.statusId);
      matched.push(entry);
    }
  }

  // 2. Search live in-memory message store if available
  if (deps?.msgStore && typeof deps.msgStore.values === 'function') {
    for (const raw of deps.msgStore.values()) {
      if (!raw || raw._jid !== 'status@broadcast') continue;
      const p = String(raw._participant || '').replace(/[^0-9]/g, '');
      const exactMatch = p === targetPhone ||
        (targetSuffix.length >= 7 && (p.endsWith(targetSuffix) || targetPhone.endsWith(p.slice(-10))));
      const nameMatch = knownContactName && nameMatches(raw._pushName, knownContactName);
      const isMatch = exactMatch || nameMatch;
      if (isMatch) {
        const sid = raw._statusId || raw.id;
        if (sid && !seen.has(sid)) {
          seen.add(sid);
          const info = extractStatusContent(raw);
          matched.push({
            statusId: sid,
            postedAt: raw._ts || now,
            kind: info.kind,
            mimetype: info.mimetype,
            caption: info.caption,
            poster: raw._pushName || targetPhone,
            senderPhone: p,
            senderJid: raw._participant,
            rawContent: info.content,
          });
        }
      }
    }
  }

  // Sort chronologically (oldest first)
  matched.sort((a, b) => (a.postedAt || 0) - (b.postedAt || 0));
  return matched;
}

/**
 * Handles target status fetching when .fetch is used with a phone number / contact.
 * E.g. `.fetch 2349068551055`
 * Delivers all statuses the target posted.
 * Returns true if handled, false if not a target query (allowing URL fetch to proceed).
 */
async function handleFetchTargetStatus(sock, msg, args, deps = {}) {
  const target = extractTarget(msg, args, deps);
  if (!target) return false;

  const chat = msg?.key?.remoteJid;
  if (!chat) return false;

  const quoted = { quoted: msg };
  const cleanTarget = target.phone;
  const targetJid = target.jid;

  // React search indicator
  if (typeof deps?.react === 'function') {
    try { await deps.react(sock, msg, '🔍'); } catch {}
  } else if (sock && typeof sock.sendMessage === 'function') {
    try { await sock.sendMessage(chat, { react: { text: '🔍', key: msg.key } }); } catch {}
  }

  const now = Date.now();
  const index = prune(loadIndex(), now);
  const statuses = findStatusesByTarget(index, target, deps);

  if (!statuses.length) {
    if (typeof deps?.react === 'function') {
      try { await deps.react(sock, msg, '❌'); } catch {}
    } else if (sock && typeof sock.sendMessage === 'function') {
      try { await sock.sendMessage(chat, { react: { text: '❌', key: msg.key } }); } catch {}
    }
    await sock.sendMessage(chat, {
      text: `❌ No active status found for @${cleanTarget}.\n\n_Make sure the number is saved in your contacts and they have posted a status within the last 24 hours._`,
      mentions: [targetJid],
    }, quoted);
    return true;
  }

  if (typeof deps?.react === 'function') {
    try { await deps.react(sock, msg, '📥'); } catch {}
  } else if (sock && typeof sock.sendMessage === 'function') {
    try { await sock.sendMessage(chat, { react: { text: '📥', key: msg.key } }); } catch {}
  }

  const total = statuses.length;
  const targetName = statuses[0]?.poster || cleanTarget;
  await sock.sendMessage(chat, {
    text: `📥 *Fetching ${total} status update${total > 1 ? 's' : ''} from ${targetName} (@${cleanTarget})...*`,
    mentions: [targetJid],
  }, quoted);

  for (let idx = 0; idx < total; idx++) {
    const entry = statuses[idx];
    const countTag = `📱 *Status [${idx + 1}/${total}]* • @${cleanTarget}`;
    const caption = entry.caption ? `${entry.caption}\n\n${countTag}` : countTag;

    try {
      if (entry.kind === 'text') {
        const textBody = `💬 *Status [${idx + 1}/${total}]* • @${cleanTarget}\n\n${entry.caption || '(empty status)'}`;
        await sock.sendMessage(chat, { text: textBody, mentions: [targetJid] }, quoted);
      } else {
        let buffer = null;
        if (entry.filePath && fs.existsSync(entry.filePath)) {
          buffer = fs.readFileSync(entry.filePath);
        } else if (entry.rawContent) {
          const dl = (typeof deps?.download === 'function' ? deps.download : null) || (await getDownloader().catch(() => null));
          if (dl) {
            buffer = await readMedia(entry.rawContent, entry.kind, dl).catch(() => null);
          }
        }

        if (!buffer) {
          await sock.sendMessage(chat, { text: `⚠️ Status [${idx + 1}/${total}] media is no longer available.` }, quoted);
        } else if (entry.kind === 'image') {
          await sock.sendMessage(chat, { image: buffer, caption, mentions: [targetJid] }, quoted);
        } else if (entry.kind === 'video') {
          await sock.sendMessage(chat, { video: buffer, caption, mimetype: entry.mimetype || 'video/mp4', mentions: [targetJid] }, quoted);
        } else if (entry.kind === 'audio') {
          await sock.sendMessage(chat, { audio: buffer, mimetype: entry.mimetype || 'audio/mp4', ptt: true }, quoted);
          if (entry.caption) {
            await sock.sendMessage(chat, { text: caption, mentions: [targetJid] }, quoted);
          }
        }
      }
    } catch (err) {
      console.warn(`[statusGroupCard] Error sending status ${idx + 1}:`, err?.message || err);
      await sock.sendMessage(chat, { text: `❌ Failed to deliver status [${idx + 1}/${total}].` }, quoted);
    }

    if (idx < total - 1) {
      await new Promise((r) => setTimeout(r, 800));
    }
  }

  if (typeof deps?.react === 'function') {
    try { await deps.react(sock, msg, '✅'); } catch {}
  } else if (sock && typeof sock.sendMessage === 'function') {
    try { await sock.sendMessage(chat, { react: { text: '✅', key: msg.key } }); } catch {}
  }

  return true;
}

module.exports = {
  STATUS_TTL_MS,
  extractGroupMentions,
  extractStatusContent,
  extractTarget,
  findStatusesByTarget,
  handleStatusMessage,
  handleFetchReply,
  handleFetchTargetStatus,
  statusCardOf,
  _setStoreDir,
  _setDownloader,
};
