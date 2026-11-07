// =========================================================================
//  nexrayGate.cjs — one paced queue for every NexRay request.
//
//  NexRay limits requests per IP or can become unreachable.
//  This queue spaces calls out, caps timeout at 3.5s, and if it fails or
//  rate-limits, immediately activates a cooldown so other sources are used
//  instantly without waiting.
// =========================================================================
'use strict';

const GAP_MS = 800;
const COOL_MS = 3 * 60 * 1000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

let _tail = Promise.resolve();
let _lastAt = 0;
let _coolUntil = 0;

function coolingDown() { return Date.now() < _coolUntil; }
function markLimited(ms = COOL_MS) { _coolUntil = Date.now() + ms; }

// Runs fn after the previous NexRay call, at least GAP_MS apart.
function paced(fn) {
  const run = async () => {
    const wait = _lastAt + GAP_MS - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    _lastAt = Date.now();
    return fn();
  };
  const next = _tail.then(run, run);
  _tail = next.catch(() => {});
  return next;
}

// Returns { list, reason }. reason: null | 'cooldown' | 'rate-limited' | 'error'.
async function nexrayList(url, timeout = 3500) {
  if (typeof fetch !== 'function') return { list: [], reason: 'error' };
  if (coolingDown()) return { list: [], reason: 'cooldown' };

  const out = await paced(async () => {
    if (coolingDown()) return { list: [], reason: 'cooldown' };
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(timeout) });
      const json = await res.json().catch(() => null);
      if (json && json.status === false && /rate limit/i.test(String(json.message || json.error || ''))) {
        markLimited();
        return { list: [], reason: 'rate-limited' };
      }
      if (json && json.status && Array.isArray(json.result)) return { list: json.result, reason: null };
      // Unexpected or error response: cooldown so we don't spam a failing host
      markLimited(60 * 1000);
      return { list: [], reason: 'error' };
    } catch (_) {
      // Timeout or network unreachable: cooldown for 2 minutes to keep bot snappy
      markLimited(120 * 1000);
      return { list: [], reason: 'error' };
    }
  });

  return out;
}

module.exports = { paced, coolingDown, markLimited, nexrayList, GAP_MS, COOL_MS };
