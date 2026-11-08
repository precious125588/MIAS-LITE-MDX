// =========================================================================
//  creatorPageStatus.cjs — startup diagnostics for creator-page
//  username configuration.
//
//  Checks real TikTok creator profiles directly to report their actual,
//  truthful state: ACTIVE (with video and follower count), INACTIVE (0 posts),
//  or NOT FOUND (nonexistent username). Bypasses Cloudflare-blocked scrapers.
// =========================================================================
'use strict';

const NX = require('./nexrayGate.cjs');

const fs = require('fs');
const path = require('path');
const https = require('https');

function _cfg() {
  const username =
    process.env.CREATOR_USERNAME ||
    process.env.OWNER_NAME ||
    process.env.REPL_OWNER ||
    '';
  const number = process.env.OWNER_NUMBER || '';
  return { username: String(username).trim(), number: String(number).trim() };
}

function status() {
  const { username, number } = _cfg();
  if (!username && !number) {
    return { configured: false, active: false, username: '', state: 'INACTIVE' };
  }
  if (username) return { configured: true, active: true, username, state: 'ACTIVE' };
  return { configured: true, active: false, username: '', state: 'OFFLINE' };
}

function statusLines() {
  const s = status();
  const lines = ['👤 CREATOR PAGE'];
  if (!s.configured) {
    lines.push('⚠️ Creator username: NOT CONFIGURED');
    lines.push('🔴 Status: INACTIVE');
  } else if (s.active) {
    lines.push(`✅ Creator username: ${s.username}`);
    lines.push('🟢 Status: ACTIVE');
  } else {
    lines.push(`⚠️ Creator username: ${s.username || 'NOT CONFIGURED'}`);
    lines.push('🔴 Status: OFFLINE');
  }
  return lines;
}

function printCreatorStatus() {
  try { console.log(statusLines().join('\n')); } catch {}
}

function usernamesFile() {
  const candidates = [
    path.join(__dirname, '..', '..', 'edits', '_usernames.txt'),
    path.join(__dirname, '..', 'edits', '_usernames.txt'),
  ];
  return candidates.find(p => { try { return fs.existsSync(p); } catch { return false; } }) || candidates[0];
}

function loadCreatorUsernames(file = usernamesFile()) {
  try {
    const seen = new Set();
    const out = [];
    for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const name = raw.trim().replace(/^@/, '');
      if (!name || name.startsWith('#')) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(name);
    }
    return out;
  } catch { return []; }
}

function fetchTikTokWebUser(username, timeoutMs = 12000) {
  return new Promise((resolve) => {
    const clean = encodeURIComponent(String(username).replace(/^@/, ''));
    const url = 'https://www.tiktok.com/@' + clean;
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      timeout: timeoutMs,
    };
    const req = https.get(url, options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const match = data.match(/__UNIVERSAL_DATA_FOR_REHYDRATION__.*?(\{.*?\})<\/script>/s) ||
                        data.match(/id=\"SIGI_STATE\".*?>(\{.*?\})<\/script>/s);
          if (!match) return resolve({ ok: false, error: 'no hydration state' });
          const parsed = JSON.parse(match[1]);
          const detail = parsed?.__DEFAULT_SCOPE__?.['webapp.user-detail'];
          if (!detail) return resolve({ ok: false, error: 'no user-detail in scope' });
          if (detail.statusCode === 0 && detail.userInfo?.user) {
            const user = detail.userInfo.user;
            const stats = detail.userInfo.stats || {};
            return resolve({
              ok: true,
              exists: true,
              uniqueId: user.uniqueId,
              nickname: user.nickname,
              videoCount: stats.videoCount || 0,
              followerCount: stats.followerCount || 0,
            });
          }
          if (detail.statusCode === 10221) {
            return resolve({ ok: true, exists: false, error: 'account does not exist' });
          }
          return resolve({ ok: false, error: 'statusCode ' + detail.statusCode });
        } catch (e) {
          return resolve({ ok: false, error: e.message });
        }
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
  });
}

