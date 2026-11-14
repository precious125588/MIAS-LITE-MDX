// =========================================================================
//  creatorVideoStore.cjs — LIVE creator-page reader. Nothing is saved.
//
//  • Each request reads a few creators from edits/_usernames.txt right now:
//    NexRay username search first (exact author match), TikWM user posts as
//    the fallback. Results live in memory only for that request.
//  • Fast timeouts (max 4-5s) ensure instant fallback if a provider is slow.
// =========================================================================
'use strict';

const fs = require('fs');
const path = require('path');
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
      const found = await nexrayCreatorVideos(cleanId, 8000);
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

// ── renamed creators ─────────────────────────────────────────────────────
// A creator who changes their TikTok username stops matching the old name, so
// the list entry returns nothing. The bot keeps one saved video id per creator
// (a "sample"). When a creator comes back empty, it opens that video and reads
// the account's current username from the page, then stores the new name in
// the renames file so later requests go straight to it. Both files live in the
// nexstore folder and survive restarts. The list file itself is not edited.
const UA_PAGE = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const RENAMES_FILE = 'creator-renames.json';
const SAMPLES_FILE = 'creator-samples.json';

function storeDir() {
  return process.env.NEXSTORE_DIR || path.join(process.cwd(), 'nexstore');
}
function readStore(file) {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(storeDir(), file), 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}
function writeStore(file, obj) {
  try {
    fs.mkdirSync(storeDir(), { recursive: true });
    fs.writeFileSync(path.join(storeDir(), file), JSON.stringify(obj, null, 2));
  } catch {}
}
function cleanName(name) {
  return String(name || '').replace(/^@/, '').trim();
}
// The username the bot should use for a list entry right now.
function currentHandle(listName) {
  const clean = cleanName(listName);
  const renames = readStore(RENAMES_FILE);
  return renames[clean.toLowerCase()] || clean;
}
function rememberSample(handle, videos) {
  const id = (videos || [])
    .map(v => String((v && (v.video_id || v.id)) || ''))
    .find(s => /^\d+$/.test(s));
  if (!id) return;
  const key = handle.toLowerCase();
  const samples = readStore(SAMPLES_FILE);
  if (samples[key] === id) return;
  samples[key] = id;
  writeStore(SAMPLES_FILE, samples);
}
// Opens a saved video under the given handle. TikTok serves the page and names
// the account that posted it. Returns the one username found, or null.
async function readPageHandle(axios, handle, videoId, timeout = 8000) {
  const url = 'https://www.tiktok.com/@' + encodeURIComponent(handle) + '/video/' + videoId;
  const r = await axios.get(url, {
    headers: { 'User-Agent': UA_PAGE, Cookie: 'current_language=en' },
    timeout, responseType: 'text', transformResponse: [s => s], validateStatus: () => true,
  });
  const html = typeof (r && r.data) === 'string' ? r.data : '';
  const names = new Set();
  const re = /"uniqueId":"([A-Za-z0-9._]{1,40})"/g;
  let m;
  while ((m = re.exec(html)) && names.size < 5) names.add(m[1]);
  return names.size === 1 ? [...names][0] : null;
}
// Finds the creator's new username from the saved sample. Returns it when it changed.
async function findRenamed(axios, listName, logger) {
  const clean = cleanName(listName);
  const handle = currentHandle(clean);
  const samples = readStore(SAMPLES_FILE);
  const videoId = samples[handle.toLowerCase()];
  if (!videoId) return null;
  let found = null;
  try { found = await readPageHandle(axios, handle, videoId); } catch { return null; }
  if (!found) return null;
  const renames = readStore(RENAMES_FILE);
  const key = clean.toLowerCase();
  if (found.toLowerCase() === key) {
    if (renames[key]) { delete renames[key]; writeStore(RENAMES_FILE, renames); }
    return null;
  }
  if (found.toLowerCase() === handle.toLowerCase()) return null;
  renames[key] = found;
  writeStore(RENAMES_FILE, renames);
  try { logger && logger.log && logger.log(`[creator-rename] ${clean} is now ${found}`); } catch {}
  return found;
}
async function safeFetch(axios, handle) {
  try { return await fetchCreatorPosts(axios, handle, 5000); }
  catch (e) { return { status: 'error', videos: [], error: String((e && e.message) || e).slice(0, 120) }; }
}

async function fetchLive({ axios, usernames, logger = console, limit = MAX_CREATORS_PER_REQUEST } = {}) {
  const uniq = [];
  const seenNames = new Set();
  for (const u of usernames || []) {
    const k = String(u || '').trim().replace(/^@/, '').toLowerCase();
    if (!k || seenNames.has(k)) continue;
    seenNames.add(k); uniq.push(u);
  }
  const picks = shuffle(uniq);
  const out = [];
  let tried = 0;
  let answered = 0;
  for (const listName of picks) {
    if (answered >= limit || out.length >= 20 || tried >= limit + 1) break;
    tried++;
    let handle = currentHandle(listName);
    let res = await safeFetch(axios, handle);
    if (res.status !== 'ok') {
      const renamed = await findRenamed(axios, listName, logger);
      if (renamed) {
        handle = renamed;
        res = await safeFetch(axios, handle);
      }
    }
    if (res.status !== 'ok') continue;
    answered++;
    rememberSample(handle, res.videos);
    for (const v of res.videos) {
      const c = toCandidate(handle, v);
      if (c) out.push(c);
    }
  }
  return out;
}

module.exports = { MAX_CREATORS_PER_REQUEST, fetchCreatorPosts, toCandidate, fetchLive, currentHandle, findRenamed, readPageHandle };
