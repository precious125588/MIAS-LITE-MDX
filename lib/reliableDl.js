// ═══════════════════════════════════════════════════════════════════════════
// reliableDl.js — shared search and validated media-download pipeline.
// Audio tries independent YouTube resolvers before matching catalog fallbacks.
// API success is not download success: every URL is downloaded and checked.
// Optional env: PRINCE_API_KEY and PREXZY_API. Provider availability varies.
'use strict';

const UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36';
const PRINCE_BASE = 'https://api.princetechn.com/api/download';
const PRINCE_KEY = process.env.PRINCE_API_KEY || 'prince';
const PIPED_HOSTS = [
  'https://api.piped.private.coffee',
  'https://pipedapi.ducks.party',
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.reallyaweso.me',
  'https://api.piped.yt',
];
const providerMedia = require('../mias/lib/providerMedia.cjs');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const AUDIUS_HOSTS = [
  'https://discoveryprovider.audius.co',
  'https://discoveryprovider2.audius.co',
  'https://discoveryprovider3.audius.co',
];

async function fetchJSON(url, { timeout = 15000, method = 'GET', headers = {}, body, signal } = {}) {
  const res = await fetch(url, {
    method,
    headers: { 'user-agent': UA, accept: '*/*', ...headers },
    body, redirect: 'follow', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + new URL(url).host);
  return res.json();
}

async function fetchBuf(url, timeout = 180000, signal) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: '*/*' },
    redirect: 'follow', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + new URL(url).host);
  return Buffer.from(await res.arrayBuffer());
}