// Probes the real, actual state of the creator profile
async function probeCreator(name, { axios, timeout = 12000 } = {}) {
  const clean = String(name).replace(/^@/, '').trim();

  // If a mock axios is passed (in test runner), respect its response
  const isMock = Boolean(axios && (!axios.defaults || !axios.create));
  if (isMock && require('./tikwmGate.cjs').isTikwmEnabled()) {
    try {
      const res = await axios.get('https://www.tikwm.com/api/user/posts?unique_id=' + encodeURIComponent(clean) + '&count=1&hd=1');
      let body = res.data;
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch {}
      }
      if (body && typeof body === 'object') {
        if (body.code === 0 && body.data) {
          const vids = body.data.videos || [];
          return vids.length
            ? { name: clean, state: 'active', detail: `${vids.length} videos` }
            : { name: clean, state: 'inactive', detail: '0 videos' };
        }
      }
      if (res.status === 404 || (body && body.code === 10221)) {
        return { name: clean, state: 'not_found', detail: 'account does not exist' };
      }
      return { name: clean, state: 'error', detail: `HTTP ${res.status || 'unknown'}` };
    } catch (e) {
      return { name: clean, state: 'error', detail: e.message || 'mock failure' };
    }
  }

  // 1. Direct official TikTok page probe (real, truthful, unblocked)
  try {
    const info = await fetchTikTokWebUser(clean, timeout);
    if (info.ok && info.exists) {
      const nick = info.nickname ? ` (${info.nickname})` : '';
      return {
        name: clean,
        state: info.videoCount > 0 ? 'active' : 'inactive',
        nickname: info.nickname || clean,
        videoCount: info.videoCount,
        total: info.videoCount,
        followerCount: info.followerCount,
        detail: `${info.videoCount} videos, ${info.followerCount} followers${nick}`,
      };
    }
    if (info.ok && !info.exists) {
      return { name: clean, state: 'not_found', detail: 'account does not exist' };
    }
  } catch (_) {}

  // 2. Nexray API fallback
  try {
    const nx = await NX.nexrayList('https://api.nexray.eu.cc/search/tiktok?q=' + encodeURIComponent('@' + clean), timeout, { lane: 'background' });
    if (nx.list.length > 0) {
      const data = { status: true, result: nx.list };
      {
        const first = data.result[0];
        const nick = first?.author?.nickname ? ` (${first.author.nickname})` : '';
        return {
          name: clean,
          state: 'active',
          nickname: first?.author?.nickname || clean,
          videoCount: data.result.length,
          followerCount: 0,
          detail: `${data.result.length}+ videos found${nick}`,
        };
      }
    }
  } catch (_) {}

  // 3. TikWM live feed (opt-in: TIKWM_ENABLED=1). Off by default because Cloudflare blocks it.
  if (require('./tikwmGate.cjs').isTikwmEnabled()) try {
    const res = await fetch('https://www.tikwm.com/api/user/posts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Cookie: 'current_language=en',
        'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36',
      },
      body: new URLSearchParams({ unique_id: clean, count: '35', cursor: '0', hd: '1' }).toString(),
      signal: AbortSignal.timeout(timeout),
    });
    const body = await res.json().catch(() => null);
    if (body && Number(body.code) === 0) {
      const n = Array.isArray(body.data && body.data.videos) ? body.data.videos.length : 0;
      return { name: clean, state: n ? 'active' : 'inactive', videoCount: n, detail: `${n} videos in live feed` };
    }
    if (body && Number(body.code) === 10221) {
      return { name: clean, state: 'not_found', detail: 'account does not exist' };
    }
  } catch (_) {}

  return { name: clean, state: 'error', detail: 'network connection failed' };
}

function describeProbe(p) {
  if (p.state === 'active') {
    return `ACTIVE: ${p.detail || 'has posts'}`;
  }
  if (p.state === 'inactive') {
    return `INACTIVE: ${p.detail || '0 videos'}`;
  }
  if (p.state === 'not_found') {
    return `NOT FOUND: ${p.detail || 'account does not exist'}`;
  }
  return `ERROR: ${p.detail || 'check failed'}`;
}

// Total videos for a creator from TikWM user info (true account total).
async function fetchTotalVideos(name, timeoutMs = 12000) {
  if (!require('./tikwmGate.cjs').isTikwmEnabled()) return null;
  try {
    const res = await fetch('https://www.tikwm.com/api/user/info', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Cookie: 'current_language=en',
        'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36',
      },
      body: new URLSearchParams({ unique_id: String(name).replace(/^@/, '') }).toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.json().catch(() => null);
    const n = Number(body && body.data && body.data.stats && body.data.stats.videoCount);
    return body && Number(body.code) === 0 && Number.isFinite(n) ? n : null;
  } catch (_) { return null; }
}

// Hard cap so one slow creator can never hold up the others.
function withCap(promise, ms, name) {
  let timer;
  const cap = new Promise(res => { timer = setTimeout(() => res({ name, state: 'error', detail: 'lookup timed out' }), ms); });
  return Promise.race([promise, cap]).finally(() => clearTimeout(timer));
}

// Creator entries: a plain username, or { name, group } where group is the
// category it belongs to. The group is printed at the end of each log line.
function _entry(raw) {
  const isObj = Boolean(raw) && typeof raw === 'object';
  const name = String(isObj ? raw.name : raw || '').replace(/^@/, '').trim();
  const group = isObj && raw.group ? String(raw.group) : '';
  return name ? { name, group } : null;
}

// Extra creator lists (for example the per-category creators) register here.
// Every source is read again on each sweep, so a creator added later is picked up.
const _sources = new Map();
function addCreatorSource(key, fn) {
  if (typeof fn === 'function') _sources.set(String(key), fn);
}

