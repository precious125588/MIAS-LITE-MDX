/**
 * MIAS — Utility Handler  v2
 *
 * General-purpose utilities used across handlers.
 * Commands must never call Baileys directly — use these helpers.
 *
 * Architecture:  Commands → Handlers → Baileys Adapter → WhatsApp
 */

import { getContentType as _getContentType, getBaileys } from "./gktwAdapter.js";
import messageContent from "../lib/messageContent.cjs";

const { extractTextFromMessage, getContextInfo } = messageContent;

// ─── JID utilities ────────────────────────────────────────────────────────────

/**
 * Normalize a JID to its canonical form (removes device suffix).
 * @param {string} jid
 * @returns {Promise<string>}
 */
export async function normalizeJid(jid) {
  try {
    const B = await getBaileys();
    if (typeof B.jidNormalizedUser === "function") return B.jidNormalizedUser(jid);
  } catch {}
  const str = String(jid || "");
  const at = str.indexOf("@");
  if (at === -1) return str;
  return `${str.slice(0, at).split(":")[0]}@${str.slice(at + 1)}`;
}

/**
 * Extract the phone number from a JID.
 * @param {string} jid
 * @returns {string}
 */
export function phoneFromJid(jid) {
  return (jid || "").split("@")[0].split(":")[0];
}

/**
 * Convert a phone number string to a user JID.
 * @param {string|number} phone
 * @returns {string}
 */
export function toUserJid(phone) {
  const clean = String(phone).replace(/\D/g, "");
  return `${clean}@s.whatsapp.net`;
}

/**
 * Check if a JID is a group.
 * @param {string} jid
 * @returns {boolean}
 */
export function isGroupJid(jid) {
  return (jid || "").endsWith("@g.us");
}

/**
 * Check if a JID is a broadcast / status.
 * @param {string} jid
 * @returns {boolean}
 */
export function isBroadcastJid(jid) {
  return (jid || "").endsWith("@broadcast") || jid === "status@broadcast";
}

/**
 * Check if a JID is a newsletter / channel.
 * @param {string} jid
 * @returns {boolean}
 */
export function isNewsletterJid(jid) {
  return (jid || "").endsWith("@newsletter");
}

/**
 * Check if a JID is a user (not group/broadcast/newsletter).
 * @param {string} jid
 * @returns {boolean}
 */
export function isUserJid(jid) {
  return (jid || "").endsWith("@s.whatsapp.net");
}

/**
 * Resolve and normalize a JID from any input (phone string or jid string).
 * @param {string} input
 * @returns {string}
 */
export function resolveJid(input) {
  const str = String(input || "").trim();
  if (str.includes("@")) return str;
  const clean = str.replace(/\D/g, "");
  if (clean) return `${clean}@s.whatsapp.net`;
  return str;
}

// ─── Sender resolution ────────────────────────────────────────────────────────

/**
 * Get the effective sender JID of a message.
 * In groups: returns the participant JID (real sender).
 * In DMs: returns the remoteJid.
 *
 * @param {object} msg - WAMessage
 * @returns {string}
 */
export function getEffectiveSender(msg) {
  if (!msg?.key) return "";
  const { remoteJid, participant, fromMe } = msg.key;
  if (isGroupJid(remoteJid)) {
    return participant || msg.participant || remoteJid;
  }
  return remoteJid || "";
}

/**
 * Check whether a message was sent by the bot itself.
 * @param {object} msg - WAMessage
 * @returns {boolean}
 */
export function isBotMessage(msg) {
  return !!msg?.key?.fromMe;
}

// ─── Message content utilities ────────────────────────────────────────────────

/**
 * Get the content type of a message.
 * @param {object} message - message.message object (inner)
 * @returns {Promise<string|null>}
 */
export async function getContentType(message) {
  try {
    return await _getContentType(message);
  } catch {
    return Object.keys(message || {})[0] || null;
  }
}

/**
 * Extract plain text from any message type.
 * Covers conversation, extendedText, image/video caption, button response,
 * list response, interactive response, and poll responses.
 *
 * @param {object} msg - WAMessage object (full)
 * @returns {string}
 */
