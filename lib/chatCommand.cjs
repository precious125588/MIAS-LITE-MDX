'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

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
  const prefix = config.PREFIX || '.';

  const rawTarget = args?.[0] || '';
  const digits = String(rawTarget).replace(/[^0-9]/g, '');

  let quoted = msg?.message?.extendedTextMessage?.contextInfo?.quotedMessage;
  for (let i = 0; i < 5 && quoted; i++) {
    const inner = quoted.viewOnceMessage?.message
      || quoted.viewOnceMessageV2?.message
      || quoted.viewOnceMessageV2Extension?.message
      || quoted.ephemeralMessage?.message
      || quoted.documentWithCaptionMessage?.message;
    if (!inner || inner === quoted) break;
    quoted = inner;
  }

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

  let dcm = deps.downloadContentFromMessage || globalThis.downloadContentFromMessage;
  if (typeof dcm !== 'function') {
    try {
      const b = require('@whiskeysockets/baileys');
      dcm = b.downloadContentFromMessage || (b.default && b.default.downloadContentFromMessage);
    } catch {}
  }

  let tempFilePath = null;

  async function downloadToDisk(mediaMsg, type, ext = 'bin') {
    if (!mediaMsg) return null;
    const rnd = crypto.randomBytes(6).toString('hex');
    const tmp = path.join(os.tmpdir(), `chat_${Date.now()}_${rnd}.${ext}`);
    tempFilePath = tmp;

    if (typeof mediaMsg.download === 'function') {
      try {
        const b = await mediaMsg.download();
        if (b && b.length > 0) {
          fs.writeFileSync(tmp, b);
          return tmp;
        }
      } catch {}
    }
    if (typeof dcm === 'function') {
      try {
        const stream = await dcm(mediaMsg, type);
        const chunks = [];
        for await (const chunk of stream) chunks.push(chunk);
        const b = Buffer.concat(chunks);
        if (b && b.length > 0) {
          fs.writeFileSync(tmp, b);
          return tmp;
        }
      } catch {}
    }
    return null;
  }

  try {
    if (hasMedia) {
      const caption = textArg || imgMsg?.caption || vidMsg?.caption || docMsg?.caption || '';
      if (imgMsg) {
        const tmp = await downloadToDisk(imgMsg, 'image', 'jpg');
        if (!tmp) throw new Error('Could not download image');
        const buf = fs.readFileSync(tmp);
        await sock.sendMessage(targetJid, { image: buf, caption });
      } else if (vidMsg) {
        const tmp = await downloadToDisk(vidMsg, 'video', 'mp4');
        if (!tmp) throw new Error('Could not download video');
        const buf = fs.readFileSync(tmp);
        await sock.sendMessage(targetJid, {
          video: buf,
          caption,
          mimetype: vidMsg.mimetype || 'video/mp4',
          gifPlayback: false
        });
      } else if (audMsg) {
        const tmp = await downloadToDisk(audMsg, 'audio', 'ogg');
        if (!tmp) throw new Error('Could not download audio');
        const buf = fs.readFileSync(tmp);
        await sock.sendMessage(targetJid, {
          audio: buf,
          mimetype: audMsg.mimetype || 'audio/ogg; codecs=opus',
          ptt: !!audMsg.ptt
        });
        if (textArg) {
          await sock.sendMessage(targetJid, { text: textArg });
        }
      } else if (stkMsg) {
        const tmp = await downloadToDisk(stkMsg, 'sticker', 'webp');
        if (!tmp) throw new Error('Could not download sticker');
        const buf = fs.readFileSync(tmp);
        await sock.sendMessage(targetJid, { sticker: buf });
        if (textArg) {
          await sock.sendMessage(targetJid, { text: textArg });
        }
      } else if (docMsg) {
        const fileExt = String(docMsg.fileName || 'file.bin').split('.').pop() || 'bin';
        const tmp = await downloadToDisk(docMsg, 'document', fileExt);
        if (!tmp) throw new Error('Could not download document');
        const buf = fs.readFileSync(tmp);
        await sock.sendMessage(targetJid, {
          document: buf,
          caption,
          mimetype: docMsg.mimetype || 'application/octet-stream',
          fileName: docMsg.fileName || 'file'
        });
      }
    } else {
      await sock.sendMessage(targetJid, { text: messageText });
    }
    return await sendReply(sock, msg, 'chat sent ✅');
  } catch (err) {
    return await sendReply(sock, msg, '❌ Failed to send chat: ' + (err?.message || String(err)));
  } finally {
    if (tempFilePath) {
      try {
        if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
      } catch {}
    }
  }
}

module.exports = {
  handleChatCommand,
};
