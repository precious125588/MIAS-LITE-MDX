'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const delivery = require('../lib/ttDelivery.cjs');

const hdBoost = delivery.HIGH_QUALITY_HD_BOOST;

test('native 1080p sources get only the gentle 1% HD bitrate increase', () => {
  const source = { width: 1920, height: 1080, shortSide: 1080, videoKbps: 584 };
  assert.equal(delivery.isHighQualitySource(source), true);
  assert.equal(delivery.pickHdBitrate(source, delivery.HD_BOOST, hdBoost), 590);
});

test('lower-resolution sources keep the existing HD reference path', () => {
  const source = { width: 1280, height: 720, shortSide: 720, videoKbps: 16000 };
  assert.equal(delivery.isHighQualitySource(source), false);
  assert.equal(delivery.pickHdBitrate(source, delivery.HD_BOOST, hdBoost), delivery.HD_REFERENCE_KBPS);
});

test('unknown or invalid source probes use the existing HD reference bitrate', () => {
  assert.equal(delivery.pickHdBitrate(null, delivery.HD_BOOST, hdBoost), delivery.HD_REFERENCE_KBPS);
  assert.equal(delivery.pickHdBitrate({ width: 0, height: 0, shortSide: 0, videoKbps: null }, delivery.HD_BOOST, hdBoost), delivery.HD_REFERENCE_KBPS);
});

test('legacy callers keep their prior boost behavior when no source-quality override is supplied', () => {
  const source = { width: 1920, height: 1080, shortSide: 1080, videoKbps: 22000 };
  assert.equal(delivery.pickHdBitrate(source), 23100);
});
