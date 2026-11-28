'use strict';

const fs = require('fs');
const path = require('path');
const messageContent = require('../mias/lib/messageContent.cjs');

/**
 * Extracts and unwraps the target quoted message from the command message.
 * Supports:
 * - messageContent.getQuotedMessage(msg)
 * - Ephemeral message wrappers
 * - Direct contextInfo on extendedTextMessage / media nodes
 * - msg.quoted?.message
 */
function extractQuotedMessage(msg) {
  if (!msg) return null;

  try {
    const quoted = messageContent.getQuotedMessage(msg);
    if (quoted) return quoted;
  } catch {}

  const root = msg.message || msg;
  const unwrappedRoot = messageContent.unwrapMessage(root);
  const context = (
    messageContent.getContextInfo(msg) ||
    unwrappedRoot?.extendedTextMessage?.contextInfo ||
    unwrappedRoot?.imageMessage?.contextInfo ||
    unwrappedRoot?.videoMessage?.contextInfo ||
    unwrappedRoot?.audioMessage?.contextInfo ||
    unwrappedRoot?.documentMessage?.contextInfo ||
    null
  );

  return context?.quotedMessage || msg.quoted?.message || msg.quoted?.msg || null;
}

/**
 * Resolves media node from the quoted message, unwrapping view-once layers.
 */
function resolveViewOnceMedia(quotedMessage) {
  if (!quotedMessage) return null;

  const unwrapped = messageContent.unwrapMessage(quotedMessage);

  // 1. Try messageContent.findMediaNode
  const found = messageContent.findMediaNode(unwrapped);
  if (found && found.content) {
    return {
      content: found.content,
      type: found.type,
      messageType: found.messageType,
      downloadType: found.downloadType || found.type,
      mimetype: found.mimetype || (found.type === 'image' ? 'image/jpeg' : found.type === 'video' ? 'video/mp4' : 'audio/mp4'),
      caption: found.content.caption || '',
      ptt: Boolean(found.content.ptt),
      fileName: found.fileName || '',
    };
  }

  // 2. Direct checks
  if (unwrapped.imageMessage) {
    return {
      content: unwrapped.imageMessage,
      type: 'image',
      messageType: 'imageMessage',
      downloadType: 'image',
      mimetype: unwrapped.imageMessage.mimetype || 'image/jpeg',
      caption: unwrapped.imageMessage.caption || '',
    };
  }

  if (unwrapped.videoMessage) {
    return {
      content: unwrapped.videoMessage,
      type: 'video',
      messageType: 'videoMessage',
      downloadType: 'video',
      mimetype: unwrapped.videoMessage.mimetype || 'video/mp4',
      caption: unwrapped.videoMessage.caption || '',
    };
  }

  if (unwrapped.audioMessage) {
    return {
      content: unwrapped.audioMessage,
      type: 'audio',
      messageType: 'audioMessage',
      downloadType: 'audio',
      mimetype: unwrapped.audioMessage.mimetype || 'audio/mp4',
      ptt: Boolean(unwrapped.audioMessage.ptt),
    };
  }

  if (unwrapped.ptvMessage) {
    return {
      content: unwrapped.ptvMessage,
      type: 'video',
      messageType: 'ptvMessage',
      downloadType: 'video',
      mimetype: unwrapped.ptvMessage.mimetype || 'video/mp4',
      caption: unwrapped.ptvMessage.caption || '',
    };
  }

  if (unwrapped.documentMessage) {
    const doc = unwrapped.documentMessage;
    const isImg = messageContent.isImageDocument(doc);
    return {
      content: doc,
      type: isImg ? 'image' : 'document',
      messageType: 'documentMessage',
      downloadType: 'document',
      mimetype: doc.mimetype || 'application/octet-stream',
      fileName: doc.fileName || 'viewonce',
      caption: doc.caption || '',
    };
  }

  return null;
}

/**
 * Downloads media buffer from stream with a safety timeout.
 */
