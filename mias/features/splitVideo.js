// .split and .remux — reply to (or send with the caption) a video or a video
// document. .split cuts it into MP4 parts and sends each part in order.
// Default part length is 90 seconds; a length can be given, e.g. .split 30s,
// .split 30 seconds, .split 1m, .split 2 min. .remux repackages it as MP4
// without re-encoding when the codecs allow.
import fs from "fs";
import os from "os";
import path from "path";
import {
  probeFile, splitVideoFile, remuxToMp4, splitPlan, fmtDuration, SPLIT_SECONDS,
  WA_VIDEO_MAX_BYTES, WA_DOC_MAX_BYTES, VIDEO_DOC_EXTS,
} from "../lib/videoTools.js";

const DOWNLOAD_TIMEOUT_MS = 120000;
export const SPLIT_MAX_SECONDS = 60 * 60;
const SPLIT_LENGTH_RE = /^(\d+(?:\.\d+)?)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes)?$/;

// Parses the optional length argument of .split. An empty argument means the
// default (SPLIT_SECONDS). Anything unclear is an error, never a silent fallback.
export function parseSplitLength(input) {
  const text = String(input ?? "").trim().toLowerCase();
  if (!text) return { seconds: SPLIT_SECONDS, isDefault: true };
  const match = text.match(SPLIT_LENGTH_RE);
  if (!match) {
    return { error: `I couldn't read the length "${text}". Use a number with s or m, for example 30s, 30 seconds, 1m or 2 min.` };
  }
  const amount = Number(match[1]);
  const unit = match[2] || "s";
  const seconds = unit.startsWith("m") ? amount * 60 : amount;
  if (!Number.isFinite(seconds) || seconds < 1) {
    return { error: "The split length must be at least 1 second." };
  }
  if (seconds > SPLIT_MAX_SECONDS) {
    return { error: `The split length can be at most ${SPLIT_MAX_SECONDS / 60} minutes.` };
  }
  return { seconds: Math.round(seconds * 1000) / 1000, isDefault: false };
}

const secondsLabel = (sec) => `${Number.isInteger(sec) ? sec : sec.toFixed(2).replace(/\.?0+$/, "")} seconds`;
const unwrap = (m) => {
  let cur = m;
  for (let i = 0; i < 6 && cur && typeof cur === "object"; i++) {
    const next = cur.ephemeralMessage?.message
      || cur.viewOnceMessage?.message
      || cur.viewOnceMessageV2?.message
      || cur.viewOnceMessageV2Extension?.message
      || cur.documentWithCaptionMessage?.message
      || cur.editedMessage?.message
      || null;
    if (!next) break;
    cur = next;
  }
  return cur;
};

function isVideoDocument(doc) {
  const mime = String(doc?.mimetype || "").toLowerCase();
  if (mime.startsWith("video/")) return true;
  const name = String(doc?.fileName || "").toLowerCase();
  const ext = (name.match(/\.([a-z0-9]+)$/) || [])[1] || "";
  return VIDEO_DOC_EXTS.includes(ext);
}

