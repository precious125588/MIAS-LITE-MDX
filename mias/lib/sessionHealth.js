/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║           SESSION HEALTH SYSTEM — MAIS MDX                     ║
 * ║  Validates auth state, signal stores, creds every 2 hours.     ║
 * ║  Detects corruption, stale sessions, missing keys.             ║
 * ║  Safe repair + controlled reconnect. Never restarts healthy.   ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";

const AUTH_DIR           = process.env.AUTH_DIR || "./auth";
const HEALTH_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 hours
const CHECK_TIMEOUT_MS   = 30 * 1000;

// Per-session lock to prevent concurrent health checks / auth writes
const _sessionLocks = new Map();    // key -> Promise
// Auth write queue per session — prevents race conditions on creds.json
const _authWriteQueue = new Map();  // sessionPath -> queued write count

let _sock             = null;
let _healthTimer      = null;
let _reconnectCount   = 0;
let _badMacCount      = 0;
let _lastHealthCheck  = null;
let _healthResults    = {};

// ── Auth Write Queue ──────────────────────────────────────────────────────────
/**
 * Serialize all writes for a session through a queue so concurrent creds.update
 * events never race each other and corrupt creds.json.
 */
export function createQueuedSaveCreds(sessionPath, saveCreds) {
  let _queue = Promise.resolve();
  return function queuedSaveCreds() {
    _queue = _queue.then(async () => {
      try {
        await saveCreds();
      } catch (e) {
        if (e?.code !== "ENOENT") {
          console.error(
            `[SessionHealth] creds save failed (${path.basename(sessionPath)}):`,
            e.message
          );
        }
      }
    });
    return _queue;
  };
}

// ── Session Lock ──────────────────────────────────────────────────────────────
async function withSessionLock(key, fn) {
  const existing = _sessionLocks.get(key) || Promise.resolve();
  const next = existing.then(() => fn()).catch(() => {});
  _sessionLocks.set(key, next);
  await next;
  if (_sessionLocks.get(key) === next) _sessionLocks.delete(key);
}

// ── Validate creds.json ───────────────────────────────────────────────────────
function validateCredsFile(sessionPath) {
  const credsPath = path.join(sessionPath, "creds.json");
  if (!fs.existsSync(credsPath)) return { ok: false, reason: "creds.json missing" };
  try {
    const raw = fs.readFileSync(credsPath, "utf8");
    if (!raw || !raw.trim()) return { ok: false, reason: "creds.json empty" };
    const creds = JSON.parse(raw);
    if (!creds.me && !creds.registered && !creds.myAppStateKeyId && !creds.signalIdentities) {
      return { ok: false, reason: "creds.json lacks required auth fields" };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `creds.json parse error: ${e.message}` };
  }
}

// ── Validate signal store files ───────────────────────────────────────────────
function validateSignalStore(sessionPath) {
  const required = ["app-state-sync-key", "app-state-sync-version", "sender-key", "session"];
  const missing  = [];
  const corrupt  = [];

  for (const prefix of required) {
    const pattern = new RegExp(`^${prefix}`);
    try {
      const files = fs.readdirSync(sessionPath).filter(f => pattern.test(f));
      if (files.length === 0) {
        if (prefix === "sender-key" || prefix === "session") {
          missing.push(prefix);
        }
        continue;
      }
      const sample = files[0];
      const raw    = fs.readFileSync(path.join(sessionPath, sample), "utf8");
      if (!raw || !raw.trim()) { corrupt.push(sample); continue; }
      JSON.parse(raw);
    } catch (e) {
      if (e.code !== "ENOENT") corrupt.push(prefix);
    }
  }

  if (corrupt.length > 0) return { ok: false, reason: `corrupt stores: ${corrupt.join(", ")}` };
  return { ok: true, missingOptional: missing };
}

// ── Repair: wipe corrupt signal store files only ─────────────────────────────
function repairSignalStore(sessionPath) {
  const storeFiles = ["app-state-sync-key", "app-state-sync-version", "sender-key", "session"];
  let repaired = 0;
  try {
    const files = fs.readdirSync(sessionPath);
    for (const f of files) {
      const isStore = storeFiles.some(s => f.startsWith(s));
      if (!isStore) continue;
      try {
        const raw = fs.readFileSync(path.join(sessionPath, f), "utf8");
        if (!raw || !raw.trim()) {
          fs.unlinkSync(path.join(sessionPath, f));
          repaired++;
        } else {
          JSON.parse(raw);
        }
      } catch {
        try { fs.unlinkSync(path.join(sessionPath, f)); repaired++; } catch {}
      }
    }
  } catch {}
  return repaired;
}

// ── Rebuild in-memory caches after Bad MAC ────────────────────────────────────
export async function rebuildCachesAfterBadMac(sock, sessionPath) {
  _badMacCount++;
  console.log(`[SessionHealth] Bad MAC detected — rebuilding caches (total: ${_badMacCount})`);
  try {
    if (typeof sock?.keys?.reload === "function") {
      await sock.keys.reload();
    }
    if (typeof sock?.fetchAppState === "function") {
      await sock.fetchAppState(["critical_block", "critical_unblock_to_primary"]).catch(() => {});
    }
    console.log("[SessionHealth] Cache rebuild complete");
    return true;
  } catch (e) {
    console.error("[SessionHealth] Cache rebuild failed:", e.message);
    return false;
  }
}

