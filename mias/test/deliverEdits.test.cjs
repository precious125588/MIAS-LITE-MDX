'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const edits = require('../precious-anime-edits.cjs');

test('all status menu categories use the HD re-encode option and do not skip re-encoding', () => {
  const statusCats = [
    'fyp', 'foryou', 'foryoupage', 'cruise', 'cruzz', 'techcruzz', 'feeling', 'discipline', 'discip',
    'naruto', 'jjk', 'demonslayer', 'aot', 'onepiece', 'dragonball', 'bleach', 'blackclover',
    'mha', 'sololeveling', 'cote', 'bluelock', 'onepunchman', 'sonic', 'fireforce', 'freefire'
  ];
  for (const cat of statusCats) {
    assert.equal(edits.shouldSkipReencode(cat), false, `Expected status category ${cat} to not skip re-encoding`);
  }
});

test('status item objects also do not skip re-encode', () => {
  assert.equal(edits.shouldSkipReencode(null, { category: 'naruto' }), false);
  assert.equal(edits.shouldSkipReencode(null, { catKey: 'cruise' }), false);
});
