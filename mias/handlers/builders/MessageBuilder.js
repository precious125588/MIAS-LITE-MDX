/**
 * MIAS — MIASMessageBuilder (Master Fluent Builder)
 *
 * The top-level builder that combines ALL other builders into a single
 * composable API. Commands use this to build any message type without
 * ever touching Baileys directly.
 *
 * Design contract: everything composes into ONE sendMessage() call.
 *   Image + Buttons + ContextInfo + ExternalAdReply + Footer + Header
 *     → ONE sendMessage() via sendRichInteractive() or MediaBuilder
 *
 *   Usage:
 *     // Rich interactive: image + buttons + adReply in ONE call
 *     await build(sock, jid)
 *       .header("JINX BOT")
 *       .body("Commands: 2804")
 *       .footer(".menu to go home")
 *       .image(imageBuf)
 *       .adReply({ title: "JINX", body: "AI Bot", sourceUrl: "https://wa.me", thumbnail: thumbBuf })
 *       .buttons([{ text: "Browse Commands", id: "btn_openmenu" }])
 *       .quoted(msg)
 *       .send();
 *
 *     // Simple image with caption
 *     await build(sock, jid).image(buf).caption("Hello!").quoted(msg).send();
 *
 *     // Text with adReply card
 *     await build(sock, jid).text("Hi!").adReply({ title: "JINX", body: "Bot" }).quoted(msg).send();
 *
 *     // Category menu
 *     await build(sock, jid).asMenu({ botName, cmdCount, categories, coverImg }).quoted(msg).send();
 */

import { InteractiveBuilder } from "./InteractiveBuilder.js";
import { MediaBuilder }        from "./MediaBuilder.js";
import { MenuBuilder }         from "./MenuBuilder.js";
import { ReactionBuilder }     from "./ReactionBuilder.js";
import { VCardBuilder }        from "./VCardBuilder.js";
import { ThumbnailBuilder }    from "./ThumbnailBuilder.js";

export class MIASMessageBuilder {
  constructor(sock, jid) {
    this._sock        = sock;
    this._jid         = jid;

    // Content state
    this._text        = null;
    this._image       = null;
    this._video       = null;
    this._audio       = null;
    this._sticker     = null;
    this._gif         = null;
    this._document    = null;
    this._buttons     = [];
    this._sections    = null;   // for list

    // Decorators
    this._header      = "";
    this._body        = "";
    this._footer      = "";
    this._caption     = "";
    this._quoted      = null;
    this._mentions    = [];
    this._mimetype    = null;
    this._filename    = null;
    this._viewOnce    = false;
    this._contextInfo = {};
    this._thumbnail   = null;

    // Mode flags
    this._mode        = null;   // "text" | "image" | "video" | "gif" | "audio" | "document" | "sticker" | "interactive" | "menu"
    this._menuOpts    = null;
  }

  // ── Content ────────────────────────────────────────────────────────────────

  text(msg)        { this._text   = msg;  this._mode = this._mode || "text";        return this; }
  image(src)       { this._image  = src;  this._mode = "image";                      return this; }
  video(src)       { this._video  = src;  this._mode = "video";                      return this; }
  audio(src)       { this._audio  = src;  this._mode = "audio";                      return this; }
  sticker(src)     { this._sticker= src;  this._mode = "sticker";                    return this; }
  gif(src)         { this._gif    = src;  this._mode = "gif";                        return this; }
  document(src)    { this._document=src;  this._mode = "document";                   return this; }

  // ── Options ────────────────────────────────────────────────────────────────

  header(t)        { this._header    = String(t  || ""); return this; }
  body(t)          { this._body      = String(t  || ""); return this; }
  footer(t)        { this._footer    = String(t  || ""); return this; }
  caption(t)       { this._caption   = String(t  || ""); return this; }
  quoted(msg)      { this._quoted    = msg || null;       return this; }
  mentions(jids)   { this._mentions  = Array.isArray(jids) ? jids : [jids].filter(Boolean); return this; }
  mimetype(m)      { this._mimetype  = String(m  || ""); return this; }
  filename(n)      { this._filename  = String(n  || ""); return this; }
  viewOnce(b)      { this._viewOnce  = b !== false;      return this; }
  thumbnail(buf)   { this._thumbnail = buf || null;       return this; }

  /**
   * Add buttons (switches mode to interactive if not already image/video).
   * @param {Array} btns - [{ text, id? }|{ text, url }|{ text, copyCode }|{ text, phone }]
   */
  buttons(btns)    {
    this._buttons = Array.isArray(btns) ? btns : [];
    if (!["image", "video"].includes(this._mode)) this._mode = "interactive";
    return this;
  }

