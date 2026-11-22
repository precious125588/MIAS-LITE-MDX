import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { isTransientTransportError, sendWithRetry } = require('../lib/reliableSend.cjs');

test('sendWithRetry retries a transient fetch failure and succeeds', async () => {
  let calls = 0;
  const sock = { async sendMessage() {
    calls += 1;
    if (calls === 1) throw new TypeError('fetch failed');
    return { key: { id: 'sent' } };
  }};
  const result = await sendWithRetry(sock, 'jid', { text: 'status' }, undefined, { delayMs: 0 });
  assert.equal(calls, 2);
  assert.equal(result.key.id, 'sent');
});

test('sendWithRetry does not retry non-transient errors', async () => {
  let calls = 0;
  const sock = { async sendMessage() { calls += 1; throw new Error('not-authorized'); } };
  await assert.rejects(sendWithRetry(sock, 'jid', { text: 'status' }, undefined, { delayMs: 0 }), /not-authorized/);
  assert.equal(calls, 1);
});

test('transport classifier recognizes fetch failed errors', () => {
  assert.equal(isTransientTransportError(new TypeError('fetch failed')), true);
  assert.equal(isTransientTransportError(new Error('bad payload')), false);
});
