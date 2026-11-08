const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveLyrics, formatLyricsMessage, parseNexrayLyrics, stripSynced } = require('../lib/lyricsResolver.cjs');

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const fail = (status) => ({ ok: false, status, json: async () => ({}) });

test('NexRay lyrics are used when the route answers', async () => {
  const calls = [];
  const fetchImpl = async (url) => { calls.push(url); return ok({ status: true, result: { title: 'Shape of You', artist: 'Ed Sheeran', lyrics: { plain_lyrics: 'Line one\nLine two' } } }); };
  const found = await resolveLyrics('shape of you', { fetchImpl });
  assert.equal(found.lyrics, 'Line one\nLine two');
  assert.equal(found.title, 'Shape of You');
  assert.equal(found.source, 'NexRay');
  assert.equal(calls.length, 1);
  assert.ok(calls[0].startsWith('https://api.nexray.eu.cc/search/lyrics?q=shape%20of%20you'));
});

test('falls back to LRCLIB when NexRay returns 404', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('nexray')) return fail(404);
    return ok([{ trackName: 'Shape of You', artistName: 'Ed Sheeran', plainLyrics: 'The club isnt the best place' }]);
  };
  const found = await resolveLyrics('shape of you', { fetchImpl });
  assert.equal(found.source, 'LRCLIB');
  assert.equal(found.artist, 'Ed Sheeran');
  assert.equal(found.lyrics, 'The club isnt the best place');
});

test('rejects with a clear error when every source fails', async () => {
  const fetchImpl = async () => { throw new TypeError('fetch failed'); };
  await assert.rejects(resolveLyrics('nothing here', { fetchImpl }), /Lyrics not found/);
});

test('synced lyrics are converted to plain text', () => {
  assert.equal(stripSynced('[00:01.00] Hello\n[00:03.50] World'), 'Hello\nWorld');
  const parsed = parseNexrayLyrics({ status: true, result: { lyrics: { synced_lyrics: '[00:01.00] Hi there' } } });
  assert.equal(parsed.lyrics, 'Hi there');
});

test('long lyrics are trimmed for WhatsApp', () => {
  const msg = formatLyricsMessage({ title: 'T', artist: 'A', lyrics: 'word '.repeat(2000), source: 'NexRay' });
  assert.ok(msg.length < 4000);
  assert.ok(msg.includes('trimmed'));
  assert.ok(msg.includes('*Title:* T'));
});

test('music card: artwork is looked up on iTunes and upgraded to 600px', async () => {
  const { fetchArtwork } = require('../lib/lyricsResolver.cjs');
  const calls = [];
  const fetchImpl = async (url) => { calls.push(url); return ok({ results: [{ artworkUrl100: 'https://is1.mzstatic.com/x/100x100bb.jpg' }] }); };
  const art = await fetchArtwork('Shape of You', 'Ed Sheeran', { fetchImpl });
  assert.equal(art, 'https://is1.mzstatic.com/x/600x600bb.jpg');
  assert.ok(calls[0].startsWith('https://itunes.apple.com/search?term=Shape%20of%20You%20Ed%20Sheeran'));
  assert.equal(await fetchArtwork('', '', { fetchImpl }), null);
});

test('music card: one caption holds the lyrics and the source line', () => {
  const { buildLyricsCaption } = require('../lib/lyricsResolver.cjs');
  const long = { title: 'Shape of You', artist: 'Ed Sheeran', source: 'NexRay', lyrics: 'word '.repeat(400) };
  const caption = buildLyricsCaption(long);
  assert.ok(caption.length <= 1024, `caption too long: ${caption.length}`);
  assert.ok(caption.includes('*Shape of You*') && caption.includes('Ed Sheeran'));
  assert.ok(caption.endsWith('_Source: NexRay · trimmed_'));
  const short = buildLyricsCaption({ title: 'T', artist: 'A', source: 'NexRay', lyrics: 'Line one\nLine two' });
  assert.ok(short.includes('Line one\nLine two'));
  assert.ok(short.endsWith('_Source: NexRay_'));
  assert.ok(!short.includes('trimmed'));
});
