/**
 * API Integration Utilities
 * ES Module version
 * Primary:   ZeroAPI (zeroapi2-production.up.railway.app)
 * Fallback:  prexzyvilla.site
 * Fallback2: public APIs
 */

import { httpClient as axios } from './lib/engineAccess.js';

const ZERO_BASE  = 'https://zeroapi2-production.up.railway.app';
const ZERO_KEY   = process.env.ZERO_API_KEY || '';
const PREXZY_BASE = "https://apis.prexzyvilla.site";
const NX_BASE    = 'https://api.nexray.eu.cc';

/** Nexray direct GET helper — works in ES modules (no require) */
async function nxGet(path, params = {}, timeoutMs = 90000) {
  try {
    const qs = new URLSearchParams(Object.fromEntries(Object.entries(params).filter(([,v]) => v !== undefined && v !== null)));
    const url = `${NX_BASE}${path}${qs.toString() ? '?' + qs.toString() : ''}`;
    const res = await axios.get(url, { timeout: timeoutMs, headers: { 'User-Agent': 'Mozilla/5.0' }, responseType: 'arraybuffer' });
    const ct = res.headers['content-type'] || '';
    if (ct.startsWith('image/') || ct.startsWith('audio/') || ct.startsWith('video/') || ct.startsWith('application/octet-stream')) {
      return { ok: true, media: true, buffer: Buffer.from(res.data), contentType: ct };
    }
    const json = JSON.parse(Buffer.from(res.data).toString('utf-8'));
    return { ok: json.status !== false, data: json, result: json.result };
  } catch (e) {
    return { ok: false, error: e?.message };
  }
}

const api = axios.create({
  timeout: 30000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  }
});

async function zeroGet(path, params = {}, timeoutMs = 25000) {
  try {
    const qs = new URLSearchParams(params);
    const url = `${ZERO_BASE}${path}${qs.toString() ? "?" + qs.toString() : ""}`;
    const { data } = await axios.get(url, {
      timeout: timeoutMs,
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept": "application/json",
        "x-api-key": ZERO_KEY,
        "Authorization": `Bearer ${ZERO_KEY}`
      }
    });
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e?.message };
  }
}

async function zeroPost(path, body = {}, timeoutMs = 25000) {
  try {
    const url = `${ZERO_BASE}${path}`;
    const { data } = await axios.post(url, body, {
      timeout: timeoutMs,
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0",
        "x-api-key": ZERO_KEY,
        "Authorization": `Bearer ${ZERO_KEY}`
      }
    });
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e?.message };
  }
}

async function prexzyGet(path, params = {}, timeoutMs = 25000) {
  try {
    const qs = new URLSearchParams(params);
    const url = `${PREXZY_BASE}${path}${qs.toString() ? "?" + qs.toString() : ""}`;
    const { data } = await axios.get(url, {
      timeout: timeoutMs,
      headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" }
    });
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e?.message };
  }
}

