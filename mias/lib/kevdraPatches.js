import { releaseBufferOnOpen } from "./startupBufferRelease.mjs";
import { throttleGroupFetch } from "./groupFetchThrottle.mjs";
/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║        KEVDRA PATCHES — MAIS MDX Integration Layer             ║
 * ║  Import this file from mias/index.js to activate all systems:  ║
 * ║    • Session health monitoring (file-level, 2h)                 ║
 * ║    • Session watchdog (runtime, 60s — Healthy/Warning/          ║
 * ║        Degraded/Broken + self-heal)                             ║
 * ║    • Metrics tracker (RAM/CPU/reconnect trends, 5min)           ║
 * ║    • Resource manager (memory leak prevention)                  ║
 * ║    • Listener dedup fix (auto-removes excess listeners)         ║
 * ║    • Interval registry (prevents duplicate setInterval leak)    ║
 * ║    • Sticker setcmd (persistent sticker→command)               ║
 * ║    • Auto-downloader (TikTok/YT/IG/FB/Twitter auto-dl)         ║
 * ║    • Status → newsletter forwarder                              ║
 * ║    • Force Private Mode                                         ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * Usage in mias/index.js (add near the top imports):
 *   import { initKevdraPatches, applyKevdraToSock, kevdraMessageHook } from './lib/kevdraPatches.js';
 *   // After creating sock:
 *   await applyKevdraToSock(sock, sessionPath);
 *   // In messages.upsert, early return if kevdraMessageHook returns true:
 *   if (await kevdraMessageHook(sock, msg, body, isOwner)) return;
 */

import path from "path";
import { fileURLToPath } from "url";
import {
  runSessionHealthCheck,
  startSessionHealthMonitor,
  createQueuedSaveCreds,
  rebuildCachesAfterBadMac,
  recordReconnect      as _shRecordReconnect,
  recordBadMac         as _shRecordBadMac,
  getHealthSummary,
  formatHealthReport,
} from "./sessionHealth.js";
import {
  startResourceManager,
  runCleanup,
  getMemoryHealth,
  trackCache,
  auditListeners,
  registerInterval,
  clearRegisteredInterval,
  getIntervalRegistry,
} from "./resourceManager.js";
import {
  runStartupSelfTest,
} from "./startupSelfTest.js";
import {
  getStickerHash,
  setCmd as stickerSetCmd,
  delCmd as stickerDelCmd,
  getCmd as stickerGetCmd,
  listCmds as stickerListCmds,
  cmdCount as stickerCmdCount,
} from "./stickerCmd.js";
import {
  handleAutoDownload, resumeAutoDownloads,
  detectPlatform,
  extractUrl,
} from "./autoDownloader.js";
import {
  forwardStatus,
  setDestination as setStatusDest,
  setEnabled as setStatusFwdEnabled,
  getConfig as getStatusFwdConfig,
} from "./statusForwarder.js";
import {
  startWatchdog,
  stopWatchdog,
  recordCommandStart,
  recordCommandEnd,
  recordMessageReceived,
  getWatchdogDiagnostics,
  forceHealthCheck,
  HEALTH,
} from "./sessionWatchdog.js";
import {
  startMetricsTracker,
  stopMetricsTracker,
  recordReconnect      as _mtRecordReconnect,
  recordSessionFailure as _mtRecordFailure,
  recordBadMac         as _mtRecordBadMac,
  recordAuthFail       as _mtRecordAuthFail,
  recordCommandLatency as _mtRecordLatency,
  getMetricsSummary,
  formatMetricsSummary,
} from "./metricsTracker.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let _initialized = false;
let _sock = null;
let _sessionPath = null;

// ── Settings helpers (loaded lazily) ─────────────────────────────────────────
function _getSetting(jid, key, def) {
  try { return globalThis.__GET_SETTING__?.(jid, key, def) ?? def; } catch { return def; }
}
function _setSetting(jid, key, val) {
  try { globalThis.__SET_SETTING__?.(jid, key, val); } catch {}
}
function _getOwnerJid() {
  try {
    const ownerNum = process.env.OWNER_NUMBER || "";
    const num = ownerNum.replace(/[^0-9]/g, "");
    return num ? `${num}@s.whatsapp.net` : null;
  } catch { return null; }
}

