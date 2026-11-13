'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'creator-rename-'));
process.env.NEXSTORE_DIR = dir;
process.env.TIKWM_ENABLED = '1';
const CVS = require('../lib/creatorVideoStore.cjs');
const quiet = { log() {} };

function mockAxios({ posts = {}, pages = {} } = {}) {
  const calls = { post: [], get: [] };
  return {
    calls,
    post: async (endpoint, form) => {
      const u = new URLSearchParams(form).get('unique_id');
      calls.post.push(u);
      return { status: 200, data: JSON.stringify({ code: 0, data: { videos: posts[u] || [] } }) };
    },
    get: async (url) => {
      calls.get.push(url);
      const m = url.match(/\/video\/(\d+)/);
      return { status: 200, data: (m && pages[m[1]]) || '<html></html>' };
    },
  };
}
const readJson = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));

test('finds a renamed creator from a saved video and uses the new name', async () => {
  fs.writeFileSync(path.join(dir, 'creator-samples.json'), JSON.stringify({ oldhandle: '7000000000000000001' }));
  const ax = mockAxios({
    posts: { newhandle: [
      { id: '7100000000000000002', title: 'edit one', play: 'https://cdn.example/a.mp4' },
      { id: '7100000000000000003', title: 'edit two', play: 'https://cdn.example/b.mp4' },
    ] },
    pages: { '7000000000000000001': '<script>{"uniqueId":"newhandle","nickname":"New"}</script>' },
  });
  const out = await CVS.fetchLive({ axios: ax, usernames: ['oldhandle'], logger: quiet, limit: 3 });
  assert.equal(out.length, 2);
  assert.ok(out.every(c => c.creator === 'newhandle'));
  assert.ok(out[0].url.includes('@newhandle/video/'));
  assert.equal(readJson('creator-renames.json').oldhandle, 'newhandle');
  assert.equal(CVS.currentHandle('oldhandle'), 'newhandle');
  assert.equal(ax.calls.get.length, 1);
});

test('a later request uses the saved new name without checking the page again', async () => {
  const ax = mockAxios({ posts: { newhandle: [{ id: '7100000000000000004', play: 'https://cdn.example/c.mp4' }] } });
  const out = await CVS.fetchLive({ axios: ax, usernames: ['oldhandle'], logger: quiet });
  assert.equal(out.length, 1);
  assert.equal(ax.calls.get.length, 0);
});

test('a successful fetch saves a sample video id for the creator', async () => {
  const ax = mockAxios({ posts: { steady: [{ id: '7200000000000000009', play: 'https://cdn.example/s.mp4' }] } });
  await CVS.fetchLive({ axios: ax, usernames: ['steady'], logger: quiet });
  assert.equal(readJson('creator-samples.json').steady, '7200000000000000009');
});

test('no rename when the saved video still names the same creator', async () => {
  fs.writeFileSync(path.join(dir, 'creator-samples.json'), JSON.stringify({ same: '7300000000000000001' }));
  const ax = mockAxios({ pages: { '7300000000000000001': '{"uniqueId":"same"}' } });
  const out = await CVS.fetchLive({ axios: ax, usernames: ['same'], logger: quiet });
  assert.equal(out.length, 0);
  assert.equal(ax.calls.get.length, 1);
  assert.equal(readJson('creator-renames.json').same, undefined);
});

test('no page check when no saved video exists for the creator', async () => {
  const ax = mockAxios({});
  const out = await CVS.fetchLive({ axios: ax, usernames: ['nosample'], logger: quiet });
  assert.equal(out.length, 0);
  assert.equal(ax.calls.get.length, 0);
});

test('an ambiguous page (two different usernames) does not trigger a rename', async () => {
  fs.writeFileSync(path.join(dir, 'creator-samples.json'), JSON.stringify({ amb: '7400000000000000001' }));
  const ax = mockAxios({ pages: { '7400000000000000001': '{"uniqueId":"x_one"} {"uniqueId":"y_two"}' } });
  await CVS.fetchLive({ axios: ax, usernames: ['amb'], logger: quiet });
  assert.equal(readJson('creator-renames.json').amb, undefined);
});
