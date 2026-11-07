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

test("boost constants are configured: 0.0001 for standard and native HD, 0.001 for 4K", () => {
  assert.equal(delivery.HD_BOOST, 1.0001);
  assert.equal(delivery.NATIVE_HD_BOOST, 1.0001);
  assert.equal(delivery.HIGH_QUALITY_HD_BOOST, 1.0001);
  assert.equal(delivery.HIGH_QUALITY_4K_BOOST, 1.001);
});

test("HD sources with 0.0001 boost encode at 1.0001", () => {
  const source = { width: 1920, height: 1080, shortSide: 1080, videoKbps: 20000 };
  const expectedBitrate = Math.round(20000 * 1.0001); // 20002 kb/s (0.0001 boost)
  assert.equal(delivery.pickHdBitrate(source, delivery.HD_BOOST, 1.0001), expectedBitrate);
});

test("Native 1080p videos encode by 0.0001", () => {
  const source = { width: 1920, height: 1080, shortSide: 1080, videoKbps: 5000 };
  const expectedBitrate = Math.round(5000 * 1.0001); // 5001 kb/s (0.0001 boost)
  assert.equal(delivery.pickHdBitrate(source, delivery.HD_BOOST, delivery.HIGH_QUALITY_HD_BOOST), expectedBitrate);
  assert.equal(delivery.pickHdBitrate(source, delivery.HD_BOOST, null), expectedBitrate);
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
