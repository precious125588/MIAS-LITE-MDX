/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║           SESSION WATCHDOG — MAIS MDX                           ║
 * ║  Per-session runtime health monitoring & self-healing.          ║
 * ║  Status: Healthy → Warning → Degraded → Broken                 ║
 * ║  Detects silent failures, stuck queues, degraded sockets.       ║
 * ║  Self-heals without global restart or owner intervention.       ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * Integration (done via kevdraPatches.js — no changes to index.js):
 *   startWatchdog(sock, sessionPath, onReconnect)
 *   stopWatchdog()
 *   getWatchdogDiagnostics()
 *   recordCommandStart(name)  → returns id
 *   recordCommandEnd(id, ok)
 */

import os from "os";
import alwaysOnline from "./alwaysOnline.cjs";

// ── Health state constants ─────────────────────────────────────────
export const HEALTH = {
  HEALTHY:  "Healthy",
  WARNING:  "Warning",
  DEGRADED: "Degraded",
  BROKEN:   "Broken",
};

// ── Tuning ─────────────────────────────────────────────────────────
const WATCHDOG_INTERVAL_MS   = 60_000;       // run health check every 60s
const SILENT_WARN_MS         = 5  * 60_000;  // no message activity 5min → warning
const SILENT_DEGRADED_MS     = 12 * 60_000;  // 12min → degraded
const SILENT_BROKEN_MS       = 20 * 60_000;  // 20min → broken (likely zombie socket)
const STUCK_QUEUE_MS         = 45_000;       // command in-flight > 45s → stuck
const MAX_QUEUE_WARN         = 30;           // queue depth warning threshold
const MAX_QUEUE_DEGRADE      = 80;           // queue depth degraded threshold
const HIGH_LATENCY_MS        = 6_000;        // avg latency > 6s → degraded signal
const LATENCY_WINDOW         = 25;           // rolling sample size
const HIGH_FAIL_RATE         = 0.35;         // 35% failure rate → degraded
const MIN_CMDS_FOR_RATE      = 15;           // minimum commands before judging fail rate
const HEAL_COOLDOWN_MS       = 3 * 60_000;   // don't re-heal more than once per 3min
const PROBE_TIMEOUT_MS       = 10_000;       // WhatsApp must answer a server ping within this
const PING_JID              = "@s.whatsapp.net";

// ── Module-level state (one watchdog per child process) ───────────
let _sock             = null;
let _sessionPath      = null;
let _onReconnect      = null;
let _watchTimer       = null;
let _healLock         = false;
let _lastHealMs       = 0;
let _lastProbeMs      = 0;
let _cmdIdSeq         = 0;
let _inFlight         = new Map();   // id → { name, startMs }
let _msgUpsertListener = null;
let _connUpdateListener = null;

const _state = {
  status:          HEALTH.HEALTHY,
  lastMsgReceived: null,
  lastCmdSeen:     null,
  lastCmdSuccess:  null,
  lastCmdFail:     null,
  lastCmdName:     null,
  lastFailName:    null,
  lastLatencyMs:   null,
  latencies:       [],
  queueSize:       0,
  cmdTotal:        0,
  cmdFailed:       0,
  reconnects:      0,
  healAttempts:    0,
  lastHealMs:      null,
  issues:          [],
  lastCloseMs:     null,
};

// ── Command tracking ─────────────────────────────────────────────
/**
 * Call at start of a command handler.
 * Returns an opaque id to pass to recordCommandEnd().
 */
export function recordCommandStart(name) {
  const id = ++_cmdIdSeq;
  _state.lastCmdSeen = Date.now();
  _state.lastCmdName = name || "?";
  _state.cmdTotal++;
  _inFlight.set(id, { name: name || "?", startMs: Date.now() });
  _state.queueSize = _inFlight.size;
  return id;
}

/**
 * Call when a command handler finishes (success or failure).
 */
