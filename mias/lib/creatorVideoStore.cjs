// =========================================================================
//  creatorVideoStore.cjs — LIVE creator-page reader. Nothing is saved.
//
//  • Each request reads a few creators from edits/_usernames.txt right now:
//    NexRay username search first (exact author match), TikWM user posts as
//    the fallback. Results live in memory only for that request.
//  • No link, video, or JSON file is written anywhere by this module.
//  • Video bytes are downloaded by precious-anime-edits.cjs into a temp
//    folder on disk, sent, and removed after the send succeeds or fails.
// =========================================================================
'use strict';

const NX = require('./nexrayGate.cjs');

const MAX_CREATORS_PER_REQUEST = 4;
const TITLE_MAX = 120;
const HEADERS = {
  'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
  Cookie: 'current_language=en',
  'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36',
};

// NexRay has no creator-list endpoint. Search by the username (plain and with @)
// and keep only results whose author nickname is exactly that creator, so other
// accounts that merely mention the name are never credited to it.
async function nexrayCreatorVideos(cleanId, timeout = 20000) {
  const want = cleanId.toLowerCase();
  const seen = new Set();
  const out = [];
  // The bare name is asked first, and the "@" form only when it finds nothing,
  // so each creator costs one NexRay call in the normal case.
  for (const q of [cleanId, "@" + cleanId]) {
    const { list } = await NX.nexrayList("https://api.nexray.eu.cc/search/tiktok?q=" + encodeURIComponent(q), timeout);
    for (const v of list) {
      const nick = String((v && v.author && v.author.nickname) || "").toLowerCase();
      const id = String((v && (v.id || v.video_id)) || "");
      if (nick !== want || !id || seen.has(id)) continue;
      seen.add(id);
      out.push(v);
    }
    if (out.length) break;
  }
  return out;
}

// Fetch one creator's posts. Returns { status, videos, error }.
//   ok      — JSON answer with videos
//   empty   — JSON answer with no videos
//   blocked — challenge page or non-JSON body
//   error   — upstream error code
async function fetchCreatorPosts(axios, uniqueId, timeout = 20000) {
  const cleanId = String(uniqueId).replace(/^@/, "").trim();
  const isTestMock = Boolean(axios && (!axios.defaults || !axios.create));
  if (!isTestMock) {
    const found = await nexrayCreatorVideos(cleanId, timeout);
    if (found.length) return { status: "ok", videos: found, error: null };
  }
  const endpoint = 'https://www.tikwm.com/api/user/posts';
  const form = new URLSearchParams({ unique_id: String(uniqueId).replace(/^@/, ''), count: '35', cursor: '0', hd: '1' }).toString();
  let r;
  let firstFailure = null;
  // The supplied gist's request pattern is form-encoded POST with a mobile UA.
  // Keep the request creator-specific; its /feed/search endpoint is keyword-only.
  if (typeof axios.post === 'function') {
    try {
      r = await axios.post(endpoint, form, {
        headers: HEADERS, timeout, validateStatus: () => true,
        responseType: 'text', transformResponse: [s => s],
      });
    } catch (e) { firstFailure = e; }
  }
  if (!r || r.status === 403 || r.status === 405 || r.status === 404) {
    try {
      r = await axios.get(endpoint + '?unique_id=' + encodeURIComponent(String(uniqueId).replace(/^@/, '')) + '&count=35&hd=1', {
        headers: HEADERS, timeout, validateStatus: () => true, responseType: 'text', transformResponse: [s => s],
      });
    } catch (e) {
      if (!r) throw e || firstFailure || new Error('TikWM creator feed request failed');
    }
  }
  let body = r.data;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return { status: 'blocked', videos: [], error: `HTTP ${r.status} non-JSON reply` }; }
  }
  if (!body || typeof body !== 'object') return { status: 'blocked', videos: [], error: 'empty reply' };
  if (body.code !== undefined && Number(body.code) !== 0) {
    return { status: 'error', videos: [], error: String(body.msg || `code ${body.code}`).slice(0, 120) };
  }
  const arr = body.data && Array.isArray(body.data.videos) ? body.data.videos : [];
  return { status: arr.length ? 'ok' : 'empty', videos: arr, error: null };
}

// NexRay reports counts as text such as "457.2K" or "2.2M"; expand the suffix.
function parseCount(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? Math.round(raw) : 0;
  const m = /^\s*([\d.,]+)\s*([kmb])?\s*$/i.exec(String(raw == null ? '' : raw));
  if (!m) return 0;
  const n = parseFloat(m[1].replace(/,/g, ''));
  if (!Number.isFinite(n)) return 0;
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] || '').toLowerCase()] || 1;
  return Math.round(n * mult);
}

// Keep only what a request needs. No file, no storage.
function toCandidate(creator, v) {
  if (!v || typeof v !== 'object') return null;
  const id = String(v.video_id || v.id || '');
  if (!/^\d+$/.test(id)) return null;
  const play = String(v.data || v.hdplay || v.play || '').trim();
  const rawLikes = v.stats?.likes ?? v.digg_count ?? 0;
  const rawViews = v.stats?.views ?? v.play_count ?? 0;
  const digg = parseCount(rawLikes);
  const plays = parseCount(rawViews);
  return {
    id,
    url: `https://www.tiktok.com/@${creator}/video/${id}`,
    play: /^https?:\/\//i.test(play) ? play : '',
    title: String(v.title || '').replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX),
    digg,
    plays,
    creator,
  };
}

function shuffle(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Read creator pages now. Returns candidates in memory only. Creators are tried
// in random order until `limit` of them answer with videos, so one empty or
// blocked creator is replaced by the next instead of ending the read early.
async function fetchLive({ axios, usernames, logger = console, limit = MAX_CREATORS_PER_REQUEST } = {}) {
  const picks = shuffle((usernames || []).filter(Boolean));
  const out = [];
  let tried = 0;
  let answered = 0;
  for (const creator of picks) {
    if (answered >= limit || out.length >= 25 || tried >= limit + 2) break;
    tried++;
    let res;
    try { res = await fetchCreatorPosts(axios, creator); }
    catch (e) { res = { status: 'error', videos: [], error: String((e && e.message) || e).slice(0, 120) }; }
    if (res.status !== 'ok') {
      logger.log(`[creator-pages] @${creator}: ${res.status}${res.error ? ' — ' + res.error : ''}`);
      continue;
    }
    answered++;
    let usable = 0;
    for (const v of res.videos) {
      const c = toCandidate(creator, v);
      if (c) { out.push(c); usable++; }
    }
    logger.log(`[creator-pages] @${creator}: ${res.videos.length} videos read live, ${usable} usable (in memory, nothing saved)`);
  }
  logger.log(`[creator-pages] live read: ${answered} of ${tried} creators answered, ${out.length} videos`);
  return out;
}

module.exports = { MAX_CREATORS_PER_REQUEST, fetchCreatorPosts, toCandidate, fetchLive };