async function downloadMediaBuffer(downloadFn, mediaContent, downloadType, timeoutMs = 35000) {
  if (typeof downloadFn !== 'function') {
    throw new Error('downloadContentFromMessage is not available');
  }

  if (!mediaContent || !mediaContent.mediaKey) {
    throw new Error('Media key missing from view-once message');
  }

  let stream;
  try {
    stream = await downloadFn(mediaContent, downloadType);
  } catch (err) {
    throw new Error('Could not decrypt view-once media: ' + (err?.message || String(err)));
  }
  if (!stream) {
    throw new Error('WhatsApp returned no media stream');
  }
  const chunks = [];
  let timer = null;

  try {
    await Promise.race([
      (async () => {
        for await (const chunk of stream) {
          chunks.push(chunk);
        }
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Download timed out after ' + Math.round(timeoutMs / 1000) + 's')), timeoutMs);
        if (timer && typeof timer.unref === 'function') {
          timer.unref();
        }
      }),
    ]);
  } catch (err) {
    const message = err?.message || String(err);
    if (/timed out/.test(message)) throw err;
    throw new Error('Could not decrypt view-once media: ' + message);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }

  const buffer = Buffer.concat(chunks);
  if (!buffer || buffer.length === 0) {
    throw new Error('Downloaded media buffer is empty');
  }
  return buffer;
}

/**
 * Extracts the quoted message's key (id, chat, author) so WhatsApp can be asked
 * to re-upload media whose link was dropped.
 */
function extractQuotedKey(msg, sock) {
  const root = msg?.message || msg || {};
  const unwrapped = messageContent.unwrapMessage(root);
  const ctx = messageContent.getContextInfo(msg)
    || unwrapped?.extendedTextMessage?.contextInfo
    || unwrapped?.imageMessage?.contextInfo
    || unwrapped?.videoMessage?.contextInfo
    || unwrapped?.audioMessage?.contextInfo
    || unwrapped?.documentMessage?.contextInfo
    || {};
  const bare = (jid) => String(jid || '').split('@')[0].split(':')[0];
  const botId = sock?.user?.id || '';
  const fromMe = Boolean(ctx.participant && botId && bare(ctx.participant) === bare(botId));
  return {
    remoteJid: msg?.key?.remoteJid || '',
    id: ctx.stanzaId || msg?.quoted?.id || msg?.quoted?.key?.id || '',
    participant: ctx.participant || undefined,
    fromMe,
  };
}

function withTimeout(promise, ms, label) {
  let timer = null;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label + ' timed out after ' + Math.round(ms / 1000) + 's')), ms);
      if (timer && typeof timer.unref === 'function') timer.unref();
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Downloads the view-once media. When WhatsApp has dropped the media link
 * (the "No valid media URL or directPath" case) or the link is expired, asks
 * the sender's device to re-upload the media and downloads the fresh copy.
 */
/**
 * Looks up the original view-once message the bot stored when it arrived.
 * WhatsApp's quoted copy can lose its media key once the view-once is opened,
 * but the arrival-time copy still has it.
 */
const ARRIVAL_TTL_MS = 24 * 60 * 60 * 1000;
const ARRIVAL_MAX_ENTRIES = 500;

/**
 * Where arrival-time copies of view-once messages are kept on disk. The bot's
 * in-memory cache is wiped on every restart, so a copy saved before a restart
 * would otherwise be lost. Defaults to the nexstore volume used on Railway.
 */
function arrivalStorePath() {
  if (process.env.VIEWONCE_STORE_FILE) return process.env.VIEWONCE_STORE_FILE;
  if (process.env.VIEWONCE_STORE_DIR) return path.join(process.env.VIEWONCE_STORE_DIR, 'viewonce-arrivals.json');
  let dir = path.join(__dirname, '..', 'nexstore');
  try {
    const sessionPaths = require('../nexstore_modules/sessionPaths.js');
    if (sessionPaths?.isVolumeMounted?.()) dir = sessionPaths.nexstoreRoot();
  } catch {}
  return path.join(dir, 'viewonce-arrivals.json');
}

/** The owner's own chat (device suffix removed), as Prince's .vv2 sends to it. */
function ownerChatJid(sock) {
  const raw = String(sock?.user?.id || '');
  const at = raw.indexOf('@');
  if (at < 0) return null;
  return raw.slice(0, at).split(':')[0] + raw.slice(at);
}

