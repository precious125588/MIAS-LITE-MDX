'use strict';

/**
 * Robust implementation for `.pin`, `.unpin`, `.pinchat`, and `.unpinchat`.
 * Supports group message pins, direct chat (DM) pins, custom durations (24h/7d/30d),
 * ACK verification, and automatic app-state sync key recovery for chat pinning.
 */

const fs = require('fs');
const path = require('path');

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

const PIN_DURATIONS = {
  '24h': 86400, '1d': 86400,
  '7d': 604800, '1w': 604800,
  '30d': 2592000, '1m': 2592000,
};
const DEFAULT_PIN_SECONDS = 604800;
const PIN_LABELS = { 86400: '24 hours', 604800: '7 days', 2592000: '30 days' };

function parsePinDuration(arg) {
  const value = String(arg ?? '').trim().toLowerCase();
  if (!value) return DEFAULT_PIN_SECONDS;
  return Object.prototype.hasOwnProperty.call(PIN_DURATIONS, value) ? PIN_DURATIONS[value] : DEFAULT_PIN_SECONDS;
}

/**
 * Track message acks from WhatsApp websocket.
 */
function trackAcks(sock) {
  const ws = sock?.ws;
  if (!ws || typeof ws.on !== 'function' || typeof ws.off !== 'function') return null;
  const event = 'CB:ack,class:message';
  const seen = new Map();
  const waiters = new Map();
  const onAck = (node) => {
    const attrs = node?.attrs || {};
    if (!attrs.id) return;
    const result = attrs.error ? { state: 'rejected', code: String(attrs.error) } : { state: 'accepted' };
    seen.set(attrs.id, result);
    const waiter = waiters.get(attrs.id);
    if (waiter) { waiters.delete(attrs.id); waiter(result); }
  };
  ws.on(event, onAck);
  return {
    wait(id, ms = 2500) {
      if (seen.has(id)) return Promise.resolve(seen.get(id));
      return new Promise((resolve) => {
        const timer = setTimeout(() => { waiters.delete(id); resolve({ state: 'timeout' }); }, ms);
        waiters.set(id, (result) => { clearTimeout(timer); resolve(result); });
      });
    },
    stop() {
      try { ws.off(event, onAck); } catch (_) {}
      seen.clear();
      waiters.clear();
    },
  };
}

/**
 * Builds canonical MessageKey candidates.
 * In DMs, participant is strictly omitted (WhatsApp rejects DM keys with participant).
 * In groups, participant is normalized without device suffix.
 */
function buildPinKeys(sock, jid, ctx) {
  const isGroup = String(jid).endsWith('@g.us');
  const part = ctx.participant ? stripDevice(ctx.participant) : '';
  const myId = stripDevice(sock?.user?.id || sock?.authState?.creds?.me?.id || '');
  const myNum = digitsOf(myId);
  const myLid = userPart(sock?.user?.lid || sock?.authState?.creds?.me?.lid || '');

  const computedFromMe = Boolean(
    ctx.fromMe ||
    (part && myNum && digitsOf(part) === myNum) ||
    (part && myLid && userPart(part) === myLid)
  );

  if (isGroup) {
    return [{
      remoteJid: jid,
      fromMe: computedFromMe,
      id: ctx.stanzaId,
      participant: part || undefined,
    }];
  }

  // 1-on-1 DM: participant must NOT be included in MessageKey
  return [
    { remoteJid: jid, fromMe: computedFromMe, id: ctx.stanzaId },
    { remoteJid: jid, fromMe: !computedFromMe, id: ctx.stanzaId }
  ];
}

