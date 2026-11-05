'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   lib/boot-audit.cjs — REAL boot audit.

   Replaces the old "[manifest] N files loaded, 0 failed" report, which was
   fake: it called require('module').createRequire(abs), a call that only
   builds a resolver and NEVER reads or parses the file, so every file always
   "loaded". This module actually reads and compiles every runtime source file
   and reports exactly what passed and what failed, with the real error.

   Checks performed per file (no side effects — nothing is executed):
     1. the file exists and is readable
     2. the source compiles (real V8 parse via vm.Script + Module.wrap)

   Output:
     [BOOT] <N> files loaded
     [BOOT] <M> failed
     [BOOT] FAILED 1/M: path/to/file.js — SyntaxError: ...
   ══════════════════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Module = require('module');

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.github', 'media', 'stickers', 'database',
  'nexstore', 'nexstore_modules', 'tmp', 'temp', 'coverage', 'dist', 'build',
  'public', 'artifacts', 'session', 'sessions',
]);

const EXTS = new Set(['.js', '.cjs', '.mjs']);

function walk(root, dir, out) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      walk(root, abs, out);
    } else if (e.isFile() && EXTS.has(path.extname(e.name))) {
      out.push(path.relative(root, abs).split(path.sep).join('/'));
    }
  }
  return out;
}

/* ESM files cannot be compiled in script mode. Neutralise only the top-level
   import/export grammar (replacing it with same-length filler so reported
   line/column numbers stay true) and compile everything else for real. */
function neutraliseModuleSyntax(src) {
  const blank = (m) => m.replace(/[^\n]/g, ' ');
  return src
    .replace(/^[ \t]*import\s+[^;'"]*from\s*['"][^'"]*['"];?/gm, blank)
    .replace(/^[ \t]*import\s*['"][^'"]*['"];?/gm, blank)
    .replace(/^[ \t]*export\s*\*\s*(as\s+[A-Za-z0-9_$]+\s*)?from\s*['"][^'"]*['"];?/gm, blank)
    .replace(/^[ \t]*export\s*\{[^}]*\}\s*(from\s*['"][^'"]*['"])?;?/gm, blank)
    .replace(/^([ \t]*)export\s+default\s+/gm, (m, i) => i + 'module.exports =' + ' '.repeat(Math.max(0, m.length - i.length - 16)))
    .replace(/^([ \t]*)export\s+(?=(const|let|var|function|class|async))/gm, (m, i) => i + '       ')
    .replace(/\bimport\.meta\b/g, '({url:""})');
}

/* Compile-check one file. Returns null on success, or a real error string. */
function checkFile(root, rel) {
  const abs = path.join(root, rel);
  let src;
  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) return 'not a file';
    src = fs.readFileSync(abs, 'utf8');
  } catch (e) {
    return (e && e.code === 'ENOENT') ? 'missing' : ((e && e.message) || 'unreadable');
  }
  if (!src.trim()) return 'empty file';

  // strip BOM + shebang (both legal in Node, illegal inside a vm.Script wrap)
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);
  if (src.startsWith('#!')) src = '//' + src.slice(2);

  const looksESM = path.extname(rel) === '.mjs' ||
    /^[ \t]*(import\s[^;]*from\s|import\s*['"]|export\s+(default|const|let|var|function|class|async|\*|\{))/m.test(src);

  // CommonJS is compiled in its real module wrapper. Module-syntax files are
  // compiled inside an async wrapper so top-level await and their own
  // `const require = createRequire(...)` shims stay legal.
  const compileCjs = (text) => { new vm.Script(Module.wrap(text), { filename: abs }); };
  const compileEsm = (text) => {
    new vm.Script('(async function(){\n' + text + '\n})', { filename: abs });
  };

  try {
    if (looksESM) compileEsm(neutraliseModuleSyntax(src));
    else compileCjs(src);
    return null;
  } catch (e) {
    if (!looksESM) {
      // A CommonJS-looking file may still use module syntax further down.
      try { compileEsm(neutraliseModuleSyntax(src)); return null; } catch (_) {}
    }
    const name = (e && e.name) || 'Error';
    const msg = (e && e.message) || String(e);
    return name + ': ' + msg.split('\n')[0];
  }
}

/**
 * Audit every runtime source file under `root`.
 * @param {object} opts { root, label, extra (array of required rel paths) }
 * @returns {{ total:number, loaded:number, failed:Array<{file:string,reason:string}> }}
 */
function audit(opts) {
  opts = opts || {};
  const root = opts.root || path.resolve(__dirname, '..');
  const label = opts.label || 'BOOT';

  const files = walk(root, root, []);
  // Files the app REQUIRES to exist — reported as failures when absent even
  // though a missing file cannot be found by walking the tree.
  for (const rel of (opts.required || [])) {
    if (!files.includes(rel)) files.push(rel);
  }
  files.sort();

  const failed = [];
  let loaded = 0;
  for (const rel of files) {
    const reason = checkFile(root, rel);
    if (reason) failed.push({ file: rel, reason });
    else loaded++;
  }

  console.log('[' + label + '] ' + loaded + ' files loaded');
  console.log('[' + label + '] ' + failed.length + ' failed');
  failed.forEach((f, i) => {
    console.log('[' + label + '] FAILED ' + (i + 1) + '/' + failed.length + ': ' + f.file + ' — ' + f.reason);
  });

  return { total: files.length, loaded, failed };
}

module.exports = { audit, checkFile, walk };
