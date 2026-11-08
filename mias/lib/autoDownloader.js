/**
 * AUTO-DOWNLOADER v4 — Universal best-quality resolver.
 * Supports: TikTok, YouTube/Shorts, Facebook, Instagram, X/Twitter,
 *           Pinterest, Spotify, SoundCloud, Threads, Reddit, LinkedIn,
 *           Snapchat, CapCut, MediaFire, Google Drive, Telegram,
 *           XNXX, XVideos, Pornhub, XHamster, ePorner/Eporner, RedTube,
 *           Tube8, Beeg, DrTuber, and more.
 * Fixes v4: YouTube HTTP-403 fix (cobalt v10 headers + yt1s + mate.yt fallbacks),
 *           Spotify intent:// redirect protection, widen Spotify fallback chain.
 */

import { httpClient as axios } from "./engineAccess.js";
import { dcGet as sharedDcGet } from "../davidcyril.js";
import fs from "fs";
import path from "path";
import os from "os";
import { Transform } from "stream";
import { pipeline as streamPipeline } from "stream/promises";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import {
  sendVideo,
  sendAudio,
  sendImage,
  sendDocument,
} from "../handlers/mediaHandler.js";
import {
  reactDownload,
  reactSuccess,
  reactFail,
  reactCustom,
} from "../handlers/reactionHandler.js";

// Load @vreden/youtube_scraper (CommonJS) — same library used by .ytmp4/.ytmp3 commands
const providerMedia = createRequire(import.meta.url)("./providerMedia.cjs");
let _ytdl = null;
try {
  const _req = createRequire(import.meta.url);
  _ytdl = _req("@vreden/youtube_scraper");
} catch (_) {}