function _resolveOwnerJid() {
  try {
    if (globalThis.__BOT_OWNER_JID) return globalThis.__BOT_OWNER_JID;
    const gn = (globalThis.__PRECIOUS__?.CONFIG?.OWNER_NUMBER || "").replace(/[^0-9]/g, "");
    if (gn) return gn + "@s.whatsapp.net";
    const cn = (globalThis.__BOT_OWNER_NUMBER || "").replace(/[^0-9]/g, "");
    if (cn) return cn + "@s.whatsapp.net";
    const n = (process.env.OWNER_NUMBER || "").replace(/[^0-9]/g, "");
    if (n) return n + "@s.whatsapp.net";
  } catch {}
  return null;
}

function _resolveForcePrivate() {
  try {
    if (typeof globalThis.__MIAS_GET_SETTINGS__ === "function") {
      const oj = _resolveOwnerJid();
      if (oj) {
        const os = globalThis.__MIAS_GET_SETTINGS__(oj);
        if (os?.forcePrivate !== undefined) return !!os.forcePrivate;
      }
      const bs = globalThis.__MIAS_GET_SETTINGS__("bot");
      if (bs?.forcePrivate !== undefined) return !!bs.forcePrivate;
    }
    if (typeof globalThis.__GET_SETTING__ === "function") {
      return !!globalThis.__GET_SETTING__("bot", "setting_19_1_forcePrivate", false);
    }
  } catch {}
  return false;
}

function _readMiasSetting(key, def) {
  try {
    if (typeof globalThis.__MIAS_GET_SETTINGS__ !== "function") return def;
    const oj = _resolveOwnerJid();
    if (oj) {
      const os = globalThis.__MIAS_GET_SETTINGS__(oj);
      if (os && os[key] !== undefined && os[key] !== null) return os[key];
    }
    const bs = globalThis.__MIAS_GET_SETTINGS__("bot");
    if (bs && bs[key] !== undefined && bs[key] !== null) return bs[key];
  } catch {}
  return def;
}

// ── Expose globalThis hooks ───────────────────────────────────────────────────
function _exposeGlobals() {
  // ── Existing session-health globals ─────────────────────────────
  globalThis.__SESSION_HEALTH_SUMMARY__       = getHealthSummary;
  globalThis.__SESSION_HEALTH_REPORT__        = formatHealthReport;
  globalThis.__RUN_SESSION_HEALTH_CHECK__     = () =>
    _sessionPath ? runSessionHealthCheck(_sessionPath) : null;
  globalThis.__RESOURCE_CLEANUP__             = runCleanup;
  globalThis.__MEMORY_HEALTH__                = getMemoryHealth;
  globalThis.__REBUILD_CACHES__               = () =>
    _sock && _sessionPath
      ? rebuildCachesAfterBadMac(_sock, _sessionPath)
      : Promise.resolve(false);

  // ── Sticker setcmd globals ───────────────────────────────────────
  globalThis.__STICKER_SETCMD__               = stickerSetCmd;
  globalThis.__STICKER_DELCMD__               = stickerDelCmd;
  globalThis.__STICKER_GETCMD__               = stickerGetCmd;
  globalThis.__STICKER_LISTCMDS__             = stickerListCmds;

  // ── Status forwarder globals ─────────────────────────────────────
  globalThis.__STATUS_FWD_SET_DEST__          = setStatusDest;
  globalThis.__STATUS_FWD_SET_ENABLED__       = setStatusFwdEnabled;
  globalThis.__STATUS_FWD_GET_CONFIG__        = getStatusFwdConfig;

  // ── NEW: Session watchdog globals ───────────────────────────────
  globalThis.__WATCHDOG_DIAGNOSTICS__         = getWatchdogDiagnostics;
  globalThis.__FORCE_HEALTH_CHECK__           = forceHealthCheck;
  globalThis.__WATCHDOG_STATUS__              = () => getWatchdogDiagnostics().status;

  // Command tracking hooks — mias/index.js can optionally call these
  // around command execution to get latency + queue health metrics.
  globalThis.__RECORD_CMD_START__             = recordCommandStart;
  globalThis.__RECORD_CMD_END__               = recordCommandEnd;

  // ── NEW: Metrics tracker globals ────────────────────────────────
  globalThis.__METRICS_SUMMARY__              = getMetricsSummary;
  globalThis.__METRICS_TEXT__                 = formatMetricsSummary;
  globalThis.__RECORD_CMD_LATENCY__           = _mtRecordLatency;

  // ── Interval registry ────────────────────────────────────────────
  globalThis.__REGISTER_INTERVAL__            = registerInterval;
  globalThis.__CLEAR_INTERVAL__               = clearRegisteredInterval;
  globalThis.__INTERVAL_REGISTRY__            = getIntervalRegistry;
}

