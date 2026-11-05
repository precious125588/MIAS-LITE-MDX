import { forwardPremiumMenu } from "../lib/premiumMenus.js";
/**
 * MIAS — Menu Handler  v4
 *
 * Main bot menu system. Sends the full menu as ONE rich message:
 *   image header + body text + category buttons + externalAdReply
 *   → single sendMessage() via MenuBuilder → sendRichInteractive()
 *
 * No more separate vCard + text + buttons sends.
 * Falls back gracefully when interactive features are unavailable.
 *
 * Architecture:  Commands → Handlers → Baileys Adapter → WhatsApp
 */

import { sendImage, sendDocument }    from "./mediaHandler.js";
import { sendText }                   from "./messageHandler.js";
import { sendButtons, sendList, sendRichInteractive } from "./interactiveHandler.js";
import { sendBotVCard }               from "./contactHandler.js";
import { getBaileysVersion }          from "./baileysHandler.js";
import { isGktwAvailable }            from "./gktwAdapter.js";
import { formatUptime }               from "./utilityHandler.js";
import {
  MENU_CATEGORIES,
  getCategoryById,
  getTotalCommandCount,
}                                     from "./menuConfig.js";
import { getCapabilities }            from "./capabilityHandler.js";
import { MenuBuilder }                from "./builders/MenuBuilder.js";
import { fetchProfilePic }            from "./contactHandler.js";

// ─── Dynamic resolver (set by index.js via globalThis) ───────────────────────

function _getSock()   { return globalThis.__MIAS_SOCK__ || null; }

// ─── Bot info resolvers ────────────────────────────────────────────────────────

function _getOwner() {
  try {
    if (globalThis.__MIAS_CONFIG__?.OWNER) return globalThis.__MIAS_CONFIG__.OWNER;
    if (globalThis.__GET_SETTING__) { const s = globalThis.__GET_SETTING__("owner"); if (s) return s; }
  } catch {}
  return "MIAS Owner";
}
function _getPrefix() {
  try {
    if (globalThis.__MIAS_CONFIG__?.PREFIX) return globalThis.__MIAS_CONFIG__.PREFIX;
    if (globalThis.__GET_SETTING__) return globalThis.__GET_SETTING__("prefix") || ".";
  } catch {}
  return ".";
}
function _getVersion() {
  try { if (globalThis.__MIAS_CONFIG__?.VERSION) return globalThis.__MIAS_CONFIG__.VERSION; } catch {}
  return "5.3.1";
}
function _getBotName() {
  try {
    if (globalThis.__MIAS_CONFIG__?.BOT_NAME) return globalThis.__MIAS_CONFIG__.BOT_NAME;
    const sock = _getSock();
    if (sock?.user?.name) return sock.user.name;
  } catch {}
  return "MIAS BOT";
}
function _getMode() {
  try { if (globalThis.__GET_SETTING__) return globalThis.__GET_SETTING__("publicMode") ? "Public" : "Private"; } catch {}
  return "Unknown";
}
function _getCmdCount() {
  try {
    if (typeof globalThis.__MIAS_CMD_COUNT__ === "number") return globalThis.__MIAS_CMD_COUNT__;
    if (typeof globalThis.__MIAS_COMMANDS__ === "object" && globalThis.__MIAS_COMMANDS__?.entries) {
      let count = 0;
      for (const [name, cmdObj] of globalThis.__MIAS_COMMANDS__.entries()) {
        if (!cmdObj?.isAlias) count++;
      }
      return count || globalThis.__MIAS_COMMANDS__.size;
    }
  } catch {}
  return getTotalCommandCount();
}

// ─── Menu text builder ────────────────────────────────────────────────────────

function _buildMenuText(opts = {}) {
  const {
    botName, owner, prefix, version, uptime, ping,
    mode, cmdCount, userName,
  } = opts;

  const bar = "─".repeat(32);

  return [
    `*${botName}*`,
    bar,
    `Commands : ${cmdCount}`,
    `Uptime   : ${uptime || "0s"}`,
    ping != null ? `Ping     : ${ping}ms` : null,
    `Mode     : ${mode}`,
    `Version  : ${version}`,
    bar,
    `Select a category below.`,
  ].filter(l => l !== null).join("\n");
}

// ─── WhatsApp native buttons limit = 3 per message ───────────────────────────

function _chunk(arr, size = 3) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Send the full bot menu as ONE rich interactive message.
 *
 * Combines: image header + bot info text + category buttons + externalAdReply card
 * → single sendMessage() via MenuBuilder → sendRichInteractive()
 *
 * Falls back gracefully: rich interactive → list → buttons → plain text.
 *
 * @param {object} sock
 * @param {string} jid
 * @param {object} [msg]            - WAMessage for quoted reply
 * @param {object} [opts]
 * @param {string} [opts.userName]  - Display name shown in the menu header
 * @param {number} [opts.ping]      - Latency in ms
 * @param {Buffer} [opts.coverImage] - Cover image buffer (falls back to bot profile pic)
 * @returns {Promise<void>}
 */
export async function sendMenu(sock, jid, msg, opts = {}) {
  return forwardPremiumMenu(sock, jid, msg || opts.quoted);
}

/**
 * Send the command list for a specific category.
 * Reads category from menuConfig — no hardcoded lists here.
 *
 * @param {object}   sock
 * @param {string}   jid
 * @param {string}   categoryId   - e.g. "cat_ai"
 * @param {object[]} [commands]   - Override list (optional, falls back to menuConfig)
 * @param {object}   [opts]
 * @param {object}   [opts.quoted]
 */
export async function sendCategoryMenu(sock, jid, categoryId, commands, opts = {}) {
  return forwardPremiumMenu(sock, jid, opts.quoted, [categoryId]);
}

/**
 * Send a quick command-count summary.
 *
 * @param {object} sock
 * @param {string} jid
 * @param {object} [opts]
 * @param {object} [opts.quoted]
 */
export async function sendCommandCount(sock, jid, opts = {}) {
  const msg = opts.quoted;
  if (!msg?.key?.id || msg.key.remoteJid !== jid || typeof globalThis.__MIAS_MENU_SNAPSHOT__ !== 'function') throw new Error('Original command-count request is required');
  const categories = await globalThis.__MIAS_MENU_SNAPSHOT__(sock, msg);
  const count = categories.reduce((sum, cat) => sum + cat.cmds.length, 0);
  const prefix = _getPrefix();
  const ver    = _getVersion();
  const text = [
    `*MIAS — Command Statistics*`,
    `${"─".repeat(28)}`,
    `Total commands : ${count}`,
    `Prefix         : ${prefix}`,
    `Version        : ${ver}`,
  ].join("\n");
  return sendText(sock, jid, text, { quoted: opts.quoted });
}
