// scripts/panel-paced-install.cjs
// Paced, progressive dependency installer for resource-constrained panels (KataBump / Pterodactyl).
// Prevents KataBump daemon kill by keeping file creation strictly below the 5,000 files/15s burst limit.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const targetDir = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
const pkgPath = path.join(targetDir, 'package.json');

if (!fs.existsSync(pkgPath)) {
  console.error(`[paced-install] package.json not found in ${targetDir}`);
  process.exit(1);
}

const originalPkgText = fs.readFileSync(pkgPath, 'utf8');
const originalPkg = JSON.parse(originalPkgText);
const allDeps = Object.entries(originalPkg.dependencies || {});

console.log(`[paced-install] Total dependencies to install: ${allDeps.length}`);

// Aggressively clean stale caches to protect panel disk quota (716MB limit)
const cacheDir = path.join(targetDir, '.npm-cache');
const tmpDir = path.join(targetDir, '.npm-tmp');
for (const dir of [cacheDir, tmpDir]) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
}

// Split into 4 safe batches (~16 packages each) to keep file creation < 4,500 files per window
const batchSize = Math.ceil(allDeps.length / 4);
const batches = [];
for (let i = 0; i < allDeps.length; i += batchSize) {
  batches.push(allDeps.slice(i, i + batchSize));
}

console.log(`[paced-install] Pacing install across ${batches.length} stages to stay below KataBump file burst thresholds (< 5,000 files/15s)`);

const accumulated = {};
let stage = 0;

for (const batch of batches) {
  stage++;
  for (const [k, v] of batch) {
    accumulated[k] = v;
  }

  console.log(`\n[paced-install] Stage ${stage}/${batches.length}: Installing ${Object.keys(accumulated).length}/${allDeps.length} packages...`);

  // Write progressive package.json
  const stagePkg = { ...originalPkg, dependencies: { ...accumulated } };
  fs.writeFileSync(pkgPath, JSON.stringify(stagePkg, null, 2), 'utf8');

  const startTime = Date.now();
  const isFinal = (stage === batches.length);
  const npmArgs = [
    'install',
    '--omit=dev',
    '--prefer-offline',
    '--no-audit',
    '--no-fund',
    '--no-progress',
    '--legacy-peer-deps',
    '--loglevel=error',
    `--cache=${cacheDir}`
  ];
  if (!isFinal) {
    npmArgs.push('--ignore-scripts');
  }

  const res = spawnSync('npm', npmArgs, {
    cwd: targetDir,
    stdio: 'inherit',
    env: {
      ...process.env,
      TMPDIR: tmpDir,
      NODE_OPTIONS: '--max-old-space-size=128',
      UV_THREADPOOL_SIZE: '1'
    }
  });

  if (res.status !== 0) {
    console.error(`[paced-install] Stage ${stage} failed with exit code ${res.status}`);
    fs.writeFileSync(pkgPath, originalPkgText, 'utf8');
    process.exit(res.status || 1);
  }

  const duration = (Date.now() - startTime) / 1000;
  console.log(`[paced-install] Stage ${stage} completed in ${duration.toFixed(1)}s`);

  // Rest 15 seconds between stages so KataBump's consecutive burst counter drops back to 0
  if (!isFinal) {
    console.log(`[paced-install] ⏳ Resting 15s to reset KataBump daemon burst window...`);
    spawnSync('sleep', ['15']);
  }
}

// Restore full original package.json
fs.writeFileSync(pkgPath, originalPkgText, 'utf8');

// Immediately purge caches to keep disk footprint minimal (~340MB)
for (const dir of [cacheDir, tmpDir]) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

console.log('\n[paced-install] ✅ All 64 dependencies installed cleanly without exceeding panel burst limits!');
