'use strict';
/* ── AUTO CACHE CLEAR (v34) ───────────────────────────────────────────────────
   Runs on EVERY boot (restart or deploy) before anything else is required.
   Wipes on-disk caches that make Railway/Render keep serving stale code:
     - node's require cache (in-process)
     - ./.cache, ./tmp, ./.tmp, ./node_modules/.cache, ./mias/.cache
     - old patch markers in os.tmpdir() (precious-* / patch-* markers)
   Idempotent, never throws, never blocks boot. */

const fs = require('fs');
const os = require('os');
const path = require('path');

function rm(p) {
  try {
    if (!fs.existsSync(p)) return false;
    fs.rmSync(p, { recursive: true, force: true });
    return true;
  } catch (_) { return false; }
}

function clearAll(opts) {
  const root = (opts && opts.root) || path.join(__dirname, '..');
  const cleared = [];

  // 1) in-process module cache
  try {
    for (const k of Object.keys(require.cache)) {
      if (k.indexOf('node_modules') === -1) delete require.cache[k];
    }
    cleared.push('require-cache');
  } catch (_) {}

  // 2) on-disk build/runtime caches
  const dirs = ['.cache', 'tmp', '.tmp', path.join('node_modules', '.cache'),
                path.join('mias', '.cache'), path.join('mias', 'tmp')];
  for (const d of dirs) if (rm(path.join(root, d))) cleared.push(d);

  // 3) stale patch markers from previous boots
  try {
    const tmp = os.tmpdir();
    for (const f of fs.readdirSync(tmp)) {
      if (/^(precious|patch|fixpack|mias)[-_.]/i.test(f)) {
        if (rm(path.join(tmp, f))) cleared.push('tmp/' + f);
      }
    }
  } catch (_) {}

  console.log('[cache-clear] boot cache cleared -> ' +
    (cleared.length ? cleared.join(', ') : 'nothing to clear'));
  return cleared;
}

module.exports = { clearAll, rm };
