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
