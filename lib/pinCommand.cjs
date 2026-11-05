'use strict';

/**
 * Shared implementation for `.pin` and `.unpin`.
 *
 * One code path serves every registration (mias/index.js and the boot-time
 * precious-fixes-v38 patch), so the behaviour cannot drift between them.
 *
 * Differences from the earlier handlers:
 *  - A message pin is never escalated to a whole-chat pin when WhatsApp rejects
 *    it. A false "pinned" reply for a chat pin was the main "pin does nothing"
 *    report.
 *  - An unknown duration is reported instead of silently defaulting to 7 days.
 *  - WhatsApp's quoted context carries no reliable `fromMe` in direct chats, so
 *    both author candidates are tried, the computed one first.
 */

const { extractQuotedContext } = require('./pin-helper.cjs');
const { createRequire } = require('node:module');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let pinGenerator = null;
function configurePinCommand(baileys = {}) {
  pinGenerator = baileys.generateWAMessageFromContent
    || baileys.default?.generateWAMessageFromContent || null;
}

async function loadPinGenerator() {
  if (typeof pinGenerator === 'function') return pinGenerator;
  const errors = [];
  // Railway installs both workspaces independently; the bot's dependency may
  // exist only under mias/node_modules. Resolve ESM from that same workspace.
  for (const loader of [createRequire(path.join(__dirname, '../mias/package.json')), require]) {
    try {
      const resolved = loader.resolve('@whiskeysockets/baileys');
      let baileys;
      try { baileys = loader('@whiskeysockets/baileys'); }
      catch (_) { baileys = await import(pathToFileURL(resolved).href); }
      const generate = baileys.generateWAMessageFromContent
        || baileys.default?.generateWAMessageFromContent;
      if (typeof generate === 'function') return generate;
      errors.push('installed Baileys has no message generator');
    } catch (error) { errors.push(error?.message || String(error)); }
  }
  throw new Error(`Baileys pin generator could not load: ${errors.join(' | ')}`);
}

const PIN_DURATIONS = {
  '24h': 86400, '1d': 86400,
  '7d': 604800, '1w': 604800,
  '30d': 2592000, '1m': 2592000,
};
const DEFAULT_PIN_SECONDS = 604800;
const PIN_LABELS = { 86400: '24 hours', 604800: '7 days', 2592000: '30 days' };
const PIN_TYPE_PIN = 1;
const PIN_TYPE_UNPIN = 2;

// WhatsApp answers every message with an <ack>. Baileys only logs error acks, and
// sendMessage resolves as soon as the frame is written, so "sent" never proved
// WhatsApp accepted the pin. The bot listens for the ack of its own pin instead.
const ACK_WAIT_MS = 8000;

/**
 * Listens for message acks on the raw socket. Start it before sending, so a
 * fast ack is never missed. Returns null when the socket exposes no ack events.
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
    wait(id, ms = ACK_WAIT_MS) {
      if (seen.has(id)) return Promise.resolve(seen.get(id));
      return new Promise((resolve) => {
        const timer = setTimeout(() => { waiters.delete(id); resolve({ state: 'timeout' }); }, ms);
        waiters.set(id, (result) => { clearTimeout(timer); resolve(result); });
      });
    },
    stop() { ws.off(event, onAck); seen.clear(); waiters.clear(); },
  };
}

/** Returns seconds for a duration argument, the default for an empty one, or null when unknown. */
function parsePinDuration(arg) {
  const value = String(arg ?? '').trim().toLowerCase();
  if (!value) return DEFAULT_PIN_SECONDS;
  return Object.prototype.hasOwnProperty.call(PIN_DURATIONS, value) ? PIN_DURATIONS[value] : null;
}

function stripDevice(jid) {
  return String(jid || '').replace(/:\d+@/, '@');
}

function userPart(jid) {
  return String(jid || '').split(':')[0].split('@')[0];
}

function digitsOf(jid) {
  return userPart(jid).replace(/\D/g, '');
}

/**
 * Keys to try, in order. The computed author comes first; the opposite is a
 * fallback for the direct-chat case where the quoted context does not say who
 * wrote the message.
 */
function buildPinKeys(sock, jid, ctx) {
  const isGroup = String(jid).endsWith('@g.us');
  const participant = ctx.participant ? stripDevice(ctx.participant) : '';
  const myNum = digitsOf(sock?.user?.id);
  const myLid = userPart(sock?.user?.lid);
  const computed = Boolean(
    ctx.fromMe
    || (participant && myNum && digitsOf(participant) === myNum)
    || (participant && myLid && userPart(participant) === myLid)
  );
  const scoped = isGroup && participant ? { participant } : {};
  return [computed, !computed].map((fromMe) => ({
    remoteJid: jid,
    id: ctx.stanzaId,
    fromMe,
    ...scoped,
  }));
}

