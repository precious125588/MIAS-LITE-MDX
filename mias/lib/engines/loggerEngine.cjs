"use strict";

/**
 * MIAS Logger Engine
 * Wraps pino + pino-pretty for structured, levelled logging.
 * Architecture: Services → LoggerEngine (pino) → stdout
 */

const pino = require("pino");

// ─── Transport ────────────────────────────────────────────────────────────────

function _buildTransport() {
  const isDev =
    process.env.NODE_ENV !== "production" &&
    process.env.PINO_PRETTY !== "0" &&
    process.stdout.isTTY;

  if (!isDev) return undefined;

  try {
    return pino.transport({
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "SYS:HH:MM:ss",
        ignore: "pid,hostname",
        messageFormat: "[{module}] {msg}",
      },
    });
  } catch {
    return undefined;
  }
}

// ─── Logger factory ───────────────────────────────────────────────────────────

function createLogger(opts = {}) {
  const level = opts.level || process.env.LOG_LEVEL || "info";
  const base = {
    level,
    base: { module: opts.module || "MIAS" },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level(label) {
        return { level: label.toUpperCase() };
      },
    },
    serializers: {
      err: pino.stdSerializers.err,
      error: pino.stdSerializers.err,
    },
  };

  const transport = _buildTransport();
  return transport ? pino(base, transport) : pino(base);
}

// ─── Root logger ──────────────────────────────────────────────────────────────

const rootLogger = createLogger({ module: "MIAS" });

/**
 * Create a child logger with a module label.
 * @param {string} module
 * @param {object} [extra]
 * @returns {object} pino logger instance
 */
function child(module, extra = {}) {
  return rootLogger.child({ module, ...extra });
}

// ─── Convenience wrappers ─────────────────────────────────────────────────────

function info(msg, data) {
  if (data !== undefined) rootLogger.info(data, msg);
  else rootLogger.info(msg);
}

function warn(msg, data) {
  if (data !== undefined) rootLogger.warn(data, msg);
  else rootLogger.warn(msg);
}

function error(msg, data) {
  if (data !== undefined) rootLogger.error(data, msg);
  else rootLogger.error(msg);
}

function debug(msg, data) {
  if (data !== undefined) rootLogger.debug(data, msg);
  else rootLogger.debug(msg);
}

function trace(msg, data) {
  if (data !== undefined) rootLogger.trace(data, msg);
  else rootLogger.trace(msg);
}

function startup(msg) {
  rootLogger.info({ phase: "startup" }, msg || "MIAS starting up");
}

function shutdown(msg) {
  rootLogger.info({ phase: "shutdown" }, msg || "MIAS shutting down");
}

/**
 * Log a command execution event.
 */
function command(cmdName, jid, latencyMs) {
  rootLogger.info({ cmd: cmdName, jid, latencyMs }, `CMD:${cmdName}`);
}

/**
 * Log an API call.
 */
function api(service, endpoint, status, latencyMs) {
  const level = (status >= 500 || status === 0) ? "error" : status >= 400 ? "warn" : "info";
  rootLogger[level]({ service, endpoint, status, latencyMs }, `API:${service}`);
}

module.exports = {
  logger: rootLogger,
  child,
  createLogger,
  info,
  warn,
  error,
  debug,
  trace,
  startup,
  shutdown,
  command,
  api,
};
