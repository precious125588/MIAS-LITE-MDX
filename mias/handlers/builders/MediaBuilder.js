/**
 * MIAS — MediaBuilder
 *
 * Fluent builder for all media message types.
 * Handles image, video, audio, sticker, gif, voice, document.
 * Auto-generates thumbnails, injects contextInfo/externalAdReply.
 *
 *   Usage:
 *     await new MediaBuilder(sock, jid)
 *       .image(imageBuf)
 *       .caption("Check this out!")
 *       .adReply({ title: "JINX", body: "Bot", sourceUrl: "https://wa.me" })
 *       .quoted(msg)
 *       .send();
 */

export class MediaBuilder {
  constructor(sock, jid) {
    this._sock        = sock;
    this._jid         = jid;
    this._type        = null;    // "image" | "video" | "audio" | "sticker" | "gif" | "voice" | "document"
    this._source      = null;    // Buffer | URL | file path
    this._caption     = "";
    this._mimetype    = null;
    this._filename    = null;
    this._quoted      = null;
    this._contextInfo = null;
    this._viewOnce    = false;
    this._ptt         = false;   // voice note
    this._gifPlayback = false;
    this._thumbnail   = null;
    this._autoThumb   = true;
    this._mentions    = [];
  }

  // ── Source setters ─────────────────────────────────────────────────────────

  /** Set image source (Buffer | URL | path) */
  image(src)      { this._type = "image";    this._source = src; return this; }

  /** Set video source */
  video(src)      { this._type = "video";    this._source = src; return this; }

  /** Set audio source */
  audio(src)      { this._type = "audio";    this._source = src; return this; }

  /** Set voice note source (PTT) */
  voice(src)      { this._type = "voice";    this._source = src; this._ptt = true; return this; }

  /** Set sticker source (WebP) */
  sticker(src)    { this._type = "sticker";  this._source = src; return this; }

  /** Set GIF source (video/mp4 with gifPlayback) */
  gif(src)        { this._type = "gif";      this._source = src; this._gifPlayback = true; return this; }

  /** Set document source */
  document(src)   { this._type = "document"; this._source = src; return this; }

  // ── Options ────────────────────────────────────────────────────────────────

  caption(text)         { this._caption   = String(text || ""); return this; }
  mimetype(mime)        { this._mimetype  = String(mime || ""); return this; }
  filename(name)        { this._filename  = String(name || ""); return this; }
  quoted(msg)           { this._quoted    = msg || null; return this; }
  viewOnce(bool)        { this._viewOnce  = bool !== false; return this; }
  thumbnail(buf)        { this._thumbnail = buf || null; return this; }
  autoThumb(bool)       { this._autoThumb = bool !== false; return this; }
  mentions(jids)        { this._mentions  = Array.isArray(jids) ? jids : [jids].filter(Boolean); return this; }

  /**
   * Attach an externalAdReply contextInfo to the media message.
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
  contextInfo(ctx)  { this._contextInfo = ctx || null; return this; }

  // ── Resolver ───────────────────────────────────────────────────────────────

  async _resolve(src) {
    if (!src) throw new Error("No media source set");
    if (Buffer.isBuffer(src)) return src;
    if (typeof src === "string") {
      if (src.startsWith("http://") || src.startsWith("https://")) {
        const { fetchBuffer } = await import("../uploadHandler.js");
        return fetchBuffer(src);
      }
      const { readFile } = await import("fs/promises");
      return readFile(src);
    }
    throw new Error("Unsupported media source type");
  }

  async _autoGenThumb(buf, isVideo) {
    if (!this._autoThumb || this._thumbnail) return this._thumbnail;
    try {
      const { generateImageThumbnail, generateVideoThumbnail } = await import("../uploadHandler.js");
      if (isVideo) return await generateVideoThumbnail(buf);
      return await generateImageThumbnail(buf, { width: 300, height: 150 });
    } catch {
      return null;
    }
  }

  /**
   * Send the media message.
   * @returns {Promise<object|null>}
   */
  async send() {
    try {
      const buf     = await this._resolve(this._source);
      const sendOpts = {};
      if (this._quoted) sendOpts.quoted = this._quoted;

      const content = {};
      if (this._contextInfo) content.contextInfo = this._contextInfo;
      if (this._mentions.length) content.mentions = this._mentions;

      switch (this._type) {
        case "image": {
          content.image    = buf;
          content.caption  = this._caption;
          content.mimetype = this._mimetype || "image/jpeg";
          if (this._viewOnce) content.viewOnce = true;
          const thumb = await this._autoGenThumb(buf, false);
          if (thumb) content.jpegThumbnail = thumb;
          break;
        }
        case "video": {
          content.video    = buf;
          content.caption  = this._caption;
          content.mimetype = this._mimetype || "video/mp4";
          if (this._gifPlayback) content.gifPlayback = true;
          if (this._viewOnce)    content.viewOnce    = true;
          const thumb = await this._autoGenThumb(buf, true);
          if (thumb) content.jpegThumbnail = thumb;
          break;
        }
        case "gif": {
          content.video       = buf;
          content.caption     = this._caption;
          content.mimetype    = this._mimetype || "video/mp4";
          content.gifPlayback = true;
          break;
        }
        case "audio": {
          content.audio    = buf;
          content.mimetype = this._mimetype || "audio/mpeg";
          break;
        }
        case "voice": {
          content.audio    = buf;
          content.mimetype = this._mimetype || "audio/ogg; codecs=opus";
          content.ptt      = true;
          break;
        }
        case "sticker": {
          content.sticker  = buf;
          content.mimetype = "image/webp";
          break;
        }
        case "document": {
          const guessMime = (name) => {
            const ext = (name || "").split(".").pop()?.toLowerCase();
            const map = { pdf: "application/pdf", zip: "application/zip", mp4: "video/mp4" };
            return map[ext] || "application/octet-stream";
          };
          content.document = buf;
          content.filename = this._filename || "file";
          content.mimetype = this._mimetype || guessMime(this._filename);
          content.caption  = this._caption;
          if (this._thumbnail) content.jpegThumbnail = this._thumbnail;
          break;
        }
        default:
          throw new Error(`Unknown media type: ${this._type}`);
      }

      return await this._sock.sendMessage(this._jid, content, sendOpts);
    } catch (err) {
      console.error("[MediaBuilder.send] Error:", err?.message);
      return null;
    }
  }
}

/**
 * Factory shorthand.
 * @param {object} sock
 * @param {string} jid
 * @returns {MediaBuilder}
 */
export function media(sock, jid) {
  return new MediaBuilder(sock, jid);
}

export default MediaBuilder;
