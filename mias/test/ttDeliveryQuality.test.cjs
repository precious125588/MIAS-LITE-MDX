'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const delivery = require('../lib/ttDelivery.cjs');

const hdBoost = delivery.HIGH_QUALITY_HD_BOOST;

test('native 1080p sources are detected as high quality', () => {
  const source = { width: 1920, height: 1080, shortSide: 1080, videoKbps: 584 };
  assert.equal(delivery.isHighQualitySource(source), true);
});

test('lower-resolution sources are not detected as high quality', () => {
  const source = { width: 1280, height: 720, shortSide: 720, videoKbps: 16000 };
  assert.equal(delivery.isHighQualitySource(source), false);
  assert.equal(delivery.pickHdBitrate(source, delivery.HD_BOOST, hdBoost), 19200);
});

test('unknown or invalid source probes use the existing HD reference bitrate', () => {
  assert.equal(delivery.pickHdBitrate(null, delivery.HD_BOOST, hdBoost), Math.round(delivery.HD_REFERENCE_KBPS * 1.2));
  assert.equal(delivery.pickHdBitrate({ width: 0, height: 0, shortSide: 0, videoKbps: null }, delivery.HD_BOOST, hdBoost), Math.round(delivery.HD_REFERENCE_KBPS * 1.2));
});

test("boost constants are configured: 1.2 for HD and SD (20% boost), 1.001 for 4K (0.001 boost)", () => {
  assert.equal(delivery.HD_BOOST, 1.2);
  assert.equal(delivery.NATIVE_HD_BOOST, 1.2);
  assert.equal(delivery.HIGH_QUALITY_HD_BOOST, 1.2);
  assert.equal(delivery.HIGH_QUALITY_4K_BOOST, 1.001);
});

test("HD sources with 1.0 boost preserve bitrate without artificial boost", () => {
  const source = { width: 1920, height: 1080, shortSide: 1080, videoKbps: 20000 };
  assert.equal(delivery.pickHdBitrate(source, delivery.HD_BOOST, 1.0), 20000);
});

test("Native 1080p sources above the reference keep the 1.2 boost", () => {
  const source = { width: 1920, height: 1080, shortSide: 1080, videoKbps: 20000 };
  assert.equal(delivery.pickHdBitrate(source, delivery.HD_BOOST, delivery.HIGH_QUALITY_HD_BOOST), 24000);
  assert.equal(delivery.pickHdBitrate(source, delivery.HD_BOOST, null), 24000);
});

test("Low-bitrate 1080p sources are lifted to the clean floor", () => {
  const source = { width: 1080, height: 1920, shortSide: 1080, videoKbps: 1030 };
  assert.equal(delivery.pickHdBitrate(source, delivery.HD_BOOST, delivery.HIGH_QUALITY_HD_BOOST), delivery.HD_CLEAN_FLOOR_KBPS);
});

test("60 s clips get the clean 3 Mb/s floor and stay under the 25 MB budget", () => {
  const source = { width: 1080, height: 1920, shortSide: 1080, videoKbps: 1030, durationSec: 60 };
  const kbps = delivery.pickHdBitrate(source, delivery.HD_BOOST, delivery.HIGH_QUALITY_HD_BOOST);
  assert.equal(kbps, 3000);
  assert.ok(((kbps + 190) * 1000 * 60) / 8 <= 25 * 1024 * 1024);
});

test("Clips up to 3 minutes stay under the 25 MB budget", () => {
  for (const sec of [15, 30, 60, 120, 180]) {
    const source = { width: 1080, height: 1920, shortSide: 1080, videoKbps: 1030, durationSec: sec };
    const kbps = delivery.pickHdBitrate(source, delivery.HD_BOOST, delivery.HIGH_QUALITY_HD_BOOST);
    assert.ok(((kbps + 190) * 1000 * sec) / 8 <= 25 * 1024 * 1024, `${sec}s at ${kbps} kb/s is over budget`);
  }
});

test("Very long clips drop to the minimum rate", () => {
  const source = { width: 1080, height: 1920, shortSide: 1080, videoKbps: 1030, durationSec: 600 };
  assert.equal(delivery.pickHdBitrate(source, delivery.HD_BOOST, delivery.HIGH_QUALITY_HD_BOOST), delivery.HD_MIN_KBPS);
});

test("all status categories use the HD re-encode option and do not skip re-encoding", () => {
  const edits = require("../precious-anime-edits.cjs");
  assert.equal(edits.shouldSkipReencode("fyp"), false);
  assert.equal(edits.shouldSkipReencode("cruise"), false);
  assert.equal(edits.shouldSkipReencode("feeling"), false);
  assert.equal(edits.shouldSkipReencode("discipline"), false);
  assert.equal(edits.shouldSkipReencode("foryou"), false);
  assert.equal(edits.shouldSkipReencode("cruzz"), false);
  assert.equal(edits.shouldSkipReencode("discip"), false);
  assert.equal(edits.shouldSkipReencode("naruto"), false);
  assert.equal(edits.shouldSkipReencode("jjk"), false);
  assert.equal(edits.shouldSkipReencode("bleach"), false);
  assert.equal(edits.shouldSkipReencode("onepiece"), false);
});
