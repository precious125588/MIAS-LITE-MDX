'use strict';
/* ── .settoken COMMAND ────────────────────────────────────────────────────────
   Owner-only. Saves the Telegram bot token used by .tgs / .tgsticker / .tgpack.

     .settoken <bot token>   verify with Telegram, save persistently, activate
     .settoken               show which token is active (masked)
     .settoken clear         remove the saved token

   The token is never echoed back. When the command was sent from the owner's
   own account, the message holding the token is deleted from the chat. */

const store = require('./telegramTokenStore.cjs');

const SENDER_KEYS = ['participantPn', 'senderPn', 'participant', 'remoteJid'];

function senderOf(msg) {
  for (const k of SENDER_KEYS) {
    const v = msg?.key?.[k];
    if (v) return String(v);
  }
  return '';
}

/** Default owner check: the owner's own account, the bot's owner registry, or the configured owner number. */
function defaultIsOwner(msg) {
  if (msg?.key?.fromMe) return true;
  const sender = senderOf(msg);
  if (typeof globalThis.__miasIsOwner === 'function' && globalThis.__miasIsOwner(sender)) return true;
  const owner = String(globalThis.ownernumber || '').replace(/\D/g, '');
  const num = sender.split('@')[0].split(':')[0].replace(/\D/g, '');
  return Boolean(owner) && num === owner;
}

async function verifyWithTelegram(axios, token) {
  const res = await axios.get(`https://api.telegram.org/bot${token}/getMe`, {
    timeout: 15000,
    validateStatus: () => true,
  });
  if (res && res.data && res.data.ok && res.data.result) {
    return { valid: true, username: res.data.result.username || null };
  }
  if (res && (res.status === 401 || res.status === 404 || (res.data && res.data.error_code === 401))) {
    return { valid: false };
  }
  // Telegram answered with something unexpected: treat as unverified, not invalid.
  return { valid: null };
}

function createSetTokenHandler({ sendReply, react, axios, isOwner = defaultIsOwner, log = console }) {
  return async function setTokenHandler(sock, msg, args = []) {
    const chat = msg?.key?.remoteJid;
    const reply = (text) => sendReply(sock, msg, text);
    const doReact = async (emoji) => { try { if (react) await react(sock, msg, emoji); } catch (_) {} };

    if (!isOwner(msg)) {
      await reply('🚫 Only the bot owner can set the Telegram token.');
      return;
    }

    const first = String((args || [])[0] || '').trim();
    const sub = first.toLowerCase();

    if (!first || sub === 'status' || sub === 'show') {
      const active = store.activeToken();
      const meta = store.readStoredMeta();
      const lines = ['🔑 *Telegram bot token*'];
      if (active.token) {
        const from = active.source === 'saved' ? 'saved with .settoken (persistent)' : 'from panel environment (may reset on update)';
        lines.push(`Active: ${store.maskToken(active.token)} — ${from}`);
      } else {
        lines.push('Active: none');
      }
      if (meta && meta.savedAt) lines.push(`Saved: ${meta.savedAt}${meta.botUsername ? ` for @${meta.botUsername}` : ''}`);
      lines.push('', 'Set: .settoken <token from @BotFather>', 'Remove: .settoken clear');
      await reply(lines.join('\n'));
      return;
    }

    if (['clear', 'remove', 'reset', 'delete'].includes(sub)) {
      const had = Boolean(store.readStoredToken());
      store.clearStoredToken();
      const after = store.activeToken();
      await reply(
        had
          ? `🗑️ Saved Telegram token removed.\n${after.token ? `The bot now uses the panel token (${store.maskToken(after.token)}).` : 'No Telegram token is active. Set one with .settoken <token>.'}`
          : 'ℹ️ No saved Telegram token to remove.'
      );
      return;
    }

    // Remove the chat message that carries the token, when it was sent by the owner's own account.
    if (msg?.key?.fromMe && chat) {
      try { await sock.sendMessage(chat, { delete: msg.key }); } catch (_) {}
    }

    if (!store.isValidTelegramToken(first)) {
      await reply('❌ That is not a valid bot token.\nIt looks like `123456789:AAH...`. Copy it from @BotFather with /token.');
      await doReact('❌');
      return;
    }

    let check;
    try {
      check = await verifyWithTelegram(axios, first);
    } catch (err) {
      // Network failure: save anyway, the token itself is well-formed.
      log.warn ? log.warn('[settoken] Telegram check unavailable:', err && err.message) : null;
      check = { valid: null };
    }

    if (check.valid === false) {
      await reply('❌ Telegram rejected this token (invalid or revoked).\nCreate or copy a fresh one from @BotFather, then send .settoken again.');
      await doReact('❌');
      return;
    }

    try {
      store.saveStoredToken(first, check.username ? { botUsername: check.username } : {});
    } catch (err) {
      log.error ? log.error('[settoken] could not save token:', err && err.message) : null;
      await reply('❌ Could not save the token on this server. Check that the data folder is writable.');
      await doReact('❌');
      return;
    }

    const who = check.username ? ` for @${check.username}` : '';
    const note = check.valid === null ? '\n⚠️ Telegram could not be reached just now, so the token was saved without a check. Try .tgs to confirm.' : '';
    await reply(
      `✅ Telegram token saved${who} (${store.maskToken(first)}).\n` +
      'It stays in place after restarts and updates. Try: .tgs <sticker pack link>' +
      note
    );
    await doReact('✅');
  };
}

module.exports = { createSetTokenHandler, defaultIsOwner, verifyWithTelegram };
