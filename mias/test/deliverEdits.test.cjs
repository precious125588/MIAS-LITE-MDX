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

test('new categories (loveme, mood, lyrics, babe) and discipline aliases (mindset, motivation) are configured with no-reencode', () => {
  const newExpected = ['mindset', 'motivation', 'peak', 'loveme', 'mood', 'lyrics', 'lyric', 'babe', 'baby', 'bby'];
  for (const cat of newExpected) {
    assert.equal(edits.shouldSkipReencode(cat), true, `Expected ${cat} to skip reencode`);
  }
  
  // Discipline aliases and drleonkessel
  assert.ok(edits.CATEGORIES.discipline.aliases.includes('mindset'));
  assert.ok(edits.CATEGORIES.discipline.aliases.includes('motivation'));
  assert.ok(edits.CATEGORIES.discipline.usernames.includes('drleonkessel'));

  // Feeling creator
  assert.ok(edits.CATEGORIES.feeling.usernames.includes('gfx19386'));

  // Freefire creators
  assert.ok(edits.CATEGORIES.freefire.usernames.includes('arnaud.freefire.dancer'));
  assert.ok(edits.CATEGORIES.freefire.usernames.includes('nexuss_44'));

  // Cruise creator
  assert.ok(edits.CATEGORIES.cruise.usernames.includes('gigidroid001'));

  // FYP creator
  assert.ok(edits.CATEGORIES.fyp.usernames.includes('loveishere36'));

  // Peak creators
  assert.ok(edits.CATEGORIES.peak.usernames.includes('haykalrz'));
  assert.ok(edits.CATEGORIES.peak.usernames.includes('norx.ae'));
  assert.ok(edits.CATEGORIES.peak.usernames.includes('drxpz.aepp'));

  // New commands exist and have valid hashtags
  assert.ok(edits.CATEGORIES.loveme);
  assert.ok(edits.CATEGORIES.mood);
  assert.ok(edits.CATEGORIES.lyrics);
  assert.ok(edits.CATEGORIES.babe);
  assert.deepEqual(edits.CATEGORIES.babe.aliases, ['babe', 'baby', 'bby']);
});
