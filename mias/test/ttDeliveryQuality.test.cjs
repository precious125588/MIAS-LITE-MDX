'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const delivery = require('../lib/ttDelivery.cjs');
const { processVideoTo4k } = require('../lib/tt4kVideo.cjs');

const hdBoost = delivery.HIGH_QUALITY_HD_BOOST;

test('native 1080p sources are detected as high quality', () => {
  const source = { width: 1920, height: 1080, shortSide: 1080, videoKbps: 584 };
  assert.equal(delivery.isHighQualitySource(source), true);
});

test('lower-resolution sources are not detected as high quality', () => {
  const source = { width: 1280, height: 720, shortSide: 720, videoKbps: 16000 };
  assert.equal(delivery.isHighQualitySource(source), false);
  assert.equal(delivery.pickHdBitrate(source, delivery.HD_BOOST, hdBoost), delivery.HD_REFERENCE_KBPS);
});

test('unknown or invalid source probes use the existing HD reference bitrate', () => {
  assert.equal(delivery.pickHdBitrate(null, delivery.HD_BOOST, hdBoost), delivery.HD_REFERENCE_KBPS);
  assert.equal(delivery.pickHdBitrate({ width: 0, height: 0, shortSide: 0, videoKbps: null }, delivery.HD_BOOST, hdBoost), delivery.HD_REFERENCE_KBPS);
});

test('high quality videos are left untouched by reencodeHdForWhatsApp', async () => {
  const samplePath = '/tmp/test_tiktok.mp4';
  if (fs.existsSync(samplePath)) {
    const originalStat = fs.statSync(samplePath);
    const result = await delivery.reencodeHdForWhatsApp(samplePath);
    assert.equal(result.untouched, true);
    assert.equal(result.bytes, originalStat.size);
    await result.cleanup();
  }
});

test('high quality videos are left untouched by processVideoTo4k', async () => {
  const samplePath = '/tmp/test_tiktok.mp4';
  if (fs.existsSync(samplePath)) {
    const originalStat = fs.statSync(samplePath);
    const result = await processVideoTo4k(samplePath);
    assert.equal(result.untouched, true);
    assert.equal(result.bytes, originalStat.size);
    result.cleanup();
  }
});


test("0.2% boost constants are configured for HD delivery", () => {
  assert.equal(delivery.HD_BOOST, 1.002);
  assert.equal(delivery.HIGH_QUALITY_HD_BOOST, 1.002);
});

test("HD sources at or above reference bitrate encode by 0.2%", () => {
  const source = { width: 1920, height: 1080, shortSide: 1080, videoKbps: 20000 };
  const expectedBitrate = Math.round(20000 * 1.002); // 20040 kb/s (0.2% boost)
  assert.equal(delivery.pickHdBitrate(source, delivery.HD_BOOST, null), expectedBitrate);
  assert.equal(delivery.pickHdBitrate(source, delivery.HD_BOOST, delivery.HIGH_QUALITY_HD_BOOST), expectedBitrate);
});

test("fyp, cruise, feeling, discipline bypass re-encoding while other categories do not", () => {
  const edits = require("../precious-anime-edits.cjs");
  assert.equal(edits.shouldSkipReencode("fyp"), true);
  assert.equal(edits.shouldSkipReencode("cruise"), true);
  assert.equal(edits.shouldSkipReencode("feeling"), true);
  assert.equal(edits.shouldSkipReencode("discipline"), true);
  assert.equal(edits.shouldSkipReencode("foryou"), true);
  assert.equal(edits.shouldSkipReencode("cruzz"), true);
  assert.equal(edits.shouldSkipReencode("discip"), true);

  // The rest are re-encoded (e.g. naruto, jjk, bleach, onepiece)
  assert.equal(edits.shouldSkipReencode("naruto"), false);
  assert.equal(edits.shouldSkipReencode("jjk"), false);
  assert.equal(edits.shouldSkipReencode("bleach"), false);
  assert.equal(edits.shouldSkipReencode("onepiece"), false);
});