/**
 * Sends one pin or unpin and waits for WhatsApp's ack of it.
 * Returns { ok, how, ack } where ack is 'accepted', 'timeout' or 'unknown'
 * (no ack channel on this socket), or { ok: false, rejected, code, error }
 * when WhatsApp refuses it. It never falls back to a whole-chat pin.
 */
async function sendPinMessage(sock, jid, key, type, seconds, { ackWaitMs = ACK_WAIT_MS } = {}) {
  if (!key?.id || !key?.remoteJid || key.remoteJid !== jid) {
    return { ok: false, error: 'quoted message key is missing or belongs to another chat' };
  }
  const errors = [];
  const tracker = trackAcks(sock);
  const verdict = async (messageId, how) => {
    const ack = tracker && messageId ? await tracker.wait(messageId, ackWaitMs) : { state: 'unknown' };
    if (ack.state === 'rejected') {
      return { ok: false, rejected: true, code: ack.code, error: `WhatsApp rejected it (error ${ack.code})` };
    }
    return { ok: true, how, ack: ack.state };
  };

  try {
    try {
      const res = await sock.sendMessage(jid, { pin: key, type, time: seconds });
      if (res?.key?.id) return await verdict(res.key.id, 'sendMessage-pin');
      errors.push('no key returned');
    } catch (error) {
      errors.push(`sendMessage: ${error?.message || error}`);
    }

    if (typeof sock.relayMessage !== 'function') {
      errors.push('socket relayMessage unavailable');
    } else {
      const generate = await loadPinGenerator();
      const wam = await generate(jid, {
        pinInChatMessage: { key, type, senderTimestampMs: Date.now() },
        messageContextInfo: { messageAddOnDurationInSecs: type === PIN_TYPE_PIN ? seconds : 0 },
      }, { userJid: stripDevice(sock.user?.id) || undefined });
      if (!wam?.key?.id || !wam?.message?.pinInChatMessage?.key?.id) {
        throw new Error('pin generator returned no message key or pin content');
      }
      await sock.relayMessage(jid, wam.message, { messageId: wam.key.id });
      return await verdict(wam.key.id, 'relay-pinInChatMessage');
    }
  } catch (error) {
    errors.push(`relay: ${error?.message || error}`);
  } finally {
    tracker?.stop();
  }

  return { ok: false, error: errors.join(' | ').slice(0, 300) };
}

/**
 * The bot's role in a group: 'admin', 'member', or 'unknown' when the bot is not
 * found in the member list. Only a positive 'member' blocks a pin up front; an
 * unknown role is left to WhatsApp, which is the authority on who may pin.
 */
function botGroupRole(sock, meta) {
  const botNum = digitsOf(sock?.user?.id);
  const botLid = userPart(sock?.user?.lid);
  const credsLid = userPart(sock?.authState?.creds?.me?.lid);
  const isBot = (value) => {
    const id = userPart(value);
    return Boolean(id) && ((botNum && id === botNum) || (botLid && id === botLid) || (credsLid && id === credsLid));
  };
  const participants = Array.isArray(meta?.participants) ? meta.participants : [];
  const me = participants.find((p) => p && [p.id, p.phoneNumber, p.pn, p.lid].filter(Boolean).some(isBot));
  if (!me) return 'unknown';
  return me.admin === 'admin' || me.admin === 'superadmin' ? 'admin' : 'member';
}

function botIsGroupAdmin(sock, meta) {
  return botGroupRole(sock, meta) === 'admin';
}

/**
 * Handles `.pin` (unpin = false) and `.unpin` (unpin = true).
 * opts: { unpin: boolean, prefix: string }
 */
async function handlePinCommand(sock, msg, args = [], opts = {}) {
  try {
    return await runPinCommand(sock, msg, args, opts);
  } catch (error) {
    const text = error?.message || String(error);
    console.error(`[${opts.unpin ? 'unpin' : 'pin'}] FAILED: unexpected error: ${text}`);
    try {
      await sock.sendMessage(msg?.key?.remoteJid, { text: `❌ ${opts.unpin ? 'Unpin' : 'Pin'} failed: ${text}` }, { quoted: msg });
    } catch (sendError) {
      console.error(`[${opts.unpin ? 'unpin' : 'pin'}] FAILED: could not send the error reply: ${sendError?.message || sendError}`);
    }
    return { ok: false, error: text };
  }
}

