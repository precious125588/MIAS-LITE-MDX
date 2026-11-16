'use strict';
/* ── CACHED CONTACTS FILE READER & INDEX ───────────────────────────────────────
   getSavedContactName used to read and split the whole contacts.vcf file for
   every lookup that was not already cached. For accounts with many contacts,
   and for unsaved senders in busy groups, that happened several times per
   message. This keeps the non-empty lines in memory and maintains an indexed
   Map of phone number / waid -> FN display name, refreshing only when the file
   size or modification time changes.
   ──────────────────────────────────────────────────────────────────────────── */

const fs = require('node:fs');

let cache = { file: null, mtimeMs: -1, size: -1, lines: [] };
let indexCache = { file: null, mtimeMs: -1, size: -1, map: new Map() };

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

function getContactMap(file) {
  let stat;
  try { stat = fs.statSync(file); } catch (_) { return new Map(); }
  if (indexCache.file === file && indexCache.mtimeMs === stat.mtimeMs && indexCache.size === stat.size) {
    return indexCache.map;
  }
  const lines = vcfLines(file);
  const map = new Map();
  let currentFn = '';
  let currentWaid = '';

  for (const line of lines) {
    if (line.startsWith('BEGIN:VCARD')) {
      currentFn = '';
      currentWaid = '';
      continue;
    }
    if (line.startsWith('FN:')) {
      currentFn = line.slice(3).trim();
    } else if (line.includes('waid=')) {
      const match = line.match(/waid=(\d+)/);
      if (match) {
        currentWaid = match[1];
      }
    } else if (line.startsWith('TEL')) {
      const match = line.match(/(?:\+|TEL[^:]*:)\s*(\d+)/);
      if (match && !currentWaid) {
        currentWaid = match[1];
      }
    }
    if (line.startsWith('END:VCARD')) {
      if (currentWaid && currentFn) {
        map.set(currentWaid, currentFn);
      }
      currentFn = '';
      currentWaid = '';
    }
  }

  // Handle flat or single-entry files that might lack standard BEGIN/END delimiters
  if (!map.size && lines.length) {
    let fn = '';
    for (const l of lines) {
      if (l.startsWith('FN:')) fn = l.slice(3).trim();
      const m = l.match(/waid=(\d+)/);
      if (m && fn) map.set(m[1], fn);
    }
  }

  indexCache = { file, mtimeMs: stat.mtimeMs, size: stat.size, map };
  return map;
}

function lookupContact(file, phoneOrWaid) {
  if (!phoneOrWaid) return '';
  const clean = String(phoneOrWaid).replace(/\D/g, '');
  if (!clean) return '';
  const map = getContactMap(file);
  return map.get(clean) || '';
}

module.exports = { vcfLines, getContactMap, lookupContact };