export function recordCommandEnd(id, success = true) {
  const entry = _inFlight.get(id);
  if (!entry) return;
  const latencyMs = Date.now() - entry.startMs;
  _inFlight.delete(id);
  _state.queueSize = _inFlight.size;
  _state.lastLatencyMs = latencyMs;

  _state.latencies.push(latencyMs);
  if (_state.latencies.length > LATENCY_WINDOW) _state.latencies.shift();

  if (success) {
    _state.lastCmdSuccess = Date.now();
  } else {
    _state.lastCmdFail   = Date.now();
    _state.lastFailName  = entry.name;
    _state.cmdFailed++;
  }
}

/** Called by the messages.upsert observer — marks the session as active. */
export function recordMessageReceived() {
  _state.lastMsgReceived = Date.now();
}

// ── Health scoring ─────────────────────────────────────────────────
function _avgLatency() {
  if (!_state.latencies.length) return null;
  return Math.round(_state.latencies.reduce((a, b) => a + b, 0) / _state.latencies.length);
}

function _computeHealth() {
  const now    = Date.now();
  let score    = 100;
  const issues = [];

  // 1. WebSocket state
  const wsState = _sock?.ws?.readyState;
  if (wsState === 2 || wsState === 3) {        // CLOSING or CLOSED
    score -= 50;
    issues.push(`WS closed (state=${wsState})`);
  } else if (wsState !== 1 && wsState !== 0 && wsState !== undefined) {
    score -= 25;
    issues.push(`WS unusual state (${wsState})`);
  }

  // 2. Message activity silence (only meaningful after first message)
  if (_state.lastMsgReceived) {
    const silenceMs = now - _state.lastMsgReceived;
    if (silenceMs > SILENT_BROKEN_MS) {
      score -= 30;
      issues.push(`Silent ${Math.round(silenceMs / 60000)}min (likely zombie socket)`);
    } else if (silenceMs > SILENT_DEGRADED_MS) {
      score -= 20;
      issues.push(`Silent ${Math.round(silenceMs / 60000)}min (no activity)`);
    } else if (silenceMs > SILENT_WARN_MS) {
      score -= 8;
      issues.push(`Low activity (${Math.round(silenceMs / 60000)}min silence)`);
    }
  }

  // 3. Stuck queue detection
  if (_inFlight.size > 0) {
    let oldestMs = now;
    for (const e of _inFlight.values()) {
      if (e.startMs < oldestMs) oldestMs = e.startMs;
    }
    const stuckMs = now - oldestMs;
    if (stuckMs > STUCK_QUEUE_MS) {
      score -= 25;
      issues.push(`Queue stuck: ${_inFlight.size} in-flight, oldest ${Math.round(stuckMs / 1000)}s`);
    } else if (_inFlight.size > MAX_QUEUE_DEGRADE) {
      score -= 20;
      issues.push(`Queue overloaded: ${_inFlight.size} items`);
    } else if (_inFlight.size > MAX_QUEUE_WARN) {
      score -= 10;
      issues.push(`Queue elevated: ${_inFlight.size} items`);
    }
  }

  // 4. Response latency
  const avgLat = _avgLatency();
  if (avgLat !== null && avgLat > HIGH_LATENCY_MS) {
    score -= 15;
    issues.push(`High avg latency: ${avgLat}ms`);
  }

  // 5. Failure rate
  if (_state.cmdTotal >= MIN_CMDS_FOR_RATE) {
    const rate = _state.cmdFailed / _state.cmdTotal;
    if (rate > HIGH_FAIL_RATE) {
      score -= 20;
      issues.push(`High failure rate: ${Math.round(rate * 100)}%`);
    }
  }

  // Map score → status
  let status;
  if      (score >= 80) status = HEALTH.HEALTHY;
  else if (score >= 60) status = HEALTH.WARNING;
  else if (score >= 35) status = HEALTH.DEGRADED;
  else                  status = HEALTH.BROKEN;

  return { status, score, issues };
}

