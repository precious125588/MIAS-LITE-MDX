"use strict";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  MIAS MDX — Two-Tier Media Delivery Cache System
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  Provides a high-performance, two-tier media reuse pipeline for WhatsApp:
 *
 *   1. Primary Method (WhatsApp CDN Media Keys):
 *      Reuses the uploaded file on WhatsApp's CDN using its directPath,
 *      mediaKey, and hashes. Re-sends directly without re-uploading, while
 *      applying the recipient's custom caption and quoted context.
 *
 *   2. Fallback 1 (copyNForward / Forwarding):
 *      If media key reconstruction fails, forwards the existing message
 *      cleanly without forwarding score / "Forwarded" tag.
 *
 *   3. Fallback 2 (Fresh Send & Auto-Cache):
 *      If both fail or cache misses, runs normal disk send / fresh upload,
 *      then indexes the new CDN keys for future reuse.
 *
 *  Storage & Lightness:
 *   - Strict 4-day TTL (345,600,000 ms) as configured by owner.
 *   - Stored in persistent DB directory with auto-pruning.
 *   - Hard limit of 2,000 entries to keep disk and memory light.
 */

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const os = require("os");

const CACHE_TTL_MS = 4 * 24 * 60 * 60 * 1000; // 4 days in milliseconds
const MAX_ENTRIES = 2000;
const CACHE_FILE_NAME = "media_delivery_cache.json";

// In-memory registry of cache entries
const _cacheMap = new Map();
let _dbFile = null;
let _saveTimer = null;
let _isLoaded = false;

function resolveDatabaseDir() {
  const authDir = String(process.env.AUTH_DIR || "").trim();
  if (authDir) {
    return path.join(path.resolve(authDir), "database");
  }

  const vol = String(process.env.RAILWAY_VOLUME_MOUNT_PATH || "").trim();
  if (vol && fs.existsSync(vol)) {
    return path.join(path.resolve(vol), "database");
  }

  const cwdDb = path.join(process.cwd(), "database");
  try {
    fs.mkdirSync(cwdDb, { recursive: true });
    return cwdDb;
  } catch {
    const tmpDb = path.join(os.tmpdir(), "mias-db");
    fs.mkdirSync(tmpDb, { recursive: true });
    return tmpDb;
  }
}

function getCacheFilePath() {
  if (_dbFile) return _dbFile;
  const dir = resolveDatabaseDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
  _dbFile = path.join(dir, CACHE_FILE_NAME);
  return _dbFile;
}

function serializeBuffer(buf) {
  if (!buf) return null;
  if (Buffer.isBuffer(buf)) return buf.toString("base64");
  if (typeof buf === "string") return buf;
  if (Array.isArray(buf)) return Buffer.from(buf).toString("base64");
  if (typeof buf === "object" && buf.data) return Buffer.from(buf.data).toString("base64");
  return null;
}

function deserializeBuffer(val) {
  if (!val) return null;
  if (Buffer.isBuffer(val)) return val;
  if (typeof val === "string") {
    try {
      return Buffer.from(val, "base64");
    } catch {
      return null;
    }
  }
  return null;
}

function unwrapWaMessage(raw) {
  if (!raw) return null;
  let m = raw.message || raw;
  for (let i = 0; i < 12 && m && typeof m === "object"; i++) {
    if (m.deviceSentMessage?.message) m = m.deviceSentMessage.message;
    else if (m.ephemeralMessage?.message) m = m.ephemeralMessage.message;
    else if (m.viewOnceMessage?.message) m = m.viewOnceMessage.message;
    else if (m.viewOnceMessageV2?.message) m = m.viewOnceMessageV2.message;
    else if (m.viewOnceMessageV2Extension?.message) m = m.viewOnceMessageV2Extension.message;
    else if (m.documentWithCaptionMessage?.message) m = m.documentWithCaptionMessage.message;
    else if (m.editedMessage?.message) m = m.editedMessage.message;
    else break;
  }
  return m;
}

