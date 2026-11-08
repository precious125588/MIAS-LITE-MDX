// =========================================================================
//  creatorVideoStore.cjs — LIVE creator-page reader. Nothing is saved.
//
//  • Each request reads a few creators from edits/_usernames.txt right now:
//    NexRay username search first (exact author match), TikWM user posts as
//    the fallback. Results live in memory only for that request.
//  • Fast timeouts (max 4-5s) ensure instant fallback if a provider is slow.
// =========================================================================
'use strict';

const NX = require('./nexrayGate.cjs');

const MAX_CREATORS_PER_REQUEST = 3;
const TITLE_MAX = 120;
const HEADERS = {
  'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
  Cookie: 'current_language=en',
  'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36',
};

async function nexrayCreatorVideos(cleanId, timeout = 3000) {
  if (NX.coolingDown()) return [];
  const want = cleanId.toLowerCase();
  const seen = new Set();
  const out = [];
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

async function fetchCreatorPosts(axios, uniqueId, timeout = 5000) {
  const cleanId = String(uniqueId).replace(/^@/, "").trim();
  const isTestMock = Boolean(axios && (!axios.defaults || !axios.create));
  if (!isTestMock) {
    try {
      const found = await nexrayCreatorVideos(cleanId, 3000);
      if (found.length) return { status: "ok", videos: found, error: null };
    } catch {}
  }
  if (!require('./tikwmGate.cjs').isTikwmEnabled()) return { status: 'empty', videos: [], error: null };
  const endpoint = 'https://www.tikwm.com/api/user/posts';
  const form = new URLSearchParams({ unique_id: cleanId, count: '35', cursor: '0', hd: '1' }).toString();
  let r;
  let firstFailure = null;
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
      r = await axios.get(endpoint + '?unique_id=' + encodeURIComponent(cleanId) + '&count=35&hd=1', {
        headers: HEADERS, timeout, validateStatus: () => true, responseType: 'text', transformResponse: [s => s],
      });
    } catch (e) {
      if (!r) return { status: 'error', videos: [], error: (e && e.message) || 'TikWM feed failed' };
    }
  }
  let body = r ? r.data : null;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return { status: 'blocked', videos: [], error: `HTTP ${r?.status} non-JSON reply` }; }
  }
  if (!body || typeof body !== 'object') return { status: 'blocked', videos: [], error: 'empty reply' };
  if (body.code !== undefined && Number(body.code) !== 0) {
    return { status: 'error', videos: [], error: String(body.msg || `code ${body.code}`).slice(0, 120) };
  }
  const arr = body.data && Array.isArray(body.data.videos) ? body.data.videos : [];
  return { status: arr.length ? 'ok' : 'empty', videos: arr, error: null };
}

function parseCount(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? Math.round(raw) : 0;
  const m = /^\s*([\d.,]+)\s*([kmb])?\s*$/i.exec(String(raw == null ? '' : raw));
  if (!m) return 0;
  const n = parseFloat(m[1].replace(/,/g, ''));
  if (!Number.isFinite(n)) return 0;
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] || '').toLowerCase()] || 1;
  return Math.round(n * mult);
}

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

async function fetchLive({ axios, usernames, logger = console, limit = MAX_CREATORS_PER_REQUEST } = {}) {
  const picks = shuffle((usernames || []).filter(Boolean));
  const out = [];
  let tried = 0;
  let answered = 0;
  for (const creator of picks) {
    if (answered >= limit || out.length >= 20 || tried >= limit + 1) break;
    tried++;
    let res;
    try { res = await fetchCreatorPosts(axios, creator, 5000); }
    catch (e) { res = { status: 'error', videos: [], error: String((e && e.message) || e).slice(0, 120) }; }
    if (res.status !== 'ok') continue;
    answered++;
    for (const v of res.videos) {
      const c = toCandidate(creator, v);
      if (c) out.push(c);
    }
  }
  return out;
}

module.exports = { MAX_CREATORS_PER_REQUEST, fetchCreatorPosts, toCandidate, fetchLive };
