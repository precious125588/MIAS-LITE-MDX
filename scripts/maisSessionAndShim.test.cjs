'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

test('call-bind-apply-helpers shim loads and resolves subpaths properly', () => {
  const ensureHelpers = require('../lib/shims/ensure-helpers.cjs');
  assert.ok(ensureHelpers);

  const main = require('call-bind-apply-helpers');
  assert.equal(typeof main, 'function');

  const actualApply = require('call-bind-apply-helpers/actualApply');
  assert.equal(typeof actualApply, 'function');

  const applyBind = require('call-bind-apply-helpers/applyBind');
  assert.equal(typeof applyBind, 'function');

  const functionApply = require('call-bind-apply-helpers/functionApply');
  assert.equal(typeof functionApply, 'function');

  const reflectApply = require('call-bind-apply-helpers/reflectApply');
  assert.ok(reflectApply !== undefined);
});

test('sessionBootstrap handles MAIS LITE MDX and MIAS LITE MDX session formats', () => {
  const { extractCredsFromRawSessionId } = require('./sessionBootstrap.cjs');

  const dummyCreds = {
    creds: {
      registered: true,
      me: { id: '15550009999:1@s.whatsapp.net', name: 'TestBot' }
    }
  };
  const b64 = Buffer.from(JSON.stringify(dummyCreds)).toString('base64');

  const testCases = [
    `MAIS_LITE_MDX~${b64}`,
    `MAIS-LITE-MDX-SESSION~${b64}`,
    `MAIS LITE MDX SESSION~${b64}`,
    `MAIS_LITE_MDX_SESSION~${b64}`,
    `MAISLITEMDXSESSION~${b64}`,
    `MIAS_LITE_MDX~${b64}`,
    `MIAS-LITE-MDX-SESSION~${b64}`,
    `MIAS LITE MDX SESSION~${b64}`,
    `SESSION_ID=MAIS_LITE_MDX~${b64}`,
    `export SESSION_ID="MAIS LITE MDX SESSION~${b64}"`,
    `'MAIS_LITE_MDX_SESSION~${b64}'`,
    `MAIS_LITE_MDX_SESSION:${b64}`,
    `MAIS LITE MDX SESSION ${b64}`
  ];

  for (const tc of testCases) {
    const extracted = extractCredsFromRawSessionId(tc);
    assert.ok(extracted, `Failed to extract from testcase: ${tc}`);
    assert.equal(extracted.me?.id, '15550009999:1@s.whatsapp.net');
  }
});
