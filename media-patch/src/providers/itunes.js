// iTunes Search API — no key, very stable, huge catalog.
// 30-second AAC/M4A previews + clean metadata and artwork.
// Docs: https://performance-partners.apple.com/search-api
const { getJSON } = require('../lib/http');

exports.name = 'itunes';
exports.kind = 'audio';
exports.full = false; // preview only

exports.searchTrack = async (query) => {
  const data = await getJSON('https://itunes.apple.com/search', {
    params: { term: query, media: 'music', entity: 'song', limit: 5 },
    timeout: 10000,
  });
  const t = (data.results || []).find((x) => x && x.previewUrl);
  if (!t) throw new Error('No iTunes match');
  return {
    provider: 'itunes',
    title: t.trackName,
    author: t.artistName,
    duration: Math.round((t.trackTimeMillis || 30000) / 1000),
    url: t.previewUrl,
    thumb: t.artworkUrl100 ? t.artworkUrl100.replace('100x100', '600x600') : undefined,
    preview: true,
    ext: 'm4a',
  };
};

exports.searchMeta = exports.searchTrack;
