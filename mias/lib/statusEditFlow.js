import { prepareTikTokVideo } from "../features/ttVideo.js";
import axios from "axios";
import { createRequire } from "module";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import os from "os";
import path from "path";

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const MAX_DURATION_SECONDS = 180;
const MAX_RESULTS = 5;
const SESSION_TTL_MS = 10 * 60 * 1000;
const MAX_VIDEO_BYTES = 90 * 1024 * 1024;

// TikTok is the only approved source for status/anime edits. Pinterest was
// removed because its pin pages rarely resolve to a real video and it was the
// main reason unrelated clips were delivered.
const PLATFORMS = [
  { id: "tiktok", label: "TikTok", domains: ["tiktok.com", "vm.tiktok.com", "vt.tiktok.com"] },
];

const PLATFORM_ALIASES = new Map([
  ["1", "tiktok"], ["tiktok", "tiktok"], ["tt", "tiktok"],
]);

const DEFAULT_PLATFORM = "tiktok";

const sessions = new Map();
const APPROVED_PLATFORMS = new Set(PLATFORMS.map((platform) => platform.id));
let tikwmQueue = Promise.resolve();
const QUALITY_QUERY_TERMS = [
  "viral trending popular high quality HD 4k anime edit",
  "best rated popular anime edit",
];
const LOW_QUALITY_PATTERN = /\b(?:low[\s-]?quality|low[\s-]?effort|no[\s-]?likes?|1[\s-]?like|flop(?:ped)?|bad[\s-]?edit|ugly[\s-]?edit)\b/i;

