// YouTube search + metadata.
// Two independent paths so one outage can't kill the ".video" / ".play" flow:
//   1. Piped mirrors  — no key, rotates across public instances
//   2. YouTube Data v3 — needs YOUTUBE_API_KEY (quota-based), used as fallback
//
// NOTE: neither path hands you a media FILE. Piped stream extraction is
// frequently rate-limited by YouTube, so treat any stream URL as best-effort
// and always fall back to the audio chain (Audius/Jamendo/Deezer/iTunes).
const { getJSON } = require('../lib/http');

const PIPED_HOSTS = [
  'https://api.piped.private.coffee',
  'https://pipedapi.ducks.party',
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.reallyaweso.me',
  'https://api.piped.yt',
];

exports.name = 'youtube';
exports.kind = 'video';

async function pipedSearch(query) {
  let last;
  for (const host of PIPED_HOSTS) {
    try {
      const data = await getJSON(`${host}/search`, {
        params: { q: query, filter: 'videos' },
        timeout: 9000,
      });
      const v = (data.items || []).find((x) => x && x.url && x.url.includes('watch?v='));
      if (!v) throw new Error('no items');
      const videoId = v.url.split('watch?v=')[1].split('&')[0];
      return {
        provider: 'piped',
        host,
        title: v.title,
        author: v.uploaderName,
        duration: v.duration,
        videoId,
        url: `https://youtu.be/${videoId}`,
        thumb: v.thumbnail,
      };
    } catch (e) {
      last = e;
    }
  }
  throw new Error(`All Piped mirrors failed (${last && last.message})`);
}

async function dataApiSearch(query) {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) throw new Error('YOUTUBE_API_KEY missing');
  const data = await getJSON('https://www.googleapis.com/youtube/v3/search', {
    params: { key, q: query, part: 'snippet', type: 'video', maxResults: 5 },
    timeout: 10000,
  });
  const v = (data.items || [])[0];
  if (!v) throw new Error('No YouTube match');
  return {
    provider: 'youtube-data',
    title: v.snippet.title,
    author: v.snippet.channelTitle,
    videoId: v.id.videoId,
    url: `https://youtu.be/${v.id.videoId}`,
    thumb: v.snippet.thumbnails.medium.url,
  };
}

exports.searchVideo = async (query) => {
  try {
    return await pipedSearch(query);
  } catch (e) {
    return dataApiSearch(query).catch(() => {
      throw e;
    });
  }
};

// Best-effort direct stream lookup (may fail when YouTube blocks the mirror).
exports.resolveStream = async (videoId, { audioOnly = true } = {}) => {
  let last;
  for (const host of PIPED_HOSTS) {
    try {
      const data = await getJSON(`${host}/streams/${videoId}`, { timeout: 12000 });
      const pool = audioOnly ? data.audioStreams : data.videoStreams;
      const best = (pool || [])
        .filter((s) => s && s.url)
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
      if (!best) throw new Error('no streams');
      return {
        provider: 'piped-stream',
        host,
        title: data.title,
        author: data.uploader,
        duration: data.duration,
        url: best.url,
        thumb: data.thumbnailUrl,
        preview: false,
        ext: audioOnly ? 'mp3' : 'mp4',
      };
    } catch (e) {
      last = e;
    }
  }
  throw new Error(`No stream host available (${last && last.message})`);
};
