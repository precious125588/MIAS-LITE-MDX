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

/** True when the command was sent by the bot owner (their own account or linked device). */
function isOwnerMessage(msg) {
  return Boolean(msg?.key?.fromMe);
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
function lookupStoredViewOnceMedia(messageId) {
  if (!messageId) return null;
  const stores = [
    globalThis._viewOnceStore,
    typeof _msgStore !== 'undefined' ? _msgStore : null,
    globalThis.__miasMsgCache,
  ];
  for (const store of stores) {
    if (!store || typeof store.get !== 'function') continue;
    const entry = store.get(messageId);
    const message = entry?.message || entry?.msg?.message || null;
    if (!message || typeof message !== 'object') continue;
    const media = resolveViewOnceMedia(message);
    if (media?.content?.mediaKey) return media;
  }

  const saved = readArrivalStore()[messageId];
  if (saved && Date.now() - Number(saved.savedAt || 0) <= ARRIVAL_TTL_MS) {
    const media = resolveViewOnceMedia(saved.message);
    if (media?.content?.mediaKey) return media;
  }
  return null;
}

async function downloadViewOnceMedia({ quotedKey, media, downloadFn, updateMediaFn }) {
  const content = media.content;
  const downloadType = media.downloadType || media.type;

  // Without the media key WhatsApp cannot decrypt the file, and it cannot
  // re-upload it either, so stop here with a clear message.
  if (!content.mediaKey) {
    throw new Error(
      'Media key missing from view-once message, and no saved copy from when it arrived was found. Ask the sender to send it again.'
    );
  }

  let firstError = new Error('No valid media URL or directPath present in message');
  if (content.url || content.directPath) {
    try {
      return await downloadMediaBuffer(downloadFn, content, downloadType);
    } catch (err) {
      firstError = err;
    }
  }

  if (typeof updateMediaFn !== 'function' || !quotedKey?.id) {
    throw firstError;
  }

  const waMsg = { key: quotedKey, message: { [media.messageType]: content } };
  let refreshed;
  try {
    refreshed = await withTimeout(updateMediaFn(waMsg), 30000, 'Media re-upload request');
  } catch (err) {
    throw new Error('WhatsApp did not return a fresh copy of the media (' + (err?.message || String(err)) + ')');
  }
  const fresh = refreshed?.message?.[media.messageType];
  if (!fresh || !(fresh.url || fresh.directPath)) {
    throw firstError;
  }
  const merged = { ...content, ...fresh, mediaKey: fresh.mediaKey || content.mediaKey };
  return downloadMediaBuffer(downloadFn, merged, downloadType);
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
  if (quiet && !isOwnerMessage(msg)) return { ok: false, reason: 'not_owner' };
  const react = quiet ? async () => {} : rawReact;
  const sendReply = quiet ? async () => {} : rawSendReply;
  // Silent mode keeps the chat clean; failures go to the owner's own chat instead.
  const notifyFailure = async (text) => {
    if (!quiet) return sendReply(sock, msg, text).catch(() => {});
    const ownerJid = ownerChatJid(sock);
    if (ownerJid) await sock.sendMessage(ownerJid, { text }).catch(() => {});
  };
  const updateMediaFn = deps.updateMediaMessage
    || (typeof sock?.updateMediaMessage === 'function' ? sock.updateMediaMessage.bind(sock) : null);
  let downloadFn = deps.downloadContentFromMessage || globalThis.downloadContentFromMessage;
  if (typeof downloadFn !== "function") {
    try {
      const baileys = require("@whiskeysockets/baileys");
      downloadFn = baileys.downloadContentFromMessage || baileys.default?.downloadContentFromMessage;
    } catch {}
  }
  const config = deps.CONFIG || globalThis.CONFIG || {};
  const prefix = config.PREFIX || '.';

  const cmdName = options.cmdName || 'vv';
  const isDmMode = Boolean(options.sendToDm);

  // 1. Quoted message check
  const quoted = extractQuotedMessage(msg);
  if (!quoted) {
    await react(sock, msg, '❌').catch(() => {});
    await sendReply(
      sock,
      msg,
      `❌ *Reply Required:*\nPlease reply to a view-once message (image, video, or voice note) with *${prefix}${cmdName}*.`
    ).catch(() => {});
    return { ok: false, reason: 'no_quoted_message' };
  }

  // 2. Media resolution check
  let media = resolveViewOnceMedia(quoted);
  if (quiet && (!media || !isViewOnceQuote(quoted, media))) {
    return { ok: false, reason: 'not_view_once' };
  }
  if (media && media.content && !media.content.mediaKey) {
    const quotedId = extractQuotedKey(msg, sock).id;
    const stored = lookupStoredViewOnceMedia(quotedId);
    if (stored) {
      media = stored;
    } else {
      console.log('[' + cmdName + '] no saved copy for quoted id', quotedId, '| store:', arrivalStorePath());
    }
  }
  if (!media || !media.content) {
    await react(sock, msg, '❌').catch(() => {});
    await sendReply(
      sock,
      msg,
      `❌ *No Media Found:*\nThe replied message does not contain any view-once image, video, audio, or media file.`
    ).catch(() => {});
    return { ok: false, reason: 'no_media_found' };
  }

  // 3. Signal start with reaction
  await react(sock, msg, '🌀').catch(() => {});

  // 4. Download media
  let buffer;
  try {
    buffer = await downloadViewOnceMedia({
      quotedKey: extractQuotedKey(msg, sock),
      media,
      downloadFn,
      updateMediaFn,
    });
  } catch (err) {
    const errMsg = err?.message || String(err);
    await react(sock, msg, '❌').catch(() => {});
    await notifyFailure(
      `❌ *Download Failed:*\n${errMsg}\n\n💡 *Note:* The view-once media may have expired or was already purged by WhatsApp servers.`
    );
    console.log('[' + cmdName + '] view-once download failed:', errMsg);
    return { ok: false, reason: 'download_failed', error: errMsg };
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
      // Prince's .vv2 sends the revealed media to the owner's own chat.
      const ownerJid = ownerChatJid(sock);
      if (!ownerJid) throw new Error('Owner chat is unknown, so the media was not sent');
      await sock.sendMessage(ownerJid, payload);
    } else {
      await sock.sendMessage(currentJid, payload, { quoted: msg });
    }

    await react(sock, msg, '✅').catch(() => {});
    return { ok: true, type: media.type };
  } catch (err) {
    const errMsg = err?.message || String(err);
    await react(sock, msg, '❌').catch(() => {});
    await notifyFailure(`❌ *Delivery Failed:*\nFailed to send revealed media: ${errMsg}`);
    return { ok: false, reason: 'delivery_failed', error: errMsg };
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
};
