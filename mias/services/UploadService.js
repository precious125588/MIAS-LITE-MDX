/**
 * MIAS — Upload Service
 *
 * Centralized media upload hub.
 * Commands never call catbox/Baileys upload directly.
 *
 * Architecture: Commands → UploadService → UploadHandler → Baileys / Catbox
 */

import { uploadMedia as _uploadMedia, uploadToCatbox as _uploadCatbox } from "../handlers/uploadHandler.js";
import { enqueueUpload } from "./QueueService.js";

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Upload a Buffer to Catbox and return the public URL.
 * Queued via the upload queue.
 *
 * @param {Buffer} buffer
 * @param {string} [filename="file.bin"]
 * @param {string} [mimetype="application/octet-stream"]
 * @returns {Promise<string>} Public Catbox URL
 */
export async function uploadToCatbox(buffer, filename = "file.bin", mimetype = "application/octet-stream") {
  return enqueueUpload(() => _uploadCatbox(buffer, filename, mimetype));
}

/**
 * Upload media using Baileys built-in upload mechanism.
 * Returns the prepared media object with a WhatsApp media URL.
 *
 * @param {object} sock
 * @param {Buffer} buffer
 * @param {"image"|"video"|"audio"|"document"|"sticker"} type
 * @param {object} [opts]
 * @returns {Promise<object>}
 */
export async function uploadToBaileys(sock, buffer, type = "image", opts = {}) {
  return enqueueUpload(() => _uploadMedia(sock, buffer, type, opts));
}

/**
 * Upload media and return a public URL.
 * Prefers Catbox; uses Baileys as fallback.
 *
 * @param {object} sock
 * @param {Buffer} buffer
 * @param {string} filename
 * @param {string} mimetype
 * @param {"image"|"video"|"audio"|"document"|"sticker"} [type]
 * @returns {Promise<string>}
 */
export async function uploadAndGetUrl(sock, buffer, filename, mimetype, type = "image") {
  return enqueueUpload(async () => {
    try { return await _uploadCatbox(buffer, filename, mimetype); }
    catch {
      const media = await _uploadMedia(sock, buffer, type);
      return media?.url || "";
    }
  });
}

export default { uploadToCatbox, uploadToBaileys, uploadAndGetUrl };
