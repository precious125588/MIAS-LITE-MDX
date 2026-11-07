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
  assert.equal(delivery.pickHdBitrate(source, delivery.HD_BOOST, hdBoost), delivery.HD_REFERENCE_KBPS);
});

test('unknown or invalid source probes use the existing HD reference bitrate', () => {
  assert.equal(delivery.pickHdBitrate(null, delivery.HD_BOOST, hdBoost), delivery.HD_REFERENCE_KBPS);
  assert.equal(delivery.pickHdBitrate({ width: 0, height: 0, shortSide: 0, videoKbps: null }, delivery.HD_BOOST, hdBoost), delivery.HD_REFERENCE_KBPS);
});

test("boost constants are configured: 1.0 for HD (no brightness boost), 1.001 for 4K (0.001 boost)", () => {
  assert.equal(delivery.HD_BOOST, 1.0);
  assert.equal(delivery.NATIVE_HD_BOOST, 1.0);
  assert.equal(delivery.HIGH_QUALITY_HD_BOOST, 1.0);
  assert.equal(delivery.HIGH_QUALITY_4K_BOOST, 1.001);
});

test("HD sources with 1.0 boost preserve bitrate without artificial boost", () => {
  const source = { width: 1920, height: 1080, shortSide: 1080, videoKbps: 20000 };
  assert.equal(delivery.pickHdBitrate(source, delivery.HD_BOOST, 1.0), 20000);
});

test("Native 1080p videos preserve original bitrate with 1.0 boost", () => {
  const source = { width: 1920, height: 1080, shortSide: 1080, videoKbps: 5000 };
  assert.equal(delivery.pickHdBitrate(source, delivery.HD_BOOST, delivery.HIGH_QUALITY_HD_BOOST), 5000);
  assert.equal(delivery.pickHdBitrate(source, delivery.HD_BOOST, null), 5000);
});

test("all status categories bypass re-encoding and send as original file", () => {
  const edits = require("../precious-anime-edits.cjs");
  assert.equal(edits.shouldSkipReencode("fyp"), true);
  assert.equal(edits.shouldSkipReencode("cruise"), true);
  assert.equal(edits.shouldSkipReencode("feeling"), true);
  assert.equal(edits.shouldSkipReencode("discipline"), true);
  assert.equal(edits.shouldSkipReencode("foryou"), true);
  assert.equal(edits.shouldSkipReencode("cruzz"), true);
  assert.equal(edits.shouldSkipReencode("discip"), true);
  assert.equal(edits.shouldSkipReencode("naruto"), true);
  assert.equal(edits.shouldSkipReencode("jjk"), true);
  assert.equal(edits.shouldSkipReencode("bleach"), true);
  assert.equal(edits.shouldSkipReencode("onepiece"), true);
});
