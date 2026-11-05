'use strict';
/**
 * Cross-platform Selector Registry
 * ================================
 * Remembers EVERY "choose your bot" prompt that was sent for a number, on any
 * surface (WhatsApp, Telegram, web panel), so that the moment the user chooses
 * on ONE platform every other copy of the selector is deleted.
 *
 * Why this exists
 * ---------------
 * The selector was sent to WhatsApp *and* Telegram (owner + every admin) and
 * re-sent on a 3-minute reminder. Nothing ever removed those copies, so users
 * saw several live selectors, tapped an old one, and got either a duplicate
 * deployment or a "locked" error. Reported as "duplicates shit".
 *
 * Registered prompts survive a restart (nexstore/selector_prompts.json), so a
 * choice made after a redeploy still cleans up the old menus.
 */

const fs   = require('fs');
const path = require('path');
const { jidKey, toJid } = require('./jid');

const STORE_DIR  = path.join(__dirname, '..', 'nexstore');
const STORE_FILE = path.join(STORE_DIR, 'selector_prompts.json');

// key -> live Baileys socket that sent the WhatsApp selector
const _sockets = new Map();

function _read() {
  try {
    if (!fs.existsSync(STORE_FILE)) return {};
    const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch { return {}; }
}

function _write(data) {
  try {
    if (!fs.existsSync(STORE_DIR)) fs.mkdirSync(STORE_DIR, { recursive: true });
    fs.writeFileSync(STORE_FILE, JSON.stringify(data, null, 2));
    return true;
  } catch (e) {
    console.warn(`[SelectorRegistry] write failed: ${e.message}`);
    return false;
  }
}

function _entry(data, key) {
  if (!data[key]) data[key] = { whatsapp: [], telegram: [] };
  if (!Array.isArray(data[key].whatsapp)) data[key].whatsapp = [];
  if (!Array.isArray(data[key].telegram)) data[key].telegram = [];
  return data[key];
}

/** Keep a reference to the socket able to revoke WhatsApp selectors. */
function attachSocket(numberOrJid, sock) {
  const key = jidKey(numberOrJid);
  if (key && sock) _sockets.set(key, sock);
}

function detachSocket(numberOrJid) {
  _sockets.delete(jidKey(numberOrJid));
}

/** Record a WhatsApp selector message so it can be deleted later. */
function registerWhatsApp(numberOrJid, msgKey, sock) {
  const key = jidKey(numberOrJid);
  if (!key || !msgKey?.id) return false;
  if (sock) attachSocket(key, sock);

  const data = _read();
  const e = _entry(data, key);
  if (!e.whatsapp.some(k => k.id === msgKey.id)) {
    e.whatsapp.push({
      id: msgKey.id,
      remoteJid: msgKey.remoteJid || toJid(key),
      fromMe: msgKey.fromMe !== false,
      participant: msgKey.participant || undefined,
      at: Date.now(),
    });
  }
  return _write(data);
}

/** Record a Telegram selector message (chat + message id). */
function registerTelegram(numberOrJid, chatId, messageId) {
  const key = jidKey(numberOrJid);
  if (!key || !chatId || !messageId) return false;

  const data = _read();
  const e = _entry(data, key);
  if (!e.telegram.some(t => String(t.chatId) === String(chatId) && t.messageId === messageId)) {
    e.telegram.push({ chatId: String(chatId), messageId, at: Date.now() });
  }
  return _write(data);
}

function list(numberOrJid) {
  const key = jidKey(numberOrJid);
  const data = _read();
  return data[key] || { whatsapp: [], telegram: [] };
}

function forget(numberOrJid) {
  const key = jidKey(numberOrJid);
  const data = _read();
  if (!data[key]) return false;
  delete data[key];
  return _write(data);
}

/**
 * Delete every selector prompt for a number, on every platform.
 * Never throws — cleanup must never block a deployment.
 *
 * @param {string} numberOrJid
 * @param {object} [opts]
 * @param {object} [opts.sock]      socket to use for WhatsApp revokes
 * @param {object} [opts.telegram]  node-telegram-bot-api client
 * @param {string} [opts.replacement] text to leave behind on Telegram instead
 *                                    of deleting (Telegram cannot delete very
 *                                    old messages)
 */
async function revokeAll(numberOrJid, opts = {}) {
  const key = jidKey(numberOrJid);
  if (!key) return { whatsapp: 0, telegram: 0 };

  const entry = list(key);
  const result = { whatsapp: 0, telegram: 0 };

  // ── WhatsApp ──────────────────────────────────────────────────────────────
  const sock = opts.sock || _sockets.get(key);
  if (sock && entry.whatsapp.length) {
    for (const k of entry.whatsapp) {
      try {
        await sock.sendMessage(k.remoteJid || toJid(key), {
          delete: {
            id: k.id,
            remoteJid: k.remoteJid || toJid(key),
            fromMe: k.fromMe !== false,
            ...(k.participant ? { participant: k.participant } : {}),
          },
        });
        result.whatsapp++;
      } catch { /* message already gone or socket closed */ }
    }
  }

  // ── Telegram ──────────────────────────────────────────────────────────────
  const tg = opts.telegram || global._miasTelegramBot || null;
  if (tg && entry.telegram.length) {
    for (const t of entry.telegram) {
      let deleted = false;
      try {
        await tg.deleteMessage(t.chatId, t.messageId);
        deleted = true;
        result.telegram++;
      } catch { /* too old / already deleted */ }

      if (!deleted && opts.replacement) {
        // Fall back to stripping the buttons so the stale menu is not tappable.
        try {
          await tg.editMessageText(opts.replacement, {
            chat_id: t.chatId,
            message_id: t.messageId,
            parse_mode: 'Markdown',
          });
          result.telegram++;
        } catch {}
        try {
          await tg.editMessageReplyMarkup({ inline_keyboard: [] }, {
            chat_id: t.chatId,
            message_id: t.messageId,
          });
        } catch {}
      }
    }
  }

  forget(key);
  return result;
}

module.exports = {
  STORE_FILE,
  attachSocket,
  detachSocket,
  registerWhatsApp,
  registerTelegram,
  list,
  forget,
  revokeAll,
};
