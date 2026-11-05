'use strict';

function createTikTokChoiceGuard({
  ttlMs = 10 * 60 * 1000,
  maxEntries = 4096,
  now = Date.now,
} = {}) {
  const seen = new Map();

  function sweep(time) {
    for (const [key, timestamp] of seen) {
      if (time - timestamp > ttlMs) seen.delete(key);
    }
  }

  return {
    isDuplicate(chatId, messageId) {
      const chat = String(chatId || '');
      const id = String(messageId || '');
      if (!chat || !id) return false;

      const time = Number(now());
      sweep(time);
      const key = `${chat}\u0000${id}`;
      if (seen.has(key)) return true;

      seen.set(key, time);
      while (seen.size > maxEntries) {
        seen.delete(seen.keys().next().value);
      }
      return false;
    },
    clear() {
      seen.clear();
    },
  };
}

module.exports = { createTikTokChoiceGuard };