async function ensureAppStateSyncKey(sock) {
  if (!sock?.authState) return false;
  const creds = sock.authState.creds;
  const keys = sock.authState.keys;
  if (!creds || !keys) return false;

  let currentKeyId = creds.myAppStateKeyId;
  if (currentKeyId) {
    try {
      const res = await keys.get('app-state-sync-key', [currentKeyId]);
      if (res?.[currentKeyId]) return true;
    } catch (_) {}
  }

  const authDirs = [
    globalThis.AUTH_DIR,
    sock?.authDir,
    sock?.authState?.authDir,
    './auth',
    './session',
    './sessions',
    './prezzy_auth',
    path.join(__dirname, '../auth'),
    path.join(__dirname, '../session'),
    path.join(__dirname, '../prezzy_auth'),
    path.join(__dirname, '../mias/prezzy_auth'),
  ].filter(Boolean);

  let foundKeyId = null;
  let foundKeyData = null;

  for (const dir of authDirs) {
    try {
      if (!fs.existsSync(dir)) continue;
      const files = fs.readdirSync(dir).filter(f => f.startsWith('app-state-sync-key-') && f.endsWith('.json'));
      for (const file of files) {
        const rawId = file.slice('app-state-sync-key-'.length, -5);
        const candidateIds = [
          rawId,
          rawId.replace(/__/g, '/').replace(/-/g, ':'),
        ];
        for (const cid of candidateIds) {
          try {
            const check = await keys.get('app-state-sync-key', [cid]);
            if (check?.[cid]) {
              foundKeyId = cid;
              break;
            }
          } catch (_) {}
        }
        if (foundKeyId) break;

        try {
          const content = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
          if (content) {
            // Check for keyId in JSON content or decoded variants
            foundKeyId = content.keyId || rawId.replace(/__/g, '/').replace(/-/g, ':') || rawId;
            foundKeyData = content;
            break;
          }
        } catch (_) {}
      }
      if (foundKeyId) break;
    } catch (_) {}
  }

  if (foundKeyId) {
    if (foundKeyData && typeof keys.set === 'function') {
      try {
        await keys.set({ 'app-state-sync-key': { [foundKeyId]: foundKeyData } });
      } catch (_) {}
    }
    creds.myAppStateKeyId = foundKeyId;
    if (typeof globalThis.saveCreds === 'function') {
      try { globalThis.saveCreds(); } catch (_) {}
    }
    return true;
  }

  try {
    if (typeof sock.sendPresenceUpdate === 'function') {
      await sock.sendPresenceUpdate('available').catch(() => {});
    }
    if (typeof sock.resyncAppState === 'function') {
      await sock.resyncAppState(['regular_high', 'regular_low', 'regular', 'critical_block', 'critical_unblock_low'], true).catch(() => {});
    }
  } catch (_) {}

  return false;
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

  const duration = args[0] ? parsePinDuration(args[0]) : null;
  const keysToTry = buildPinKeys(sock, from, ctx);
  const tracker = trackAcks(sock);

  let lastError = null;
  for (const key of keysToTry) {
    try {
      const payload = {
        pin: key,
        type: 1,
      };
      if (duration && args.length > 0) {
        payload.time = duration;
      }

      const res = await sock.sendMessage(from, payload);
      const ack = tracker && res?.key?.id ? await tracker.wait(res.key.id, 2500) : { state: 'unknown' };

      if (ack.state === 'rejected') {
        lastError = `WhatsApp rejected it (code ${ack.code})`;
        continue;
      }

      await sock.sendMessage(from, { text: '✔ Message pinned.' });
      tracker?.stop();
      return { ok: true, how: 'sendMessage-pin' };
    } catch (err) {
      lastError = err?.message || err;
    }
  }

  tracker?.stop();
  await sock.sendMessage(from, { text: '✖ Error pinning message: ' + (lastError || 'make sure bot is group admin') }, { quoted: msg });
  return { ok: false, error: lastError };
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

  const keysToTry = buildPinKeys(sock, from, ctx);
  let lastError = null;

  for (const key of keysToTry) {
    try {
      await sock.sendMessage(from, { pin: key, type: 2 });
      await sock.sendMessage(from, { text: '✔ Message unpinned.' });
      return { ok: true, how: 'sendMessage-unpin' };
    } catch (err) {
      try {
        await sock.sendMessage(from, { pin: key, type: 0 });
        await sock.sendMessage(from, { text: '✔ Message unpinned.' });
        return { ok: true, how: 'sendMessage-unpin-type0' };
      } catch (err2) {
        lastError = err2?.message || err2;
      }
    }
  }

  await sock.sendMessage(from, { text: '✖ Error unpinning message: ' + (lastError || 'failed') }, { quoted: msg });
  return { ok: false, error: lastError };
}

