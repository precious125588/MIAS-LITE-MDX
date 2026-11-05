'use strict';
/**
 * MIAS Bot Selector
 *
 * Sends the WhatsApp bot-selection menu after pairing and makes sure the
 * buttons are actually tappable.
 *
 * FIXED (was broken):
 *   - Native Flow was building ONE `single_select` button PER BOT. WhatsApp's
 *     single_select is a *single* button that carries a `sections`/`rows`
 *     payload.
 *   - The message was relayed without `messageContextInfo`.
 *   - Recipient was a bare phone number, not a JID.
 *   - NEW: every menu we send is registered in deploy/selectorRegistry so it
 *     can be deleted the instant the user picks a bot anywhere. Re-sends now
 *     revoke the previous menu first, so a number never has two live menus.
 *
 * Strategy (most -> least interactive):
 *   1. Native Flow single_select  (one button, radio-style list)
 *   2. Native Flow quick_reply    (one tappable button per bot)
 *   3. Legacy list message        (older clients)
 *   4. Plain numbered text        (always works)
 */

const chalk = require('chalk');
const { toJid } = require('./jid');
const selectorRegistry = require('./selectorRegistry');

// -- Baileys loader ----------------------------------------------------------
let _baileys = null;
async function _getBaileys() {
  if (_baileys) return _baileys;
  try {
    _baileys = await import('@whiskeysockets/baileys');
  } catch (e) {
    console.log(chalk.yellow(`[BotSelector] Baileys import failed: ${e.message}`));
    _baileys = null;
  }
  return _baileys;
}

function _statusBadge(status) {
  switch (status) {
    case 'stable':       return '🟢';
    case 'beta':         return '🟡';
    case 'experimental': return '🔴';
    default:             return '⚪';
  }
}

function _bodyText(bots) {
  return bots
    .map(b => `*${b.name}* ${_statusBadge(b.status)}\n_${b.tagline || ''}_`)
    .join('\n\n');
}

/**
 * Send the bot selection menu.
 *
 * @param {object} sock         Baileys socket
 * @param {string} numberOrJid  Bare number or full JID — normalised here
 * @param {Array}  bots         Bot manifests
 * @returns {Promise<boolean>}  true when at least one strategy delivered
 */
async function sendBotSelectionMenu(sock, numberOrJid, bots) {
  const jid = toJid(numberOrJid);
  if (!jid) {
    console.error(chalk.red(`[BotSelector] Cannot resolve JID from "${numberOrJid}"`));
    return false;
  }
  if (!Array.isArray(bots) || bots.length === 0) {
    console.error(chalk.red('[BotSelector] No bots to offer'));
    return false;
  }

  // Keep the socket available to the registry so a choice made on Telegram can
  // still delete this WhatsApp menu.
  selectorRegistry.attachSocket(jid, sock);

  // Never leave two live menus in the chat: drop any previous one first.
  try { await selectorRegistry.revokeAll(jid, { sock }); } catch {}

  const strategies = [
    ['native-flow single_select', _trySingleSelect],
    ['native-flow quick_reply',   _tryQuickReply],
    ['legacy list',               _tryListMessage],
    ['plain text',                _sendTextFallback],
  ];

  // Wait for the socket to actually be open first, and retry the whole ladder
  // a few times while it reconnects.
  for (let round = 1; round <= 3; round++) {
    if (!(await _waitForOpen(sock))) {
      console.log(chalk.yellow(`[BotSelector] Socket not open (round ${round}/3), waiting…`));
      await _sleep(5000);
      continue;
    }

    let sawClosed = false;
    for (const [label, fn] of strategies) {
      try {
        const sentKey = await fn(sock, jid, bots);
        if (sentKey) {
          if (sentKey !== true) selectorRegistry.registerWhatsApp(jid, sentKey, sock);
          console.log(chalk.green(`[BotSelector] Menu sent via ${label}`));
          return true;
        }
        console.log(chalk.gray(`[BotSelector] ${label} unavailable, trying next`));
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        if (/Connection Closed|Connection Terminated|closed/i.test(msg)) sawClosed = true;
        console.log(chalk.yellow(`[BotSelector] ${label} failed: ${msg}`));
      }
    }

    if (!sawClosed) break;         // real failure, retrying won't help
    console.log(chalk.yellow(`[BotSelector] Connection dropped mid-send, retrying (${round}/3)`));
    await _sleep(5000);
  }

  console.error(chalk.red('[BotSelector] Every strategy failed'));
  return false;
}

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function _isOpen(sock) {
  const rs = sock?.ws?.readyState ?? sock?.ws?.socket?.readyState;
  return rs === 1;
}

async function _waitForOpen(sock, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (_isOpen(sock)) return true;
    await _sleep(500);
  }
  return _isOpen(sock);
}

