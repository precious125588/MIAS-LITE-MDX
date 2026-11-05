'use strict';

/**
 * Helper module for WhatsApp message pinning and unpinning using Baileys.
 * Provides quoted context unwrapping, duration parsing, and canonical MessageKey construction.
 */

function unwrapMessage(msg) {
  if (!msg) return null;
  let m = msg.message || msg;
  // Unwrap nested containers (ephemeral, view-once, document-with-caption)
  let depth = 0;
  while (m && depth < 5) {
    if (m.ephemeralMessage?.message) {
      m = m.ephemeralMessage.message;
    } else if (m.viewOnceMessage?.message) {
      m = m.viewOnceMessage.message;
    } else if (m.viewOnceMessageV2?.message) {
      m = m.viewOnceMessageV2.message;
    } else if (m.viewOnceMessageV2Extension?.message) {
      m = m.viewOnceMessageV2Extension.message;
    } else if (m.documentWithCaptionMessage?.message) {
      m = m.documentWithCaptionMessage.message;
    } else {
      break;
    }
    depth++;
  }
  return m;
}

function extractContextInfo(m) {
  if (!m) return null;
  if (m.contextInfo && (m.contextInfo.stanzaId || m.contextInfo.quotedMessage)) {
    return m.contextInfo;
  }
  const knownKeys = [
    'extendedTextMessage',
    'imageMessage',
    'videoMessage',
    'audioMessage',
    'documentMessage',
    'stickerMessage',
    'buttonsResponseMessage',
    'templateButtonReplyMessage',
    'interactiveResponseMessage',
    'pollCreationMessage',
    'pollCreationMessageV2',
    'pollCreationMessageV3',
    'pollUpdateMessage',
    'contactMessage',
    'contactsArrayMessage',
    'locationMessage',
    'liveLocationMessage',
    'ptvMessage'
  ];
  for (const k of knownKeys) {
    if (m[k]?.contextInfo && (m[k].contextInfo.stanzaId || m[k].contextInfo.quotedMessage)) {
      return m[k].contextInfo;
    }
  }
  for (const k of Object.keys(m)) {
    if (k.endsWith('Message') && m[k]?.contextInfo && (m[k].contextInfo.stanzaId || m[k].contextInfo.quotedMessage)) {
      return m[k].contextInfo;
    }
  }
  return null;
}

function extractQuotedContext(msg) {
  const unwrapped = unwrapMessage(msg);
  const ctx = extractContextInfo(unwrapped);
  if (!ctx || !ctx.stanzaId) {
    return null;
  }
  return {
    stanzaId: ctx.stanzaId,
    participant: ctx.participant || null,
    fromMe: Boolean(ctx.fromMe),
    quotedMessage: ctx.quotedMessage || null,
    rawContext: ctx
  };
}

function parsePinDuration(arg) {
  if (arg === null || arg === undefined) return 604800; // default 7 days
  const str = String(arg).toLowerCase().trim();
  if (!str) return 604800;

  // 24 hours / 1 day
  if (['24h', '24hr', '24hrs', '1d', '1day', '86400'].includes(str)) {
    return 86400;
  }
  // 30 days / 1 month
  if (['30d', '30day', '30days', '1m', '1mo', '1month', '2592000'].includes(str)) {
    return 2592000;
  }
  // 7 days / 1 week (default)
  if (['7d', '7day', '7days', '1w', '1wk', '1week', '604800'].includes(str)) {
    return 604800;
  }

  const num = parseInt(str, 10);
  if (num === 86400) return 86400;
  if (num === 2592000) return 2592000;
  if (num === 604800) return 604800;

  return 604800;
}

function getPinDurationLabel(seconds) {
  if (seconds === 86400) return '24 hours';
  if (seconds === 2592000) return '30 days';
  return '7 days';
}

function normalizeJid(raw) {
  if (!raw) return '';
  const str = String(raw).trim();
  const withoutDevice = str.split(':')[0];
  const user = withoutDevice.split('@')[0];
  if (str.includes('@lid')) return `${user}@lid`;
  if (str.includes('@g.us')) return `${user}@g.us`;
  return `${user}@s.whatsapp.net`;
}

function cleanDigits(jid) {
  if (!jid) return '';
  return String(jid).split('@')[0].replace(/\D/g, '');
}

function buildPinKey(sock, jid, ctx, messageCache) {
  if (!ctx || !ctx.stanzaId) {
    throw new Error('Cannot build pin key: missing stanzaId');
  }

  const stanzaId = ctx.stanzaId;
  const isGroup = String(jid).endsWith('@g.us');

  // Check if cached message exists
  let cachedKey = null;
  if (messageCache && typeof messageCache.get === 'function') {
    const cached = messageCache.get(stanzaId);
    if (cached?.key) cachedKey = cached.key;
  }

  // Derive bot identities
  const botJid = sock?.user?.id ? normalizeJid(sock.user.id) : '';
  const botLid = sock?.user?.lid ? normalizeJid(sock.user.lid) : '';
  const botNum = cleanDigits(botJid);

  // Derive participant identity
  const rawParticipant = ctx.participant || cachedKey?.participant || '';
  const participantNorm = rawParticipant ? normalizeJid(rawParticipant) : '';
  const participantNum = cleanDigits(participantNorm);

  // Determine if message was sent from the bot itself
  let fromMe = false;
  if (cachedKey?.fromMe !== undefined) {
    fromMe = Boolean(cachedKey.fromMe);
  } else if (ctx.fromMe === true) {
    fromMe = true;
  } else if (participantNorm) {
    if (botJid && participantNorm === botJid) fromMe = true;
    else if (botLid && participantNorm === botLid) fromMe = true;
    else if (botNum && participantNum && botNum === participantNum) fromMe = true;
  }

  if (isGroup) {
    if (fromMe) {
      return {
        remoteJid: jid,
        id: stanzaId,
        fromMe: true,
        participant: botJid || participantNorm || undefined
      };
    } else {
      return {
        remoteJid: jid,
        id: stanzaId,
        fromMe: false,
        participant: participantNorm || undefined
      };
    }
  } else {
    // 1-on-1 DM: WhatsApp does not use participant in key
    return {
      remoteJid: jid,
      id: stanzaId,
      fromMe: Boolean(fromMe)
    };
  }
}

module.exports = {
  unwrapMessage,
  extractContextInfo,
  extractQuotedContext,
  parsePinDuration,
  getPinDurationLabel,
  normalizeJid,
  cleanDigits,
  buildPinKey
};
