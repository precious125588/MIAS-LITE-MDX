/**
 * connectionPolicy.cjs — Reconnection and Disconnect Decision Architecture
 *
 * Implements Levanter-grade connection policy and resilient retry handling:
 *   • Fast reconnect on 515 (restartRequired) — 800ms delay, bounded restarts
 *   • Exponential backoff for transient drops (408, 428, 503, network drop) — 1s..8s, max 12
 *   • Terminal codes (401 logged out, 403 forbidden, 411 multidevice mismatch, 500 bad session)
 *     halt reconnect and quarantine session to avoid infinite auth loops
 *   • 440 (connection replaced / conflict) pauses reconnect to prevent dual-instance fighting
 */
'use strict';

const DisconnectCode = Object.freeze({
  loggedOut: 401,
  forbidden: 403,
  timedOut: 408,
  multideviceMismatch: 411,
  connectionClosed: 428,
  connectionReplaced: 440,
  badSession: 500,
  restartRequired: 515,
  unavailableService: 503,
});

const MAX_RECONNECTS = 12; // transient network drops
const MAX_RESTARTS = 6;    // WhatsApp restartRequired (515)

const TERMINAL_MESSAGES = {
  401: 'WhatsApp ended this link. Device logged out. Remove any stale linked-device in WhatsApp and pair again.',
  403: 'WhatsApp refused this login (403 forbidden). Wait a few minutes before retrying.',
  411: 'Multi-device conflict detected (411). Remove unused linked devices in WhatsApp and pair again.',
  440: 'Connection replaced by another session (440). Pausing reconnect to prevent socket contention.',
  500: 'WhatsApp rejected the saved handshake (500 bad session). Session credentials need re-pairing.',
};

function backoffDelay(attempt, base = 1000, cap = 8000) {
  const exp = Math.min(cap, base * Math.pow(2, Math.max(0, attempt)));
  // Add 10% jitter to prevent thundering herd
  const jitter = Math.floor(Math.random() * (exp * 0.1));
  return Math.min(cap, exp + jitter);
}

/**
 * Classifies Baileys disconnect status code and determines retry behavior.
 *
 * @param {number|undefined} statusCode
 * @param {{reconnects?: number, restarts?: number}} state
 * @returns {{action: 'retry'|'fail'|'pause', delayMs?: number, message?: string, isTerminal?: boolean, isRestartRequired?: boolean, isConflict?: boolean}}
 */
function classifyDisconnect(statusCode, { reconnects = 0, restarts = 0 } = {}) {
  const code = Number(statusCode) || 0;

  if (code === DisconnectCode.connectionReplaced) {
    return {
      action: 'pause',
      isConflict: true,
      message: TERMINAL_MESSAGES[440],
      delayMs: 15000,
    };
  }

  if (TERMINAL_MESSAGES[code]) {
    return {
      action: 'fail',
      isTerminal: true,
      statusCode: code,
      message: TERMINAL_MESSAGES[code],
    };
  }

  if (code === DisconnectCode.restartRequired) {
    if (restarts >= MAX_RESTARTS) {
      return {
        action: 'fail',
        isTerminal: true,
        statusCode: code,
        message: 'WhatsApp requested restart repeatedly (515). Halting to prevent loop.',
      };
    }
    return {
      action: 'retry',
      isRestartRequired: true,
      delayMs: 800, // fast Levanter reconnect
      restarts: restarts + 1,
    };
  }

  if (reconnects >= MAX_RECONNECTS) {
    return {
      action: 'fail',
      isTerminal: false,
      statusCode: code,
      message: 'WhatsApp connection kept dropping after max attempts. Please check network.',
    };
  }

  return {
    action: 'retry',
    isRestartRequired: false,
    delayMs: backoffDelay(reconnects),
    reconnects: reconnects + 1,
  };
}

module.exports = {
  DisconnectCode,
  MAX_RECONNECTS,
  MAX_RESTARTS,
  TERMINAL_MESSAGES,
  backoffDelay,
  classifyDisconnect,
};