function ytId(u) {
  const m = String(u || '').match(/(?:youtu\.be\/|[?&]v=|shorts\/|embed\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

// ── magic-byte validation (never send HTML/JSON as media again) ─────────────
function looksAudio(b) {
  if (!b || b.length < 5000) return false;
  return b.slice(0, 3).toString() === 'ID3'
      || (b[0] === 0xFF && (b[1] & 0xE0) === 0xE0)          // mp3 frame
      || b.slice(4, 8).toString() === 'ftyp'                 // m4a/mp4a
      || b.slice(0, 4).toString() === 'OggS'
      || b.slice(0, 4).toString() === 'fLaC'
      || b.slice(0, 4).toString() === 'RIFF';
}
function looksVideo(b) {
  if (!b || b.length < 10000) return false;
  return b.slice(4, 8).toString() === 'ftyp'
      || (b[0] === 0x1A && b[1] === 0x45 && b[2] === 0xDF && b[3] === 0xA3); // EBML
}

async function ensureMp4(buffer) {
  if (!looksVideo(buffer)) throw new Error('INVALID_VIDEO_BYTES');
  if (buffer.subarray(4, 8).toString() === 'ftyp') return buffer;
  if (buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return remuxWebmToMp4(buffer);
  throw new Error('UNSUPPORTED_VIDEO_CONTAINER');
}

// ── YouTube search (piped mirrors → html scrape) ────────────────────────────
async function searchYouTube(query) {
  query = String(query || '').trim();
  if (/^https?:\/\//i.test(query) && ytId(query)) {
    return { videoId: ytId(query), url: 'https://youtu.be/' + ytId(query), title: query };
  }
  let last;
  for (const h of PIPED_HOSTS) {
    try {
      const d = await fetchJSON(h + '/search?q=' + encodeURIComponent(query) + '&filter=videos', { timeout: 9000 });
      const v = (d.items || []).find(x => x && x.url && x.url.includes('watch?v='));
      if (!v) throw new Error('no items');
      const id = v.url.split('watch?v=')[1].split('&')[0];
      return {
        videoId: id, url: 'https://youtu.be/' + id,
        title: v.title || query, author: v.uploaderName || null,
        duration: v.duration || null, views: v.viewCount || null,
        thumb: 'https://i.ytimg.com/vi/' + id + '/hqdefault.jpg',
      };
    } catch (e) { last = e; }
  }
  try {
    const res = await fetch('https://www.youtube.com/results?search_query=' + encodeURIComponent(query),
      { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(12000) });
    const html = await res.text();
    const m = html.match(/"videoId":"([A-Za-z0-9_-]{11})"/);
    if (m) {
      const id = m[1];
      const tm = html.match(new RegExp('"videoId":"' + id + '"[\\s\\S]{0,600}?"title":\\{"runs":\\[\\{"text":"([^"]{1,150})"'));
      return { videoId: id, url: 'https://youtu.be/' + id, title: tm ? tm[1] : query, thumb: 'https://i.ytimg.com/vi/' + id + '/hqdefault.jpg' };
    }
  } catch (e) { last = e; }
  try {
    const sData = await fetchJSON('https://api.siputzx.my.id/api/s/youtube?query=' + encodeURIComponent(query), { timeout: 10000 });
    const items = Array.isArray(sData?.data) ? sData.data : (Array.isArray(sData) ? sData : []);
    const item = items.find(x => x?.videoId || (x?.url && ytId(x.url)));
    if (item) {
      const id = item.videoId || ytId(item.url);
      return {
        videoId: id,
        url: 'https://youtu.be/' + id,
        title: item.title || query,
        author: item.author?.name || null,
        duration: item.duration?.timestamp || item.timestamp || null,
        views: item.views || null,
        thumb: item.thumbnail || item.image || ('https://i.ytimg.com/vi/' + id + '/hqdefault.jpg'),
      };
    }
  } catch (e) { last = e; }
  throw new Error('YouTube search failed: ' + (last && last.message));
}

// ── oEmbed author enrichment (never "Unknown" when YouTube knows it) ────────
async function enrichAuthor(meta) {
  if (meta && !meta.author && (meta.url || meta.videoId)) {
    try {
      const ytUrl = meta.url || ('https://www.youtube.com/watch?v=' + meta.videoId);
      const d = await fetchJSON('https://www.youtube.com/oembed?url=' + encodeURIComponent(ytUrl) + '&format=json', { timeout: 8000 });
      if (d && d.author_name) meta.author = d.author_name;
      if (d && d.title && (!meta.title || meta.title === meta.url)) meta.title = d.title;
    } catch (e) {}
  }
  return meta;
}

// ── PrinceTechn resolvers (live-verified 2026-09-23) ────────────────────────
async function princeResolve(ytUrl, kind, signal) {
  const ep = kind === 'video' ? 'ytmp4' : 'ytmp3';
  const d = await fetchJSON(PRINCE_BASE + '/' + ep + '?apikey=' + PRINCE_KEY + '&url=' + encodeURIComponent(ytUrl), { timeout: kind === 'video' ? 60000 : 20000, signal });
  const r = d && (d.result || d.data);
  const u = r && (r.downloadUrl || r.download_url || r.url || r.audio || r.video || r.mp3 || r.mp4);
  if (!u || !/^https?:\/\//.test(u)) throw new Error('princetechn returned no file url');
  return { url: u, title: r.title, author: r.author, duration: r.duration, thumb: r.thumbnail };
}

// ── keyless audio fallbacks ─────────────────────────────────────────────────
async function audiusTrack(query, signal) {
  let hosts = AUDIUS_HOSTS, last;
  try {
    const list = await fetchJSON('https://api.audius.co', { timeout: 6000, signal });
    if (Array.isArray(list.data) && list.data.length) hosts = [...list.data.slice(0, 3), ...AUDIUS_HOSTS];
  } catch (e) {}
  for (const h of hosts) {
    try {
      const d = await fetchJSON(h + '/v1/tracks/search?query=' + encodeURIComponent(query) + '&limit=5&app_name=mais-bot', { timeout: 12000, signal });
      const t = (d.data || []).find(x => x && x.is_streamable !== false) || (d.data || [])[0];
      if (!t) throw new Error('no match');
      return { url: h + '/v1/tracks/' + t.id + '/stream?app_name=mais-bot', title: t.title, artist: t.user && t.user.name, ext: '.mp3', mime: 'audio/mpeg', src: 'audius' };
    } catch (e) { last = e; }
  }
  throw last || new Error('audius failed');
}
async function deezerTrack(query, signal) {
  const d = await fetchJSON('https://api.deezer.com/search?q=' + encodeURIComponent(query) + '&limit=5', { timeout: 10000, signal });
  const t = (d.data || []).find(x => x && x.preview);
  if (!t) throw new Error('no deezer match');
  return { url: t.preview, title: t.title, artist: t.artist && t.artist.name, ext: '.mp3', mime: 'audio/mpeg', src: 'deezer', preview: true };
}
async function itunesTrack(query, signal) {
  const d = await fetchJSON('https://itunes.apple.com/search?term=' + encodeURIComponent(query) + '&media=music&entity=song&limit=5', { timeout: 10000, signal });
  const t = (d.results || []).find(x => x && x.previewUrl);
  if (!t) throw new Error('no itunes match');
  return { url: t.previewUrl, title: t.trackName, artist: t.artistName, ext: '.m4a', mime: 'audio/mp4', src: 'itunes', preview: true };
}


// SaveTube is an independent resolver fallback. Always obtain a fresh media
// URL and validate downloaded bytes before sending anything to WhatsApp.
async function saveTubeResolve(ytUrl, kind, signal) {
  const headers = { 'content-type': 'application/json', origin: 'https://yt-mp4.net', referer: 'https://yt-mp4.net/',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' };
  const { cdn } = await fetchJSON('https://media.savetube.vip/api/random-cdn', { timeout: 12000, headers, signal });
  if (!/^[a-z0-9.-]+$/i.test(String(cdn || ''))) throw new Error('invalid media CDN');
  const info = await fetchJSON(`https://${cdn}/v2/info`, { method: 'POST', headers, body: JSON.stringify({ url: ytUrl }), timeout: 20000, signal });
  if (!info?.status || !info?.data) throw new Error(info?.message || 'media info unavailable');
  const encrypted = Buffer.from(info.data, 'base64');
  if (encrypted.length < 32 || encrypted.length % 16) throw new Error('invalid media info');
  const decipher = crypto.createDecipheriv('aes-128-cbc', Buffer.from('C5D58EF67A7584E4A29F6C35BBC4EB12', 'hex'), encrypted.subarray(0, 16));
  const video = JSON.parse(Buffer.concat([decipher.update(encrypted.subarray(16)), decipher.final()]).toString('utf8'));
  const qualities = kind === 'audio' ? ['128'] : [...new Set((video.video_formats || []).map(f => String(f.quality || f.height || '').match(/\d+/)?.[0]).filter(Boolean))].sort((a,b) => Number(b)-Number(a));
  for (const quality of qualities) {
    const result = await fetchJSON(`https://${cdn}/download`, { method: 'POST', headers, body: JSON.stringify({ downloadType: kind === 'audio' ? 'audio' : 'video', quality, key: video.key }), timeout: 20000, signal });
    const url = result?.data?.downloadUrl;
    if (result?.status && providerMedia.isHttpUrl(url)) return { url, title: video.title || 'YouTube', height: Number(quality) || 0, src: 'savetube' };
  }
  throw new Error('no playable media format');
}


async function savenowDownload(ytUrl, format, signal) {
  const apiKey = process.env.YTDL_API_KEY || "dfcb6d76f2f6a9894gjkege8a4ab232222";
  const startUrl = "https://p.savenow.to/ajax/download.php?" + new URLSearchParams({
    copyright: "0",
    format: String(format),
    url: ytUrl,
    api: apiKey
  });
  const headers = {
    accept: "*/*",
    referer: "https://y2down.cc/",
    origin: "https://y2down.cc",
    "user-agent": UA
  };
  const initRes = await fetch(startUrl, { headers, signal });
  const init = await initRes.json().catch(() => null);
  if (!init || !init.progress_url) throw new Error("savenow failed to initialize: " + (init?.text || "no progress_url"));
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("savenow aborted");
    await new Promise(r => setTimeout(r, 1500));
    try {
      const pRes = await fetch(init.progress_url, { headers, signal });
      const p = await pRes.json();
      if (p?.download_url) {
        return { url: p.download_url, title: init.title || p.title || "media" };
      }
      if (p && p.success === 0 && p.text && /error|fail/i.test(p.text)) {
        throw new Error("savenow conversion failed: " + p.text);
      }
    } catch (e) {
      if (e?.message?.includes("savenow conversion failed")) throw e;
    }
  }
  throw new Error("savenow polling timed out");
}

function runMediaFfmpeg(args, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    let bin = 'ffmpeg';
    for (const candidate of ['../mias/node_modules/ffmpeg-static', '../node_modules/ffmpeg-static']) {
      try { const ffmpeg = require(candidate); if (ffmpeg && require('node:fs').existsSync(ffmpeg)) { bin = ffmpeg; break; } } catch {}
    }
    let child, stderr = '';
    try { child = spawn(bin, ['-hide_banner','-loglevel','error','-y',...args], {stdio:['ignore','ignore','pipe']}); } catch (e) { reject(e); return; }
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('MP4 remux timed out')); }, timeoutMs);
    child.stderr.on('data', d => { stderr = (stderr + d.toString()).slice(-4000); });
    child.once('error', e => { clearTimeout(timer); reject(e); });
    child.once('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(stderr.trim().split('\n').pop() || `ffmpeg exited ${code}`)); });
  });
}

async function muxToMp4(inputs, mode = 'copy') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mais-video-'));
  const paths = inputs.map((_, i) => path.join(dir, `input-${i}.bin`));
  const output = path.join(dir, 'output.mp4');
  try {
    await Promise.all(inputs.map((buf, i) => fs.writeFile(paths[i], buf)));
    const inputArgs = paths.flatMap(p => ['-i', p]);
    const maps = mode.startsWith('separate') ? ['-map','0:v:0','-map','1:a:0?'] : ['-map','0:v:0?','-map','0:a:0?'];
    const args = mode === 'copy' || mode === 'separate' ? ['-c','copy'] : ['-c:v','libx264','-preset','veryfast','-crf','20','-pix_fmt','yuv420p','-c:a','aac','-b:a','160k'];
    await runMediaFfmpeg([...inputArgs,...maps,...args,'-movflags','+faststart',output]);
    const result = await fs.readFile(output);
    if (!looksVideo(result) || result.subarray(4,8).toString() !== 'ftyp') throw new Error('Remux did not produce a valid MP4');
    return result;
  } finally { await fs.rm(dir,{recursive:true,force:true}).catch(()=>{}); }
}

