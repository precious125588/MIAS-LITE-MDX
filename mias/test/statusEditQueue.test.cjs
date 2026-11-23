'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { StatusEditQueue, videoId } = require('../lib/statusEditQueue.cjs');

function tempQueue(categories = { peak: {}, naruto: {} }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-queue-'));
  return { dir, queue: new StatusEditQueue({ categories, filePath: path.join(dir, 'queue.json'), logger: { warn() {} } }) };
}
const item = (id, src = 'search', author = 'creator') => ({
  url: `https://www.tiktok.com/@${author}/video/${id}`, caption: `caption ${id}`, src, creator: author,
  play: `https://cdn.example/${id}.mp4`,
});

test('extracts TikTok ids and persists only candidate metadata, not media blobs', () => {
  assert.equal(videoId(item('7654321098765432101')), '7654321098765432101');
  const { dir, queue } = tempQueue();
  queue.enqueue('peak', item('7654321098765432101'));
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'queue.json'), 'utf8'));
  assert.equal(saved.queues.peak[0].id, '7654321098765432101');
  assert.equal(saved.queues.peak[0].play, 'https://cdn.example/7654321098765432101.mp4');
  assert.equal(Buffer.isBuffer(saved.queues.peak[0].play), false);
});

test('reserve is atomic, no duplicate id is served across categories, and delivery persists', () => {
  const { dir, queue } = tempQueue();
  assert.equal(queue.enqueue('peak', item('7654321098765432101')), true);
  assert.equal(queue.enqueue('naruto', item('7654321098765432101', 'zip')), false);
  const [lease] = queue.reserve('peak', 1);
  assert.equal(queue.count('peak'), 0);
  assert.equal(queue.enqueue('naruto', item('7654321098765432101', 'zip')), false);
  queue.settle(lease.token, true);
  const afterRestart = new StatusEditQueue({ categories: { peak: {}, naruto: {} }, filePath: path.join(dir, 'queue.json'), logger: { warn() {} } });
  assert.equal(afterRestart.enqueue('naruto', item('7654321098765432101')), false);
});

test('failed delivery consumes a bad id and refills from new unique candidates', async () => {
  const { dir, queue } = tempQueue();
  queue.enqueue('peak', item('7654321098765432101'));
  const [lease] = queue.reserve('peak', 1);
  queue.settle(lease.token, false);
  await queue.refill('peak', async () => [item('7654321098765432101'), item('7654321098765432102'), item('7654321098765432103')]);
  assert.equal(queue.count('peak'), 2);
  const leases = queue.reserve('peak', 2);
  assert.equal(new Set(leases.map(x => x.id)).size, 2);
  assert.ok(leases.every(x => x.id !== '7654321098765432101'));
});

test('background refill locks duplicate fetches and is capped at two items', async () => {
  const { queue } = tempQueue();
  let calls = 0;
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  const fetchCandidates = async () => { calls++; await wait; return [item('7654321098765432101'), item('7654321098765432102'), item('7654321098765432103')]; };
  const a = queue.refill('peak', fetchCandidates);
  const b = queue.refill('peak', fetchCandidates);
  release();
  await Promise.all([a, b]);
  assert.equal(calls, 1);
  assert.equal(queue.count('peak'), 2);
});

test('crash recovery returns unacknowledged leases to the persistent queue', () => {
  const { dir, queue } = tempQueue();
  queue.enqueue('peak', item('7654321098765432101'));
  queue.reserve('peak', 1);
  const recovered = new StatusEditQueue({ categories: { peak: {}, naruto: {} }, filePath: path.join(dir, 'queue.json'), logger: { warn() {} } });
  assert.equal(recovered.count('peak'), 1);
});


test('startup prefill refreshes full local queues with live source candidates', async () => {
  const { queue } = tempQueue();
  queue.enqueue('peak', item('7654321098765432101', 'zip'));
  queue.enqueue('peak', item('7654321098765432102', 'zip'));
  await queue.refill('peak', async () => [item('7654321098765432103', 'pages'), item('7654321098765432104', 'search')], { force: true });
  const leases = queue.reserve('peak', 2);
  assert.equal(leases.length, 2);
  assert.ok(leases.some(x => x.src === 'pages' || x.src === 'search'));
});