// ── Liveness probes ────────────────────────────────────────────────
function _alwaysOnlineEnabled() {
  const onlineSetting = globalThis.__MIAS_ALWAYS_ONLINE_ENABLED__;
  return typeof onlineSetting !== "function" || onlineSetting() !== false;
}

function _withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Returns true when WhatsApp answers a ping, false when the socket is closed,
 * unresponsive, or the ping fails, and null when the socket is still connecting
 * (in which case the watchdog must not interfere).
 */
async function _probeSocket(sock) {
  const ws = sock?.ws;
  const readyState = ws?.readyState ?? ws?.socket?.readyState;
  if (ws?.isOpen === false || ws?.isClosing === true || ws?.isClosed === true
    || readyState === 2 || readyState === 3) {
    return false;
  }
  if (readyState !== undefined && readyState !== 1) return null;

  if (typeof sock.query === "function") {
    try {
      await _withTimeout(
        sock.query({ tag: "iq", attrs: { to: PING_JID, type: "get", xmlns: "w:p" }, content: [{ tag: "ping", attrs: {} }] }),
        PROBE_TIMEOUT_MS,
        "Server ping",
      );
      return true;
    } catch (err) {
      console.warn(`[Watchdog] Server ping failed: ${err?.message || err}`);
      return false;
    }
  }

  // Fallback for sockets without query(): presence still proves the socket accepts writes.
  try {
    await alwaysOnline.sendPresenceUpdateWithTimeout(sock, "available", PROBE_TIMEOUT_MS);
    return true;
  } catch {
    return false;
  }
}

function _requestReconnect(reason) {
  if (typeof _onReconnect !== "function") return;
  console.log(`[Watchdog] 🔴 ${reason} — scheduling reconnect`);
  setTimeout(() => {
    try { _onReconnect(reason); } catch {}
  }, 3_000);
}

/** Quiet chats are normal; a long silence only triggers a cheap ping, never a full heal. */
async function _probeOnly() {
  const now = Date.now();
  if (!_sock || _healLock || now - _lastProbeMs < HEAL_COOLDOWN_MS) return;
  _lastProbeMs = now;
  const alive = await _probeSocket(_sock);
  if (alive === false) {
    _requestReconnect("watchdog-silent-zombie");
  } else if (alive === true) {
    console.log("[Watchdog] Silent, but server ping answered — socket is alive");
  }
}