async function muxTracksToMp4(video, audio) {
  try { return await muxToMp4([video,audio],'separate'); }
  catch { return await muxToMp4([video,audio],'separate-transcode'); }
}

async function remuxWebmToMp4(buffer) {
  try { return await muxToMp4([buffer],'copy'); }
  catch { return await muxToMp4([buffer],'transcode'); }
}

function collectYtdlBuffer(stream, timeoutMs = 180000) {
  return new Promise((resolve,reject) => {
    const chunks=[]; const timer=setTimeout(()=>stream.destroy(new Error('ytdl timeout')),timeoutMs);
    stream.on('data', c=>chunks.push(c)); stream.once('end',()=>{clearTimeout(timer);resolve(Buffer.concat(chunks));});
    stream.once('error',e=>{clearTimeout(timer);reject(e);});
  });
}

// ── PUBLIC API: resolve audio (full song first, previews last resort) ───────
async function resolveAudio(meta) {
  meta = meta || {};
  const raw = meta.url || meta.videoUrl || '';
  const id = ytId(raw) || (/^[A-Za-z0-9_-]{11}$/.test(meta.videoId || '') ? meta.videoId : null);
  const ytUrl = id ? 'https://www.youtube.com/watch?v=' + id : null;
  const title = meta.title || meta.query || 'audio';
  const controller = new AbortController();
  const signal = controller.signal;
  const deadline = setTimeout(() => controller.abort(), 120000);
  const failures = [];
  // Validate actual bytes, not provider filename guesses. Prexzy often returns
  // AAC in M4A, while NexRay can return Opus inside WebM rather than Ogg.
  const readAudio = async (track) => {
    if (!providerMedia.isHttpUrl(track?.url)) throw new Error('NO_AUDIO_URL');
    if (['audius', 'deezer', 'itunes'].includes(track.src)) {
      const normalize = text => String(text || '').toLowerCase().normalize('NFKD')
        .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
      const requested = normalize(title), found = normalize(track.title);
      if (!requested || !found || requested !== found) throw new Error('UNRELATED_CATALOG_RESULT');
    }
    const buf = await fetchBuf(track.url, 35000, signal);
    const webm = buf.length >= 5000 && buf.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    if (!looksAudio(buf) && !webm) throw new Error('INVALID_AUDIO_BYTES');
    let mime = 'audio/mpeg', ext = '.mp3';
    if (buf.subarray(4, 8).toString() === 'ftyp') { mime = 'audio/mp4'; ext = '.m4a'; }
    else if (buf.subarray(0, 4).toString() === 'OggS') { mime = 'audio/ogg'; ext = '.ogg'; }
    else if (webm) { mime = 'audio/webm'; ext = '.webm'; }
    else if (buf.subarray(0, 4).toString() === 'fLaC') { mime = 'audio/flac'; ext = '.flac'; }
    else if (buf.subarray(0, 4).toString() === 'RIFF') { mime = 'audio/wav'; ext = '.wav'; }
    else if (buf[0] === 0xff && (buf[1] & 0xf6) === 0xf0) { mime = 'audio/aac'; ext = '.aac'; }
    return { buf, title: track.title || title, author: track.author || track.artist || meta.author,
      mime, ext, src: track.src, preview: !!track.preview };
  };
  const attempt = async (name, task) => {
    if (signal.aborted) return null;
    try { return await readAudio({ ...await task(), src: name }); }
    catch { failures.push(name); return null; }
  };
  try {
    if (meta.dlUrl && providerMedia.isHttpUrl(meta.dlUrl)) {
      const result = await attempt('cached-audio', async () => ({ url: meta.dlUrl }));
      if (result) return result;
    }
    if (ytUrl) {
      const providers = [
        ['nexray-mp3', async () => providerMedia.pickAudio(await fetchJSON(
          'https://api.nexray.eu.cc/downloader/ytmp3?url=' + encodeURIComponent(ytUrl), { timeout: 20000, signal }))],
        ['princetechn', () => princeResolve(ytUrl, 'audio', signal)],
        ['prexzy', async () => {
          const base = String(process.env.PREXZY_API || 'https://prexzyapis.com').replace(/\/$/, '');
          return providerMedia.pickAudio(await fetchJSON(base + '/download/ytmp3?url=' + encodeURIComponent(ytUrl), { timeout: 20000, signal }));
        }],
        ['nexray-aio', async () => providerMedia.pickAudio(await fetchJSON(
          'https://api.nexray.eu.cc/downloader/aio?url=' + encodeURIComponent(ytUrl), { timeout: 20000, signal }))],
      ];
      for (const [name, task] of providers) {
        const result = await attempt(name, task);
        if (result) return result;
      }
      const saveTube = await attempt('savetube', () => saveTubeResolve(ytUrl, 'audio', signal));
      if (saveTube) return saveTube;
      const savenow = await attempt('savenow-mp3', () => savenowDownload(ytUrl, 'mp3', signal));
      if (savenow) return savenow;
    }
    for (const [name, fn] of [['audius', audiusTrack], ['deezer', deezerTrack], ['itunes', itunesTrack]]) {
      const result = await attempt(name, () => fn(title, signal));
      if (result) return result;
    }
    // Log provider names only: signed CDN links and credentials are private.
    console.warn('[audio] No playable result:', failures.join(', '), signal.aborted ? '(deadline reached)' : '');
    throw new Error(signal.aborted
      ? 'Audio download timed out after 120 seconds. Please retry.'
      : 'No provider returned playable audio. Please retry with a YouTube link.');
  } finally {
    clearTimeout(deadline);
    controller.abort();
  }
}

