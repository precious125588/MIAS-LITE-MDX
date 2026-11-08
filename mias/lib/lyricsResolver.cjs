'use strict';
// Lyrics lookup for the `lyrics` and `search-lirik` commands.
// Primary:  NexRay  GET /search/lyrics?q=   (the old /search/lirik route now returns 404 "Endpoint not found")
// Fallback: LRCLIB  GET /api/search?q=       (free, public, no key)

const NEXRAY_LYRICS = 'https://api.nexray.eu.cc/search/lyrics';
const LRCLIB_SEARCH = 'https://lrclib.net/api/search';
const MAX_LYRICS_CHARS = 3500;
const TIMEOUT_MS = 10000;

function cleanText(value) {
  return typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trim() : '';
}

// Removes "[00:12.34]" timestamps from synced lyrics so they read as plain text.
function stripSynced(text) {
  return cleanText(text)
    .split('\n')
    .map((line) => line.replace(/^\s*\[[^\]]*\]\s*/, ''))
    .join('\n')
    .trim();
}

function parseNexrayLyrics(payload) {
  if (!payload || payload.status === false || !payload.result || typeof payload.result !== 'object') return null;
  const result = payload.result;
  let body = result.lyrics;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = { plain_lyrics: body }; }
  }
  const obj = body && typeof body === 'object' ? body : {};
  const lyrics = cleanText(obj.plain_lyrics || obj.plainLyrics) || stripSynced(obj.synced_lyrics || obj.syncedLyrics);
  if (!lyrics) return null;
  return {
    title: cleanText(result.title) || cleanText(obj.track_name) || cleanText(obj.name),
    artist: cleanText(result.artist) || cleanText(obj.artist_name),
    lyrics,
    source: 'NexRay',
  };
}

function parseLrclibLyrics(list) {
  if (!Array.isArray(list)) return null;
  const hit = list.find((track) => track && !track.instrumental && (cleanText(track.plainLyrics) || cleanText(track.syncedLyrics)));
  if (!hit) return null;
  return {
    title: cleanText(hit.trackName || hit.name),
    artist: cleanText(hit.artistName),
    lyrics: cleanText(hit.plainLyrics) || stripSynced(hit.syncedLyrics),
    source: 'LRCLIB',
  };
}

async function getJson(url, fetchImpl) {
  const res = await fetchImpl(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 MIAS/1.0' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function describeError(err) {
  if (err && err.status) return `HTTP ${err.status}`;
  if (err && err.name === 'TimeoutError') return 'timeout';
  return 'unreachable';
}

async function resolveLyrics(query, { fetchImpl = fetch } = {}) {
  const q = cleanText(query);
  if (!q) throw new Error('Song title is required');
  const failures = [];

  try {
    const found = parseNexrayLyrics(await getJson(`${NEXRAY_LYRICS}?q=${encodeURIComponent(q)}`, fetchImpl));
    if (found) return found;
    failures.push('nexray: no lyrics');
  } catch (err) {
    failures.push(`nexray: ${describeError(err)}`);
  }

  try {
    const found = parseLrclibLyrics(await getJson(`${LRCLIB_SEARCH}?q=${encodeURIComponent(q)}`, fetchImpl));
    if (found) return found;
    failures.push('lrclib: no lyrics');
  } catch (err) {
    failures.push(`lrclib: ${describeError(err)}`);
  }

  const err = new Error(`Lyrics not found for "${q}"`);
  err.failures = failures;
  throw err;
}

function formatLyricsMessage(found) {
  const header = ['🎶 *Lyrics*', found.title ? `*Title:* ${found.title}` : null, found.artist ? `*Artist:* ${found.artist}` : null]
    .filter(Boolean)
    .join('\n');
  let body = found.lyrics;
  let trimmed = false;
  if (body.length > MAX_LYRICS_CHARS) {
    body = body.slice(0, MAX_LYRICS_CHARS).replace(/\s+\S*$/, '') + '…';
    trimmed = true;
  }
  return `${header}\n\n${body}\n\n_Source: ${found.source}${trimmed ? ' · trimmed' : ''}_`;
}

module.exports = { resolveLyrics, formatLyricsMessage, parseNexrayLyrics, parseLrclibLyrics, stripSynced };