async function runPinCommand(sock, msg, args = [], opts = {}) {
  const unpin = Boolean(opts.unpin);
  const prefix = opts.prefix || '.';
  const jid = msg?.key?.remoteJid || '';
  const isGroup = String(jid).endsWith('@g.us');
  const tag = unpin ? 'unpin' : 'pin';
  // The bot silences console.log unless DEBUG_LOGS=1, so every failure goes out through console.error.
  const fail = (text) => console.error(`[${tag}] FAILED: ${text}`);
  const log = (text) => console.log(`[${tag}] ${text}`);
  const say = (text) => Promise.resolve()
    .then(() => sock.sendMessage(jid, { text }, { quoted: msg }))
    .catch((error) => fail(`could not send the reply: ${error?.message || error}`));

  const ctx = extractQuotedContext(msg);
  const requester = String(msg?.key?.participant || msg?.key?.participantPn || jid).split('@')[0].split(':')[0];
  log(`requested by ${requester} in ${isGroup ? 'group' : 'chat'}, quoted message ${ctx ? 'found' : 'missing'}${unpin ? '' : `, duration ${args[0] || 'default 7d'}`}`);
  if (!ctx) {
    if (!unpin) {
      fail('stopped: no quoted message to pin');
      await say(`❌ Reply to the message you want to pin with *${prefix}pin [24h|7d|30d]*`);
      return { ok: false, error: 'no quoted message' };
    }
    try {
      if (typeof sock.chatModify === 'function') {
        await sock.chatModify({ pin: false }, jid);
        log('chat unpinned with chatModify');
        await say('📌 *Chat unpinned!*');
        return { ok: true, how: 'chatModify-unpin-chat' };
      }
    } catch (_) { /* reported below */ }
    await say(`❌ Reply to the pinned message with *${prefix}unpin*`);
    return { ok: false, error: 'no quoted message' };
  }

  let seconds = 0;
  if (!unpin) {
    seconds = parsePinDuration(args[0]);
    if (seconds === null) {
      fail(`stopped: unknown duration "${args[0]}"`);
      await say(`❌ Unknown duration *${args[0]}*. Use *24h*, *7d* or *30d*.`);
      return { ok: false, error: 'unknown duration' };
    }
  }

  if (isGroup) {
    let meta = null;
    try { meta = await sock.groupMetadata(jid); } catch (_) { /* fall through */ }
    if (meta && botGroupRole(sock, meta) === 'member') {
      const text = unpin
        ? '❌ Bot must be a group admin to unpin messages in this group!'
        : '❌ Bot must be a group admin to pin messages in this group!';
      fail('stopped: bot is not a group admin (WhatsApp role check)');
      await say(text);
      return { ok: false, error: 'bot is not admin' };
    }
  }

  let lastError = '';
  for (const key of buildPinKeys(sock, jid, ctx)) {
    const result = await sendPinMessage(sock, jid, key, unpin ? PIN_TYPE_UNPIN : PIN_TYPE_PIN, unpin ? 0 : seconds, { ackWaitMs: opts.ackWaitMs });
    const attempt = `attempt ${key.fromMe ? 'as own message' : 'as other author'}`;
    if (result.ok) log(`${attempt}: sent via ${result.how}, WhatsApp ack ${result.ack}`);
    else fail(`${attempt}: ${result.error}`);
    if (result.ok) {
      const confirmed = result.ack === 'accepted';
      const label = PIN_LABELS[seconds] || '7 days';
      if (unpin) {
        if (confirmed) {
          try { await sock.sendMessage(jid, { react: { text: '📌', key: msg.key } }); } catch (_) { /* cosmetic */ }
          await say('📌 *WhatsApp accepted the unpin.* Open the chat to confirm it is gone.');
        } else {
          fail('WhatsApp did not acknowledge the unpin within 8 seconds');
          await say('⚠️ *Unpin sent, but WhatsApp did not acknowledge it within 8 seconds.* Open the chat to check it.');
        }
      } else if (confirmed) {
        await say(`📌 *WhatsApp accepted the pin* (${label}). Open the chat to confirm it shows.`);
      } else {
        fail('WhatsApp did not acknowledge the pin within 8 seconds');
        await say('⚠️ *Pin sent, but WhatsApp did not acknowledge it within 8 seconds.* Open the chat to check it. If it is not pinned, make sure the bot is a group admin.');
      }
      log(`${tag} ${confirmed ? 'acknowledged by WhatsApp' : 'sent, not acknowledged within 8s'}`);
      return { ok: true, how: result.how, ack: result.ack };
    }
    lastError = result.error;
  }

  fail(lastError || 'unknown error');
  await say(unpin
    ? `❌ Unpin failed: ${lastError || 'unknown error'} (bot needs admin rights in groups)`
    : `❌ Failed to pin message: ${lastError || 'make sure bot is group admin'}`);
  return { ok: false, error: lastError };
}

module.exports = {
  configurePinCommand,
  PIN_DURATIONS,
  PIN_LABELS,
  parsePinDuration,
  buildPinKeys,
  sendPinMessage,
  trackAcks,
  ACK_WAIT_MS,
  botGroupRole,
  botIsGroupAdmin,
  handlePinCommand,
};