// ── Self-healing ───────────────────────────────────────────────────
async function _selfHeal(reason, status) {
  const now = Date.now();
  if (_healLock) return;
  if (now - _lastHealMs < HEAL_COOLDOWN_MS) return;
  _healLock    = true;
  _lastHealMs  = now;
  _state.healAttempts++;
  _state.lastHealMs = now;

  console.log(`[Watchdog] 🔧 Self-heal: ${reason} (status=${status})`);

  try {
    // ── Step 1: Clear stuck in-flight queue ──────────────────────
    if (_inFlight.size > 0) {
      const stuck = [];
      for (const [id, e] of _inFlight.entries()) {
        if (now - e.startMs > STUCK_QUEUE_MS) {
          _inFlight.delete(id);
          stuck.push(e.name);
        }
      }
      _state.queueSize = _inFlight.size;
      if (stuck.length) console.log(`[Watchdog] Cleared ${stuck.length} stuck commands: ${stuck.slice(0, 5).join(", ")}`);
    }

    // ── Step 2: Refresh group metadata cache ─────────────────────
    if (_sock && typeof _sock.groupFetchAllParticipating === "function") {
      try {
        const groups = await Promise.race([
          _sock.groupFetchAllParticipating(),
          new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 15_000)),
        ]);
        let refreshed = 0;
        for (const [id, meta] of Object.entries(groups || {})) {
          try {
            if (typeof globalThis.__UPDATE_GROUP_META_CACHE__ === "function") {
              globalThis.__UPDATE_GROUP_META_CACHE__(id, meta);
            }
            refreshed++;
          } catch {}
        }
        console.log(`[Watchdog] Group meta refreshed: ${refreshed} groups`);
      } catch (e) {
        console.warn(`[Watchdog] Group meta refresh failed: ${e?.message}`);
      }
    }

    // ── Step 3: Re-sync app-state signal keys ────────────────────
    if (_sock && status !== HEALTH.WARNING) {
      try {
        await Promise.race([
          _sock.fetchAppState?.(["critical_block", "critical_unblock_to_primary"]) ?? Promise.resolve(),
          new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 10_000)),
        ]);
        console.log("[Watchdog] App-state resynced");
      } catch (e) {
        if (!/timeout/i.test(e?.message)) console.warn(`[Watchdog] App-state sync failed: ${e?.message}`);
      }
    }

    // ── Step 4: Server round-trip probe ──────────────────────────
    // A presence send only proves the local socket accepted a write, and a dead
    // but "open" socket accepts writes too. Only a reply from WhatsApp proves
    // the connection is alive, so the ping decides whether to reconnect.
    if (_sock) {
      const alive = await _probeSocket(_sock);
      if (alive === true) {
        if (_state.status === HEALTH.DEGRADED) {
          _state.status = HEALTH.WARNING;
          console.log("[Watchdog] Server ping answered after heal — upgraded to WARNING");
        }
        if (_alwaysOnlineEnabled()) {
          try { await alwaysOnline.sendPresenceUpdateWithTimeout(_sock, "available", 5_000); } catch {}
        }
      } else if (alive === false) {
        _requestReconnect("watchdog-unresponsive-probe");
      }
    }

    // ── Step 6: Force GC if available ────────────────────────────
    try { if (typeof global.gc === "function") global.gc(); } catch {}

  } catch (e) {
    console.error(`[Watchdog] Self-heal error: ${e?.message}`);
  } finally {
    _healLock = false;
  }
}