function encodeArrivalValue(_key, value) {
  if (value && value.type === 'Buffer' && Array.isArray(value.data)) {
    return { __buf: Buffer.from(value.data).toString('base64') };
  }
  if (value instanceof Uint8Array) {
    return { __buf: Buffer.from(value).toString('base64') };
  }
  return value;
}

function decodeArrivalValue(_key, value) {
  if (value && typeof value === 'object' && typeof value.__buf === 'string') {
    return Buffer.from(value.__buf, 'base64');
  }
  return value;
}

function readArrivalStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(arrivalStorePath(), 'utf8'), decodeArrivalValue);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeArrivalStore(data) {
  const file = arrivalStorePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, encodeArrivalValue));
  fs.renameSync(tmp, file);
}

function isViewOnceEnvelope(message) {
  if (!message || typeof message !== 'object') return false;
  const top = message.ephemeralMessage?.message || message;
  return Boolean(top.viewOnceMessage || top.viewOnceMessageV2 || top.viewOnceMessageV2Extension);
}

function normalizeJid(jid) {
  if (!jid) return null;
  const raw = String(jid).trim();
  const at = raw.indexOf('@');
  if (at < 0) return raw + '@s.whatsapp.net';
  const user = raw.slice(0, at).split(':')[0];
  const server = raw.slice(at);
  return user + server;
}

function getSenderJid(msg, sock, deps = {}) {
  if (typeof deps.getSender === 'function') {
    try {
      const s = deps.getSender(msg);
      if (s) return normalizeJid(s);
    } catch {}
  }
  if (typeof globalThis.getSender === 'function') {
    try {
      const s = globalThis.getSender(msg);
      if (s) return normalizeJid(s);
    } catch {}
  }
  const participant = msg?.key?.participant || msg?.participant;
  if (participant) return normalizeJid(participant);
  const remote = msg?.key?.remoteJid;
  if (remote && !remote.endsWith('@g.us') && remote !== 'status@broadcast') {
    return normalizeJid(remote);
  }
  return null;
}