// ── PUBLIC API: resolve video ───────────────────────────────────────────────
async function resolveVideo(meta) {
  meta = meta || {};
  const ytUrl = meta.url || (meta.videoId ? 'https://youtu.be/' + meta.videoId : null);
  const title = meta.title || 'video';
  if (ytUrl) {
    // Prexzy's current public route uses a different response shape from the
    // old configured host: top-level download_url and info.title.
    try {
      const apiBase = String(process.env.PREXZY_API || 'https://prexzyapis.com').replace(/\/$/, '');
      for (const quality of [2160, 1440, 1080, 720, 480, 360]) {
        const d = await fetchJSON(apiBase + '/download/ytmp4?url=' + encodeURIComponent(ytUrl) + '&quality=' + quality, { timeout: 60000 });
        const picked = providerMedia.pickPrexzyVideo(d);
        const u = picked?.url;
        if (u && /^https?:\/\//i.test(u)) {
          const raw = await fetchBuf(u, 240000);
          try { const buf = await ensureMp4(raw); return { buf, title: picked?.title || title, author: d?.info?.uploader || meta.author, mime: 'video/mp4', ext: '.mp4', src: 'prexzy', quality }; } catch {}
        }
      }
    } catch (e) {}
    try {
      const p = await princeResolve(ytUrl, 'video');
      const raw = await fetchBuf(p.url, 240000);
      const buf = await ensureMp4(raw);
      return { buf, title: p.title || title, author: p.author || meta.author, mime: 'video/mp4', ext: '.mp4', src: 'princetechn' };
    } catch (e) {}
    // NexRay AIO exposes multiple formats under result.medias. Choose the
    // highest real video URL, not result.url (which is the original YouTube page).
    try {
      const d = await fetchJSON('https://api.nexray.eu.cc/downloader/aio?url=' + encodeURIComponent(ytUrl), { timeout: 45000 });
      const r = d?.result || d?.data || d;
      const best = providerMedia.pickNexrayVideo(d);
      if (best?.url) {
        const raw = await fetchBuf(best.url, 240000);
        const buf = await ensureMp4(raw);
        return { buf, title: r?.title || title, author: r?.author || meta.author, mime: 'video/mp4', ext: '.mp4', src: 'nexray-aio', quality: best.height };
      }
    } catch (e) {}
    try {
      const c = new AbortController(), timer = setTimeout(() => c.abort(), 60000);
      try {
        const picked = await saveTubeResolve(ytUrl, 'video', c.signal);
        const raw = await fetchBuf(picked.url, 240000, c.signal);
        const buf = await ensureMp4(raw);
        return { buf, title: picked.title || title, author: meta.author, mime: 'video/mp4', ext: '.mp4', src: 'savetube', quality: picked.height };
      } finally { clearTimeout(timer); c.abort(); }
    } catch (e) {}
    try {
      const c = new AbortController(), timer = setTimeout(() => c.abort(), 60000);
      try {
        for (const q of ["1080", "720", "480", "360"]) {
          try {
            const picked = await savenowDownload(ytUrl, q, c.signal);
            if (picked?.url) {
              const raw = await fetchBuf(picked.url, 240000, c.signal);
              const buf = await ensureMp4(raw);
              return { buf, title: picked.title || title, author: meta.author, mime: 'video/mp4', ext: '.mp4', src: 'savenow', quality: parseInt(q, 10) };
            }
          } catch {}
        }
      } finally { clearTimeout(timer); c.abort(); }
    } catch (e) {}
    try {
      const mod = await import('@distube/ytdl-core').catch(() => null);
      const ytdl = mod && (mod.default || mod);
      if (ytdl) {
        const info = await ytdl.getInfo(ytUrl, { requestOptions: { headers: { 'user-agent': UA } } });
        try {
          const videoFormat = ytdl.chooseFormat(info.formats, { quality: 'highestvideo', filter: 'videoonly' });
          const audioFormat = ytdl.chooseFormat(info.formats, { quality: 'highestaudio', filter: 'audioonly' });
          if (videoFormat?.hasVideo && !videoFormat.hasAudio && audioFormat?.hasAudio) {
            const [videoBuf,audioBuf] = await Promise.all([collectYtdlBuffer(ytdl.downloadFromInfo(info,{format:videoFormat})),collectYtdlBuffer(ytdl.downloadFromInfo(info,{format:audioFormat}))]);
            const merged = await muxTracksToMp4(videoBuf,audioBuf);
            return {buf:merged,title:info.videoDetails?.title||title,mime:'video/mp4',ext:'.mp4',src:'ytdl-core',quality:videoFormat.height||0};
          }
        } catch (e) {}
        const fmt = ytdl.chooseFormat(info.formats, { quality: 'highest', filter: 'audioandvideo' });
        let b = await collectYtdlBuffer(ytdl.downloadFromInfo(info,{format:fmt}));
        if (looksVideo(b)) {
          if (b.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]))) b=await remuxWebmToMp4(b);
          return {buf:b,title:info.videoDetails?.title||title,mime:'video/mp4',ext:'.mp4',src:'ytdl-core',quality:fmt?.height||0};
        }
      }
    } catch (e) {}
  }
  throw new Error('Video providers returned no playable media. Try again shortly, or use .play → option 4.');
}