// API Endpoints
const APIs = {
  // Image Generation — ZeroAPI primary, prexzyvilla fallback, pollinations final
  generateImage: async (prompt) => {
    // 1. ZeroAPI
    try {
      const r = await zeroGet("/ai/txt2img", { prompt }, 60000);
      const d = r.data?.data || r.data;
      const imgUrl = d?.url || d?.image || d?.result || (typeof d === "string" && d.startsWith("http") ? d : null);
      if (imgUrl && imgUrl.startsWith("http")) {
        const response = await axios.get(imgUrl, { responseType: 'arraybuffer', timeout: 60000 });
        if (response.data && response.data.length > 1000) return Buffer.from(response.data);
      }
    } catch (e) { }

    // 2. ZeroAPI dalle
    try {
      const r = await zeroGet("/ai/dalle", { prompt }, 60000);
      const d = r.data?.data || r.data;
      const imgUrl = d?.url || d?.image || d?.result || (typeof d === "string" && d.startsWith("http") ? d : null);
      if (imgUrl && imgUrl.startsWith("http")) {
        const response = await axios.get(imgUrl, { responseType: 'arraybuffer', timeout: 60000 });
        if (response.data && response.data.length > 1000) return Buffer.from(response.data);
      }
    } catch (e) { }

    // 3. Prexzy txt2img
    try {
      const r = await prexzyGet("/ai/txt2img", { prompt }, 60000);
      const d = r.data;
      const imgUrl = d?.url || d?.image || d?.result || d?.data?.url || (typeof d?.data === "string" ? d.data : null);
      if (imgUrl && imgUrl.startsWith("http")) {
        const response = await axios.get(imgUrl, { responseType: 'arraybuffer', timeout: 60000 });
        if (response.data && response.data.length > 1000) return Buffer.from(response.data);
      }
    } catch (e) { }

    // 4. Pollinations.ai
    try {
      const response = await api.get(`https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}`, {
        responseType: 'arraybuffer',
        timeout: 30000
      });
      if (response.data && response.data.length > 1000) return Buffer.from(response.data);
    } catch (e) { }

    throw new Error('All image generation endpoints failed');
  },

  // AI Chat — ZeroAPI primary, prexzyvilla fallback, pollinations final
  chatAI: async (text) => {
    // 1. ZeroAPI chat
    try {
      const r = await zeroPost("/ai/chat", { message: text }, 30000);
      const d = r.data?.data || r.data;
      const reply = d?.text || d?.message || d?.result || d?.response || d?.answer || d?.reply;
      if (reply) return { msg: reply };
    } catch (e) { }

    // 2. ZeroAPI GPT
    try {
      const r = await zeroGet("/ai/gpt", { q: text }, 30000);
      const d = r.data?.data || r.data;
      const reply = d?.result || d?.answer || d?.response || d?.message || (typeof d === "string" ? d : null);
      if (reply) return { msg: reply };
    } catch (e) { }

    // 3. Prexzy aichat
    try {
      const r = await prexzyGet("/ai/aichat", { prompt: text }, 30000);
      const d = r.data;
      const reply = d?.response || d?.text || d?.result || d?.message || (typeof d?.data === "string" ? d.data : null);
      if (reply) return { msg: reply };
    } catch (e) { }

    // 4. Prexzy copilot
    try {
      const r = await prexzyGet("/ai/copilot", { text }, 30000);
      const d = r.data;
      const reply = d?.text || d?.response || d?.result || (typeof d?.data === "string" ? d.data : null);
      if (reply) return { msg: reply };
    } catch (e) { }

    // 5. Pollinations
    try {
      const msgs = [{ role: 'user', content: text }];
      const { data } = await axios.post('https://text.pollinations.ai/openai',
        { model: 'openai', messages: msgs },
        { headers: { 'Content-Type': 'application/json' }, timeout: 25000 }
      );
      const reply = data?.choices?.[0]?.message?.content;
      if (reply) return { msg: reply };
    } catch (e) { }

    // 6. Nexray GPT-3.5
    try {
      const rnx = await nxGet('/ai/gpt35', { text }, 30000);
      if (rnx.ok && !rnx.media) {
        const reply = rnx.result;
        if (reply && typeof reply === 'string') return { msg: reply };
      }
    } catch (e) { }
    // 7. popcat
    try {
      const response = await api.get(`https://api.popcat.xyz/chat?msg=${encodeURIComponent(text)}`);
      if (response.data && response.data.response) {
        return { msg: response.data.response };
      }
    } catch (e) { }

    throw new Error('Failed to get AI response');
  },

  // TikTok Download — ZeroAPI primary, prexzyvilla fallback, tikwm final
  getTikTokDownload: async (url) => {
    // 1. ZeroAPI
    try {
      const r = await zeroGet("/download/tiktok", { url }, 30000);
      const d = r.data?.data || r.data;
      const videoUrl = d?.play || d?.video || d?.url || d?.download;
      const title = d?.title || "TikTok Video";
      if (videoUrl) return { videoUrl, title };
    } catch (e) { }

    // 2. Prexzy primary
    try {
      const r = await prexzyGet("/download/tiktok", { url }, 30000);
      const d = r.data;
      const videoUrl = d?.data?.play || d?.data?.video || d?.data?.url || d?.url || d?.video;
      const title = d?.data?.title || d?.title || "TikTok Video";
      if (videoUrl) return { videoUrl, title };
    } catch (e) { }

    // 3. Prexzy V2
    try {
      const r = await prexzyGet("/download/tiktokV2", { url }, 30000);
      const d = r.data;
      const videoUrl = d?.data?.play || d?.data?.video || d?.data?.url || d?.url;
      const title = d?.data?.title || d?.title || "TikTok Video";
      if (videoUrl) return { videoUrl, title };
    } catch (e) { }

    // 4. Nexray tiktok
    try {
      const rnx = await nxGet('/downloader/tiktok', { url }, 45000);
      if (rnx.ok && !rnx.media) {
        const d = rnx.result;
        const videoUrl = d?.video?.[0] || d?.play || d?.url || d?.download;
        if (videoUrl) return { videoUrl, title: d?.title || 'TikTok Video' };
      }
    } catch (e) { }
    // 4b. Nexray tiktok v2
    try {
      const rnx2 = await nxGet('/downloader/v2/tiktok', { url }, 45000);
      if (rnx2.ok && !rnx2.media) {
        const d = rnx2.result;
        const videoUrl = d?.video?.[0] || d?.play || d?.url;
        if (videoUrl) return { videoUrl, title: d?.title || 'TikTok Video' };
      }
    } catch (e) { }
    // 5. tikwm.com
    try {
      const response = await axios.get(`https://tikwm.com/api/?url=${encodeURIComponent(url)}`, {
        timeout: 15000,
        headers: { 'accept': '*/*', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
      });
      if (response.data && response.data.data && response.data.data.play) {
        return { videoUrl: response.data.data.play, title: response.data.data.title || 'TikTok Video' };
      }
    } catch (e) { }

    throw new Error('TikTok download failed');
  },

  // YouTube Audio Download — ZeroAPI primary, then legacy APIs
  getEliteProTechDownloadByUrl: async (youtubeUrl) => {
    // 1. ZeroAPI
    try {
      const r = await zeroGet("/download/youtube", { url: youtubeUrl, type: "audio" }, 60000);
      const d = r.data?.data || r.data;
      const dlUrl = d?.download || d?.url || d?.audio;
      const title = d?.title || "YouTube Audio";
      if (dlUrl) return { download: dlUrl, title };
    } catch (e) { }

    // 2. Prexzy
    try {
      const r = await prexzyGet("/download/ytdownload", { url: youtubeUrl, type: "audio", format: "mp3" }, 40000);
      const d = r.data;
      const dlUrl = d?.data?.url || d?.url || d?.download;
      const title = d?.data?.title || d?.title || "YouTube Audio";
      if (dlUrl) return { download: dlUrl, title };
    } catch (e) { }

    // 3. EliteProTech fallback
    const AXIOS_DEFAULTS = {
      timeout: 60000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*'
      }
    };
    const tryRequest = async (getter, attempts = 3) => {
      let lastError;
      for (let attempt = 1; attempt <= attempts; attempt++) {
        try { return await getter(); } catch (err) {
          lastError = err;
          if (attempt < attempts) await new Promise(r => setTimeout(r, 1000 * attempt));
        }
      }
      throw lastError;
    };
    const apiUrl = `https://eliteprotech-apis.zone.id/ytdown?url=${encodeURIComponent(youtubeUrl)}&format=mp3`;
    const res = await tryRequest(() => axios.get(apiUrl, AXIOS_DEFAULTS));
    if (res?.data?.success && res?.data?.downloadURL) {
      return { download: res.data.downloadURL, title: res.data.title || 'YouTube Audio' };
    }
    throw new Error('All YouTube audio endpoints failed');
  },

  // YouTube Video Download — ZeroAPI primary, then legacy
  getEliteProTechVideoByUrl: async (youtubeUrl) => {
    // 1. ZeroAPI
    try {
      const r = await zeroGet("/download/youtube", { url: youtubeUrl, type: "video" }, 60000);
      const d = r.data?.data || r.data;
      const dlUrl = d?.download || d?.url || d?.video;
      const title = d?.title || "YouTube Video";
      if (dlUrl) return { download: dlUrl, title };
    } catch (e) { }

    // 2. Prexzy
    try {
      const r = await prexzyGet("/download/ytdownload", { url: youtubeUrl, type: "video", quality: "720" }, 40000);
      const d = r.data;
      const dlUrl = d?.data?.url || d?.url || d?.download;
      const title = d?.data?.title || d?.title || "YouTube Video";
      if (dlUrl) return { download: dlUrl, title };
    } catch (e) { }

    // 3. EliteProTech fallback
    const AXIOS_DEFAULTS = {
      timeout: 60000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json, text/plain, */*'
      }
    };
    const tryRequest = async (getter, attempts = 3) => {
      let lastError;
      for (let attempt = 1; attempt <= attempts; attempt++) {
        try { return await getter(); } catch (err) {
          lastError = err;
          if (attempt < attempts) await new Promise(r => setTimeout(r, 1000 * attempt));
        }
      }
      throw lastError;
    };
    const apiUrl = `https://eliteprotech-apis.zone.id/ytdown?url=${encodeURIComponent(youtubeUrl)}&format=mp4`;
    const res = await tryRequest(() => axios.get(apiUrl, AXIOS_DEFAULTS));
    if (res?.data?.success && res?.data?.downloadURL) {
      return { download: res.data.downloadURL, title: res.data.title || 'YouTube Video' };
    }
    throw new Error('All YouTube video endpoints failed');
  },

  // Spotify Download — ZeroAPI primary, prexzyvilla fallback
  spotifyDl: async (url) => {
    // 1. ZeroAPI
    try {
      const r = await zeroGet("/download/spotify", { url }, 60000);
      const d = r.data?.data || r.data;
      const dlUrl = d?.download || d?.url || d?.audio || d?.mp3;
      const title = d?.title || d?.name || "Spotify Track";
      const cover = d?.cover || d?.thumbnail || d?.image || null;
      const artist = d?.artist || d?.artists || "";
      if (dlUrl) return { download: dlUrl, title, cover, artist };
    } catch (e) { }

    // 2. Prexzy
    try {
      const r = await prexzyGet("/download/spotify", { url }, 60000);
      const d = r.data?.data || r.data;
      const dlUrl = d?.download || d?.url || d?.audio;
      const title = d?.title || "Spotify Track";
      if (dlUrl) return { download: dlUrl, title, cover: null, artist: "" };
    } catch (e) { }
    // 3. Nexray spotify
    try {
      const rnx = await nxGet('/downloader/spotify', { url }, 60000);
      if (rnx.ok && !rnx.media) {
        const d = rnx.result;
        const dlUrl = d?.url || d?.download || d?.audio;
        if (dlUrl) return { download: dlUrl, title: d?.title || 'Spotify Track', cover: d?.image || null, artist: d?.artist || '' };
      }
    } catch (e) { }

    throw new Error('Spotify download failed');
  },

  // Adult content — ZeroAPI primary
  getAdultContent: async (category) => {
    // 1. ZeroAPI
    try {
      const r = await zeroGet(`/adult/${category}`, {}, 30000);
      const d = r.data?.data || r.data;
      const url = d?.url || d?.image || d?.video || (typeof d === "string" && d.startsWith("http") ? d : null);
      if (url) return { url, type: d?.type || "image" };
    } catch (e) { }

    // 2. Prexzy
    try {
      const r = await prexzyGet(`/nsfw/${category}`, {}, 30000);
      const d = r.data?.data || r.data;
      const url = d?.url || d?.image || d?.video || (typeof d === "string" && d.startsWith("http") ? d : null);
      if (url) return { url, type: "image" };
    } catch (e) { }

    return null;
  },

  // News
  getNews: async (query = "") => {
    try {
      const r = await zeroGet("/tools/news", query ? { q: query } : {}, 15000);
      if (r.ok) return r.data?.data || r.data;
    } catch (e) { }
    return null;
  },

  // Translate
  translate: async (text, to = "en", from = "auto") => {
    // 1. ZeroAPI
    try {
      const r = await zeroGet("/tools/translate", { text, to, from }, 15000);
      if (r.ok) {
        const d = r.data?.data || r.data;
        return d?.result || d?.text || d?.translated || (typeof d === "string" ? d : null);
      }
    } catch (e) { }
    // 2. Nexray translate
    try {
      const r2 = await nxGet('/tools/translate', { text, lang: to }, 20000);
      if (r2.ok && r2.result) {
        const res = r2.result;
        return res?.translated_text || (typeof res === 'string' ? res : null);
      }
    } catch (e) { }
    // 3. MyMemory
    try {
      const { data } = await axios.get(
        `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${from === "auto" ? "en" : from}|${to}`,
        { timeout: 10000 }
      );
      return data?.responseData?.translatedText || null;
    } catch (e) { }
    return null;
  },
};


// ══════════════════════════════════════════════════════════════
// ALL ZEROA PI SOCIAL + FILE HOSTING + CONTENT ENDPOINTS
// ══════════════════════════════════════════════════════════════

async function _zeroSocialDl(platform, url, prexzyPath = null) {
  // 1. ZeroAPI /api/<platform>
  const r = await zeroGet(`/api/${platform}`, { url }, 60000);
  if (r.ok) {
    const d = r.data?.data || r.data?.result || r.data;
    const dlUrl = [d?.download_url, d?.download, d?.url, d?.audio, d?.video, d?.mp3, d?.mp4, d?.link]
      .find(v => v && typeof v === 'string' && v.startsWith('http'));
    if (dlUrl) return { ok: true, url: dlUrl, title: d?.title || platform, data: d };
    // may return medias array
    const medias = d?.medias || d?.formats;
    if (Array.isArray(medias) && medias[0]?.url) return { ok: true, url: medias[0].url, title: d?.title || platform, data: d };
    if (d) return { ok: true, url: null, title: d?.title || platform, data: d };
  }
  // 2. Prexzy
  if (prexzyPath) {
    try {
      const r2 = await prexzyGet(prexzyPath, { url }, 60000);
      if (r2.ok) {
        const d2 = r2.data?.data || r2.data;
        const dlUrl = [d2?.download_url, d2?.url, d2?.download, d2?.audio, d2?.video]
          .find(v => v && typeof v === 'string' && v.startsWith('http'));
        if (dlUrl) return { ok: true, url: dlUrl, title: d2?.title || platform, data: d2 };
      }
    } catch {}
  }
  // 3. Cobalt
  try {
    const { data } = await APIs._cobalt(url);
    if (data?.url) return { ok: true, url: data.url, title: platform, data };
  } catch {}
  return { ok: false, error: `${platform} download failed` };
}

// Cobalt universal fallback
APIs._cobalt = async (url, mode = 'auto') => {
  const { data } = await axios.post('https://co.wuk.sh/api/json',
    { url, downloadMode: mode, filenameStyle: 'basic' },
    { headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, timeout: 30000 }
  );
  return { data };
};

// ── Social platforms ─────────────────────────────────────────
APIs.tiktok     = (url) => _zeroSocialDl('tiktok',    url, '/download/tiktok');
APIs.instagram  = (url) => _zeroSocialDl('instagram', url, '/download/instagram');
APIs.youtube    = (url, type = 'video') => _zeroSocialDl('youtube', url, '/download/ytdownload');
APIs.twitter    = (url) => _zeroSocialDl('twitter',   url, '/download/twitter');
APIs.facebook   = (url) => _zeroSocialDl('facebook',  url, '/download/facebook');
APIs.snapchat   = (url) => _zeroSocialDl('snapchat',  url, null);
APIs.reddit     = (url) => _zeroSocialDl('reddit',    url, null);
APIs.threads    = (url) => _zeroSocialDl('threads',   url, null);
APIs.pinterest  = (url) => _zeroSocialDl('pinterest', url, null);
APIs.universal  = (url) => _zeroSocialDl('universal', url, null);

// ── File hosting ─────────────────────────────────────────────
APIs.mediafire  = (url) => _zeroSocialDl('mediafire',  url, null);
APIs.gdrive     = (url) => _zeroSocialDl('gdrive',     url, null);
APIs.dropbox    = (url) => _zeroSocialDl('dropbox',    url, null);
APIs.mega       = (url) => _zeroSocialDl('mega',       url, null);
APIs.pixeldrain = (url) => _zeroSocialDl('pixeldrain', url, null);
APIs.streamtape = (url) => _zeroSocialDl('streamtape', url, null);

// ── Content endpoints ────────────────────────────────────────
APIs.movies = async (query, type = 'movie', season, episode) => {
  const params = { url: query, type };
  if (season)  params.season  = season;
  if (episode) params.episode = episode;
  const r = await zeroGet('/api/movies', params, 30000);
  if (r.ok) return { ok: true, data: r.data?.data || r.data };
  try { const r2 = await prexzyGet('/search/movie', { query }, 20000); if (r2.ok) return { ok: true, data: r2.data?.data || r2.data }; } catch {}
  return { ok: false };
};

APIs.anime = async (query, episode = 1) => {
  const r = await zeroGet('/api/anime', { url: query, episode }, 30000);
  if (r.ok) return { ok: true, data: r.data?.data || r.data };
  try { const r2 = await prexzyGet('/anime/search', { query }, 20000); if (r2.ok) return { ok: true, data: r2.data?.data || r2.data }; } catch {}
  return { ok: false };
};

APIs.adult = async (url) => {
  const r = await zeroGet('/api/adult', { url }, 60000);
  if (r.ok) {
    const d = r.data?.data || r.data;
    const dlUrl = [d?.download_url, d?.url, d?.video, d?.stream].find(v => v && typeof v === 'string' && v.startsWith('http'));
    if (dlUrl) return { ok: true, url: dlUrl, title: d?.title || 'Adult', data: d };
    // Enforce size guard: reject empty / tiny responses
    if (d?.title || d?.image) return { ok: true, url: null, title: d.title, data: d };
  }
  // Prexzy nsfw fallback
  try {
    const r2 = await prexzyGet('/nsfw/xget', { url }, 60000);
    if (r2.ok) { const d2 = r2.data?.data || r2.data; const u = d2?.url || d2?.image; if (u) return { ok: true, url: u, data: d2 }; }
  } catch {}
  return { ok: false, error: 'Adult download failed' };
};

APIs.apk = async (packageId) => {
  const r = await zeroGet('/api/apk', { url: packageId }, 60000);
  if (r.ok) { const d = r.data?.data || r.data; const u = d?.download_url || d?.url || d?.download; if (u) return { ok: true, url: u, title: d?.name || packageId, data: d }; }
  try { const r2 = await prexzyGet('/download/apk', { packageName: packageId }, 60000); if (r2.ok) { const u = r2.data?.data?.url || r2.data?.url; if (u) return { ok: true, url: u, data: r2.data?.data || r2.data }; } } catch {}
  return { ok: false };
};

// ══════════════════════════════════════════════════════════════
// NEXRAY-POWERED UTILITY FUNCTIONS
// Usable from any bot via: import APIs from './api.js'
// ══════════════════════════════════════════════════════════════

/** Remove background from image URL */
APIs.removebg = async (imageUrl) => {
  // 1. Nexray (multiple versions)
  for (const path of ['/tools/removebg', '/tools/v1/removebg', '/tools/v2/removebg']) {
    try {
      const r = await nxGet(path, { url: imageUrl }, 60000);
      if (r.ok) {
        if (r.media && r.buffer.length > 500) return { ok: true, buffer: r.buffer, contentType: r.contentType };
        const url = r.result?.url || r.result;
        if (url && typeof url === 'string' && url.startsWith('http')) {
          const rb = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
          return { ok: true, buffer: Buffer.from(rb.data) };
        }
      }
    } catch (e) { }
  }
  return { ok: false, error: 'removebg failed' };
};

/** Upscale image from URL */
APIs.upscale = async (imageUrl) => {
  for (const path of ['/tools/upscale', '/tools/v1/upscale', '/tools/v2/upscale']) {
    try {
      const r = await nxGet(path, { url: imageUrl }, 90000);
      if (r.ok) {
        if (r.media && r.buffer.length > 500) return { ok: true, buffer: r.buffer, contentType: r.contentType };
        const url = r.result?.url || r.result;
        if (url && typeof url === 'string') {
          const rb = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
          return { ok: true, buffer: Buffer.from(rb.data) };
        }
      }
    } catch (e) { }
  }
  return { ok: false, error: 'upscale failed' };
};

/** Get lyrics — uses nexray /search/lirik */
APIs.getLyrics = async (query) => {
  try {
    const r = await nxGet('/search/lirik', { query }, 20000);
    if (r.ok && r.result) {
      const d = r.result;
      if (typeof d === 'string') return { ok: true, lyrics: d, title: query };
      return { ok: true, lyrics: d?.lyrics || d?.lirik || JSON.stringify(d), title: d?.title || d?.judul || query, artist: d?.artist || d?.artis || '' };
    }
  } catch (e) { }
  return { ok: false, error: 'Lyrics not found' };
};

/** Indonesian weather forecast — /information/cuaca */
APIs.getCuaca = async (kota) => {
  try {
    const r = await nxGet('/information/cuaca', { kota }, 20000);
    if (r.ok && r.result) return { ok: true, data: r.result };
  } catch (e) { }
  return { ok: false };
};

/** Indonesian prakiraan cuaca forecast — /information/prakiraan */
APIs.getPrakiraan = async (kota) => {
  try {
    const r = await nxGet('/information/prakiraan', { kota }, 20000);
    if (r.ok && r.result) return { ok: true, data: r.result };
  } catch (e) { }
  return { ok: false };
};

/** YouTube search — /search/youtube */
APIs.ytSearch = async (query) => {
  try {
    const r = await nxGet('/search/youtube', { query }, 20000);
    if (r.ok && r.result) return { ok: true, data: r.result };
  } catch (e) { }
  return { ok: false };
};

/** YouTube mp3 download — /downloader/ytmp3 */
APIs.ytmp3 = async (url) => {
  // 1. Nexray ytmp3
  try {
    const r = await nxGet('/downloader/ytmp3', { url }, 90000);
    if (r.ok && !r.media) {
      const d = r.result;
      const dlUrl = d?.url || d?.download || d?.audio;
      if (dlUrl) return { ok: true, url: dlUrl, title: d?.title || 'YouTube Audio' };
    }
  } catch (e) { }
  // 2. Nexray v1
  try {
    const r = await nxGet('/downloader/v1/youtube', { url }, 90000);
    if (r.ok && !r.media) {
      const d = r.result;
      const dlUrl = d?.url || d?.download || d?.audio;
      if (dlUrl) return { ok: true, url: dlUrl, title: d?.title || 'YouTube Audio' };
    }
  } catch (e) { }
  return { ok: false, error: 'ytmp3 failed' };
};

/** Instagram download — nexray + zero fallback */
APIs.instagramDl = async (url) => {
  // 1. Nexray
  try {
    const r = await nxGet('/downloader/instagram', { url }, 45000);
    if (r.ok && !r.media) {
      const d = r.result;
      const mediaUrl = Array.isArray(d) ? d[0]?.url : d?.url || d?.video || d?.image;
      if (mediaUrl) return { ok: true, url: mediaUrl, data: d };
    }
  } catch (e) { }
  // 2. ZeroAPI fallback
  const zr = await zeroGet('/api/instagram', { url }, 60000);
  if (zr.ok) { const d = zr.data?.data || zr.data; return { ok: true, url: d?.url || null, data: d }; }
  return { ok: false };
};

/** Stalk Instagram user — /stalker/instagram */
APIs.stalkIG = async (username) => {
  try {
    const r = await nxGet('/stalker/instagram', { username }, 20000);
    if (r.ok && r.result) return { ok: true, data: r.result };
  } catch (e) { }
  return { ok: false };
};

/** Stalk TikTok user — /stalker/tiktok */
APIs.stalkTT = async (username) => {
  try {
    const r = await nxGet('/stalker/tiktok', { username }, 20000);
    if (r.ok && r.result) return { ok: true, data: r.result };
  } catch (e) { }
  return { ok: false };
};

/** Stalk GitHub user — /stalker/github */
APIs.stalkGH = async (username) => {
  try {
    const r = await nxGet('/stalker/github', { username }, 20000);
    if (r.ok && r.result) return { ok: true, data: r.result };
  } catch (e) { }
  return { ok: false };
};

/** OCR — extract text from image URL | /tools/ocr */
APIs.ocr = async (imageUrl) => {
  try {
    const r = await nxGet('/tools/ocr', { url: imageUrl }, 30000);
    if (r.ok && r.result) {
      const text = typeof r.result === 'string' ? r.result : r.result?.text || JSON.stringify(r.result);
      return { ok: true, text };
    }
  } catch (e) { }
  return { ok: false };
};

/** Screenshot a website — /tools/ssweb */
APIs.screenshot = async (url) => {
  try {
    const r = await nxGet('/tools/ssweb', { url }, 30000);
    if (r.ok) {
      if (r.media && r.buffer.length > 500) return { ok: true, buffer: r.buffer };
      const imgUrl = r.result?.url || r.result;
      if (imgUrl && typeof imgUrl === 'string') {
        const rb = await axios.get(imgUrl, { responseType: 'arraybuffer', timeout: 20000 });
        return { ok: true, buffer: Buffer.from(rb.data) };
      }
    }
  } catch (e) { }
  return { ok: false };
};

/** Nexray image download helper — fetches buffer from URL result */
APIs.nxFetchBuffer = async (url) => {
  try {
    const { data } = await axios.get(url, { responseType: 'arraybuffer', timeout: 60000, headers: { 'User-Agent': 'Mozilla/5.0' } });
    return Buffer.from(data);
  } catch (e) { return null; }
};

export default APIs;
export { zeroGet, zeroPost, prexzyGet, nxGet };
