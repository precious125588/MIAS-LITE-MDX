'use strict';

function isTransientTransportError(error) {
  const message = [error?.message, error?.cause?.message, error?.code]
    .filter(Boolean).join(' ');
  return /fetch failed|ECONNRESET|ETIMEDOUT|ECONNABORTED|EAI_AGAIN|socket hang up|network error/i.test(message);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Retry a WhatsApp send only for recognizable transient transport failures. */
async function sendWithRetry(sock, jid, payload, options, { attempts = 2, delayMs = 900 } = {}) {
  const maxAttempts = Math.max(1, Math.min(3, Number(attempts) || 1));
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await sock.sendMessage(jid, payload, options);
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !isTransientTransportError(error)) throw error;
      await delay(delayMs * attempt);
    }
  }
  throw lastError;
}

module.exports = { isTransientTransportError, sendWithRetry };
