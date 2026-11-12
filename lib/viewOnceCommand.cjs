'use strict';

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
  return null;
}

async function downloadViewOnceMedia({ quotedKey, media, downloadFn, updateMediaFn }) {
  const content = media.content;
  const downloadType = media.downloadType || media.type;
  let firstError = new Error('No valid media URL or directPath present in message');

  if (!content.mediaKey) {
    firstError = new Error('Media key missing from view-once message');
  }
  if ((content.url || content.directPath) && content.mediaKey) {
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
  const refreshed = await withTimeout(updateMediaFn(waMsg), 30000, 'Media re-upload request');
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
  const react = quiet ? async () => {} : rawReact;
  const sendReply = quiet ? async () => {} : rawSendReply;
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
  if (media && media.content && !media.content.mediaKey) {
    const stored = lookupStoredViewOnceMedia(extractQuotedKey(msg, sock).id);
    if (stored) media = stored;
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
    await sendReply(
      sock,
      msg,
      `❌ *Download Failed:*\n${errMsg}\n\n💡 *Note:* The view-once media may have expired or was already purged by WhatsApp servers.`
    ).catch(() => {});
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
      const getSender = deps.getSender || globalThis.getSender;
      const isGroup = deps.isGroup || globalThis.isGroup;
      const inGroup = typeof isGroup === 'function' ? isGroup(msg) : currentJid.endsWith('@g.us');

      let targetJid = currentJid;
      if (inGroup) {
        const sender = typeof getSender === 'function' ? getSender(msg) : (msg.key?.participant || '');
        if (sender) {
          const digits = sender.split('@')[0].split(':')[0].replace(/\D/g, '');
          if (digits) {
            targetJid = digits + '@s.whatsapp.net';
          }
        }
      }

      await sock.sendMessage(targetJid, payload);

      if (inGroup && targetJid !== currentJid) {
        await sendReply(
          sock,
          msg,
          `🔒 *View-Once Revealed:*\nThe media has been sent silently to your Private Chat (DM)!`
        ).catch(() => {});
      }
    } else {
      await sock.sendMessage(currentJid, payload, { quoted: msg });
    }

    await react(sock, msg, '✅').catch(() => {});
    return { ok: true, type: media.type };
  } catch (err) {
    const errMsg = err?.message || String(err);
    await react(sock, msg, '❌').catch(() => {});
    await sendReply(
      sock,
      msg,
      `❌ *Delivery Failed:*\nFailed to send revealed media: ${errMsg}`
    ).catch(() => {});
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
};
