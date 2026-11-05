// Audius — free, permissionless music API. No API key. Full-length streams.
// Docs: https://docs.audius.org/
const { getJSON } = require('../lib/http');

const FALLBACK_HOSTS = [
  'https://discoveryprovider.audius.co',
  'https://discoveryprovider2.audius.co',
  'https://discoveryprovider3.audius.co',
];

let cachedHost = null;
let cachedAt = 0;
const HOST_TTL = 10 * 60 * 1000;

async function pickHost() {
  if (cachedHost && Date.now() - cachedAt < HOST_TTL) return cachedHost;

  // api.audius.co returns the current list of healthy discovery nodes.
  let hosts = FALLBACK_HOSTS;
  try {
    const list = await getJSON('https://api.audius.co', { timeout: 6000 });
    if (Array.isArray(list.data) && list.data.length) {
      hosts = [...list.data.slice(0, 5), ...FALLBACK_HOSTS];
    }
  } catch {
    /* fall through to the static list */
  }

  for (const h of hosts) {
    try {
      await getJSON(`${h}/health_check`, { timeout: 5000 });
      cachedHost = h;
      cachedAt = Date.now();
      return h;
    } catch {
      /* try next node */
    }
  }
  throw new Error('No Audius node reachable');
}

exports.name = 'audius';
exports.kind = 'audio';
exports.full = true; // full-length playable audio

exports.searchTrack = async (query) => {
  const host = await pickHost();
  const data = await getJSON(`${host}/v1/tracks/search`, {
    params: { query, limit: 5, app_name: 'mais-bot' },
    timeout: 12000,
  });
  const t = (data.data || []).find((x) => x && x.is_streamable !== false) || (data.data || [])[0];
  if (!t) throw new Error('No Audius match');
  return {
    provider: 'audius',
    title: t.title,
    author: t.user && t.user.name,
    duration: t.duration,
    url: `${host}/v1/tracks/${t.id}/stream?app_name=mais-bot`,
    thumb: t.artwork && (t.artwork['480x480'] || t.artwork['150x150']),
    preview: false,
    ext: 'mp3',
  };
};