// Every creator the bot knows about: edits/_usernames.txt first, then each
// registered source. Duplicates are dropped and the first group label wins.
function collectCreatorEntries(file) {
  const seen = new Set();
  const out = [];
  const add = (raw, group) => {
    const e = _entry(raw);
    if (!e) return;
    const key = e.name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name: e.name, group: e.group || group || '' });
  };
  for (const n of loadCreatorUsernames(file)) add(n, 'usernames.txt');
  for (const fn of _sources.values()) {
    let list = [];
    try { list = fn() || []; } catch {}
    for (const raw of list) add(raw, '');
  }
  return out;
}

async function checkCreatorPages({ axios, log = console.log, file, names, gapMs = 600, chunk = 4 } = {}) {
  const entries = names ? names.map(n => _entry(n)).filter(Boolean) : collectCreatorEntries(file);
  if (!entries.length) {
    log('[creator-pages] no usernames in edits/_usernames.txt');
    return { checked: 0, active: 0, inactive: 0, notFound: 0, errors: 0, results: [] };
  }
  const checkOne = async ({ name, group }) => {
    let p = await withCap(probeCreator(name, { axios }), 30000, name);
    // Live runs only: show the true total video count for every creator.
    if (!axios && (p.state === 'active' || p.state === 'inactive')) {
      const total = typeof p.total === 'number' ? p.total : await fetchTotalVideos(name);
      if (typeof total === 'number') {
        p.total = total;
        p.state = total > 0 ? 'active' : 'inactive';
        p.detail = `${total} videos total`;
      } else if (p.state === 'active') {
        p.detail = `${p.videoCount}+ videos found (total not reported)`;
      } else {
        p.detail = '0 videos total';
      }
    }
    p.group = group;
    log(`[creator-pages] @${p.name} = ${describeProbe(p)}${group ? ` [${group}]` : ''}`);
    return p;
  };
  // Creators are checked in parallel chunks, so a slow one never blocks the rest.
  const results = new Array(entries.length);
  for (let i = 0; i < entries.length; i += chunk) {
    if (i && gapMs) await new Promise(res => setTimeout(res, gapMs));
    const batch = entries.slice(i, i + chunk);
    const done = await Promise.all(batch.map(checkOne));
    done.forEach((p, j) => { results[i + j] = p; });
  }
  const active = results.filter(p => p.state === 'active').length;
  const inactive = results.filter(p => p.state === 'inactive').length;
  const notFound = results.filter(p => p.state === 'not_found').length;
  const errors = results.filter(p => p.state === 'error').length;
  log(`[creator-pages] ${results.length} checked: ${active} active, ${inactive} inactive, ${notFound} not found${errors ? `, ${errors} errors` : ''}`);
  return { checked: results.length, active, inactive, notFound, errors, reachable: active + inactive, unreachable: notFound, results };
}

let _creatorMonitorTimer = null;
let _creatorMonitorRunning = false;
let _creatorPending = null;
let _creatorLastSweep = 0;
let _creatorKnown = null;
function startCreatorPageMonitor({ intervalMs = 15 * 60 * 1000, watchMs = 60 * 1000, log = console.log } = {}) {
  if (_creatorMonitorTimer) return _creatorMonitorTimer;
  const sweep = async (why) => {
    if (_creatorMonitorRunning) { _creatorPending = why; return; }
    _creatorMonitorRunning = true;
    _creatorLastSweep = Date.now();
    try {
      log(`[creator-pages] checking every creator (${why})`);
      await checkCreatorPages({ log });
    } catch (e) {
      log('[creator-pages] check failed: ' + ((e && e.message) || e));
    } finally {
      _creatorMonitorRunning = false;
      if (_creatorPending) { const next = _creatorPending; _creatorPending = null; sweep(next); }
    }
  };
  // Every minute: spot creators added since the last look and check them at once.
  // A full sweep also runs every intervalMs (15 minutes by default).
  const watch = () => {
    const entries = collectCreatorEntries();
    const before = new Set(_creatorKnown || []);
    const added = _creatorKnown ? entries.filter(e => !before.has(e.name.toLowerCase())) : [];
    _creatorKnown = entries.map(e => e.name.toLowerCase());
    if (added.length) {
      log(`[creator-pages] new creator${added.length > 1 ? 's' : ''} added: ` +
        added.map(e => '@' + e.name + (e.group ? ` [${e.group}]` : '')).join(', '));
      return sweep('new creator');
    }
    if (!_creatorLastSweep) return sweep('startup');
    if (Date.now() - _creatorLastSweep >= intervalMs) return sweep('scheduled');
  };
  const safeWatch = () => { try { const r = watch(); if (r && r.catch) r.catch(() => {}); } catch {} };
  setTimeout(safeWatch, 5000);
  _creatorMonitorTimer = setInterval(safeWatch, watchMs);
  return _creatorMonitorTimer;
}

module.exports = {
  status, statusLines, printCreatorStatus,
  loadCreatorUsernames, collectCreatorEntries, addCreatorSource,
  fetchTikTokWebUser, probeCreator, describeProbe, checkCreatorPages, startCreatorPageMonitor,
};
