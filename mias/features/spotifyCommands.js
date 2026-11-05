200
// Spotify command: music card (cover, title, artist, duration) and a quoted 1/2/3 picker.
// Built the same way as the .play card, but with its own pending store and reply
// listener, so .play / .play2 code is not touched.
//   1 = music file (MP3)   2 = voice note   3 = video file (or "video not available")
import axios from "axios";
import { nxGet } from "../api.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const { resolveFfmpeg } = require("../lib/portableVideo.cjs");

const SPOT_TTL = 20 * 60 * 1000;          // card stays pickable for 20 minutes
const SPOT_FIND_BUDGET_MS = 75 * 1000;    // max time spent finding a working provider
const SPOT_PENDING = new Map();           // card message id -> pick entry
const SPOT_BOUND = new WeakSet();         // sockets that already have the reply listener
const UA = { "User-Agent": "Mozilla/5.0" };
const SPOTIFY_TRACK_RE = /https?:\/\/open\.spotify\.com\/(?:intl-[a-z]+\/)?track\/[A-Za-z0-9]+/i;
// Audio links must not be images, Spotify/YouTube pages, or CDN artwork.
const NOT_AUDIO_RE = /scdn\.co|ytimg|spotify\.com|youtube\.com|youtu\.be|\.(jpe?g|png|webp|gif)(\?|$)/i;

const chatKey = (j) => String(j || "").replace(/:\d+(?=@)/, "").toLowerCase();
const fmtDur = (sec) => (!sec ? "N/A" : `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`);
const normTitle = (s) => String(s || "").toLowerCase().replace(/\(.*?\)|\[.*?\]/g, " ").replace(/[^a-z0-9]+/g, " ").trim();

// Duration: values above 10000 are milliseconds (Spotify ms), smaller are seconds.
function parseDurationSec(v) {
  if (v == null || v === "") return 0;
  const s = String(v).trim();
  if (/^\d+(\.\d+)?$/.test(s)) { const n = Math.round(Number(s)); return n > 10000 ? Math.round(n / 1000) : n; }
  const parts = s.split(":").map(Number);
  if (parts.length >= 2 && parts.every(Number.isFinite)) return parts.reduce((a, b) => a * 60 + b, 0);
  return 0;
}

// Flatten a provider response into [key, value] pairs. Keys are lower-cased and
// arrays keep the key of their parent, so artists: ["A", "B"] yields ["artists","A"].
function walkPairs(o, key = "", depth = 0, out = []) {
  if (o == null || depth > 6) return out;
  if (typeof o === "string" || typeof o === "number") { out.push([key.toLowerCase(), String(o)]); return out; }
  if (Array.isArray(o)) { for (const x of o.slice(0, 30)) walkPairs(x, key, depth + 1, out); return out; }
  if (typeof o === "object") for (const [k, v] of Object.entries(o)) walkPairs(v, k, depth + 1, out);
  return out;
}
function pickOne(pairs, keys, test = () => true) {
  for (const k of keys) {
    const hit = pairs.find(([pk, pv]) => pk === k && pv.trim() && test(pv.trim()));
    if (hit) return hit[1].trim();
  }
  return "";
}
function pickAll(pairs, keys) {
  for (const k of keys) {
    const vals = [...new Set(pairs.filter(([pk, pv]) => pk === k && pv.trim() && !/^\d+$/.test(pv.trim())).map(([, pv]) => pv.trim()))];
    if (vals.length) return vals;
  }
  return [];
}

