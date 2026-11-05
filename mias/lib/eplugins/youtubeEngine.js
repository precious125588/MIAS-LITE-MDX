/**
 * Levanter's YouTube search helper (lib/utils.js `yts`, the Innertube path).
 * Copyright (c) lyfe00011, MIT License (see LICENSE-LEVANTER.txt).
 *
 * Search uses the same youtubei.js client and version as Levanter (18.3.0), with the same
 * result filter and field mapping. Levanter's hosted search fallback is not ported.
 *
 * song() returns the same MP3 (192 kbps, 44.1 kHz) as Levanter's song, but gets the audio from
 * public download APIs (NexRay, Prexzy) instead of Levanter's SABR stream and hosted servers.
 */
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
let clientPromise = null;

// Levanter's bC: one shared Innertube session, created with YT_COOKIE when it is set.
async function innertube() {
  if (!clientPromise) {
    clientPromise = (async () => {
      const { Innertube, UniversalCache } = require("youtubei.js");
      const options = { cache: new UniversalCache(false), generate_session_locally: true };
      if (process.env.YT_COOKIE) options.cookie = process.env.YT_COOKIE;
      return Innertube.create(options);
    })();
    clientPromise.catch(() => {
      clientPromise = null;
    });
  }
  return clientPromise;
}

/**
 * exact: lib/utils.js bx (video search). Returns the videos that have a published date, as
 * { id, title, thumbnail, author, published, view, duration, seconds }.
 */
export function toVideoList(results) {
  const videos = [];
  for (const item of results || []) {
    if (!item?.published?.text) continue;
    videos.push({
      id: item.id,
      title: item.title.text,
      thumbnail: item?.thumbnails?.[0] || { url: "" },
      author: item.author?.name || "",
      published: item.published.text || "",
      view: item.short_view_count?.text,
      duration: item.duration?.text,
      seconds: item.duration?.seconds,
    });
  }
  return videos;
}

export async function yts(query) {
  const yt = await innertube();
  const search = await yt.search(String(query), { type: "video" });
  return toVideoList(search.results);
}

/* ── song: audio download through public APIs ───────────────────────────────────── */

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const MAX_AUDIO_BYTES = 50 * 1024 * 1024;
const NEXRAY_API = () => String(process.env.NEXRAY_API || "https://api.nexray.eu.cc").replace(/\/$/, "");
const PREXZY_API = () => String(process.env.PREXZY_API || "https://prexzyapis.com").replace(/\/$/, "");

const YT_ID_REGEX = /(?:https?:\/\/|)(?:(?:www\.|m\.|)youtube(?:-nocookie|)\.com\/(?:watch\?.*(?:|&)v=|embed\/|shorts\/|v\/)|youtu\.be\/)([-_0-9A-Za-z]{11})/;

/** The 11-character video id from a bare id or a YouTube link, or null. */
export function youtubeVideoId(input) {
  const text = String(input || "").trim();
  if (/^[-_0-9A-Za-z]{11}$/.test(text)) return text;
  const match = text.match(YT_ID_REGEX);
  return match ? match[1] : null;
}

async function getJsonApi(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Each provider returns a direct audio URL. They are tried in this order until one works.
const AUDIO_PROVIDERS = [
  {
    name: "nexray",
    async resolve(ytUrl) {
      const data = await getJsonApi(`${NEXRAY_API()}/downloader/ytmp3?url=${encodeURIComponent(ytUrl)}`);
      if (!data?.result?.url) throw new Error("no audio url in response");
      return { url: data.result.url, title: data.result.title || "" };
    },
  },
  {
    name: "prexzy",
    async resolve(ytUrl) {
      const data = await getJsonApi(`${PREXZY_API()}/download/ytmp3?url=${encodeURIComponent(ytUrl)}`);
      if (!data?.download_url) throw new Error("no audio url in response");
      return { url: data.download_url, title: data?.info?.title || "" };
    },
  },
  {
    name: "nexray-aio",
    async resolve(ytUrl) {
      const data = await getJsonApi(`${NEXRAY_API()}/downloader/aio?url=${encodeURIComponent(ytUrl)}`);
      const best = (data?.result?.medias || [])
        .filter((m) => m?.type === "audio" && m?.url)
        .sort((a, b) => Number(b.bitrate || 0) - Number(a.bitrate || 0))[0];
      if (!best) throw new Error("no audio url in response");
      return { url: best.url, title: data.result.title || "" };
    },
  },
];

// Reads the body while counting bytes, so an oversized response is cut off, not buffered whole.
async function downloadAudio(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow", signal: AbortSignal.timeout(180000) });
  if (!res.ok) throw new Error(`audio download HTTP ${res.status}`);
  const declared = Number(res.headers.get("content-length") || 0);
  if (declared > MAX_AUDIO_BYTES) throw new Error("audio file is too large");
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_AUDIO_BYTES) {
      await reader.cancel();
      throw new Error("audio file is too large");
    }
    chunks.push(Buffer.from(value));
  }
  if (!total) throw new Error("audio download was empty");
  return Buffer.concat(chunks);
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.FFMPEG_PATH || "ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-4000);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 180000);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.trim().slice(-300)}`));
    });
  });
}

/** exact: Levanter's song output format, MP3 at 192 kbps and 44.1 kHz (audioBitrate 192, audioFrequency 44100). */
export async function transcodeToMp3(input) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "song-"));
  const inPath = path.join(dir, "input");
  const outPath = path.join(dir, "output.mp3");
  try {
    await writeFile(inPath, input);
    await runFfmpeg(["-hide_banner", "-loglevel", "error", "-y", "-i", inPath, "-vn", "-c:a", "libmp3lame", "-b:a", "192k", "-ar", "44100", outPath]);
    return await readFile(outPath);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Levanter's song(videoId): resolves { buffer, title, id, provider } with the MP3 bytes.
 * Throws with each provider's failure when none of them returns audio.
 */
export async function song(input) {
  const id = youtubeVideoId(input);
  if (!id) throw new Error("song: expected a YouTube video id or link");
  const ytUrl = `https://www.youtube.com/watch?v=${id}`;
  const failures = [];
  for (const provider of AUDIO_PROVIDERS) {
    try {
      const { url, title } = await provider.resolve(ytUrl);
      const raw = await downloadAudio(url);
      const buffer = await transcodeToMp3(raw);
      return { buffer, title, id, provider: provider.name };
    } catch (err) {
      failures.push(`${provider.name}: ${err.message}`);
    }
  }
  throw new Error(`song: no audio provider returned ${id} (${failures.join("; ")})`);
}