function cleanText(value) {
  return String(value || "")
    .replace(/[*_~`]/g, "")
    .replace(/[\u200b-\u200d\uFEFF]/g, "")
    .trim();
}

function unwrapQuotedMessage(message) {
  let current = message;
  for (let i = 0; i < 6; i += 1) {
    const inner = current?.viewOnceMessage?.message
      || current?.viewOnceMessageV2?.message
      || current?.ephemeralMessage?.message
      || current?.documentWithCaptionMessage?.message;
    if (!inner || inner === current) break;
    current = inner;
  }
  return current || {};
}

export function statusMessageText(msg) {
  const message = msg?.message || {};
  return cleanText(
    message.conversation
      || message.extendedTextMessage?.text
      || message.imageMessage?.caption
      || message.videoMessage?.caption
      || message.documentMessage?.caption
      || message.buttonsResponseMessage?.selectedButtonId
      || message.listResponseMessage?.singleSelectReply?.selectedRowId
      || message.interactiveResponseMessage?.buttonReply?.id
      || message.interactiveResponseMessage?.buttonReply?.displayText
      || "",
  );
}

function contextInfo(msg) {
  const message = msg?.message || {};
  return message.extendedTextMessage?.contextInfo
    || message.imageMessage?.contextInfo
    || message.videoMessage?.contextInfo
    || message.documentMessage?.contextInfo
    || message.buttonsResponseMessage?.contextInfo
    || message.listResponseMessage?.contextInfo
    || message.interactiveResponseMessage?.contextInfo
    || null;
}

function sessionKey(msg) {
  const jid = String(msg?.key?.remoteJid || "");
  const sender = String(
    msg?.key?.participant
      || msg?.key?.senderPn
      || msg?.key?.participantPn
      || (jid.endsWith("@s.whatsapp.net") ? jid : ""),
  );
  return `${jid}|${sender}`;
}

function quoteId(msg) {
  return contextInfo(msg)?.stanzaId || "";
}

function isQuotedPrompt(msg, session) {
  const id = quoteId(msg);
  return !!contextInfo(msg)?.quotedMessage && !!id && session.promptIds.has(id);
}

function parsePlatform(value) {
  const normalized = cleanText(value).toLowerCase()
    .replace(/^(option|choice|platform|number|no\.?)\s*[:.)-]?\s*/i, "")
    .trim();
  const platform = PLATFORM_ALIASES.get(normalized) || null;
  return platform && APPROVED_PLATFORMS.has(platform) ? platform : null;
}

export function parseStatusPlatform(value) {
  return parsePlatform(value);
}

export function parseStatusQuantity(value) {
  const normalized = cleanText(value).toLowerCase();
  const match = normalized.match(/(?:^|\b)(10|[1-9])(?:\s*(?:edit|edits|video|videos))?\b/);
  if (!match) return 0;
  return Math.min(MAX_RESULTS, Number(match[1]));
}

function platformInfo(id) {
  return PLATFORMS.find((platform) => platform.id === id) || PLATFORMS.at(-1);
}

function trimHtmlUrl(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#x2F;/gi, "/")
    .replace(/\\u0026/g, "&")
    .trim();
}

function decodeSearchHtml(value) {
  return String(value || "")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&amp;/g, "&")
    .replace(/&#x2F;/gi, "/")
    .replace(/\\u0026/g, "&")
    .replace(/\\"/g, "\"");
}

function validHttpUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (!/^https?:$/.test(url.protocol)) return "";
    return url.toString();
  } catch {
    return "";
  }
}

function hostMatches(url, domains = []) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

function isConcreteSourceUrl(url, platform) {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname.toLowerCase();
    if (platform === "tiktok") {
      // Tag/search landing pages cannot be downloaded as an individual edit.
      return /\/@[^/]+\/video\/\d+/.test(pathname)
        || /\/video\/\d+/.test(pathname);
    }
    return false;
  } catch {
    return false;
  }
}

function deepUrl(value, preferred = false, depth = 0) {
  if (depth > 5 || value == null) return "";
  if (typeof value === "string") {
    const url = validHttpUrl(value);
    if (!url) return "";
    if (preferred || /\.(mp4|m3u8|webm)(?:[?#]|$)/i.test(url)) return url;
    return "";
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = deepUrl(item, preferred, depth + 1);
      if (found) return found;
    }
    return "";
  }
  if (typeof value !== "object") return "";
  const preferredKeys = [
    "download_url", "downloadUrl", "download", "hdplay", "hd", "no_watermark",
    "nowm", "video", "video_url", "videoUrl", "play", "play_url", "url", "link",
    "mp4", "file", "media",
  ];
  for (const key of preferredKeys) {
    const found = deepUrl(value[key], true, depth + 1);
    if (found) return found;
  }
  for (const child of Object.values(value)) {
    const found = deepUrl(child, false, depth + 1);
    if (found) return found;
  }
  return "";
}

function candidate(sourceUrl, extra = {}) {
  const source = validHttpUrl(sourceUrl);
  if (!source) return null;
  const platform = String(extra.platform || "").toLowerCase();
  if (!APPROVED_PLATFORMS.has(platform) || !hostMatches(source, platformInfo(platform).domains)) {
    return null;
  }
  if (!isConcreteSourceUrl(source, platform)) return null;
  const title = cleanText(extra.title || "Status edit").slice(0, 120);
  if (LOW_QUALITY_PATTERN.test(title) || hasLowEngagement(extra)) return null;
  return {
    sourceUrl: source,
    downloadUrl: validHttpUrl(extra.downloadUrl || ""),
    title,
    platform,
    qualityScore: qualityScore({ ...extra, title }),
  };
}

function uniqueCandidates(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = item?.sourceUrl || item?.downloadUrl;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function numericMetric(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = String(value || "").replace(/,/g, "").trim().toLowerCase();
  const match = text.match(/^([\d.]+)\s*([km])?/);
  if (!match) return 0;
  const multiplier = match[2] === "m" ? 1_000_000 : match[2] === "k" ? 1_000 : 1;
  return Number(match[1]) * multiplier;
}

function qualityScore(item = {}) {
  const title = String(item.title || "").toLowerCase();
  const views = numericMetric(item.views ?? item.viewCount ?? item.playCount);
  const likes = numericMetric(item.likes ?? item.likeCount);
  const rating = numericMetric(item.rating ?? item.score);
  let score = 50;
  if (/\b(?:viral|trending|popular|best|4k|hd|amv)\b/.test(title)) score += 15;
  if (views >= 100_000) score += 20;
  if (likes >= 10_000) score += 15;
  if (rating >= 4) score += 10;
  if (LOW_QUALITY_PATTERN.test(title)) score -= 60;
  return score;
}

function hasLowEngagement(item = {}) {
  const views = numericMetric(item.views ?? item.viewCount ?? item.playCount);
  const likes = numericMetric(item.likes ?? item.likeCount);
  const rating = numericMetric(item.rating ?? item.score);
  return (views > 0 && views < 1_000)
    || (likes > 0 && likes < 10)
    || (rating > 0 && rating < 3);
}

// ── Relevance ────────────────────────────────────────────────────────────
// The old flow accepted every TikTok link found on a search results page, so
// a "naruto" request happily returned random unrelated videos. Every
// candidate now has to actually mention the requested topic.
const STOP_WORDS = new Set(["the", "a", "an", "edit", "edits", "anime", "video", "videos", "status", "of", "and"]);

function queryTokens(query) {
  return String(query || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
}

function matchesQuery(query, ...texts) {
  const tokens = queryTokens(query);
  if (!tokens.length) return true;
  const haystack = texts.map((text) => String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, " ")).join(" ");
  const compact = haystack.replace(/\s+/g, "");
  return tokens.some((token) => haystack.includes(token) || compact.includes(token));
}

async function tikwmRequest(url, params) {
  const request = tikwmQueue.then(async () => {
    const response = await axios.get(url, {
      params,
      timeout: 30000,
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
    });
    return response.data;
  });
  tikwmQueue = request.catch(() => {});
  return request;
}

// Keyword search straight from TikTok's index: real titles, real view counts
// and a direct playable URL, mixing fresh new 4k/viral edits with classic high-quality edits.
async function tikwmSearch(query) {
  const cleanQ = String(query || "").trim();
  const freshQueries = [`${cleanQ} 4k edit`, `${cleanQ} viral edit 2026`, `${cleanQ} trending edit`];
  const classicQueries = [`${cleanQ} best edit`, `${cleanQ} edit`, cleanQ];

  const searchEndpoints = [
    "https://www.tikwm.com/api/feed/search/",
    "https://tikwm.com/api/feed/search/"
  ];

  // Random quality/trending flavour for the edit fetch: sometimes the plain
  // topic, sometimes topic + trending / 4k / 60fps / 120fps / 360fps. Results
  // are still gated by matchesQuery(topic), so a Naruto search can NEVER
  // return JJK unless the hashtags actually relate.
  const _qualityTags = ["trending", "4k", "60fps", "120fps", "360fps"];
  const qualityify = (q) => {
    const base = String(q || "").trim();
    if (!base) return base;
    if (Math.random() < 0.45) return base;
    return `${base} ${_qualityTags[Math.floor(Math.random() * _qualityTags.length)]}`;
  };
  const fetchForQueries = async (queryList, targetCount = 10) => {
    const list = [];
    for (const keywords of queryList) {
      for (const ep of searchEndpoints) {
        try {
          const data = await tikwmRequest(ep, {
            keywords: qualityify(keywords),
            count: 20,
            cursor: 0,
            HD: 1,
          });
          const rows = data?.data?.videos || data?.data || [];
          for (const row of Array.isArray(rows) ? rows : []) {
            const author = row?.author?.unique_id || row?.author?.uniqueId || "";
            const videoId = row?.video_id || row?.aweme_id || row?.id;
            if (!author || !videoId) continue;
            const title = String(row?.title || row?.desc || "").trim();
            if (!matchesQuery(cleanQ, title, author)) continue;
            const item = candidate(`https://www.tiktok.com/@${author}/video/${videoId}`, {
              platform: "tiktok",
              title: title || `${cleanQ} edit`,
              views: row?.play_count,
              likes: row?.digg_count,
              downloadUrl: row?.hdplay || row?.play || "",
            });
            if (item) list.push(item);
          }
          if (list.length >= targetCount) break;
        } catch {}
      }
      if (list.length >= targetCount) break;
    }
    return list;
  };

  const [freshRaw, classicRaw] = await Promise.all([
    fetchForQueries(freshQueries, 8),
    fetchForQueries(classicQueries, 8)
  ]);

  const fresh = uniqueCandidates(freshRaw).sort((a, b) => b.qualityScore - a.qualityScore);
  const classic = uniqueCandidates(classicRaw).sort((a, b) => b.qualityScore - a.qualityScore);

  // Blend fresh and classic edits so users get a mix of both
  const blended = [];
  const maxLen = Math.max(fresh.length, classic.length);
  for (let i = 0; i < maxLen; i++) {
    if (i < fresh.length) blended.push(fresh[i]);
    if (i < classic.length) blended.push(classic[i]);
  }

  const result = uniqueCandidates(blended.length ? blended : [...fresh, ...classic]);
  return result;
}

