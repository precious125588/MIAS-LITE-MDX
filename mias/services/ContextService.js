/**
 * MIAS — Context Service
 *
 * Centralized contextInfo / externalAdReply builder.
 * Commands never construct contextInfo or externalAdReply manually.
 *
 * Architecture: Commands → ContextService → InteractiveHandler → WhatsApp
 */

import { buildExternalAdReply } from "../handlers/interactiveHandler.js";
import { prepareContextInfo, prepareExternalAdReply } from "../handlers/mediaHandler.js";

// ─── ExternalAdReply ──────────────────────────────────────────────────────────

/**
 * Build an externalAdReply contextInfo (link preview card).
 *
 * @param {object}  opts
 * @param {string}  [opts.title]
 * @param {string}  [opts.body]
 * @param {string}  [opts.sourceUrl="https://whatsapp.com"]
 * @param {Buffer}  [opts.thumbnail]
 * @param {number|"VIDEO"} [opts.mediaType=1]  - 1=image, 2=video
 * @param {boolean} [opts.renderLarger=true]
 * @returns {object} contextInfo object
 */
export function buildAdReply(opts = {}) {
  return buildExternalAdReply(opts);
}

/**
 * Alias: prepareContextInfo for use in media sends.
 */
export { prepareContextInfo, prepareExternalAdReply };

// ─── Mention contextInfo ──────────────────────────────────────────────────────

/**
 * Build a mention contextInfo.
 * @param {string[]} jids - JIDs to mention
 * @returns {object}
 */
export function buildMentionContext(jids = []) {
  return { contextInfo: { mentionedJid: jids } };
}

// ─── Forward contextInfo ──────────────────────────────────────────────────────

/**
 * Build a contextInfo that marks a message as forwarded.
 * @param {number} [score=100]
 * @returns {object}
 */
export function buildForwardContext(score = 100) {
  return { contextInfo: { isForwarded: true, forwardingScore: score } };
}

// ─── Quote contextInfo ────────────────────────────────────────────────────────

/**
 * Build a contextInfo that quotes a specific message.
 * @param {object} msg - WAMessage to quote
 * @returns {object}
 */
export function buildQuoteContext(msg) {
  if (!msg?.key) return {};
  return {
    contextInfo: {
      stanzaId:     msg.key.id,
      participant:  msg.key.participant || msg.key.remoteJid,
      quotedMessage: msg.message,
    },
  };
}

// ─── Combined builders ────────────────────────────────────────────────────────

/**
 * Build a rich contextInfo combining ad reply + mentions.
 * @param {object} opts
 * @param {object} [opts.adReply]   - externalAdReply options
 * @param {string[]}[opts.mentions] - JIDs to mention
 * @returns {object}
 */
export function buildRichContext(opts = {}) {
  const ctx = {};
  if (opts.adReply) {
    const { externalAdReply } = buildExternalAdReply(opts.adReply);
    ctx.externalAdReply = externalAdReply;
  }
  if (opts.mentions?.length) ctx.mentionedJid = opts.mentions;
  return { contextInfo: ctx };
}

export default {
  buildAdReply,
  buildExternalAdReply,
  prepareContextInfo,
  prepareExternalAdReply,
  buildMentionContext,
  buildForwardContext,
  buildQuoteContext,
  buildRichContext,
};
