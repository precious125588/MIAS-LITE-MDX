'use strict';

const MIN_COMPANION_SYNC_MS = 15_000;
const MAX_COMPANION_SYNC_MS = 25_000;
const SAVE_INTERVAL_MS = 1_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function duration(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

/**
 * Keep the temporary pairing socket alive while WhatsApp finishes syncing the
 * newly linked companion keys. Legacy callers can use the history grace;
 * pairing supplies isReady to wait for offline notifications and auth writes
 * instead. A deadline is not proof of readiness: an unfinished link must fail
 * visibly without handing its identity to a second process.
 */
async function waitForCompanionSync({
  eventEmitter,
  saveCreds,
  minMs = MIN_COMPANION_SYNC_MS,
  maxMs = MAX_COMPANION_SYNC_MS,
  hardMaxMs,
  sleepFn = sleep,
  saveTimeoutMs = 5000,
  isActive = () => true,
  isReady,
  isProgressing,
} = {}) {
  const minimum = duration(minMs, MIN_COMPANION_SYNC_MS);
  const maximum = Math.max(minimum, duration(maxMs, MAX_COMPANION_SYNC_MS));
  // Extended ceiling. It applies only while isProgressing() says the account is still syncing.
  const hardMaximum = Math.max(maximum, duration(hardMaxMs, maximum));
  const progressing = typeof isProgressing === 'function' ? isProgressing : () => false;
  let historyReceived = false;
  let elapsedMs = 0;
  const onHistory = () => { historyReceived = true; };

  eventEmitter?.once?.('messaging-history.set', onHistory);

  const startedAt = Date.now();
  const saveLimitMs = Math.max(1, duration(saveTimeoutMs, 5000));
  const assertActive = () => {
    if (!isActive()) throw new Error('Pairing socket closed during companion sync');
  };
  const saveSafely = async () => {
    assertActive();
    if (typeof saveCreds !== 'function') return;
    // Keep the overall grace bounded even when an auth write hangs. Failure
    // must reach the pairing controller, never approve an incomplete key set.
    // Reserve one write budget beyond the sync window. A final write at
    // 25s must not get a 1ms deadline and falsely fail on a healthy volume.
    const remainingMs = Math.max(1, hardMaximum + saveLimitMs - (Date.now() - startedAt));
    let timer;
    try {
      await Promise.race([
        Promise.resolve().then(() => { assertActive(); return saveCreds(); }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Credential persistence timed out during companion sync')),
            Math.min(saveLimitMs, remainingMs));
        }),
      ]);
      assertActive();
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    await saveSafely();
    const ready = () => typeof isReady === 'function' ? isReady() : historyReceived;
    for (;;) {
      if (elapsedMs >= minimum && ready()) break;
      // Past the normal ceiling only while the account is still making progress.
      const limit = elapsedMs < maximum
        ? maximum
        : (hardMaximum > maximum && progressing() ? hardMaximum : maximum);
      if (elapsedMs >= limit) break;
      const remainingMs = Math.min(limit - elapsedMs, limit - (Date.now() - startedAt));
      if (remainingMs <= 0) break;
      const interval = Math.min(SAVE_INTERVAL_MS, remainingMs);
      await sleepFn(interval);
      elapsedMs += interval;
      await saveSafely();
    }

    assertActive();
    if (typeof isReady === 'function' && !isReady()) {
      throw new Error('WhatsApp initial sync did not settle before the deadline. Session saved; retry on a stable connection without resetting it.');
    }
    return { elapsedMs, historyReceived };
  } finally {
    if (typeof eventEmitter?.off === 'function') {
      eventEmitter.off('messaging-history.set', onHistory);
    } else {
      eventEmitter?.removeListener?.('messaging-history.set', onHistory);
    }
  }
}

module.exports = {
  MIN_COMPANION_SYNC_MS,
  MAX_COMPANION_SYNC_MS,
  waitForCompanionSync,
};
