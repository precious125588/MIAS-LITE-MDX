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
  assert.match(src, /\${username\} with the \${cmd\} \${vidWord\}/);
});

test('new categories (loveme, mood, lyrics, babe) do NOT skip re-encode so they bloat like other status commands', () => {
  const bloatCats = ['loveme', 'mood', 'lyrics', 'lyric', 'babe', 'baby', 'bby'];
  for (const cat of bloatCats) {
    assert.equal(edits.shouldSkipReencode(cat), false, `Expected ${cat} to NOT skip re-encode (bloat via HD 1.3)`);
  }
  // Mindset, motivation, peak remain in no-reencode
  assert.equal(edits.shouldSkipReencode('mindset'), true);
  assert.equal(edits.shouldSkipReencode('motivation'), true);
  assert.equal(edits.shouldSkipReencode('peak'), true);
});

test('isPhotoSlider detects and rejects photo sliders / image slideshows', () => {
  assert.equal(edits.isPhotoSlider({ images: ['https://example.com/1.jpg', 'https://example.com/2.jpg'] }), true);
  assert.equal(edits.isPhotoSlider({ image_post_info: { images: ['https://example.com/1.jpg'] } }), true);
  assert.equal(edits.isPhotoSlider({ is_slider: true }), true);
  assert.equal(edits.isPhotoSlider({ type: 'image' }), true);
  assert.equal(edits.isPhotoSlider({ play: 'https://example.com/audio.mp3' }), true);
  assert.equal(edits.isPhotoSlider({ play: 'https://example.com/video.mp4' }), false);
});

test('qualityOk avoids videos below 1k likes', () => {
  // Below 1k likes -> rejected
  assert.equal(edits.qualityOk({ digg_count: 500 }), false);
  assert.equal(edits.qualityOk({ stats: { likes: 999, views: 50000 } }), false);
  // >= 1k likes -> accepted
  assert.equal(edits.qualityOk({ digg_count: 1000 }), true);
  assert.equal(edits.qualityOk({ stats: { likes: 1500 } }), true);
  // Photo slider -> rejected
  assert.equal(edits.qualityOk({ digg_count: 5000, is_slider: true }), false);
});

test('pickUnseen shuffles top rated candidates and avoids duplicate drops across users', () => {
  const pool = [
    { url: 'https://www.tiktok.com/@a/video/1000000000000001', cid: 'v1', digg_count: 50000, play_count: 200000 },
    { url: 'https://www.tiktok.com/@b/video/1000000000000002', cid: 'v2', digg_count: 40000, play_count: 150000 },
    { url: 'https://www.tiktok.com/@c/video/1000000000000003', cid: 'v3', digg_count: 30000, play_count: 100000 },
    { url: 'https://www.tiktok.com/@d/video/1000000000000004', cid: 'v4', digg_count: 20000, play_count: 80000 },
    { url: 'https://www.tiktok.com/@e/video/1000000000000005', cid: 'v5', digg_count: 10000, play_count: 50000 },
    { url: 'https://www.tiktok.com/@f/video/1000000000000006', cid: 'v6', digg_count: 500, play_count: 20000 }, // <1k likes should be filtered out
  ];

  // User 1 requests babe
  const picksUser1 = edits.pickUnseen('user1@s.whatsapp.net', 'babe', pool, 2);
  assert.equal(picksUser1.length, 2);
  // Filtered out item with 500 likes
  assert.ok(picksUser1.every(x => x.cid !== 'v6'));

  // Record delivery for User 1
  edits.recordRecentDelivered('babe', picksUser1.map(x => edits.contentKeyOf(x)));

  // User 2 requests babe right after
  const picksUser2 = edits.pickUnseen('user2@s.whatsapp.net', 'babe', pool, 2);
  assert.equal(picksUser2.length, 2);

  // User 1 and User 2 should NOT get the same videos
  const user1Keys = new Set(picksUser1.map(x => edits.contentKeyOf(x)));
  const user2Keys = new Set(picksUser2.map(x => edits.contentKeyOf(x)));
  for (const k of user1Keys) {
    assert.equal(user2Keys.has(k), false, 'User 2 received a video that User 1 just received!');
  }
});
