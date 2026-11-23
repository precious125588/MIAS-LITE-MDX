'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const edits = require('../precious-anime-edits.cjs');

const item = (id, src = 'zip', creator = '') => ({
  url: `https://www.tiktok.com/@${creator || 'user' + id}/video/${id}`,
  src,
  cid: 'c_' + id,
});

test('a failed candidate is skipped and the next one is returned', () => {
  const plan = edits.makeDeliveryPlan([item('1', 'zip'), item('2', 'zip'), item('3', 'zip')]);
  const first = plan.next();
  plan.failed(first);
  const second = plan.next();
  assert.ok(second, 'a candidate should still be available after a failure');
  assert.notEqual(second.key, first.key);
  plan.failed(second);
  const third = plan.next();
  assert.ok(third);
  assert.notEqual(third.key, first.key);
  assert.notEqual(third.key, second.key);
  plan.failed(third);
  assert.equal(plan.next(), null, 'pool is exhausted after every candidate failed');
});

test('a delivered candidate is not returned again by the plan', () => {
  const plan = edits.makeDeliveryPlan([item('1'), item('2')]);
  const a = plan.next();
  plan.delivered(a);
  const b = plan.next();
  assert.ok(b);
  assert.notEqual(b.key, a.key);
});

test('status queue keeps a two-candidate buffer for each category', () => {
  const queueCore = require('../lib/statusEditQueue.cjs');
  assert.equal(queueCore.DEFAULT_CAPACITY, 2);
  assert.equal(typeof queueCore.StatusEditQueue, 'function');
  assert.ok(edits && typeof edits.makeDeliveryPlan === 'function');
});
