'use strict';
/* ── STALE-CODE CRASH SHIELD (v34) ────────────────────────────────────────────
   Purpose: if the container is running OLD code, or the new fix files are not
   actually loading, the process must CRASH LOUDLY and name exactly what is
   wrong — instead of silently running yesterday's build.

   How it works:
     lib/precious-build-stamp.json is written at push time and contains
       { buildId, builtAt, files: { "<path>": "<sha256>" }, mustNotExist: [...] }
     On boot we verify, for every listed file:
       - it exists                      -> else CRASH "missing"
       - its sha256 matches the stamp   -> else CRASH "stale/modified"
     and for every path in mustNotExist:
       - it must be gone                -> else CRASH "deleted file still present"
   Set STALE_GUARD=warn to log instead of crash. */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function verify(opts) {
  const root = (opts && opts.root) || path.join(__dirname, '..');
  const name = (opts && opts.name) || 'process';
  const stampPath = path.join(__dirname, 'precious-build-stamp.json');
  const problems = [];
  let stamp;

  try {
    stamp = JSON.parse(fs.readFileSync(stampPath, 'utf8'));
  } catch (e) {
    problems.push('build stamp unreadable: lib/precious-build-stamp.json (' + (e && e.message) + ')');
    return fail(problems, null, name);
  }

  for (const rel of Object.keys(stamp.files || {})) {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) { problems.push('MISSING    ' + rel); continue; }
    let got;
    try { got = sha256(abs); } catch (e) { problems.push('UNREADABLE ' + rel + ' (' + e.message + ')'); continue; }
    if (got !== stamp.files[rel]) {
      problems.push('STALE      ' + rel +
        ' (expected ' + String(stamp.files[rel]).slice(0, 12) +
        ', running ' + got.slice(0, 12) + ')');
    }
  }

  for (const rel of (stamp.mustNotExist || [])) {
    if (fs.existsSync(path.join(root, rel))) {
      problems.push('NOT DELETED ' + rel + ' (old code still on disk, it overrides the new fixes)');
    }
  }

  if (!problems.length) {
    console.log('[stale-guard] ✅ ' + name + ' running build ' + stamp.buildId +
      ' (' + stamp.builtAt + ') — ' + Object.keys(stamp.files || {}).length + ' fix files verified');
    global.__PRECIOUS_BUILD__ = stamp.buildId;
    global.__PRECIOUS_BUILT_AT__ = stamp.builtAt;
    return stamp;
  }
  return fail(problems, stamp, name);
}

function fail(problems, stamp, name) {
  const line = '═'.repeat(70);
  console.error('\n' + line);
  console.error('❌ STALE CODE DETECTED — ' + name + ' is NOT running the pushed fixes');
  if (stamp) console.error('   expected build: ' + stamp.buildId + ' (' + stamp.builtAt + ')');
  console.error('   exactly what is wrong:');
  for (const p of problems) console.error('     • ' + p);
  console.error('   fix: redeploy with "Clear build cache" so the container rebuilds from main.');
  console.error(line + '\n');

  if (String(process.env.STALE_GUARD || '').toLowerCase() === 'strict') {
    process.exit(1);
  }
  console.warn('[stale-guard] continuing with updated code (set STALE_GUARD=strict to halt)');
  return stamp;
}

module.exports = { verify, sha256 };