// ── Helper: isStatusForwarderEnabled ─────────────────────────────────────────
function isStatusForwarderEnabled() {
  try {
    const oj = _resolveOwnerJid();
    if (oj && typeof globalThis.__MIAS_GET_SETTINGS__ === "function") {
      const os = globalThis.__MIAS_GET_SETTINGS__(oj);
      if (os && os.statusForwarder !== undefined) return !!os.statusForwarder;
    }
    if (typeof globalThis.__MIAS_GET_SETTINGS__ === "function") {
      const bs = globalThis.__MIAS_GET_SETTINGS__("bot");
      if (bs && bs.statusForwarder !== undefined) return !!bs.statusForwarder;
    }
    if (typeof globalThis.__GET_SETTING__ === "function") {
      return globalThis.__GET_SETTING__("bot", "setting_19_3_statusFwdEnabled", false);
    }
  } catch {}
  return false;
}

function getStatusFwdDestLocal() {
  try {
    if (typeof globalThis.__GET_SETTING__ === "function") {
      return globalThis.__GET_SETTING__("bot", "setting_19_3_statusFwdDest", null);
    }
  } catch {}
  return null;
}

// ── Init: run once on startup ─────────────────────────────────────────────────
export async function initKevdraPatches(sessionPath, dbDir) {
  if (_initialized) return;
  _initialized = true;
  _sessionPath = sessionPath;

  console.log("[KevdraPatches] Initializing stability systems...");

  // 1. Startup self-test
  try {
    await runStartupSelfTest(sessionPath, dbDir);
  } catch (e) {
    console.error("[KevdraPatches] Startup self-test error:", e.message);
  }

  // 2. Resource manager (cache cleanup + listener audit)
  try {
    startResourceManager();
  } catch (e) {
    console.error("[KevdraPatches] Resource manager error:", e.message);
  }

  // 3. Metrics tracker (long-term RAM/CPU/reconnect trends)
  try {
    startMetricsTracker();
  } catch (e) {
    console.error("[KevdraPatches] Metrics tracker error:", e.message);
  }

  // 4. Expose globalThis hooks
  _exposeGlobals();

  console.log("[KevdraPatches] ✅ All stability systems initialized");
}

