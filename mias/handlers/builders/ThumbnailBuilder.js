/**
 * MIAS — ThumbnailBuilder
 *
 * Fluent builder for generating JPEG thumbnail buffers from images or videos.
 * Wraps the uploadHandler thumbnail generators with a clean API.
 *
 *   Usage:
 *     const thumb = await new ThumbnailBuilder()
 *       .fromImage(imageBuf)
 *       .size(300, 150)
 *       .quality(80)
 *       .generate();
 *
 *     const vthumb = await new ThumbnailBuilder()
 *       .fromVideo(videoBuf)
 *       .offsetSec(2)
 *       .generate();
 */

export class ThumbnailBuilder {
  constructor() {
    this._source    = null;
    this._kind      = null; // "image" | "video"
    this._width     = 300;
    this._height    = 150;
    this._quality   = 75;
    this._offsetSec = 1;    // for video only
  }

  /**
   * Set an image buffer as the thumbnail source.
   * @param {Buffer} buf
   */
  fromImage(buf) {
    this._source = buf;
    this._kind   = "image";
    return this;
  }

  /**
   * Set a video buffer as the thumbnail source.
   * @param {Buffer} buf
   */
  fromVideo(buf) {
    this._source = buf;
    this._kind   = "video";
    return this;
  }

  /** Output dimensions */
  size(width, height) {
    this._width  = width  || 300;
    this._height = height || 150;
    return this;
  }

  /** JPEG quality (1-100) */
  quality(q) {
    this._quality = q || 75;
    return this;
  }

  /**
   * Time offset in seconds for video frame extraction (default: 1s).
   * @param {number} sec
   */
  offsetSec(sec) {
    this._offsetSec = sec || 1;
    return this;
  }

  /**
   * Generate and return the JPEG thumbnail buffer.
   * Returns null if generation fails.
   * @returns {Promise<Buffer|null>}
   */
  async generate() {
    if (!this._source || !Buffer.isBuffer(this._source)) return null;

    try {
      const { generateImageThumbnail, generateVideoThumbnail } = await import("../uploadHandler.js");

      if (this._kind === "video") {
        return await generateVideoThumbnail(this._source, {
          width:     this._width,
          offsetSec: this._offsetSec,
        });
      }

      return await generateImageThumbnail(this._source, {
        width:   this._width,
        height:  this._height,
        quality: this._quality,
      });
    } catch {
      return null;
    }
  }

  /**
   * Shorthand: generate a square hero-card thumbnail (512×512 at 85% quality).
   * @param {Buffer} imageBuf
   * @returns {Promise<Buffer|null>}
   */
  static async heroCard(imageBuf) {
    return new ThumbnailBuilder().fromImage(imageBuf).size(512, 512).quality(85).generate();
  }

  /**
   * Shorthand: generate a standard preview thumbnail (300×150).
   * @param {Buffer} imageBuf
   * @returns {Promise<Buffer|null>}
   */
  static async preview(imageBuf) {
    return new ThumbnailBuilder().fromImage(imageBuf).size(300, 150).quality(75).generate();
  }
}

/**
 * Factory shorthand.
 * @returns {ThumbnailBuilder}
 */
export function thumbnail() {
  return new ThumbnailBuilder();
}

export default ThumbnailBuilder;
