'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

function unwrapQuotedMessage(rawQuoted) {
  let quoted = rawQuoted;
  for (let i = 0; i < 6 && quoted && typeof quoted === 'object'; i++) {
    const inner = quoted.viewOnceMessage?.message
      || quoted.viewOnceMessageV2?.message
      || quoted.viewOnceMessageV2Extension?.message
      || quoted.ephemeralMessage?.message
      || quoted.documentWithCaptionMessage?.message
      || quoted.editedMessage?.message;
    if (!inner || inner === quoted) break;
    quoted = inner;
  }
  return quoted;
}

async function downloadMediaToDisk(mediaMsg, type, ext = 'bin', dcm = null) {
  if (!mediaMsg) return { path: null, cleanup: () => {} };
  const rnd = crypto.randomBytes(6).toString('hex');
  const tmp = path.join(os.tmpdir(), `chat_${Date.now()}_${rnd}.${ext}`);
  const cleanup = () => {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {}
  };

  if (typeof mediaMsg.download === 'function') {
    try {
      const b = await mediaMsg.download();
      if (b && b.length > 0) {
        fs.writeFileSync(tmp, b);
        return { path: tmp, cleanup };
      }
    } catch {}
  }

  let resolver = dcm || globalThis.downloadContentFromMessage;
  if (typeof resolver !== 'function') {
    try {
      const b = require('@whiskeysockets/baileys');
      resolver = b.downloadContentFromMessage || (b.default && b.default.downloadContentFromMessage);
    } catch {}
  }

  if (typeof resolver === 'function') {
    try {
      const stream = await resolver(mediaMsg, type);
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      const b = Buffer.concat(chunks);
      if (b && b.length > 0) {
        fs.writeFileSync(tmp, b);
        return { path: tmp, cleanup };
      }
    } catch {}
  }

  if (typeof globalThis.__miasRobustDownload === 'function') {
    try {
      const b = await globalThis.__miasRobustDownload(null, mediaMsg, type);
      if (b && b.length > 0) {
        fs.writeFileSync(tmp, b);
        return { path: tmp, cleanup };
      }
    } catch {}
  }

  cleanup();
  return { path: null, cleanup: () => {} };
}

async function sendChatMediaOrText(sock, targetJid, rawQuoted, textArg = '', deps = {}) {
  const quoted = unwrapQuotedMessage(rawQuoted);
  const dcm = deps.downloadContentFromMessage || globalThis.downloadContentFromMessage;

  const imgMsg = quoted?.imageMessage;
  const vidMsg = quoted?.videoMessage || quoted?.ptvMessage;
  const audMsg = quoted?.audioMessage;
  const stkMsg = quoted?.stickerMessage;
  const docMsg = quoted?.documentMessage;
  const conMsg = quoted?.contactMessage || quoted?.contactsArrayMessage;
  const locMsg = quoted?.locationMessage || quoted?.liveLocationMessage;
  const quotedText = quoted?.conversation || quoted?.extendedTextMessage?.text || quoted?.interactiveMessage?.body?.text || quoted?.buttonsMessage?.contentText || '';
  const messageText = textArg || quotedText.trim();

  let tempCleanup = null;
  try {
    if (imgMsg) {
      const downloaded = await downloadMediaToDisk(imgMsg, 'image', 'jpg', dcm);
      tempCleanup = downloaded.cleanup;
      if (!downloaded.path) throw new Error('Could not download image');
      const buf = fs.readFileSync(downloaded.path);
      const caption = textArg || imgMsg.caption || '';
      const sent = await sock.sendMessage(targetJid, { image: buf, caption });
      return { success: Boolean(sent), type: 'IMAGE', sentMessage: sent };
    }

    if (vidMsg) {
      const downloaded = await downloadMediaToDisk(vidMsg, 'video', 'mp4', dcm);
      tempCleanup = downloaded.cleanup;
      if (!downloaded.path) throw new Error('Could not download video');
      const buf = fs.readFileSync(downloaded.path);
      const caption = textArg || vidMsg.caption || '';
      const payload = {
        video: buf,
        caption,
        mimetype: vidMsg.mimetype || 'video/mp4',
        gifPlayback: false,
      };
      if (quoted?.ptvMessage) payload.ptv = true;
      const sent = await sock.sendMessage(targetJid, payload);
      return { success: Boolean(sent), type: 'VIDEO', sentMessage: sent };
    }

    if (audMsg) {
      const downloaded = await downloadMediaToDisk(audMsg, 'audio', 'ogg', dcm);
      tempCleanup = downloaded.cleanup;
      if (!downloaded.path) throw new Error('Could not download audio');
      const buf = fs.readFileSync(downloaded.path);
      const sent = await sock.sendMessage(targetJid, {
        audio: buf,
        mimetype: audMsg.mimetype || 'audio/ogg; codecs=opus',
        ptt: Boolean(audMsg.ptt),
      });
      if (textArg) {
        await sock.sendMessage(targetJid, { text: textArg });
      }
      return { success: Boolean(sent), type: 'AUDIO', sentMessage: sent };
    }

    if (stkMsg) {
      const downloaded = await downloadMediaToDisk(stkMsg, 'sticker', 'webp', dcm);
      tempCleanup = downloaded.cleanup;
      if (!downloaded.path) throw new Error('Could not download sticker');
      const buf = fs.readFileSync(downloaded.path);
      const sent = await sock.sendMessage(targetJid, {
        sticker: buf,
        isAnimated: Boolean(stkMsg.isAnimated),
      });
      if (textArg) {
        await sock.sendMessage(targetJid, { text: textArg });
      }
      return { success: Boolean(sent), type: 'STICKER', sentMessage: sent };
    }

    if (docMsg) {
      const fileExt = String(docMsg.fileName || 'file.bin').split('.').pop() || 'bin';
      const downloaded = await downloadMediaToDisk(docMsg, 'document', fileExt, dcm);
      tempCleanup = downloaded.cleanup;
      if (!downloaded.path) throw new Error('Could not download document');
      const buf = fs.readFileSync(downloaded.path);
      const caption = textArg || docMsg.caption || '';
      const sent = await sock.sendMessage(targetJid, {
        document: buf,
        caption,
        mimetype: docMsg.mimetype || 'application/octet-stream',
        fileName: docMsg.fileName || 'file',
      });
      return { success: Boolean(sent), type: 'DOCUMENT', sentMessage: sent };
    }

    if (conMsg) {
      let sent;
      if (quoted?.contactMessage) {
        sent = await sock.sendMessage(targetJid, {
          contacts: {
            displayName: quoted.contactMessage.displayName,
            contacts: [{ vcard: quoted.contactMessage.vcard }],
          },
        });
      } else {
        sent = await sock.sendMessage(targetJid, {
          contacts: { contacts: quoted.contactsArrayMessage.contacts },
        });
      }
      return { success: Boolean(sent), type: 'CONTACT', sentMessage: sent };
    }

    if (locMsg) {
      const loc = quoted.locationMessage || quoted.liveLocationMessage;
      const sent = await sock.sendMessage(targetJid, {
        location: {
          degreesLatitude: loc.degreesLatitude,
          degreesLongitude: loc.degreesLongitude,
          name: loc.name || loc.address || '',
        },
      });
      return { success: Boolean(sent), type: 'LOCATION', sentMessage: sent };
    }

    if (messageText) {
      const sent = await sock.sendMessage(targetJid, { text: messageText });
      return { success: Boolean(sent), type: 'TEXT', sentMessage: sent };
    }

    throw new Error('No supported message content found to forward');
  } finally {
    if (tempCleanup) tempCleanup();
  }
}

