/**
 * MIAS — Message Handler  v2
 *
 * Centralized abstraction for sending text messages, replies, polls,
 * typing indicators, read receipts, and message edits.
 *
 * Every text-output path in every command must route through here.
 *
 * Architecture:  Commands → Handlers → Baileys Adapter → WhatsApp
 */

import { sendPoll as _sendPoll } from "./gktwAdapter.js";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Maximum WhatsApp message character limit */
const MAX_MSG_LENGTH = 65_536;

/** Chunk size used when splitting long messages */
const CHUNK_SIZE = 4_000;

// ─── Internal helpers ─────────────────────────────────────────────────────────

function _sanitize(text) {
  if (text === null || text === undefined) return "";
  return String(text);
}

function _chunk(text, size = CHUNK_SIZE) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    chunks.push(text.slice(start, start + size));
    start += size;
  }
  return chunks;
}

/**
 * Detect if the second argument is a WAMessage (has .key) rather than a plain JID string.
 * Allows sendReply(sock, msg, text) as a shorthand.
 */
function _isMsgObject(v) {
  return v && typeof v === "object" && v.key && typeof v.key === "object";
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Send a plain text message.
 *
 * @param {object} sock
 * @param {string} jid
 * @param {string} text
 * @param {object} [opts]
 * @param {object}  [opts.quoted]        - WAMessage to quote
 * @param {string[]}[opts.mentions]      - JIDs to mention
 * @param {object}  [opts.contextInfo]   - Extra context info
 * @param {boolean} [opts.linkPreview]   - Enable/disable link preview (default true)
 * @returns {Promise<object|null>}
 */
export async function sendText(sock, jid, text, opts = {}) {
  try {
    const body = _sanitize(text);
    if (!body) return null;

    const content = { text: body };

    if (opts.mentions?.length) content.mentions = opts.mentions;
    if (opts.contextInfo) content.contextInfo = opts.contextInfo;
    if (opts.linkPreview === false) content.linkPreview = false;

    const sendOpts = {};
    if (opts.quoted) sendOpts.quoted = opts.quoted;

    return await sock.sendMessage(jid, content, sendOpts);
  } catch (err) {
    console.error("[sendText] Error:", err?.message);
    return null;
  }
}

/**
 * Send a reply to a specific message.
 *
 * Supports two signatures:
 *   sendReply(sock, jid, text, quotedMsg, opts?)   — explicit JID + quoted
 *   sendReply(sock, msg, text, opts?)              — msg object shorthand (jid auto-extracted)
 *
 * @param {object} sock
 * @param {string|object} jidOrMsg  - Chat JID string, or a WAMessage object
 * @param {string} text
 * @param {object|string} [quotedOrOpts] - WAMessage to quote, or opts when using msg shorthand
 * @param {object} [opts]
 * @returns {Promise<object|null>}
 */
export async function sendReply(sock, jidOrMsg, text, quotedOrOpts, opts = {}) {
  // Shorthand: sendReply(sock, msg, text, opts?)
  if (_isMsgObject(jidOrMsg)) {
    const msg = jidOrMsg;
    const jid = msg.key?.remoteJid;
    const extraOpts = (quotedOrOpts && typeof quotedOrOpts === "object" && !quotedOrOpts.key)
      ? quotedOrOpts
      : {};
    return sendText(sock, jid, text, { ...extraOpts, quoted: msg });
  }

  // Standard: sendReply(sock, jid, text, quotedMsg, opts?)
  return sendText(sock, jidOrMsg, text, { ...opts, quoted: quotedOrOpts });
}

/**
 * Send a raw message content object directly (escape hatch).
 * Use only when higher-level helpers don't cover the needed type.
 *
 * @param {object} sock
 * @param {string} jid
 * @param {object} content  - Raw Baileys message content
 * @param {object} [opts]
 * @returns {Promise<object|null>}
 */
export async function sendRaw(sock, jid, content, opts = {}) {
  try {
    return await sock.sendMessage(jid, content, opts);
  } catch (err) {
    console.error("[sendRaw] Error:", err?.message);
    return null;
  }
}

/**
 * Send a long message, automatically chunking it if it exceeds CHUNK_SIZE.
 *
 * @param {object} sock
 * @param {string} jid
 * @param {string} text
 * @param {object} [opts]
 * @param {object}  [opts.quoted]      - Only applied to the first chunk
 * @param {number}  [opts.chunkSize]   - Override default chunk size
 * @param {number}  [opts.delayMs]     - Delay between chunks (default 300ms)
 * @returns {Promise<void>}
 */
export async function sendLong(sock, jid, text, opts = {}) {
  const body = _sanitize(text);
  const size = opts.chunkSize || CHUNK_SIZE;
  const delay = opts.delayMs ?? 300;

  if (body.length <= size) {
    return sendText(sock, jid, body, opts);
  }

  const chunks = _chunk(body, size);
  for (let i = 0; i < chunks.length; i++) {
    const chunkOpts = i === 0 ? { quoted: opts.quoted } : {};
    await sendText(sock, jid, chunks[i], chunkOpts);
    if (i < chunks.length - 1 && delay > 0) {
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

/**
 * Show a typing indicator, wait, then send the text.
 *
 * @param {object} sock
 * @param {string} jid
 * @param {string} text
 * @param {object} [opts]
 * @param {number}  [opts.typingMs=1000] - Duration to show typing indicator
 * @returns {Promise<object|null>}
 */
export async function sendWithTyping(sock, jid, text, opts = {}) {
  const typingMs = opts.typingMs ?? 1000;
  try {
    if (typeof sock.sendPresenceUpdate === "function") {
      await sock.sendPresenceUpdate("composing", jid);
    }
    await new Promise(r => setTimeout(r, typingMs));
  } catch {}

  try {
    if (typeof sock.sendPresenceUpdate === "function") {
      await sock.sendPresenceUpdate("paused", jid);
    }
  } catch {}

  return sendText(sock, jid, text, opts);
}

/**
 * Edit a previously sent text message in place.
 *
 * @param {object} sock
 * @param {string} jid
 * @param {object} msgKey  - Key of the message to edit (msg.key)
 * @param {string} newText
 * @returns {Promise<object|null>}
 */
export async function editText(sock, jid, msgKey, newText) {
  try {
    return await sock.sendMessage(jid, { text: _sanitize(newText), edit: msgKey });
  } catch (err) {
    console.error("[editText] Error:", err?.message);
    return null;
  }
}

/**
 * Send a message with @mentions.
 *
 * @param {object}   sock
 * @param {string}   jid
 * @param {string}   text
 * @param {string[]} jids    - JIDs to mention
 * @param {object}   [opts]
 * @returns {Promise<object|null>}
 */
export async function sendMention(sock, jid, text, jids = [], opts = {}) {
  return sendText(sock, jid, text, { ...opts, mentions: jids });
}

/**
 * Send a poll message.
 *
 * @param {object}   sock
 * @param {string}   jid
 * @param {string}   question            - Poll question
 * @param {string[]} options             - 2–12 answer choices
 * @param {object}   [opts]
 * @param {number}   [opts.selectableCount=1]  - Max selectable answers
 * @param {object}   [opts.quoted]
 * @returns {Promise<object|null>}
 */
export async function sendPoll(sock, jid, question, options, opts = {}) {
  try {
    return await _sendPoll(sock, jid, question, options, opts);
  } catch (err) {
    // Fallback: plain-text representation
    const lines = options.map((o, i) => `[${i + 1}] ${o}`).join("\n");
    const fallback = `📊 *${question}*\n\n${lines}`;
    return sendText(sock, jid, fallback, { quoted: opts.quoted });
  }
}

/**
 * Mark a message as read.
 *
 * @param {object} sock
 * @param {object} msg - WAMessage to mark read
 * @returns {Promise<void>}
 */
export async function sendRead(sock, msg) {
  try {
    const key = msg?.key;
    if (key && typeof sock.readMessages === "function") {
      await sock.readMessages([key]);
    }
  } catch {}
}

/**
 * Send a typing presence update.
 *
 * @param {object} sock
 * @param {string} jid
 * @param {"composing"|"paused"|"recording"} [state="composing"]
 */
export async function sendTyping(sock, jid, state = "composing") {
  try {
    if (typeof sock.sendPresenceUpdate === "function") {
      await sock.sendPresenceUpdate(state, jid);
    }
  } catch {}
}
