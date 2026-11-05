"use strict";

const path = require("path");
// file-type 22 is ESM-only, so it is loaded with a dynamic import on first use.
let _fileTypePromise = null;
const loadFileType = () => (_fileTypePromise ??= import("file-type"));
async function fromBuffer(buffer) {
  const mod = await loadFileType();
  const detect = mod.fileTypeFromBuffer ?? mod.default?.fromBuffer;
  return detect(buffer);
}
const FileType = { fromBuffer };

const MIME_BY_EXTENSION = new Map([
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
  [".mp4", "video/mp4"],
  [".mkv", "video/x-matroska"],
  [".webm", "video/webm"],
  [".mp3", "audio/mpeg"],
  [".m4a", "audio/mp4"],
  [".ogg", "audio/ogg"],
  [".opus", "audio/opus"],
  [".wav", "audio/wav"],
  [".pdf", "application/pdf"],
  [".zip", "application/zip"],
  [".tar", "application/x-tar"],
  [".gz", "application/gzip"],
  [".7z", "application/x-7z-compressed"],
  [".rar", "application/vnd.rar"],
]);

const CATEGORY_BY_MIME = [
  ["image/", "image"],
  ["video/", "video"],
  ["audio/", "audio"],
  ["application/pdf", "pdf"],
  ["application/zip", "archive"],
  ["application/x-tar", "archive"],
  ["application/gzip", "archive"],
  ["application/x-7z-compressed", "archive"],
  ["application/vnd.rar", "archive"],
];

function categoryForMime(mime = "") {
  if (mime === "image/gif") return "gif";
  if (mime === "application/vnd.whatsapp.sticker") return "sticker";
  return CATEGORY_BY_MIME.find(([prefix]) => mime === prefix || mime.startsWith(prefix))?.[1] || "document";
}

async function detectBuffer(buffer, options = {}) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError("detectBuffer expects a Buffer");
  const maxBytes = options.maxBytes || 200 * 1024 * 1024;
  if (buffer.length > maxBytes) throw new RangeError(`Buffer exceeds ${maxBytes} byte limit`);

  const detected = await FileType.fromBuffer(buffer);
  if (!detected) {
    return {
      ext: null,
      mime: "application/octet-stream",
      category: "document",
      source: "unknown",
      size: buffer.length,
    };
  }
  return {
    ext: detected.ext || null,
    mime: detected.mime || "application/octet-stream",
    category: categoryForMime(detected.mime),
    source: "magic-bytes",
    size: buffer.length,
  };
}

async function detectFile(filePath, options = {}) {
  const fs = require("fs/promises");
  const buffer = await fs.readFile(filePath);
  const result = await detectBuffer(buffer, options);
  return { ...result, path: filePath };
}

function detectExtension(filePath) {
  const ext = path.extname(String(filePath)).toLowerCase();
  const mime = MIME_BY_EXTENSION.get(ext) || "application/octet-stream";
  return {
    ext: ext.replace(/^\./, "") || null,
    mime,
    category: categoryForMime(mime),
    source: "extension",
  };
}

async function detectMedia(input, options = {}) {
  if (Buffer.isBuffer(input) || input instanceof Uint8Array) {
    return detectBuffer(Buffer.from(input), options);
  }
  if (typeof input === "string") return detectFile(input, options);
  throw new TypeError("detectMedia expects a Buffer, Uint8Array, or file path");
}

function isMediaType(info, category) {
  return Boolean(info && info.category === category);
}

module.exports = {
  CATEGORY_BY_MIME,
  MIME_BY_EXTENSION,
  categoryForMime,
  detectBuffer,
  detectExtension,
  detectFile,
  detectMedia,
  fromBuffer,
  isMediaType,
  library: FileType,
};