// A deadline always clears its timer, including synchronous throws. This is
// also used around SDK calls that do not expose an AbortSignal.
async function withDeadline(task, timeoutMs, code = 'DOWNLOAD_TIMEOUT') {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(task),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error(code), { code })), timeoutMs);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

// The first valid download URL wins, not the first provider to fail or return
// null. Cancel losing HTTP requests and consume every rejection.
async function firstUsableResult(providers, { timeoutMs = 12000 } = {}) {
  const controller = new AbortController();
  try {
    return await withDeadline(() => Promise.any(providers.map(provider =>
      Promise.resolve().then(() => provider(controller.signal)).then(result => {
        let url;
        try { url = new URL(result?.dl); } catch { throw new Error('NO_DOWNLOAD_URL'); }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('INVALID_DOWNLOAD_URL');
        return result;
      })
    )), timeoutMs, 'APK_PROVIDER_TIMEOUT');
  } catch { return null; }
  finally { controller.abort(); }
}

// Stream to disk with an absolute deadline, size cap and ZIP magic check.
// APKs are ZIP containers; this rejects HTML/error pages, not a malware scan
// or a cryptographic verification of an application's publisher.

async function downloadMediaToFile(url, destPath, options = {}) {
  const { timeout = 180000, signal } = options;
  const deadline = setTimeout(() => {}, timeout);
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, accept: '*/*' },
      redirect: 'follow',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + new URL(url).host);
    const out = createWriteStream(destPath);
    await pipeline(Readable.fromWeb(res.body), out);
    return destPath;
  } finally {
    clearTimeout(deadline);
  }
}

