"use strict";

const { detectBuffer } = require("./fileDetection.cjs");

const DEFAULT_MIME = {
  image: "image/jpeg",
  video: "video/mp4",
  audio: "audio/mpeg",
  document: "application/octet-stream",
  sticker: "image/webp",
};

function normalizeKind(kind, detected) {
  const value = String(kind || detected?.category || "document").toLowerCase();
  if (value === "gif") return "video";
  if (value === "voice" || value === "voicenote" || value === "voice-note") return "audio";
  return ["image", "video", "audio", "document", "sticker"].includes(value) ? value : "document";
}

async function createMediaPayload(buffer, options = {}) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError("createMediaPayload expects a Buffer");
  const detected = options.detect === false ? null : await detectBuffer(buffer);
  const kind = normalizeKind(options.kind, detected);
  const payload = { [kind]: buffer };
  if (kind === "audio" && options.ptt) payload.ptt = true;
  if (options.caption) payload.caption = String(options.caption);
  if (options.fileName) payload.fileName = String(options.fileName);
  if (options.mimetype || detected?.mime) payload.mimetype = options.mimetype || detected.mime;
  if (options.gifPlayback && kind === "video") payload.gifPlayback = true;
  return { payload, kind, detected };
}

async function sendMedia(sock, jid, buffer, options = {}) {
  if (!sock || typeof sock.sendMessage !== "function") throw new TypeError("A Baileys-compatible socket is required");
  const { payload } = await createMediaPayload(buffer, options);
  const sendOptions = {};
  if (options.quoted) sendOptions.quoted = options.quoted;
  if (options.ephemeralExpiration) sendOptions.ephemeralExpiration = options.ephemeralExpiration;
  return sock.sendMessage(jid, payload, sendOptions);
}

async function sendAlbum(sock, jid, items, options = {}) {
  if (!Array.isArray(items) || items.length === 0) throw new TypeError("Album items must be a non-empty array");
  const results = [];
  for (const item of items) {
    const buffer = Buffer.isBuffer(item) ? item : item.buffer;
    const itemOptions = Buffer.isBuffer(item) ? {} : item;
    results.push(await sendMedia(sock, jid, buffer, { ...options, ...itemOptions }));
    if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
  }
  return results;
}

function mediaDefaults(kind) {
  return DEFAULT_MIME[normalizeKind(kind)] || DEFAULT_MIME.document;
}

module.exports = { createMediaPayload, mediaDefaults, sendAlbum, sendMedia };