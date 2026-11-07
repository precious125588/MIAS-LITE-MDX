'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const edits = require('../precious-anime-edits.cjs');

test('all status menu categories bypass re-encoding and send as original file', () => {
  const statusCats = [
    'fyp', 'foryou', 'foryoupage', 'cruise', 'cruzz', 'techcruzz', 'feeling', 'discipline', 'discip',
    'naruto', 'jjk', 'demonslayer', 'aot', 'onepiece', 'dragonball', 'bleach', 'blackclover',
    'mha', 'sololeveling', 'cote', 'bluelock', 'onepunchman', 'sonic', 'fireforce', 'freefire'
  ];
  for (const cat of statusCats) {
    assert.equal(edits.shouldSkipReencode(cat), true, `Expected status category ${cat} to skip reencode and send original file`);
  }
});

test('status item objects also skip re-encode', () => {
  assert.equal(edits.shouldSkipReencode(null, { category: 'naruto' }), true);
  assert.equal(edits.shouldSkipReencode(null, { catKey: 'cruise' }), true);
});