export function extractText(msg) {
  return extractTextFromMessage(msg);
}

/**
 * Alias for extractText — used by many handlers as "body" of the message.
 * @param {object} msg - WAMessage object (full)
 * @returns {string}
 */
export function extractBody(msg) {
  return extractText(msg);
}

/**
 * Get a message's quoted context (the replied-to message).
 * @param {object} msg - WAMessage object (full)
 * @returns {object|null}
 */
export function getQuoted(msg) {
  const context = getContextInfo(msg);
  const qMsg = context?.quotedMessage || msg?.quoted?.message || msg?.quoted?.msg;
  if (!qMsg) return null;
  return {
    message: qMsg,
    key: {
      id: context?.stanzaId,
      remoteJid: context?.remoteJid || msg.key?.remoteJid,
      participant: context?.participant,
    },
  };
}

/**
 * Extract all mentioned JIDs from a message.
 * @param {object} msg - WAMessage (full)
 * @returns {string[]}
 */
export function getMentions(msg) {
  return getContextInfo(msg)?.mentionedJid || [];
}

/**
 * Extract the command name from a parsed message body (first word, no prefix).
 * @param {string} body    - Raw message text
 * @param {string} prefix  - Bot prefix (e.g. ".")
 * @returns {string}
 */
export function extractCommandName(body, prefix = ".") {
  if (!body?.startsWith(prefix)) return "";
  return body.slice(prefix.length).split(/\s+/)[0].toLowerCase().trim();
}

// ─── Timing & retry utilities ─────────────────────────────────────────────────

/**
 * Sleep for a given number of milliseconds.
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retry an async function up to `retries` times with exponential back-off.
 *
 * @param {Function} fn
 * @param {number}   [retries=3]
 * @param {number}   [baseDelayMs=500]
 * @returns {Promise<any>}
 */
export async function withRetry(fn, retries = 3, baseDelayMs = 500) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < retries) {
        await sleep(baseDelayMs * Math.pow(2, i));
      }
    }
  }
  throw lastErr;
}

// ─── Uptime formatting ────────────────────────────────────────────────────────

/**
 * Format a duration in milliseconds as a human-readable string.
 * e.g. "3d 4h 12m 5s"
 * @param {number} ms
 * @returns {string}
 */
export function formatUptime(ms) {
  const totalSeconds = Math.floor((ms || 0) / 1000);
  const d = Math.floor(totalSeconds / 86400);
  const h = Math.floor((totalSeconds % 86400) / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(" ");
}

/**
 * Format a byte count as a human-readable string.
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (bytes < 1024)             return `${bytes} B`;
  if (bytes < 1024 * 1024)      return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// ─── Presence helpers ─────────────────────────────────────────────────────────

/**
 * Update the bot's typing indicator in a chat.
 * @param {object} sock
 * @param {string} jid
 * @param {"composing"|"paused"|"recording"} [state="composing"]
 */
export async function setPresence(sock, jid, state = "composing") {
  try {
    if (typeof sock.sendPresenceUpdate === "function") {
      await sock.sendPresenceUpdate(state, jid);
    }
  } catch {}
}

/**
 * Show typing presence for the duration of fn(), then pause.
 * @param {object}   sock
 * @param {string}   jid
 * @param {Function} fn   - Async function to run while showing typing
 * @returns {Promise<any>}
 */
export async function withTyping(sock, jid, fn) {
  await setPresence(sock, jid, "composing");
  try {
    return await fn();
  } finally {
    await setPresence(sock, jid, "paused").catch(() => {});
  }
}

// ─── Read-receipt helpers ─────────────────────────────────────────────────────

/**
 * Mark a message as read.
 * @param {object} sock
 * @param {object} msg - WAMessage
 */
export async function markRead(sock, msg) {
  try {
    const key = msg?.key;
    if (key && typeof sock.readMessages === "function") {
      await sock.readMessages([key]);
    }
  } catch {}
}
