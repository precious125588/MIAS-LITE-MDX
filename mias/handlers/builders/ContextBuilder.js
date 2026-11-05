/**
 * MIAS — ContextBuilder
 *
 * Fluent builder for WhatsApp contextInfo objects.
 * Combines externalAdReply, mentions, forwarding, and quote context.
 *
 *   Usage:
 *     const ctx = new ContextBuilder()
 *       .adReply({ title: "JINX", body: "Bot ready", sourceUrl: "https://wa.me", thumbnail: buf })
 *       .mentions(["1234@s.whatsapp.net"])
 *       .forwarded(5)
 *       .build();
 *     // → { contextInfo: { externalAdReply: {...}, mentionedJid: [...], ... } }
 */

import { ExternalAdReplyBuilder } from "./ExternalAdReplyBuilder.js";

export class ContextBuilder {
  constructor() {
    this._externalAdReply = null;
    this._mentions        = [];
    this._forwardScore    = null;
    this._stanzaId        = null;
    this._participant     = null;
    this._quotedMessage   = null;
  }

  /**
   * Set externalAdReply via options object or ExternalAdReplyBuilder instance.
   * @param {object|ExternalAdReplyBuilder} opts
   */
  adReply(opts) {
    if (opts instanceof ExternalAdReplyBuilder) {
      this._externalAdReply = opts.buildRaw();
    } else {
      this._externalAdReply = new ExternalAdReplyBuilder()
        .title(opts?.title || "")
        .body(opts?.body || "")
        .sourceUrl(opts?.sourceUrl || "https://whatsapp.com")
        .thumbnail(opts?.thumbnail || null)
        .mediaType(opts?.mediaType || 1)
        .renderLarger(opts?.renderLarger !== false)
        .buildRaw();
    }
    return this;
  }

  /** Add JIDs to mention */
  mentions(jids) {
    this._mentions = Array.isArray(jids) ? jids : [jids].filter(Boolean);
    return this;
  }

  /**
   * Mark message as forwarded.
   * @param {number} [score=100]
   */
  forwarded(score = 100) {
    this._forwardScore = score;
    return this;
  }

  /**
   * Quote a specific message by WAMessage.
   * @param {object} msg - WAMessage
   */
  quote(msg) {
    if (msg?.key) {
      this._stanzaId      = msg.key.id;
      this._participant   = msg.key.participant || msg.key.remoteJid;
      this._quotedMessage = msg.message;
    }
    return this;
  }

  /**
   * Build and return { contextInfo: {...} }.
   * @returns {{ contextInfo: object }}
   */
  build() {
    const ctx = {};

    if (this._externalAdReply) {
      ctx.externalAdReply = this._externalAdReply;
    }
    if (this._mentions.length) {
      ctx.mentionedJid = this._mentions;
    }
    if (this._forwardScore !== null) {
      ctx.isForwarded    = true;
      ctx.forwardingScore = this._forwardScore;
    }
    if (this._stanzaId) {
      ctx.stanzaId      = this._stanzaId;
      ctx.participant   = this._participant;
      ctx.quotedMessage = this._quotedMessage;
    }

    return { contextInfo: ctx };
  }

  /**
   * Build and return just the contextInfo object (not wrapped).
   * @returns {object}
   */
  buildRaw() {
    return this.build().contextInfo;
  }
}

/**
 * Factory shorthand.
 * @returns {ContextBuilder}
 */
export function context() {
  return new ContextBuilder();
}

export default ContextBuilder;