// Turn any provider JSON into { audioUrl, meta } or null when it has no audio link.
export function parseSpotifyPayload(data) {
  if (!data || typeof data !== "object") return null;
  if (data.status === false || data.success === false) return null;
  const pairs = walkPairs(data);
  const isAudioUrl = (v) => /^https?:\/\//i.test(v) && !NOT_AUDIO_RE.test(v);
  const audioUrl = pickOne(pairs, ["downloadlink", "download_url", "downloadurl", "download", "music", "audio", "audiourl", "mp3", "dlurl", "link", "url"], isAudioUrl);
  if (!audioUrl) return null;
  const title = pickOne(pairs, ["title", "name", "track", "songtitle", "trackname"], (v) => v.length < 300 && !/^https?:/i.test(v));
  const artist = pickAll(pairs, ["artist", "artists", "artistname", "channel", "author", "uploader", "singer"]).join(", ");
  const durRaw = pickOne(pairs, ["duration", "duration_ms", "durationms", "durationsec", "length"]);
  const cover = pickOne(pairs, ["cover", "thumbnail", "thumb", "image", "album_art", "albumart", "cover_url", "coverurl", "picture", "img", "artwork"], (v) => /^https?:\/\//i.test(v));
  // Video only from the Spotify provider payload (Canvas / video fields). No YouTube.
  const videoUrl = pickOne(pairs, ["video", "videourl", "video_url", "canvas", "canvasurl", "canvas_url", "mp4", "videolink"], (v) => /^https?:\/\//i.test(v) && !NOT_AUDIO_RE.test(v));
  return {
    audioUrl,
    videoUrl: videoUrl || "",
    meta: { title: title || "Spotify Track", artist: artist || "Unknown artist", durationSec: parseDurationSec(durRaw), cover: cover || "" },
  };
}

// Audio sniffing: only real audio bytes pass, so an HTML error page is never sent.
export function audioFormat(buf) {
  if (!buf || buf.length < 5000) return null;
  const head = buf.subarray(0, 12);
  if (head.toString("latin1", 0, 3) === "ID3") return "mp3";
  if (head[0] === 0xff && (head[1] & 0xe0) === 0xe0) return "mp3";
  if (head.toString("latin1", 0, 4) === "OggS") return "ogg";
  if (head.toString("latin1", 4, 8) === "ftyp") return "m4a";
  if (head.toString("latin1", 0, 4) === "RIFF") return "wav";
  if (head.toString("latin1", 0, 4) === "fLaC") return "flac";
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return "webm";
  return null;
}
const EXT = { mp3: ".mp3", ogg: ".ogg", m4a: ".m4a", wav: ".wav", flac: ".flac", webm: ".webm" };

// ---- WhatsApp-playable Spotify video ----
// WhatsApp shows "something is wrong with the video file" for an MP4 that is not H.264 with
// yuv420p pixels, or whose moov atom sits at the end. The TikTok path is not changed; this is
// separate. A file that already fits is stream-copied with +faststart (fast). Anything else is
// encoded once to H.264/AAC. The output is checked before it is returned.
function probeMedia(text) {
  const out = { video: null, audio: null };
  for (const line of String(text).split("\n")) {
    if (!out.video && /Stream #\d+:\d+.*: Video:/.test(line)) {
      const dim = /(\d{2,5})x(\d{2,5})/.exec(line);
      out.video = {
        codec: ((/Video: ([a-z0-9_]+)/i.exec(line) || [])[1] || "").toLowerCase(),
        pix: ((/\b(yuv[a-z0-9]+)\b/i.exec(line) || [])[1] || "").toLowerCase(),
        w: dim ? Number(dim[1]) : 0, h: dim ? Number(dim[2]) : 0,
      };
    }
    if (!out.audio && /Stream #\d+:\d+.*: Audio:/.test(line)) {
      out.audio = { codec: ((/Audio: ([a-z0-9_]+)/i.exec(line) || [])[1] || "").toLowerCase() };
    }
  }
  return out;
}

// ffmpeg -i prints stream details to stderr and exits non-zero (no output file); that is expected.
async function ffmpegInfo(file) {
  try { await execFileAsync(resolveFfmpeg(), ["-hide_banner", "-i", file], { timeout: 20000, maxBuffer: 4 * 1024 * 1024 }); return ""; }
  catch (e) { return String(e?.stderr || ""); }
}

export async function makeWhatsAppVideo(input) {
  if (!Buffer.isBuffer(input) || input.length < 10000 || input.toString("latin1", 4, 8) !== "ftyp") return null;
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "mias-spot-vid-"));
  const inP = path.join(dir, "in.mp4"), outP = path.join(dir, "out.mp4");
  try {
    await fsp.writeFile(inP, input);
    const src = probeMedia(await ffmpegInfo(inP));
    if (!src.video) return null;
    const fits = src.video.codec === "h264" && src.video.pix === "yuv420p" && src.video.w % 2 === 0 && src.video.h % 2 === 0;
    const hasAudio = !!src.audio;
    const args = fits
      ? ["-c:v", "copy", ...(hasAudio ? (src.audio.codec === "aac" ? ["-c:a", "copy"] : ["-c:a", "aac", "-b:a", "128k", "-ac", "2"]) : [])]
      : ["-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-c:v", "libx264", "-preset", "veryfast", "-crf", "26",
         "-profile:v", "high", "-pix_fmt", "yuv420p", ...(hasAudio ? ["-c:a", "aac", "-b:a", "128k", "-ac", "2"] : [])];
    await execFileAsync(resolveFfmpeg(), ["-hide_banner", "-loglevel", "error", "-y", "-i", inP,
      "-map", "0:v:0", "-map", "0:a:0?", ...args, "-movflags", "+faststart", "-f", "mp4", outP],
      { timeout: 150000, maxBuffer: 8 * 1024 * 1024 });
    const out = await fsp.readFile(outP);
    const chk = probeMedia(await ffmpegInfo(outP));
    const faststart = out.indexOf("moov") > 0 && out.indexOf("moov") < out.indexOf("mdat");
    if (out.length < 10000 || out.toString("latin1", 4, 8) !== "ftyp" || !chk.video || chk.video.codec !== "h264" || chk.video.pix !== "yuv420p" || !faststart) return null;
    return out;
  } catch {
    return null;
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export function installSpotifyCommands(ctx) {
  const { cmd, sendReply, react, CONFIG, dcGet, prexzyGet, __miasMapSet, __miasMapDelete, getSender, isPrivateBlocked, transcodeAudio, voiceBuffer } = ctx;
  const brand = () => `${CONFIG.BOT_NAME || "MIAS"} • SPOTIFY`;

  // Providers, tried in order. Prexzy and Nexray first, then the rest.
  // A provider that is down or returns no audio is skipped.
  const sources = [
    { name: "Prexzy", get: async (url) => { const r = await prexzyGet("/download/spotify", { url }, 40000); return r && r.ok ? r.data : null; } },
    { name: "Nexray", get: async (url) => { const r = await nxGet("/downloader/spotify", { url }, 40000); return r && r.ok ? r.data : null; } },
    { name: "DavidCyril", get: async (url) => { const r = await dcGet("/spotifydl", { url }, 30000); return r && r.ok ? r.data : null; } },
    { name: "DavidCyril 2", get: async (url) => { const r = await dcGet("/download/spotify", { url }, 30000); return r && r.ok ? r.data : null; } },
    { name: "Gifted", get: async (url) => { if (!CONFIG.GIFTED_KEY) return null; return (await axios.get(`${CONFIG.GIFTED_API}/api/download/spotify?apikey=${CONFIG.GIFTED_KEY}&url=${encodeURIComponent(url)}`, { timeout: 30000 })).data; } },
    { name: "Vreden", get: async (url) => (await axios.get(`https://api.vreden.my.id/api/v1/download/spotify?url=${encodeURIComponent(url)}`, { timeout: 30000, headers: UA })).data },
    { name: "Zenzxz", get: async (url) => (await axios.get(`https://api.zenzxz.my.id/downloader/spotify?url=${encodeURIComponent(url)}`, { timeout: 30000, headers: UA })).data },
    { name: "Agatz", get: async (url) => (await axios.get(`https://api.agatz.xyz/api/spotify?url=${encodeURIComponent(url)}`, { timeout: 30000, headers: UA })).data },
    { name: "Siputzx", get: async (url) => (await axios.get(`https://api.siputzx.my.id/api/d/spotify?url=${encodeURIComponent(url)}`, { timeout: 30000, headers: UA })).data },
    { name: "Ryzendesu", get: async (url) => (await axios.get(`https://api.ryzendesu.vip/api/downloader/spotify?url=${encodeURIComponent(url)}`, { timeout: 25000, headers: UA })).data },
  ];

  // Yields each provider that returns audio, in order, within the time budget.
  async function* iterateSources(url, skip = new Set()) {
    const started = Date.now();
    for (const src of sources) {
      if (Date.now() - started > SPOT_FIND_BUDGET_MS) return;
      if (skip.has(src.name)) continue;
      let data = null;
      try { data = await src.get(url); } catch { continue; }
      const parsed = parseSpotifyPayload(data);
      if (parsed) yield { source: src.name, ...parsed };
    }
  }

  // Fill duration and cover from the public Spotify embed page when a provider omits them.
  async function fillFromEmbed(url, meta) {
    const id = (url.match(/track\/([A-Za-z0-9]+)/) || [])[1];
    if (!id) return;
    try {
      const { data } = await axios.get(`https://open.spotify.com/embed/track/${id}`, { timeout: 15000, headers: { ...UA, Accept: "text/html" }, responseType: "text" });
      const html = String(data || "");
      if (!meta.durationSec) { const d = html.match(/"duration(?:_ms|Ms)?"\s*:\s*(\d{4,})/); if (d) meta.durationSec = parseDurationSec(d[1]); }
      if (!meta.cover) { const c = html.match(/property="og:image"\s+content="([^"]+)"/) || html.match(/(https:\/\/(?:i\.scdn\.co|image-cdn-[a-z0-9]+\.spotifycdn\.com)\/image\/[A-Za-z0-9]+)/); if (c) meta.cover = c[1]; }
    } catch {}
  }

  async function resolveCard(url) {
    for await (const c of iterateSources(url)) {
      if (!c.meta.durationSec || !c.meta.cover) await fillFromEmbed(url, c.meta);
      return { url, ...c };
    }
    return null;
  }

  // Name search: first Spotify track link any search provider returns.
  async function findTrackUrl(query) {
    const searchers = [
      async () => { const r = await nxGet("/search/spotify", { q: query }, 20000); return r && r.ok ? r.data : null; },
      async () => { const r = await dcGet("/search/spotify", { text: query }, 18000); return r && r.ok ? r.data : null; },
      async () => (await axios.get(`https://api.siputzx.my.id/api/s/spotify?query=${encodeURIComponent(query)}`, { timeout: 15000, headers: UA })).data,
      async () => { if (!CONFIG.GIFTED_KEY) return null; return (await axios.get(`${CONFIG.GIFTED_API}/api/search/spotify?apikey=${CONFIG.GIFTED_KEY}&q=${encodeURIComponent(query)}`, { timeout: 15000 })).data; },
    ];
    for (const s of searchers) {
      try { const d = await s(); const m = JSON.stringify(d || "").match(SPOTIFY_TRACK_RE); if (m) return m[0]; } catch {}
    }
    return null;
  }

  // Fallback, used only when the Spotify provider returns no video: the YouTube match for this track.
  async function findYouTubeUrl(meta) {
    const want = normTitle(meta.title);
    if (!want) return null;
    try {
      const r = await nxGet("/search/youtube", { q: `${meta.artist} ${meta.title}` }, 20000);
      const list = r && r.ok && Array.isArray(r.result) ? r.result : [];
      for (const v of list.slice(0, 5)) {
        if (normTitle(v.title).includes(want) && v.url) return v.url;
      }
    } catch {}
    return null;
  }

  // Best YouTube MP4 link at 720p or lower (provider lists can include 1080p, which is too large).
  function pickYouTubeVideoLink(data) {
    const found = [];
    (function walk(o) {
      if (!o || typeof o !== "object") return;
      if (Array.isArray(o)) { o.forEach(walk); return; }
      if (typeof o.download_url === "string" && /^https?:\/\//i.test(o.download_url) && !/youtube\.com|youtu\.be/i.test(o.download_url)) {
        found.push({ url: o.download_url, h: Number(o.height) || 0 });
      }
      for (const v of Object.values(o)) if (v && typeof v === "object") walk(v);
    })(data);
    const ok = found.filter((c) => c.h <= 720).sort((a, b) => b.h - a.h);
    return ok.length ? ok[0].url : "";
  }

  async function fetchYouTubeMp4Buf(ytUrl) {
    const tries = [
      async () => { const r = await prexzyGet("/download/ytmp4", { url: ytUrl, quality: "720" }, 45000); return r && r.ok ? r.data : null; },
      async () => { const r = await dcGet("/download/ytmp4", { url: ytUrl }, 40000); return r && r.ok ? r.data : null; },
      async () => { const r = await nxGet("/downloader/ytmp4", { url: ytUrl }, 60000); return r && r.ok ? r.data : null; },
    ];
    for (const t of tries) {
      try {
        const link = pickYouTubeVideoLink(await t());
        if (!link) continue;
        const buf = await fetchBuf(link, 300000);
        if (buf.length > 10000 && buf.length < 60 * 1024 * 1024 && buf.toString("latin1", 4, 8) === "ftyp") return buf;
      } catch {}
    }
    return null;
  }

  // The YouTube match for this card, looked up once and cached on the card entry.
  async function youTubeFor(entry) {
    if (entry.ytUrl === undefined) entry.ytUrl = (await findYouTubeUrl(entry.meta)) || null;
    return entry.ytUrl;
  }

  // First http(s) media link in a provider response, skipping YouTube pages and images.
  function pickMediaLink(data) {
    if (!data || typeof data !== "object") return "";
    return pickOne(walkPairs(data), ["download_url", "downloadurl", "downloadlink", "download", "url", "link"],
      (v) => /^https?:\/\//i.test(v) && !NOT_AUDIO_RE.test(v));
  }

  // YouTube audio (MP3) for the matched track. Used only when no Spotify provider gave audio.
  async function findYouTubeAudio(ytUrl) {
    const tries = [
      async () => { const r = await prexzyGet("/download/ytmp3", { url: ytUrl }, 45000); return r && r.ok ? r.data : null; },
      async () => { const r = await dcGet("/download/ytmp3", { url: ytUrl }, 40000); return r && r.ok ? r.data : null; },
      async () => { const r = await nxGet("/downloader/ytmp3", { url: ytUrl }, 60000); return r && r.ok ? r.data : null; },
    ];
    for (const t of tries) {
      try {
        const link = pickMediaLink(await t());
        if (!link) continue;
        const a = await downloadAudio(link);
        if (a) return a;
      } catch {}
    }
    return null;
  }

  // YouTube links are often video-only. The track audio goes on the picture: Spotify's first,
  // YouTube's only when Spotify gave none (see getAudioFor).
  async function muxAudio(videoBuf, audioBuf) {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "mias-spot-mux-"));
    const vIn = path.join(dir, "v.mp4"), aIn = path.join(dir, "a.bin"), out = path.join(dir, "out.mp4");
    try {
      await fsp.writeFile(vIn, videoBuf);
      await fsp.writeFile(aIn, audioBuf);
      await execFileAsync(resolveFfmpeg(), ["-hide_banner", "-loglevel", "error", "-y", "-i", vIn, "-i", aIn,
        "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "128k", "-shortest",
        "-movflags", "+faststart", "-f", "mp4", out], { timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
      const res = await fsp.readFile(out);
      return res.length > 10000 && res.toString("latin1", 4, 8) === "ftyp" ? res : null;
    } finally {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function fetchBuf(url, timeout = 120000) {
    const r = await axios.get(url, { responseType: "arraybuffer", timeout, maxContentLength: Infinity, maxBodyLength: Infinity, maxRedirects: 5, headers: UA });
    return Buffer.from(r.data || []);
  }
  async function downloadAudio(url) {
    const buf = await fetchBuf(url, 120000);
    const fmt = audioFormat(buf);
    return fmt ? { buf, fmt } : null;
  }
  // Video: the Spotify provider's own MP4 link only (no YouTube). The file must be a real
  // MP4, then goes through the same processing as the TikTok 1.3 HD video before delivery.
  async function fetchVideoBuf(url) {
    if (!url || !/^https?:\/\//i.test(url) || NOT_AUDIO_RE.test(url)) return null;
    const buf = await fetchBuf(url, 300000).catch(() => null);
    if (!buf || buf.length < 10000 || buf.toString("latin1", 4, 8) !== "ftyp") return null;
    return makeWhatsAppVideo(buf);
  }

  // Premium caption: Unicode-styled fixed labels only. Song title and artist are
  // inserted as plain text (bold markers only), so they are never re-styled.
  function buildCard(meta) {
    const title = String(meta.title || "Unknown title").slice(0, 80);
    const artist = String(meta.artist || "Unknown artist").slice(0, 80);
    return [
      "━━━━━ 𝙎𝙋𝙊𝙏𝙄𝙁𝙔 𝘿𝙊𝙒𝙉𝙇𝙊𝘼𝘿 ━━━━━",
      "",
      `*${title}*`,
      "",
      `𝗔𝗿𝘁𝗶𝘀𝘁: ${artist}`,
      `𝗗𝘂𝗿𝗮𝘁𝗶𝗼𝗻: ${fmtDur(meta.durationSec)}`,
      "",
      "━━━━━━━━━━━━━━━━━━━━",
      "",
      "𝑺𝑬𝑳𝑬𝑪𝑻 𝑭𝑶𝑹𝑴𝑨𝑻",
      "",
      "1. 𝗠𝘂𝘀𝗶𝗰 𝗙𝗶𝗹𝗲 — MP3 𝗔𝘂𝗱𝗶𝗼",
      "2. 𝗩𝗼𝗶𝗰𝗲 𝗡𝗼𝘁𝗲 — 𝗩𝗼𝗶𝗰𝗲 𝗠𝗲𝘀𝘀𝗮𝗴𝗲",
      "3. 𝗩𝗶𝗱𝗲𝗼 𝗙𝗶𝗹𝗲 — MP4",
      "",
      "Reply to this message with 1, 2, or 3 to choose your format.",
      "",
      "𝙋𝙊𝙒𝙀𝙍𝙀𝘿 𝘽𝙔 𝑷𝑹𝑬𝑪𝑰𝑶𝑼𝑺 x",
    ].join("\n");
  }

  // The Spotify card does NOT write the shared .play picker flag. Other picker
  // routers read that flag and would take over bare digits; this module's own
  // listener handles 1/2/3, so .play and every other picker stay untouched.
  function refreshChat() {}
  function sweep() {
    const now = Date.now();
    const jids = [];
    for (const [k, v] of SPOT_PENDING) if (now - v.ts > SPOT_TTL) { SPOT_PENDING.delete(k); jids.push(v.jid); }
    for (const j of jids) refreshChat(j);
  }

  async function getAudioFor(entry) {
    if (entry.audioUrl) { try { const a = await downloadAudio(entry.audioUrl); if (a) return a; } catch {} }
    for await (const c of iterateSources(entry.url, new Set([entry.source]))) {
      try { const a = await downloadAudio(c.audioUrl); if (a) return a; } catch {}
    }
    // Fallback only: no Spotify provider gave audio, so use the YouTube match's audio.
    const yt = await youTubeFor(entry);
    const ya = yt ? await findYouTubeAudio(yt) : null;
    if (ya) return ya;
    throw new Error("no provider could deliver this track right now");
  }

  async function deliver(sock, entry, n, m) {
    const jid = m.key.remoteJid;
    const title = entry.meta.title;
    const safe = `${entry.meta.artist} - ${title}`.replace(/[^\w\s.-]/g, "_").trim().slice(0, 70) || "track";
    if (n === 3) {
      // 1) The Spotify provider's own video. 2) If none, the YouTube video, with the Spotify audio
      // (YouTube audio only if no Spotify provider gave audio).
      let vbuf = entry.videoUrl ? await fetchVideoBuf(entry.videoUrl) : null;
      if (!vbuf) {
        const yt = await youTubeFor(entry);
        const [picture, audio] = yt
          ? await Promise.all([fetchYouTubeMp4Buf(yt), getAudioFor(entry).catch(() => null)])
          : [null, null];
        if (picture && audio) {
          const muxed = await muxAudio(picture, audio.buf).catch(() => null);
          vbuf = muxed ? await makeWhatsAppVideo(muxed) : null;
        }
      }
      if (!vbuf) { await sendReply(sock, m, `🎬 *Video not available* right now for *${title}*.`); return; }
      await sock.sendMessage(jid, { video: vbuf, mimetype: "video/mp4", caption: `🎵 ${title} — ${entry.meta.artist}` }, { quoted: m });
      return;
    }
    const a = await getAudioFor(entry);
    if (n === 2) {
      const ogg = a.fmt === "ogg" ? a.buf : await voiceBuffer(a.buf, (EXT[a.fmt] || ".mp3").replace(/^\./, ""));
      await sock.sendMessage(jid, { audio: ogg, mimetype: "audio/ogg; codecs=opus", ptt: true }, { quoted: m });
      return;
    }
    // n === 1: music file as MP3 (transcode when the provider sent another format)
    const mp3 = a.fmt === "mp3" ? a.buf : await transcodeAudio(a.buf, (EXT[a.fmt] || ".m4a").replace(/^\./, ""));
    try {
      await sock.sendMessage(jid, { audio: mp3, mimetype: "audio/mpeg", ptt: false, fileName: `${safe}.mp3` }, { quoted: m });
    } catch {
      await sock.sendMessage(jid, { document: mp3, mimetype: "audio/mpeg", fileName: `${safe}.mp3` }, { quoted: m });
    }
  }

  function bindListener(sock) {
    if (!sock || !sock.ev || typeof sock.ev.on !== "function" || SPOT_BOUND.has(sock)) return;
    SPOT_BOUND.add(sock);
    sock.ev.on("messages.upsert", async (up) => {
      try {
        for (const m of (up && up.messages) || []) {
          if (!m || !m.message || !m.key || m.key.remoteJid === "status@broadcast") continue;
          const text = String(m.message?.conversation || m.message?.extendedTextMessage?.text || "").trim();
          if (!/^[1-3]$/.test(text)) continue;
          sweep();
          const jid = m.key.remoteJid;
          // Match the quoted card first, otherwise the newest pending card in this chat.
          let id = null, entry = null;
          const quotedId = m.message?.extendedTextMessage?.contextInfo?.stanzaId || "";
          if (quotedId && SPOT_PENDING.has(quotedId) && chatKey(SPOT_PENDING.get(quotedId).jid) === chatKey(jid)) { id = quotedId; entry = SPOT_PENDING.get(quotedId); }
          if (!entry) {
            for (const [k, v] of SPOT_PENDING) if (chatKey(v.jid) === chatKey(jid) && (!entry || v.ts > entry.ts)) { id = k; entry = v; }
          }
          if (!entry) continue;
          const who = String(getSender(m) || "");
          if (entry.user && who && chatKey(entry.user) !== chatKey(who)) continue;
          if (isPrivateBlocked && isPrivateBlocked(m)) continue;
          SPOT_PENDING.delete(id);
          try { await sock.sendMessage(jid, { react: { text: "⏳", key: m.key } }); } catch {}
          try {
            await deliver(sock, entry, Number(text), m);
            // Option 3 (video) gets no ✅: the video or its "not available" reply is the result.
            if (Number(text) !== 3) { try { await sock.sendMessage(jid, { react: { text: "✅", key: m.key } }); } catch {} }
          } catch (e) {
            try { await sock.sendMessage(jid, { react: { text: "❌", key: m.key } }); } catch {}
            try { await sendReply(sock, m, `❌ Spotify download failed: ${e?.message || e}`); } catch {}
          }
        }
      } catch {}
    });
  }

  const quotedText = (msg) => {
    try {
      const q = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
      return String(q?.conversation || q?.extendedTextMessage?.text || "").trim();
    } catch { return ""; }
  };
  const usage = () => `🎧 *${brand()}*\n\nUsage: ${CONFIG.PREFIX}spotify <song name or Spotify link>\n\nThen quote the card with *1* (music), *2* (voice note) or *3* (video).`;

  async function spotifyCard(sock, msg, args) {
    const jid = msg.key.remoteJid;
    const query = (args || []).join(" ").trim() || quotedText(msg);
    if (!query) { await sendReply(sock, msg, usage()); return; }
    try { await react(sock, msg, "⏳"); } catch {}
    const status = await sock.sendMessage(jid, { text: `🎧 *${brand()}*\n\n🔍 Searching *${query.slice(0, 80)}* …` }, { quoted: msg }).catch(() => null);
    const clearStatus = async () => { if (status && status.key) { try { await sock.sendMessage(jid, { delete: status.key }); } catch {} } };
    try {
      const link = query.match(SPOTIFY_TRACK_RE);
      const trackUrl = link ? link[0] : await findTrackUrl(query);
      if (!trackUrl) throw new Error("I couldn't find that song on Spotify. Try sending the Spotify link.");
      const track = await resolveCard(trackUrl);
      if (!track) throw new Error("all Spotify providers are busy right now. Try again in a minute.");
      const videoUrl = track.videoUrl || "";
      const cover = track.meta.cover ? await fetchBuf(track.meta.cover, 15000).catch(() => null) : null;
      const card = buildCard(track.meta);
      const sent = cover && cover.length > 2000
        ? await sock.sendMessage(jid, { image: cover, caption: card }, { quoted: msg }).catch(() => null)
        : await sock.sendMessage(jid, { text: card }, { quoted: msg }).catch(() => null);
      await clearStatus();
      if (!sent || !sent.key || !sent.key.id) throw new Error("could not send the music card.");
      sweep();
      SPOT_PENDING.set(sent.key.id, {
        jid, user: String(getSender(msg) || ""), ts: Date.now(),
        url: trackUrl, source: track.source, audioUrl: track.audioUrl,
        meta: track.meta, videoUrl: videoUrl || "",
      });
      const timer = setTimeout(() => { SPOT_PENDING.delete(sent.key.id); }, SPOT_TTL);
      if (timer && typeof timer.unref === "function") timer.unref();
      bindListener(sock);
      try { await react(sock, msg, "✅"); } catch {}
    } catch (e) {
      await clearStatus();
      try { await react(sock, msg, "❌"); } catch {}
      await sendReply(sock, msg, `❌ Spotify failed: ${e?.message || e}`);
    }
  }

  cmd(["spotify", "spot", "spotdl", "spotifydl", "spotify2", "spotifyv2", "spotdlv2"],
    { desc: "Spotify track card: reply 1 music, 2 voice note, 3 video", category: "DOWNLOAD" },
    spotifyCard);

  return { spotifyCard, resolveCard, parseSpotifyPayload, audioFormat };
}

