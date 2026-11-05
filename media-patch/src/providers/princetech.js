// PrinceTechn — public ytmp3/ytmp4 resolver. Live-verified 2026-09-23:
// returns real savetube.vip CDN file URLs. Optional env: PRINCE_API_KEY.
const { getJSON } = require('../lib/http');
const youtube = require('./youtube');

const BASE = 'https://api.princetechn.com/api/download';
const KEY = process.env.PRINCE_API_KEY || 'prince';

exports.name = 'princetech';
exports.kind = 'both';
exports.full = true;

async function resolve(ytUrl, kind) {
  const ep = kind === 'video' ? 'ytmp4' : 'ytmp3';
  const d = await getJSON(`${BASE}/${ep}?apikey=${KEY}&url=${encodeURIComponent(ytUrl)}`, { timeout: kind === 'video' ? 60000 : 45000 });
  const r = d && (d.result || d.data);
  const u = r && (r.downloadUrl || r.download_url || r.url || r.audio || r.video);
  if (!u || !/^https?:\/\//.test(u)) throw new Error('princetech: no file url');
  return {
    provider: 'princetech',
    title: r.title, author: r.author, duration: r.duration,
    url: u, thumb: r.thumbnail, preview: false,
    ext: kind === 'video' ? 'mp4' : 'mp3',
  };
}

exports.searchTrack = async (query) => {
  const meta = /youtu(\.be|be\.com)/.test(query) ? { url: query } : await youtube.searchVideo(query);
  return resolve(meta.url, 'audio');
};

exports.searchVideoTrack = async (query) => {
  const meta = /youtu(\.be|be\.com)/.test(query) ? { url: query } : await youtube.searchVideo(query);
  return resolve(meta.url, 'video');
};
