'use strict';
/* ── CACHED CONTACTS FILE READER ─────────────────────────────────────────────
   getSavedContactName used to read and split the whole contacts.vcf file for
   every lookup that was not already cached. For accounts with many contacts,
   and for unsaved senders in busy groups, that happened several times per
   message. This keeps the non-empty lines in memory and re-reads the file only
   when its size or modification time changes.
   ──────────────────────────────────────────────────────────────────────────── */

const fs = require('node:fs');

let cache = { file: null, mtimeMs: -1, size: -1, lines: [] };

function vcfLines(file) {
  let stat;
  try { stat = fs.statSync(file); } catch (_) { return []; }
  if (cache.file === file && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) {
    return cache.lines;
  }
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  cache = { file, mtimeMs: stat.mtimeMs, size: stat.size, lines };
  return lines;
}

module.exports = { vcfLines };