  /**
   * Add list sections (switches to list interactive).
   * @param {Array} sects
   */
  sections(sects)  {
    this._sections = sects;
    this._mode = "interactive";
    return this;
  }

  /**
   * Attach an externalAdReply (link preview card).
   * @param {object} opts - { title, body, sourceUrl, thumbnail, mediaType }
   */
  adReply(opts)    {
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
   */
  contextInfo(ctx) { this._contextInfo = ctx || {}; return this; }

  /**
   * Configure as a bot menu. Switches mode to "menu".
   * @param {object} opts - { botName, cmdCount, uptime, prefix, categories, coverImg, ... }
   */
  asMenu(opts)     { this._menuOpts = opts || {}; this._mode = "menu"; return this; }

  // ── Send ───────────────────────────────────────────────────────────────────

  /**
   * Send the message.
   * Automatically routes to the correct handler based on content set.
   * All paths that support it combine image+buttons+contextInfo in ONE call.
   *
   * @returns {Promise<object|null>}
   */
  async send() {
    const mode = this._mode;

    // ── Menu mode ──────────────────────────────────────────────────────────
    if (mode === "menu") {
      const o = this._menuOpts || {};
      const mb = new MenuBuilder(this._sock, this._jid)
        .botName(o.botName   || "JINX")
        .cmdCount(o.cmdCount || 0)
        .uptime(o.uptime     || "0s")
        .prefix(o.prefix     || ".")
        .userName(o.userName || "Guest")
        .version(o.version   || "1.0.0")
        .mode(o.mode         || "Public")
        .quoted(this._quoted);

      if (o.ping      != null) mb.ping(o.ping);
      if (o.footer)            mb.footer(o.footer);
      if (o.sourceUrl)         mb.sourceUrl(o.sourceUrl);
      if (o.categories?.length) mb.categories(o.categories);
      if (o.coverImg)           mb.coverImage(o.coverImg);

      return mb.send();
    }

    // ── Interactive mode (buttons or list) — or image/video WITH buttons ──
    const hasButtons  = this._buttons.length > 0 || this._sections;
    const hasMedia    = this._image || this._video;
    const hasInteract = mode === "interactive" || (hasMedia && hasButtons);

    if (hasInteract) {
      const ib = new InteractiveBuilder(this._sock, this._jid)
        .header(this._header)
        .body(this._body || this._text || this._caption || "")
        .footer(this._footer)
        .quoted(this._quoted)
        .contextInfo(this._contextInfo);

      if (this._image)    ib.image(this._image);
      if (this._video)    ib.video(this._video);
      if (this._buttons.length) ib.buttons(this._buttons);
      if (this._sections) ib.sections(this._sections);

      return ib.send();
    }

    // ── Pure image/video/media modes ────────────────────────────────────────
    if (mode === "image" || mode === "video" || mode === "gif" ||
        mode === "audio" || mode === "sticker" || mode === "document") {
      const mb = new MediaBuilder(this._sock, this._jid);

      if (mode === "image")    mb.image(this._image);
      if (mode === "video")    mb.video(this._video);
      if (mode === "gif")      mb.gif(this._gif);
      if (mode === "audio")    mb.audio(this._audio);
      if (mode === "sticker")  mb.sticker(this._sticker);
      if (mode === "document") mb.document(this._document);

      mb.caption(this._caption || this._text || "")
        .quoted(this._quoted);

      if (this._mimetype)   mb.mimetype(this._mimetype);
      if (this._filename)   mb.filename(this._filename);
      if (this._thumbnail)  mb.thumbnail(this._thumbnail);
      if (this._viewOnce)   mb.viewOnce(true);
      if (this._mentions.length) mb.mentions(this._mentions);
      if (Object.keys(this._contextInfo).length) mb.contextInfo(this._contextInfo);

      return mb.send();
    }

    // ── Plain text ──────────────────────────────────────────────────────────
    try {
      const content  = { text: String(this._text || this._body || this._caption || "") };
      if (this._mentions.length) content.mentions = this._mentions;
      if (Object.keys(this._contextInfo).length) content.contextInfo = this._contextInfo;

      const sendOpts = {};
      if (this._quoted) sendOpts.quoted = this._quoted;

      return await this._sock.sendMessage(this._jid, content, sendOpts);
    } catch (err) {
      console.error("[MIASMessageBuilder.send] Error:", err?.message);
      return null;
    }
  }
}

/**
 * Factory shorthand.
 * @param {object} sock
 * @param {string} jid
 * @returns {MIASMessageBuilder}
 */
export function build(sock, jid) {
  return new MIASMessageBuilder(sock, jid);
}

export default MIASMessageBuilder;
