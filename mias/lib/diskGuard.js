/**
 * Small, dependency-free guard for media downloads.
 *
 * A media Buffer is usually uploaded by Baileys through a temporary file. On
 * small containers, several concurrent downloads can therefore fail with
 * ENOSPC even when the JavaScript heap still has room.
 */
import fs from "fs";
import os from "os";
import path from "path";

const MB = 1024 * 1024;
const DEFAULT_MAX_MEDIA_MB = 64;
// TikTok HD assets can exceed the general 64 MiB cap; keep this override
// scoped to TikTok downloads so other platforms retain their existing limit.
export const TIKTOK_DOWNLOAD_MAX_BYTES = 300 * MB;
// Explicit TikTok video-document choices get a separate 1 GiB ceiling.
// This does not raise the inline-video limit or other platforms' media caps.
export const TIKTOK_DOCUMENT_MAX_BYTES = 1024 * MB;
const DEFAULT_MIN_FREE_MB = 128;
const KNOWN_TEMP_PREFIXES = [
  "mias-video-",
  "mv23_",
  "mias_",
  "precious_voice_",
  "audio_",
  "audio_out_",
  "conv_",
  "ptt_",
  "trim_",
  "_wm_",
  "stk_",
  "stk2_",
];

function envBytes(name, fallbackMb) {
  const value = Number(process.env[name]);
  const mb = Number.isFinite(value) && value > 0 ? value : fallbackMb;
  return Math.floor(mb * MB);
}

export function getMediaLimitBytes() {
  return envBytes("DOWNLOAD_MAX_MB", DEFAULT_MAX_MEDIA_MB);
}

export function getDiskSpace(target = os.tmpdir()) {
  try {
    const stats = fs.statfsSync(target);
    return {
      freeBytes: Number(stats.bavail) * Number(stats.bsize),
      availableBytes: Number(stats.bavail) * Number(stats.bsize),
      totalBytes: Number(stats.blocks) * Number(stats.bsize),
    };
  } catch {
    // Some older Node/filesystem combinations do not expose statfs. In that
    // case the guard stays fail-open; the actual operation still reports its
    // original error to the user.
    return null;
  }
}

export function cleanupKnownTempFiles({
  directory = os.tmpdir(),
  olderThanMs = 30 * 60 * 1000,
  prefixes = KNOWN_TEMP_PREFIXES,
} = {}) {
  let removed = 0;
  const cutoff = Date.now() - olderThanMs;
  try {
    for (const name of fs.readdirSync(directory)) {
      if (!prefixes.some((prefix) => name.startsWith(prefix))) continue;
      const fullPath = path.join(directory, name);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.mtimeMs < cutoff) {
          fs.rmSync(fullPath, { recursive: true, force: true });
          removed++;
        }
      } catch {
        // A concurrent request may have removed it already.
      }
    }
  } catch {
    // Cleanup is best-effort and must never break a download by itself.
  }
  return removed;
}

export function ensureDiskSpace(requiredBytes = getMediaLimitBytes(), {
  directory = os.tmpdir(),
  minFreeBytes = envBytes("DOWNLOAD_MIN_FREE_MB", DEFAULT_MIN_FREE_MB),
} = {}) {
  cleanupKnownTempFiles({ directory });
  const space = getDiskSpace(directory);
  if (!space) return null;

  // Leave room for the inbound buffer and the outbound upload/encryption
  // copy. This is deliberately conservative for small Railway/PaaS disks.
  const needed = Math.max(0, Number(requiredBytes) || 0) + minFreeBytes;
  if (space.freeBytes < needed) {
    const error = new Error(
      `Not enough temporary storage (${Math.floor(space.freeBytes / MB)} MB free; ` +
      `need about ${Math.ceil(needed / MB)} MB).`
    );
    error.code = "ENOSPC";
    error.availableBytes = space.freeBytes;
    error.requiredBytes = needed;
    throw error;
  }
  return space;
}

export function isNoSpaceError(error) {
  return error?.code === "ENOSPC"
    || /ENOSPC|no space left on device|not enough temporary storage/i.test(String(error?.message || error));
}

export default {
  getMediaLimitBytes,
  getDiskSpace,
  cleanupKnownTempFiles,
  ensureDiskSpace,
  isNoSpaceError,
};