async function downloadApkToFile(url, filePath, {
  timeoutMs = 90000,
  maxBytes = 1024 * 1024 * 1024, // 1 GB (was 95 MB)
  createWriteStream = require('fs').createWriteStream,
  fetchImpl = fetch,
} = {}) {
  const { Readable, Transform } = require('stream');
  const { pipeline } = require('stream/promises');
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('INVALID_DOWNLOAD_URL');
  const controller = new AbortController();
  const signal = controller.signal;
  const deadline = setTimeout(() => controller.abort(), timeoutMs);
  try {
  const response = await fetchImpl(url, { signal, redirect: 'follow', headers: { 'user-agent': UA } });
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw new Error('APK_HTTP_ERROR');
  }
  const type = String(response.headers.get('content-type') || '');
  if (/text\/|json|xml/i.test(type)) {
    await response.body.cancel().catch(() => {});
    throw new Error('APK_NOT_BINARY');
  }
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body.cancel().catch(() => {});
    throw Object.assign(new Error('APK_TOO_LARGE'), { code: 'APK_TOO_LARGE' });
  }
  let bytes = 0, prefix = Buffer.alloc(0), validated = false;
  const check = new Transform({
    transform(chunk, encoding, done) {
      bytes += chunk.length;
      if (bytes > maxBytes) return done(Object.assign(new Error('APK_TOO_LARGE'), { code: 'APK_TOO_LARGE' }));
      if (!validated) {
        prefix = Buffer.concat([prefix, chunk]);
        if (prefix.length < 4) return done();
        if (!prefix.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) return done(new Error('APK_INVALID_ZIP'));
        validated = true;
        this.push(prefix);
        prefix = null;
      } else this.push(chunk);
      done();
    },
    flush(done) { done(validated && bytes > 1000 ? null : new Error('APK_EMPTY_OR_TRUNCATED')); },
  });
  await pipeline(Readable.fromWeb(response.body), check, createWriteStream(filePath), { signal });
  return bytes;
  } finally { clearTimeout(deadline); }
}

module.exports = {
  withDeadline, firstUsableResult, downloadApkToFile, downloadMediaToFile,
  searchYouTube, enrichAuthor, resolveAudio, resolveVideo,
  fetchJSON, fetchBuf, ytId, looksAudio, looksVideo, ensureMp4,
  PRINCE_BASE, PIPED_HOSTS, saveTubeResolve, remuxWebmToMp4, muxTracksToMp4,
};