function computeFileHash(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size === 0) return null;

    const hash = crypto.createHash("sha256");
    const fd = fs.openSync(filePath, "r");
    try {
      const buf = Buffer.alloc(256 * 1024);
      let bytesRead;
      let pos = 0;
      while ((bytesRead = fs.readSync(fd, buf, 0, buf.length, pos)) > 0) {
        hash.update(buf.subarray(0, bytesRead));
        pos += bytesRead;
      }
      return hash.digest("hex");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

function loadCacheFromDisk() {
  if (_isLoaded) return;
  _isLoaded = true;
  try {
    const file = getCacheFilePath();
    if (!fs.existsSync(file)) return;
    const raw = fs.readFileSync(file, "utf8");
    const json = JSON.parse(raw);
    const now = Date.now();
    if (Array.isArray(json)) {
      for (const entry of json) {
        if (entry && entry.key && entry.expiresAt && entry.expiresAt > now) {
          _cacheMap.set(entry.key, entry);
        }
      }
    } else if (json && typeof json === "object") {
      for (const [k, entry] of Object.entries(json)) {
        if (entry && entry.expiresAt && entry.expiresAt > now) {
          _cacheMap.set(k, entry);
        }
      }
    }
  } catch (err) {
    console.warn("[media-cache] Could not load cache file:", err?.message || err);
  }
}

function scheduleSaveToDisk() {
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    flushCacheToDisk().catch(() => {});
  }, 2000);
  if (typeof _saveTimer.unref === "function") _saveTimer.unref();
}

async function flushCacheToDisk() {
  try {
    sweepExpiredEntries();
    const file = getCacheFilePath();
    const entries = Array.from(_cacheMap.values()).slice(-MAX_ENTRIES);
    await fsp.writeFile(file, JSON.stringify(entries), "utf8");
  } catch (err) {
    console.warn("[media-cache] Save error:", err?.message || err);
  }
}

function sweepExpiredEntries() {
  const now = Date.now();
  for (const [k, v] of _cacheMap.entries()) {
    if (!v || !v.expiresAt || v.expiresAt <= now) {
      _cacheMap.delete(k);
    }
  }
  // If still over max limit, trim oldest
  if (_cacheMap.size > MAX_ENTRIES) {
    const sorted = Array.from(_cacheMap.entries()).sort(
      (a, b) => (a[1].createdAt || 0) - (b[1].createdAt || 0)
    );
    const toDelete = sorted.slice(0, _cacheMap.size - MAX_ENTRIES);
    for (const [k] of toDelete) {
      _cacheMap.delete(k);
    }
  }
}

/**
 * Extract WhatsApp CDN media keys and message reference from a sent message result.
 */
function extractMediaKeys(sentMessage) {
  if (!sentMessage) return null;
  const m = unwrapWaMessage(sentMessage);
  if (!m) return null;

  let target = null;
  let type = "video";

  if (m.videoMessage) {
    target = m.videoMessage;
    type = "video";
  } else if (m.ptvMessage) {
    target = m.ptvMessage;
    type = "video";
  } else if (m.documentMessage) {
    target = m.documentMessage;
    type = "document";
  } else if (m.audioMessage) {
    target = m.audioMessage;
    type = "audio";
  } else if (m.imageMessage) {
    target = m.imageMessage;
    type = "image";
  }

  if (!target || !target.directPath || !target.mediaKey) {
    return null;
  }

  const directPath = String(target.directPath || "");
  const mediaKey = serializeBuffer(target.mediaKey);
  const fileSha256 = serializeBuffer(target.fileSha256);
  const fileEncSha256 = serializeBuffer(target.fileEncSha256);
  const fileLength = Number(target.fileLength || 0);

  if (!directPath || !mediaKey) return null;

  return {
    type,
    directPath,
    mediaKey,
    fileSha256,
    fileEncSha256,
    fileLength,
    mimetype: target.mimetype || (type === "video" ? "video/mp4" : "application/octet-stream"),
    seconds: Number(target.seconds || 0),
    height: Number(target.height || 0),
    width: Number(target.width || 0),
    fileName: target.fileName || target.title || "media",
    ptv: Boolean(m.ptvMessage || target.ptv),
    rawMessage: sentMessage.key ? sentMessage : null,
  };
}

/**
 * Store a cached media entry with a strict 4-day TTL.
 */
function setCachedMedia(key, mediaData) {
  if (!key || !mediaData) return;
  loadCacheFromDisk();

  const now = Date.now();
  const entry = {
    key: String(key),
    createdAt: now,
    expiresAt: now + CACHE_TTL_MS, // 4-day expiry
    type: mediaData.type || "video",
    directPath: mediaData.directPath,
    mediaKey: mediaData.mediaKey,
    fileSha256: mediaData.fileSha256,
    fileEncSha256: mediaData.fileEncSha256,
    fileLength: Number(mediaData.fileLength || 0),
    mimetype: mediaData.mimetype,
    seconds: Number(mediaData.seconds || 0),
    height: Number(mediaData.height || 0),
    width: Number(mediaData.width || 0),
    fileName: mediaData.fileName || "media",
    ptv: Boolean(mediaData.ptv),
    rawMessage: mediaData.rawMessage || null,
  };

  _cacheMap.set(String(key), entry);
  scheduleSaveToDisk();
}

