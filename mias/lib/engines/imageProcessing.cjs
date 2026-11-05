"use strict";

const Jimp = require("jimp");

function assertBuffer(buffer, name = "image") {
  if (!Buffer.isBuffer(buffer)) throw new TypeError(`${name} must be a Buffer`);
}

async function readImage(buffer) {
  assertBuffer(buffer);
  return Jimp.read(buffer);
}

async function toBuffer(image, mime = Jimp.MIME_PNG, quality) {
  if (quality !== undefined && typeof image.quality === "function") image.quality(quality);
  return image.getBufferAsync(mime);
}

async function resize(buffer, width, height = Jimp.AUTO, options = {}) {
  const image = await readImage(buffer);
  image.resize(Math.max(1, Math.floor(width)), height === Jimp.AUTO ? Jimp.AUTO : Math.max(1, Math.floor(height)), options.mode);
  return toBuffer(image, options.mime || Jimp.MIME_PNG, options.quality);
}

async function crop(buffer, x, y, width, height, options = {}) {
  const image = await readImage(buffer);
  image.crop(Math.max(0, x), Math.max(0, y), Math.max(1, width), Math.max(1, height));
  return toBuffer(image, options.mime || Jimp.MIME_PNG, options.quality);
}

async function overlay(buffer, overlayBuffer, x = 0, y = 0, options = {}) {
  const image = await readImage(buffer);
  const layer = await readImage(overlayBuffer);
  if (options.opacity !== undefined) layer.opacity(Math.max(0, Math.min(1, Number(options.opacity))));
  image.composite(layer, Math.floor(x), Math.floor(y), {
    mode: options.mode || Jimp.BLEND_SOURCE_OVER,
  });
  return toBuffer(image, options.mime || Jimp.MIME_PNG, options.quality);
}

async function blur(buffer, radius = 5, options = {}) {
  const image = await readImage(buffer);
  image.blur(Math.max(1, Math.min(100, Math.floor(radius))));
  return toBuffer(image, options.mime || Jimp.MIME_PNG, options.quality);
}

async function watermark(buffer, watermarkBuffer, options = {}) {
  const image = await readImage(buffer);
  const layer = await readImage(watermarkBuffer);
  const opacity = options.opacity === undefined ? 0.35 : Math.max(0, Math.min(1, Number(options.opacity)));
  layer.opacity(opacity);
  const x = options.x === undefined ? image.bitmap.width - layer.bitmap.width - 16 : options.x;
  const y = options.y === undefined ? image.bitmap.height - layer.bitmap.height - 16 : options.y;
  image.composite(layer, Math.max(0, Math.floor(x)), Math.max(0, Math.floor(y)));
  return toBuffer(image, options.mime || Jimp.MIME_PNG, options.quality);
}

async function optimize(buffer, options = {}) {
  const image = await readImage(buffer);
  const maxWidth = options.maxWidth || 1920;
  const maxHeight = options.maxHeight || 1920;
  const scale = Math.min(1, maxWidth / image.bitmap.width, maxHeight / image.bitmap.height);
  if (scale < 1) image.resize(Math.max(1, Math.floor(image.bitmap.width * scale)), Jimp.AUTO);
  const mime = options.mime || Jimp.MIME_JPEG;
  return toBuffer(image, mime, options.quality === undefined ? 82 : options.quality);
}

async function processImage(buffer, operations = {}) {
  let image = await readImage(buffer);
  if (operations.resize) {
    const { width, height = Jimp.AUTO } = operations.resize;
    image.resize(Math.max(1, Math.floor(width)), height === Jimp.AUTO ? Jimp.AUTO : Math.max(1, Math.floor(height)));
  }
  if (operations.crop) {
    const { x = 0, y = 0, width, height } = operations.crop;
    image.crop(Math.max(0, x), Math.max(0, y), Math.max(1, width), Math.max(1, height));
  }
  if (operations.blur) image.blur(Math.max(1, Math.min(100, Math.floor(operations.blur))));
  if (operations.watermark?.buffer) {
    const layer = await readImage(operations.watermark.buffer);
    layer.opacity(Math.max(0, Math.min(1, Number(operations.watermark.opacity ?? 0.35))));
    image.composite(layer, operations.watermark.x || 0, operations.watermark.y || 0);
  }
  return toBuffer(image, operations.mime || Jimp.MIME_PNG, operations.quality);
}

module.exports = {
  Jimp,
  blur,
  crop,
  imageLibrary: Jimp,
  library: Jimp,
  optimize,
  overlay,
  processImage,
  resize,
  watermark,
};