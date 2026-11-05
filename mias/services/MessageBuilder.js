/**
 * MIAS — Message Builder
 *
 * Universal message builder. Commands send media without worrying about
 * low-level WhatsApp structures.
 *
 * The builder automatically manages:
 *  ✓ Media uploads & downloads
 *  ✓ Thumbnails
 *  ✓ MIME types
 *  ✓ Quoted messages
 *  ✓ Mentions
 *  ✓ ContextInfo / ExternalAdReply
 *  ✓ Interactive payloads
 *
 * Architecture: Commands → MessageBuilder → MediaService / InteractiveService → WhatsApp
 */

import { sendText, sendReply, sendLong } from "../handlers/messageHandler.js";
import { sendImageMedia, sendVideoMedia, sendAudioMedia, sendVoiceMedia, sendDocumentMedia, sendStickerMedia, sendGifMedia, sendMedia } from "./MediaService.js";
import { sendButtons, sendList, sendHeroCard, buildExternalAdReply } from "./InteractiveService.js";
import { fromImage as thumbFromImage } from "./ThumbnailService.js";
import { buildAdReply, buildRichContext } from "./ContextService.js";

// ─── Builder class ────────────────────────────────────────────────────────────

export class MIASMessageBuilder {
  constructor(sock, jid) {
    this._sock = sock;
    this._jid  = jid;
    this._opts = {};
  }

  /** Set the quoted message (reply-to). */
  quote(msg)          { this._opts.quoted = msg; return this; }

  /** Set message caption (for media). */
  caption(text)       { this._opts.caption = String(text); return this; }

  /** Set mentioned JIDs. */
  mention(jids)       { this._opts.mentions = [].concat(jids); return this; }

  /** Set footer text (for interactive messages). */
  footer(text)        { this._opts.footer = String(text); return this; }

  /** Set message header / title. */
  title(text)         { this._opts.title = String(text); return this; }

  /** Attach an external ad reply (link preview card). */
  adReply(opts)       { this._opts.contextInfo = buildAdReply(opts); return this; }

  /** Attach a rich contextInfo. */
  context(opts)       { this._opts.contextInfo = buildRichContext(opts).contextInfo; return this; }

  /** Set force MIME type. */
  mime(mimetype)      { this._opts.mimetype = mimetype; return this; }

  /** Disable link preview. */
  noPreview()         { this._opts.linkPreview = false; return this; }

  // ── Text sends ─────────────────────────────────────────────────────────────

  /** Send a plain text message. */
  async text(message) {
    return sendText(this._sock, this._jid, message, this._opts);
  }

  /** Send a reply (quoted text). */
  async reply(message) {
    const q = this._opts.quoted;
    if (!q) return sendText(this._sock, this._jid, message, this._opts);
    return sendReply(this._sock, this._jid, message, q, this._opts);
  }

  /** Send a long message (chunked if > 4000 chars). */
  async long(message) {
    return sendLong(this._sock, this._jid, message, this._opts);
  }

  // ── Media sends ────────────────────────────────────────────────────────────

  /** Send an image (auto-optimized + thumbnail). */
  async image(src) {
    return sendImageMedia(this._sock, this._jid, src, this._opts);
  }

  /** Send a video (auto-thumbnail). */
  async video(src) {
    return sendVideoMedia(this._sock, this._jid, src, this._opts);
  }

  /** Send audio. */
  async audio(src) {
    return sendAudioMedia(this._sock, this._jid, src, this._opts);
  }

  /** Send a voice note. */
  async voice(src) {
    return sendVoiceMedia(this._sock, this._jid, src, this._opts);
  }

  /** Send a document. */
  async document(src, filename) {
    return sendDocumentMedia(this._sock, this._jid, src, { ...this._opts, fileName: filename });
  }

  /** Send a sticker. */
  async sticker(src, animated = false) {
    return sendStickerMedia(this._sock, this._jid, src, { ...this._opts, animated });
  }

  /** Send a GIF. */
  async gif(src) {
    return sendGifMedia(this._sock, this._jid, src, this._opts);
  }

  /** Auto-detect and send any media type. */
  async media(src) {
    return sendMedia(this._sock, this._jid, src, this._opts);
  }

  // ── Interactive sends ──────────────────────────────────────────────────────

  /** Send quick-reply buttons. */
  async buttons(body, btns) {
    return sendButtons(this._sock, this._jid, body, btns, this._opts);
  }

  /** Send a single-select list. */
  async list(body, sections) {
    return sendList(this._sock, this._jid, body, sections, this._opts);
  }

  /** Send a hero card with image/title/buttons. */
  async heroCard(imageOrOpts, btns) {
    const cardOpts = typeof imageOrOpts === "object" && !Buffer.isBuffer(imageOrOpts)
      ? imageOrOpts
      : { image: imageOrOpts, title: this._opts.title, body: this._opts.caption };
    return sendHeroCard(this._sock, this._jid, { ...this._opts, ...cardOpts, buttons: btns });
  }
}

// ─── Factory function ─────────────────────────────────────────────────────────

/**
 * Create a fluent MessageBuilder for a given socket + JID.
 *
 * @param {object} sock
 * @param {string} jid
 * @returns {MIASMessageBuilder}
 *
 * @example
 * await build(sock, jid).caption("Hello!").image(buf);
 * await build(sock, jid).quote(msg).text("Done!");
 * await build(sock, jid).title("Menu").buttons("Pick one:", btns);
 */
export function build(sock, jid) {
  return new MIASMessageBuilder(sock, jid);
}

/**
 * Quick send helpers — no builder chain needed.
 */
export const quick = {
  text:     (sock, jid, text, opts)       => sendText(sock, jid, text, opts),
  reply:    (sock, jid, text, msg, opts)  => sendReply(sock, jid, text, msg, opts),
  image:    (sock, jid, src, opts)        => sendImageMedia(sock, jid, src, opts),
  video:    (sock, jid, src, opts)        => sendVideoMedia(sock, jid, src, opts),
  audio:    (sock, jid, src, opts)        => sendAudioMedia(sock, jid, src, opts),
  voice:    (sock, jid, src, opts)        => sendVoiceMedia(sock, jid, src, opts),
  document: (sock, jid, src, opts)        => sendDocumentMedia(sock, jid, src, opts),
  sticker:  (sock, jid, src, opts)        => sendStickerMedia(sock, jid, src, opts),
  media:    (sock, jid, src, opts)        => sendMedia(sock, jid, src, opts),
};

export default { build, quick, MIASMessageBuilder };
