'use strict';

const fs = require('fs');
const path = require('path');

function ensureDependencies(rootDir) {
  const root = rootDir || path.resolve(__dirname, '..');
  // Runtime boot must never launch npm once per package. Dependency installation
  // belongs in robust-install.sh, which runs one lockfile-based install before startup.
  // Keep this helper limited to cheap on-disk compatibility shims.

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
