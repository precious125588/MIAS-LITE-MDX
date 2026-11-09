'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const delivery = require('../lib/ttDelivery.cjs');

test('HD_ARGS does not contain harmful aresample hard-compensation filter', () => {
  const args = delivery.HD_ARGS('in.mp4', 'out.mp4', 3000, { copyAudio: false });
  const joined = args.join(' ');
  assert.equal(joined.includes('min_hard_comp'), false, 'Should not contain min_hard_comp');
  assert.equal(joined.includes('aresample=async=1000'), false, 'Should not contain harmful aresample filter');
});

test('HD_ARGS uses cfr frame rate mode to prevent video stutter and dropped frames', () => {
  const args = delivery.HD_ARGS('in.mp4', 'out.mp4', 3000);
  const fpsModeIndex = args.indexOf('-fps_mode');
  assert.ok(fpsModeIndex >= 0, '-fps_mode must be defined');
  assert.equal(args[fpsModeIndex + 1], 'cfr', 'Expected -fps_mode cfr');
});

test('HD_ARGS selects stream copy when copyAudio is true for AAC sources', () => {
  const argsAac = delivery.HD_ARGS('in.mp4', 'out.mp4', 3000, { copyAudio: true });
  const audioCodecIdx = argsAac.indexOf('-c:a');
  assert.ok(audioCodecIdx >= 0, '-c:a must be specified');
  assert.equal(argsAac[audioCodecIdx + 1], 'copy', 'Expected -c:a copy for AAC');
});

test('HD_ARGS falls back to clean AAC encoding when copyAudio is false', () => {
  const argsOther = delivery.HD_ARGS('in.mp4', 'out.mp4', 3000, { copyAudio: false });
  const audioCodecIdx = argsOther.indexOf('-c:a');
  assert.ok(audioCodecIdx >= 0, '-c:a must be specified');
  assert.equal(argsOther[audioCodecIdx + 1], 'aac', 'Expected -c:a aac');
  assert.ok(argsOther.includes('-ar'), 'Expected sample rate setting');
  assert.ok(argsOther.includes('48000'), 'Expected 48000 Hz');
});

test('probeSourceVideo detects audioCodec from media', async () => {
  // If /tmp/source.mp4 exists in environment, verify with it
  if (fs.existsSync('/tmp/source.mp4')) {
    const probe = await delivery.probeSourceVideo('/tmp/source.mp4');
    assert.ok(probe, 'Probe should succeed');
    assert.equal(probe.audioCodec, 'aac', 'Should detect aac audio codec');
  }
});
