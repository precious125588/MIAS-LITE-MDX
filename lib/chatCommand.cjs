'use strict';

/**
 * Handler for .chat command:
 * .chat <number> <message>
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
  const quoted = msg?.message?.extendedTextMessage?.contextInfo?.quotedMessage;
  const quotedText = quoted?.conversation || quoted?.extendedTextMessage?.text || '';
  const messageText = (args?.slice(1)?.join(' ')?.trim()) || quotedText.trim();

  if (!digits || digits.length < 5 || !messageText) {
    return await sendReply(sock, msg, 'Usage: ' + prefix + 'chat 2349068551055 hello');
  }

  const targetJid = digits + '@s.whatsapp.net';
  try {
    await sock.sendMessage(targetJid, { text: messageText });
    return await sendReply(sock, msg, 'chat sent ✅');
  } catch (err) {
    return await sendReply(sock, msg, '❌ Failed to send chat: ' + (err?.message || String(err)));
  }
}

module.exports = {
  handleChatCommand,
};