// Confirms a scraped link really is about the requested topic before it is
// downloaded.
async function isRelevantTikTok(item, query) {
  try {
    const data = await tikwmRequest("https://www.tikwm.com/api//", { url: item.sourceUrl, hd: 1 });
    if (Number(data?.code) !== 0) return false;
    const info = data?.data || {};
    return matchesQuery(query, info.title, info.author?.unique_id, info.author?.nickname);
  } catch {
    return false;
  }
}

async function bingSearch(query, platform) {
  const info = platformInfo(platform);
  const domainQuery = ` site:${info.domains[0]}`;
  const queries = [
    ...QUALITY_QUERY_TERMS.map((quality) =>
      `https://www.bing.com/videos/search?q=${encodeURIComponent(`${query} ${quality}${domainQuery}`)}`),
    ...QUALITY_QUERY_TERMS.map((quality) =>
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(`${query} ${quality}${domainQuery}`)}`),
  ];
  const found = [];
  for (const url of queries) try {
    const { data } = await axios.get(url, {
      timeout: 18000,
      headers: { "User-Agent": "Mozilla/5.0", Accept: "text/html,application/xhtml+xml" },
    });
    const html = decodeSearchHtml(data);
    const pageFound = [];
    const pattern = /href=["'](https?:\/\/[^"'<> ]+)/gi;
    let match;
    while ((match = pattern.exec(html)) && pageFound.length < 15) {
      const link = trimHtmlUrl(match[1]);
      if (hostMatches(link, info.domains)) {
        pageFound.push(candidate(link, {
          platform,
          title: `${query} viral high quality edit`,
          qualityScore: 65,
        }));
      }
    }
    // Bing's video results are commonly embedded in HTML as escaped
    // `pgurl`/`murl` JSON instead of normal anchors. Parse those URLs too or
    // the search appears empty even though Bing returned real TikTok/Pinterest
    // videos.
    const embeddedPattern = /"(?:pgurl|murl)"\s*:\s*"(https?:\/\/[^"]+)"/gi;
    while ((match = embeddedPattern.exec(html)) && pageFound.length < 30) {
      const link = trimHtmlUrl(match[1]);
      if (hostMatches(link, info.domains)) {
        pageFound.push(candidate(link, {
          platform,
          title: `${query} viral high quality edit`,
          qualityScore: 65,
        }));
      }
    }
    for (const encoded of html.matchAll(/uddg=([^&"]+)/gi)) {
      try {
        const link = trimHtmlUrl(decodeURIComponent(encoded[1]));
        if (hostMatches(link, info.domains)) {
          pageFound.push(candidate(link, {
            platform,
            title: `${query} viral high quality edit`,
            qualityScore: 65,
          }));
        }
      } catch {}
    }
    const results = uniqueCandidates(pageFound);
    if (results.length) return results.sort((a, b) => b.qualityScore - a.qualityScore);
  } catch {}
  return [];
}

async function searchCandidates(query, platform = DEFAULT_PLATFORM) {
  const target = APPROVED_PLATFORMS.has(platform) ? platform : DEFAULT_PLATFORM;
  const primary = await tikwmSearch(query).catch(() => []);
  const all = [...primary];

  if (uniqueCandidates(all).length < 5) {
    try {
      const { data: pxData } = await axios.get("https://prexzyapis.com/search/tiktoksearch", {
        params: { q: query },
        timeout: 20000,
        headers: { "User-Agent": "Mozilla/5.0" },
      });
      const pxRows = pxData?.data || pxData?.result || [];
      for (const r of Array.isArray(pxRows) ? pxRows : []) {
        const u = r?.url || r?.play || r?.video;
        if (u && !all.some((it) => it.sourceUrl === u)) {
          all.push(candidate(u, {
            platform: "tiktok",
            title: r?.title || `${query} viral edit`,
            downloadUrl: r?.play || r?.video || u,
            qualityScore: 70,
          }));
        }
      }
    } catch {}
  }
  if (uniqueCandidates(all).length < 5) {
    try {
      const { data: nxData } = await axios.get("https://api.nexray.eu.cc/search/tiktok", {
        params: { q: query },
        timeout: 20000,
        headers: { "User-Agent": "Mozilla/5.0" },
      });
      const nxRows = nxData?.result || nxData?.data || [];
      for (const r of Array.isArray(nxRows) ? nxRows : []) {
        const u = r?.url || r?.play || r?.video || (r?.id ? `https://www.tiktok.com/@user/video/${r.id}` : null);
        if (u && !all.some((it) => it.sourceUrl === u)) {
          all.push(candidate(u, {
            platform: "tiktok",
            title: r?.title || `${query} viral edit`,
            downloadUrl: r?.play || r?.video || u,
            qualityScore: 70,
          }));
        }
      }
    } catch {}
  }

  // Search-engine scraping is only a fallback now, and every scraped link is
  // checked against the topic before it can be delivered.
  if (uniqueCandidates(all).length < 5) {
    const scraped = await bingSearch(query, target).catch(() => []);
    for (const item of scraped.slice(0, 12)) {
      if (uniqueCandidates(all).length >= 10) break;
      if (await isRelevantTikTok(item, query)) all.push(item);
    }
  }

  return uniqueCandidates(all)
    .filter((item) => item.qualityScore >= 50)
    .sort((a, b) => b.qualityScore - a.qualityScore)
    .slice(0, 15);
}