// -- Strategy 1: Native Flow single_select -----------------------------------
async function _trySingleSelect(sock, jid, bots) {
  const B = await _getBaileys();
  const proto = B?.proto;
  const generateWAMessageFromContent = B?.generateWAMessageFromContent;
  if (!proto?.Message?.InteractiveMessage || !generateWAMessageFromContent) return null;

  const rows = bots.map(bot => ({
    header: '',
    title: `${_statusBadge(bot.status)} ${bot.name}`,
    description: `${bot.tagline || ''}${bot.version ? ` · v${bot.version}` : ''}`.trim(),
    id: `deploy:${bot.id}`,
  }));

  const buttons = [{
    name: 'single_select',
    buttonParamsJson: JSON.stringify({
      title: '🚀 Choose your bot',
      sections: [{ title: '🤖 Available Bots', highlight_label: 'Pick one', rows }],
    }),
  }];

  const interactive = proto.Message.InteractiveMessage.create({
    header: proto.Message.InteractiveMessage.Header.create({
      title: '🤖 MIAS Platform',
      subtitle: 'Bot Deployment',
      hasMediaAttachment: false,
    }),
    body: proto.Message.InteractiveMessage.Body.create({
      text:
        `🎉 *Pairing Successful!*\n\n` +
        `Tap the button below and choose which bot you want to deploy.\n\n` +
        `${_bodyText(bots)}\n\n` +
        `_Your bot starts within 3 seconds of choosing._`,
    }),
    footer: proto.Message.InteractiveMessage.Footer.create({
      text: '⚡ Powered by MIAS Platform',
    }),
    nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({
      buttons,
      messageParamsJson: '',
    }),
  });

  // messageContextInfo is REQUIRED or modern clients drop the whole message.
  const content = {
    viewOnceMessage: {
      message: {
        messageContextInfo: {
          deviceListMetadata: {},
          deviceListMetadataVersion: 2,
        },
        interactiveMessage: interactive,
      },
    },
  };

  const msg = generateWAMessageFromContent(jid, content, { userJid: sock?.user?.id });
  await sock.relayMessage(jid, msg.message, { messageId: msg.key.id });
  return msg.key;
}

// -- Strategy 2: Native Flow quick_reply -------------------------------------
async function _tryQuickReply(sock, jid, bots) {
  const B = await _getBaileys();
  const proto = B?.proto;
  const generateWAMessageFromContent = B?.generateWAMessageFromContent;
  if (!proto?.Message?.InteractiveMessage || !generateWAMessageFromContent) return null;

  // WhatsApp renders at most 3 quick replies reliably.
  const buttons = bots.slice(0, 3).map(bot => ({
    name: 'quick_reply',
    buttonParamsJson: JSON.stringify({
      display_text: `${_statusBadge(bot.status)} ${bot.name}`,
      id: `deploy:${bot.id}`,
    }),
  }));

  const interactive = proto.Message.InteractiveMessage.create({
    body: proto.Message.InteractiveMessage.Body.create({
      text:
        `🎉 *Pairing Successful!*\n\n` +
        `Choose the bot you want to deploy:\n\n${_bodyText(bots)}`,
    }),
    footer: proto.Message.InteractiveMessage.Footer.create({
      text: '⚡ Powered by MIAS Platform',
    }),
    nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({
      buttons,
      messageParamsJson: '',
    }),
  });

  const content = {
    viewOnceMessage: {
      message: {
        messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
        interactiveMessage: interactive,
      },
    },
  };

  const msg = generateWAMessageFromContent(jid, content, { userJid: sock?.user?.id });
  await sock.relayMessage(jid, msg.message, { messageId: msg.key.id });
  return msg.key;
}

// -- Strategy 3: legacy list message -----------------------------------------
async function _tryListMessage(sock, jid, bots) {
  const rows = bots.map(bot => ({
    rowId: `deploy:${bot.id}`,
    title: `${_statusBadge(bot.status)} ${bot.name}`,
    description: bot.tagline || '',
  }));

  const sent = await sock.sendMessage(jid, {
    text: `🎉 *Pairing Successful!*\n\nChoose the bot you want to deploy.`,
    footer: '⚡ Powered by MIAS Platform',
    title: '🤖 MIAS Platform — Bot Selection',
    buttonText: '🚀 Choose Bot',
    sections: [{ title: '🤖 Available Bots', rows }],
  });
  return sent?.key || true;
}

// -- Strategy 4: plain numbered text -----------------------------------------
async function _sendTextFallback(sock, jid, bots) {
  const detail = bots
    .map((b, i) => `*${i + 1}.* ${_statusBadge(b.status)} *${b.name}*\n     _${b.tagline || ''}_`)
    .join('\n\n');

  const sent = await sock.sendMessage(jid, {
    text:
      `🎉 *Pairing Successful!*\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🤖 *Choose Your Bot*\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `${detail}\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `Reply with the *number* (e.g. *1*) or the bot's *name*.\n\n` +
      `_Your bot starts within 3 seconds of choosing._`,
  });
  return sent?.key || true;
}

module.exports = { sendBotSelectionMenu };
