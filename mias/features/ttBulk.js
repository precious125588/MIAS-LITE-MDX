// Bulk TikTok downloads for `.tt url1,url2,...`.
// One provider request per link, the exact format asked for, streamed to disk
// (never held in memory), and a clear reason for every link that fails.
// Each temporary file is removed after its link is delivered or has failed.
import { fetchTikTokInfo, selectTikTokUrl, parseTikTokMode } from "./tiktok.js";

export const BULK_MAX_LINKS = 10;

// The format id for a batch. Defaults to HD video (1.3) when no format is given.
export function bulkModeId(ttMode) {
  return parseTikTokMode(ttMode)?.id || "1.3";
}

// Resolves one link to a file on disk. `deps.fetchToDisk(url, { kind })` must
// return { path, bytes, mimetype, cleanup }. Throws a readable reason on failure.
export async function downloadTikTokMedia(url, modeId, deps = {}) {
  const mode = parseTikTokMode(modeId);
  if (!mode) throw new Error(`Unknown format ${modeId}`);
  if (mode.kind === "slider") throw new Error("Slider photos are not supported in a batch; send one link instead");
  if (typeof deps.fetchToDisk !== "function") throw new Error("Bulk download needs the disk media pipeline");

  const fetchImpl = deps.fetchImpl || fetch;
  const info = await fetchTikTokInfo(url, fetchImpl); // one provider request
  const mediaUrl = selectTikTokUrl(info, mode);
  if (!mediaUrl) throw new Error(`No ${mode.kind} file is available in format ${mode.id}`);

  const kind = mode.kind === "audio" ? "audio" : "video";
  const file = await deps.fetchToDisk(mediaUrl, { kind });
  return { file, mode };
}

// Processes each link in order. `send` receives { file, mode, index, total, url }.
export async function runTikTokBulk({ urls, modeId, send, deps = {} }) {
  const unique = [...new Set(urls)];
  const list = unique.slice(0, BULK_MAX_LINKS);
  const skipped = unique.length - list.length;
  const failures = [];
  let sent = 0;

  for (let i = 0; i < list.length; i++) {
    const url = list[i];
    let item = null;
    try {
      item = await downloadTikTokMedia(url, modeId, deps);
      await send({ file: item.file, mode: item.mode, index: i + 1, total: list.length, url });
      sent++;
    } catch (error) {
      failures.push({ index: i + 1, url, reason: error?.message || String(error) });
    } finally {
      if (item?.file && typeof item.file.cleanup === "function") {
        await item.file.cleanup().catch(() => {});
      }
    }
    if (i < list.length - 1) await new Promise((resolve) => setTimeout(resolve, 1200));
  }

  return { sent, failed: failures.length, failures, skipped, total: list.length };
}

export function formatBulkSummary(result) {
  const lines = [`🎵 *Batch done!*  ✅ ${result.sent} sent  ❌ ${result.failed} failed`];
  for (const f of result.failures.slice(0, 10)) lines.push(`#${f.index}: ${f.reason}`);
  if (result.skipped > 0) {
    lines.push(`Only the first ${BULK_MAX_LINKS} links were processed (${result.skipped} skipped).`);
  }
  return lines.join("\n");
}
