"use strict";
/*
 * Disk-backed media delivery for every socket the bot creates.
 *
 * Any sock.sendMessage() call whose payload carries a Buffer or remote URL in
 * video, document, audio, image, or sticker is streamed to a temporary file
 * and sent from disk: Baileys receives { url: <local path> } and streams the
 * file itself. The temporary file is deleted in `finally`, after the send
 * either delivered or failed. If a temporary file cannot be written, the original
 * payload is sent as before so a full disk or transient error never blocks delivery.
 *
 * Video notes ({ video, ptv: true }) take the same path: the temp file is sent
 * as a round video note (ptvMessage) and removed afterwards.
 */

const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { Readable } = require("stream");

const DISK_KEYS = ["video", "document", "audio", "image", "sticker"];
const TMP_PREFIX = "mais_vd_";
const STALE_MS = 60 * 60 * 1000;
const BUFFER_SPILL_MIN_BYTES = 512 * 1024; // 512 KB: small stickers/icons stay in memory, heavy media spills to disk

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
  if (key === "image") {
    if (mt.includes("png")) return ".png";
    if (mt.includes("webp")) return ".webp";
    return ".jpg";
  }
  if (key === "sticker") return ".webp";
  return ".bin";
}

function isVideoNote(content) {
  return !!content && content.ptv === true && !!content.video;
}

function unlinkQuiet(file) {
  if (!file) return;
  try { fs.unlinkSync(file); } catch {}
}

function extractRemoteUrl(val) {
  if (typeof val === "string" && /^https?:\/\//i.test(val)) return val;
  if (val && typeof val === "object" && typeof val.url === "string" && /^https?:\/\//i.test(val.url)) return val.url;
  return null;
}

async function streamRemoteUrlToDisk(url, targetPath, timeoutMs = 60000) {
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} streaming media`);
  const out = fs.createWriteStream(targetPath);
  const nodeStream = typeof Readable.fromWeb === "function" ? Readable.fromWeb(res.body) : res.body;
  await new Promise((resolve, reject) => {
    nodeStream.pipe(out);
    nodeStream.on("error", reject);
    out.on("finish", resolve);
    out.on("error", reject);
  });
  return targetPath;
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

    const written = [];
    const payload = { ...content };
    if (isVideoNote(content)) {
      payload.ptv = true;
      if (!payload.mimetype) payload.mimetype = "video/mp4";
      delete payload.gifPlayback;
    }

    try {
      for (const key of DISK_KEYS) {
        const val = content[key];
        if (!val) continue;

        // 1. In-memory Buffer: write to disk if > BUFFER_SPILL_MIN_BYTES or if it's video/document/audio
        if (Buffer.isBuffer(val)) {
          const mustSpill = (key === "video" || key === "document" || key === "audio") || val.length >= BUFFER_SPILL_MIN_BYTES;
          if (mustSpill && val.length > 0) {
            const ext = content.fileName ? path.extname(content.fileName) || extensionFor(key, content.mimetype) : extensionFor(key, content.mimetype);
            const file = path.join(workDir, `${TMP_PREFIX}${crypto.randomBytes(8).toString("hex")}${ext}`);
            fs.writeFileSync(file, val);
            written.push(file);
            payload[key] = { url: file };
          }
        }
        // 2. Remote URL: stream straight to disk
        else {
          const remoteUrl = extractRemoteUrl(val);
          if (remoteUrl) {
            try {
              const ext = content.fileName ? path.extname(content.fileName) || extensionFor(key, content.mimetype) : extensionFor(key, content.mimetype);
              const file = path.join(workDir, `${TMP_PREFIX}${crypto.randomBytes(8).toString("hex")}${ext}`);
              await streamRemoteUrlToDisk(remoteUrl, file, 90000);
              written.push(file);
              payload[key] = { url: file };
            } catch (dlErr) {
              // If remote fetch fails here, let Baileys handle the original URL or fail gracefully
              console.warn(`[disk-send] remote stream fallback: ${dlErr?.message || dlErr}`);
            }
          }
        }
      }

      // Universal cache layer: covers media commands that send buffers/URLs
      // directly instead of using one of the dedicated disk-delivery helpers.
      const mediaKey = DISK_KEYS.find((key) => payload[key]);
      if (mediaKey) {
        try {
          const mediaCache = require("./mediaDeliveryCache.cjs");
          const source = content[mediaKey];
          const localPath = written.find((file) => payload[mediaKey]?.url === file)
            || (source && typeof source === "object" && typeof source.url === "string" && fs.existsSync(source.url) ? source.url : null)
            || (typeof source === "string" && fs.existsSync(source) ? source : null);
          const sourceBuffer = Buffer.isBuffer(source) ? source : null;
          const sourceHash = localPath
            ? mediaCache.computeFileHash(localPath)
            : sourceBuffer ? crypto.createHash("sha256").update(sourceBuffer).digest("hex") : null;
          const cacheKey = sourceHash ? `sha256:${sourceHash}` : null;

          if (cacheKey) {
            const type = mediaKey === "ptv" ? "video" : mediaKey;
            const cacheSock = new Proxy(sock, {
              get(target, property, receiver) {
                if (property === "sendMessage") return rawSend;
                const value = Reflect.get(target, property, receiver);
                return typeof value === "function" ? value.bind(target) : value;
              },
            });
            return await mediaCache.deliverWithMediaCache({
              sock: cacheSock,
              jid,
              cacheKey,
              filePath: localPath,
              type,
              caption: typeof content.caption === "string" ? content.caption : "",
              fileName: content.fileName || null,
              ptv: mediaKey === "audio" ? Boolean(content.ptt) : Boolean(content.ptv),
              isAnimated: Boolean(content.isAnimated),
              quoted: options?.quoted || null,
              sendFresh: () => rawSend(jid, payload, options),
            });
          }
        } catch (cacheErr) {
          console.warn(`[disk-send] media cache fallback: ${cacheErr?.message || cacheErr}`);
        }
      }

      const result = await rawSend(jid, payload, options);
      if (result?.key?.id) {
        try {
          const mediaCache = require("./mediaDeliveryCache.cjs");
          const pathsToIndex = [...written];
          const mediaKey = DISK_KEYS.find((k) => payload[k]);
          const localPath = (mediaKey && payload[mediaKey]?.url && fs.existsSync(payload[mediaKey].url) ? payload[mediaKey].url : null)
            || (mediaKey && content[mediaKey]?.url && fs.existsSync(content[mediaKey].url) ? content[mediaKey].url : null)
            || (mediaKey && typeof content[mediaKey] === "string" && fs.existsSync(content[mediaKey]) ? content[mediaKey] : null);
          if (localPath && !pathsToIndex.includes(localPath)) {
            pathsToIndex.push(localPath);
          }
          for (const file of pathsToIndex) {
            const h = mediaCache.computeFileHash(file);
            if (h) {
              mediaCache.recordSentMedia(`sha256:${h}`, result);
            }
          }
        } catch {}
      }
      return result;
    } catch (error) {
      console.error(`[disk-send] send error: ${error?.message || error}`);
      throw error;
    } finally {
      for (const file of written) unlinkQuiet(file);
    }
  };

  sock.__miasVideoDiskSend = true;
  console.log("[CDN-CACHE] Media cache enabled for direct socket media delivery (video, audio, image, document, sticker)");
  return sock;
}

module.exports = { installVideoDiskSend, isVideoNote, DISK_KEYS, TMP_PREFIX, defaultDir, sweepStale };
