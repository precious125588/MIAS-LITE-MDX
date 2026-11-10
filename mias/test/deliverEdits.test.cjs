'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const edits = require('../precious-anime-edits.cjs');

test('NO_REENCODE_CATEGORIES set contains fyp, cruise, feeling, discipline and their aliases and skips re-encoding', () => {
  const expected = ['fyp', 'foryou', 'foryoupage', 'cruise', 'cruzz', 'techcruzz', 'feeling', 'discipline', 'discip'];
  for (const cat of expected) {
    assert.equal(edits.shouldSkipReencode(cat), true, `Expected ${cat} to skip reencode and send original video`);
  }
});

test('other anime/status categories do not skip reencode and use HD 1.3 re-encoding', () => {
  const normalCats = ['naruto', 'jjk', 'demonslayer', 'aot', 'onepiece', 'dragonball', 'bleach', 'blackclover', 'mha', 'sololeveling', 'cote', 'bluelock', 'onepunchman', 'sonic', 'fireforce', 'freefire'];
  for (const cat of normalCats) {
    assert.equal(edits.shouldSkipReencode(cat), false, `Expected ${cat} not to skip reencode`);
  }
});

test('status item objects correctly respect skip re-encode for fyp/cruise/feeling/discipline', () => {
  assert.equal(edits.shouldSkipReencode(null, { category: 'naruto' }), false);
  assert.equal(edits.shouldSkipReencode(null, { catKey: 'cruise' }), true);
  assert.equal(edits.shouldSkipReencode(null, { category: 'fyp' }), true);
  assert.equal(edits.shouldSkipReencode(null, { catKey: 'discipline' }), true);
  assert.equal(edits.shouldSkipReencode(null, { catKey: 'feeling' }), true);
});

test('anime edit logger formats cleanly and eliminates debug spam lines', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '../precious-anime-edits.cjs'), 'utf8');

  // Verify spam log patterns are absent
  assert.equal(src.includes('[anime-edits][pick]'), false);
  assert.equal(src.includes('[anime-edits][download]'), false);
  assert.equal(src.includes('[anime-edits][sent]'), false);
  assert.equal(src.includes('[anime-edits][failed]'), false);
  assert.equal(src.includes('[anime-edits][deliver]'), false);

  // Verify concise user log format
  assert.match(src, /\$\{username\} with the \$\{cmd\} \$\{vidWord\}/);
});
