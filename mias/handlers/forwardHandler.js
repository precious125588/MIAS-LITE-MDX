/**
 * MIAS — Forward Handler
 *
 * Centralizes all message forwarding logic.
 * Supports reliable media download -> fresh Baileys media upload pipeline.
 */

import { downloadContentFromMessage } from "@whiskeysockets/baileys";

function _deepClone(obj) {
  try {
    return JSON.parse(JSON.stringify(obj));
  } catch {
    return obj;
  }
}

function _injectForwardScore(content, score) {
  const cloned = _deepClone(content);
  const firstKey = Object.keys(cloned || {})[0];
  if (!firstKey) return cloned;
  cloned[firstKey] = cloned[firstKey] || {};
  cloned[firstKey].contextInfo = {
    ...(cloned[firstKey].contextInfo || {}),
    forwardingScore: score,
    isForwarded: score > 0,
  };
  return cloned;
}

function _unwrapMedia(msg) {
  let m = msg?.message || msg;
  for (let i = 0; i < 6 && m && typeof m === "object"; i++) {
    const next = m.ephemeralMessage?.message ||
                 m.viewOnceMessage?.message ||
                 m.viewOnceMessageV2?.message ||
                 m.viewOnceMessageV2Extension?.message ||
                 m.documentWithCaptionMessage?.message || null;
    if (!next) break;
    m = next;
  }
  return m;
}

/**
 * Forward a message to a JID with reliable media re-upload pipeline.
 */
export async function forwardMessage(sock, toJid, msg, opts = {}) {
  try {
    const m = _unwrapMedia(msg);
    if (!m) return null;

    // Detect media
    if (m.videoMessage || m.ptvMessage) {
      const v = m.videoMessage || m.ptvMessage;
      const stream = await downloadContentFromMessage(v, "video");
      let buf = Buffer.alloc(0);
      for await (const chunk of stream) buf = Buffer.concat([buf, chunk]);
      if (buf && buf.length > 100) {
        console.log(`[forward] Delivered video bytes=${buf.length} to target=${toJid}`);
        return await sock.sendMessage(toJid, {
          video: buf,
          caption: v.caption || "",
          mimetype: v.mimetype || "video/mp4",
          ptv: !!m.ptvMessage,
          contextInfo: { forwardingScore: opts.score ?? 1, isForwarded: (opts.score ?? 1) > 0 }
        });
      }
    }

    if (m.imageMessage) {
      const img = m.imageMessage;
      const stream = await downloadContentFromMessage(img, "image");
      let buf = Buffer.alloc(0);
      for await (const chunk of stream) buf = Buffer.concat([buf, chunk]);
      if (buf && buf.length > 100) {
        console.log(`[forward] Delivered image bytes=${buf.length} to target=${toJid}`);
        return await sock.sendMessage(toJid, {
          image: buf,
          caption: img.caption || "",
          mimetype: img.mimetype || "image/jpeg",
          contextInfo: { forwardingScore: opts.score ?? 1, isForwarded: (opts.score ?? 1) > 0 }
        });
      }
    }

    if (m.audioMessage) {
      const a = m.audioMessage;
      const stream = await downloadContentFromMessage(a, "audio");
      let buf = Buffer.alloc(0);
      for await (const chunk of stream) buf = Buffer.concat([buf, chunk]);
      if (buf && buf.length > 100) {
        console.log(`[forward] Delivered audio bytes=${buf.length} to target=${toJid}`);
        return await sock.sendMessage(toJid, {
          audio: buf,
          mimetype: a.mimetype || "audio/ogg; codecs=opus",
          ptt: !!a.ptt,
          contextInfo: { forwardingScore: opts.score ?? 1, isForwarded: (opts.score ?? 1) > 0 }
        });
      }
    }

    if (m.documentMessage) {
      const d = m.documentMessage;
      const stream = await downloadContentFromMessage(d, "document");
      let buf = Buffer.alloc(0);
      for await (const chunk of stream) buf = Buffer.concat([buf, chunk]);
      if (buf && buf.length > 100) {
        console.log(`[forward] Delivered document bytes=${buf.length} to target=${toJid}`);
        return await sock.sendMessage(toJid, {
          document: buf,
          mimetype: d.mimetype || "application/octet-stream",
          fileName: d.fileName || "document",
          contextInfo: { forwardingScore: opts.score ?? 1, isForwarded: (opts.score ?? 1) > 0 }
        });
      }
    }

    if (m.stickerMessage) {
      const s = m.stickerMessage;
      const stream = await downloadContentFromMessage(s, "sticker");
      let buf = Buffer.alloc(0);
      for await (const chunk of stream) buf = Buffer.concat([buf, chunk]);
      if (buf && buf.length > 100) {
        console.log(`[forward] Delivered sticker bytes=${buf.length} to target=${toJid}`);
        return await sock.sendMessage(toJid, {
          sticker: buf,
          isAnimated: !!s.isAnimated,
          contextInfo: { forwardingScore: opts.score ?? 1, isForwarded: (opts.score ?? 1) > 0 }
        });
      }
    }

    // Text or other content
    const text = m.conversation || m.extendedTextMessage?.text || "";
    if (text) {
      return await sock.sendMessage(toJid, {
        text,
        contextInfo: { forwardingScore: opts.score ?? 1, isForwarded: (opts.score ?? 1) > 0 }
      });
    }

    // Fallback native Baileys forward
    return await sock.sendMessage(toJid, { forward: msg, force: true });
  } catch (err) {
    console.error("[forwardMessage] Error:", err?.message || err);
    return null;
  }
}

export async function forwardSilent(sock, toJid, msg) {
  return forwardMessage(sock, toJid, msg, { score: 0 });
}

export async function broadcastForward(sock, jids, msg, opts = {}) {
  const results = [];
  for (const jid of jids) {
    try {
      results.push(await forwardMessage(sock, jid, msg, opts));
    } catch {
      results.push(null);
    }
  }
  return results;
}

export async function resendMessage(sock, toJid, msg, extra = {}) {
  try {
    return await forwardMessage(sock, toJid, msg, { score: 0 });
  } catch (err) {
    console.error("[resendMessage] Error:", err?.message);
    return null;
  }
}