/**
 * Retrieve a cached media entry if present and within the 4-day window.
 */
function getCachedMedia(key) {
  if (!key) return null;
  loadCacheFromDisk();

  const entry = _cacheMap.get(String(key));
  if (!entry) return null;

  if (Date.now() > entry.expiresAt) {
    _cacheMap.delete(String(key));
    return null;
  }
  return entry;
}

/**
 * Delete a specific key or wipe expired keys immediately.
 */
function deleteCachedMedia(key) {
  loadCacheFromDisk();
  if (key) {
    _cacheMap.delete(String(key));
  } else {
    sweepExpiredEntries();
  }
  scheduleSaveToDisk();
}

/**
 * Primary Method:
 * Re-sends media using WhatsApp CDN directPath, mediaKey and hashes.
 * Avoids re-uploading bytes to WhatsApp while applying the caller's
 * caption and quoted context.
 */
async function sendViaMediaKeys(sock, jid, cached, {
  caption = "",
  quoted = null,
  fileName = null,
  type = null,
  ptv = false,
} = {}) {
  if (!sock || !jid || !cached || !cached.directPath || !cached.mediaKey) {
    throw new Error("Invalid parameters for media key send");
  }

  const mediaType = type || cached.type || "video";
  const mediaKeyBuf = deserializeBuffer(cached.mediaKey);
  const fileShaBuf = deserializeBuffer(cached.fileSha256);
  const fileEncShaBuf = deserializeBuffer(cached.fileEncSha256);
  const isPtv = Boolean(ptv || cached.ptv);

  const messageContent = {};

  if (mediaType === "document") {
    messageContent.documentMessage = {
      url: `https://mmg.whatsapp.net${cached.directPath}`,
      directPath: cached.directPath,
      mediaKey: mediaKeyBuf,
      fileSha256: fileShaBuf,
      fileEncSha256: fileEncShaBuf,
      fileLength: cached.fileLength,
      mimetype: cached.mimetype || "video/mp4",
      title: fileName || cached.fileName || "document.mp4",
      fileName: fileName || cached.fileName || "document.mp4",
      caption: caption || "",
    };
  } else if (mediaType === "audio") {
    messageContent.audioMessage = {
      url: `https://mmg.whatsapp.net${cached.directPath}`,
      directPath: cached.directPath,
      mediaKey: mediaKeyBuf,
      fileSha256: fileShaBuf,
      fileEncSha256: fileEncShaBuf,
      fileLength: cached.fileLength,
      mimetype: cached.mimetype || "audio/mp4",
      seconds: cached.seconds || 0,
      ptt: Boolean(cached.ptv),
    };
  } else {
    // Video
    messageContent.videoMessage = {
      url: `https://mmg.whatsapp.net${cached.directPath}`,
      directPath: cached.directPath,
      mediaKey: mediaKeyBuf,
      fileSha256: fileShaBuf,
      fileEncSha256: fileEncShaBuf,
      fileLength: cached.fileLength,
      mimetype: cached.mimetype || "video/mp4",
      caption: caption || "",
      seconds: cached.seconds || 0,
      height: cached.height || 0,
      width: cached.width || 0,
      ...(isPtv ? { ptv: true } : {}),
    };
  }

  // Attempt relay via sock.relayMessage
  if (typeof sock.relayMessage === "function") {
    let msgId = "3EB0" + crypto.randomBytes(8).toString("hex").toUpperCase();
    let finalPayload = messageContent;

    // Use generateWAMessageFromContent if available globally or on sock
    const genFn = globalThis.generateWAMessageFromContent ||
                  sock.generateWAMessageFromContent ||
                  (sock.constructor && sock.constructor.generateWAMessageFromContent);

    if (typeof genFn === "function") {
      try {
        const wam = genFn(jid, messageContent, { quoted, userJid: sock.user?.id });
        if (wam && wam.message && wam.key) {
          finalPayload = wam.message;
          msgId = wam.key.id || msgId;
        }
      } catch {}
    }

    await sock.relayMessage(jid, finalPayload, { messageId: msgId });
    const result = {
      key: { remoteJid: jid, fromMe: true, id: msgId },
      message: finalPayload,
      __cacheMethod: "primary_cdn_keys",
    };
    return result;
  }

  // Fallback direct sendMessage if relayMessage not present on mock
  if (typeof sock.sendMessage === "function") {
    const payload = {};
    if (mediaType === "document") {
      payload.document = messageContent.documentMessage;
      payload.fileName = fileName || cached.fileName;
    } else {
      payload.video = messageContent.videoMessage;
    }
    payload.caption = caption;
    const res = await sock.sendMessage(jid, payload, { quoted });
    if (res && res.key) res.__cacheMethod = "primary_cdn_keys";
    return res;
  }

  throw new Error("Socket has no compatible relayMessage or sendMessage method");
}

