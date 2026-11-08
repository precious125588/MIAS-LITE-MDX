'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const NX = require('../lib/nexrayGate.cjs');

test('a background cooldown does not block interactive NexRay calls', () => {
  NX.markLimited(0, 'interactive');
  NX.markLimited(60 * 1000, 'background');
  assert.equal(NX.coolingDown('background'), true);
  assert.equal(NX.coolingDown('interactive'), false);
});

test('an interactive cooldown does not affect background checks', () => {
  NX.markLimited(0, 'background');
  NX.markLimited(60 * 1000, 'interactive');
  assert.equal(NX.coolingDown('interactive'), true);
  assert.equal(NX.coolingDown('background'), false);
});

test('a background call is not queued behind an interactive call', async () => {
  const order = [];
  const slow = NX.paced(async () => { await new Promise((r) => setTimeout(r, 300)); order.push('interactive'); }, 'interactive');
  const fast = NX.paced(async () => { order.push('background'); }, 'background');
  await Promise.all([slow, fast]);
  assert.deepEqual(order, ['background', 'interactive']);
});
