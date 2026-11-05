// Deezer — public API, no key. Rich metadata + 30-second MP3 previews.
// Docs: https://developers.deezer.com/api
const { getJSON } = require('../lib/http');

exports.name = 'deezer';
exports.kind = 'audio';
exports.full = false; // preview only

exports.searchTrack = async (query) => {
  const data = await getJSON('https://api.deezer.com/search', {
    params: { q: query, limit: 5 },
    timeout: 10000,
  });
  const t = (data.data || []).find((x) => x && x.preview);
  if (!t) throw new Error('No Deezer match');
  return {
    provider: 'deezer',
    title: t.title,
    author: t.artist && t.artist.name,
    duration: 30,
    url: t.preview,
    thumb: t.album && t.album.cover_big,
    preview: true,
    ext: 'mp3',
  };
};

exports.searchMeta = exports.searchTrack;
