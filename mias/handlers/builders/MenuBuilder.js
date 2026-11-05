/**
 * MIAS — MenuBuilder
 *
 * Fluent builder for the bot menu.
 * Combines image + bot info text + interactive category buttons
 * into ONE sendMessage() call (via InteractiveBuilder → sendRichInteractive).
 *
 * This replaces the old approach of sending vCard + text + buttons separately.
 * Now everything — image header, body text, buttons, contextInfo — is one message.
 *
 *   Usage:
 *     await new MenuBuilder(sock, jid)
 *       .botName("JINX")
 *       .cmdCount(2804)
 *       .uptime("5m 30s")
 *       .prefix(".")
 *       .userName("Precious")
 *       .coverImage(imageBuf)
 *       .quoted(msg)
 *       .send();
 */

import { InteractiveBuilder } from "./InteractiveBuilder.js";
import { ThumbnailBuilder }   from "./ThumbnailBuilder.js";

export class MenuBuilder {
  constructor(sock, jid) {
    this._sock      = sock;
    this._jid       = jid;
    this._botName   = "JINX";
    this._cmdCount  = 0;
    this._uptime    = "0s";
    this._prefix    = ".";
    this._userName  = "Guest";
    this._version   = "1.0.0";
    this._mode      = "Public";
    this._ping      = null;
    this._coverImg  = null;  // Buffer for image header
    this._quoted    = null;
    this._categories = [];
    this._footer    = "";
    this._sourceUrl = "https://whatsapp.com";
  }

  botName(name)        { this._botName   = String(name || "JINX");   return this; }
  cmdCount(n)          { this._cmdCount  = Number(n)  || 0;          return this; }
  uptime(str)          { this._uptime    = String(str || "0s");       return this; }
  prefix(p)            { this._prefix    = String(p   || ".");        return this; }
  userName(name)       { this._userName  = String(name || "Guest");   return this; }
  version(v)           { this._version   = String(v   || "1.0.0");   return this; }
  mode(m)              { this._mode      = String(m   || "Public");   return this; }
  ping(ms)             { this._ping      = ms;                         return this; }
  coverImage(buf)      { this._coverImg  = buf || null;               return this; }
  quoted(msg)          { this._quoted    = msg || null;               return this; }
  sourceUrl(url)       { this._sourceUrl = String(url || "https://whatsapp.com"); return this; }

  /**
   * Set menu categories.
   * @param {Array} cats - [{ id, label, cmds: [] }]
   */
  categories(cats)     { this._categories = cats || [];               return this; }

  /**
   * Set custom footer text.
   */
  footer(text)         { this._footer = String(text || "");           return this; }

  /**
   * Build the menu body text.
   */
  _buildBody() {
    const bar  = "─".repeat(32);
    const lines = [
      `*${this._botName}*`,
      bar,
      `Commands : ${this._cmdCount}`,
      `Uptime   : ${this._uptime}`,
      this._ping != null ? `Ping     : ${this._ping}ms` : null,
      `Mode     : ${this._mode}`,
      `Version  : ${this._version}`,
      bar,
      `Choose a category below.`,
    ].filter(l => l !== null);
    return lines.join("\n");
  }

  /**
   * Build category buttons (max 3 per WhatsApp native flow, but we include all).
   */
  _buildButtons() {
    if (!this._categories.length) {
      return [{ text: "Browse Commands", id: "btn_openmenu" }];
    }
    // Map each category to a button — WhatsApp supports up to 10 for native flow
    return this._categories.slice(0, 10).map(c => ({
      text: c.label,
      id:   c.id,
    }));
  }

  /**
   * Send the menu as ONE rich interactive message:
   * image header + bot info + category buttons + adReply card.
   *
   * Falls back gracefully: rich interactive → image+text → plain text.
   * @returns {Promise<void>}
   */
  async send() {
    const body    = this._buildBody();
    const buttons = this._buildButtons();
    const footer  = this._footer || `${this._prefix}help <cmd> for details`;

    // Generate thumbnail for adReply from cover image
    let thumbBuf = null;
    if (this._coverImg && Buffer.isBuffer(this._coverImg)) {
      thumbBuf = await ThumbnailBuilder.preview(this._coverImg).catch(() => null);
    }

    const builder = new InteractiveBuilder(this._sock, this._jid)
      .header(this._botName)
      .body(body)
      .footer(footer)
      .buttons(buttons)
      .quoted(this._quoted)
      .adReply({
        title:     this._botName,
        body:      `Commands: ${this._cmdCount}  •  Uptime: ${this._uptime}`,
        sourceUrl: this._sourceUrl,
        thumbnail: thumbBuf,
        mediaType: 1,
      });

    // Attach cover image to header if available
    if (this._coverImg) {
      builder.image(this._coverImg);
    }

    return builder.send();
  }
}

/**
 * Factory shorthand.
 * @param {object} sock
 * @param {string} jid
 * @returns {MenuBuilder}
 */
export function menu(sock, jid) {
  return new MenuBuilder(sock, jid);
}

export default MenuBuilder;
