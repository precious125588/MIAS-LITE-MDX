// =========================================================================
//  nexrayGate.cjs — one paced queue for every NexRay request.
//
//  NexRay limits requests per IP. Commands and the creator monitor used to
//  fire together, and after the first burst every reply was "Rate limit too
//  many requests". This queue spaces calls out, and after a limit reply it
//  pauses NexRay for a minute, so callers move on to another source at once
//  instead of waiting on a source that is refusing them.
// =========================================================================
'use strict';

const GAP_MS = 1100;
const COOL_MS = 60 * 1000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

let _tail = Promise.resolve();
let _lastAt = 0;
let _coolUntil = 0;

function coolingDown() { return Date.now() < _coolUntil; }
function markLimited() { _coolUntil = Date.now() + COOL_MS; }

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
// A server error is retried once; a rate-limit reply starts the cooldown.
async function nexrayList(url, timeout = 20000) {
  if (typeof fetch !== 'function') return { list: [], reason: 'error' };
  if (coolingDown()) return { list: [], reason: 'cooldown' };
  let reason = 'error';
  for (let attempt = 0; attempt < 2; attempt++) {
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
        return { list: [], reason: 'error' };
      } catch (_) {
        return { list: [], reason: 'error' };
      }
    });
    if (out.reason !== 'error') return out;
    reason = out.reason;
  }
  return { list: [], reason };
}

module.exports = { paced, coolingDown, markLimited, nexrayList, GAP_MS, COOL_MS };
