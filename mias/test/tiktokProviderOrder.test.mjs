import test from 'node:test';
import assert from 'node:assert/strict';
const { fetchTikTokInfo } = await import('../features/tiktok.js');

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

test('Prexzy is the first source and an HD answer ends the chain', async () => {
  const f = mockFetch((u) => u.includes('prexzyapis.com')
    ? { status: 200, body: { status: true, data: { title: 'T', hdplay: 'https://cdn.example/hd.mp4', play: 'https://cdn.example/sd.mp4' } } }
    : down);
  const info = await withEnv(undefined, () => fetchTikTokInfo(URL_, f));
  assert.equal(info.videoHd, 'https://cdn.example/hd.mp4');
  assert.equal(f.calls.length, 1);
  assert.ok(f.calls[0].includes('prexzyapis.com'));
});

test('when Prexzy is down the NexRay AIO route answers next', async () => {
  const f = mockFetch((u) => u.includes('nexray.eu.cc/downloader/aio')
    ? { status: 200, body: { status: true, result: { medias: [{ type: 'video', quality: 'hd_no_watermark', url: 'https://cdn.example/aio-hd.mp4' }] } } }
    : down);
  const info = await withEnv(undefined, () => fetchTikTokInfo(URL_, f));
  assert.equal(info.videoHd, 'https://cdn.example/aio-hd.mp4');
  assert.ok(f.calls[1].includes('nexray.eu.cc/downloader/aio'));
});

test('TikWM is never called unless TIKWM_ENABLED is set', async () => {
  const f = mockFetch(() => down);
  await withEnv(undefined, async () => {
    await assert.rejects(fetchTikTokInfo(URL_, f), (e) => e.code === 'ALL_PROVIDERS_FAILED');
  });
  assert.ok(f.calls.every((u) => !u.includes('tikwm.com')), 'tikwm was called while disabled');
});

test('TikWM is used as a last resort once it is enabled', async () => {
  const f = mockFetch((u) => u.includes('tikwm.com')
    ? { status: 200, body: { code: 0, data: { hdplay: 'https://cdn.example/tikwm-hd.mp4', title: 'T' } } }
    : down);
  const info = await withEnv('1', () => fetchTikTokInfo(URL_, f));
  assert.equal(info.videoHd, 'https://cdn.example/tikwm-hd.mp4');
  assert.ok(f.calls.some((u) => u.includes('tikwm.com')));
});
