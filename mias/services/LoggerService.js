/**
 * MIAS — Logger Service
 *
 * Single shared logger for the entire bot.
 * Wraps pino internally — no command should import pino directly.
 *
 * Architecture: Commands → LoggerService → LoggerEngine (pino) → stdout
 */

import engineRegistryModule from "../lib/engineRegistry.cjs";

const _engine = engineRegistryModule.getEngineRegistry().get("logger");

// ─── Child logger factory ─────────────────────────────────────────────────────

const _children = new Map();

/**
 * Get a named child logger.
 * @param {string} module
 * @returns {object} pino child logger
 */
export function getLogger(module = "MIAS") {
  if (_children.has(module)) return _children.get(module);
  const child = _engine ? _engine.child(module) : _nullLogger(module);
  _children.set(module, child);
  return child;
}

function _nullLogger(module) {
  const prefix = `[${module}]`;
  return {
    info:  (msg, ...a) => console.log(prefix, msg, ...a),
    warn:  (msg, ...a) => console.warn(prefix, msg, ...a),
    error: (msg, ...a) => console.error(prefix, msg, ...a),
    debug: (msg, ...a) => process.env.DEBUG && console.log(prefix, "[DEBUG]", msg, ...a),
    trace: () => {},
    child: (extra) => _nullLogger(`${module}:${extra.module || JSON.stringify(extra)}`),
  };
}

// ─── Root-level helpers (use MIAS root logger) ───────────────────────────────

const _root = getLogger("MIAS");

/** Log an info message. */
export function info(msg, data) {
  if (_engine) data !== undefined ? _engine.info(data, msg) : _engine.info(msg);
  else console.log("[MIAS]", msg, data ?? "");
}

/** Log a warning. */
export function warn(msg, data) {
  if (_engine) data !== undefined ? _engine.warn(data, msg) : _engine.warn(msg);
  else console.warn("[MIAS]", msg, data ?? "");
}

/** Log an error. */
export function error(msg, data) {
  if (_engine) data !== undefined ? _engine.error(data, msg) : _engine.error(msg);
  else console.error("[MIAS]", msg, data ?? "");
}

/** Log a debug message (only when LOG_LEVEL=debug or DEBUG is set). */
export function debug(msg, data) {
  if (_engine) data !== undefined ? _engine.debug(data, msg) : _engine.debug(msg);
  else if (process.env.DEBUG || process.env.LOG_LEVEL === "debug") {
    console.log("[MIAS][DEBUG]", msg, data ?? "");
  }
}

/** Log a trace message. */
export function trace(msg, data) {
  if (_engine) data !== undefined ? _engine.trace(data, msg) : _engine.trace(msg);
}

/** Log a startup event. */
export function startup(msg = "MIAS starting up") {
  if (_engine) _engine.startup(msg);
  else console.log("[MIAS][STARTUP]", msg);
}

/** Log a shutdown event. */
export function shutdown(msg = "MIAS shutting down") {
  if (_engine) _engine.shutdown(msg);
  else console.log("[MIAS][SHUTDOWN]", msg);
}

/** Log a command execution with optional latency. */
export function command(cmdName, jid, latencyMs) {
  if (_engine) _engine.command(cmdName, jid, latencyMs);
  else console.log(`[MIAS][CMD] ${cmdName} | ${jid} | ${latencyMs ?? "?"}ms`);
}

/** Log an API call. */
export function api(service, endpoint, status, latencyMs) {
  if (_engine) _engine.api(service, endpoint, status, latencyMs);
  else console.log(`[MIAS][API] ${service} ${endpoint} ${status} ${latencyMs ?? "?"}ms`);
}

/** Default export: root logger interface */
export default { info, warn, error, debug, trace, startup, shutdown, command, api, getLogger };
