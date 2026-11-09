'use strict';

/**
 * XYLO-format implementation for `.pin`, `.unpin`, `.pinchat`, and `.unpinchat`.
 * Matches XYLO-MD's exact whatsapp.ts behavior and messages.
 */

function stripDevice(jid) {
  return String(jid || '').replace(/:\d+@/, '@');
}

function userPart(jid) {
  return String(jid || '').split(':')[0].split('@')[0];
}

function digitsOf(jid) {
  return userPart(jid).replace(/\D/g, '');
}

function getContextInfo(msg) {
  const m = msg?.message || msg || {};
  return (
    m.extendedTextMessage?.contextInfo ||
    m.imageMessage?.contextInfo ||
    m.videoMessage?.contextInfo ||
    m.documentMessage?.contextInfo ||
    m.audioMessage?.contextInfo ||
    m.stickerMessage?.contextInfo ||
    m.ephemeralMessage?.message?.extendedTextMessage?.contextInfo ||
    m.ephemeralMessage?.message?.imageMessage?.contextInfo ||
    m.ephemeralMessage?.message?.videoMessage?.contextInfo ||
    m.ephemeralMessage?.message?.documentMessage?.contextInfo ||
    m.viewOnceMessage?.message?.extendedTextMessage?.contextInfo ||
    m.viewOnceMessageV2?.message?.extendedTextMessage?.contextInfo ||
    m.viewOnceMessageV2Extension?.message?.extendedTextMessage?.contextInfo ||
    m.documentWithCaptionMessage?.message?.documentMessage?.contextInfo ||
    null
  );
}

function isOwnerMsg(sock, msg) {
  if (msg?.key?.fromMe) return true;
  const sender = msg?.key?.participantPn || msg?.key?.senderPn || msg?.key?.participant || msg?.key?.remoteJid || '';
  if (typeof globalThis.__miasIsOwner === 'function') {
    try { if (globalThis.__miasIsOwner(sender)) return true; } catch (_) {}
  }
  if (typeof globalThis.__miasIsSudo === 'function') {
    try { if (globalThis.__miasIsSudo(sender)) return true; } catch (_) {}
  }
  const senderDigits = digitsOf(sender);
  const cfgNum = String(process.env.OWNER_NUMBER || globalThis.CONFIG?.OWNER_NUMBER || '').replace(/\D/g, '');
  if (cfgNum && senderDigits && senderDigits === cfgNum) return true;
  const cfgJid = String(process.env.OWNER_JID || globalThis.CONFIG?.OWNER_JID || '');
  if (cfgJid && stripDevice(sender).toLowerCase() === stripDevice(cfgJid).toLowerCase()) return true;
  return false;
}

async function isGroupAdmin(sock, jid, msg) {
  if (isOwnerMsg(sock, msg)) return true;
  const sender = msg?.key?.participantPn || msg?.key?.senderPn || msg?.key?.participant || '';
  if (typeof globalThis.__miasIsGroupAdmin === 'function') {
    try {
      if (await globalThis.__miasIsGroupAdmin(sock, jid, sender)) return true;
    } catch (_) {}
  }
  try {
    const meta = await sock.groupMetadata(jid);
    const participants = meta?.participants || [];
    const p = participants.find((x) => stripDevice(x.id) === stripDevice(sender) || digitsOf(x.id) === digitsOf(sender));
    return p?.admin === 'admin' || p?.admin === 'superadmin';
  } catch (_) {
    return false;
  }
}

async function handlePinCommand(sock, msg, args = [], opts = {}) {
  const isChat = Boolean(opts.chat || opts.isChat);
  const unpin = Boolean(opts.unpin);

  const text = String(msg?.message?.conversation || msg?.message?.extendedTextMessage?.text || '').trim().toLowerCase();
  if (isChat || text.startsWith('.pinchat') || text.startsWith('/pinchat') || text.startsWith('pinchat')) {
    return handlePinChatCommand(sock, msg, args, opts);
  }
  if (text.startsWith('.unpinchat') || text.startsWith('/unpinchat') || text.startsWith('unpinchat')) {
    return handleUnpinChatCommand(sock, msg, args, opts);
  }

  if (unpin) {
    return handleUnpinCommand(sock, msg, args, opts);
  }
  return handleMessagePinCommand(sock, msg, args, opts);
}

