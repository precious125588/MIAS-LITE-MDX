/**
 * Sticker command system (ESM version)
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DB_PATHS = [
  path.join(__dirname, "..", "database", "sticker_commands.json"),
  path.join(__dirname, "..", "..", "database", "sticker_commands.json"),
  path.join(process.cwd(), "database", "sticker_commands.json"),
  path.join(process.cwd(), "database", "stickerCmds.json")
];

function loadMappings() {
  const merged = {};
  for (const dbPath of DB_PATHS) {
    try {
      if (fs.existsSync(dbPath)) {
        const raw = fs.readFileSync(dbPath, "utf8");
        if (raw && raw.trim()) {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === "object") {
            Object.assign(merged, parsed);
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

export function getStickerHash(stickerMsg) {
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
      return buf.toString("hex");
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
      return crypto.createHash("sha256").update(buf).digest("hex");
    }
    return null;
  } catch {
    return null;
  }
}

export function setCmd(hash, command) {
  if (!hash || !command) return false;
  const cmd = command.trim().replace(/^[.\/!#]/, "");
  if (!cmd) return false;
  _mappings = loadMappings();
  _mappings[hash] = cmd;
  try {
    if (/^[0-9a-fA-F]{64}$/.test(hash)) {
      const b64 = Buffer.from(hash, "hex").toString("base64");
      _mappings[b64] = cmd;
    } else {
      const hex = Buffer.from(hash, "base64").toString("hex");
      _mappings[hex] = cmd;
    }
  } catch (_) {}
  saveMappings(_mappings);
  return true;
}

export function delCmd(hash) {
  if (!hash) return false;
  _mappings = loadMappings();
  let deleted = false;
  if (_mappings[hash]) {
    delete _mappings[hash];
    deleted = true;
  }
  try {
    if (/^[0-9a-fA-F]{64}$/.test(hash)) {
      const b64 = Buffer.from(hash, "hex").toString("base64");
      if (_mappings[b64]) {
        delete _mappings[b64];
        deleted = true;
      }
    } else {
      const hex = Buffer.from(hash, "base64").toString("hex");
      if (_mappings[hex]) {
        delete _mappings[hex];
        deleted = true;
      }
    }
  } catch (_) {}
  if (deleted) saveMappings(_mappings);
  return deleted;
}

export function getCmd(hash) {
  if (!hash) return null;
  _mappings = loadMappings();
  if (_mappings[hash]) return _mappings[hash];
  try {
    if (/^[0-9a-fA-F]{64}$/.test(hash)) {
      const b64 = Buffer.from(hash, "hex").toString("base64");
      if (_mappings[b64]) return _mappings[b64];
    } else {
      const hex = Buffer.from(hash, "base64").toString("hex");
      if (_mappings[hex]) return _mappings[hex];
    }
  } catch (_) {}
  return null;
}

export function listCmds() {
  _mappings = loadMappings();
  const result = {};
  for (const [k, v] of Object.entries(_mappings)) {
    if (/^[0-9a-fA-F]{64}$/.test(k)) {
      result[k] = v;
    } else if (!result[k]) {
      result[k] = v;
    }
  }
  return result;
}

export function cmdCount() {
  return Object.keys(listCmds()).length;
}

export function reloadMappings() {
  _mappings = loadMappings();
}
