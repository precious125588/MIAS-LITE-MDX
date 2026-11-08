// =========================================================================
//  nexrayGate.cjs — paced NexRay queues, one per lane.
//
//  NexRay limits requests per IP or can become unreachable. Each lane has its
//  own queue, spacing and cooldown:
//    • "interactive" — user commands (fyp, lyrics, search). Never waits behind
//      background work and is not cooled down by it.
//    • "background"  — the creator-page monitor, which sweeps many creators.
//  A timeout or rate limit in one lane cools down only that lane.
// =========================================================================
'use strict';

const GAP_MS = 800;
const COOL_MS = 3 * 60 * 1000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

const _lanes = {
  interactive: { tail: Promise.resolve(), lastAt: 0, coolUntil: 0 },
  background: { tail: Promise.resolve(), lastAt: 0, coolUntil: 0 },
};
const laneOf = (lane) => _lanes[lane] || _lanes.interactive;

function coolingDown(lane = 'interactive') { return Date.now() < laneOf(lane).coolUntil; }
function markLimited(ms = COOL_MS, lane = 'interactive') { laneOf(lane).coolUntil = Date.now() + ms; }

// Runs fn after the previous call in the same lane, at least GAP_MS apart.
function paced(fn, lane = 'interactive') {
  const state = laneOf(lane);
  const run = async () => {
    const wait = state.lastAt + GAP_MS - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    state.lastAt = Date.now();
    return fn();
  };
  const next = state.tail.then(run, run);
  state.tail = next.catch(() => {});
  return next;
}

// Returns { list, reason }. reason: null | 'cooldown' | 'rate-limited' | 'error'.
async function nexrayList(url, timeout = 3500, { lane = 'interactive' } = {}) {
  if (typeof fetch !== 'function') return { list: [], reason: 'error' };
  if (coolingDown(lane)) return { list: [], reason: 'cooldown' };

  const out = await paced(async () => {
    if (coolingDown(lane)) return { list: [], reason: 'cooldown' };
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(timeout) });
      const json = await res.json().catch(() => null);
      if (json && json.status === false && /rate limit/i.test(String(json.message || json.error || ''))) {
        markLimited(COOL_MS, lane);
        return { list: [], reason: 'rate-limited' };
      }
      if (json && json.status && Array.isArray(json.result)) return { list: json.result, reason: null };
      // Unexpected or error response: brief pause for this lane only
      markLimited(15 * 1000, lane);
      return { list: [], reason: 'error' };
    } catch (_) {
      // Timeout or network unreachable: brief pause for this lane only.
      // NexRay answers in 0.4-11s, so one slow reply must not stall every command.
      markLimited(15 * 1000, lane);
      return { list: [], reason: 'error' };
    }
  }, lane);

  return out;
}

module.exports = { paced, coolingDown, markLimited, nexrayList, GAP_MS, COOL_MS };