async function handleMessagePinCommand(sock, msg, args = [], opts = {}) {
  const from = msg?.key?.remoteJid || '';
  const ctx = getContextInfo(msg);
  if (!ctx?.stanzaId) {
    return sock.sendMessage(from, { text: '✖ Reply to a message to pin it.' }, { quoted: msg });
  }

  const isGroup = from.endsWith('@g.us');
  if (isGroup) {
    const isOwner = isOwnerMsg(sock, msg);
    const isAdmin = isOwner || await isGroupAdmin(sock, from, msg);
    if (!isAdmin && !isOwner) {
      return sock.sendMessage(from, { text: '✖ Admin only.' }, { quoted: msg });
    }
  }

  const myId = stripDevice(sock?.user?.id || sock?.authState?.creds?.me?.id || '');
  const part = ctx.participant ? stripDevice(ctx.participant) : '';
  const fromMe = Boolean(ctx.fromMe || (part && myId && (part === myId || digitsOf(part) === digitsOf(myId))));

  try {
    await sock.sendMessage(from, {
      pin: {
        remoteJid: from,
        fromMe,
        id: ctx.stanzaId,
        participant: ctx.participant || undefined,
      },
      type: 1,
    });
    await sock.sendMessage(from, { text: '✔ Message pinned.' });
    return { ok: true, how: 'sendMessage-pin' };
  } catch (err) {
    await sock.sendMessage(from, { text: '✖ Error pinning message: ' + (err?.message || err) }, { quoted: msg });
    return { ok: false, error: err?.message || err };
  }
}

async function handleUnpinCommand(sock, msg, args = [], opts = {}) {
  const from = msg?.key?.remoteJid || '';
  const ctx = getContextInfo(msg);
  if (!ctx?.stanzaId) {
    return sock.sendMessage(from, { text: '✖ Reply to a pinned message to unpin it.' }, { quoted: msg });
  }

  const isGroup = from.endsWith('@g.us');
  if (isGroup) {
    const isOwner = isOwnerMsg(sock, msg);
    const isAdmin = isOwner || await isGroupAdmin(sock, from, msg);
    if (!isAdmin && !isOwner) {
      return sock.sendMessage(from, { text: '✖ Admin only.' }, { quoted: msg });
    }
  }

  const myId = stripDevice(sock?.user?.id || sock?.authState?.creds?.me?.id || '');
  const part = ctx.participant ? stripDevice(ctx.participant) : '';
  const fromMe = Boolean(ctx.fromMe || (part && myId && (part === myId || digitsOf(part) === digitsOf(myId))));

  try {
    await sock.sendMessage(from, {
      pin: {
        remoteJid: from,
        fromMe,
        id: ctx.stanzaId,
        participant: ctx.participant || undefined,
      },
      type: 2,
    });
    await sock.sendMessage(from, { text: '✔ Message unpinned.' });
    return { ok: true, how: 'sendMessage-unpin' };
  } catch (err) {
    try {
      await sock.sendMessage(from, {
        pin: {
          remoteJid: from,
          fromMe,
          id: ctx.stanzaId,
          participant: ctx.participant || undefined,
        },
        type: 0,
      });
      await sock.sendMessage(from, { text: '✔ Message unpinned.' });
      return { ok: true, how: 'sendMessage-unpin-type0' };
    } catch (err2) {
      await sock.sendMessage(from, { text: '✖ Error unpinning message: ' + (err2?.message || err2) }, { quoted: msg });
      return { ok: false, error: err2?.message || err2 };
    }
  }
}

async function handlePinChatCommand(sock, msg, args = [], opts = {}) {
  const from = msg?.key?.remoteJid || '';
  const isOwner = isOwnerMsg(sock, msg);
  if (!isOwner) {
    return sock.sendMessage(from, { text: '✖ Only owners can pin.' }, { quoted: msg });
  }
  try {
    await sock.chatModify({ pin: true }, from);
    await sock.sendMessage(from, { text: '◆ Chat pinned.' });
    return { ok: true, how: 'chatModify-pin' };
  } catch (err) {
    await sock.sendMessage(from, { text: '✖ Error pinning chat: ' + (err?.message || err) + '\n\n◈ Make sure you have enough pin slots (max 3).' }, { quoted: msg });
    return { ok: false, error: err?.message || err };
  }
}

async function handleUnpinChatCommand(sock, msg, args = [], opts = {}) {
  const from = msg?.key?.remoteJid || '';
  const isOwner = isOwnerMsg(sock, msg);
  if (!isOwner) {
    return sock.sendMessage(from, { text: '✖ Only owners can unpin.' }, { quoted: msg });
  }
  try {
    await sock.chatModify({ pin: false }, from);
    await sock.sendMessage(from, { text: '◆ Chat unpinned.' });
    return { ok: true, how: 'chatModify-unpin' };
  } catch (err) {
    await sock.sendMessage(from, { text: '✖ Error unpinning chat: ' + (err?.message || err) }, { quoted: msg });
    return { ok: false, error: err?.message || err };
  }
}

module.exports = {
  handlePinCommand,
  handleMessagePinCommand,
  handleUnpinCommand,
  handlePinChatCommand,
  handleUnpinChatCommand,
  isOwnerMsg,
  isGroupAdmin,
  getContextInfo,
  // backwards compatibility
  configurePinCommand: () => {},
  parsePinDuration: () => 604800,
  PIN_DURATIONS: { '24h': 86400, '7d': 604800, '30d': 2592000 },
  PIN_LABELS: { 86400: '24 hours', 604800: '7 days', 2592000: '30 days' },
};
