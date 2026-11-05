/**
 * MIAS — ExternalAdReplyBuilder
 *
 * Fluent builder for externalAdReply contextInfo (link-preview cards).
 * Used to attach rich link-preview cards to any message.
 *
 *   Usage:
 *     const ctx = new ExternalAdReplyBuilder()
 *       .title("JINX Bot")
 *       .body("2804 commands ready")
 *       .sourceUrl("https://wa.me")
 *       .thumbnail(buf)
 *       .mediaType("IMAGE")
 *       .build();
 *     // → { externalAdReply: { ... } }
 */

export class ExternalAdReplyBuilder {
  constructor() {
    this._title        = "";
    this._body         = "";
    this._sourceUrl    = "https://whatsapp.com";
    this._mediaType    = 1;   // 1 = IMAGE, 2 = VIDEO
    this._thumbnail    = null;
    this._renderLarger = true;
    this._showAd       = false;
  }

  /** Card heading */
  title(text)         { this._title = String(text || ""); return this; }

  /** Card sub-heading / description */
  body(text)          { this._body = String(text || ""); return this; }

  /** Source URL for the card */
  sourceUrl(url)      { this._sourceUrl = String(url || "https://whatsapp.com"); return this; }

  /** Thumbnail JPEG buffer */
  thumbnail(buf)      { this._thumbnail = buf || null; return this; }

  /**
   * Media type: 1 or "IMAGE" for image, 2 or "VIDEO" for video.
   */
  mediaType(type)     {
    this._mediaType = (type === "VIDEO" || type === 2) ? 2 : 1;
    return this;
  }

  /** Whether to render the larger thumbnail (default: true) */
  renderLarger(bool)  { this._renderLarger = bool !== false; return this; }

  /** Whether to show ad attribution (default: false) */
  showAd(bool)        { this._showAd = !!bool; return this; }

  /**
   * Build and return the contextInfo object.
   * @returns {{ externalAdReply: object }}
   */
  build() {
    return {
      externalAdReply: {
        title:                this._title,
        body:                 this._body,
        sourceUrl:            this._sourceUrl,
        mediaType:            this._mediaType,
        thumbnail:            this._thumbnail,
        renderLargerThumbnail: this._renderLarger,
        showAdAttribution:    this._showAd,
      },
    };
  }

  /**
   * Build and return just the externalAdReply object (not wrapped in contextInfo).
   * @returns {object}
   */
  buildRaw() {
    return this.build().externalAdReply;
  }
}

/**
 * Factory shorthand.
 * @returns {ExternalAdReplyBuilder}
 */
export function adReply() {
  return new ExternalAdReplyBuilder();
}

export default ExternalAdReplyBuilder;
