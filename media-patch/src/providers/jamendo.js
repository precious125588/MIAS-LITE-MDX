// Jamendo — Creative Commons music, full-length legal MP3 downloads.
// Free key: https://devportal.jamendo.com/  ->  JAMENDO_CLIENT_ID
const { getJSON } = require('../lib/http');

exports.name = 'jamendo';
exports.kind = 'audio';
exports.full = true;

exports.searchTrack = async (query) => {
  const id = process.env.JAMENDO_CLIENT_ID;
  if (!id) throw new Error('JAMENDO_CLIENT_ID missing');
  const data = await getJSON('https://api.jamendo.com/v3.0/tracks/', {
    params: { client_id: id, search: query, limit: 5, audioformat: 'mp32' },
    timeout: 10000,
  });
  if (data.headers && data.headers.status === 'failed') {
    throw new Error(data.headers.error_message || 'Jamendo rejected the request');
  }
  const t = (data.results || []).find((x) => x && x.audiodownload_allowed && x.audiodownload);
  if (!t) throw new Error('No downloadable Jamendo match');
  return {
    provider: 'jamendo',
    title: t.name,
    author: t.artist_name,
    duration: t.duration,
    url: t.audiodownload,
    thumb: t.album_image || t.image,
    preview: false,
    ext: 'mp3',
  };
};
