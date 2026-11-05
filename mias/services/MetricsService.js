/**
 * MIAS — Metrics Service
 *
 * Centralized metrics and performance tracking.
 * Delegates to metricsTracker internally.
 *
 * Architecture: Commands → MetricsService → metricsTracker → stats
 */

import engineRegistryModule from "../lib/engineRegistry.cjs";

// Command usage counters (in-memory)
const _commandUsage  = new Map();  // cmd → count
const _commandErrors = new Map();  // cmd → count
const _apiLatency    = new Map();  // service → [latencies]
const _startupTime   = Date.now();

let _metricsTracker = null;
async function _getTracker() {
  if (_metricsTracker !== null) return _metricsTracker;
  try {
    const m = await import("../lib/metricsTracker.js");
    _metricsTracker = m;
  } catch { _metricsTracker = {}; }
  return _metricsTracker;
}

// ─── Command metrics ──────────────────────────────────────────────────────────

/**
 * Record a command execution.
 * @param {string} cmd
 * @param {number} latencyMs
 */
export async function recordCommand(cmd, latencyMs) {
  _commandUsage.set(cmd, (_commandUsage.get(cmd) || 0) + 1);
  const tracker = await _getTracker();
  if (tracker?.recordCommandLatency) tracker.recordCommandLatency(cmd, latencyMs);
}

/**
 * Record a command error.
 * @param {string} cmd
 */
export function recordCommandError(cmd) {
  _commandErrors.set(cmd, (_commandErrors.get(cmd) || 0) + 1);
}

// ─── API metrics ──────────────────────────────────────────────────────────────

/**
 * Record an API call latency.
 * @param {string} service
 * @param {number} latencyMs
 * @param {boolean} [success=true]
 */
export function recordApiCall(service, latencyMs, success = true) {
  if (!_apiLatency.has(service)) _apiLatency.set(service, []);
  const arr = _apiLatency.get(service);
  arr.push(latencyMs);
  if (arr.length > 100) arr.shift(); // Keep rolling 100
}

// ─── System metrics ───────────────────────────────────────────────────────────

/**
 * Get current memory usage.
 * @returns {object} { rss, heapUsed, heapTotal, external } in MB
 */
export function getMemoryUsage() {
  const m = process.memoryUsage();
  const toMb = (v) => Math.round(v / 1024 / 1024 * 10) / 10;
  return {
    rss:      toMb(m.rss),
    heapUsed: toMb(m.heapUsed),
    heapTotal:toMb(m.heapTotal),
    external: toMb(m.external),
  };
}

/**
 * Get uptime in seconds.
 * @returns {number}
 */
export function getUptime() {
  return Math.round((Date.now() - _startupTime) / 1000);
}

/**
 * Format uptime as a human-readable string.
 * @returns {string}
 */
export function formatUptime() {
  const total = getUptime();
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(" ");
}

// ─── Summary ──────────────────────────────────────────────────────────────────

/**
 * Get a complete metrics summary.
 * @returns {object}
 */
export async function getSummary() {
  const tracker = await _getTracker();
  const pinoMetrics = tracker?.getMetricsSummary ? tracker.getMetricsSummary() : {};

  // Command usage stats
  const topCommands = [..._commandUsage.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([cmd, count]) => ({ cmd, count }));

  // Average API latencies
  const apiStats = {};
  for (const [svc, lats] of _apiLatency.entries()) {
    if (!lats.length) continue;
    apiStats[svc] = {
      avg: Math.round(lats.reduce((a, b) => a + b, 0) / lats.length),
      min: Math.min(...lats),
      max: Math.max(...lats),
      samples: lats.length,
    };
  }

  return {
    uptime:      getUptime(),
    uptimeStr:   formatUptime(),
    memory:      getMemoryUsage(),
    commands: {
      topUsed:   topCommands,
      total:     [..._commandUsage.values()].reduce((a, b) => a + b, 0),
      errors:    [..._commandErrors.values()].reduce((a, b) => a + b, 0),
    },
    api: apiStats,
    ...pinoMetrics,
  };
}

/**
 * Format metrics as a human-readable string for display.
 * @returns {Promise<string>}
 */
export async function formatSummary() {
  const tracker = await _getTracker();
  if (tracker?.formatMetricsSummary) return tracker.formatMetricsSummary();
  const summary = await getSummary();
  return [
    `*MIAS Metrics*`,
    `Uptime: ${summary.uptimeStr}`,
    `RAM: ${summary.memory.heapUsed}MB / ${summary.memory.heapTotal}MB`,
    `Commands run: ${summary.commands.total}`,
    `Errors: ${summary.commands.errors}`,
  ].join("\n");
}

export default { recordCommand, recordCommandError, recordApiCall, getMemoryUsage, getUptime, formatUptime, getSummary, formatSummary };
