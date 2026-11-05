// =========================================================================
//  editMatch.cjs — category matching and pick spreading for anime edits.
//
//  • Tags match whole words only. "aot" never matches "otsutsuki" and
//    "eren" never matches "different", which is how Naruto edits leaked
//    into .aot before.
//  • Tags of six or more letters also match compound hashtags, so
//    "#attackontitanedit" counts as "attackontitan".
//  • spreadPicks() puts one item per creator/source first, so two deliveries
//    come from different creators or sources when the pool allows it.
// =========================================================================
'use strict';

// Short tags (under 6 letters: "aot", "eren", "levi", "hange") match whole
// words only. Longer tags also match compound hashtags such as
// "#borutonextgeneration" or "#attackontitanedit".
const LONG_TAG = 6;
const COMPOUND_MAX = 20;

// Whole-word tokens from caption, hashtags and title. Hashtags written with
// "_" or "-" are kept both joined ("jjk_edit" -> "jjkedit") and split.
function tokensOf(item) {
  const text = [item && item.caption, item && item.hashtags, item && item.title]
    .filter(Boolean).join(' ').toLowerCase();
  const out = new Set();
  for (const chunk of text.split(/[^a-z0-9_\-]+/)) {
    if (!chunk) continue;
    out.add(chunk.replace(/[_\-]/g, ''));
    for (const part of chunk.split(/[_\-]+/)) if (part) out.add(part);
  }
  out.delete('');
  return out;
}

function hasTag(tokens, tag) {
  const key = String(tag || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!key) return false;
  if (tokens.has(key)) return true;
  // Generic "edit" tags also count compound hashtags such as "#animeedit".
  if (key === 'edit' || key === 'edits') {
    for (const t of tokens) if (/^.{3,}edits?$/.test(t)) return true;
    return false;
  }
  if (key.length < LONG_TAG) return false;
  for (const t of tokens) {
    if ((t.startsWith(key) || t.endsWith(key)) && t.length - key.length <= COMPOUND_MAX) return true;
  }
  return false;
}

// Same rule as before: the item needs a tag of the category. If it also
// carries another franchise's exclusive marker, it needs the target's marker
// too (a real crossover). Matching is now whole-word.
function matchesCategory(item, cat, franchiseMarkers = {}) {
  const tokens = tokensOf(item);
  if (!cat.tags.some(tag => hasTag(tokens, tag))) return false;
  const targetKey = Object.keys(franchiseMarkers).find(k => cat.tags.some(tg => tg.includes(k)));
  if (targetKey) {
    const targetMarkers = franchiseMarkers[targetKey];
    for (const [otherKey, otherMarkers] of Object.entries(franchiseMarkers)) {
      if (otherKey === targetKey) continue;
      if (otherMarkers.some(m => hasTag(tokens, m))) {
        if (!targetMarkers.some(m => hasTag(tokens, m))) return false;
      }
    }
  }
  return true;
}

function sourceGroupOf(item) {
  return String((item && item.src) || 'other') + (item && item.creator ? '@' + item.creator : '');
}

// First pass: one item from each creator/source. Second pass: fill the rest.
function spreadPicks(picks, n = picks.length) {
  const out = [];
  const used = new Set();
  for (const it of picks) {
    const g = sourceGroupOf(it);
    if (!used.has(g)) { used.add(g); out.push(it); }
  }
  for (const it of picks) {
    if (out.length >= n) break;
    if (!out.includes(it)) out.push(it);
  }
  return out.slice(0, n);
}

module.exports = { LONG_TAG, COMPOUND_MAX, tokensOf, hasTag, matchesCategory, sourceGroupOf, spreadPicks };