async function handlePinChatCommand(sock, msg, args = [], opts = {}) {
  const from = msg?.key?.remoteJid || '';
  const isOwner = isOwnerMsg(sock, msg);
  if (!isOwner) {
    return sock.sendMessage(from, { text: '✖ Only owners can pin.' }, { quoted: msg });
  }

  await ensureAppStateSyncKey(sock).catch(() => {});

  try {
    await sock.chatModify({ pin: true }, from);
    await sock.sendMessage(from, { text: '◆ Chat pinned.' });
    return { ok: true, how: 'chatModify-pin' };
  } catch (err) {
    const errMsg = String(err?.message || err);
    if (/myAppStateKey|app.?state.?key|not.?present|not.?synced/i.test(errMsg)) {
      await ensureAppStateSyncKey(sock).catch(() => {});
      try {
        await sock.chatModify({ pin: true }, from);
        await sock.sendMessage(from, { text: '◆ Chat pinned.' });
        return { ok: true, how: 'chatModify-pin-retry' };
      } catch (retryErr) {
        await sock.sendMessage(from, {
          text: '✖ WhatsApp sync error: App state key is not synced yet. Please wait a moment and try again.'
        }, { quoted: msg });
        return { ok: false, error: retryErr?.message || retryErr };
      }
    }

    if (/pin slot|max|limit|3/i.test(errMsg)) {
      await sock.sendMessage(from, {
        text: '✖ Error pinning chat: Maximum pinned chats reached (max 3). Please unpin a chat first.'
      }, { quoted: msg });
      return { ok: false, error: errMsg };
    }

    await sock.sendMessage(from, {
      text: '✖ Error pinning chat: ' + errMsg + '\n\n◈ Make sure you have enough pin slots (max 3).'
    }, { quoted: msg });
    return { ok: false, error: errMsg };
  }
}

async function handleUnpinChatCommand(sock, msg, args = [], opts = {}) {
  const from = msg?.key?.remoteJid || '';
  const isOwner = isOwnerMsg(sock, msg);
  if (!isOwner) {
    return sock.sendMessage(from, { text: '✖ Only owners can unpin.' }, { quoted: msg });
  }

  await ensureAppStateSyncKey(sock).catch(() => {});

  try {
    await sock.chatModify({ pin: false }, from);
    await sock.sendMessage(from, { text: '◆ Chat unpinned.' });
    return { ok: true, how: 'chatModify-unpin' };
  } catch (err) {
    const errMsg = String(err?.message || err);
    if (/myAppStateKey|app.?state.?key|not.?present|not.?synced/i.test(errMsg)) {
      await ensureAppStateSyncKey(sock).catch(() => {});
      try {
        await sock.chatModify({ pin: false }, from);
        await sock.sendMessage(from, { text: '◆ Chat unpinned.' });
        return { ok: true, how: 'chatModify-unpin-retry' };
      } catch (retryErr) {
        await sock.sendMessage(from, {
          text: '✖ WhatsApp sync error: App state key is not synced yet. Please wait a moment and try again.'
        }, { quoted: msg });
        return { ok: false, error: retryErr?.message || retryErr };
      }
    }
    await sock.sendMessage(from, { text: '✖ Error unpinning chat: ' + errMsg }, { quoted: msg });
    return { ok: false, error: errMsg };
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
  buildPinKeys,
  ensureAppStateSyncKey,
  trackAcks,
  // backwards compatibility
  configurePinCommand: () => {},
  parsePinDuration,
  PIN_DURATIONS,
  PIN_LABELS,
};