async function prexzyDownload(sourceUrl, platform) {
  const endpointByPlatform = { tiktok: "/download/tiktok" };
  const endpoint = endpointByPlatform[platform];
  if (!endpoint) return "";
  const hosts = [
    process.env.PREXZY_API || "https://prexzyapis.com",
    "https://apis.prexzyvilla.site",
  ];
  for (const host of hosts) {
    try {
      const response = await axios.get(`${host}${endpoint}`, {
        params: { url: sourceUrl },
        timeout: 35000,
        headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
      });
      const u = deepUrl(response.data);
      if (u) return u;
    } catch {}
  }
  try {
    const { data } = await axios.get("https://api.nexray.eu.cc/downloader/tiktok", {
      params: { url: sourceUrl },
      timeout: 35000,
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
    });
    const u = deepUrl(data);
    if (u) return u;
  } catch {}
  return "";
}

async function tikwmDownload(sourceUrl) {
  // TikWM currently exposes a lightweight JSON resolver for TikTok pages.
  // Serialize calls because its free endpoint enforces roughly one request
  // per second; concurrent anime workers would otherwise trip its limiter.
  const request = tikwmQueue.then(async () => {
    const response = await axios.get("https://www.tikwm.com/api/", {
      params: { url: sourceUrl, hd: 1 },
      timeout: 30000,
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
    });
    if (Number(response.data?.code) !== 0) return "";
    return deepUrl(response.data?.data);
  });
  tikwmQueue = request.catch(() => {});
  return request;
}

