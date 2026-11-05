'use strict';
/* Regenerates lib/precious-build-stamp.json from the files that are ACTUALLY
   in the build. Runs inside the Docker build right after `COPY . .`, so the
   stamp always matches the latest pushed code. You never edit hashes by hand.
   The runtime stale-guard still CRASHES if anything changes after the build
   or if a deleted file comes back. */
const fs = require('fs');
const path = require('path');
const { sha256 } = require('../lib/precious-stale-guard.cjs');
const root = path.join(__dirname, '..');
const stampPath = path.join(root, 'lib', 'precious-build-stamp.json');
const stamp = JSON.parse(fs.readFileSync(stampPath, 'utf8'));
const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
stamp.buildId = 'auto-' + now.getUTCFullYear() + pad(now.getUTCMonth() + 1) + pad(now.getUTCDate()) +
  '-' + pad(now.getUTCHours()) + pad(now.getUTCMinutes()) + pad(now.getUTCSeconds());
stamp.builtAt = now.toISOString();
let gitSha = process.env.RAILWAY_GIT_COMMIT_SHA || process.env.COMMIT_SHA || process.env.GIT_COMMIT_SHA || null;
if (!gitSha) {
  try {
    const { execSync } = require('child_process');
    gitSha = execSync('git rev-parse HEAD', { cwd: root, encoding: 'utf8' }).trim();
  } catch (_) {}
}
if (gitSha && /^[0-9a-f]{7,40}$/i.test(gitSha)) {
  stamp.sha = gitSha;
  stamp.commit = gitSha;
}
for (const rel of Object.keys(stamp.files || {})) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) { console.error('[build-stamp] MISSING ' + rel); process.exit(1); }
  stamp.files[rel] = sha256(abs);
}
const left = (stamp.mustNotExist || []).filter((r) => fs.existsSync(path.join(root, r)));
if (left.length) { console.error('[build-stamp] delete these first: ' + left.join(', ')); process.exit(1); }
fs.writeFileSync(stampPath, JSON.stringify(stamp, null, 2) + '\n');
console.log('[build-stamp] ✅ ' + stamp.buildId + ' — ' + Object.keys(stamp.files).length + ' files stamped');