// ── Watchdog tick ──────────────────────────────────────────────────
async function _tick() {
  try {
    const { status, score, issues } = _computeHealth();
    const prev = _state.status;
    _state.status = status;
    _state.issues = issues;

    if (issues.length > 0) {
      const tag = status === HEALTH.HEALTHY ? "" : ` [${status}]`;
      console.log(`[Watchdog]${tag} score=${score} | ${issues.join(" | ")}`);
    }

    // Heal whenever the session is DEGRADED or BROKEN. _selfHeal enforces the
    // cooldown, so repeated attempts are rate-limited instead of permanently blocked.
    if (status === HEALTH.DEGRADED || status === HEALTH.BROKEN) {
      await _selfHeal(`transition ${prev} → ${status}`, status);
      return;
    }

    if (_state.lastMsgReceived && Date.now() - _state.lastMsgReceived > SILENT_BROKEN_MS) {
      await _probeOnly();
    }
  } catch (e) {
    console.error(`[Watchdog] Tick error: ${e?.message}`);
  }
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Start the watchdog for a Baileys socket.
 * @param {object}   sock          Baileys socket
 * @param {string}   sessionPath   AUTH_DIR for this session
 * @param {Function} onReconnect   called with reason string to trigger reconnect
 */
export function startWatchdog(sock, sessionPath, onReconnect) {
  // Detach listeners from the previous socket before replacing the reference.
  // Assigning _sock first makes stopWatchdog() try to detach from the new socket,
  // leaving observers attached to the old socket after every reconnect.
  stopWatchdog();
  _sock         = sock;
  _sessionPath  = sessionPath;
  _onReconnect  = onReconnect;

  // ── Observe message activity ─────────────────────────────────
  _msgUpsertListener = ({ messages = [] }) => {
    if (messages.length > 0) recordMessageReceived();
  };
  try { sock.ev.on("messages.upsert", _msgUpsertListener); } catch {}

  // ── Observe connection state ─────────────────────────────────
  _connUpdateListener = ({ connection }) => {
    if (connection === "open") {
      _state.reconnects++;
      _state.lastMsgReceived = Date.now();
      // On fresh connect: clear stuck queue and reset to healthy
      _inFlight.clear();
      _state.queueSize = 0;
      if (_state.status === HEALTH.BROKEN || _state.status === HEALTH.DEGRADED) {
        _state.status = HEALTH.HEALTHY;
        _state.issues = [];
      }
    } else if (connection === "close") {
      // Do not pre-set BROKEN here: a socket marked BROKEN before the tick was
      // skipped by the heal check, so a closed socket was never reconnected.
      _state.lastCloseMs = Date.now();
    }
  };
  try { sock.ev.on("connection.update", _connUpdateListener); } catch {}

  // ── Start periodic health check ───────────────────────────────
  _watchTimer = setInterval(_tick, WATCHDOG_INTERVAL_MS);
  if (_watchTimer?.unref) _watchTimer.unref();

  console.log("[Watchdog] Started — health check every 60s");
}

export function stopWatchdog() {
  if (_watchTimer) { clearInterval(_watchTimer); _watchTimer = null; }
  // Remove previously attached listeners to prevent duplication
  try {
    if (_sock && _msgUpsertListener)   _sock.ev.off("messages.upsert",   _msgUpsertListener);
    if (_sock && _connUpdateListener)  _sock.ev.off("connection.update",  _connUpdateListener);
  } catch {}
  _msgUpsertListener  = null;
  _connUpdateListener = null;
}

/** Returns full diagnostics snapshot for .health / .diagnostics commands. */
export function getWatchdogDiagnostics() {
  const now = Date.now();
  const ago = (ts) => ts ? `${Math.round((now - ts) / 1000)}s ago` : "never";
  const { score, issues } = _computeHealth();
  return {
    status:          _state.status,
    healthScore:     score,
    issues:          issues.length ? issues : ["none"],
    socketWsState:   _sock?.ws?.readyState ?? "no socket",
    lastMsgReceived: ago(_state.lastMsgReceived),
    lastCmdSeen:     ago(_state.lastCmdSeen),
    lastCmdSuccess:  ago(_state.lastCmdSuccess),
    lastCmdFail:     ago(_state.lastCmdFail),
    lastCmdName:     _state.lastCmdName   || "none",
    lastFailName:    _state.lastFailName  || "none",
    avgLatencyMs:    _avgLatency()        ?? "n/a",
    lastLatencyMs:   _state.lastLatencyMs ?? "n/a",
    queueSize:       _state.queueSize,
    inFlightNames:   [..._inFlight.values()].map(e => e.name).slice(0, 10),
    cmdTotal:        _state.cmdTotal,
    cmdFailed:       _state.cmdFailed,
    failRate:        _state.cmdTotal > 0
      ? `${Math.round((_state.cmdFailed / _state.cmdTotal) * 100)}%`
      : "n/a",
    reconnects:      _state.reconnects,
    healAttempts:    _state.healAttempts,
    lastHeal:        ago(_state.lastHealMs),
    sessionPath:     _sessionPath || "unknown",
    memRssMB:        Math.round(process.memoryUsage().rss / 1024 / 1024),
    uptimeSec:       Math.round(process.uptime()),
  };
}

/** Force an immediate health check (for .health command). */
export async function forceHealthCheck() {
  const result = _computeHealth();
  _state.status = result.status;
  _state.issues = result.issues;
  return result;
}

/** Test-only hooks; not used by the bot runtime. */
export const _testing = {
  tick: _tick,
  probeOnly: _probeOnly,
  reset() {
    _lastHealMs = 0;
    _lastProbeMs = 0;
    _healLock = false;
    _inFlight.clear();
    _state.status = HEALTH.HEALTHY;
    _state.issues = [];
    _state.lastMsgReceived = null;
  },
  setLastMessageAgo(ms) {
    _state.lastMsgReceived = Date.now() - ms;
  },
};
