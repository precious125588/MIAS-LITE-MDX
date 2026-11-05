/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║           METRICS TRACKER — MAIS MDX                            ║
 * ║  Long-term RAM/CPU/reconnect/failure trend tracking.            ║
 * ║  24h rolling window, 5-min samples, automatic trend detection.  ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

import os from "os";
import { getHeapStatistics } from "node:v8";

// ── Config ──────────────────────────────────────────────────────────
const SAMPLE_INTERVAL_MS = 5 * 60_000;  // sample every 5 minutes
const MAX_SAMPLES        = 288;          // 24 hours @ 5-min intervals
const TREND_WINDOW       = 12;           // last 12 samples (1 hour) for trend
const HEAP_LEAK_DELTA    = 20;           // heap grew >20pct in TREND_WINDOW → leak warning
const HEAP_CRIT_PCT      = 85;           // heap at 85%+ → critical warning

// ── State ────────────────────────────────────────────────────────────
const _samples           = [];
let   _metricsTimer      = null;
const _start             = Date.now();

// Counters (accumulated across the process lifetime)
let _reconnectTotal      = 0;
let _sessionFailures     = 0;
let _cmdLatencyTotal     = 0;
let _cmdLatencyCount     = 0;
let _badMacCount         = 0;
let _authFailCount       = 0;

// ── Sampling ─────────────────────────────────────────────────────────
export function calculateHeapUsage(mem, heapLimitBytes) {
  const limit = Number(heapLimitBytes);
  const used = Number(mem && mem.heapUsed);
  if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(used) || used < 0) {
    throw new TypeError("Valid heapUsed and heap limit values are required");
  }
  return {
    heapPct: Math.min(100, Math.round((used / limit) * 100)),
    heapLimitMB: Math.round(limit / 1048576),
  };
}

function _takeSample() {
  try {
    const mem   = process.memoryUsage();
    const heapStats = getHeapStatistics();
    const heapUsage = calculateHeapUsage(mem, heapStats.heap_size_limit);
    const heapPct = heapUsage.heapPct;
    const sample = {
      ts:          Date.now(),
      rssMB:       Math.round(mem.rss  / 1048576),
      heapUsedMB:  Math.round(mem.heapUsed / 1048576),
      heapTotalMB: Math.round(mem.heapTotal / 1048576),
      heapLimitMB: heapUsage.heapLimitMB,
      heapPct,
      sysFreeMB:   Math.round(os.freemem() / 1048576),
      reconnects:  _reconnectTotal,
      failures:    _sessionFailures,
      badMac:      _badMacCount,
      authFails:   _authFailCount,
      avgLatMs:    _cmdLatencyCount > 0
        ? Math.round(_cmdLatencyTotal / _cmdLatencyCount)
        : null,
    };
    _samples.push(sample);
    if (_samples.length > MAX_SAMPLES) _samples.splice(0, _samples.length - MAX_SAMPLES);

    // ── Trend detection ──────────────────────────────────────────
    if (_samples.length >= TREND_WINDOW) {
      const window = _samples.slice(-TREND_WINDOW);
      const firstHeap = window[0].heapPct;
      const lastHeap  = window[window.length - 1].heapPct;

      if (lastHeap >= HEAP_CRIT_PCT) {
        console.warn(
          `[Metrics] 🔴 CRITICAL: heap at ${lastHeap}% — ` +
          `RSS=${sample.rssMB}MB, heapLimit=${sample.heapLimitMB}MB, free=${sample.sysFreeMB}MB`
        );
        // Nudge GC if available
        try { if (typeof global.gc === "function") global.gc(); } catch {}

      } else if (lastHeap - firstHeap > HEAP_LEAK_DELTA && lastHeap > 60) {
        console.warn(
          `[Metrics] ⚠️ Memory trend: heap ${firstHeap}% → ${lastHeap}% ` +
          `over last ${Math.round(TREND_WINDOW * SAMPLE_INTERVAL_MS / 60000)}min — possible leak`
        );
      }
    }

    return sample;
  } catch (e) {
    console.error(`[Metrics] Sample error: ${e?.message}`);
    return null;
  }
}