/**
 * Fallback 1:
 * Clean message forward without forwarding score / "Forwarded" tag.
 */
async function sendViaForwardFallback(sock, jid, cached, {
  quoted = null,
} = {}) {
  if (!sock || !jid || !cached) {
    throw new Error("Invalid parameters for forward fallback");
  }

  const rawMsg = cached.rawMessage;
  if (!rawMsg) {
    throw new Error("No raw message available for forward fallback");
  }

  // 1. Try sock.copyNForward (forceForward = false removes forwarded indicator)
  if (typeof sock.copyNForward === "function") {
    const res = await sock.copyNForward(jid, rawMsg, false, { quoted });
    if (res && res.key) {
      res.__cacheMethod = "fallback_forward";
      return res;
    }
  }

  // 2. Try sendMessage with forward option
  if (typeof sock.sendMessage === "function") {
    const res = await sock.sendMessage(jid, {
      forward: rawMsg,
      contextInfo: { forwardingScore: 0, isForwarded: false },
    }, { quoted });
    if (res && res.key) {
      res.__cacheMethod = "fallback_forward";
      return res;
    }
  }

  throw new Error("Socket does not support copyNForward or message forward");
}

/**
 * Universal Delivery Helper:
 * Delivers media via Primary (CDN keys) -> Fallback 1 (forward) -> Fallback 2 (fresh send).
 */
async function deliverWithMediaCache({
  sock,
  jid,
  cacheKey = null,
  filePath = null,
  type = "video",
  caption = "",
  fileName = null,
  quoted = null,
  ptv = false,
  sendFresh,
}) {
  if (typeof sendFresh !== "function") {
    throw new TypeError("sendFresh must be an async function");
  }

  // 1. Resolve keys
  const keysToCheck = [];
  if (cacheKey) keysToCheck.push(String(cacheKey));
  let fileHash = null;
  if (filePath) {
    fileHash = computeFileHash(filePath);
    if (fileHash) keysToCheck.push(`sha256:${fileHash}`);
  }

  // 2. Check cache
  let cached = null;
  for (const k of keysToCheck) {
    cached = getCachedMedia(k);
    if (cached) break;
  }

  // 3. If cached, try Primary (Media keys)
  if (cached) {
    try {
      const result = await sendViaMediaKeys(sock, jid, cached, {
        caption,
        quoted,
        fileName: fileName || cached.fileName,
        type: type || cached.type,
        ptv,
      });
      if (result?.key?.id) {
        return result;
      }
    } catch (primaryErr) {
      console.warn(`[media-cache] Primary CDN media-key relay failed, trying Fallback 1: ${primaryErr?.message || primaryErr}`);
    }

    // 4. Try Fallback 1 (copyNForward / forward)
    try {
      const result = await sendViaForwardFallback(sock, jid, cached, { quoted });
      if (result?.key?.id) {
        return result;
      }
    } catch (fallback1Err) {
      console.warn(`[media-cache] Fallback 1 forward failed, falling back to fresh send: ${fallback1Err?.message || fallback1Err}`);
    }
  }

  // 5. Fallback 2: Fresh Send
  const freshResult = await sendFresh();

  // 6. Index new send for future reuse with 4-day TTL
  try {
    const extracted = extractMediaKeys(freshResult);
    if (extracted) {
      for (const k of keysToCheck) {
        setCachedMedia(k, extracted);
      }
    }
  } catch (indexErr) {
    console.warn(`[media-cache] Failed to index fresh send: ${indexErr?.message || indexErr}`);
  }

  return freshResult;
}

/**
 * Register any sent message into the cache explicitly.
 */
function recordSentMedia(key, sentMessage) {
  try {
    const extracted = extractMediaKeys(sentMessage);
    if (extracted && key) {
      setCachedMedia(key, extracted);
      return true;
    }
  } catch {}
  return false;
}

module.exports = {
  CACHE_TTL_MS,
  MAX_ENTRIES,
  computeFileHash,
  extractMediaKeys,
  getCachedMedia,
  setCachedMedia,
  deleteCachedMedia,
  sweepExpiredEntries,
  sendViaMediaKeys,
  sendViaForwardFallback,
  deliverWithMediaCache,
  recordSentMedia,
};