// Finds a video, video note or video document in one message node.
export function findVideoIn(message) {
  const u = unwrap(message);
  if (!u) return null;
  if (u.videoMessage) return { node: u.videoMessage, dlType: "video", ext: "mp4" };
  if (u.ptvMessage) return { node: u.ptvMessage, dlType: "video", ext: "mp4" };
  if (u.documentMessage && isVideoDocument(u.documentMessage)) {
    const name = String(u.documentMessage.fileName || "");
    const ext = (name.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase() || "mp4";
    return { node: u.documentMessage, dlType: "document", ext };
  }
  return null;
}

// Quoted video first, then the message itself (a video sent with ".split" as its caption).
export function pickVideoSource(msg) {
  const m = msg?.message;
  const ctxInfo = m?.extendedTextMessage?.contextInfo
    || m?.videoMessage?.contextInfo
    || m?.documentMessage?.contextInfo
    || Object.values(m || {}).find((v) => v && typeof v === "object" && v.contextInfo)?.contextInfo
    || null;
  const quoted = ctxInfo?.quotedMessage;
  return (quoted && findVideoIn(quoted)) || findVideoIn(m);
}

function withTimeout(promise, ms, label) {
  let t;
  const timer = new Promise((_, reject) => { t = setTimeout(() => reject(new Error(`${label} timed out`)), ms); });
  return Promise.race([promise, timer]).finally(() => clearTimeout(t));
}

export function installSplitVideo(ctx) {
  const { cmd, sendReply, react, downloadContentFromMessage, CONFIG } = ctx;
  const PREFIX = CONFIG?.PREFIX || ".";

  async function downloadVideo(src) {
    const work = (async () => {
      const stream = await downloadContentFromMessage(src.node, src.dlType);
      if (!stream) throw new Error("the video download stream could not be opened");
      const chunks = [];
      let total = 0;
      try {
        for await (const c of stream) {
          total += c.length;
          if (total > WA_DOC_MAX_BYTES) {
            try { stream.destroy?.(); } catch {}
            throw new Error("the video is over WhatsApp's 2 GB limit");
          }
          chunks.push(c);
        }
      } finally {
        try { stream.destroy?.(); } catch {}
      }
      return Buffer.concat(chunks);
    })();
    return withTimeout(work, DOWNLOAD_TIMEOUT_MS, "Download");
  }

  async function sendVideoFile(sock, jid, msg, file, caption) {
    // Deliver through 4K delivery pipeline without re-encoding
    try {
      const disk = await import("../lib/tiktokDiskDelivery.cjs");
      if (disk && typeof disk.sendVideoFromDisk === "function") {
        const stats = fs.statSync(file);
        if (stats.size > WA_DOC_MAX_BYTES) throw new Error("a part is over WhatsApp's 2 GB limit");
        if (stats.size > WA_VIDEO_MAX_BYTES) {
          await disk.sendDocumentFromDisk(sock, jid, file, path.basename(file), caption, msg);
          return;
        }
        await disk.sendVideoFromDisk(sock, jid, file, caption, msg);
        return;
      }
    } catch (deliveryErr) {
      // Fallback to direct send if delivery helper fails
    }
    const isStatus = msg?.key?.remoteJid === "status@broadcast";
    const sendOpts = isStatus ? {} : { quoted: msg };
    const buf = fs.readFileSync(file);
    if (buf.length > WA_DOC_MAX_BYTES) throw new Error("a part is over WhatsApp's 2 GB limit");
    if (buf.length > WA_VIDEO_MAX_BYTES) {
      await sock.sendMessage(jid, { document: buf, mimetype: "video/mp4", fileName: path.basename(file), caption }, sendOpts);
    } else {
      try {
        await sock.sendMessage(jid, { video: buf, mimetype: "video/mp4", caption }, sendOpts);
      } catch (sendErr) {
        await sock.sendMessage(jid, { document: buf, mimetype: "video/mp4", fileName: path.basename(file), caption }, sendOpts);
      }
    }
  }

  cmd(["split"], {
    desc: `Split a video into parts (default ${SPLIT_SECONDS}s) — reply to a video, e.g. ${PREFIX}split 30s or ${PREFIX}split 1m`,
    category: "MEDIA",
  }, async (sock, msg, args = []) => {
    const isStatus = msg?.key?.remoteJid === "status@broadcast";
    const jid = isStatus ? (msg?.key?.participant || msg?.participant) : msg?.key?.remoteJid;
    const lengthArg = Array.isArray(args) ? args.join(" ") : String(args || "");
    const parsed = parseSplitLength(lengthArg);
    if (parsed.error) {
      await react(sock, msg, "❌");
      await sendReply(sock, msg, `❌ ${parsed.error}\n\nUsage: ${PREFIX}split [length]. Default is ${SPLIT_SECONDS} seconds. Examples: ${PREFIX}split 30s, ${PREFIX}split 1m`);
      return;
    }
    const segSec = parsed.seconds;
    const src = pickVideoSource(msg);
    if (!src) {
      await react(sock, msg, "❌");
      await sendReply(sock, msg, `Reply to a *video* or *video file* with ${PREFIX}split. Each part will be ${secondsLabel(segSec)} at most.`);
      return;
    }
    await react(sock, msg, "🌀");
    let dir = null;
    try {
      const buf = await downloadVideo(src);
      if (!buf.length) throw new Error("the video could not be downloaded from WhatsApp");
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "split-"));
      const inPath = path.join(dir, `in.${src.ext}`);
      fs.writeFileSync(inPath, buf);

      const info = await probeFile(inPath);
      if (!info.duration) throw new Error("I couldn't read that video's length");
      const plan = splitPlan(info.duration, segSec);
      if (!plan.needed) {
        await react(sock, msg, "❌");
        await sendReply(sock, msg, `⏱️ That video is ${fmtDuration(info.duration)} long. The split limit is ${secondsLabel(segSec)}, so it doesn't need splitting.`);
        return;
      }

      const partsDir = path.join(dir, "parts");
      fs.mkdirSync(partsDir);
      const parts = await splitVideoFile(inPath, partsDir, info, segSec);
      if (!parts.length) throw new Error("the split produced no parts");
      for (let i = 0; i < parts.length; i++) {
        await sendVideoFile(sock, jid, msg, parts[i], `Part ${i + 1}/${parts.length} · ${secondsLabel(segSec)} max`);
        if (i < parts.length - 1) await new Promise(r => setTimeout(r, 400));
      }
      await react(sock, msg, "✅");
    } catch (e) {
      console.error("[split] error:", e?.message || e);
      await react(sock, msg, "❌");
      await sendReply(sock, msg, `❌ Split failed: ${e?.message || e}`).catch(() => {});
    } finally {
      if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
    }
  });

  cmd(["remux"], {
    desc: "Repackage a video as MP4 without re-encoding when possible — reply to a video or video file",
    category: "MEDIA",
  }, async (sock, msg) => {
    const isStatus = msg?.key?.remoteJid === "status@broadcast";
    const jid = isStatus ? (msg?.key?.participant || msg?.participant) : msg?.key?.remoteJid;
    const src = pickVideoSource(msg);
    if (!src) {
      await react(sock, msg, "❌");
      await sendReply(sock, msg, `Reply to a *video* or *video file* with ${PREFIX}remux.`);
      return;
    }
    await react(sock, msg, "🌀");
    let dir = null;
    try {
      const buf = await downloadVideo(src);
      if (!buf.length) throw new Error("the video could not be downloaded from WhatsApp");
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "remux-"));
      const inPath = path.join(dir, `in.${src.ext}`);
      const outPath = path.join(dir, "out.mp4");
      fs.writeFileSync(inPath, buf);
      const info = await probeFile(inPath);
      await remuxToMp4(inPath, outPath, info);
      await sendVideoFile(sock, jid, msg, outPath, "Remuxed to MP4 (no re-encode)");
      await react(sock, msg, "✅");
    } catch (e) {
      console.error("[remux] error:", e?.message || e);
      await react(sock, msg, "❌");
      await sendReply(sock, msg, `❌ Remux failed: ${e?.message || e}`).catch(() => {});
    } finally {
      if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
    }
  });
}
