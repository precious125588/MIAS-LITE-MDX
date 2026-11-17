'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const ownership = require('../../sessionOwnership');
const persist = require('../sessionPersistence.cjs');

test('deleteSessionCompletely respects ownership guard when not forced', async () => {
  const testNum = '99912345678';
  ownership.handOffToBot(testNum);
  
  // Non-forced deletion by pairing caller should be rejected when owned by bot
  const res = await persist.deleteSessionCompletely({
    number: testNum,
    who: ownership.OWNER_PAIRING,
    force: false
  });
  assert.equal(res.ok, false);
  assert.equal(res.guarded, true);
  
  // Forced deletion should bypass guard
  const forcedRes = await persist.deleteSessionCompletely({
    number: testNum,
    who: ownership.OWNER_PAIRING,
    force: true
  });
  assert.equal(forcedRes.ok, true);
});