/** True when the command was sent by the bot owner (their own account, linked device, or authorized owner). */
function isOwnerMessage(msg, sock, deps = {}) {
  if (msg?.key?.fromMe) return true;

  const sender = getSenderJid(msg, sock, deps) || msg?.key?.participant || msg?.key?.remoteJid || '';
  const senderDigits = String(sender).split('@')[0].split(':')[0].replace(/[^0-9]/g, '');

  if (typeof deps.isOwner === 'function' && deps.isOwner(sender)) return true;
  if (typeof globalThis.isOwner === 'function' && globalThis.isOwner(sender)) return true;
  if (typeof globalThis.__miasIsOwner === 'function' && globalThis.__miasIsOwner(sender)) return true;
  if (typeof deps.isSudo === 'function' && deps.isSudo(sender)) return true;
  if (typeof globalThis.isSudo === 'function' && globalThis.isSudo(sender)) return true;

  const configOwner = String(deps.CONFIG?.OWNER_NUMBER || globalThis.CONFIG?.OWNER_NUMBER || '').replace(/[^0-9]/g, '');
  if (configOwner && senderDigits && (senderDigits === configOwner || senderDigits.endsWith(configOwner) || configOwner.endsWith(senderDigits))) {
    return true;
  }

  const botNum = String(sock?.user?.id || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
  if (botNum && senderDigits && senderDigits === botNum) {
    return true;
  }

  return false;
}

/** Resolves the target DM chat where revealed media should be sent in DM mode (.vv2). */
function resolveTargetDm(msg, sock, deps = {}) {
  // If the command was sent by another authorized user (not from the bot account):
  if (!msg?.key?.fromMe) {
    const sender = getSenderJid(msg, sock, deps);
    if (sender && !sender.endsWith('@g.us') && sender !== 'status@broadcast') {
      return normalizeJid(sender);
    }
  }

  // If the command was sent from the bot account itself (fromMe):
  const configOwner = deps.CONFIG?.OWNER_NUMBER || globalThis.CONFIG?.OWNER_NUMBER;
  if (configOwner) {
    const clean = String(configOwner).replace(/[^0-9]/g, '');
    if (clean) return clean + '@s.whatsapp.net';
  }

  if (typeof deps.getOwnerJid === 'function') {
    try {
      const oj = deps.getOwnerJid();
      if (oj) return normalizeJid(oj);
    } catch {}
  }

  return ownerChatJid(sock);
}

/** Clears a reaction from a message (WhatsApp / Baileys unreact). */
async function clearReaction(sock, msg, deps = {}, rawReact = null) {
  try {
    if (typeof deps?.unreact === 'function') {
      await deps.unreact(sock, msg);
    } else if (typeof rawReact === 'function') {
      await rawReact(sock, msg, '');
    } else if (sock?.sendMessage && msg?.key?.remoteJid) {
      await sock.sendMessage(msg.key.remoteJid, {
        react: { text: '', key: msg.key },
      });
    }
  } catch {}
}

/** True when the quoted media is a view-once: wrapped in a view-once envelope, or flagged on the media itself. */
function isViewOnceQuote(quoted, media) {
  return isViewOnceEnvelope(quoted) || Boolean(media?.content?.viewOnce);
}

/**
 * Saves a view-once message the moment it arrives, with its media key, to disk.
 * Call this from the message-arrival handler for every incoming message.
 */
function rememberViewOnceArrival(msg) {
  try {
    const id = msg?.key?.id;
    if (!id) return false;
    const media = resolveViewOnceMedia(msg.message);
    if (!isViewOnceEnvelope(msg.message) && !media?.content?.viewOnce) return false;
    if (!media?.content?.mediaKey) {
      console.log('[viewonce-store] arrival has no media key, not saved:', id);
      return false;
    }

    const store = readArrivalStore();
    const now = Date.now();
    for (const [key, entry] of Object.entries(store)) {
      if (!entry || now - Number(entry.savedAt || 0) > ARRIVAL_TTL_MS) delete store[key];
    }
    store[id] = { savedAt: now, message: msg.message };
    const remoteJid = msg?.key?.remoteJid || '';
    if (remoteJid) {
      store[remoteJid + '|' + id] = { savedAt: now, message: msg.message };
    }

    const keys = Object.keys(store);
    if (keys.length > ARRIVAL_MAX_ENTRIES) {
      keys.sort((a, b) => Number(store[a].savedAt) - Number(store[b].savedAt));
      for (const key of keys.slice(0, keys.length - ARRIVAL_MAX_ENTRIES)) delete store[key];
    }
    writeArrivalStore(store);
    console.log('[viewonce-store] saved view-once arrival', id, 'to', arrivalStorePath());
    return true;
  } catch (err) {
    console.log('[viewonce-store] could not save view-once arrival:', err?.message || err);
    return false;
  }
}

/**
 * Looks up the original view-once message the bot saw when it arrived.
 * WhatsApp's quoted copy can lose its media key once the view-once is opened,
 * but the arrival-time copy still has it. Checks memory first, then disk.
 */
function normalizeMediaKey(key) {
  if (!key) return null;
  if (typeof key === 'string' || Buffer.isBuffer(key) || key instanceof Uint8Array) return key;
  if (key && typeof key === 'object') {
    if (key.__buf && typeof key.__buf === 'string') {
      return Buffer.from(key.__buf, 'base64');
    }
    if (key.type === 'Buffer' && Array.isArray(key.data)) {
      return Buffer.from(key.data);
    }
    const vals = Object.values(key);
    if (vals.length > 0 && vals.every(v => typeof v === 'number')) {
      return Buffer.from(vals);
    }
  }
  return key;
}

function lookupStoredViewOnceMedia(messageId, remoteJid) {
  if (!messageId) return null;
  const stores = [
    globalThis._viewOnceStore,
    globalThis._msgRetryStore,
    globalThis._msgStore,
    typeof _msgStore !== 'undefined' ? _msgStore : null,
    globalThis.__miasMsgCache,
  ];
  for (const store of stores) {
    if (!store || typeof store.get !== 'function') continue;
    let entry = store.get(messageId);
    if (!entry && remoteJid) {
      entry = store.get(remoteJid + '|' + messageId);
    }
    if (!entry) continue;
    const message = entry?.message || entry?.msg?.message || entry?.raw || entry;
    if (!message || typeof message !== 'object') continue;
    const media = resolveViewOnceMedia(message);
    if (media?.content?.mediaKey) {
      media.content.mediaKey = normalizeMediaKey(media.content.mediaKey);
      return media;
    }
  }

  const arrivalStore = readArrivalStore();
  const saved = arrivalStore[messageId] || (remoteJid ? arrivalStore[remoteJid + '|' + messageId] : null);
  if (saved && Date.now() - Number(saved.savedAt || 0) <= ARRIVAL_TTL_MS) {
    const media = resolveViewOnceMedia(saved.message);
    if (media?.content?.mediaKey) {
      media.content.mediaKey = normalizeMediaKey(media.content.mediaKey);
      return media;
    }
  }
  return null;
}

async function relayLevanterViewOnce(sock, targetJid, quotedMsg, originalMsg) {
  try {
    if (!sock || typeof sock.relayMessage !== "function") return false;
    let unwrapped = quotedMsg;
    for (let i = 0; i < 5; i++) {
      const inner = unwrapped?.viewOnceMessage?.message
        || unwrapped?.viewOnceMessageV2?.message
        || unwrapped?.viewOnceMessageV2Extension?.message
        || unwrapped?.ephemeralMessage?.message
        || unwrapped?.documentWithCaptionMessage?.message;
      if (!inner || inner === unwrapped) break;
      unwrapped = inner;
    }

    const mediaKey = ["imageMessage", "videoMessage", "audioMessage", "ptvMessage", "documentMessage"].find(k => unwrapped?.[k]);
    if (!mediaKey) return false;

    const cloned = JSON.parse(JSON.stringify(unwrapped));
    if (cloned[mediaKey]) {
      cloned[mediaKey].viewOnce = false;
    }

    const messageId = (typeof sock.generateMessageTag === "function" ? sock.generateMessageTag() : null) || ("relay_" + Date.now());
    await sock.relayMessage(targetJid, cloned, { messageId });
    return true;
  } catch (err) {
    console.log("[levanter-relay] relay failed:", err?.message || err);
    return false;
  }
}

async function downloadViewOnceMedia({ quotedKey, media, downloadFn, updateMediaFn, sock, downloadMediaFn, deps }) {
  const content = media.content;
  const downloadType = media.downloadType || media.type;

  if (content.mediaKey) {
    content.mediaKey = normalizeMediaKey(content.mediaKey);
  }
  // Without the media key WhatsApp cannot decrypt the file, and it cannot
  // re-upload it either, so stop here with a clear message.
  if (!content.mediaKey) {
    throw new Error(
      "Media key missing and no saved copy. Ask the sender to resend."
    );
  }

  let dlFn = downloadFn;
  if (typeof dlFn !== 'function') {
    dlFn = deps?.downloadContentFromMessage || globalThis.downloadContentFromMessage;
  }
  let dlMediaFn = downloadMediaFn;
  if (typeof dlMediaFn !== 'function') {
    dlMediaFn = deps?.downloadMediaMessage || globalThis.downloadMediaMessage;
  }
  if (typeof dlFn !== 'function' || typeof dlMediaFn !== 'function') {
    let baileys = null;
    try {
      baileys = require('@whiskeysockets/baileys');
    } catch {}
    if (!baileys && globalThis.Baileys) baileys = globalThis.Baileys;
    if (baileys) {
      if (typeof dlFn !== 'function') {
        dlFn = baileys.downloadContentFromMessage || baileys.default?.downloadContentFromMessage;
      }
      if (typeof dlMediaFn !== 'function') {
        dlMediaFn = baileys.downloadMediaMessage || baileys.default?.downloadMediaMessage;
      }
    }
  }

  let firstError = new Error("No valid media URL or directPath present in message");
  // Strategy 1 (Standard stream download)
  if (content.url || content.directPath) {
    try {
      return await downloadMediaBuffer(dlFn, content, downloadType);
    } catch (err) {
      firstError = err;
    }
  }

  // Strategy 2 (Baileys downloadMediaMessage with automatic re-upload fallback)
  if (typeof dlMediaFn === 'function' || typeof sock?.downloadMediaMessage === 'function') {
    try {
      const waMsg = { key: quotedKey, message: { [media.messageType]: content } };
      let buf;
      if (typeof dlMediaFn === 'function') {
        buf = await dlMediaFn(waMsg, 'buffer', {}, {
          reuploadRequest: updateMediaFn,
          logger: sock?.logger || { info() {}, error() {}, warn() {}, debug() {}, trace() {} }
        });
      } else if (typeof sock.downloadMediaMessage === 'function') {
        buf = await sock.downloadMediaMessage(waMsg);
      }
      if (buf && buf.length) return buf;
    } catch (err) {
      if (!firstError) firstError = err;
    }
  }

  // Strategy 3 (Prince + Xylo: Re-request fresh media from WhatsApp)
  if (typeof updateMediaFn === "function" && quotedKey?.id) {
    const waMsg = { key: quotedKey, message: { [media.messageType]: content } };
    let refreshed;
    try {
      refreshed = await withTimeout(updateMediaFn(waMsg), 30000, "Media re-upload request");
    } catch (err) {
      // Don't crash immediately, let other fallbacks try
    }
    const fresh = refreshed?.message?.[media.messageType];
    if (fresh && (fresh.url || fresh.directPath)) {
      const merged = { ...content, ...fresh, mediaKey: normalizeMediaKey(fresh.mediaKey || content.mediaKey) };
      try {
        return await downloadMediaBuffer(dlFn, merged, downloadType);
      } catch (err) {
        if (!firstError) firstError = err;
      }
    }
  }

  // Strategy 4 (Stored media buffer fallback)
  if (typeof globalThis.downloadStoredMediaBuffer === 'function') {
    try {
      const buf = await globalThis.downloadStoredMediaBuffer(content, downloadType);
      if (buf && buf.length) return buf;
    } catch (err) {
      if (!firstError) firstError = err;
    }
  }

  throw firstError;
}

/**
 * Main handler for .vv and .vv2 commands
 */
async function handleViewOnceCommand(sock, msg, args = [], options = {}, deps = {}) {
  const rawReact = deps.react || globalThis.react || (async (s, m, r) => s?.sendMessage?.(m?.key?.remoteJid, { react: { text: r, key: m?.key } }));
  const rawSendReply = deps.sendReply || globalThis.sendReply || (async (s, m, t) => s?.sendMessage?.(m?.key?.remoteJid, { text: t }, { quoted: m }));
  // .vv2 runs silently: no reactions and no chat text, success or failure.
  const quiet = Boolean(options.silent);
  // .vv2 is owner-only: anyone else gets no reaction, reply or media, and no error either.
  if (quiet && !isOwnerMessage(msg, sock, deps)) return { ok: false, reason: 'not_owner' };
  const react = quiet ? async () => {} : rawReact;
  const sendReply = quiet ? async () => {} : rawSendReply;

  const isDmMode = Boolean(options.sendToDm);
  const targetDm = isDmMode ? resolveTargetDm(msg, sock, deps) : null;

  // Silent mode keeps the chat clean; failures go to the owner's private DM instead.
  const notifyFailure = async (text) => {
    if (!quiet) return sendReply(sock, msg, text).catch(() => {});
    const dm = targetDm || resolveTargetDm(msg, sock, deps);
    if (dm) await sock.sendMessage(dm, { text }).catch(() => {});
  };

  try {
    const updateMediaFn = deps.updateMediaMessage
      || (typeof sock?.updateMediaMessage === 'function' ? sock.updateMediaMessage.bind(sock) : null);
    let downloadFn = deps.downloadContentFromMessage || globalThis.downloadContentFromMessage;
    let downloadMediaFn = deps.downloadMediaMessage || globalThis.downloadMediaMessage;
    if (typeof downloadFn !== 'function' || typeof downloadMediaFn !== 'function') {
      let baileys = null;
      try {
        baileys = require('@whiskeysockets/baileys');
      } catch {}
      if (!baileys && globalThis.Baileys) baileys = globalThis.Baileys;
      if (baileys) {
        if (typeof downloadFn !== 'function') {
          downloadFn = baileys.downloadContentFromMessage || baileys.default?.downloadContentFromMessage;
        }
        if (typeof downloadMediaFn !== 'function') {
          downloadMediaFn = baileys.downloadMediaMessage || baileys.default?.downloadMediaMessage;
        }
      }
    }
    const config = deps.CONFIG || globalThis.CONFIG || {};
    const prefix = config.PREFIX || '.';

    const cmdName = options.cmdName || 'vv';

    // 1. Quoted message check
    const quoted = extractQuotedMessage(msg);
    if (!quoted) {
      if (!quiet) await react(sock, msg, '❌').catch(() => {});
      await notifyFailure(
        `❌ *Reply Required:*\nPlease reply to a view-once message (image, video, or voice note) with *${prefix}${cmdName}*.`
      );
      return { ok: false, reason: 'no_quoted_message' };
    }

    // 2. Media resolution check
    let media = resolveViewOnceMedia(quoted);
    const quotedKey = extractQuotedKey(msg, sock);
    const quotedId = quotedKey?.id;
    let stored = null;
    if (quotedId) {
      stored = lookupStoredViewOnceMedia(quotedId, quotedKey?.remoteJid);
      if (stored && stored.content) {
        if (!media || !media.content) {
          media = stored;
        } else {
          // Merge arrival-time stored copy: restores full directPath, url, and mediaKey stripped by WhatsApp
          media.content = {
            ...stored.content,
            ...media.content,
            directPath: stored.content.directPath || media.content.directPath,
            url: stored.content.url || media.content.url,
            mediaKey: normalizeMediaKey(stored.content.mediaKey || media.content.mediaKey),
            fileEncSha256: stored.content.fileEncSha256 || media.content.fileEncSha256,
            fileSha256: stored.content.fileSha256 || media.content.fileSha256,
            fileLength: stored.content.fileLength || media.content.fileLength,
          };
          if (stored.type && !media.type) media.type = stored.type;
          if (stored.messageType && !media.messageType) media.messageType = stored.messageType;
          if (stored.downloadType && !media.downloadType) media.downloadType = stored.downloadType;
        }
      }
    }

    if (!media || !media.content) {
      if (!quiet) await react(sock, msg, '❌').catch(() => {});
      await notifyFailure(
        '❌ *No Media Found:*\nThe replied message does not contain any view-once image, video, audio, or media file.'
      );
      return { ok: false, reason: 'no_media_found' };
    }

    const isVo = Boolean(
      isViewOnceQuote(quoted, media) ||
      (stored && (isViewOnceEnvelope(stored) || Boolean(stored?.content?.viewOnce)))
    );

    // .vv only reviews viewonce messages, not normal messages!
    // Non-viewonce response must say reply vv to viewonce message and not exceed two lines.
    if (!isVo) {
      if (quiet) {
        return { ok: false, reason: 'not_view_once' };
      }
      await react(sock, msg, '❌').catch(() => {});
      await sendReply(
        sock,
        msg,
        `❌ *Please reply to a view-once message.*\nUsage: *${prefix}${cmdName}* (reply to view-once)`
      ).catch(() => {});
      return { ok: false, reason: 'not_view_once' };
    }

    // 3. Signal start with reaction (vv only; vv2 is silent)
    if (!quiet) {
      await react(sock, msg, '🌀').catch(() => {});
    }

    // 4. Download media with Prince + Xylo + Levanter fallbacks
    let buffer;
    let relayDelivered = false;
    try {
      buffer = await downloadViewOnceMedia({
        quotedKey: extractQuotedKey(msg, sock),
        media,
        downloadFn,
        updateMediaFn,
        sock,
        downloadMediaFn,
        deps,
      });
    } catch (err) {
      const errMsg = err?.message || String(err);
      // Strategy 4 (Levanter fallback): if buffer download fails, attempt rebroadcast / relay
      if (sock && typeof sock.relayMessage === 'function' && quoted) {
        try {
          const currentJid = msg.key?.remoteJid || '';
          const targetJid = isDmMode ? (targetDm || resolveTargetDm(msg, sock, deps)) : currentJid;
          if (targetJid) {
            const relayed = await relayLevanterViewOnce(sock, targetJid, quoted, msg);
            if (relayed) {
              relayDelivered = true;
            }
          }
        } catch (rErr) {
          console.log('[' + cmdName + '] levanter relay fallback failed:', rErr?.message || rErr);
        }
      }

      if (!relayDelivered) {
        if (!quiet) await react(sock, msg, '❌').catch(() => {});
        await notifyFailure(
          `❌ *Download Failed:*\n${errMsg}\n\n💡 Media may have expired.`
        );
        console.log('[' + cmdName + '] view-once download failed:', errMsg);
        return { ok: false, reason: 'download_failed', error: errMsg };
      }
    }

    const unreactDelay = typeof options.unreactDelayMs === 'number' ? options.unreactDelayMs : 1200;

    if (relayDelivered) {
      if (!quiet) {
        await react(sock, msg, '✅').catch(() => {});
        if (unreactDelay >= 0) {
          setTimeout(() => {
            clearReaction(sock, msg, deps, rawReact);
          }, unreactDelay);
        }
      }
      return { ok: true, type: media.type, mode: 'relay' };
    }

    // 5. Build outgoing payload
    const caption = media.caption || undefined;
    let payload;
    if (media.type === 'image') {
      payload = { image: buffer, caption };
    } else if (media.type === 'video') {
      payload = { video: buffer, mimetype: 'video/mp4', caption };
    } else if (media.type === 'audio') {
      payload = {
        audio: buffer,
        mimetype: media.mimetype || 'audio/mp4',
        ptt: Boolean(media.ptt),
      };
    } else {
      payload = {
        document: buffer,
        mimetype: media.mimetype || 'application/octet-stream',
        fileName: media.fileName || 'viewonce',
        caption,
      };
    }

    // 6. Deliver media
    try {
      const currentJid = msg.key?.remoteJid || '';

      if (isDmMode) {
        const dm = targetDm || resolveTargetDm(msg, sock, deps);
        if (!dm) throw new Error('Target DM chat is unknown, so the media was not sent');
        await sock.sendMessage(dm, payload);
      } else {
        await sock.sendMessage(currentJid, payload, { quoted: msg });
      }

      if (!quiet) {
        await react(sock, msg, '✅').catch(() => {});
        if (unreactDelay >= 0) {
          setTimeout(() => {
            clearReaction(sock, msg, deps, rawReact);
          }, unreactDelay);
        }
      }
      return { ok: true, type: media.type };
    } catch (err) {
      const errMsg = err?.message || String(err);
      if (!quiet) await react(sock, msg, '❌').catch(() => {});
      await notifyFailure(`❌ *Delivery Failed:*\nFailed to send revealed media: ${errMsg}`);
      return { ok: false, reason: 'delivery_failed', error: errMsg };
    }
  } catch (fatalErr) {
    const errMsg = fatalErr?.message || String(fatalErr);
    if (!quiet) await react(sock, msg, '❌').catch(() => {});
    await notifyFailure(`❌ *Error:* ${errMsg}`);
    return { ok: false, reason: 'error', error: errMsg };
  }
}

module.exports = {
  extractQuotedMessage,
  extractQuotedKey,
  resolveViewOnceMedia,
  downloadMediaBuffer,
  downloadViewOnceMedia,
  handleViewOnceCommand,
  ownerChatJid,
  rememberViewOnceArrival,
  lookupStoredViewOnceMedia,
  arrivalStorePath,
  normalizeMediaKey,
  normalizeJid,
  getSenderJid,
  isOwnerMessage,
  resolveTargetDm,
  clearReaction,
};
