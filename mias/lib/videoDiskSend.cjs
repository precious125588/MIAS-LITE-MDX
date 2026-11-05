"use strict";
/*
 * Disk-backed media delivery for every socket the bot creates.
 *
 * Any sock.sendMessage() call whose payload carries a Buffer in video,
 * document or audio is written to a temporary file and sent from disk:
 * Baileys receives { url: <local path> } and streams the file itself. The
 * temporary file is deleted in `finally`, after the send either delivered or
 * failed. Payloads without such buffers (text, images, stickers, URLs) pass
 * through untouched. If the temporary file cannot be written, the original
 * buffer is sent as before so a full disk never blocks delivery.
 *
 * Video notes ({ video, ptv: true }) take the same path: the temp file is sent
 * as a round video note (ptvMessage) and removed afterwards.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const DISK_KEYS = ["video", "document", "audio"];
const TMP_PREFIX = "mais_vd_";
const STALE_MS = 60 * 60 * 1000;

function defaultDir() {
  const p = path.join(process.cwd(), "pipeline-work", "tmp");
  try {
    fs.mkdirSync(p, { recursive: true });
    return p;
  } catch {
    return os.tmpdir();
  }
}

function sweepStale(dir) {
  try {
    const cutoff = Date.now() - STALE_MS;
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith(TMP_PREFIX)) continue;
      const full = path.join(dir, name);
      try {
        if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
      } catch {}
    }
  } catch {}
}

function extensionFor(key, mimetype) {
  const mt = String(mimetype || "").toLowerCase();
  if (key === "video") return mt.includes("webm") ? ".webm" : ".mp4";
  if (key === "audio") {
    if (mt.includes("ogg")) return ".ogg";
    if (mt.includes("mp4") || mt.includes("m4a") || mt.includes("aac")) return ".m4a";
    return ".mp3";
  }
  return ".bin";
}

function isVideoNote(content) {
  return !!content && content.ptv === true && !!content.video;
}

function unlinkQuiet(file) {
  if (!file) return;
  try { fs.unlinkSync(file); } catch {}
}

function installVideoDiskSend(sock, { dir = null } = {}) {
  if (!sock || typeof sock.sendMessage !== "function" || sock.__miasVideoDiskSend) return sock;
  const workDir = dir || defaultDir();
  sweepStale(workDir);
  const rawSend = sock.sendMessage.bind(sock);

  sock.sendMessage = async function sendFromDisk(jid, content, options) {
    if (!content || typeof content !== "object" || Buffer.isBuffer(content)) {
      return rawSend(jid, content, options);
    }
    const keys = DISK_KEYS.filter((k) => Buffer.isBuffer(content[k]) && content[k].length > 0);
    if (!keys.length) return rawSend(jid, content, options);

    const written = [];
    const payload = { ...content };
    if (isVideoNote(content)) {
      // Round video notes: keep ptv so Baileys builds ptvMessage, and make sure the MIME type is video/mp4.
      payload.ptv = true;
      if (!payload.mimetype) payload.mimetype = "video/mp4";
      delete payload.gifPlayback;
    }
    try {
      for (const key of keys) {
        const file = path.join(workDir, `${TMP_PREFIX}${crypto.randomBytes(8).toString("hex")}${extensionFor(key, content.mimetype)}`);
        fs.writeFileSync(file, content[key]);
        written.push(file);
        payload[key] = { url: file };
      }
    } catch (error) {
      for (const file of written) unlinkQuiet(file);
      console.error(`[disk-send] could not write temp file, sending from memory: ${error?.message || error}`);
      return rawSend(jid, content, options);
    }

    try {
      return await rawSend(jid, payload, options);
    } finally {
      for (const file of written) unlinkQuiet(file);
    }
  };

  sock.__miasVideoDiskSend = true;
  return sock;
}

module.exports = { installVideoDiskSend, isVideoNote, DISK_KEYS, TMP_PREFIX };
