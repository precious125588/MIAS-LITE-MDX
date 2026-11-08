try { require('../ensure-dependencies.cjs'); } catch (e) {}
'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

const shimsBaseDir = __dirname;
const helpersShimDir = path.resolve(shimsBaseDir, 'call-bind-apply-helpers');
const boundShimDir = path.resolve(shimsBaseDir, 'call-bound');
const bindShimDir = path.resolve(shimsBaseDir, 'call-bind');

function copyDirSync(src, dst) {
  try {
    if (!fs.existsSync(src)) return false;
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
  const packages = [
    { name: 'call-bind-apply-helpers', src: helpersShimDir },
    { name: 'call-bound', src: boundShimDir },
    { name: 'call-bind', src: bindShimDir }
  ];

  const targetRoots = [
    path.join(rootDir, 'node_modules'),
    path.join(rootDir, 'mias', 'node_modules')
  ];

  for (const nmDir of targetRoots) {
    if (!fs.existsSync(nmDir)) continue;
    for (const pkg of packages) {
      const target = path.join(nmDir, pkg.name);
      if (!fs.existsSync(path.join(target, 'index.js'))) {
        copyDirSync(pkg.src, target);
      }
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
        return path.join(helpersShimDir, 'index.js');
      }
      if (request.startsWith('call-bind-apply-helpers/')) {
        const subpath = request.slice('call-bind-apply-helpers/'.length);
        const candidate = path.join(helpersShimDir, subpath.endsWith('.js') ? subpath : `${subpath}.js`);
        if (fs.existsSync(candidate)) return candidate;
        const candidateRaw = path.join(helpersShimDir, subpath);
        if (fs.existsSync(candidateRaw)) return candidateRaw;
      }
      if (request === 'call-bound') {
        return path.join(boundShimDir, 'index.js');
      }
      if (request === 'call-bind') {
        return path.join(bindShimDir, 'index.js');
      }
      if (request === 'call-bind/callBound') {
        const cb = path.join(bindShimDir, 'callBound.js');
        if (fs.existsSync(cb)) return cb;
        return path.join(boundShimDir, 'index.js');
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
  helpersShimDir,
  boundShimDir,
  bindShimDir
};
