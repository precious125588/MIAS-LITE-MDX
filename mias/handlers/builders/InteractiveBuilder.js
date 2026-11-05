/**
 * MIAS — InteractiveBuilder
 *
 * Fluent builder for rich interactive WhatsApp messages.
 * Combines image/video header + buttons + contextInfo/externalAdReply
 * + footer + header text into ONE single sendMessage() call via the
 * fixed gktwAdapter.sendRichInteractive().
 *
 * This is the correct way to send image+buttons together — NOT two
 * separate sends. Everything goes in ONE proto InteractiveMessage.
 *
 *   Usage:
 *     await new InteractiveBuilder(sock, jid)
 *       .header("JINX BOT")
 *       .body("Commands: 2804\nUptime: 0s")
 *       .footer(".menu to go home")
 *       .image(imageBuf)
 *       .adReply({ title: "JINX", body: "AI Bot", sourceUrl: "https://wa.me", thumbnail: thumbBuf })
 *       .buttons([
 *         { text: "Browse Commands", id: "btn_openmenu" },
 *         { text: "Help", id: "btn_help" },
 *       ])
 *       .quoted(msg)
 *       .send();
 */

export class InteractiveBuilder {
  constructor(sock, jid) {
    this._sock        = sock;
    this._jid         = jid;
    this._header      = "";
    this._body        = "";
    this._footer      = "";
    this._buttons     = [];
    this._sections    = null;   // for list messages
    this._image       = null;   // Buffer | URL
    this._video       = null;   // Buffer | URL
    this._contextInfo = {};
    this._quoted      = null;
    this._type        = "buttons"; // "buttons" | "list"
    this._buttonText  = "Open";    // for list messages
    this._listTitle   = "";        // for list messages
  }

  // ── Content ────────────────────────────────────────────────────────────────

  header(text)        { this._header = String(text || ""); return this; }
  body(text)          { this._body   = String(text || ""); return this; }
  footer(text)        { this._footer = String(text || ""); return this; }
  quoted(msg)         { this._quoted = msg || null;        return this; }

  /**
   * Set the image buffer or URL for the message header.
   * When set, the image is sent INSIDE the interactive message — one call.
   * @param {Buffer|string} src
   */
  image(src)          { this._image = src; return this; }

  /**
   * Set the video buffer or URL for the message header.
   * @param {Buffer|string} src
   */
  video(src)          { this._video = src; return this; }

  /**
   * Set buttons array.
   * Each button: { text, id? } | { text, url } | { text, copyCode } | { text, phone }
   * @param {Array} btns
   */
  buttons(btns)       { this._buttons = Array.isArray(btns) ? btns : []; return this; }

  /**
   * Set list sections (switches to list mode).
   * @param {Array} sections - [{ title, rows: [{ id, title, description? }] }]
   */
  sections(sects)     { this._sections = sects; this._type = "list"; return this; }

  /** Label for the list-open button */
  buttonText(text)    { this._buttonText = String(text || "Open"); return this; }

  /** Title shown in the list header */
  listTitle(text)     { this._listTitle = String(text || ""); return this; }

  /**
   * Attach an externalAdReply (link preview card) to the message.
   * @param {object} opts - { title, body, sourceUrl, thumbnail, mediaType }
   */
  adReply(opts) {
    this._contextInfo = {
      externalAdReply: {
        title:                opts?.title       || "",
        body:                 opts?.body        || "",
        sourceUrl:            opts?.sourceUrl   || "https://whatsapp.com",
        mediaType:            opts?.mediaType   ?? 1,
        thumbnail:            opts?.thumbnail   || null,
        renderLargerThumbnail: opts?.renderLarger !== false,
        showAdAttribution:    false,
      },
    };
    return this;
  }

  /**
   * Attach a raw contextInfo object.
   * @param {object} ctx
   */
  contextInfo(ctx)    { this._contextInfo = ctx || {}; return this; }

  // ── Send ───────────────────────────────────────────────────────────────────

  /**
   * Send the interactive message.
   * Routes through gktwAdapter.sendRichInteractive() which sends everything
   * in ONE sendMessage() call: image header + buttons + contextInfo + footer.
   * Falls back gracefully: GKTW → Baileys proto → plain text.
   *
   * @returns {Promise<object|null>}
   */
  async send() {
    const { sendRichInteractive } = await import("../gktwAdapter.js");
    return sendRichInteractive(this._sock, this._jid, {
      header:      this._header,
      body:        this._body,
      footer:      this._footer,
      buttons:     this._buttons,
      sections:    this._sections,
      buttonText:  this._buttonText,
      listTitle:   this._listTitle,
      image:       this._image,
      video:       this._video,
      contextInfo: this._contextInfo,
      quoted:      this._quoted,
      type:        this._type,
    });
  }
}

/**
 * Factory shorthand.
 * @param {object} sock
 * @param {string} jid
 * @returns {InteractiveBuilder}
 */
export function interactive(sock, jid) {
  return new InteractiveBuilder(sock, jid);
}

export default InteractiveBuilder;
