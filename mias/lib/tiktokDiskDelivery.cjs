"use strict";

const fs = require("fs");
const RATE_LIMIT_RETRY_DELAYS_MS = Object.freeze([1500, 5000]);
const WHATSAPP_VIDEO_MAX_BYTES = 95 * 1024 * 1024;

function assertWhatsAppVideoSize(bytes) {
  const size = Number(bytes) || 0;
  if (size <= WHATSAPP_VIDEO_MAX_BYTES) return;

  const sizeMiB = (size / (1024 * 1024)).toFixed(1);
  const error = new Error(
    `This MP4 is ${sizeMiB} MiB. Video messages are limited to 95 MB. Nothing was sent as a video. Choose 1.4 HD Document to send the same original MP4 as a document (up to 2 GB).`,
  );
  error.code = "WHATSAPP_VIDEO_TOO_LARGE";
  throw error;
}

function isRateLimitError(error) {
  const message = [
    error?.message,
    error?.code,
    error?.status,
    error?.statusCode,
    error?.output?.statusCode,
    error?.output?.payload?.tag,
    error?.data?.error,
  ].filter((value) => value !== undefined && value !== null).join(" ");
  return /rate[\s_-]*over[\s_-]*limit|too many requests|(?:http|status|code)[\s:=_-]*429\b/i.test(message);
}

async function sendWithRateLimitRetry(send, {
  retryDelaysMs = RATE_LIMIT_RETRY_DELAYS_MS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  let attempt = 0;
  while (true) {
    try {
      return await send();
    } catch (error) {
      if (!isRateLimitError(error) || attempt >= retryDelaysMs.length) throw error;
      const delay = Math.max(0, Number(retryDelaysMs[attempt]) || 0);
      attempt += 1;
      await sleep(delay);
    }
  }
}

async function sendConfirmedFileMessage(sock, jid, payload, msg, retryOptions) {
  return sendWithRateLimitRetry(async () => {
    const result = await sock.sendMessage(jid, payload, { quoted: msg });
    if (!result?.key?.id) {
      const error = new Error("WhatsApp did not confirm the file send; delivery is unconfirmed.");
      error.code = "SEND_UNCONFIRMED";
      throw error;
    }
    return result;
  }, retryOptions);
}

function hasMp4Signature(prefix) {
  return Buffer.isBuffer(prefix)
    && prefix.length >= 12
    && prefix.subarray(4, 8).toString("ascii") === "ftyp";
}

function createTikTokFileName(title, extension = ".mp4") {
  const requestedExtension = String(extension || ".mp4").toLowerCase();
  const safeExtension = /^\.[a-z0-9]{1,8}$/.test(requestedExtension)
    ? requestedExtension
    : ".mp4";
  const safeTitle = Array.from(String(title || "").normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[. ]+/g, "")
    .replace(/[. ]+$/g, ""))
    .slice(0, 120)
    .join("")
    .replace(/[. ]+$/g, "");
  const baseName = safeTitle || "TikTok video";
  return baseName.toLowerCase().endsWith(safeExtension)
    ? baseName
    : `${baseName}${safeExtension}`;
}

async function fetchVideoCandidate(url, {
  pipeline,
  cap,
  maxBufferedBytes,
  timeout = 90000,
  headers,
} = {}) {
  if (!pipeline || typeof pipeline.fetchToDisk !== "function") {
    throw new TypeError("A media pipeline with fetchToDisk is required");
  }

  const downloaded = await pipeline.fetchToDisk(url, { cap, timeout, headers });
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    if (typeof downloaded.cleanup === "function") {
      await downloaded.cleanup();
    } else if (downloaded.path) {
      await fs.promises.rm(downloaded.path, { force: true });
    }
  };

  try {
    const bytes = Number(downloaded.bytes) || fs.statSync(downloaded.path).size;
    if (bytes < 2048) {
      await cleanup();
      return null;
    }

    const fd = fs.openSync(downloaded.path, "r");
    let prefix;
    try {
      prefix = Buffer.alloc(Math.min(64, bytes));
      const read = fs.readSync(fd, prefix, 0, prefix.length, 0);
      prefix = prefix.subarray(0, read);
    } finally {
      fs.closeSync(fd);
    }

    const head = prefix.toString("utf8").trim().toLowerCase();
    if (head.startsWith("<!doctype") || head.startsWith("<html") || head.startsWith("{")) {
      await cleanup();
      return null;
    }

    // The normalizer's documented 120 MiB input limit makes it a no-op above
    // this size. Keep large non-MP4 responses off the heap too: reject them
    // rather than reading an unexpected large payload into a Buffer.
    if (bytes > maxBufferedBytes) {
      if (!hasMp4Signature(prefix)) {
        await cleanup();
        return null;
      }
      return {
        buffer: null,
        file: { path: downloaded.path, bytes, cleanup },
      };
    }

    const buffer = fs.readFileSync(downloaded.path);
    await cleanup();
    return { buffer, file: null, bytes };
  } catch (error) {
    await cleanup().catch(() => {});
    throw error;
  }
}

function sendVideoFromDisk(sock, jid, filePath, caption, msg, retryOptions) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      const stat = fs.statSync(filePath);
      if (stat.size > WHATSAPP_VIDEO_MAX_BYTES) {
        throw new Error(`Video file size (${Math.round(stat.size / (1024 * 1024))} MB) exceeds WhatsApp video limit (${Math.round(WHATSAPP_VIDEO_MAX_BYTES / (1024 * 1024))} MB). Only document modes can send as documents.`);
      }
    }
  } catch (err) {
    if (err.message && err.message.includes("exceeds WhatsApp video limit")) {
      throw err;
    }
  }
  return sendConfirmedFileMessage(
    sock,
    jid,
    { video: { url: filePath }, mimetype: "video/mp4", caption },
    msg,
    retryOptions,
  );
}

function sendDocumentFromDisk(sock, jid, filePath, fileName, caption, msg, retryOptions) {
  return sendConfirmedFileMessage(
    sock,
    jid,
    { document: { url: filePath }, mimetype: "video/mp4", fileName, caption },
    msg,
    retryOptions,
  );
}

module.exports = {
  assertWhatsAppVideoSize,
  createTikTokFileName,
  fetchVideoCandidate,
  hasMp4Signature,
  isRateLimitError,
  sendDocumentFromDisk,
  sendWithRateLimitRetry,
  sendVideoFromDisk,
  WHATSAPP_VIDEO_MAX_BYTES,
};