// ── Record helpers ────────────────────────────────────────────────
export function recordReconnect()          { _reconnectTotal++; }
export function recordSessionFailure()     { _sessionFailures++; }
export function recordBadMac()             { _badMacCount++; }
export function recordAuthFail()           { _authFailCount++; }
export function recordCommandLatency(ms) {
  if (typeof ms === "number" && ms >= 0 && isFinite(ms)) {
    _cmdLatencyTotal += ms;
    _cmdLatencyCount++;
  }
}

// ── Lifecycle ──────────────────────────────────────────────────────
export function startMetricsTracker() {
  if (_metricsTimer) clearInterval(_metricsTimer);
  _takeSample(); // immediate first sample
  _metricsTimer = setInterval(_takeSample, SAMPLE_INTERVAL_MS);
  if (_metricsTimer?.unref) _metricsTimer.unref();
  console.log(`[Metrics] Tracker started — sampling every ${SAMPLE_INTERVAL_MS / 60000}min`);
}

export function stopMetricsTracker() {
  if (_metricsTimer) { clearInterval(_metricsTimer); _metricsTimer = null; }
}

// ── Summary ────────────────────────────────────────────────────────
export function getMetricsSummary() {
  const now     = Date.now();
  const uptimeH = Math.round((now - _start) / 3_600_000 * 10) / 10;
  const latest  = _samples[_samples.length - 1] ?? {};

  // Compute trend label
  let memTrend = "stable";
  if (_samples.length >= 6) {
    const w      = _samples.slice(-Math.min(24, _samples.length)); // last 2h
    const first  = w[0].heapPct;
    const last   = w[w.length - 1].heapPct;
    const delta  = last - first;
    if      (delta >  20) memTrend = "🔴 growing fast";
    else if (delta >   8) memTrend = "🟡 rising";
    else if (delta < -10) memTrend = "🟢 dropping";
    else                  memTrend = "🟢 stable";
  }

  // Reconnect rate (per hour over uptime)
  const uptimeFull = Math.max((now - _start) / 3_600_000, 0.01);
  const reconnectRate = Math.round((_reconnectTotal / uptimeFull) * 10) / 10;

  // Peak heap
  const peakHeapPct = _samples.length
    ? Math.max(..._samples.map(s => s.heapPct))
    : 0;

  return {
    uptimeHours:     uptimeH,
    currentRssMB:    latest.rssMB    ?? 0,
    currentHeapPct:  latest.heapPct  ?? 0,
    peakHeapPct,
    sysFreeMB:       latest.sysFreeMB ?? 0,
    memTrend,
    reconnectTotal:  _reconnectTotal,
    reconnectPerHr:  reconnectRate,
    sessionFailures: _sessionFailures,
    badMacCount:     _badMacCount,
    authFailCount:   _authFailCount,
    avgLatencyMs:    _cmdLatencyCount > 0
      ? Math.round(_cmdLatencyTotal / _cmdLatencyCount)
      : null,
    sampleCount:     _samples.length,
    recentSamples:   _samples.slice(-12),  // last hour
  };
}

/** Formatted text summary for the .metrics bot command. */
export function formatMetricsSummary() {
  const s = getMetricsSummary();
  const lat = s.avgLatencyMs !== null ? `${s.avgLatencyMs}ms` : "n/a";
  return (
    `📊 *METRICS — MAIS MDX*\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `⏱ Uptime: ${s.uptimeHours}h\n` +
    `🧠 RAM: ${s.currentRssMB}MB RSS | Heap: ${s.currentHeapPct}% (peak ${s.peakHeapPct}%)\n` +
    `📈 Mem trend: ${s.memTrend}\n` +
    `🔌 Reconnects: ${s.reconnectTotal} (${s.reconnectPerHr}/hr)\n` +
    `❌ Session failures: ${s.sessionFailures}\n` +
    `🔐 Bad MAC events: ${s.badMacCount}\n` +
    `⚡ Avg cmd latency: ${lat}\n` +
    `📦 Samples collected: ${s.sampleCount}`
  );
}
