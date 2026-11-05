/**
 * MIAS — MIME Service
 *
 * Centralized MIME type detection and extension resolution.
 * Wraps file-type (binary detection) and mime-types (extension lookup).
 *
 * Architecture: Commands → MimeService → FileDetection + UtilityEngine → packages
 */

import engineRegistryModule from "../lib/engineRegistry.cjs";

const _fileEngine    = engineRegistryModule.getEngineRegistry().get("fileDetection");
const _utilityEngine = engineRegistryModule.getEngineRegistry().get("utility");

// ─── Static MIME map (fast lookup without package) ────────────────────────────

const STATIC_MAP = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
  gif: "image/gif", svg: "image/svg+xml", ico: "image/x-icon", bmp: "image/bmp",
  mp4: "video/mp4", mkv: "video/x-matroska", mov: "video/quicktime",
  avi: "video/x-msvideo", flv: "video/x-flv", wmv: "video/x-ms-wmv",
  mp3: "audio/mpeg", ogg: "audio/ogg", m4a: "audio/mp4", aac: "audio/aac",
  opus: "audio/ogg; codecs=opus", wav: "audio/wav", flac: "audio/flac",
  pdf: "application/pdf", zip: "application/zip", rar: "application/x-rar-compressed",
  "7z": "application/x-7z-compressed", tar: "application/x-tar",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  txt: "text/plain", json: "application/json", xml: "application/xml",
  html: "text/html", css: "text/css", js: "application/javascript",
  apk: "application/vnd.android.package-archive",
  ipa: "application/octet-stream",
};

const CATEGORY_MAP = {
  "image/": "image", "video/": "video", "audio/": "audio",
  "application/pdf": "document", "application/msword": "document",
  "application/vnd.openxmlformats": "document",
  "application/vnd.ms-": "document",
};

// ─── Core API ─────────────────────────────────────────────────────────────────

/**
 * Detect MIME type from a Buffer (binary detection).
 * @param {Buffer} buffer
 * @returns {Promise<{mime: string, ext: string, category: string}>}
 */
export async function detectBuffer(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError("detectBuffer expects a Buffer");
  if (_fileEngine?.detectBuffer) return _fileEngine.detectBuffer(buffer);
  // Signature-based fallback
  const sig = buffer.slice(0, 12);
  if (sig[0] === 0xFF && sig[1] === 0xD8) return { mime: "image/jpeg", ext: "jpg", category: "image" };
  if (sig.slice(0, 8).toString("hex") === "89504e470d0a1a0a") return { mime: "image/png", ext: "png", category: "image" };
  if (sig.slice(0, 4).toString() === "RIFF") return { mime: "video/avi", ext: "avi", category: "video" };
  if (sig.slice(0, 4).toString() === "%PDF") return { mime: "application/pdf", ext: "pdf", category: "document" };
  return { mime: "application/octet-stream", ext: "bin", category: "unknown" };
}

/**
 * Get MIME type from a file extension.
 * @param {string} ext  - "jpg", ".jpg", "image/jpeg"
 * @returns {string}
 */
export function fromExtension(ext) {
  const clean = String(ext || "").replace(/^\./, "").toLowerCase();
  if (_utilityEngine?.lookup) return _utilityEngine.lookup(clean) || STATIC_MAP[clean] || "application/octet-stream";
  return STATIC_MAP[clean] || "application/octet-stream";
}

/**
 * Get the file extension for a MIME type.
 * @param {string} mimeType
 * @returns {string|null}
 */
export function toExtension(mimeType) {
  if (_utilityEngine?.extension) return _utilityEngine.extension(mimeType);
  const found = Object.entries(STATIC_MAP).find(([, v]) => v === mimeType);
  return found ? found[0] : null;
}

/**
 * Guess MIME from a filename.
 * @param {string} filename
 * @param {string} [fallback="application/octet-stream"]
 * @returns {string}
 */
export function fromFilename(filename, fallback = "application/octet-stream") {
  const ext = String(filename || "").split(".").pop()?.toLowerCase() || "";
  return fromExtension(ext) || fallback;
}

/**
 * Get the media category from a MIME type.
 * @param {string} mime
 * @returns {"image"|"video"|"audio"|"document"|"sticker"|"unknown"}
 */
export function getCategory(mime) {
  const m = String(mime || "");
  if (m === "image/webp") return "sticker";
  for (const [prefix, cat] of Object.entries(CATEGORY_MAP)) {
    if (m.startsWith(prefix)) return cat;
  }
  return "unknown";
}

/**
 * Check if a MIME type is an image.
 */
export function isImage(mime) { return String(mime).startsWith("image/"); }
export function isVideo(mime) { return String(mime).startsWith("video/"); }
export function isAudio(mime) { return String(mime).startsWith("audio/"); }
export function isDocument(mime) {
  const m = String(mime);
  return m.startsWith("application/") || m.startsWith("text/");
}
export function isSticker(mime) { return String(mime) === "image/webp"; }

export default { detectBuffer, fromExtension, toExtension, fromFilename, getCategory, isImage, isVideo, isAudio, isDocument, isSticker };
