/**
 * MIAS — Interactive Service
 *
 * Centralized interactive message builder.
 * One shared place for: buttons, lists, carousels, hero cards, polls, external ad replies.
 * Commands never build interactive payloads manually.
 *
 * Architecture: Commands → InteractiveService → InteractiveHandler → GKTW/Baileys → WhatsApp
 */

import {
  sendButtons,
  sendList,
  sendHeroCard,
  sendCarousel,
  sendNativeFlow,
  sendUrlButtons,
  sendInteractive,
  buildExternalAdReply,
  sendPollInteractive,
} from "../handlers/interactiveHandler.js";

// ─── Re-export all interactive builders ───────────────────────────────────────

export {
  sendButtons,
  sendList,
  sendHeroCard,
  sendCarousel,
  sendNativeFlow,
  sendUrlButtons,
  sendInteractive,
  buildExternalAdReply,
  sendPollInteractive,
};

// ─── Semantic aliases ─────────────────────────────────────────────────────────

/**
 * Send a quick-reply button message.
 * Automatically degrades to list → plain text on unsupported clients.
 */
export const sendQuickReply = sendButtons;

/**
 * Send a single-select list message.
 */
export const sendSelectList = sendList;

/**
 * Send a hero card (image/video header + buttons).
 */
export const sendCard = sendHeroCard;

/**
 * Build an external ad reply / link preview contextInfo.
 *
 * @param {object} opts
 * @param {string} [opts.title]
 * @param {string} [opts.body]
 * @param {string} [opts.sourceUrl]
 * @param {Buffer} [opts.thumbnail]
 * @param {number} [opts.mediaType=1]  - 1=image, 2=video
 * @returns {object}  contextInfo object
 */
export { buildExternalAdReply as buildLinkPreview };

/**
 * Build a contextInfo object for enriched messages.
 * @param {object} opts
 * @returns {object}
 */
export function buildContextInfo(opts = {}) {
  return {
    contextInfo: {
      ...buildExternalAdReply(opts),
      mentionedJid: opts.mentions || [],
    },
  };
}

/**
 * Send a poll message.
 */
export { sendPollInteractive as sendPoll };

export default {
  sendButtons,
  sendList,
  sendHeroCard,
  sendCarousel,
  sendNativeFlow,
  sendUrlButtons,
  sendInteractive,
  buildExternalAdReply,
  buildContextInfo,
  sendPollInteractive,
  sendQuickReply,
  sendSelectList,
  sendCard,
};