/**
 * Handler for .chat command:
 * .chat <number> <message>
 * Reply to media + .chat <number> [caption]
 * Single-line usage output:
 * Usage: <prefix>chat 2349068551055 hello
 * On send:
 * chat sent ✅
 */
async function handleChatCommand(sock, msg, args = [], options = {}, deps = {}) {
  const sendReply = deps.sendReply || globalThis.sendReply || (async (s, m, t) => s?.sendMessage?.(m?.key?.remoteJid, { text: t }, { quoted: m }));
  const config = deps.CONFIG || globalThis.CONFIG || {};
  const prefix = config.PREFIX === '' ? '' : (config.PREFIX || '.');

  const rawTarget = args?.[0] || '';
  const digits = String(rawTarget).replace(/[^0-9]/g, '');

  const rawQuoted = msg?.message?.extendedTextMessage?.contextInfo?.quotedMessage;
  const quoted = unwrapQuotedMessage(rawQuoted);

  const imgMsg = quoted?.imageMessage;
  const vidMsg = quoted?.videoMessage || quoted?.ptvMessage;
  const audMsg = quoted?.audioMessage;
  const stkMsg = quoted?.stickerMessage;
  const docMsg = quoted?.documentMessage;
  const hasMedia = !!(imgMsg || vidMsg || audMsg || stkMsg || docMsg);

  const textArg = (args?.slice(1)?.join(' ')?.trim()) || '';
  const quotedText = quoted?.conversation || quoted?.extendedTextMessage?.text || quoted?.interactiveMessage?.body?.text || '';
  const messageText = textArg || quotedText.trim();

  if (!digits || digits.length < 5 || (!hasMedia && !messageText)) {
    return await sendReply(sock, msg, 'Usage: ' + prefix + 'chat 2349068551055 hello');
  }

  const targetJid = digits + '@s.whatsapp.net';

  try {
    const res = await sendChatMediaOrText(sock, targetJid, rawQuoted, textArg, deps);
    if (!res || !res.success) {
      throw new Error('Could not send message or media');
    }
    return await sendReply(sock, msg, 'chat sent ✅');
  } catch (err) {
    return await sendReply(sock, msg, '❌ Failed to send chat: ' + (err?.message || String(err)));
  }
}

module.exports = {
  handleChatCommand,
  sendChatMediaOrText,
  unwrapQuotedMessage,
  downloadMediaToDisk,
};
