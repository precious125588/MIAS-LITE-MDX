'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function ensureDependencies(rootDir) {
  const root = rootDir || path.resolve(__dirname, '..');
  const critical = [
    { name: 'lodash', spec: 'lodash@^4.18.1', check: path.join('node_modules', 'lodash', 'package.json') },
    { name: 'axios', spec: 'axios@^1.20.0', check: path.join('node_modules', 'axios', 'package.json') },
    { name: 'qrcode', spec: 'qrcode@^1.5.4', check: path.join('node_modules', 'qrcode', 'package.json') },
    { name: 'express', spec: 'express@^5.3.0', check: path.join('node_modules', 'express', 'package.json') },
    { name: '@whiskeysockets/baileys', spec: '@whiskeysockets/baileys@npm:@itsliaaa/baileys@0.4.0', check: path.join('node_modules', '@whiskeysockets', 'baileys', 'package.json') },
    { name: '@itsliaaa/starforge', spec: '@itsliaaa/starforge@0.0.0-alpha.10', check: path.join('node_modules', '@itsliaaa', 'starforge', 'package.json') },
    { name: '@hapi/boom', spec: '@hapi/boom@^10.0.1', check: path.join('node_modules', '@hapi', 'boom', 'package.json') },
    { name: 'chalk', spec: 'chalk@^4.1.2', check: path.join('node_modules', 'chalk', 'package.json') },
    { name: 'pino', spec: 'pino@^10.4.0', check: path.join('node_modules', 'pino', 'package.json') },
    { name: 'qs', spec: 'qs@^6.16.1', check: path.join('node_modules', 'qs', 'package.json') },
    { name: 'ws', spec: 'ws@^8.22.2', check: path.join('node_modules', 'ws', 'package.json') }
  ];

  const missing = critical.filter(c => !fs.existsSync(path.join(root, c.check)));
  if (missing.length > 0) {
    console.log(`[BOOT-DEPS] ⚠️ Missing critical dependencies: ${missing.map(m => m.name).join(', ')}. Auto-installing with low-memory profile...`);
    const env = {
      ...process.env,
      NODE_OPTIONS: [process.env.NODE_OPTIONS || '', '--max-old-space-size=128'].filter(Boolean).join(' ')
    };

    // Install missing packages individually to prevent memory spikes
    for (const item of missing) {
      if (fs.existsSync(path.join(root, item.check))) continue;
      console.log(`[BOOT-DEPS] Installing ${item.spec} (low-memory mode)...`);
      try {
        const res = spawnSync('npm', [
          'install',
          '--no-audit',
          '--no-fund',
          '--no-progress',
          '--legacy-peer-deps',
          '--ignore-scripts',
          '--no-save',
          '--no-package-lock',
          '--prefer-offline',
          '--maxsockets=1',
          item.spec
        ], {
          cwd: root,
          stdio: 'inherit',
          env
        });

        if (res.status === 137 || res.signal === 'SIGKILL') {
          console.warn(`[BOOT-DEPS] ⚠️ npm was interrupted (low memory / exit 137) while installing ${item.name}. Continuing...`);
        } else if (res.status !== 0) {
          console.warn(`[BOOT-DEPS] ⚠️ npm install ${item.name} exited with code ${res.status}. Continuing...`);
        } else {
          console.log(`[BOOT-DEPS] ✅ Installed ${item.name}`);
        }
      } catch (err) {
        console.warn(`[BOOT-DEPS] ⚠️ Error during ${item.name} install:`, err.message);
      }
    }
  }

  // Ensure @whiskeysockets/baileys has a root index.js bridge to prevent ERR_MODULE_NOT_FOUND
  try {
    const baileysDir = path.join(root, 'node_modules', '@whiskeysockets', 'baileys');
    if (fs.existsSync(baileysDir)) {
      const idxFile = path.join(baileysDir, 'index.js');
      if (!fs.existsSync(idxFile)) {
        fs.writeFileSync(idxFile, "export * from './lib/index.js';\nexport { default } from './lib/index.js';\n", 'utf8');
      }
    }
  } catch {}

  // Ensure @itsliaaa/starforge has a root index.js bridge if needed
  try {
    const starforgeDir = path.join(root, 'node_modules', '@itsliaaa', 'starforge');
    if (fs.existsSync(starforgeDir)) {
      const idxFile = path.join(starforgeDir, 'index.js');
      if (!fs.existsSync(idxFile)) {
        fs.writeFileSync(idxFile, "module.exports = require('./lib/index.js');\n", 'utf8');
      }
    }
  } catch {}

  // Ensure mias/node_modules is a symlink to root node_modules
  try {
    const miasNm = path.join(root, 'mias', 'node_modules');
    if (fs.existsSync(miasNm)) {
      try {
        const stat = fs.lstatSync(miasNm);
        if (!stat.isSymbolicLink()) {
          fs.rmSync(miasNm, { recursive: true, force: true });
        }
      } catch {}
    }
    if (!fs.existsSync(miasNm)) {
      try {
        fs.symlinkSync('../node_modules', miasNm, 'junction');
      } catch {
        // If symlink fails, copy or ignore
      }
    }
  } catch {}
}

try {
  ensureDependencies();
} catch (e) {
  // Silent fallback
}

module.exports = { ensureDependencies };
