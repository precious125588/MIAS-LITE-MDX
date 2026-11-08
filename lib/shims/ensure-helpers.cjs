'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

const shimDir = path.resolve(__dirname, 'call-bind-apply-helpers');

function copyDirSync(src, dst) {
  try {
    fs.mkdirSync(dst, { recursive: true });
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const dstPath = path.join(dst, entry.name);
      if (entry.isDirectory()) {
        copyDirSync(srcPath, dstPath);
      } else {
        fs.copyFileSync(srcPath, dstPath);
      }
    }
    return true;
  } catch {
    return false;
  }
}

function ensureOnDisk() {
  const rootDir = path.resolve(__dirname, '..', '..');
  const targetRoots = [
    path.join(rootDir, 'node_modules', 'call-bind-apply-helpers'),
    path.join(rootDir, 'mias', 'node_modules', 'call-bind-apply-helpers')
  ];

  for (const target of targetRoots) {
    const parentDir = path.dirname(target);
    if (!fs.existsSync(parentDir)) continue;
    if (!fs.existsSync(path.join(target, 'index.js')) || !fs.existsSync(path.join(target, 'actualApply.js'))) {
      copyDirSync(shimDir, target);
    }
  }
}

function installResolveHook() {
  if (Module.__callBindApplyHelpersHookInstalled) return;
  Module.__callBindApplyHelpersHookInstalled = true;

  const origResolveFilename = Module._resolveFilename;

  Module._resolveFilename = function (request, parent, isMain, options) {
    try {
      return origResolveFilename.call(this, request, parent, isMain, options);
    } catch (err) {
      if (request === 'call-bind-apply-helpers') {
        return path.join(shimDir, 'index.js');
      }
      if (request.startsWith('call-bind-apply-helpers/')) {
        const subpath = request.slice('call-bind-apply-helpers/'.length);
        const candidate = path.join(shimDir, subpath.endsWith('.js') ? subpath : `${subpath}.js`);
        if (fs.existsSync(candidate)) return candidate;
        const candidateRaw = path.join(shimDir, subpath);
        if (fs.existsSync(candidateRaw)) return candidateRaw;
      }
      throw err;
    }
  };
}

try {
  ensureOnDisk();
  installResolveHook();
} catch (e) {
  // Silent fallback
}

module.exports = {
  ensureOnDisk,
  installResolveHook,
  shimDir
};
