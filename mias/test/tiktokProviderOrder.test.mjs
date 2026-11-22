import test from 'node:test';
import assert from 'node:assert/strict';
const { fetchTikTokInfo, PRIMARY_ORDER, ANIME_STATUS_PRIMARY_ORDER } = await import('../features/tiktok.js');

const URL_ = 'https://www.tiktok.com/@user/video/7673326979118140692';

function mockFetch(route) {
  const calls = [];
  const fn = async (u) => {
    calls.push(u);
    const r = route(u);
    if (r === 'throw') throw new TypeError('fetch failed');
    return { ok: r.status < 400, status: r.status, json: async () => r.body };
  };
  fn.calls = calls;
  return fn;
}
const down = { status: 503, body: {} };
const withEnv = async (value, fn) => {
  const prev = process.env.TIKWM_ENABLED;
  if (value === undefined) delete process.env.TIKWM_ENABLED; else process.env.TIKWM_ENABLED = value;
  try { return await fn(); } finally {
    if (prev === undefined) delete process.env.TIKWM_ENABLED; else process.env.TIKWM_ENABLED = prev;
  }
};

test('Prexzy is primary and an HD answer ends the chain', async () => {
  const f = mockFetch((u) => u.includes('prexzyapis.com')
    ? { status: 200, body: { status: true, data: { title: 'T', hdplay: 'https://cdn.example/prexzy-hd.mp4', play: 'https://cdn.example/sd.mp4' } } }
    : down);
  const info = await withEnv(undefined, () => fetchTikTokInfo(URL_, f));
  assert.equal(info.videoHd, 'https://cdn.example/prexzy-hd.mp4');
  assert.equal(f.calls.length, 1);
  assert.ok(f.calls[0].includes('prexzyapis.com'));
});

test('when Prexzy is down, TikWM answers second', async () => {
  const f = mockFetch((u) => u.includes('tikwm.com')
    ? { status: 200, body: { code: 0, data: { hdplay: 'https://cdn.example/tikwm-hd.mp4', title: 'T' } } }
    : down);
  const info = await withEnv(undefined, () => fetchTikTokInfo(URL_, f));
  assert.equal(info.videoHd, 'https://cdn.example/tikwm-hd.mp4');
  assert.ok(f.calls[0].includes('prexzyapis.com'), 'Prexzy should be called first');
  assert.ok(f.calls[1].includes('tikwm.com'), 'TikWM should be called second');
});

test('when Prexzy and TikWM are down, NexRay answers third', async () => {
  const f = mockFetch((u) => u.includes('nexray.eu.cc/downloader/aio')
    ? { status: 200, body: { status: true, result: { medias: [{ type: 'video', quality: 'hd_no_watermark', url: 'https://cdn.example/aio-hd.mp4' }] } } }
    : down);
  const info = await withEnv(undefined, () => fetchTikTokInfo(URL_, f));
  assert.equal(info.videoHd, 'https://cdn.example/aio-hd.mp4');
  assert.ok(f.calls[0].includes('prexzyapis.com'), 'Prexzy should be called first');
  assert.ok(f.calls[1].includes('tikwm.com'), 'TikWM should be called second');
  assert.ok(f.calls[2].includes('nexray.eu.cc/downloader/aio'), 'NexRay should be called third');
});

test('TikWM can be explicitly disabled via TIKWM_ENABLED=0', async () => {
  const f = mockFetch((u) => u.includes('nexray.eu.cc/downloader/aio')
    ? { status: 200, body: { status: true, result: { medias: [{ type: 'video', quality: 'hd_no_watermark', url: 'https://cdn.example/aio-hd.mp4' }] } } }
    : down);
  const info = await withEnv('0', () => fetchTikTokInfo(URL_, f));
  assert.equal(info.videoHd, 'https://cdn.example/aio-hd.mp4');
  assert.ok(f.calls[0].includes('prexzyapis.com'));
  assert.ok(f.calls.every((u) => !u.includes('tikwm.com')), 'TikWM was called despite TIKWM_ENABLED=0');
});

test('for anime status menu categories, Prexzy is first and NexRay is second', async () => {
  const f = mockFetch((u) => u.includes('nexray.eu.cc/downloader/aio')
    ? { status: 200, body: { status: true, result: { medias: [{ type: 'video', quality: 'hd_no_watermark', url: 'https://cdn.example/anime-nexray-hd.mp4' }] } } }
    : down);
  const info = await fetchTikTokInfo(URL_, f, { order: ANIME_STATUS_PRIMARY_ORDER });
  assert.equal(info.videoHd, 'https://cdn.example/anime-nexray-hd.mp4');
  assert.ok(f.calls[0].includes('prexzyapis.com'), 'Prexzy must be first for anime status');
  assert.ok(f.calls[1].includes('nexray.eu.cc/downloader/aio'), 'NexRay must be second for anime status');
  assert.ok(!f.calls.slice(0, 2).some((u) => u.includes('tikwm.com')), 'TikWM must not precede NexRay in anime status');
});