// ── Full session health check ─────────────────────────────────────────────────
export async function runSessionHealthCheck(sessionPath) {
  const label  = path.basename(sessionPath);
  const result = { label, time: new Date().toISOString(), ok: true, warnings: [], actions: [] };

  // 1. Validate creds.json
  const credsCheck = validateCredsFile(sessionPath);
  if (!credsCheck.ok) {
    result.ok = false;
    result.warnings.push(credsCheck.reason);
    result.actions.push("creds_missing");
  }

  // 2. Validate signal stores
  const storeCheck = validateSignalStore(sessionPath);
  if (!storeCheck.ok) {
    result.warnings.push(storeCheck.reason);
    result.actions.push("repair_signal_store");
    const repaired = repairSignalStore(sessionPath);
    if (repaired > 0) {
      result.actions.push(`repaired_${repaired}_files`);
      console.log(`[SessionHealth] Repaired ${repaired} corrupt signal store files for ${label}`);
    }
  }

  if (storeCheck.missingOptional?.length) {
    result.warnings.push(`optional stores missing: ${storeCheck.missingOptional.join(", ")}`);
  }

  // 3. Check session freshness (creds.json mtime)
  try {
    const credsPath = path.join(sessionPath, "creds.json");
    const stat      = fs.statSync(credsPath);
    const ageHours  = (Date.now() - stat.mtimeMs) / 3600000;
    if (ageHours > 72) {
      result.warnings.push(`stale session: creds last updated ${Math.round(ageHours)}h ago`);
    }
  } catch {}

  _healthResults[label] = result;
  _lastHealthCheck = Date.now();
  return result;
}

// ── Start periodic health check ───────────────────────────────────────────────
export function startSessionHealthMonitor(sessionPath, onRepairNeeded) {
  if (_healthTimer) { clearInterval(_healthTimer); }
  _healthTimer = setInterval(async () => {
    await withSessionLock(sessionPath, async () => {
      const result = await runSessionHealthCheck(sessionPath);
      if (!result.ok && typeof onRepairNeeded === "function") {
        await onRepairNeeded(result);
      }
    });
  }, HEALTH_INTERVAL_MS);

  if (_healthTimer.unref) _healthTimer.unref();
  console.log(`[SessionHealth] Monitor started (check every 2h) for ${path.basename(sessionPath)}`);
}

export function stopSessionHealthMonitor() {
  if (_healthTimer) { clearInterval(_healthTimer); _healthTimer = null; }
}

// ── Counters ──────────────────────────────────────────────────────────────────
export function recordReconnect() { _reconnectCount++; }
export function recordBadMac()    { _badMacCount++;    }

// ── Health summary (raw data) ─────────────────────────────────────────────────
export function getHealthSummary() {
  return {
    lastCheck:      _lastHealthCheck ? new Date(_lastHealthCheck).toLocaleString() : "never",
    results:        _healthResults,
    reconnectCount: _reconnectCount,
    badMacCount:    _badMacCount,
    uptime:         process.uptime(),
    memory:         process.memoryUsage(),
  };
}

// ── Formatted health report (for .health bot command) ────────────────────────
export function formatHealthReport() {
  const summary   = getHealthSummary();
  const memMB     = Math.round((summary.memory?.rss ?? 0) / 1048576);
  const heapUsed  = Math.round((summary.memory?.heapUsed ?? 0) / 1048576);
  const heapTotal = Math.round((summary.memory?.heapTotal ?? 0) / 1048576);
  const heapPct   = heapTotal > 0 ? Math.round((heapUsed / heapTotal) * 100) : 0;
  const uptimeH   = Math.round(summary.uptime / 3600 * 10) / 10;
  const memStatus = heapPct < 70 ? "🟢" : heapPct < 85 ? "🟡" : "🔴";

  const resultLines = Object.values(summary.results).map(r => {
    const icon = r.ok ? "✅" : "❌";
    const warn = r.warnings.length ? ` — ${r.warnings.join(", ")}` : "";
    return `  ${icon} ${r.label}${warn}`;
  });

  // Attach watchdog diagnostics if available
  let watchdogBlock = "";
  try {
    if (typeof globalThis.__WATCHDOG_DIAGNOSTICS__ === "function") {
      const d = globalThis.__WATCHDOG_DIAGNOSTICS__();
      const statusIcon = {
        Healthy: "🟢", Warning: "🟡", Degraded: "🟠", Broken: "🔴",
      }[d.status] ?? "⚪";
      const issues = (d.issues ?? []).filter(i => i !== "none").join(", ") || "none";
      watchdogBlock =
        `\n\n🔍 *Runtime Watchdog*\n` +
        `  ${statusIcon} Status: ${d.status} (score ${d.healthScore})\n` +
        `  📥 Last message: ${d.lastMsgReceived}\n` +
        `  ⚡ Avg latency: ${d.avgLatencyMs ?? "n/a"}ms\n` +
        `  📋 Queue: ${d.queueSize} items\n` +
        `  🔧 Heals: ${d.healAttempts} | Issues: ${issues}`;
    }
  } catch {}

  return (
    `🏥 *SESSION HEALTH — MAIS MDX*\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `⏱ Uptime: ${uptimeH}h\n` +
    `${memStatus} RAM: ${memMB}MB RSS | Heap: ${heapUsed}/${heapTotal}MB (${heapPct}%)\n` +
    `🔌 Reconnects: ${summary.reconnectCount}\n` +
    `🔐 Bad MAC events: ${summary.badMacCount}\n` +
    `🕒 Last file-health check: ${summary.lastCheck}\n` +
    (resultLines.length
      ? `\n📁 *Session files:*\n${resultLines.join("\n")}`
      : "\n📁 *Session files:* not yet checked") +
    watchdogBlock
  );
}
