import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import axios from 'axios';
import policy from '../lib/fetchRetryPolicy.cjs';

const { shouldRetryFetch, describeFetchFailure } = policy;

// Starts a local server that answers every request with the given status.
async function serve(status) {
  let hits = 0;
  const server = http.createServer((req, res) => { hits++; res.statusCode = status; res.end('nope'); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/file.bin`;
  return { url, hits: () => hits, close: () => new Promise(r => server.close(r)) };
}

// Same request options the .fetch command uses.
const getOpts = { timeout: 5000, maxRedirects: 8, responseType: 'arraybuffer', headers: { Accept: '*/*' } };

for (const status of [400, 401, 403, 404, 410]) {
  test(`HTTP ${status} is not retried and is described`, async () => {
    const s = await serve(status);
    try {
      let err;
      try { await axios.get(s.url, getOpts); } catch (e) { err = e; }
      assert.ok(err, 'expected axios to throw');
      assert.equal(shouldRetryFetch(err), false);
      assert.match(describeFetchFailure(err, s.url), new RegExp(`^HTTP ${status}`));
      assert.match(describeFetchFailure(err, s.url), /127\.0\.0\.1:\d+/);
    } finally { await s.close(); }
  });
}

for (const status of [408, 429, 500, 503]) {
  test(`HTTP ${status} is retried`, async () => {
    const s = await serve(status);
    try {
      let err;
      try { await axios.get(s.url, getOpts); } catch (e) { err = e; }
      assert.equal(shouldRetryFetch(err), true);
    } finally { await s.close(); }
  });
}

test('network failure (connection refused) is retried and described by its code', async () => {
  const s = await serve(200);
  const url = s.url; await s.close(); // port now closed
  let err;
  try { await axios.get(url, getOpts); } catch (e) { err = e; }
  assert.ok(err);
  assert.equal(shouldRetryFetch(err), true);
  assert.equal(describeFetchFailure(err, url), 'ECONNREFUSED');
});

test('a 4xx is requested once, a 5xx is requested on every attempt', async () => {
  const four = await serve(404);
  const five = await serve(500);
  try {
    // Mirror the command's loop: stop when the policy says not to retry.
    for (const [s, max] of [[four, 3], [five, 3]]) {
      for (let i = 1; i <= max; i++) {
        let err;
        try { await axios.get(s.url, getOpts); } catch (e) { err = e; }
        if (!shouldRetryFetch(err)) break;
      }
    }
    assert.equal(four.hits(), 1);
    assert.equal(five.hits(), 3);
  } finally { await four.close(); await five.close(); }
});