// ── Attach to a Baileys socket (call after makeWASocket) ──────────────────────
export async function applyKevdraToSock(sock, sessionPath, saveCreds) {
  // One group-list download per TTL instead of one per caller (see groupFetchThrottle.mjs)
  try { throttleGroupFetch(sock); } catch (e) { console.warn("[KevdraPatches] group fetch throttle skipped:", e.message); }
  resumeAutoDownloads(sock);
  _sock = sock;
  if (sessionPath) _sessionPath = sessionPath;

  // 5. Wrap saveCreds with write queue (prevents auth race conditions)
  const queuedSave = saveCreds ? createQueuedSaveCreds(sessionPath, saveCreds) : null;

  // 6. Start session health monitor (file-level checks every 2h)
  try {
    startSessionHealthMonitor(sessionPath, async (result) => {
      console.warn("[KevdraPatches] Session health issue detected:", result.warnings.join(", "));
    });
  } catch (e) {
    console.error("[KevdraPatches] Health monitor error:", e.message);
  }

  // 7. Start runtime session watchdog (health score + self-heal every 60s)
  try {
    startWatchdog(sock, sessionPath, (reason) => {
      // Watchdog requests reconnect on BROKEN session
      console.warn(`[KevdraPatches] Watchdog reconnect requested: ${reason}`);
      try {
        if (typeof globalThis.__SCHEDULE_RECONNECT__ === "function") {
          globalThis.__SCHEDULE_RECONNECT__(reason, 3000);
        } else if (typeof globalThis.scheduleReconnect === "function") {
          globalThis.scheduleReconnect(reason, 3000);
        }
      } catch {}
    });
  } catch (e) {
    console.error("[KevdraPatches] Watchdog start error:", e.message);
  }

  // 8. Audit listener counts only. Event order does not reveal ownership, so
  // arbitrary removal could silently detach essential Baileys/app handlers.
  try { auditListeners(sock.ev, "sock.ev", 20); } catch {}

  // 9. Track socket store caches for cleanup
  try {
    if (sock.store?.messages instanceof Map) trackCache(sock.store.messages, "store.messages");
    if (sock.store?.contacts instanceof Map) trackCache(sock.store.contacts, "store.contacts");
  } catch {}

  // 10a. Release Baileys' startup event buffer as soon as the connection opens
  try { releaseBufferOnOpen(sock); } catch {}

  // 10. creds.update → queued save
  if (queuedSave) {
    try { sock.ev.on("creds.update", queuedSave); } catch {}
  }

  // 11. connection.update → reconnect + Bad MAC counters + metrics
  try {
    sock.ev.on("connection.update", ({ connection, lastDisconnect }) => {
      if (connection === "open") {
        _shRecordReconnect();
        _mtRecordReconnect();
      }
      const errMsg = String(lastDisconnect?.error?.message || lastDisconnect?.error || "");
      if (/bad mac|bad_mac|BadMAC/i.test(errMsg)) {
        _shRecordBadMac();
        _mtRecordBadMac();
        rebuildCachesAfterBadMac(sock, sessionPath).catch(() => {});
      }
      if (/401|logout|loggedOut|logged_out/i.test(errMsg)) {
        _mtRecordAuthFail();
      }
    });
  } catch {}

  // 12. Re-expose globals (includes watchdog + metrics references)
  _exposeGlobals();

  return queuedSave;
}

// ── Message hook: call from messages.upsert BEFORE main cmd handler ───────────
/**
 * Returns true if the message was handled (caller should return/skip main handler).
 * Returns false if the message should continue to the main handler.
 */
export async function kevdraMessageHook(sock, msg, body, isOwner) {
  const remoteJid = msg?.key?.remoteJid;
  if (!remoteJid) return false;
  if (sock?.user?.id) resumeAutoDownloads(sock);

  // Record message activity for watchdog silent-failure detector
  try { recordMessageReceived(); } catch {}

  // ── Drop WhatsApp system stub notifications ─────────────────────────────────
  if (msg?.messageStubType !== undefined && msg?.messageStubType !== null) {
    return true;
  }
  if (msg?.message) {
    const msgKeys = Object.keys(msg.message).filter(k => k !== "messageContextInfo");
    if (msgKeys.length === 1 && msgKeys[0] === "protocolMessage") return true;
  }

  const isGroup = String(remoteJid).endsWith("@g.us");

  // ── Force Private Mode (non-command messages) ───────────────────────────────
  try {
    if (_resolveForcePrivate() && isGroup && !isOwner) {
      return true;
    }
  } catch {}

  // ── Sticker SetCmd detection ────────────────────────────────────────────────
  const msgContent = msg?.message;
  if (msgContent) {
    const stickerMsg = msgContent?.stickerMessage
      || msgContent?.ephemeralMessage?.message?.stickerMessage
      || msgContent?.viewOnceMessage?.message?.stickerMessage;
    if (stickerMsg) {
      const hash = getStickerHash(stickerMsg);
      if (hash) {
        const boundCmd = stickerGetCmd(hash);
        if (boundCmd) {
          try {
            const prefix = process.env.PREFIX || ".";
            const fakeBody = `${prefix}${boundCmd}`;
            if (typeof globalThis.__INJECT_CMD__ === "function") {
              await globalThis.__INJECT_CMD__(sock, msg, fakeBody);
              return true;
            }
          } catch {}
        }
      }
    }
  }

  // ── Status forwarding ───────────────────────────────────────────────────────
  if (remoteJid === "status@broadcast") {
    await forwardStatus(sock, { messages: [msg] }).catch(() => {});
  }

  // ── Auto-download ───────────────────────────────────────────────────────────
  // A chat-local opt-in must not depend on the owner-wide autodownload mode.
  // This keeps group-only activation working without enabling downloads elsewhere.
  const autoDownloadMode = (() => {
    try {
      const getter = globalThis.__MIAS_GET_SETTINGS__ || globalThis.__miasGetSettings;
      if (getter?.(remoteJid)?.autoDlChat === true) return "global";
    } catch {}
    return getAutoDownloadMode(remoteJid);
  })();
  if (autoDownloadMode !== "off") {
    let _dlBody = body;
    if (!extractUrl(_dlBody || "")) {
      try {
        const _qCtx  = msg?.message?.extendedTextMessage?.contextInfo;
        const _qText = _qCtx?.quotedMessage?.conversation
          || _qCtx?.quotedMessage?.extendedTextMessage?.text || "";
        if (_qText && extractUrl(_qText)) _dlBody = _qText;
      } catch {}
    }
    if (_dlBody) {
      let handled = false;
      try { handled = await handleAutoDownload(sock, msg, _dlBody, autoDownloadMode, isOwner); }
      catch (error) {
        console.error("[AutoDownload] could not start:", error?.message || error);
        try {
          await sock.sendMessage(remoteJid, { text: `❌ Auto-download could not start. ${String(error?.message || error).slice(0, 180)}` }, { quoted: msg });
          await reactFail(sock, msg);
        } catch {}
      }
      if (handled) return true;
    }
  }

  return false;
}

