'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const edits = require('../precious-anime-edits.cjs');

test('NO_REENCODE_CATEGORIES set contains fyp, cruise, feeling, discipline and their aliases', () => {
  const expected = ['fyp', 'foryou', 'foryoupage', 'cruise', 'cruzz', 'techcruzz', 'feeling', 'discipline', 'discip'];
  for (const cat of expected) {
    assert.equal(edits.shouldSkipReencode(cat), true, `Expected ${cat} to skip reencode`);
  }
});

test('other categories do not skip reencode', () => {
  const normalCats = ['naruto', 'jjk', 'demonslayer', 'aot', 'onepiece', 'dragonball', 'bleach', 'blackclover', 'mha', 'sololeveling', 'cote', 'bluelock', 'onepunchman', 'sonic', 'fireforce', 'freefire'];
  for (const cat of normalCats) {
    assert.equal(edits.shouldSkipReencode(cat), false, `Expected ${cat} not to skip reencode`);
  }
});