async function cobaltDownload(sourceUrl) {
  const endpoints = [
    "https://api.cobalt.tools/api/json",
    "https://co.wuk.sh/api/json",
    "https://cobalt-api.kwiatekmiki.com/",
  ];
  for (const endpoint of endpoints) {
    try {
      const { data } = await axios.post(endpoint, {
        url: sourceUrl,
        downloadMode: "video",
        videoQuality: "720",
        filenameStyle: "basic",
      }, {
        timeout: 35000,
        headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "Mozilla/5.0" },
      });
      const url = deepUrl(data);
      if (url) return url;
    } catch {}
  }
  return "";
}

async function downloadBuffer(url) {
  const response = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: 120000,
    maxContentLength: MAX_VIDEO_BYTES,
    maxBodyLength: MAX_VIDEO_BYTES,
    headers: { "User-Agent": "Mozilla/5.0", Accept: "video/*,application/octet-stream,*/*" },
  });
  const buffer = Buffer.from(response.data || []);
  if (buffer.length < 10000 || buffer.length > MAX_VIDEO_BYTES) return null;
  const contentType = String(response.headers?.["content-type"] || "").toLowerCase();
  const looksLikeVideo = /^video\//.test(contentType)
    || buffer.slice(4, 8).toString("ascii") === "ftyp"
    || buffer.slice(0, 4).toString("ascii") === "RIFF"
    || (buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3);
  if (/text\/html|application\/json/.test(contentType) || !looksLikeVideo) return null;
  return buffer;
}

