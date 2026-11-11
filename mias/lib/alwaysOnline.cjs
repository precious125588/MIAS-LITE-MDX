"use strict";

const DEFAULT_PRESENCE_INTERVAL_MS = 55_000;
const MIN_PRESENCE_INTERVAL_MS = 10_000;
const MAX_PRESENCE_INTERVAL_MS = 55_000;
const DEFAULT_PRESENCE_TIMEOUT_MS = 8_000;

function normalizeInterval(value, fallback, minimum, maximum) {
  const raw = String(value ?? "").trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(parsed)));
}

function normalizePresenceInterval(value, fallback = DEFAULT_PRESENCE_INTERVAL_MS) {
  return normalizeInterval(value, fallback, MIN_PRESENCE_INTERVAL_MS, MAX_PRESENCE_INTERVAL_MS);
}

function normalizePresenceTimeout(value, fallback = DEFAULT_PRESENCE_TIMEOUT_MS) {
  return normalizeInterval(value, fallback, 1_000, 15_000);
}

function isAlwaysOnlineEnabled(settings) {
  return settings?.alwaysOnline !== false;
}

function socketCanSendPresence(sock, connected) {
  if (!sock || !connected || typeof sock.sendPresenceUpdate !== "function") return false;
  const ws = sock.ws;
  if (ws?.isOpen === false || ws?.isClosed === true || ws?.isClosing === true) return false;
  const readyState = ws?.readyState ?? ws?.socket?.readyState;
  if (readyState !== undefined && readyState !== 1) return false;
  return true;
}

async function sendPresenceUpdateWithTimeout(sock, presence, timeoutMs = DEFAULT_PRESENCE_TIMEOUT_MS) {
  if (!sock || typeof sock.sendPresenceUpdate !== "function") {
    throw new TypeError("WhatsApp socket does not support presence updates");
  }
  const timeout = normalizePresenceTimeout(timeoutMs);
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => sock.sendPresenceUpdate(presence)),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`WhatsApp presence update timed out after ${timeout}ms`);
          error.code = "PRESENCE_UPDATE_TIMEOUT";
          reject(error);
        }, timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  DEFAULT_PRESENCE_INTERVAL_MS,
  MIN_PRESENCE_INTERVAL_MS,
  MAX_PRESENCE_INTERVAL_MS,
  DEFAULT_PRESENCE_TIMEOUT_MS,
  normalizeInterval,
  normalizePresenceInterval,
  normalizePresenceTimeout,
  isAlwaysOnlineEnabled,
  socketCanSendPresence,
  sendPresenceUpdateWithTimeout,
};