let _portableVideo = null;
function getPortableVideo() {
  if (_portableVideo) return _portableVideo;
  try {
    const _req = createRequire(import.meta.url);
    _portableVideo = _req("./portableVideo.cjs");
  } catch (_) {}
  return _portableVideo;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ZERO_BASE   = "https://zeroapi2-production.up.railway.app";
const ZERO_KEY    = process.env.ZERO_API_KEY || "";
const PREXZY_BASE = process.env.PREXZY_API || "https://prexzyapis.com";

const REQUEST_TIMEOUT  = 30000;
const DOWNLOAD_TIMEOUT = 150000;
const MAX_FILE_SIZE_BYTES = Number(process.env.AUTO_DL_MAX_MB || 64) * 1024 * 1024;

const UA = "Mozilla/5.0 (Linux; Android 13; SM-G998B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";

// Remove leftovers from a killed ffmpeg/download process. Only touch files
// created by this bot and only after they are old enough that no active
// request should still be using them.
function getPipelineWorkDir() {
  const p = path.join(process.cwd(), 'pipeline-work', 'tmp');
  try { fs.mkdirSync(p, { recursive: true }); return p; } catch { return os.tmpdir(); }
}
function cleanupStaleTempFiles() {
  const prefixes = [
    "mais_dl_", "mv23_", "_wm_in_", "_wm_out_",
    "dcjail_", "trace_", "sauce_",
  ];
  const cutoff = Date.now() - 60 * 60 * 1000;
  try {
    for (const name of fs.readdirSync(os.tmpdir())) {
      if (!prefixes.some((prefix) => name.startsWith(prefix))) continue;
      const full = path.join(os.tmpdir(), name);
      try {
        if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
      } catch {}
    }
  } catch {}
}
cleanupStaleTempFiles();

// ─── Platform detection ────────────────────────────────────────────────────

const PLATFORM_PATTERNS = {
  tiktok:    /(?:tiktok\.com\/(?:@[^/]+\/video\/|t\/|v\/)|vm\.tiktok\.com\/|vt\.tiktok\.com\/)/i,
  youtube:   /(?:youtube\.com\/(?:watch\?v=|shorts\/|live\/|embed\/)|youtu\.be\/)/i,
  facebook:  /(?:facebook\.com|m\.facebook\.com|fb\.watch|fb\.com)\//i,
  instagram: /instagram\.com\/(?:p|reel|reels|tv|stories)\//i,
  twitter:   /(?:twitter\.com|x\.com)\/[^\s/]+\/status\/\d+/i,
  pinterest: /(?:pinterest\.[a-z.]+\/pin\/|pin\.it\/)/i,
  spotify:   /open\.spotify\.com\/(?:track|album|playlist|episode|show)\//i,
  soundcloud:/soundcloud\.com\//i,
  threads:   /threads\.net\/@[^/]+\/post\//i,
  reddit:    /(?:reddit\.com\/r\/[^/]+\/comments\/|redd\.it\/)/i,
  linkedin:  /linkedin\.com\/(?:posts|feed|in)\//i,
  snapchat:  /snapchat\.com\//i,
  capcut:    /capcut\.com\//i,
  douyin:    /(?:douyin\.com|iesdouyin\.com)\//i,
  terabox:   /(?:terabox\.com|1024terabox\.com|teraboxapp\.com|4funbox\.com)\//i,
  apk:       /(?:\.apk(?:$|[?#])|(?:apkpure\.com|apkmirror\.com|apkcombo\.com|apkmody\.io|play\.google\.com\/store\/apps)\/)/i,
  gitclone:  /(?:github\.com\/[^/]+\/[^/]+|gitlab\.com\/[^/]+\/[^/]+)/i,
  mediafire: /(?:mediafire\.com|mfi\.re)\//i,
  gdrive:    /(?:drive|docs)\.google\.com\//i,
  telegram:  /t\.me\/[^/]+\/\d+/i,
  // Adult sites — extended list
  adult: /(?:xnxx\.com|xvideos\.com|pornhub\.com|xhamster(?:\d*)\.com|eporner\.com|eporrner\.com|redtube\.com|tube8\.com|beeg\.com|drtuber\.com|bravotube\.net|tnaflix\.com|xtube\.com|4tube\.com|fux\.com|hardsextube\.com|keezmovies\.com|nuvid\.com|porndig\.com|txxx\.com|vjav\.com|youporn\.com|spankbang\.com|xempire\.com|hotmovs\.com|hqporner\.com|porn555\.com|anyxxx\.com|porntrex\.com|tubepornclassic\.com|ok\.xxx|hdporn\.net|proporn\.com|sexvid\.xxx|gotporn\.com|videosection\.com|porn\.com|xmoviesforyou\.com)\//i,
};

// Alias used when calling platform-specific API endpoints
const PLATFORM_ALIASES = {
  adult: "xnxx", twitter: "twitter", reddit: "reddit",
  douyin: "douyin", terabox: "terabox", apk: "apk", gitclone: "gitclone",
};

const PLATFORM_ENDPOINTS = {
  youtube:   ["youtube", "yt", "ytmp4"],
  tiktok:    ["tiktok", "tt"],
  facebook:  ["facebook", "fb"],
  instagram: ["instagram", "ig"],
  twitter:   ["twitter", "x", "twitter"],
  pinterest: ["pinterest", "pinterestdl"],
  spotify:   ["spotify", "spotifydl"],
  soundcloud:["soundcloud"],
  threads:   ["threads"],
  reddit:    ["reddit"],
  linkedin:  ["linkedin"],
  snapchat:  ["snapchat"],
  capcut:    ["capcut"],
  douyin:    ["douyin", "dy"],
  terabox:   ["terabox"],
  apk:       ["apk"],
  gitclone:  ["gitclone", "github"],
  mediafire: ["mediafire"],
  gdrive:    ["gdrive"],
  adult:     ["xnxx", "xvideos", "pornhub", "xhamster"],
};

export function detectPlatform(text) {
  for (const [platform, regex] of Object.entries(PLATFORM_PATTERNS)) {
    if (regex.test(String(text || ""))) return platform;
  }
  return null;
}

export function extractUrl(text) {
  if (!text) return null;
  const candidates = [];
  const httpMatches = String(text).match(/https?:\/\/[^\s"'<>]+/gi) || [];
  candidates.push(...httpMatches);

  const bareDomains = [
    "tiktok\\.com","youtube\\.com","youtu\\.be","facebook\\.com","fb\\.watch","fb\\.com",
    "instagram\\.com","twitter\\.com","x\\.com","pinterest\\.[a-z.]+","pin\\.it",
    "open\\.spotify\\.com","soundcloud\\.com","threads\\.net","reddit\\.com","redd\\.it",
    "linkedin\\.com","snapchat\\.com","capcut\\.com","mediafire\\.com","mfi\\.re",
    "douyin\\.com","iesdouyin\\.com","terabox\\.com","1024terabox\\.com","teraboxapp\\.com",
    "apkpure\\.com","apkmirror\\.com","apkcombo\\.com","apkmody\\.io","github\\.com","gitlab\\.com",
    "drive\\.google\\.com","docs\\.google\\.com","t\\.me",
    "xnxx\\.com","xvideos\\.com","pornhub\\.com","xhamster\\.com","eporner\\.com",
    "eporrner\\.com","redtube\\.com","tube8\\.com","beeg\\.com","drtuber\\.com",
    "spankbang\\.com","youporn\\.com","hqporner\\.com","txxx\\.com","vjav\\.com",
    "bravotube\\.net","tnaflix\\.com","nuvid\\.com","porndig\\.com","hotmovs\\.com",
  ].join("|");
  const bareDomain = new RegExp(`(?:^|\\s)((?:(?:www\\.|m\\.)?(?:${bareDomains})\\/[^\\s"'<>]+))`, "gi");
  let match;
  while ((match = bareDomain.exec(String(text)))) {
    candidates.push(`https://${match[1].replace(/^https?:\/\//i, "")}`);
  }

  for (const raw of candidates) {
    const cleaned = raw.trim().replace(/[\].,;!?)'"`]+$/g, "");
    if (detectPlatform(cleaned)) return cleaned;
  }
  return null;
}

// ─── HTTP helpers ──────────────────────────────────────────────────────────

async function httpGet(url, opts = {}) {
  const urlStr = String(url || "");
  // Guard 1: skip non-HTTP protocols (intent://, market://, etc.) — axios cannot handle them
  if (!urlStr.match(/^https?:\/\//i)) return { ok: false, error: "Non-HTTP URL: " + urlStr.slice(0, 60) };
  try {
    const { data, headers, request } = await axios.get(urlStr, {
      timeout: opts.timeout || REQUEST_TIMEOUT,
      maxRedirects: 8,
      headers: { "User-Agent": UA, "Accept": "application/json,text/html,*/*", ...(opts.headers || {}) },
      validateStatus: () => true,
    });
    // Guard 2: if axios followed a redirect to a non-HTTP scheme, silently ignore
    const finalUrl = request?.res?.responseUrl || urlStr;
    if (!String(finalUrl).match(/^https?:\/\//i)) return { ok: false, error: "Redirect to non-HTTP: " + String(finalUrl).slice(0, 60) };
    return { ok: true, data, headers, finalUrl };
  } catch (e) {
    // Guard 3: swallow intent:// / market:// redirect errors that slip past maxRedirects
    if (/intent:|market:|Unsupported protocol|Redirected request failed/i.test(e.message)) {
      return { ok: false, error: "Blocked non-HTTP redirect: " + e.message.slice(0, 80) };
    }
    return { ok: false, error: e.message };
  }
}

async function httpPostForm(url, form, opts = {}) {
  try {
    const params = new URLSearchParams(form);
    const { data } = await axios.post(url, params.toString(), {
      timeout: opts.timeout || REQUEST_TIMEOUT,
      headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded", ...(opts.headers || {}) },
      validateStatus: () => true,
    });
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function httpPostJson(url, body, opts = {}) {
  try {
    const { data } = await axios.post(url, body, {
      timeout: opts.timeout || REQUEST_TIMEOUT,
      headers: { "User-Agent": UA, "Accept": "application/json", "Content-Type": "application/json", ...(opts.headers || {}) },
      validateStatus: () => true,
    });
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function zeroGet(endpoint, params = {}, timeout = REQUEST_TIMEOUT) {
  const qs = new URLSearchParams(params).toString();
  return httpGet(`${ZERO_BASE}${endpoint}${qs ? "?" + qs : ""}`, {
    timeout,
    headers: { "x-api-key": ZERO_KEY, Authorization: `Bearer ${ZERO_KEY}` },
  });
}

async function dcGet(endpoint, params = {}, timeout = REQUEST_TIMEOUT) {
  return sharedDcGet(endpoint, params, timeout);
}

async function prexzyGet(endpoint, params = {}, timeout = REQUEST_TIMEOUT) {
  const qs = new URLSearchParams(params).toString();
  return httpGet(`${PREXZY_BASE}${endpoint}${qs ? "?" + qs : ""}`, { timeout });
}

function cleanupTemp(tmpPath) {
  try { if (tmpPath && fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
}

function preferredType(platform) {
  if (["spotify", "soundcloud"].includes(platform)) return "audio";
  if (["mediafire", "gdrive"].includes(platform)) return "document";
  return "video";
}

function inferTypeFromKey(key = "", value = "") {
  const k = String(key).toLowerCase();
  const v = String(value).toLowerCase().split("?")[0];
  if (/(audio|music|mp3|m4a|song|sound)/.test(k) || /\.(mp3|m4a|aac|ogg|opus|wav|flac)$/.test(v)) return "audio";
  if (/(image|photo|thumb|thumbnail|cover|avatar|poster)/.test(k) || /\.(jpg|jpeg|png|webp|gif)$/.test(v)) return "image";
  if (/(video|play|hd|sd|mp4|webm|download|url|source)/.test(k) || /\.(mp4|m4v|webm|mov|mkv)$/.test(v)) return "video";
  return "document";
}

function qualityScore(key = "", obj = {}) {
  const k = String(key).toLowerCase();
  const label = String(obj?.quality || obj?.qualityLabel || obj?.resolution || obj?.format || "").toLowerCase();
  if (/2160|4k|uhd/.test(k + label)) return 900;
  if (/1440|2k/.test(k + label)) return 800;
  if (/1080|fhd|fullhd/.test(k + label)) return 700;
  if (/720|hd/.test(k + label)) return 600;
  if (/480/.test(k + label)) return 400;
  if (/360|sd/.test(k + label)) return 300;
  if (/no[_-]?watermark|nowm|hdplay|hd_url/.test(k)) return 650;
  if (/sd/.test(k)) return 350;
  return 100;
}

function collectCandidates(node, keyPath = "", parent = null, out = []) {
  if (!node) return out;
  if (typeof node === "string") {
    const val = node.replace(/\\\//g, "/").trim();
    if (/^https?:\/\//i.test(val)) {
      out.push({ url: val, type: inferTypeFromKey(keyPath, val), score: qualityScore(keyPath, parent || {}) });
    }
    return out;
  }
  if (Array.isArray(node)) {
    node.forEach((item, i) => collectCandidates(item, `${keyPath}.${i}`, item, out));
    return out;
  }
  if (typeof node === "object") {
    for (const [k, v] of Object.entries(node)) collectCandidates(v, keyPath ? `${keyPath}.${k}` : k, node, out);
  }
  return out;
}

function extractTitle(data, fallback) {
  const d = data?.data || data?.result || data;
  return d?.title || d?.name || d?.filename || d?.fileName || data?.title || fallback;
}

function extractThumb(data) {
  const d = data?.data || data?.result || data;
  return d?.thumbnail || d?.thumb || d?.cover || d?.image || data?.thumbnail || null;
}

function pickBestCandidate(data, platform, fallbackTitle) {
  const want = preferredType(platform);
  const candidates = collectCandidates(data)
    .filter(c => !/\.m3u8(?:\?|$)/i.test(c.url))
    .filter(c => !/sprite|avatar|profile_pic/i.test(c.url));

  if (!candidates.length) return null;
  const typeWeight = (type) => {
    if (want === "audio") return type === "audio" ? 10000 : type === "video" ? 3000 : 0;
    if (want === "document") return type === "document" ? 9000 : type === "video" ? 8000 : type === "audio" ? 7000 : 5000;
    return type === "video" ? 10000 : type === "audio" ? 5000 : type === "image" ? (platform === "pinterest" ? 3000 : 1000) : 500;
  };
  candidates.sort((a, b) => (typeWeight(b.type) + b.score) - (typeWeight(a.type) + a.score));
  const best = candidates[0];
  return { url: best.url, type: best.type, title: extractTitle(data, fallbackTitle), thumb: extractThumb(data), _via: "generic" };
}

// ─── Expand short URLs ─────────────────────────────────────────────────────

async function expandUrl(url) {
  try {
    const r = await httpGet(url, { timeout: 12000, headers: { Accept: "text/html,*/*" } });
    return r.finalUrl || url;
  } catch {
    return url;
  }
}

// ─── Platform-specific resolvers ───────────────────────────────────────────

async function fromTikwm(url, platform) {
  const r = await httpPostForm("https://www.tikwm.com/api/", { url, hd: "1" }, { headers: { Referer: "https://www.tikwm.com/" } });
  const d = r.data?.data;
  if (!d) return null;
  const rawImages = Array.isArray(d.images) ? d.images : (Array.isArray(d.image_post_info?.images) ? d.image_post_info.images.map(x => x?.display_image?.url_list?.[0] || x) : []);
  const images = rawImages.filter(x => typeof x === "string" && x);
  if (images.length > 0) {
    return {
      type: "slider",
      images,
      music: d.music || d.play,
      title: d.title || platform,
      thumb: d.cover,
      _via: "tikwm"
    };
  }
  const dl = d.hdplay || d.play || d.wmplay || d.video;
  if (!dl) return null;
  const fullUrl = String(dl).startsWith("http") ? dl : `https://www.tikwm.com${dl}`;
  return { url: fullUrl, type: "video", title: d.title || platform, thumb: d.cover, _via: "tikwm" };
}

// ─── YouTube resolvers (in priority order) ─────────────────────────────────

async function fromCobalt(url, platform) {
  const isAudio = preferredType(platform) === "audio";
  const body = {
    url,
    downloadMode: isAudio ? "audio" : "auto",
    videoQuality: "1080",
    youtubeVideoCodec: "h264",
    filenameStyle: "basic",
    audioFormat: isAudio ? "mp3" : undefined,
  };
  // Cobalt v10 API — requires Accept: application/json header
  const endpoints = [
    "https://api.cobalt.tools/",
    "https://cobalt.imput.net/",
    "https://cobalt.synth.zip/",
    "https://cobalt.tools/",
  ];
  const cobaltHeaders = {
    "Accept": "application/json",
    "Content-Type": "application/json",
    "User-Agent": UA,
  };
  for (const ep of endpoints) {
    try {
      const r = await httpPostJson(ep, body, { timeout: 45000, headers: cobaltHeaders });
      if (!r.ok || !r.data) continue;
      const status = String(r.data?.status || "");
      // v10 uses "tunnel"/"redirect"/"picker" — accept all non-error statuses
      if (status && ["error", "rate-limit"].includes(status)) continue;
      if (r.data?.url) return { url: r.data.url, type: isAudio ? "audio" : "video", title: r.data?.filename || platform, _via: "cobalt" };
      const direct = pickBestCandidate(r.data, platform, platform);
      if (direct?.url) return { ...direct, _via: "cobalt" };
    } catch {}
  }
  return null;
}

// ─── YouTube extra fallbacks ────────────────────────────────────────────────

async function fromYt1s(url) {
  try {
    // Step 1: analyse
    const vid = url.match(/(?:v=|shorts\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/)?.[1];
    if (!vid) return null;
    const analyzeR = await httpPostJson(
      "https://yt1s.com/api/ajaxSearch/index",
      { q: `https://www.youtube.com/watch?v=${vid}`, vt: "home" },
      { headers: { Referer: "https://yt1s.com/", Origin: "https://yt1s.com" }, timeout: 25000 }
    );
    if (!analyzeR.ok) return null;
    const links = analyzeR.data?.links?.mp4 || {};
    let bestKey = null, bestH = 0;
    for (const [k, info] of Object.entries(links)) {
      const h = parseInt(String(info?.f || info?.q || "0").replace(/[^0-9]/g, "")) || 0;
      if (h > bestH) { bestH = h; bestKey = k; }
    }
    if (!bestKey) return null;
    // Step 2: convert
    const convertR = await httpPostJson(
      "https://yt1s.com/api/ajaxConvert/convert",
      { vid, k: bestKey },
      { headers: { Referer: "https://yt1s.com/", Origin: "https://yt1s.com" }, timeout: 30000 }
    );
    const dlUrl = convertR.data?.dlink || convertR.data?.url;
    if (dlUrl && String(dlUrl).startsWith("http")) return { url: dlUrl, type: "video", title: analyzeR.data?.title || "YouTube", _via: "yt1s" };
  } catch {}
  return null;
}

async function fromMateYt(url) {
  try {
    // mate.yt — simple query-based downloader
    const r = await httpGet(`https://mate.yt/dl?url=${encodeURIComponent(url)}&format=mp4&quality=720`, { timeout: 25000 });
    if (r.ok && r.data?.url) return { url: r.data.url, type: "video", title: r.data?.title || "YouTube", _via: "mate.yt" };
  } catch {}
  try {
    // yt5s.io
    const r2 = await httpPostJson(
      "https://yt5s.io/api/ajaxSearch",
      { q: url, vt: "home" },
      { headers: { Referer: "https://yt5s.io/", Origin: "https://yt5s.io" }, timeout: 25000 }
    );
    const links = r2.data?.links?.mp4 || {};
    const first = Object.values(links)[0];
    if (first?.url) return { url: first.url, type: "video", title: r2.data?.title || "YouTube", _via: "yt5s" };
  } catch {}
  return null;
}

async function fromSsYtAlt(url) {
  try {
    // ssyoutube.app alternate endpoint
    const r = await httpPostJson(
      "https://ssyoutube.app/api/convert",
      { url },
      { headers: { Referer: "https://ssyoutube.app/", Origin: "https://ssyoutube.app" }, timeout: 25000 }
    );
    if (r.data?.downloadUrl || r.data?.url) {
      const dlUrl = r.data.downloadUrl || r.data.url;
      return { url: dlUrl, type: "video", title: r.data?.title || "YouTube", _via: "ssyoutube-app" };
    }
  } catch {}
  try {
    // dlvideo.io
    const r2 = await httpGet(`https://dlvideo.io/api?url=${encodeURIComponent(url)}&format=mp4`, { timeout: 25000 });
    if (r2.ok && r2.data?.url) return { url: r2.data.url, type: "video", title: "YouTube", _via: "dlvideo" };
  } catch {}
  return null;
}

async function fromYtdlp(url) {
  // Hosted yt-dlp API services
  const services = [
    `https://yt.artemislena.eu/api/v1/videos/${encodeURIComponent(url.match(/(?:v=|shorts\/|youtu\.be\/)([^&?/]+)/)?.[1] || "")}`,
    `https://invidious.snopyta.org/api/v1/videos/${url.match(/(?:v=|shorts\/|youtu\.be\/)([^&?/]+)/)?.[1] || ""}`,
  ];
  for (const ep of services) {
    try {
      const r = await httpGet(ep, { timeout: 20000 });
      if (!r.ok || !r.data?.adaptiveFormats) continue;
      const formats = r.data.adaptiveFormats.filter(f => f.type?.startsWith("video/mp4") && f.url);
      formats.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
      if (formats[0]?.url) return { url: formats[0].url, type: "video", title: r.data.title || "YouTube", _via: "invidious" };
    } catch {}
  }
  return null;
}

async function fromY2mate(url) {
  try {
    // Step 1: Get video ID and available formats
    const analyzeR = await httpPostForm(
      "https://www.y2mate.com/mates/en68/analyzeV2/ajax",
      { k_query: url, k_page: "home", hl: "en", q_auto: "0" },
      { headers: { Referer: "https://www.y2mate.com/" }, timeout: 20000 }
    );
    if (!analyzeR.ok || !analyzeR.data) return null;
    const data = analyzeR.data;
    const vid = data?.vid;
    if (!vid) return null;
    // Find best mp4 format key
    const links = data?.links?.mp4 || {};
    let bestKey = null, bestHeight = 0;
    for (const [k, info] of Object.entries(links)) {
      const h = parseInt(String(info?.f || "").replace(/[^0-9]/g, "") || "0");
      if (h > bestHeight) { bestHeight = h; bestKey = k; }
    }
    if (!bestKey) return null;
    // Step 2: Get download URL
    const convertR = await httpPostForm(
      "https://www.y2mate.com/mates/en68/convertV2/index",
      { vid, k: bestKey },
      { headers: { Referer: "https://www.y2mate.com/" }, timeout: 25000 }
    );
    const dlUrl = convertR.data?.dlink;
    if (!dlUrl) return null;
    return { url: dlUrl, type: "video", title: data?.title || "YouTube", _via: "y2mate" };
  } catch {
    return null;
  }
}

async function fromYoutubeSnap(url) {
  try {
    const r = await httpPostJson(
      "https://ssyoutube.com/api/convert",
      { url, apiKey: "" },
      { headers: { Referer: "https://ssyoutube.com/" }, timeout: 25000 }
    );
    if (r.data?.url) return { url: r.data.url, type: "video", title: r.data?.title || "YouTube", _via: "ssyoutube" };
  } catch {}
  try {
    // savefrom.net style
    const r2 = await httpPostForm(
      "https://worker.sf-tools.com/savefrom.php",
      { sf_url: url },
      { headers: { Referer: "https://en.savefrom.net/", Origin: "https://en.savefrom.net" }, timeout: 25000 }
    );
    if (r2.data?.url) {
      const candidates = Array.isArray(r2.data.url) ? r2.data.url : [r2.data.url];
      const best = candidates.filter(u => u?.url && /mp4/i.test(u?.ext || u?.type || "")).sort((a,b)=>(parseInt(b.name||"0")-(parseInt(a.name||"0"))))[0];
      if (best?.url) return { url: best.url, type: "video", title: r2.data?.title || "YouTube", _via: "savefrom" };
    }
  } catch {}
  return null;
}

async function fromYtLoader(url) {
  try {
    // loader.to
    const r = await httpGet(`https://loader.to/ajax/download.php?format=mp4&url=${encodeURIComponent(url)}`, {
      timeout: 25000,
      headers: { Referer: "https://loader.to/" },
    });
    if (r.data?.success && r.data?.id) {
      const id = r.data.id;
      for (let i = 0; i < 10; i++) {
        await new Promise(res => setTimeout(res, 3000));
        const prog = await httpGet(`https://loader.to/ajax/progress.php?id=${id}`, { timeout: 10000 });
        if (prog.data?.download_url) return { url: prog.data.download_url, type: "video", title: "YouTube", _via: "loader.to" };
        if (prog.data?.success === 1 && prog.data?.text) {
          const dlUrl = prog.data.text;
          if (/^https?:\/\//.test(dlUrl)) return { url: dlUrl, type: "video", title: "YouTube", _via: "loader.to" };
        }
      }
    }
  } catch {}
  return null;
}

// ─── Spotify resolvers ─────────────────────────────────────────────────────

async function fromSpotifyDown(url) {
  const trackId = String(url).match(/open\.spotify\.com\/track\/([^?/#]+)/i)?.[1];
  if (!trackId) return null;
  const r = await httpGet(`https://api.spotifydown.com/download/${trackId}`, {
    timeout: 45000,
    headers: { Origin: "https://spotifydown.com", Referer: "https://spotifydown.com/" },
  });
  if (r.data?.success && r.data?.link) {
    return { url: r.data.link, type: "audio", title: r.data?.metadata?.title || "Spotify Track", thumb: r.data?.metadata?.cover, _via: "spotifydown" };
  }
  return null;
}

async function fromSpotifySave(url) {
  try {
    const r = await httpGet(`https://spotify-down.com/api/download?url=${encodeURIComponent(url)}`, {
      timeout: 30000,
      headers: { Referer: "https://spotify-down.com/", Origin: "https://spotify-down.com" },
    });
    if (r.data?.downloadLink || r.data?.link || r.data?.url) {
      const dlUrl = r.data.downloadLink || r.data.link || r.data.url;
      return { url: dlUrl, type: "audio", title: r.data?.title || r.data?.name || "Spotify Track", _via: "spotify-down.com" };
    }
  } catch {}
  return null;
}

async function fromSpotifyMate(url) {
  try {
    const r = await httpPostJson(
      "https://spotifymate.com/api/fetchSpotify",
      { url },
      { headers: { Referer: "https://spotifymate.com/", Origin: "https://spotifymate.com" }, timeout: 30000 }
    );
    const dl = r.data?.data?.downloadUrl || r.data?.downloadUrl || r.data?.url;
    if (dl) return { url: dl, type: "audio", title: r.data?.data?.title || "Spotify Track", _via: "spotifymate" };
  } catch {}
  return null;
}

// ─── Pinterest resolvers ───────────────────────────────────────────────────

async function fromPinterestPage(url) {
  const r = await httpGet(url, { timeout: 20000, headers: { Accept: "text/html" } });
  if (!r.ok || !r.data) return null;
  const html = String(r.data);
  const unescape = (s) => String(s || "").replace(/&amp;/g, "&").replace(/\\u002F/g, "/");
  const og = (re) => unescape((html.match(re) || [])[1]);
  const video = og(/<meta[^>]+property=["']og:video(?::url)?["'][^>]+content=["']([^"']+)["']/i)
    || og(/"video_url"\s*:\s*"([^"]+)"/i)
    || og(/"url"\s*:\s*"([^"]+\.mp4[^"]*)"/i);
  if (video) return { url: video, type: "video", title: "Pinterest", thumb: og(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i), _via: "pinterest-page" };
  const image = og(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
  if (image) return { url: image, type: "image", title: "Pinterest", _via: "pinterest-page" };
  return null;
}

// ─── Reddit resolver ───────────────────────────────────────────────────────

async function fromReddit(url) {
  try {
    // Reddit JSON API
    const jsonUrl = url.replace(/\/$/, "") + ".json?limit=1";
    const r = await httpGet(jsonUrl, {
      timeout: 20000,
      headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0 (compatible; bot/1.0)" },
    });
    if (!r.ok || !Array.isArray(r.data)) return null;
    const post = r.data[0]?.data?.children?.[0]?.data;
    if (!post) return null;
    // Video post
    if (post.is_video && post.media?.reddit_video) {
      const vid = post.media.reddit_video;
      const vidUrl = vid.fallback_url || vid.hls_url || vid.dash_url;
      if (vidUrl) return { url: vidUrl.replace(/\?.*$/, ""), type: "video", title: post.title || "Reddit", thumb: post.thumbnail, _via: "reddit-json" };
    }
    // Hosted image/gif
    if (post.url_overridden_by_dest) {
      const u = post.url_overridden_by_dest;
      if (/\.(mp4|webm|gifv?)$/i.test(u)) return { url: u.replace(/\.gifv$/, ".mp4"), type: "video", title: post.title || "Reddit", _via: "reddit-json" };
      if (/\.(jpg|jpeg|png|webp|gif)$/i.test(u)) return { url: u, type: "image", title: post.title || "Reddit", _via: "reddit-json" };
    }
    // Gallery
    if (post.gallery_data && post.media_metadata) {
      const firstKey = Object.keys(post.media_metadata)[0];
      const img = post.media_metadata[firstKey];
      const src = img?.s?.u || img?.p?.[img.p.length - 1]?.u;
      if (src) return { url: src.replace(/&amp;/g, "&"), type: "image", title: post.title || "Reddit", _via: "reddit-gallery" };
    }
  } catch {}
  return null;
}

// ─── MediaFire resolver ────────────────────────────────────────────────────

async function fromMediaFire(url) {
  try {
    const resolver = createRequire(import.meta.url)("./mediafireResolver.cjs");
    const dl = await resolver.resolveMediaFire(url, { timeoutMs: 20000 });
    return { url: dl, type: "document", title: "MediaFire File", _via: "mediafire-safe-resolver" };
  } catch (primaryError) {
    const r = await httpGet(url, { timeout: 20000, headers: { Accept: "text/html" } });
    if (!r?.ok) throw new Error("MediaFire page could not be loaded");
    const html = String(r.data || "");
    const candidates = [
      html.match(/id=["']downloadButton["'][^>]*href=["']([^"']+)["']/i)?.[1],
      html.match(/href=["'](https?:\/\/download[^"']+mediafire\.com[^"']+)["']/i)?.[1],
    ].filter(Boolean);
    const dl = candidates.map(x => x.replace(/&amp;/g, "&")).find(x => {
      try { const parsed = new URL(x, url); return /^https?:$/.test(parsed.protocol) && /(?:^|\.)mediafire\.com$/i.test(parsed.hostname); } catch { return false; }
    });
    const title = (html.match(/class=["']dl-btn-label["'][^>]*>([^<]+)/i) || html.match(/<title>([^<]+)/i))?.[1]?.replace(/ - MediaFire$/i, "").trim();
    if (dl) return { url: new URL(dl, url).href, type: "document", title: title || "MediaFire File", _via: "mediafire-page" };
    throw primaryError;
  }
}

// ─── Adult resolvers ───────────────────────────────────────────────────────

async function fromPornhub(url) {
  try {
    const viewkeyMatch = url.match(/viewkey=([^&]+)/i) || url.match(/\/view_video\.php\?viewkey=([^&]+)/i);
    if (!viewkeyMatch) return null;
    const vk = viewkeyMatch[1];
    const r = await httpGet(`https://www.pornhub.com/webmasters/video_by_id?id=${vk}`, {
      timeout: 25000,
      headers: { Accept: "application/json", Referer: "https://www.pornhub.com/" },
    });
    if (r.data?.video?.medias?.length) {
      const medias = r.data.video.medias.sort((a,b) => (parseInt(b.quality)||0) - (parseInt(a.quality)||0));
      const best = medias.find(m => m.format === "mp4" && m.videoUrl) || medias[0];
      if (best?.videoUrl) return { url: best.videoUrl, type: "video", title: r.data.video.title || "PornHub", thumb: r.data.video.thumb, _via: "pornhub-api" };
    }
  } catch {}
  return null;
}

async function fromXhamster(url) {
  try {
    const r = await httpGet(url, {
      timeout: 25000,
      headers: { Accept: "text/html", Referer: "https://xhamster.com/" },
    });
    const html = String(r.data || "");
    // Extract video sources from page
    const sourceMatch = html.match(/sources\s*:\s*(\{[^}]+(?:mp4|webm)[^}]+\})/i)
      || html.match(/"sources"\s*:\s*(\{[^}]+\})/i)
      || html.match(/xhsource\s*=\s*\{([^}]+)\}/i);
    if (sourceMatch) {
      const srcJson = sourceMatch[1].replace(/'/g, '"');
      try {
        const parsed = JSON.parse(srcJson);
        const urls = Object.entries(parsed).filter(([,v]) => typeof v === "string" && /^https?/.test(v));
        urls.sort((a,b) => (parseInt(b[0])||0) - (parseInt(a[0])||0));
        if (urls[0]?.[1]) return { url: urls[0][1], type: "video", title: (html.match(/<title>([^<]+)/i)||[])[1] || "xHamster", _via: "xhamster-page" };
      } catch {}
    }
    // Try OG video tag
    const ogVideo = (html.match(/<meta[^>]+property=["']og:video(?::url)?["'][^>]+content=["']([^"']+)["']/i)||[])[1];
    if (ogVideo) return { url: ogVideo, type: "video", title: "xHamster", _via: "xhamster-og" };
  } catch {}
  return null;
}

async function fromEporner(url) {
  try {
    // eporner & eporrner both work the same
    const normalized = url.replace("eporrner.com", "eporner.com");
    const r = await httpGet(normalized, {
      timeout: 25000,
      headers: { Accept: "text/html", Referer: "https://www.eporner.com/" },
    });
    const html = String(r.data || "");
    // Try MP4 sources
    const mp4Match = html.match(/"sources"\s*:\s*\[([^\]]+)\]/i)
      || html.match(/sources\s*=\s*\[([^\]]+)\]/i);
    if (mp4Match) {
      const sources = (mp4Match[1].match(/https?[^\s"',]+(?:\.mp4|quality=)[^\s"',]*/gi) || []);
      if (sources.length) return { url: sources[0], type: "video", title: (html.match(/<title>([^<]+)/i)||[])[1] || "ePorner", _via: "eporner-page" };
    }
    const ogVideo = (html.match(/<meta[^>]+property=["']og:video(?::url)?["'][^>]+content=["']([^"']+)["']/i)||[])[1];
    if (ogVideo) return { url: ogVideo, type: "video", title: "ePorner", _via: "eporner-og" };
  } catch {}
  return null;
}

// ─── Proven APIs from case.js commands (davidcyril / prexzyvilla / prince / vreden) ──

const PREXZY_BASE2 = process.env.PREXZY_API || "https://prexzyapis.com";
const PRINCE_BASE = "https://api.princetechn.com";
const PRINCE_KEY  = "prince";
const UA2 = "Mozilla/5.0 (Linux; Android 13; SM-G998B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";

/** @vreden/youtube_scraper — mp4 */
async function fromVredenMp4(url) {
  if (!_ytdl) return null;
  try {
    const data = await _ytdl.mp4(url);
    const dlUrl = data?.url || data?.download;
    if (dlUrl && String(dlUrl).startsWith("http")) {
      return { url: dlUrl, type: "video", title: data?.title || "YouTube", _via: "vreden-mp4" };
    }
  } catch (_) {}
  return null;
}

/** @vreden/youtube_scraper — mp3 */
async function fromVredenMp3(url) {
  if (!_ytdl) return null;
  try {
    const data = await _ytdl.mp3(url);
    const dlUrl = data?.url || data?.download;
    if (dlUrl && String(dlUrl).startsWith("http")) {
      return { url: dlUrl, type: "audio", title: data?.title || "YouTube", _via: "vreden-mp3" };
    }
  } catch (_) {}
  return null;
}

/** prexzyvilla ytmp4 API */
async function fromPrexzyYtMp4(url) {
  try {
    const r = await axios.get(`${PREXZY_BASE2}/download/ytmp4?url=${encodeURIComponent(url)}&quality=1080`,
      { timeout: 40000, headers: { "User-Agent": UA2 } });
    const picked = providerMedia.pickPrexzyVideo(r.data);
    if (picked?.url) return { ...picked, type: "video", _via: "prexzy-ytmp4" };
  } catch (_) {}
  return null;
}

/** prexzyvilla ytmp3 API */
async function fromPrexzyYtMp3(url) {
  try {
    const r = await axios.get(`${PREXZY_BASE2}/download/ytmp3?url=${encodeURIComponent(url)}`,
      { timeout: 40000, headers: { "User-Agent": UA2 } });
    const d = r.data?.result || r.data?.data || r.data;
    const dlUrl = d?.url || d?.audio || d?.download;
    if (dlUrl && String(dlUrl).startsWith("http")) return { url: dlUrl, type: "audio", title: d?.title || "YouTube", _via: "prexzy-ytmp3" };
  } catch (_) {}
  return null;
}

/** davidcyril Facebook API */
async function fromDcFb(url) {
  try {
    const r = await sharedDcGet("/facebook", { url }, 30000);
    if (!r.ok) return null;
    const d = r.data?.result || r.data?.data || r.data;
    const dlUrl = d?.hd || d?.sd || d?.url || d?.video || (Array.isArray(d?.videos) ? d.videos[0]?.url : null);
    if (dlUrl && String(dlUrl).startsWith("http")) return { url: dlUrl, type: "video", title: d?.title || "Facebook", _via: "davidcyril-fb" };
  } catch (_) {}
  return null;
}

/** prexzyvilla Facebook API */
async function fromPrexzyFb(url) {
  try {
    const r = await axios.get(`${PREXZY_BASE2}/download/facebook?url=${encodeURIComponent(url)}`,
      { timeout: 30000, headers: { "User-Agent": UA2 } });
    const d = r.data?.result || r.data?.data || r.data;
    const dlUrl = d?.hd || d?.sd || d?.url || d?.video;
    if (dlUrl && String(dlUrl).startsWith("http")) return { url: dlUrl, type: "video", title: d?.title || "Facebook", _via: "prexzy-fb" };
  } catch (_) {}
  return null;
}

/** prexzyvilla Instagram API */
async function fromPrexzyIg(url) {
  try {
    const r = await axios.get(`${PREXZY_BASE2}/download/instagram?url=${encodeURIComponent(url)}`,
      { timeout: 30000, headers: { "User-Agent": UA2 } });
    const d = r.data?.result || r.data?.data || r.data;
    const dlUrl = (Array.isArray(d) ? d[0]?.url : null) || d?.url || d?.video;
    const imgUrl = d?.image || d?.thumbnail;
    if (dlUrl && String(dlUrl).startsWith("http")) return { url: dlUrl, type: "video", title: "Instagram", _via: "prexzy-ig" };
    if (imgUrl && String(imgUrl).startsWith("http")) return { url: imgUrl, type: "image", title: "Instagram", _via: "prexzy-ig-img" };
  } catch (_) {}
  return null;
}

/** davidcyril Instagram API */
async function fromDcIg(url) {
  try {
    const r = await sharedDcGet("/instagram", { url }, 30000);
    if (!r.ok) return null;
    const d = r.data?.result || r.data?.data || r.data;
    const dlUrl = (Array.isArray(d) ? d[0]?.url : null) || d?.url || d?.video;
    const imgUrl = d?.image || d?.thumbnail;
    if (dlUrl && String(dlUrl).startsWith("http")) return { url: dlUrl, type: "video", title: "Instagram", _via: "davidcyril-ig" };
    if (imgUrl && String(imgUrl).startsWith("http")) return { url: imgUrl, type: "image", title: "Instagram", _via: "davidcyril-ig-img" };
  } catch (_) {}
  return null;
}

/** prince API — Twitter (same as .twitter command uses) */
async function fromPrinceTw(url) {
  try {
    const r = await axios.get(`${PRINCE_BASE}/api/download/twitter`,
      { params: { apikey: PRINCE_KEY, url }, timeout: 25000, headers: { "User-Agent": UA2 } });
    const d = r.data?.result || r.data;
    const dlUrl = d?.hd || d?.sd || d?.url
      || (Array.isArray(d?.variants) ? d.variants.sort((a,b) => (b.bitrate||0)-(a.bitrate||0))[0]?.url : null);
    if (dlUrl && String(dlUrl).startsWith("http")) return { url: dlUrl, type: "video", title: d?.title || d?.text?.slice(0,80) || "Twitter", _via: "prince-twitter" };
    // v2 fallback
    const r2 = await axios.get(`${PRINCE_BASE}/api/download/twitterv2`,
      { params: { apikey: PRINCE_KEY, url }, timeout: 25000, headers: { "User-Agent": UA2 } });
    const d2 = r2.data?.result || r2.data;
    const dlUrl2 = d2?.hd || d2?.sd || d2?.url;
    if (dlUrl2 && String(dlUrl2).startsWith("http")) return { url: dlUrl2, type: "video", title: "Twitter/X", _via: "prince-twitter-v2" };
  } catch (_) {}
  return null;
}

/** davidcyril Spotify direct download */
async function fromDcSpotify(url) {
  if (!String(url || "").includes("spotify.com")) return null;
  try {
    const r = await sharedDcGet("/download/spotify", { url }, 45000);
    if (!r.ok) return null;
    const d = r.data?.result || r.data?.data || r.data;
    const dlUrl = d?.url || d?.audio || d?.download;
    if (dlUrl && String(dlUrl).startsWith("http")) return { url: dlUrl, type: "audio", title: d?.title || d?.name || "Spotify Track", _via: "davidcyril-spotify" };
  } catch (_) {}
  return null;
}

/** Spotify → YouTube search → vreden/prexzy mp3 (mirrors case.js Spotify command) */
async function fromSpotifyViaYt(url) {
  try {
    // Get track metadata
    const trackId = String(url).match(/open\.spotify\.com\/track\/([a-zA-Z0-9]+)/i)?.[1];
    let title = "", artist = "";
    if (trackId) {
      try {
        const info = await sharedDcGet("/spotify/track", { id: trackId }, 15000);
        if (!info.ok) throw new Error(info.error || "DavidCyril track lookup failed");
        const d = info.data?.result || info.data?.data || info.data;
        title = d?.name || d?.title || "";
        artist = d?.artists?.[0]?.name || d?.artist || "";
      } catch (_) {
        try {
          const info2 = await axios.get(`${PREXZY_BASE2}/music/spotify?id=${trackId}`, { timeout: 15000 });
          const d2 = info2.data?.result || info2.data;
          title = d2?.name || "";
          artist = d2?.artists?.[0]?.name || "";
        } catch (_2) {}
      }
    }
    if (!title) return null;
    const q = artist ? `${title} ${artist}` : title;
    // Search YouTube
    const ytSearchRes = await axios.get(`https://www.youtube.com/results?search_query=${encodeURIComponent(q + " audio")}`,
      { headers: { "User-Agent": UA2 }, timeout: 15000 });
    const vidIdMatch = String(ytSearchRes.data).match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
    if (!vidIdMatch) return null;
    const ytUrl = `https://www.youtube.com/watch?v=${vidIdMatch[1]}`;
    // prexzy first (proxied CDN), then cobalt, then vreden last
    const px = await fromPrexzyYtMp3(ytUrl).catch(() => null);
    if (px?.url) return { ...px, title: title || px.title, _via: "spotify-yt-prexzy" };
    const cob = await fromCobalt(ytUrl, "spotify").catch(() => null);
    if (cob?.url) return { ...cob, title: title || cob.title, _via: "spotify-yt-cobalt" };
    const vr = await fromVredenMp3(ytUrl).catch(() => null);
    if (vr?.url) return { ...vr, title: title || vr.title, _via: "spotify-yt-vreden" };
  } catch (_) {}
  return null;
}

// ─── Instagram/Twitter/Facebook via multiple services ─────────────────────

async function fromInstaSave(url) {
  try {
    const r = await httpPostJson(
      "https://snapinsta.app/api",
      { q: url, t: "media", lang: "en" },
      { headers: { Referer: "https://snapinsta.app/", Origin: "https://snapinsta.app" }, timeout: 25000 }
    );
    const candidate = pickBestCandidate(r.data, "instagram", "Instagram");
    if (candidate?.url) return { ...candidate, _via: "snapinsta" };
  } catch {}
  return null;
}

async function fromSsig(url) {
  try {
    const r = await httpPostForm(
      "https://ssinstagram.com/download",
      { url },
      { headers: { Referer: "https://ssinstagram.com/" }, timeout: 25000 }
    );
    const candidate = pickBestCandidate(r.data, "instagram", "Instagram");
    if (candidate?.url) return { ...candidate, _via: "ssinstagram" };
  } catch {}
  return null;
}

async function fromSnapfb(url) {
  try {
    const r = await httpPostForm(
      "https://snapsave.app/action.php",
      { url },
      { headers: { Referer: "https://snapsave.app/", Origin: "https://snapsave.app" }, timeout: 25000 }
    );
    const candidate = pickBestCandidate(r.data, "facebook", "Facebook");
    if (candidate?.url) return { ...candidate, _via: "snapsave" };
  } catch {}
  return null;
}

async function fromFbDownloader(url) {
  try {
    const r = await httpGet(`https://fdown.net/download.php?URLz=${encodeURIComponent(url)}`, {
      timeout: 25000,
      headers: { Referer: "https://fdown.net/" },
    });
    const html = String(r.data || "");
    const hdMatch = html.match(/href=["'](https?:\/\/[^"']+\.mp4[^"']*)["'][^>]*>.*?HD/i);
    const sdMatch = html.match(/href=["'](https?:\/\/[^"']+\.mp4[^"']*)["']/i);
    const dlUrl = hdMatch?.[1] || sdMatch?.[1];
    if (dlUrl) return { url: dlUrl.replace(/&amp;/g, "&"), type: "video", title: "Facebook Video", _via: "fdown" };
  } catch {}
  return null;
}

async function fromVxTwitter(url) {
  try {
    // vxtwitter gives back direct media URL via OG tags
    const vxUrl = url.replace(/(?:twitter\.com|x\.com)/, "vxtwitter.com");
    const r = await httpGet(vxUrl, { timeout: 20000, headers: { Accept: "text/html" } });
    const html = String(r.data || "");
    const ogVideo = (html.match(/<meta[^>]+property=["']og:video(?::url)?["'][^>]+content=["']([^"']+)["']/i)||[])[1];
    if (ogVideo) return { url: ogVideo.replace(/&amp;/g, "&"), type: "video", title: (html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)||[])[1] || "X/Twitter", _via: "vxtwitter" };
  } catch {}
  return null;
}

async function fromFxTwitter(url) {
  try {
    // fxtwitter JSON endpoint
    const tweetId = url.match(/status\/(\d+)/)?.[1];
    if (!tweetId) return null;
    const r = await httpGet(`https://api.fxtwitter.com/status/${tweetId}`, { timeout: 20000 });
    const media = r.data?.tweet?.media;
    if (media?.videos?.[0]?.url) return { url: media.videos[0].url, type: "video", title: r.data.tweet?.text?.slice(0,80) || "Twitter", _via: "fxtwitter" };
    if (media?.photos?.[0]?.url) return { url: media.photos[0].url, type: "image", title: "Twitter", _via: "fxtwitter" };
  } catch {}
  return null;
}

async function fromTwitsave(url) {
  try {
    const r = await httpGet(`https://twitsave.com/info?url=${encodeURIComponent(url)}`, {
      timeout: 25000,
      headers: { Referer: "https://twitsave.com/" },
    });
    const candidate = pickBestCandidate(r.data, "twitter", "X/Twitter");
    if (candidate?.url) return { ...candidate, _via: "twitsave" };
  } catch {}
  return null;
}

/** savevideonow / getfvid / loader.to FB fallbacks */
async function fromSaveFb(url) {
  // Try getfvid.com (works well for FB Reels & share URLs)
  try {
    const r = await httpPostForm(
      "https://getfvid.com/downloader",
      { url, fburl: url },
      { headers: { Referer: "https://getfvid.com/", Origin: "https://getfvid.com" }, timeout: 25000 }
    );
    const html = String(r.data || "");
    const hdUrl = (html.match(/href=["'](https?:\/\/[^"']+\.mp4[^"']*)["'][^>]*>\s*(?:.*?HD|HD.*?)\s*</i) || html.match(/href=["'](https?:\/\/video\.xx\.[^"']+\.mp4[^"']*)["']/i))?.[1];
    const anyUrl = (html.match(/href=["'](https?:\/\/[^"']+(?:\.mp4|fbcdn[^"']*|video[^"']*))[^"']*["'][^>]*>(?:[^<]*(?:download|HD|SD|video)[^<]*)<\/a>/i))?.[1];
    const dlUrl = (hdUrl || anyUrl || "").replace(/&amp;/g, "&");
    if (dlUrl && dlUrl.startsWith("http")) return { url: dlUrl, type: "video", title: "Facebook Video", _via: "getfvid" };
  } catch {}
  // Try fbvideo.to
  try {
    const r2 = await httpPostForm(
      "https://fbvideo.to/ajax/fb.php",
      { url },
      { headers: { Referer: "https://fbvideo.to/", Origin: "https://fbvideo.to", "X-Requested-With": "XMLHttpRequest" }, timeout: 20000 }
    );
    const d = r2.data;
    const dl = (d?.hd_link || d?.sd_link || d?.url || "").replace(/&amp;/g, "&");
    if (dl && dl.startsWith("http")) return { url: dl, type: "video", title: "Facebook Video", _via: "fbvideo.to" };
  } catch {}
  // Try savefb.net
  try {
    const r3 = await httpGet(`https://savefb.net/api?url=${encodeURIComponent(url)}`, { timeout: 20000 });
    const d3 = r3.data;
    const dl3 = d3?.hd || d3?.sd || d3?.url || (Array.isArray(d3?.links) ? d3.links[0]?.url : null);
    if (dl3 && String(dl3).startsWith("http")) return { url: dl3, type: "video", title: d3?.title || "Facebook Video", _via: "savefb.net" };
  } catch {}
  return null;
}

// ─── Generic AIO fallback chain ────────────────────────────────────────────

const AIO_ENDPOINTS = [
  { name: "zero-api",          run: async (u, p) => zeroGet(`/api/${PLATFORM_ALIASES[p] || p}`,        { url: u }, 45000) },
  { name: "zero-download",     run: async (u, p) => zeroGet(`/download/${PLATFORM_ALIASES[p] || p}`,   { url: u }, 45000) },
  { name: "zero-aio",          run: async (u)    => zeroGet("/download/aio",                            { url: u }, 45000) },
  { name: "prexzy-download",   run: async (u, p) => prexzyGet(`/download/${PLATFORM_ALIASES[p] || p}`, { url: u }, 45000) },
  { name: "prexzy-downloader", run: async (u, p) => prexzyGet(`/downloader/${PLATFORM_ALIASES[p] || p}`,{ url: u }, 45000) },
  { name: "prexzy-aio",        run: async (u)    => prexzyGet("/download/aio",                          { url: u }, 45000) },
  { name: "nexray-aio",        run: async (u)    => httpGet(`https://api.nexray.eu.cc/downloader/aio?url=${encodeURIComponent(u)}`, { timeout: 45000 }) },
  { name: "davidcyril",        run: async (u, p) => dcGet(`/download/${PLATFORM_ALIASES[p] || p}`,      { url: u }, 45000) },
  { name: "siputzx-platform",  run: async (u, p) => httpGet(`https://api.siputzx.my.id/api/d/${PLATFORM_ALIASES[p] || p}?url=${encodeURIComponent(u)}`) },
  { name: "siputzx-aio",       run: async (u)    => httpGet(`https://api.siputzx.my.id/api/d/aio?url=${encodeURIComponent(u)}`) },
  { name: "ryzendesu-platform",run: async (u, p) => httpGet(`https://api.ryzendesu.vip/api/downloader/${PLATFORM_ALIASES[p] || p}?url=${encodeURIComponent(u)}`) },
  { name: "ryzendesu-aio",     run: async (u)    => httpGet(`https://api.ryzendesu.vip/api/downloader/aio?url=${encodeURIComponent(u)}`) },
  { name: "gifted",            run: async (u, p) => httpGet(`https://api.giftedtech.web.id/api/download/${PLATFORM_ALIASES[p] || p}?apikey=gifted&url=${encodeURIComponent(u)}`) },
  { name: "bk9",               run: async (u, p) => httpGet(`https://bk9.fun/download/${PLATFORM_ALIASES[p] || p}?url=${encodeURIComponent(u)}`) },
  { name: "aemt",              run: async (u, p) => httpGet(`https://aemt.me/download/${PLATFORM_ALIASES[p] || p}?url=${encodeURIComponent(u)}`) },
  { name: "fasturl",           run: async (u, p) => httpGet(`https://api.fasturl.cloud/download/${PLATFORM_ALIASES[p] || p}?url=${encodeURIComponent(u)}`) },
  { name: "widipe",            run: async (u, p) => httpGet(`https://widipe.com/download/${PLATFORM_ALIASES[p] || p}dl?url=${encodeURIComponent(u)}`) },
  { name: "btch-aio",          run: async (u)    => httpGet(`https://btch.us/api/aio?url=${encodeURIComponent(u)}`) },
  { name: "lolhuman",          run: async (u, p) => httpGet(`https://api.lolhuman.xyz/api/${PLATFORM_ALIASES[p] || p}?apikey=lohmn&url=${encodeURIComponent(u)}`) },
  { name: "nexoracle",         run: async (u, p) => httpGet(`https://api.nexoracle.com/downloader/${PLATFORM_ALIASES[p] || p}?apikey=free_key&url=${encodeURIComponent(u)}`) },
  { name: "mrsn",              run: async (u, p) => httpGet(`https://api.mrsn.top/downloader/${PLATFORM_ALIASES[p] || p}?url=${encodeURIComponent(u)}`) },
];

async function aioFallback(url, platform) {
  const names = PLATFORM_ENDPOINTS[platform] || [PLATFORM_ALIASES[platform] || platform];
  const errors = [];
  for (const endpointName of names) {
    for (const api of AIO_ENDPOINTS) {
      try {
        const r = await api.run(url, endpointName);
        if (!r?.ok && !r?.data) { errors.push(`${api.name}:net`); continue; }
        let best = null;
        if (api.name === "nexray-aio") {
          const selected = providerMedia.pickNexrayVideo(r.data, { maxBytes: MAX_FILE_SIZE_BYTES });
          if (selected?.url) best = { ...selected, _via: "nexray-aio" };
        } else {
          best = pickBestCandidate(r.data, platform, endpointName);
        }
        if (best?.url) return { result: best, errors };
        errors.push(`${api.name}:empty`);
      } catch (e) {
        errors.push(`${api.name}:${e.message?.slice(0, 40)}`);
      }
    }
  }
  return { result: null, errors };
}

// ─── Buffer validation ─────────────────────────────────────────────────────

function detectBufferType(buf, contentType = "", requested = "video") {
  const ct = String(contentType || "").toLowerCase();
  const start = buf.slice(0, 64);
  const ascii = start.toString("ascii");
  const utf = start.toString("utf8").trim().toLowerCase();
  if (utf.startsWith("<!doctype") || utf.startsWith("<html") || utf.startsWith("<?xml") || utf.startsWith("{")) {
    return { type: "bad", ext: "bin", mimetype: ct || "text/html" };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) return { type: "image", ext: "jpg", mimetype: "image/jpeg" };
  if (buf.slice(0, 8).toString("hex") === "89504e470d0a1a0a") return { type: "image", ext: "png", mimetype: "image/png" };
  if (ascii.startsWith("RIFF") && ascii.includes("WEBP")) return { type: "image", ext: "webp", mimetype: "image/webp" };
  if (ascii.startsWith("GIF")) return { type: "image", ext: "gif", mimetype: "image/gif" };
  if (ascii.includes("ftyp") || ascii.includes("moov") || ascii.includes("mdat")) {
    return requested === "audio" || ct.includes("audio") ? { type: "audio", ext: "m4a", mimetype: "audio/mp4" } : { type: "video", ext: "mp4", mimetype: "video/mp4" };
  }
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return { type: "video", ext: "webm", mimetype: "video/webm" };
  if (ascii.startsWith("ID3") || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) return { type: "audio", ext: "mp3", mimetype: "audio/mpeg" };
  if (ascii.startsWith("OggS")) return { type: "audio", ext: "ogg", mimetype: "audio/ogg; codecs=opus" };
  if (ascii.startsWith("fLaC")) return { type: "audio", ext: "flac", mimetype: "audio/flac" };
  if (ct.startsWith("video/")) return { type: "video", ext: ct.includes("webm") ? "webm" : "mp4", mimetype: ct.split(";")[0] };
  if (ct.startsWith("audio/")) return { type: "audio", ext: ct.includes("ogg") ? "ogg" : "mp3", mimetype: ct.split(";")[0] };
  if (ct.startsWith("image/")) return { type: "image", ext: ct.includes("png") ? "png" : ct.includes("webp") ? "webp" : "jpg", mimetype: ct.split(";")[0] };
  return { type: requested === "document" ? "document" : requested, ext: requested === "audio" ? "mp3" : requested === "image" ? "jpg" : requested === "document" ? "bin" : "mp4", mimetype: "application/octet-stream" };
}

async function downloadToTemp(url, requestedType = "video") {
  const _dlHeaders = (referer) => ({
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "*/*",
    "Referer": referer,
    "Accept-Encoding": "gzip, deflate, br",
  });
  const _referer = /youtu/i.test(url) ? "https://www.youtube.com/"
    : /facebook|fbcdn/i.test(url) ? "https://www.facebook.com/"
    : /spotify/i.test(url) ? "https://open.spotify.com/"
    : "https://www.google.com/";
  // Responses are streamed to a temp file (never buffered whole in RAM).
  const _getStream = (headers) => axios.get(url, {
    responseType: "stream",
    timeout: DOWNLOAD_TIMEOUT,
    maxRedirects: 10,
    headers,
    validateStatus: () => true,
  });
  let response;
  try {
    response = await _getStream(_dlHeaders(_referer));
  } catch (e) {
    // Guard: intent:// / market:// redirect → Android deep-link, not a real download URL
    if (/intent:|market:|Unsupported protocol|Redirected request failed/i.test(e.message || "")) {
      throw new Error("Download URL is an app deep-link (intent://), not a direct media file — Spotify/FB API returned an app-redirect instead of audio/video");
    }
    throw e;
  }
  // Retry 403 with YouTube/Facebook CDN-specific headers (CDNs block generic UAs)
  if (response.status === 403) {
    try {
      const _retry = await _getStream({
        ..._dlHeaders(_referer),
        "Origin": _referer.replace(/\/$/, ""),
        "Sec-Fetch-Dest": requestedType === "audio" ? "audio" : "video",
        "Sec-Fetch-Mode": "no-cors",
        "Sec-Fetch-Site": "cross-site",
        "Range": "bytes=0-",
      });
      response.data?.destroy?.();
      response = _retry;
    } catch (_) {}
  }
  if (response.status >= 400) {
    response.data?.destroy?.();
    throw new Error(`Download server returned HTTP ${response.status}`);
  }
  const rawPath = path.join(getPipelineWorkDir(), `mais_dl_${Date.now()}_${Math.random().toString(36).slice(2)}.part`);
  let size = 0;
  const _byteCap = new Transform({
    transform(chunk, _enc, cb) {
      size += chunk.length;
      if (size > MAX_FILE_SIZE_BYTES) {
        cb(new Error(`File too large (${Math.round(size / 1024 / 1024)}MB > ${Math.round(MAX_FILE_SIZE_BYTES / 1024 / 1024)}MB)`));
        return;
      }
      cb(null, chunk);
    },
  });
  try {
    await streamPipeline(response.data, _byteCap, fs.createWriteStream(rawPath));
    if (size < 700) throw new Error(`Downloaded file too small (${size}B)`);
    const handle = await fs.promises.open(rawPath, "r");
    let prefix;
    try {
      prefix = Buffer.alloc(Math.min(64, size));
      const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
      prefix = prefix.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
    const detected = detectBufferType(prefix, response.headers?.["content-type"], requestedType);
    if (detected.type === "bad") throw new Error("Downloader returned an error page instead of media");
    const tmpPath = path.join(getPipelineWorkDir(), `mais_dl_${Date.now()}_${Math.random().toString(36).slice(2)}.${detected.ext || "mp4"}`);
    await fs.promises.rename(rawPath, tmpPath);
    return { tmpPath, ...detected, size };
  } catch (error) {
    await fs.promises.rm(rawPath, { force: true }).catch(() => {});
    throw error;
  }
}

// ─── Main resolver ─────────────────────────────────────────────────────────

async function resolvePlatformMedia(url, platform) {
  const expanded = (platform === "pinterest" || /pin\.it\//i.test(url)) ? await expandUrl(url) : url;

  // ── APK links ── resolve store/repository pages to a direct archive URL.
  // Direct .apk files bypass generic video resolvers; the delivery worker
  // validates the ZIP signature and streams the file to a bounded temp file.
  if (platform === "apk") {
    if (/\.apk(?:$|[?#])/i.test(expanded)) {
      return { url: expanded, type: "document", title: "Android app", _via: "direct-apk" };
    }
    const resolved = await aioFallback(expanded, platform);
    if (resolved.result?.url) return { ...resolved.result, type: "document", title: resolved.result.title || "Android app" };
    const nexray = await nexrayFallback(expanded, platform).catch(() => null);
    if (nexray?.url) return { ...nexray, type: "document", title: nexray.title || "Android app" };
    throw new Error(`Could not resolve an APK download for ${new URL(expanded).hostname}; try a direct .apk URL or an app name with .apk`);
  }

  // ── TikTok ──
  if (platform === "tiktok") {
    const tik = await fromTikwm(expanded, platform).catch(() => null);
    if (tik?.url || (tik?.type === "slider" && tik?.images?.length)) return tik;
    try {
      const r = await prexzyGet("/download/tiktok", { url: expanded });
      const d = r?.data?.data || r?.data?.result || r?.data;
      const u = d?.hdplay || d?.play || d?.video || d?.url;
      if (u) return { url: u, type: "video", title: d?.title || "TikTok", thumb: d?.cover || d?.thumbnail, _via: "prexzy-tt" };
    } catch {}
    for (const ep of ["/download/tiktok", "/download/tiktokv2"]) {
      try {
        const r = await dcGet(ep, { url: expanded });
        const d = r?.data?.result || r?.data?.data || r?.data;
        const u = d?.video || d?.play || d?.url;
        if (u) return { url: u, type: "video", title: d?.title || "TikTok", _via: "dc-tt" };
      } catch {}
    }
    const cobalt = await fromCobalt(expanded, platform).catch(() => null);
    if (cobalt?.url) return cobalt;
    const aio = await aioFallback(expanded, platform);
    if (aio.result?.url) return aio.result;
    throw new Error(`All TikTok APIs failed`);
  }

  // ── YouTube ── cobalt FIRST (proxy server), then prexzy, then others
  // NOTE: fromVredenMp4 is NOT used here — it returns raw googlevideo.com CDN URLs
  // which are IP-restricted to the API server's IP and will 403 when our bot downloads
  // from a different IP. cobalt.tools proxies the stream through its own servers.
  if (platform === "youtube") {
    // Normalise Shorts/live/embed URLs → watch?v=ID so all APIs handle them correctly
    const _normYt = (u) => {
      const m = String(u).match(/(?:shorts|live|embed)\/([a-zA-Z0-9_-]{11})/);
      return m ? `https://www.youtube.com/watch?v=${m[1]}` : u;
    };
    const ytUrl = _normYt(expanded);
    const cobalt = await fromCobalt(ytUrl, platform).catch(() => null); // proxied — no IP restriction
    if (cobalt?.url) return cobalt;
    const px = await fromPrexzyYtMp4(ytUrl).catch(() => null);          // prexzy proxied CDN
    if (px?.url) return px;
    const yt1s = await fromYt1s(ytUrl).catch(() => null);               // yt1s proxied CDN
    if (yt1s?.url) return yt1s;
    const snap = await fromYoutubeSnap(ytUrl).catch(() => null);        // ssyoutube / savefrom
    if (snap?.url) return snap;
    const y2 = await fromY2mate(ytUrl).catch(() => null);               // y2mate CDN
    if (y2?.url) return y2;
    const ssAlt = await fromSsYtAlt(ytUrl).catch(() => null);
    if (ssAlt?.url) return ssAlt;
    const mateYt = await fromMateYt(ytUrl).catch(() => null);
    if (mateYt?.url) return mateYt;
    const loader = await fromYtLoader(ytUrl).catch(() => null);
    if (loader?.url) return loader;
    const ytdlp = await fromYtdlp(ytUrl).catch(() => null);
    if (ytdlp?.url) return ytdlp;
    const vr = await fromVredenMp4(ytUrl).catch(() => null);            // last resort: may 403
    if (vr?.url) return vr;
    const aio = await aioFallback(ytUrl, platform);
    if (aio.result?.url) return aio.result;
    throw new Error(`YouTube download failed — use .ytmp4 command for this video`);
  }

  // ── Spotify ── spotifymate first (no intent:// issues), then others
  if (platform === "spotify") {
    const _spOk = (r) => r?.url && String(r.url).startsWith("http") && !/intent:|market:|spotifydown/i.test(r.url) ? r : null;
    // spotifymate returns direct mp3 CDN links — most reliable, no intent:// redirects
    const sp3 = _spOk(await fromSpotifyMate(expanded).catch(() => null));
    if (sp3?.url) return sp3;
    const dc = _spOk(await fromDcSpotify(expanded).catch(() => null));
    if (dc?.url) return dc;
    const sp2 = _spOk(await fromSpotifySave(expanded).catch(() => null));
    if (sp2?.url) return sp2;
    // fromSpotifyDown last — known to return intent:// redirects on some tracks
    const sp1 = _spOk(await fromSpotifyDown(expanded).catch(() => null));
    if (sp1?.url) return sp1;
    const ytFb = await fromSpotifyViaYt(expanded).catch(() => null);  // yt search + prexzy mp3
    if (ytFb?.url) return ytFb;
    const cobalt = await fromCobalt(expanded, platform).catch(() => null);
    if (cobalt?.url) return cobalt;
    const aio = await aioFallback(expanded, platform);
    if (aio.result?.url) return aio.result;
    throw new Error(`All Spotify APIs failed — try .spotify command directly`);
  }

  // ── Instagram ── (prexzyvilla first — same as .ig command, then davidcyril, then existing chain)
  if (platform === "instagram") {
    const pxIg = await fromPrexzyIg(expanded).catch(() => null);
    if (pxIg?.url) return pxIg;
    const dcIg = await fromDcIg(expanded).catch(() => null);
    if (dcIg?.url) return dcIg;
    const tik = await fromTikwm(expanded, platform).catch(() => null);
    if (tik?.url) return tik;
    const insta = await fromInstaSave(expanded).catch(() => null);
    if (insta?.url) return insta;
    const ssig = await fromSsig(expanded).catch(() => null);
    if (ssig?.url) return ssig;
    const cobalt = await fromCobalt(expanded, platform).catch(() => null);
    if (cobalt?.url) return cobalt;
    const aio = await aioFallback(expanded, platform);
    if (aio.result?.url) return aio.result;
    throw new Error(`All Instagram APIs failed`);
  }

  // ── Facebook ── (davidcyril + prexzyvilla first — same as .fb command)
  if (platform === "facebook") {
    // Expand share/reel/watch URLs — MUST use desktop UA to avoid mobile login-redirect
    const _DESK_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
    let fbUrl = expanded;
    if (/fb\.watch|facebook\.com\/share\//i.test(fbUrl)) {
      try {
        const r = await axios.get(fbUrl, {
          maxRedirects: 6, timeout: 15000,
          headers: { "User-Agent": _DESK_UA, "Accept": "text/html,*/*", "Accept-Language": "en-US,en;q=0.9" },
          validateStatus: () => true,
        });
        const resolved = r.request?.res?.responseUrl || r.request?.responseURL || fbUrl;
        if (String(resolved).includes("facebook.com") && String(resolved).startsWith("http")) fbUrl = resolved;
      } catch (_) {}
    }
    // Try ALL resolvers with BOTH the expanded URL AND the original, pick first hit
    const _fbUrls = Array.from(new Set([fbUrl, expanded].filter(Boolean)));
    // cobalt first — proxies FB video through its own servers (most reliable)
    for (const _fbu of _fbUrls) {
      const cob = await fromCobalt(_fbu, "facebook").catch(() => null);
      if (cob?.url) return cob;
    }
    for (const _fbu of _fbUrls) {
      const dcFb = await fromDcFb(_fbu).catch(() => null);
      if (dcFb?.url) return dcFb;
    }
    for (const _fbu of _fbUrls) {
      const pxFb = await fromPrexzyFb(_fbu).catch(() => null);
      if (pxFb?.url) return pxFb;
    }
    for (const _fbu of _fbUrls) {
      const tik = await fromTikwm(_fbu, platform).catch(() => null);
      if (tik?.url) return tik;
    }
    for (const _fbu of _fbUrls) {
      const snp = await fromSnapfb(_fbu).catch(() => null);
      if (snp?.url) return snp;
    }
    for (const _fbu of _fbUrls) {
      const fbd = await fromFbDownloader(_fbu).catch(() => null);
      if (fbd?.url) return fbd;
    }
    for (const _fbu of _fbUrls) {
      const sfb = await fromSaveFb(_fbu).catch(() => null);
      if (sfb?.url) return sfb;
    }
    const cobalt = await fromCobalt(fbUrl, platform).catch(() => null);
    if (cobalt?.url) return cobalt;
    for (const _fbu of _fbUrls) {
      const aio = await aioFallback(_fbu, platform);
      if (aio.result?.url) return aio.result;
    }
    throw new Error(`All Facebook APIs failed — share URL may require login`);
  }

  // ── X / Twitter ── (prince API first — same as .twitter command)
  if (platform === "twitter") {
    const pr = await fromPrinceTw(expanded).catch(() => null);
    if (pr?.url) return pr;
    const fx = await fromFxTwitter(expanded).catch(() => null);
    if (fx?.url) return fx;
    const vx = await fromVxTwitter(expanded).catch(() => null);
    if (vx?.url) return vx;
    const tik = await fromTikwm(expanded, platform).catch(() => null);
    if (tik?.url) return tik;
    const ts = await fromTwitsave(expanded).catch(() => null);
    if (ts?.url) return ts;
    const cobalt = await fromCobalt(expanded, platform).catch(() => null);
    if (cobalt?.url) return cobalt;
    const aio = await aioFallback(expanded, platform);
    if (aio.result?.url) return aio.result;
    throw new Error(`All X/Twitter APIs failed`);
  }

  // ── Reddit ──
  if (platform === "reddit") {
    const rd = await fromReddit(expanded).catch(() => null);
    if (rd?.url) return rd;
    const cobalt = await fromCobalt(expanded, platform).catch(() => null);
    if (cobalt?.url) return cobalt;
    const aio = await aioFallback(expanded, platform);
    if (aio.result?.url) return aio.result;
    throw new Error(`All Reddit APIs failed`);
  }

  // ── Pinterest ──
  if (platform === "pinterest") {
    const tik = await fromTikwm(expanded, platform).catch(() => null);
    if (tik?.url && tik.type === "video") return tik;
    const aioFirst = await aioFallback(expanded, platform);
    if (aioFirst.result?.url && aioFirst.result.type === "video") return aioFirst.result;
    const page = await fromPinterestPage(expanded).catch(() => null);
    if (page?.url && page.type === "video") return page;
    if (aioFirst.result?.url) return aioFirst.result;
    if (page?.url) return page;
    throw new Error(`All Pinterest APIs failed`);
  }

  // ── GitHub/GitLab repository archive (download only; never execute code) ──
  if (platform === "gitclone") {
    const match = expanded.match(/^https?:\/\/(?:www\.)?github\.com\/([^/?#]+)\/([^/?#]+)(?:\/tree\/([^/?#]+))?/i);
    if (match) {
      const owner = encodeURIComponent(match[1]);
      const repo = encodeURIComponent(match[2].replace(/\.git$/i, ""));
      let branch = match[3] ? decodeURIComponent(match[3]) : null;
      if (!branch) {
        const meta = await httpGet(`https://api.github.com/repos/${owner}/${repo}`, { timeout: 12000, headers: { Accept: "application/vnd.github+json" } }).catch(() => null);
        branch = meta?.data?.default_branch || null;
      }
      if (branch) return { url: `https://github.com/${owner}/${repo}/archive/refs/heads/${encodeURIComponent(branch)}.zip`, type: "document", title: `${match[2]} repository`, _via: "github-archive" };
    }
    const aio = await aioFallback(expanded, platform);
    if (aio.result?.url) return aio.result;
    throw new Error("Could not resolve this repository archive; use a public GitHub/GitLab repository URL");
  }

  // ── MediaFire ──
  if (platform === "mediafire") {
    const mf = await fromMediaFire(expanded).catch(() => null);
    if (mf?.url) return mf;
    const aio = await aioFallback(expanded, platform);
    if (aio.result?.url) return aio.result;
    const nx = await nexrayFallback(expanded, platform).catch(() => null);
    if (nx?.url) return nx;
    throw new Error("MediaFire could not provide a direct file. Check that the link is public and points to a single file, not a folder or an expired page.");
  }

  // ── Adult platforms ──
  if (platform === "adult") {
    // Try platform-specific handlers first
    if (/pornhub\.com/i.test(expanded)) {
      const ph = await fromPornhub(expanded).catch(() => null);
      if (ph?.url) return ph;
    }
    if (/xhamster/i.test(expanded)) {
      const xh = await fromXhamster(expanded).catch(() => null);
      if (xh?.url) return xh;
    }
    if (/eporner\.com|eporrner\.com/i.test(expanded)) {
      const ep = await fromEporner(expanded).catch(() => null);
      if (ep?.url) return ep;
    }
    // Generic fallback for all other adult sites
    const cobalt = await fromCobalt(expanded, platform).catch(() => null);
    if (cobalt?.url) return cobalt;
    const aio = await aioFallback(expanded, platform);
    if (aio.result?.url) return aio.result;
    const _nxAdult = await nexrayFallback(expanded, platform).catch(() => null);
    if (_nxAdult?.url) return _nxAdult;
    throw new Error(`All adult platform APIs failed — site may block bots`);
  }

  // ── All other platforms (SoundCloud, Threads, LinkedIn, Snapchat, CapCut, GDrive, Telegram, etc.) ──
  const cobalt = await fromCobalt(expanded, platform).catch(() => null);
  if (cobalt?.url) return cobalt;
  const aio = await aioFallback(expanded, platform);
  if (aio.result?.url) return aio.result;
  const _nxGen = await nexrayFallback(expanded, platform).catch(() => null);
  if (_nxGen?.url) return _nxGen;
  throw new Error(`All ${platform} APIs failed (${aio.errors?.slice(0, 8).join(" | ") || "no media"})`);
}

// ─── Nexray fallback — every downloader endpoint (api.nexray.eu.cc/category/downloader) ───
// Old APIs stay first in the chain; Nexray is the final safety net for AIO +
// auto-downloader so every source in the download API list is covered.
async function nexrayFallback(url, platform) {
  const NEX = "https://api.nexray.eu.cc";
  const pickMedia = (d) => {
    const r = d?.result || d?.data || d;
    if (typeof r === "string" && /^https?:\/\//i.test(r)) return { url: r, type: null };
    const selectedVideo = providerMedia.pickNexrayVideo(d, { maxBytes: MAX_FILE_SIZE_BYTES });
    if (selectedVideo) return { ...selectedVideo, _via: "nexray-aio" };
    if (Array.isArray(r) && r[0]?.url) return { url: r[0].url, title: r[0]?.title, type: null };
    const u = r?.download || r?.download_url || r?.dl || r?.video || r?.hdplay || r?.play || r?.audio || r?.media || r?.mp4 || r?.mp3;
    // `result.url` from NexRay can be the input page itself, not a media URL.
    if (u && /^https?:\/\//i.test(String(u))) return { url: String(u), title: r?.title || r?.desc, type: r?.type || (r?.audio && !r?.video ? "audio" : null) };
    return null;
  };
  const perPlatform = {
    tiktok:    ["/downloader/tiktok", "/downloader/v2/tiktok", "/downloader/v1/tiktok"],
    instagram: ["/downloader/instagram", "/downloader/reels"],
    facebook:  ["/downloader/facebook"],
    youtube:   ["/downloader/ytvideo", "/downloader/v2/youtube", "/downloader/v1/youtube"],
    twitter:   ["/downloader/twitter", "/downloader/v1/twitter"],
    pinterest: ["/downloader/pinterest"],
    soundcloud:["/downloader/soundcloud"],
    spotify:   ["/downloader/spotify"],
    threads:   ["/downloader/threads"],
    capcut:    ["/downloader/capcut"],
    reddit:    ["/downloader/reddit"],
    mediafire: ["/downloader/mediafire"],
    gdrive:    ["/downloader/gdrive", "/downloader/googledrive"],
    likee:     ["/downloader/likee"],
    douyin:    ["/downloader/douyin"],
    terabox:   ["/downloader/terabox"],
    apk:       ["/downloader/apk", "/downloader/apkpure", "/downloader/playstore"],
    snackvideo:["/downloader/snackvideo"],
  };
  const paths = [...(perPlatform[platform] || []), "/downloader/aio", "/downloader/video"];
  for (const p of paths) {
    try {
      const { data } = await axios.get(`${NEX}${p}?url=${encodeURIComponent(url)}`, { timeout: 25000, headers: { "User-Agent": UA } });
      const got = pickMedia(data);
      if (got?.url || got?.type === "slider" || (Array.isArray(got?.images) && got.images.length > 0)) return got;
    } catch {}
  }
  return null;
}

// ─── Public API ────────────────────────────────────────────────────────────

export async function resolveMediaUrl(url, platform) {
  const p = platform || detectPlatform(url);
  if (!p) throw new Error("Unsupported platform: unknown");
  return resolvePlatformMedia(url, p);
}

// One stuck download (a provider that never answers, a hung upload) must not block every
// later link in the queue. After this long the job is reported as failed and the queue moves on.
export const AUTODL_JOB_TIMEOUT_MS = 6 * 60 * 1000;
export function runWithJobTimeout(promise, ms = AUTODL_JOB_TIMEOUT_MS, onTimeout = null) {
  let timer = null;
  const timeout = new Promise(resolve => {
    timer = setTimeout(async () => {
      console.error(`[AutoDownload] job timed out after ${Math.round(ms / 1000)}s; continuing with the queue`);
      try { await onTimeout?.(); } catch {}
      resolve(false);
    }, ms);
  });
  return Promise.race([
    Promise.resolve().then(() => promise),
    timeout,
  ]).finally(() => clearTimeout(timer));
}

// Durable FIFO, isolated by bot identity. Only one download runs at a time.
// Pending/running jobs survive process restarts (at-least-once delivery).
export class AutoDownloadQueue {
  constructor(file, worker) {
    this.file = file; this.worker = worker; this.running = false;
    this.jobs = []; this.waiters = new Map();
    if (fs.existsSync(file)) {
      const stored = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!Array.isArray(stored)) throw new Error("Invalid autodownload queue database");
      this.jobs = stored.filter(j => j && j.id && j.msg?.key?.remoteJid && j.body);
    }
  }
  persist() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.jobs), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
  enqueue(job) {
    const existing = this.jobs.find(j => j.id === job.id);
    if (existing) return this.waiters.get(job.id)?.promise || Promise.resolve(true);
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    this.waiters.set(job.id, { promise, resolve });
    this.jobs.push(job);
    try { this.persist(); }
    catch (err) { this.jobs.pop(); this.waiters.delete(job.id); throw err; }
    void this.drain();
    return promise;
  }
  async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.jobs.length) {
        const job = this.jobs[0];
        let result = false;
        try { result = await this.worker(job); }
        catch (err) { console.error("[AutoDownloadQueue]", err?.message || err); }
        this.jobs.shift();
        // A persistence failure must not strand in-memory waiters or silently
        // start further work against a stale database.
        let persistenceError;
        try { this.persist(); } catch (err) { persistenceError = err; }
        this.waiters.get(job.id)?.resolve(result);
        this.waiters.delete(job.id);
        if (persistenceError) { console.error("[AutoDownloadQueue] persistence failed:", persistenceError.message); break; }
      }
    } finally { this.running = false; }
  }
}
const autoDownloadQueues = new Map();
function getAutoDownloadQueue(sock) {
  const owner = String(sock?.user?.id || "").replace(/:\d+(?=@)/, "").replace(/[^a-zA-Z0-9]/g, "_");
  if (!owner) throw new Error("Autodownload requires an authenticated bot identity");
  let entry = autoDownloadQueues.get(owner);
  if (!entry) {
    entry = { sock };
    const base = process.env.AUTO_DL_QUEUE_DIR || path.join(process.cwd(), "database", "autodownload");
    entry.queue = new AutoDownloadQueue(path.join(base, owner + ".json"), job => runWithJobTimeout(
      processAutoDownload(entry.sock, job.msg, job.body, "global", false),
      AUTODL_JOB_TIMEOUT_MS,
      async () => {
        const sock = entry.sock;
        await reactFail(sock, job.msg).catch(() => {});
        await sock.sendMessage(job.msg.key.remoteJid, { text: "❌ Auto-download timed out. Send the link again to retry." }, { quoted: job.msg }).catch(() => {});
      },
    ));
    autoDownloadQueues.set(owner, entry);
  }
  entry.sock = sock;
  return entry.queue;
}
export function resumeAutoDownloads(sock) {
  try { void getAutoDownloadQueue(sock).drain(); }
  catch (err) { console.error("[AutoDownloadQueue] recovery failed:", err?.message || err); }
}
export async function handleAutoDownload(sock, msg, body, mode, isOwner) {
  if (msg?.key?.remoteJid === "status@broadcast") return false;
  // If fromMe: only drop if it is not the owner dropping links to download
  if (msg?.key?.fromMe && !isOwner) return false;
  if (!mode || mode === "off") return false;
  const chat = String(msg?.key?.remoteJid || "");
  if (!chat || (mode === "dm" && chat.endsWith("@g.us"))) return false;
  if (mode === "here") {
    const getter = globalThis.__MIAS_GET_SETTINGS__ || globalThis.__miasGetSettings;
    const owner = String(sock?.user?.id || "").replace(/:\d+(?=@)/, "");
    if (getter?.(owner)?.autoDownloadChat !== chat) return false;
  }
  if (/^[.!#\/$,+\-]\s*[a-z0-9]/i.test(String(body || "").trim())) return false;
  const url = extractUrl(body || "");
  if (!url || !detectPlatform(url)) return false;
  const id = chat + "|" + (msg.key.id || (Date.now() + "_" + Math.random()));
  try {
    // Snapshot only the fields needed to quote/reply; never serialize socket or media buffers.
    const minimal = { key: { ...msg.key }, message: { conversation: String(body) } };
    const queue = getAutoDownloadQueue(sock);
    const urls = [...new Set((String(body).match(/https?:\/\/[^\s"'<>]+/gi) || [])
      .map(value => extractUrl(value)).filter(Boolean))];
    if (!urls.length) urls.push(url);
    // Acknowledge straight away: the link was detected and queued, even if earlier jobs are still running.
    await reactCustom(sock, msg, "🌀").catch(() => {});
    console.log(`[AutoDownload] queued ${urls.length} link(s) from ${chat} (${detectPlatform(url) || "unknown"}, mode ${mode})`);
    for (let i = 0; i < urls.length; i++) {
      void queue.enqueue({ id: id + "|" + i, msg: minimal, body: urls[i], createdAt: Date.now() });
    }
  } catch (err) {
    try { await reactFail(sock, msg); await sock.sendMessage(chat, { text: "❌ Cannot queue download: " + err.message }, { quoted: msg }); } catch {}
  }
  return true;
}

async function processAutoDownload(sock, msg, body, mode, isOwner) {
  // Per-chat opt-in (settings UI option 30): enabling auto-DL for THIS chat
  // forces download here even when the global mode is off/dm — other chats
  // stay untouched.
  try {
    const _cid = msg?.key?.remoteJid || "";
    const _chatS = (typeof globalThis.__miasGetSettings === "function") ? globalThis.__miasGetSettings(_cid) : null;
    if (_chatS && _chatS.autoDlChat === true && (!mode || mode === "off" || mode === "dm")) mode = "global";
  } catch {}
  if (!mode || mode === "off") return false;
  const isGroup = String(msg?.key?.remoteJid || "").endsWith("@g.us");
  if (mode === "dm" && isGroup) return false;

  const url = extractUrl(body || "");
  if (!url) return false;
  const platform = detectPlatform(url);
  if (!platform) return false;

  // Plain TikTok links are auto-downloaded when mode is active;
  // commands like .tt or .tiktok are bypassed below by command prefix check.

  // A message that already invokes a bot command must not be auto-downloaded
  // as well — the command itself decides what to send.
  if (/^[.!#\/$,+\-]\s*[a-z0-9]/i.test(String(body || "").trim())) return false;

  await reactCustom(sock, msg, "🌀");

  const jid = msg.key.remoteJid;
  let tmpPath = null;
  try {
    let result = await resolveMediaUrl(url, platform);
    if (!result?.url && !(result?.type === "slider" && result?.images?.length)) {
      throw new Error("No download URL resolved");
    }

    let bytes;
    let caption;
    let fileName;
    let dlType = result.type || preferredType(platform);
    let dlMime = "video/mp4";
    let downloaded = null;

    if (result.type === "slider" && Array.isArray(result.images) && result.images.length > 0) {
      const pv = getPortableVideo();
      if (!pv?.createSliderVideo) throw new Error("Slider video generator unavailable");
      bytes = await pv.createSliderVideo({
        images: result.images,
        audioUrl: result.music,
        durationPerSlide: 3,
      });
      if (!Buffer.isBuffer(bytes) || !bytes.length) throw new Error("TikTok slider video generation returned no file");
      const sliderPath = path.join(getPipelineWorkDir(), `mais_dl_${Date.now()}_${Math.random().toString(36).slice(2)}.mp4`);
      fs.writeFileSync(sliderPath, bytes);
      tmpPath = sliderPath;
      downloaded = { tmpPath, type: "video", ext: "mp4", mimetype: "video/mp4", size: bytes.length, fileName: `tiktok_slider_${Date.now()}.mp4` };
      caption = `*${result.title || "TikTok Slider"}*\n🖼️ ${result.images.length} slides (3s each with music)`;
      fileName = downloaded.fileName;
      dlType = "video";
      dlMime = "video/mp4";
    } else if (platform === "apk") {
      const fs = await import("fs");
      const path = await import("path");
      const tempPath = path.join(getPipelineWorkDir(), `mais_dl_${Date.now()}_${Math.random().toString(36).slice(2)}.apk`);
      try {
        const { downloadApkToFile } = createRequire(import.meta.url)("../../lib/reliableDl.js");
        const size = await downloadApkToFile(result.url, tempPath, { maxBytes: Math.min(MAX_FILE_SIZE_BYTES, 95 * 1024 * 1024), timeoutMs: DOWNLOAD_TIMEOUT });
        tmpPath = tempPath;
        downloaded = { tmpPath, type: "document", ext: "apk", mimetype: "application/vnd.android.package-archive", size, fileName: `${(result.title || "android_app").replace(/[^a-z0-9_-]/gi, "_").slice(0, 60) || "android_app"}.apk` };
      } catch (error) {
        cleanupTemp(tempPath);
        throw error;
      }
    } else {
      try {
        if (platform === "mediafire") {
          const resolver = createRequire(import.meta.url)("./mediafireResolver.cjs");
          const mediafireFile = await resolver.downloadMediaFireFileToTemp(result.url, {
            tempDir: getPipelineWorkDir(), maxBytes: MAX_FILE_SIZE_BYTES, timeoutMs: DOWNLOAD_TIMEOUT,
          });
          tmpPath = mediafireFile.path;
          const ext = (String(mediafireFile.fileName || "").match(/\.([a-z0-9]{1,8})$/i) || [])[1]?.toLowerCase() || "bin";
          downloaded = {
            tmpPath, type: "document", ext,
            mimetype: mediafireFile.contentType || "application/octet-stream", size: mediafireFile.size,
            fileName: mediafireFile.fileName,
          };
        } else {
          downloaded = await downloadToTemp(result.url, dlType);
          tmpPath = downloaded.tmpPath;
        }
      } catch (firstDownloadError) {
        if (platform !== "youtube" && platform !== "tiktok") throw firstDownloadError;
        const alternate = await nexrayFallback(url, platform).catch(() => null);
        if (!alternate?.url || alternate.url === result.url) throw firstDownloadError;
        result = alternate;
        dlType = result.type || "video";
        downloaded = await downloadToTemp(result.url, dlType);
      }
      tmpPath = downloaded.tmpPath;
      const sizeText = downloaded.size >= 1024 * 1024
        ? `${(downloaded.size / 1024 / 1024).toFixed(1)} MB`
        : `${(downloaded.size / 1024).toFixed(1)} KB`;
      caption = `*${result.title || `Auto-downloaded from ${platform}`}*\n📦 ${sizeText}`;
      fileName = downloaded.fileName || `${platform}_${Date.now()}.${downloaded.ext}`;
      dlType = downloaded.type;
      dlMime = downloaded.mimetype;
    }

    if (dlType === "video") {
      let mediaSource = tmpPath;
      let hdCleanup = null;
      if (platform === "tiktok") {
        try {
          const req = createRequire(import.meta.url);
          const TTD = req("./ttDelivery.cjs");
          if (TTD && typeof TTD.reencodeHdForWhatsApp === "function") {
            const hdRes = await TTD.reencodeHdForWhatsApp(tmpPath, {
              maxBytes: 95 * 1024 * 1024,
              boost: 1.2,
              sourceQualityBoost: 1.2,
            });
            if (hdRes && hdRes.path && hdRes.bytes > 0) {
              mediaSource = hdRes.path;
              hdCleanup = hdRes.cleanup;
            }
          }
        } catch (hdErr) {}
      }
      try {
      if (downloaded.size > 90 * 1024 * 1024) {
        await sendDocument(sock, jid, mediaSource, {
          caption,
          mimetype: dlMime || "video/mp4",
          fileName,
          quoted: msg,
        });
      } else {
        const sent = await sendVideo(sock, jid, mediaSource, {
          caption,
          mimetype: dlMime,
          fileName,
          quoted: msg,
        });
        if (!sent) {
          await sendDocument(sock, jid, mediaSource, {
            caption,
            mimetype: dlMime,
            fileName,
            quoted: msg,
          });
        }
      }
      } finally {
        if (typeof hdCleanup === "function") await hdCleanup().catch(() => {});
      }
    } else if (dlType === "audio") {
      await sendAudio(sock, jid, tmpPath, {
        mimetype: downloaded.mimetype || "audio/mpeg",
        quoted: msg,
      });
    } else if (dlType === "image") {
      await sendImage(sock, jid, tmpPath, {
        caption,
        mimetype: downloaded.mimetype,
        quoted: msg,
      });
    } else {
      await sendDocument(sock, jid, tmpPath, {
        caption,
        mimetype: downloaded.mimetype || "application/octet-stream",
        fileName,
        quoted: msg,
      });
    }

    await reactSuccess(sock, msg);
    return true;
  } catch (e) {
    console.error(`[AutoDownloader] ${platform} failed:`, e.message);
    try {
      await reactFail(sock, msg);
      await sock.sendMessage(jid, { text: `❌ Auto-download failed for ${platform}.\n_${e.message}_` }, { quoted: msg });
    } catch {}
    return true;
  } finally {
    cleanupTemp(tmpPath);
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   ADULT PATH (Prexzy /nsfw/xvideos-dl + /nsfw/xnxx-dl — VERIFIED live)
   Wraps the module-scope resolver so adult links never fall through to the
   generic provider that returned "an error page instead of media".
   ══════════════════════════════════════════════════════════════════════════ */
try {
  const __req = createRequire(import.meta.url);
  let __nsfwPath = null;
  try { __nsfwPath = __req.resolve('./nsfwPrexzy.cjs'); } catch (_) { __nsfwPath = null; }
  if (!__nsfwPath) throw Object.assign(new Error('nsfw pack not installed (skipped)'), { __skip: true });
  const __nsfw = __req(__nsfwPath);
  if (typeof resolvePlatformMedia === 'function' && !globalThis.__NSFW_AUTODL_PATCHED__) {
    globalThis.__NSFW_AUTODL_PATCHED__ = true;
    const __origResolve = resolvePlatformMedia;
    resolvePlatformMedia = async function (url, platform) {
      if (platform === 'adult' || /xvideos\.|xnxx\./i.test(String(url))) {
        const eps = /xnxx\./i.test(String(url))
          ? ['/nsfw/xnxx-dl', '/nsfw/xvideos-dl', '/download/aio']
          : ['/nsfw/xvideos-dl', '/nsfw/xnxx-dl', '/download/aio'];
        for (const ep of eps) {
          try {
            const r = await __nsfw.prexzyJson(ep, { url }, 45000);
            if (!r.ok) continue;
            const u = __nsfw.pickUrl(r.data);
            if (u) return { url: u, type: 'video', title: r.data?.title || 'Adult', _via: 'prexzy' + ep };
          } catch {}
        }
        console.log('[nsfw-adult] all Prexzy adult providers missed, falling back to generic resolver');
      }
      return __origResolve.apply(this, arguments);
    };
    console.log('[nsfw-adult] ✅ autoDownloader adult path -> Prexzy /nsfw/xvideos-dl + /nsfw/xnxx-dl');
  }
} catch (e) {
  if (e && e.__skip) { console.log('[nsfw-adult] adult pack not installed - skipped (expected).'); }
  else { console.log('[nsfw-adult] autoDownloader patch failed:', (e && e.message) || e); }
}
/* __NSFW_ADULT_PACK__ */