export function getMp4DurationSeconds(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 16) return 0;
  const findMvhd = (start, end) => {
    let offset = start;
    while (offset + 8 <= end) {
      let size = buffer.readUInt32BE(offset);
      const type = buffer.toString("ascii", offset + 4, offset + 8);
      let header = 8;
      if (size === 1 && offset + 16 <= end) {
        size = Number(buffer.readBigUInt64BE(offset + 8));
        header = 16;
      } else if (size === 0) {
        size = end - offset;
      }
      if (size < header || offset + size > end) break;
      if (type === "mvhd" && offset + header + 20 <= end) {
        const version = buffer.readUInt8(offset + header);
        const base = offset + header + (version === 1 ? 20 : 12);
        if (base + (version === 1 ? 16 : 8) <= end) {
          const timescale = buffer.readUInt32BE(base);
          const duration = version === 1
            ? Number(buffer.readBigUInt64BE(base + 4))
            : buffer.readUInt32BE(base + 4);
          return timescale ? duration / timescale : 0;
        }
      }
      if (["moov", "trak", "mdia"].includes(type)) {
        const nested = findMvhd(offset + header, offset + size);
        if (nested) return nested;
      }
      offset += size;
    }
    return 0;
  };
  return findMvhd(0, buffer.length);
}

async function trimVideo(buffer) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mias-status-"));
  const input = path.join(dir, "input.bin");
  const output = path.join(dir, "output.mp4");
  try {
    let ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
    try {
      const bundled = require("ffmpeg-static");
      if (bundled && fs.existsSync(bundled)) ffmpeg = bundled;
    } catch {}
    await fs.promises.writeFile(input, buffer);
    await execFileAsync(ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-y", "-i", input,
      "-t", String(MAX_DURATION_SECONDS), "-map", "0:v:0", "-map", "0:a:0?",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", output,
    ], { timeout: 120000, maxBuffer: 1024 * 1024 });
    const trimmed = await fs.promises.readFile(output);
    return trimmed.length > 10000 ? trimmed : null;
  } catch {
    return null;
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function enforceDuration(buffer, { normalize = true } = {}) {
  const seconds = getMp4DurationSeconds(buffer);
  if (!normalize) {
    return seconds > MAX_DURATION_SECONDS + 0.5 ? null : buffer;
  }
  // Always transcode to a normal MP4 before sending. Some approved feeds
  // return WebM/Matroska/odd MP4 variants; sending those as video/mp4 makes
  // playback work for the bot owner but fail for other WhatsApp clients.
  const normalized = await trimVideo(buffer);
  if (normalized) return normalized;
  if (seconds > MAX_DURATION_SECONDS + 0.5) return null;
  return buffer.slice(4, 8).toString("ascii") === "ftyp" ? buffer : null;
}

async function resolveCandidate(item, { normalize = true } = {}) {
  if (!item || !APPROVED_PLATFORMS.has(item.platform)
      || !hostMatches(item.sourceUrl, platformInfo(item.platform).domains)) {
    return null;
  }
  const directUrls = [];
  if (item.downloadUrl) directUrls.push(item.downloadUrl);
  try {
    const platformUrl = await tikwmDownload(item.sourceUrl);
    if (platformUrl) directUrls.push(platformUrl);
  } catch {}

  // Try the source-specific URL before contacting generic fallbacks. The old
  // order always waited for Cobalt and Prexzy even after TikWM/Pinterest had
  // already returned a usable video, making a working edit look stuck for
  // 60–90 seconds and often timing out before WhatsApp received anything.
  for (const url of [...new Set(directUrls)]) {
    try {
      const buffer = await downloadBuffer(url);
      if (!buffer) continue;
      const limited = await enforceDuration(buffer, { normalize });
      if (limited) return { ...item, buffer: limited, duration: getMp4DurationSeconds(limited) };
    } catch {}
  }

  const fallbackUrls = [];
  const cobalt = await cobaltDownload(item.sourceUrl);
  if (cobalt) fallbackUrls.push(cobalt);
  const fallback = await prexzyDownload(item.sourceUrl, item.platform);
  if (fallback) fallbackUrls.push(fallback);
  for (const url of [...new Set(fallbackUrls)]) {
    try {
      const buffer = await downloadBuffer(url);
      if (!buffer) continue;
      const limited = await enforceDuration(buffer, { normalize });
      if (limited) return { ...item, buffer: limited, duration: getMp4DurationSeconds(limited) };
    } catch {}
  }
  return null;
}

function formatPlatformMenu(prefix) {
  return [
    "🎬 *Choose the platform for the edits*",
    "",
    "1. TikTok",
    "",
    "Reply to this message with *1*.",
    `_Videos longer than 3:00 are trimmed or skipped._`,
    "_Only popular, high-quality edits from the selected platform are accepted._",
  ].join("\n");
}

function formatQuantityPrompt() {
  return [
    "🔢 *How many edits should I send?*",
    "",
    "Reply to this message with a number from *1 to 5*.",
    "_Each video is limited to 3:00 maximum._",
  ].join("\n");
}

export function buildStatusVideoMessage(buffer) {
  return {
    video: buffer,
    mimetype: "video/mp4",
  };
}

export function createStatusEditFlow({ prefix = ".", animeFlow = null } = {}) {
  const getPrefix = () => typeof prefix === "function" ? String(prefix() || "") : String(prefix || "");
  const expire = () => {
    const now = Date.now();
    for (const [key, value] of sessions) {
      if (now - value.updatedAt > SESSION_TTL_MS) sessions.delete(key);
    }
  };

  async function prompt(sock, jid, text, quoted, session) {
    const sent = await sock.sendMessage(jid, { text }, { quoted });
    session.promptIds = new Set([sent?.key?.id].filter(Boolean));
    session.updatedAt = Date.now();
    return sent;
  }

  async function start(sock, msg) {
    expire();
    const key = sessionKey(msg);
    const session = {
      key,
      stage: "topic",
      promptIds: new Set(),
      updatedAt: Date.now(),
      topic: "",
      platform: "",
      quantity: 0,
    };
    sessions.set(key, session);
    await prompt(sock, msg.key.remoteJid, [
      "🎬 *Status Edit Maker*",
      "",
      "What status edit do you want?",
      "Quote this message and reply with the topic, for example: *Naruto*.",
    ].join("\n"), msg, session);
    return true;
  }

  async function handleReply(sock, msg, body) {
    expire();
    const key = sessionKey(msg);
    const session = sessions.get(key);
    if (!session || !isQuotedPrompt(msg, session)) return false;
    const value = cleanText(body);
    if (!value || (getPrefix() && value.startsWith(getPrefix()))) return false;
    session.updatedAt = Date.now();

    if (session.stage === "topic") {
      session.topic = value.slice(0, 120);

      // Anime titles use the same direct edit pipeline as the dedicated
      // anime commands. This keeps `status` useful in no-prefix mode: replying
      // "Naruto" to the first prompt immediately sends normal anime edits
      // instead of forcing the user through a second platform picker.
      const animeEntry = animeFlow?.resolve?.(session.topic);
      if (animeEntry && typeof animeFlow.sendThree === "function") {
        session.stage = "working";
        sessions.delete(key);
        await animeFlow.sendThree(sock, msg, animeEntry);
        return true;
      }

      // TikTok is the only source now, so the platform question is skipped.
      session.platform = DEFAULT_PLATFORM;
      session.stage = "quantity";
      await prompt(sock, msg.key.remoteJid, formatQuantityPrompt(), msg, session);
      return true;
    }
    if (session.stage === "platform") {
      const platform = parsePlatform(value);
      if (!platform) {
        await prompt(sock, msg.key.remoteJid,
          "❌ Reply with *1* for TikTok.", msg, session);
        return true;
      }
      session.platform = platform;
      session.stage = "quantity";
      await prompt(sock, msg.key.remoteJid, formatQuantityPrompt(), msg, session);
      return true;
    }
    if (session.stage === "quantity") {
      const quantity = parseStatusQuantity(value);
      if (!quantity) {
        await prompt(sock, msg.key.remoteJid, "❌ Reply with a number from *1 to 5*.", msg, session);
        return true;
      }
      session.quantity = quantity;
      session.stage = "working";
      await sock.sendMessage(msg.key.remoteJid, {
        text: `🔎 Searching *${session.topic}* edits on *${platformInfo(session.platform).label}*...\nPreparing ${quantity} video${quantity === 1 ? "" : "s"}.`,
      }, { quoted: msg });

      try {
        const candidates = await searchCandidates(session.topic, session.platform);
        const results = [];
        for (const item of candidates) {
          if (results.length >= quantity) break;
          const resolved = await resolveCandidate(item);
          if (resolved) results.push(resolved);
        }
        if (!results.length) {
          await sock.sendMessage(msg.key.remoteJid, {
            text: "❌ I could not find a matching TikTok edit right now. Try another topic or spelling.",
          }, { quoted: msg });
          sessions.delete(key);
          return true;
        }
        for (let index = 0; index < results.length; index += 1) {
          const result = results[index];
          // Process status edits EXACTLY like the tt 1.3 HD path (same
          // normalize/remux pipeline) so they arrive playable, fast, in 4:5 HD.
          let _editBuf = result.buffer;
          try { _editBuf = await prepareTikTokVideo(result.buffer); } catch (_) {}
          await sock.sendMessage(
            msg.key.remoteJid,
            buildStatusVideoMessage(_editBuf),
            { quoted: msg },
          );
        }
        sessions.delete(key);
      } catch (error) {
        sessions.delete(key);
        await sock.sendMessage(msg.key.remoteJid, {
          text: `❌ The edit search failed safely: ${String(error?.message || "provider unavailable").slice(0, 180)}`,
        }, { quoted: msg });
      }
      return true;
    }
    return true;
  }

  return {
    start,
    handleReply,
    hasPending: (msg) => sessions.has(sessionKey(msg)),
    statusMessageText,
    formatPlatformMenu,
    formatQuantityPrompt,
  };
}

export {
  MAX_DURATION_SECONDS,
  MAX_RESULTS,
  PLATFORMS,
  searchCandidates as searchStatusCandidates,
  resolveCandidate as resolveStatusCandidate,
  sessions as __statusEditSessions,
};