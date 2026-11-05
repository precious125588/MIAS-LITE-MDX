/**
 * CJS bridge for stickerCmd — unified persistent sticker command store
 */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DB_PATHS = [
  path.join(__dirname, "..", "database", "sticker_commands.json"),
  path.join(__dirname, "..", "..", "database", "sticker_commands.json"),
  path.join(process.cwd(), "database", "sticker_commands.json"),
  path.join(process.cwd(), "database", "stickerCmds.json")
];

function normalizeHash(hash) {
  if (!hash || typeof hash !== "string") return null;
  const clean = hash.trim();
  if (/^[0-9a-fA-F]{64}$/.test(clean)) {
    return clean.toLowerCase();
  }
  try {
    const buf = Buffer.from(clean, "base64");
    if (buf.length === 32) {
      return buf.toString("hex").toLowerCase();
    }
  } catch (_) {}
  return clean.toLowerCase();
}

function loadMappings() {
  const merged = {};
  for (const dbPath of DB_PATHS) {
    try {
      if (fs.existsSync(dbPath)) {
        const raw = fs.readFileSync(dbPath, "utf8");
        if (raw && raw.trim()) {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === "object") {
            for (const [k, v] of Object.entries(parsed)) {
              const norm = normalizeHash(k) || k;
              if (norm && v && typeof v === "string") {
                merged[norm] = v.trim().replace(/^[.\/!#]/, "");
              }
            }
          }
        }
      }
    } catch (_) {}
  }
  return merged;
}

function saveMappings(map) {
  const targets = [
    DB_PATHS[0],
    DB_PATHS[2],
    DB_PATHS[3]
  ];
  for (const p of targets) {
    try {
      const dir = path.dirname(p);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(p, JSON.stringify(map, null, 2), "utf8");
    } catch (e) {
      console.error("[StickerCmd] Save failed for " + p + ":", e.message);
    }
  }
}

let _mappings = loadMappings();

function getStickerHash(stickerMsg) {
  if (!stickerMsg) return null;
  try {
    const sha = stickerMsg.fileSha256 || stickerMsg.fileEncSha256;
    if (sha) {
      let buf;
      if (Buffer.isBuffer(sha)) {
        buf = sha;
      } else if (sha instanceof Uint8Array) {
        buf = Buffer.from(sha);
      } else if (typeof sha === "object" && Array.isArray(sha.data)) {
        buf = Buffer.from(sha.data);
      } else if (typeof sha === "string") {
        buf = /^[0-9a-fA-F]{64}$/.test(sha) ? Buffer.from(sha, "hex") : Buffer.from(sha, "base64");
      } else {
        buf = Buffer.from(sha);
      }
      return buf.toString("hex").toLowerCase();
    }
    if (stickerMsg.mediaKey) {
      let buf;
      if (Buffer.isBuffer(stickerMsg.mediaKey)) {
        buf = stickerMsg.mediaKey;
      } else if (stickerMsg.mediaKey instanceof Uint8Array) {
        buf = Buffer.from(stickerMsg.mediaKey);
      } else if (typeof stickerMsg.mediaKey === "string") {
        buf = Buffer.from(stickerMsg.mediaKey, "base64");
      } else {
        buf = Buffer.from(stickerMsg.mediaKey);
      }
      return crypto.createHash("sha256").update(buf).digest("hex").toLowerCase();
    }
    return null;
  } catch {
    return null;
  }
}

function stickerSetCmd(hash, command) {
  if (!hash || !command) return false;
  const cmd = command.trim().replace(/^[.\/!#]/, "");
  if (!cmd) return false;
  const norm = normalizeHash(hash) || hash;
  _mappings = loadMappings();
  _mappings[norm] = cmd;
  saveMappings(_mappings);
  return true;
}

function stickerDelCmd(hash) {
  if (!hash) return false;
  const norm = normalizeHash(hash) || hash;
  _mappings = loadMappings();
  let deleted = false;
  if (_mappings[norm]) {
    delete _mappings[norm];
    deleted = true;
  }
  if (_mappings[hash]) {
    delete _mappings[hash];
    deleted = true;
  }
  if (deleted) saveMappings(_mappings);
  return deleted;
}

function stickerGetCmd(hash) {
  if (!hash) return null;
  const norm = normalizeHash(hash) || hash;
  _mappings = loadMappings();
  if (_mappings[norm]) return _mappings[norm];
  if (_mappings[hash]) return _mappings[hash];
  return null;
}

function stickerListCmds() {
  _mappings = loadMappings();
  const seen = new Set();
  const result = {};
  for (const [k, v] of Object.entries(_mappings)) {
    const norm = normalizeHash(k) || k;
    const pair = `${norm}:${v}`;
    if (!seen.has(pair)) {
      seen.add(pair);
      result[norm] = v;
    }
  }
  return result;
}

function stickerCmdCount() {
  return Object.keys(stickerListCmds()).length;
}

module.exports = {
  loadMappings,
  saveMappings,
  getStickerHash,
  stickerSetCmd,
  stickerDelCmd,
  stickerGetCmd,
  stickerListCmds,
  stickerCmdCount
};