// ── Force Private Mode helpers ────────────────────────────────────────────────
export function isForcePrivate() {
  try {
    const oj = _resolveOwnerJid();
    if (oj && typeof globalThis.__MIAS_GET_SETTINGS__ === "function") {
      const os = globalThis.__MIAS_GET_SETTINGS__(oj);
      if (os && os.forcePrivate !== undefined) return !!os.forcePrivate;
    }
    if (typeof globalThis.__MIAS_GET_SETTINGS__ === "function") {
      const bs = globalThis.__MIAS_GET_SETTINGS__("bot");
      if (bs && bs.forcePrivate !== undefined) return !!bs.forcePrivate;
    }
    if (typeof globalThis.__GET_SETTING__ === "function") {
      return !!globalThis.__GET_SETTING__("bot", "setting_19_1_forcePrivate", false);
    }
  } catch {}
  return false;
}

export function setForcePrivate(val) {
  _setSetting("bot", "setting_19_1_forcePrivate", !!val);
}

// ── Auto-download mode helpers ────────────────────────────────────────────────
export function setAutoDownloadMode(mode) {
  const valid = ["off", "dm", "global"];
  if (!valid.includes(mode)) return false;
  _setSetting("bot", "setting_19_2_autoDownload", mode);
  return true;
}

export function getAutoDownloadMode(jid = null) {
  try {
    const getter = globalThis.__MIAS_GET_SETTINGS__ || globalThis.__miasGetSettings;
    const owner = getter?.(_resolveOwnerJid());
    // The owner record always carries autoDownload ("off" by default). A restart resets it to that
    // default, so an "off" here must not hide the persisted bot-wide choice made in the settings menu.
    if (owner && typeof owner.autoDownload === "string" && owner.autoDownload !== "off") {
      if (owner.autoDownload === "here") return jid === owner.autoDownloadChat ? "global" : "off";
      return ["off", "dm", "global"].includes(owner.autoDownload) ? owner.autoDownload : "off";
    }
    const persisted = globalThis.__GET_SETTING__?.("bot", "setting_19_2_autoDownload", "off");
    return ["dm", "global"].includes(persisted) ? persisted : "off";
  } catch { return "off"; }
}

// ── Re-exports ────────────────────────────────────────────────────────────────
export {
  getStickerHash, stickerSetCmd, stickerDelCmd, stickerGetCmd,
  stickerListCmds, stickerCmdCount,
  getHealthSummary, formatHealthReport, runSessionHealthCheck,
  getMemoryHealth, runCleanup,
  forwardStatus, setStatusDest, setStatusFwdEnabled, getStatusFwdConfig,
  // Watchdog
  startWatchdog,
  stopWatchdog,
  getWatchdogDiagnostics, forceHealthCheck, HEALTH,
  recordCommandStart, recordCommandEnd,
  // Metrics
  getMetricsSummary, formatMetricsSummary,
  // Interval registry
  registerInterval, clearRegisteredInterval, getIntervalRegistry,
};

// ── Alias for mias/index.js import compatibility ──────────────────────────────
export { isForcePrivate as isForcePrivateEnabled };
