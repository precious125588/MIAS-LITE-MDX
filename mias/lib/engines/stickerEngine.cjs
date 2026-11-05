"use strict";

const { Sticker, StickerTypes, createSticker, extractMetadata } = require("wa-sticker-formatter");

const DEFAULT_METADATA = {
  pack: process.env.STICKER_PACK_NAME || "MIAS",
  author: process.env.STICKER_AUTHOR || "MIAS Bot",
};

async function createStaticSticker(input, options = {}) {
  const sticker = new Sticker(input, {
    ...DEFAULT_METADATA,
    ...options,
    type: options.type || StickerTypes.FULL,
  });
  if (options.quality !== undefined) sticker.setQuality(options.quality);
  return sticker.build();
}

async function createAnimatedSticker(input, options = {}) {
  return createStaticSticker(input, {
    ...options,
    type: options.type || StickerTypes.FULL,
    quality: options.quality === undefined ? 80 : options.quality,
  });
}

async function getStickerMetadata(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError("getStickerMetadata expects a Buffer");
  return extractMetadata(buffer);
}

module.exports = {
  Sticker,
  StickerTypes,
  createAnimatedSticker,
  createStaticSticker,
  createSticker,
  getStickerMetadata,
};