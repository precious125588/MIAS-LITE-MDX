'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('call-bind-apply-helpers, call-bound, and call-bind shims load properly', () => {
  const ensureHelpers = require('../lib/shims/ensure-helpers.cjs');
  assert.equal(typeof ensureHelpers.ensureOnDisk, 'function');
  assert.equal(typeof ensureHelpers.installResolveHook, 'function');

  // Verify call-bind-apply-helpers main and subpath resolution
  const basic = require('call-bind-apply-helpers');
  assert.equal(typeof basic, 'function');

  const actualApply = require('call-bind-apply-helpers/actualApply');
  assert.equal(typeof actualApply, 'function');

  // Verify call-bound resolution and functionality
  const callBound = require('call-bound');
  assert.equal(typeof callBound, 'function');
  const slice = callBound('String.prototype.slice');
  assert.equal(typeof slice, 'function');
  assert.equal(slice('hello world', 0, 5), 'hello');

  // Verify call-bind resolution and functionality
  const callBind = require('call-bind');
  assert.equal(typeof callBind, 'function');
  assert.equal(typeof callBind.apply, 'function');
  const boundIndexOf = callBind(String.prototype.indexOf);
  assert.equal(boundIndexOf('foobar', 'bar'), 3);
});

test('sessionBootstrap handles MAIS LITE MDX and MIAS LITE MDX session formats', () => {
  const { extractCredsFromRawSessionId } = require('./sessionBootstrap.cjs');

  const sampleCreds = {
    registered: true,
    me: { id: '2348152433778:1@s.whatsapp.net', name: 'Tester' },
    accountSettings: { unarchiveChats: false }
  };
  const jsonStr = JSON.stringify(sampleCreds);
  const rawBase64 = Buffer.from(jsonStr, 'utf8').toString('base64');

  const testCases = [
    `MAIS_LITE_MDX~${rawBase64}`,
    `MAIS-LITE-MDX-SESSION~${rawBase64}`,
    `MAIS LITE MDX SESSION~${rawBase64}`,
    `MAIS_LITE_MDX_SESSION~${rawBase64}`,
    `MIAS_LITE_MDX~${rawBase64}`,
    `SESSION_ID=MAIS_LITE_MDX~${rawBase64}`,
    `export SESSION_ID="MAIS LITE MDX SESSION~${rawBase64}"`,
    `"MAIS_LITE_MDX_SESSION~${rawBase64}"`
  ];

  for (const tc of testCases) {
    const extracted = extractCredsFromRawSessionId(tc);
    assert.ok(extracted, `Expected session to be extracted for case: ${tc}`);
    assert.equal(extracted.registered, true);
    assert.equal(extracted.me.id, '2348152433778:1@s.whatsapp.net');
  }
});
