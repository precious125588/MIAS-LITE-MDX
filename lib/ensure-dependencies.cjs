'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function ensureDependencies(rootDir) {
  const root = rootDir || path.resolve(__dirname, '..');
  const critical = [
    { name: 'lodash', spec: 'lodash@^4.18.1', check: path.join('node_modules', 'lodash', 'package.json') },
    { name: 'qrcode', spec: 'qrcode@^1.5.4', check: path.join('node_modules', 'qrcode', 'package.json') },
    { name: 'express', spec: 'express@^5.3.0', check: path.join('node_modules', 'express', 'package.json') },
    { name: '@whiskeysockets/baileys', spec: '@whiskeysockets/baileys@npm:@itsliaaa/baileys@0.4.0', check: path.join('node_modules', '@whiskeysockets', 'baileys', 'package.json') }
  ];

  const missing = critical.filter(c => !fs.existsSync(path.join(root, c.check)));
  if (missing.length > 0) {
    console.log(`[BOOT-DEPS] ⚠️ Missing critical dependencies: ${missing.map(m => m.name).join(', ')}. Auto-installing...`);
    try {
      const toInstall = missing.map(m => m.spec);
      const res = spawnSync('npm', [
        'install',
        '--no-audit',
        '--no-fund',
        '--no-progress',
        '--legacy-peer-deps',
        '--ignore-scripts',
        '--maxsockets=1',
        ...toInstall
      ], {
        cwd: root,
        stdio: 'inherit'
      });
      if (res.status === 0) {
        console.log('[BOOT-DEPS] ✅ Dependencies installed successfully.');
      } else {
        console.warn(`[BOOT-DEPS] Warning: npm install exited with code ${res.status}`);
      }
    } catch (err) {
      console.warn('[BOOT-DEPS] Error auto-installing dependencies:', err.message);
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

  // Ensure symlink from mias/node_modules -> ../node_modules
  try {
    const miasNm = path.join(root, 'mias', 'node_modules');
    if (!fs.existsSync(miasNm)) {
      fs.symlinkSync('../node_modules', miasNm, 'junction');
    }
  } catch {}
}

try {
  ensureDependencies();
} catch (e) {
  // Silent fallback
}

module.exports = { ensureDependencies };
