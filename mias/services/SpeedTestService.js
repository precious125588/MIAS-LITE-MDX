/**
 * MIAS — Speed Test Service
 *
 * Runs internet speed tests (download, upload, ping, jitter) and formats
 * the results for WhatsApp. Wraps speedTest.cjs behind the MIAS service
 * layer with queuing, progress reactions, and pretty output.
 *
 * Usage:
 *   import { run, sendSpeedTest } from "./SpeedTestService.js";
 *
 *   const result = await run();
 *   await sendSpeedTest(sock, jid, msg);
 */

import { enqueueBackground } from "./QueueService.js";
import { warn, debug } from "./LoggerService.js";

// ── CJS engine shim ────────────────────────────────────────────────────────────
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const speedTestEngine = require("../lib/engines/speedTest.cjs");

// ── Constants ──────────────────────────────────────────────────────────────────
const DEFAULT_TIMEOUT   = 90_000;   // 90 s total test timeout
const DEFAULT_THREADS   = 4;
const DEFAULT_DL_DUR    = 5_000;    // 5 s download test
const DEFAULT_UL_DUR    = 5_000;    // 5 s upload test
const DEFAULT_SAMPLES   = 5;        // latency ping samples

// ── Helpers ────────────────────────────────────────────────────────────────────

function _bar(value, max, width = 10) {
  const filled = Math.round((Math.min(value, max) / max) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function _ratingEmoji(downloadMbps) {
  if (downloadMbps >= 100) return "🚀";
  if (downloadMbps >= 50)  return "⚡";
  if (downloadMbps >= 20)  return "✅";
  if (downloadMbps >= 5)   return "🟡";
  if (downloadMbps >= 1)   return "🟠";
  return "🔴";
}

function _pingEmoji(pingMs) {
  if (pingMs <= 20)  return "🟢";
  if (pingMs <= 60)  return "🟡";
  if (pingMs <= 120) return "🟠";
  return "🔴";
}

function _ratingLabel(downloadMbps) {
  if (downloadMbps >= 100) return "Excellent 🏆";
  if (downloadMbps >= 50)  return "Very Fast ⚡";
  if (downloadMbps >= 20)  return "Fast ✅";
  if (downloadMbps >= 5)   return "Moderate 🟡";
  if (downloadMbps >= 1)   return "Slow 🟠";
  return "Very Slow 🔴";
}

// ── Core speed test ────────────────────────────────────────────────────────────

/**
 * @typedef {object} SpeedTestResult
 * @property {number}       downloadMbps
 * @property {number}       uploadMbps
 * @property {number}       pingMs
 * @property {number}       jitterMs
 * @property {object|null}  server
 * @property {string|null}  clientIp
 * @property {string|null}  clientIsp
 * @property {number}       elapsedMs
 */

/**
 * Run a full speed test.
 *
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=90000]     - Overall timeout
 * @param {number} [opts.threads=4]           - Download thread count
 * @param {number} [opts.downloadDuration]    - Download phase duration (ms)
 * @param {number} [opts.uploadDuration]      - Upload phase duration (ms)
 * @param {number} [opts.samples=5]           - Latency ping samples
 * @returns {Promise<SpeedTestResult>}
 */
export async function run(opts = {}) {
  debug("[SpeedTest] Starting speed test...");
  const result = await speedTestEngine.runSpeedTest({
    timeoutMs:        opts.timeoutMs        || DEFAULT_TIMEOUT,
    threads:          opts.threads          || DEFAULT_THREADS,
    downloadDuration: opts.downloadDuration || DEFAULT_DL_DUR,
    uploadDuration:   opts.uploadDuration   || DEFAULT_UL_DUR,
    samples:          opts.samples          || DEFAULT_SAMPLES,
    server:           opts.server           || undefined,
  });
  debug(`[SpeedTest] Done — ↓${result.downloadMbps.toFixed(2)} ↑${result.uploadMbps.toFixed(2)} ping ${result.pingMs}ms`);
  return result;
}

// ── Formatting ─────────────────────────────────────────────────────────────────

/**
 * Format a speed test result as a WhatsApp-ready text block.
 *
 * @param {SpeedTestResult} result
 * @param {object} [opts]
 * @param {string} [opts.title]         - Custom header line
 * @param {boolean} [opts.showBars=true] - Show visual progress bars
 * @param {boolean} [opts.showServer=true]
 * @param {boolean} [opts.showIsp=true]
 * @returns {string}
 */
export function format(result, opts = {}) {
  const show = { bars: true, server: true, isp: true, ...opts };
  const dl   = result.downloadMbps.toFixed(2);
  const ul   = result.uploadMbps.toFixed(2);
  const ping = Math.round(result.pingMs);
  const jit  = result.jitterMs ? Math.round(result.jitterMs) : null;
  const time = (result.elapsedMs / 1000).toFixed(1);

  const dlBar   = show.bars ? ` ${_bar(result.downloadMbps,  200)}` : "";
  const ulBar   = show.bars ? ` ${_bar(result.uploadMbps,    100)}` : "";
  const pingBar = show.bars ? ` ${_bar(Math.max(0, 200 - ping), 200)}` : "";

  const lines = [
    opts.title || `${_ratingEmoji(result.downloadMbps)} *Speed Test Results*`,
    "",
    `📥 *Download:* ${dl} Mbps${dlBar}`,
    `📤 *Upload:*   ${ul} Mbps${ulBar}`,
    `🏓 *Ping:*     ${ping} ms${pingBar} ${_pingEmoji(ping)}`,
    ...(jit !== null ? [`📊 *Jitter:*    ${jit} ms`] : []),
    "",
    `🏅 *Rating:* ${_ratingLabel(result.downloadMbps)}`,
  ];

  if (show.isp && result.clientIsp) {
    lines.push(`🌐 *ISP:* ${result.clientIsp}`);
  }
  if (result.clientIp) {
    lines.push(`🔌 *IP:* ${result.clientIp}`);
  }
  if (show.server && result.server) {
    const s = result.server;
    const name = s.name || s.host || s.id || "Unknown";
    const loc  = [s.country, s.cc].filter(Boolean).join(", ");
    lines.push(`📡 *Server:* ${name}${loc ? ` (${loc})` : ""}`);
  }

  lines.push(`⏱️ *Completed in:* ${time}s`);
  return lines.join("\n");
}

/**
 * Format a compact single-line summary.
 * @param {SpeedTestResult} result
 * @returns {string}
 */
export function formatCompact(result) {
  const dl   = result.downloadMbps.toFixed(1);
  const ul   = result.uploadMbps.toFixed(1);
  const ping = Math.round(result.pingMs);
  return `${_ratingEmoji(result.downloadMbps)} ↓${dl} Mbps  ↑${ul} Mbps  🏓${ping}ms`;
}

// ── High-level send helpers ────────────────────────────────────────────────────

/**
 * Run a speed test and send the result to a WhatsApp chat.
 * Sends a "running…" reaction while the test is in progress, then
 * sends the formatted result and a success reaction when done.
 *
 * @param {object} sock
 * @param {string} jid
 * @param {object} [quotedMsg]  - Message to quote
 * @param {object} [opts]
 * @param {string} [opts.title]          - Custom header line
 * @param {boolean} [opts.bars=true]     - Show progress bars
 * @param {boolean} [opts.compact=false] - Send compact one-liner instead
 * @returns {Promise<SpeedTestResult>}
 */
export async function sendSpeedTest(sock, jid, quotedMsg, opts = {}) {
  // Send loading indicator
  await sock.sendMessage(jid, { react: { text: "⏳", key: quotedMsg?.key || { remoteJid: jid, id: "speed-test" } } })
    .catch(() => {});

  let result;
  try {
    result = await run(opts);
  } catch (err) {
    warn(`[SpeedTest] Error: ${err?.message}`);
    // React with failure
    await sock.sendMessage(jid, { react: { text: "❌", key: quotedMsg?.key || { remoteJid: jid, id: "speed-test" } } })
      .catch(() => {});
    const errorMsg = `❌ *Speed test failed*\n${err?.message || "Unknown error"}`;
    await sock.sendMessage(jid, { text: errorMsg, ...(quotedMsg ? { quoted: quotedMsg } : {}) });
    throw err;
  }

  // React success
  await sock.sendMessage(jid, { react: { text: "✅", key: quotedMsg?.key || { remoteJid: jid, id: "speed-test" } } })
    .catch(() => {});

  const text = opts.compact ? formatCompact(result) : format(result, opts);
  await sock.sendMessage(jid, {
    text,
    ...(quotedMsg ? { quoted: quotedMsg } : {}),
  });

  return result;
}

/**
 * Run a quick (shorter duration) speed test.
 * Faster to complete but less accurate.
 * @returns {Promise<SpeedTestResult>}
 */
export async function quickRun() {
  return run({
    threads:          2,
    downloadDuration: 3_000,
    uploadDuration:   3_000,
    samples:          3,
    timeoutMs:        45_000,
  });
}

/**
 * Run a speed test in the background (fire-and-forget).
 * Useful for periodic health checks.
 * @param {Function} [onComplete]  - Called with SpeedTestResult when done
 */
export function runBackground(onComplete) {
  enqueueBackground(async () => {
    try {
      const result = await run();
      if (typeof onComplete === "function") onComplete(null, result);
    } catch (err) {
      warn(`[SpeedTest] Background run failed: ${err?.message}`);
      if (typeof onComplete === "function") onComplete(err, null);
    }
  }).catch(() => {});
}

export default {
  run,
  quickRun,
  runBackground,
  format,
  formatCompact,
  sendSpeedTest,
};
