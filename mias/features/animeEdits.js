// Anime edit command plugin.
//
// The resolver deliberately lives outside index.js so anime aliases and
// provider behavior can be changed without touching the main dispatcher.

import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { execFile } from "child_process";
import { promisify } from "util";
import {
  searchStatusCandidates,
  resolveStatusCandidate,
} from "../lib/statusEditFlow.js";
import {
  candidateText,
  isAllowedAnimeCandidate,
} from "../lib/animeContentFilter.js";

const require = createRequire(import.meta.url);
const axios = require("axios");
const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ANIME_ROOT = path.resolve(__dirname, "..", "..", "animes");
const ANIME_SOURCE_CONFIG = readJson(
  path.join(__dirname, "..", "Config", "animeSources.json"),
  readJson(path.join(__dirname, "..", "config", "animeSources.json"), {}),
);
const ANIME_SOURCE_LIST = readSourceList(
  path.join(__dirname, "..", "Config", "animeSources.txt"),
);
const MAX_RESULTS = 3;
const NARUTO_RESULTS = 2;
const DEMON_SLAYER_RESULTS = 2;
const MAX_INPUT_BYTES = 90 * 1024 * 1024;
const JJK_RESULTS = 2;
const NARUTO_SEARCH_BATCH_SIZE = 1;
const NARUTO_CANDIDATE_TARGET = 4;
const DC_TIKTOK_ENDPOINTS = [
  "/download/tiktokdl-rapid",
  "/download/tiktok",
  "/download/savetik",
];
const MAX_PORTABLE_MP4_BYTES = 12 * 1024 * 1024;
const MAX_PORTABLE_OUTPUT_BYTES = 16 * 1024 * 1024;
const SOURCE_PAGE_TIMEOUT_MS = 25000;
const SOURCE_PAGE_CACHE_TTL_MS = 5 * 60 * 1000;
const configuredPageCache = new Map();
// Keep anime shortcuts aligned with the status wizard's hard three-minute
// limit. The actual trim is performed by ffmpeg before anything is sent.
const MAX_DURATION_SECONDS = 180;

// These are deliberately generic enough for mixed anime source pages. They
// are only used as outgoing captions; they never widen the configured source
// allow-list or trigger a search outside it.
const RANDOM_EDIT_HASHTAGS = Object.freeze([
  "#animeedit", "#animeedits", "#amv", "#anime", "#edit", "#edits",
  "#4kedit", "#auraedit", "#animeamv", "#otaku", "#weeb",
  // trending + quality-boost pool for random status fetches (4k/60/120/360fps)
  "#trending", "#trendingedit", "#trendinganime", "#viraledit",
  "#4k", "#4kedits", "#4kanime", "#60fps", "#60fpsedit", "#60fpsanime",
  "#120fps", "#120fpsedit", "#360fps", "#animeedit4k",
]);

// Naruto is intentionally restricted to this TikTok hashtag pool. Do not
// widen this to a generic web/search-engine query: that was the source of
// unrelated clips and unreliable downloads.
//
// Keep the seed list readable and let uniqueHashtags() remove repeated tags
// case-insensitively. TikTok treats hashtag casing as equivalent, so entries
// such as #Ninetails and #nineTails must not create duplicate searches.
const NARUTO_HASHTAG_SEED = [
  "#Naruto",
  "#Narutoshipuden",
  "#Narutouzumaki",
  "#Ninetails",
  "#narutoedit",
  "#rasengannaruto",
  "#boruto",
  "#sasuke",
  "#Obito",
  "#Obitoedits",
  "#shikamaru",
  "#narutovspain",
  "#ObitoUchiha",
  "#Uchiha",
  "#Shinuchiha",
  "#Minato",
  "#kakashi",
  "#kakashiedit",
  "#Jiraya",
  "#Jirayaedits",
  "#Minatoedit",
  "#Akatsuki",
  "#Akatsukiedits",
  "#Madara",
  "#kurenal",
  "#Shadowclonetsutsu",
  "#kurama",
  "#Hashirama",
  "#tobirama",
  "#Rocklee",
  "#Guysensei",
  "#Pain",
  "#Yaiko",
  "#nagato",
  "#sasukeuchiha",
  "#sasukes",
  "#sasukedit",
  "#sakura",
  "#sakuraharuno",
  "#kakashihatake",
  "#itachi",
  "#itachiuchiha",
  "#itachiedit",
  "#madarauchiha",
  "#obitouchiha",
  "#minatonamikaze",
  "#jiraiya",
  "#tsunade",
  "#gaara",
  "#mightguy",
  "#guy",
  "#neji",
  "#ino",
  "#choji",
  "#hinata",
  "#hinatahyuga",
  "#borutouzumaki",
  "#kawaki",
  "#sarada",
  "#mitsuki",
  "#konohamaru",
  "#shisui",
  "#shisuiuchiha",
  "#hashiramasenju",
  "#hiruzen",
  "#orochimaru",
  "#kabuto",
  "#deidara",
  "#kisame",
  "#konan",
  "#hidan",
  "#kakuzu",
  "#sasori",
  "#zabuza",
  "#haku",
  "#killerbee",
  "#borutonarutonextgenerations",
  "#borutoedit",
  "#borutoedits",
  "#borutotiktok",
  "#borutokawaki",
  "#saradauchiha",
  "#borutotwobluevortex",
  "#tbv",
  "#twobluevortex",
  "#narutoshippuden",
  "#animeedit",
  "#akatsuki",
  "#sharingan",
  "#rinnegan",
  "#rasengan",
  "#susanoo",
  "#chakra",
  "#narutoedits",
  "#uchiha",
  "#uchihaclan",
  "#uzumaki",
  "#uzumakiclan",
  "#senju",
  "#senjucan",
  "#hyuga",
  "#hyugaclan",
  "#akatsukiedit",
  "#akatsukimemes",
  "#team7",
  "#team10",
  "#team8",
  "#teamguy",
  "#konoha",
  "#hiddenleaf",
  "#leafvillage",
  "#shinobi",
  "#ninja",
  "#narutoverse",
  "#shinobiworld",
  "#sharing",
  "#mangekyosharingan",
  "#eternalms",
  "#byakugan",
  "#rinnesharingan",
  "#baryonmode",
  "#sixpath",
  "#sixpaths",
  "#sixpathsofpain",
  "#sageMode",
  "#sixpathsage",
  "#rasenshuriken",
  "#chidori",
  "#amaterasu",
  "#kamui",
  "#izanagi",
  "#izanami",
  "#genjutsu",
  "#taijutsu",
  "#ninjutsu",
  "#kagebunshin",
  "#shadowclone",
  "#woodstyle",
  "#firestyle",
  "#waterstyle",
  "#lightningstyle",
  "#earthstyle",
  "#windstyle",
  "#otsutsuki",
  "#otsutsukiclan",
  "#otsutsukiedit",
  "#otsutsukiedits",
  "#otsutsukimoments",
  "#otsutsukimemes",
  "#otsutsukipower",
  "#otsutsukipowers",
  "#kaguya",
  "#kaguyatsutsuki",
  "#kaguyaroot",
  "#kaguyaedit",
  "#kaguyaedits",
  "#momoshiki",
  "#momoshikiotsutsuki",
  "#momoshikiedit",
  "#momoshikiedits",
  "#kinshiki",
  "#kinshikiotsutsuki",
  "#kinshikiedit",
  "#isshiki",
  "#isshikiootsutsuki",
  "#isshikiedit",
  "#isshikiedits",
  "#jigen",
  "#jigenedit",
  "#urashiki",
  "#urashikiedit",
  "#toneri",
  "#toneriotsutsuki",
  "#toneriedit",
  "#hagoromo",
  "#hagoromootsutsuki",
  "#hagoromoedit",
  "#sageofsixpaths",
  "#hamura",
  "#hamuraotsutsuki",
  "#hamuraedit",
  "#shibai",
  "#shibaiotsutsuki",
  "#shibaiotsutsukiedit",
  "#code",
  "#daemon",
  "#daemonedit",
  "#eida",
  "#edaedit",
  "#otsutsukilore",
  "#otsutsukigod",
  "#shinjutsu",
  "#shinjutsupowers",
  "#divinepower",
  "#godofshinobi",
  "#sixpathssage",
  "#tenseigan",
  "#jougan",
  "#karma",
  "#karmaseal",
  "#rinnegans",
  "#narutoamv",
  "#narutoamvedit",
  "#narutoshippudenedit",
  "#narutoanimeedit",
  "#naruto4k",
  "#naruto4kedit",
  "#narutoedit4k",
  "#narutoeditz",
  "#narutoedits4k",
  "#itachiedits",
  "#madaraedit",
  "#madaraedits",
  "#obitoedit",
  "#obitoedits",
  "#sasukeedit",
  "#sasukeedits",
  "#shisuiedit",
  "#otsutsukiclan",
  "#kaguyautsutsuki",
  "#shibaiedit",
  "#kiba",
  "#eternalmangekyosharingan",
  "#rinnegansharingan",
  "#perfectsusanoo",
  "#narutoaura",
  "#animeaura",
  "#animepower",
  "#animepowers",
  "#painedit",
  "#nagatoedit",
  "#minatoedit",
  "#jiraiyaedit",
  "#hashiramaedit",
  "#tobiramaedit",
  "#mightguyedit",
  "#rockleeedit",
  "#gaaraedit",
  "#deidaraedit",
  "#tentails",
  "#tentailsedits",
  "#tenten",
  "#temari",
];

// JJK has its own pool so `.jjk` can never fall through to a generic TikTok
// search. Keep the series name in every search pool as requested.
const JJK_HASHTAG_SEED = [
  "#jjk",
  "#jjkedit",
  "#jjkedits",
  "#jujutsukaisen",
  "#jujutsukaisenedit",
  "#jujutsukaisenedits",
  "#jujutsukaisenamv",
  "#jujutsukaisen4k",
  "#jjkamv",
  "#jjk4k",
  "#jjkaura",
  "#satorugojo",
  "#gojo",
  "#gojoedit",
  "#gojoedits",
  "#gojo4k",
  "#gojoaura",
  "#geto",
  "#getoedit",
  "#sukuna",
  "#sukunaedit",
  "#sukunaedits",
  "#yujiitadori",
  "#itadoriyuji",
  "#itadoriedit",
  "#megumifushiguro",
  "#megumiedit",
  "#nobara",
  "#nobaraedit",
  "#toji",
  "#tojiedit",
  "#maki",
  "#makiedit",
  "#yuta",
  "#yutaedit",
  "#nanami",
  "#nanamiedit",
  "#mahito",
  "#mahitoedit",
  "#kenjaku",
  "#jjkseason2",
  "#jjkseason3",
  "#shibuya",
  "#shibuyaarc",
  "#cullinggame",
];

// Supplied Demon Slayer / Kimetsu no Yaiba hashtag pool. Keep this list
// explicit: the command must stay inside the requested TikTok source set.
const DEMON_SLAYER_HASHTAG_SEED = [
  "#demonslayer", "#kimetsunoyaiba", "#kny", "#knyedit", "#knyedits",
  "#demonslayer4k", "#demonslayer4kedit", "#demonslayeramv", "#demonslayeramvedit",
  "#tanjiro", "#tanjiroedit", "#tanjiroedits", "#tanjiro4k", "#tanjiroaura",
  "#hinokamikagura", "#sunbreathing", "#zenitsu", "#zenitsuedit", "#zenitsuedits",
  "#zenitsu4k", "#zenitsuaura", "#thunderbreathing", "#rengoku", "#rengokuedit",
  "#rengokuedits", "#rengoku4k", "#rengokuaura", "#flamebreathing", "#tengen",
  "#tengenedit", "#tengenedits", "#tengen4k", "#tengenaura", "#soundbreathing",
  "#giyu", "#giyuedit", "#giyuedits", "#giyu4k", "#giyuaura", "#muichiro",
  "#muichiroedit", "#muichiroedits", "#muichiro4k", "#muichiroaura",
  "#mistbreathing", "#sanemi", "#sanemiedit", "#sanemiedits", "#sanemiaura",
  "#windbreathing", "#gyomei", "#gyomeiedit", "#gyomeiedits", "#gyomeiaura",
  "#stonebreathing", "#mitsuri", "#mitsuriedit", "#mitsuriedits", "#mitsuriaura",
  "#obanai", "#obanaiedit", "#shinobu", "#shinobuedit", "#shinobuedits",
  "#shinobuaura", "#muzan", "#muzanedit", "#muzanedits", "#muzanaura",
  "#kokushibo", "#kokushiboedit", "#kokushiboedits", "#kokushiboaura", "#douma",
  "#doumaedit", "#doumaedits", "#doumaaura", "#akaza", "#akazaedit", "#akazaedits",
  "#akazaaura", "#hantengu", "#hantenguedit", "#gyokko", "#gyokkoedit", "#nakime",
  "#nakimeedit", "#uppermoon", "#uppermoonedit", "#uppermoonedits", "#uppermoons",
  "#twelvekizuki", "#moonbreathing", "#demonmark", "#demonslayeredits4k",
  "#demonslayeredit4k", "#demonslayeredits", "#demonslayeredit", "#infinitycastle",
  "#kny",
];

function uniqueHashtags(items) {
  const seen = new Set();
  return items.filter((hashtag) => {
    const key = normalizeHashtag(hashtag);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export const NARUTO_HASHTAGS = Object.freeze(uniqueHashtags(NARUTO_HASHTAG_SEED));
export const JJK_HASHTAGS = Object.freeze(uniqueHashtags(JJK_HASHTAG_SEED));
export const DEMON_SLAYER_HASHTAGS = Object.freeze(uniqueHashtags(DEMON_SLAYER_HASHTAG_SEED));

// TikWM treats `/api/feed/search` (without the trailing slash) as a protected
// web route and returns HTTP 403. The actual JSON endpoint is the slash form.
// Keep both hostnames because either one can be rate-limited independently.
const TIKWM_SEARCH_ENDPOINTS = [
  "https://www.tikwm.com/api/feed/search/",
  "https://tikwm.com/api/feed/search/",
];
const TIKWM_DETAIL_ENDPOINTS = [
  "https://www.tikwm.com/api/",
  "https://tikwm.com/api/",
];
let tikwmQueue = Promise.resolve();
let davidCyrilClientPromise;

// These are safe built-in shortcuts. Catalog entries can add more registered
// titles without changing the dispatcher.
const BUILTIN_ALIASES = {
  naruto: ["naruto"],
  jjk: ["jjk", "jujutsu kaisen"],
  "one-piece": ["one piece"],
  bleach: ["bleach"],
  "demon-slayer": ["demon slayer", "kimetsu no yaiba"],
  "dragon-ball": ["dragon ball", "dragonball"],
  "attack-on-titan": ["attack on titan", "aot"],
  "solo-leveling": ["solo leveling"],
  "my-hero-academia": ["my hero academia", "bnha"],
  "one-punch-man": ["one punch man"],
  "black-clover": ["black clover"],
  "chainsaw-man": ["chainsaw man"],
  "tokyo-revengers": ["tokyo revengers"],
  "blue-lock": ["blue lock"],
};

function cleanSlug(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function commandKey(value) {
  return cleanSlug(value).replace(/-/g, "");
}

function displayName(slug) {
  return String(slug || "")
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function readSourceList(file) {
  try {
    return fs.readFileSync(file, "utf8")
      .split(/\r?\n/)
      .map((line) => line.replace(/#.*/, "").trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function sourceConfigValues(slug) {
  // The plain-text list is the easiest option for non-coders: paste one
  // TikTok profile/share URL per line. If it exists, it intentionally
  // replaces the JSON global list so deleting a line really removes it.
  const globalSources = ANIME_SOURCE_LIST.length
    ? ANIME_SOURCE_LIST
    : [
      ...(Array.isArray(ANIME_SOURCE_CONFIG.sources)
        ? ANIME_SOURCE_CONFIG.sources : []),
      ...(Array.isArray(ANIME_SOURCE_CONFIG.sourceLinks)
        ? ANIME_SOURCE_CONFIG.sourceLinks : []),
      ...(Array.isArray(ANIME_SOURCE_CONFIG.defaultSources)
        ? ANIME_SOURCE_CONFIG.defaultSources : []),
    ];
  const values = [
    ...globalSources,
    ...(Array.isArray(ANIME_SOURCE_CONFIG.defaultPages)
      ? ANIME_SOURCE_CONFIG.defaultPages : []),
    ...(Array.isArray(ANIME_SOURCE_CONFIG[slug]?.sources)
      ? ANIME_SOURCE_CONFIG[slug].sources : []),
    ...(Array.isArray(ANIME_SOURCE_CONFIG[slug]?.sourceLinks)
      ? ANIME_SOURCE_CONFIG[slug].sourceLinks : []),
    ...(Array.isArray(ANIME_SOURCE_CONFIG[slug]?.pages)
      ? ANIME_SOURCE_CONFIG[slug].pages : []),
  ];
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function isTikTokUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    return /(^|\.)tiktok\.com$/i.test(url.hostname);
  } catch {
    return false;
  }
}

// vm.tiktok.com / vt.tiktok.com / tiktok.com/t/ are SHORT LINKS to a single
// video. Every downloader in the chain follows the 302 redirect to the
// canonical /@user/video/<id> URL on its own, so these must be classified as
// VIDEO urls. Treating them as "pages" was the VM-source expectation
// mismatch: the page scraper compared a redirect stub against video metadata
// and rejected every VM source.
function isTikTokShortLink(url) {
  return /^(vm|vt|m)\.tiktok\.com$/i.test(url.hostname)
    || (/(^|\.)tiktok\.com$/i.test(url.hostname) && /^\/t\//i.test(url.pathname));
}

function isConfiguredVideoUrl(value) {
  if (!isTikTokUrl(value)) return false;
  try {
    const url = new URL(String(value).trim());
    if (isTikTokShortLink(url)) return true;
    return /\/@[^/]+\/video(?:\/|$)/i.test(url.pathname)
      || /\/video\/\d+/i.test(url.pathname);
  } catch {
    return false;
  }
}

function configuredSourceVideoUrls(slug) {
  return sourceConfigValues(slug).filter(isConfiguredVideoUrl);
}

function configuredSourcePages(slug) {
  return sourceConfigValues(slug).filter((value) => !isConfiguredVideoUrl(value));
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function videoMetadataFromObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const videoId = value.video_id || value.aweme_id || value.awemeId
    || value.item_id || value.itemId || value.videoId
    // TikTok's own SIGI_STATE / rehydration pages name the field just "id".
    // Accept it only when it is a real numeric aweme id so random page
    // objects never slip through.
    || (/^\d{10,25}$/.test(String(value.id || "")) ? value.id : undefined);
  const author = value.author?.unique_id
    || value.author?.uniqueId
    || value.author?.nickname
    || value.authorInfo?.unique_id
    || value.authorInfo?.uniqueId
    || value.authorInfo?.nickname
    || value.unique_id
    || value.uniqueId
    // SIGI item rows expose the author as a plain username string.
    || (typeof value.author === "string" ? value.author : undefined)
    || value.nickname;
  const title = String(
    value.title
      || value.desc
      || value.description
      || value.text
      || value.caption
      || "",
  ).trim();
  if (!videoId || (!author && !value.share_url && !value.shareUrl) || !title) return null;
  const sourceUrl = firstUrl(
    value.share_url,
    value.shareUrl,
    value.url,
    author && videoId ? `https://www.tiktok.com/@${author}/video/${videoId}` : "",
  );
  if (!sourceUrl || !isTikTokUrl(sourceUrl)) return null;
  return {
    sourceUrl,
    videoId: String(videoId),
    title: title.slice(0, 240),
    author: String(author || "TikTok creator").trim(),
    views: value.play_count || value.playCount || value.views || 0,
    likes: value.digg_count || value.diggCount || value.likes || 0,
    row: value,
    sourceType: "configured-page",
  };
}

function extractTikTokVideoMetadata(html) {
  const found = [];
  const seen = new Set();
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const candidate = videoMetadataFromObject(value);
    if (candidate) {
      const key = candidate.videoId || canonicalUrl(candidate.sourceUrl);
      if (!seen.has(key)) {
        seen.add(key);
        found.push(candidate);
      }
    }
    for (const child of Object.values(value)) {
      if (child && typeof child === "object") visit(child);
    }
  };

  const scripts = String(html || "").match(/<script\b[^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const script of scripts) {
    const body = script.replace(/^<script\b[^>]*>/i, "").replace(/<\/script>$/i, "").trim();
    if (!body || body.length > 2_000_000) continue;
    try {
      visit(JSON.parse(decodeHtml(body)));
    } catch {}
  }
  return found;
}

function matchesAnimeEditCandidate(candidate, slug) {
  if (slug === "naruto") return isNarutoEditTitle(candidate);
  if (slug === "jjk") return isJjkEditTitle(candidate);
  if (slug === "demon-slayer") return isDemonSlayerEditTitle(candidate);
  return isAllowedAnimeCandidate(candidate);
}

async function configuredPageCandidates(slug) {
  const pages = configuredSourcePages(slug);
  const candidates = [];
  const seen = new Set();
  const readPage = async (pageUrl) => {
    const cacheKey = canonicalUrl(pageUrl);
    let rows = configuredPageCache.get(cacheKey);
    if (rows && Date.now() - rows.cachedAt <= SOURCE_PAGE_CACHE_TTL_MS) return rows;
    try {
      const response = await axios.get(pageUrl, {
        timeout: SOURCE_PAGE_TIMEOUT_MS,
        maxRedirects: 5,
        responseType: "text",
        headers: {
          "User-Agent": "Mozilla/5.0",
          Accept: "text/html,application/xhtml+xml",
        },
      });
      rows = {
        cachedAt: Date.now(),
        items: extractTikTokVideoMetadata(response.data),
      };
    } catch {
      rows = { cachedAt: Date.now(), items: [] };
    }
    configuredPageCache.set(cacheKey, rows);
    return rows;
  };

  // Read a few pages at once so one unavailable TikTok profile cannot make a
  // command wait through the whole source list serially.
  for (let offset = 0; offset < pages.length; offset += 6) {
    const batch = await Promise.all(pages.slice(offset, offset + 6).map(readPage));
    for (const rows of batch) {
      for (const candidate of rows.items || []) {
        if (!matchesAnimeEditCandidate(candidate, slug)) continue;
        const key = candidate.videoId || canonicalUrl(candidate.sourceUrl);
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push(candidate);
      }
    }
  }
  return shuffle(candidates);
}

function sourcePageHandles(slug) {
  const configured = sourceConfigValues(slug);
  return new Set(configured.map((value) => {
    const raw = String(value || "").trim().toLowerCase();
    if (!raw) return "";
    if (raw.startsWith("@")) return raw.slice(1);
    try {
      const pathname = new URL(raw).pathname;
      return pathname.match(/\/@([^/]+)/)?.[1]?.toLowerCase() || "";
    } catch {
      return raw.replace(/^@/, "").replace(/\/+$/, "");
    }
  }).filter(Boolean));
}

function randomHashtags(count = 3) {
  const pool = [...RANDOM_EDIT_HASHTAGS];
  for (let index = pool.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    [pool[index], pool[swap]] = [pool[swap], pool[index]];
  }
  return pool.slice(0, Math.max(1, Math.min(Number(count) || 3, 5))).join(" ");
}

function configuredSourceCandidates(slug) {
  return shuffle(configuredSourceVideoUrls(slug)).map((sourceUrl) => ({
    sourceUrl,
    videoId: "",
    hashtag: randomHashtags(1),
    title: "Configured TikTok anime edit",
    author: "Configured TikTok source",
    sourceType: "configured",
  }));
}

async function collectConfiguredCandidates(slug) {
  // Explicit video URLs are supported for future additions, while the
  // supplied vm.tiktok.com links are treated as pages and expanded from the
  // page metadata. Never turn a page into a generic TikTok search.
  const direct = configuredSourceCandidates(slug);
  const pageItems = await configuredPageCandidates(slug);
  return shuffle([...direct, ...pageItems]);
}

function isAllowedSourcePage(row, slug) {
  const allowed = sourcePageHandles(slug);
  if (!allowed.size) return true;
  const author = String(
    row?.author?.unique_id
      || row?.author?.uniqueId
      || row?.author?.nickname
      || "",
  ).trim().toLowerCase().replace(/^@/, "");
  return !!author && allowed.has(author);
}

function loadCatalog() {
  const configured = readJson(path.join(ANIME_ROOT, "catalog.json"), []);
  const bySlug = new Map();
  for (const item of Array.isArray(configured) ? configured : []) {
    const slug = cleanSlug(item?.slug || item?.folder || item?.title);
     if (!slug) continue;
    bySlug.set(slug, {
      slug,
      title: String(item.title || displayName(slug)).trim(),
      aliases: [],
      query: String(item.query || item.title || displayName(slug)).trim(),
    });
  }

  // Keep the built-in commands available even when the optional /animes
  // media folder has not been created yet. Previously an empty folder meant
  // .naruto was never registered, so the only thing the user saw was the
  // Keep the title command available even when the optional /animes media
  // folder has not been created yet.
  for (const [slug, aliases] of Object.entries(BUILTIN_ALIASES)) {
    const current = bySlug.get(slug) || {
      slug,
      title: displayName(slug),
      aliases: [],
      query: displayName(slug),
    };
    current.aliases = [...new Set([
      ...(current.aliases || []),
      ...aliases.map(commandKey),
    ])];
    bySlug.set(slug, current);
  }

  try {
    for (const entry of fs.readdirSync(ANIME_ROOT, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const slug = cleanSlug(entry.name);
       if (!slug) continue;
      const current = bySlug.get(slug) || {
        slug,
        title: displayName(slug),
        aliases: [],
        query: displayName(slug),
      };
      const titleFile = path.join(ANIME_ROOT, entry.name, "title.txt");
      try {
        const title = fs.readFileSync(titleFile, "utf8").trim();
        if (title) {
          current.title = title.slice(0, 100);
          current.query = title.slice(0, 100);
        }
      } catch {}
      bySlug.set(slug, current);
    }
  } catch {}

  for (const [slug, aliases] of Object.entries(BUILTIN_ALIASES)) {
    const current = bySlug.get(slug) || {
      slug,
      title: displayName(slug),
      aliases: [],
      query: displayName(slug),
    };
    current.aliases = [...new Set([
      ...current.aliases,
      ...aliases.map(commandKey),
      commandKey(slug),
    ])];
    bySlug.set(slug, current);
  }
  return [...bySlug.values()];
}

function validVideoBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 10000 || buffer.length > MAX_INPUT_BYTES) return false;
  const header = buffer.slice(0, 16);
  return header.slice(4, 8).toString("ascii") === "ftyp"
    || header.slice(0, 4).toString("ascii") === "RIFF"
    || (header[0] === 0x1a && header[1] === 0x45 && header[2] === 0xdf && header[3] === 0xa3);
}

function isMp4Buffer(buffer) {
  return validVideoBuffer(buffer) && buffer.slice(4, 8).toString("ascii") === "ftyp";
}

function ffmpegBinary() {
  try {
    const bundled = require("ffmpeg-static");
    if (bundled && fs.existsSync(bundled)) return bundled;
  } catch {}
  return process.env.FFMPEG_PATH || "ffmpeg";
}

async function normalizeHdVideo(input) {
  if (!validVideoBuffer(input)) return null;
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mias-anime-"));
  const source = path.join(dir, "source.bin");
  const output = path.join(dir, "anime-hd.mp4");
  try {
    await fs.promises.writeFile(source, input);
    await execFileAsync(ffmpegBinary(), [
      "-hide_banner", "-loglevel", "error", "-y",
      "-i", source,
      "-t", String(MAX_DURATION_SECONDS),
      "-map", "0:v:0", "-map", "0:a:0?",
      // Cap the longest edge at 1280 without padding. TikTok edits are
      // normally portrait; forcing 1280x720 made them arrive with large
      // black bars and a poor WhatsApp preview.
      "-vf", "scale=720:720:force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1",
      "-r", "30",
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "64k", "-movflags", "+faststart",
      "-f", "mp4", output,
    ], { timeout: 120000, maxBuffer: 1024 * 1024 });
    const result = await fs.promises.readFile(output);
    return validVideoBuffer(result) ? result : null;
  } catch (error) {
    console.warn("[anime-edits] HD conversion skipped candidate:", error?.message || error);
    return null;
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function withTimeout(promise, timeoutMs = 130000) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function tikwmRequest(url, params) {
  const request = tikwmQueue.then(async () => {
    const response = await axios.get(url, {
      params,
      timeout: 25000,
      headers: {
        "User-Agent": "Mozilla/5.0",
        Accept: "application/json",
      },
    });
    return response.data;
  });
  tikwmQueue = request.catch(() => {});
  return request;
}

function shuffle(items) {
  const output = [...items];
  for (let index = output.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    [output[index], output[swap]] = [output[swap], output[index]];
  }
  return output;
}

function firstUrl(...values) {
  return values.find((value) => typeof value === "string" && /^https?:\/\//i.test(value)) || "";
}

function normalizeHashtag(value) {
  return String(value || "").trim().toLowerCase().replace(/^#+/, "").replace(/[^a-z0-9]+/g, "");
}

function canonicalUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return raw.replace(/[?#].*$/, "").replace(/\/+$/, "").toLowerCase();
  }
}

export function isNarutoEditTitle(value) {
  const title = typeof value === "object"
    ? candidateText(value)
    : String(value || "").trim();
  const normalized = title.toLowerCase().replace(/[^a-z0-9]+/g, " ");
  const series = /\b(?:naruto|boruto|uzumaki|uchiha|shippuden)\b/.test(normalized);
  const edit = /\b(?:edit|edits|amv|4k|aura|status)\b/.test(normalized);
  return series && edit && isAllowedAnimeCandidate(title);
}

function buildHashtagSearchQueries(hashtags) {
  // There are no fixed "anchors" anymore. Every request searches a random
  // hashtag from the command's own allow-list, so results cannot spill into
  // an unrelated anime or a general TikTok search.
  return shuffle(hashtags);
}

export function buildNarutoSearchQueries() {
  return buildHashtagSearchQueries(NARUTO_HASHTAGS);
}

export function isJjkEditTitle(value) {
  const title = typeof value === "object"
    ? candidateText(value)
    : String(value || "").trim();
  const normalized = title.toLowerCase().replace(/[^a-z0-9]+/g, " ");
  const series = /\b(?:jjk|jujutsu|gojo|sukuna|geto|itadori|megumi|nobara|toji)\b/.test(normalized);
  const edit = /\b(?:edit|edits|amv|4k|aura|status)\b/.test(normalized);
  return series && edit && isAllowedAnimeCandidate(title);
}

export function buildJjkSearchQueries() {
  return buildHashtagSearchQueries(JJK_HASHTAGS);
}

export function isDemonSlayerEditTitle(value) {
  const title = typeof value === "object"
    ? candidateText(value)
    : String(value || "").trim();
  const normalized = title.toLowerCase().replace(/[^a-z0-9]+/g, " ");
  const series = /\b(?:demon\s+slayer|kimetsu(?:\s+no\s+yaiba)?|kny|tanjiro|zenitsu|rengoku|tengen|giyu|muzan|akaza|kokushibo|douma|shinobu|mitsuri|muichiro)\b/.test(normalized);
  const edit = /\b(?:edit|edits|amv|4k|aura|breathing|infinity\s+castle)\b/.test(normalized);
  return series && edit && isAllowedAnimeCandidate(title);
}

export function buildDemonSlayerSearchQueries() {
  return buildHashtagSearchQueries(DEMON_SLAYER_HASHTAGS);
}

function narutoCandidate(row, hashtag) {
  const author = row?.author?.unique_id
    || row?.author?.uniqueId
    || row?.author?.nickname
    || row?.author?.uniqueId;
  const videoId = row?.video_id || row?.aweme_id || row?.awemeId || row?.id;
  const sourceUrl = firstUrl(
    row?.share_url,
    row?.shareUrl,
    row?.url,
    author && videoId ? `https://www.tiktok.com/@${author}/video/${videoId}` : "",
  );
  const title = String(row?.title || row?.desc || "").trim().slice(0, 140);
  if (!sourceUrl
    || !isAllowedSourcePage(row, "naruto")
    || !isNarutoEditTitle({ ...row, title, hashtag })) return null;
  return {
    sourceUrl,
    videoId: String(videoId || "").trim(),
    hashtag,
    title,
    author: String(author || "TikTok creator").trim(),
    views: row?.play_count || row?.playCount || row?.views || 0,
    likes: row?.digg_count || row?.diggCount || row?.likes || 0,
    row,
  };
}

function demonSlayerCandidate(row, hashtag) {
  const author = row?.author?.unique_id
    || row?.author?.uniqueId
    || row?.author?.nickname
    || row?.author?.uniqueId;
  const videoId = row?.video_id || row?.aweme_id || row?.awemeId || row?.id;
  const sourceUrl = firstUrl(
    row?.share_url,
    row?.shareUrl,
    row?.url,
    author && videoId ? `https://www.tiktok.com/@${author}/video/${videoId}` : "",
  );
  const title = String(row?.title || row?.desc || "").trim().slice(0, 180);
  if (!sourceUrl
    || !isAllowedSourcePage(row, "demon-slayer")
    || !isDemonSlayerEditTitle({ ...row, title, hashtag })) return null;
  return {
    sourceUrl,
    videoId: String(videoId || "").trim(),
    hashtag,
    title,
    author: String(author || "TikTok creator").trim(),
    views: row?.play_count || row?.playCount || row?.views || 0,
    likes: row?.digg_count || row?.diggCount || row?.likes || 0,
    row,
  };
}

function jjkCandidate(row, hashtag) {
  const author = row?.author?.unique_id
    || row?.author?.uniqueId
    || row?.author?.nickname
    || row?.author?.uniqueId;
  const videoId = row?.video_id || row?.aweme_id || row?.awemeId || row?.id;
  const sourceUrl = firstUrl(
    row?.share_url,
    row?.shareUrl,
    row?.url,
    author && videoId ? `https://www.tiktok.com/@${author}/video/${videoId}` : "",
  );
  const title = String(row?.title || row?.desc || "").trim().slice(0, 180);
  if (!sourceUrl
    || !isAllowedSourcePage(row, "jjk")
    || !isJjkEditTitle({ ...row, title, hashtag })) return null;
  return {
    sourceUrl,
    videoId: String(videoId || "").trim(),
    hashtag,
    title,
    author: String(author || "TikTok creator").trim(),
    views: row?.play_count || row?.playCount || row?.views || 0,
    likes: row?.digg_count || row?.diggCount || row?.likes || 0,
    row,
  };
}

async function searchHashtag(query, mapCandidate) {
  for (const endpoint of TIKWM_SEARCH_ENDPOINTS) {
    try {
      const payload = await tikwmRequest(endpoint, {
        keywords: query,
        count: 20,
        cursor: 0,
        web: 1,
        HD: 1,
      });
      if (Number(payload?.code) !== 0 && payload?.data == null) continue;
      const rows = payload?.data?.videos || payload?.data?.data || payload?.data || [];
      const candidates = (Array.isArray(rows) ? rows : [])
        .map((row) => mapCandidate(row, query))
        .filter(Boolean);
      if (candidates.length) return candidates;
    } catch {}
  }
  return [];
}

const searchNarutoHashtag = (query) => searchHashtag(query, narutoCandidate);
const searchJjkHashtag = (query) => searchHashtag(query, jjkCandidate);
const searchDemonSlayerHashtag = (query) => searchHashtag(query, demonSlayerCandidate);

async function collectNarutoCandidates() {
  const candidates = [];
  const seen = new Set();
  // Search only shuffled hashtags from Naruto's own pool. A quiet hashtag is
  // skipped and the next one is tried; no generic TikTok search is used.
  const queries = buildNarutoSearchQueries();
  for (let offset = 0; offset < queries.length; offset += NARUTO_SEARCH_BATCH_SIZE) {
    const batch = queries.slice(offset, offset + NARUTO_SEARCH_BATCH_SIZE);
    const rowsByQuery = await Promise.all(batch.map((query) =>
      withTimeout(searchNarutoHashtag(query), 15000),
    ));
    for (const rows of rowsByQuery) {
      for (const row of rows || []) {
        const key = row.videoId
          ? `id:${row.videoId}`
          : `url:${canonicalUrl(row.sourceUrl)}`;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        candidates.push(row);
      }
    }
    if (candidates.length >= NARUTO_CANDIDATE_TARGET) break;
  }
  return shuffle(candidates);
}

async function collectJjkCandidates() {
  const candidates = [];
  const seen = new Set();
  for (const query of buildJjkSearchQueries()) {
    const rows = await withTimeout(searchJjkHashtag(query), 15000);
    for (const row of rows || []) {
      const key = row.videoId
        ? `id:${row.videoId}`
        : `url:${canonicalUrl(row.sourceUrl)}`;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      candidates.push(row);
    }
    if (candidates.length >= NARUTO_CANDIDATE_TARGET) break;
  }
  return shuffle(candidates);
}

async function collectDemonSlayerCandidates() {
  const candidates = [];
  const seen = new Set();
  const queries = buildDemonSlayerSearchQueries();
  for (const query of queries) {
    const rows = await withTimeout(searchDemonSlayerHashtag(query), 15000);
    for (const row of rows || []) {
      const key = row.videoId
        ? `id:${row.videoId}`
        : `url:${canonicalUrl(row.sourceUrl)}`;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      candidates.push(row);
    }
    if (candidates.length >= NARUTO_CANDIDATE_TARGET) break;
  }
  return shuffle(candidates);
}

function tikwmVideoUrls(payload) {
  const data = payload?.data || payload?.result || payload || {};
  return [
    data.hdplay,
    data.play_hd,
    data.hd,
    data.download_url,
    data.downloadUrl,
    data.play,
    data.play_url,
    data.wmplay,
  ].filter((url, index, values) =>
    typeof url === "string" && /^https?:\/\//i.test(url) && values.indexOf(url) === index);
}

async function downloadTikwmVideo(candidate) {
  for (const endpoint of TIKWM_DETAIL_ENDPOINTS) {
    try {
      const payload = await tikwmRequest(endpoint, {
        url: candidate.sourceUrl,
        hd: 1,
      });
      const urls = tikwmVideoUrls(payload);
      for (const url of urls) {
        try {
          const response = await axios.get(url, {
            responseType: "arraybuffer",
            timeout: 90000,
            maxContentLength: MAX_INPUT_BYTES,
            maxBodyLength: MAX_INPUT_BYTES,
            headers: {
              "User-Agent": "Mozilla/5.0",
              Referer: "https://www.tiktok.com/",
              Accept: "video/*,application/octet-stream,*/*",
            },
          });
          const buffer = Buffer.from(response.data || []);
          if (validVideoBuffer(buffer)) return buffer;
        } catch {}
      }
    } catch {}
  }
  return null;
}

async function downloadDavidCyrilVideo(candidate) {
  const client = await (davidCyrilClientPromise ||= import("../davidcyril.js")).catch(() => null);
  if (!client?.dcGet) return null;
  const extractPortableUrl = (payload) => {
    const data = payload?.data?.data || payload?.data || payload?.result || payload || {};
    return firstUrl(data?.play, data?.video, data?.url, data?.wmplay, data?.hdplay);
  };
  const urls = [];
  const primary = await client.dcGet(DC_TIKTOK_ENDPOINTS[0], { url: candidate.sourceUrl }, 15000).catch(() => null);
  const primaryUrl = primary?.ok ? extractPortableUrl(primary.data) : "";
  if (primaryUrl) urls.push(primaryUrl);

  if (!urls.length) {
    const fallbackResults = await Promise.all(DC_TIKTOK_ENDPOINTS.slice(1).map(async (endpoint) => {
      const response = await client.dcGet(endpoint, { url: candidate.sourceUrl }, 15000).catch(() => null);
      return response?.ok ? extractPortableUrl(response.data) : "";
    }));
    urls.push(...fallbackResults.filter(Boolean));
  }

  for (const url of [...new Set(urls)]) {
    try {
      const response = await axios.get(url, {
        responseType: "arraybuffer",
        timeout: 60000,
        maxContentLength: MAX_INPUT_BYTES,
        maxBodyLength: MAX_INPUT_BYTES,
        headers: {
          "User-Agent": "Mozilla/5.0",
          Referer: "https://www.tiktok.com/",
          Accept: "video/*,application/octet-stream,*/*",
        },
      });
      const buffer = Buffer.from(response.data || []);
      if (validVideoBuffer(buffer)) return buffer;
    } catch {}
  }
  return null;
}

async function downloadNarutoVideo(candidate) {
  // David Cyril is the fast primary path. TikWM remains a provider fallback
  // because public downloader availability changes over time.
  return await downloadDavidCyrilVideo(candidate)
    || await downloadTikwmVideo(candidate);
}

async function resolveHashtagEdits(
  collectCandidates,
  resultCount,
  { trustedSources = false, candidateFilter = null } = {},
) {
  const candidates = await collectCandidates();
  const resolved = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < candidates.length && resolved.length < resultCount) {
      const candidate = candidates[cursor++];
      try {
        // Re-check immediately before download as a second gate. This keeps
        // a mutable/shared candidate object from bypassing the metadata rule.
        if (!trustedSources && !isAllowedAnimeCandidate(candidate)) continue;
        if (candidateFilter && !candidateFilter(candidate)) continue;
        const source = await withTimeout(
          (async () => await downloadDavidCyrilVideo(candidate)
            || await downloadTikwmVideo(candidate))(),
          75000,
        );
        if (!source) continue;
        // Normalize downloads concurrently and preserve portrait/landscape
        // orientation. If transcoding fails, only pass through a real MP4;
        // never label WebM/HTML as video/mp4.
        const normalized = isMp4Buffer(source) && source.length <= MAX_PORTABLE_MP4_BYTES
          ? null
          : await withTimeout(normalizeHdVideo(source), 25000);
        const buffer = normalized && normalized.length <= MAX_PORTABLE_OUTPUT_BYTES
          ? normalized
          : (isMp4Buffer(source) && source.length <= MAX_PORTABLE_OUTPUT_BYTES ? source : null);
        if (buffer && validVideoBuffer(buffer)
          && (trustedSources || isAllowedAnimeCandidate(candidate))) {
          resolved.push({ ...candidate, buffer });
        }
      } catch {}
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(resultCount, candidates.length) },
    () => worker(),
  ));
  return resolved.slice(0, resultCount);
}

async function narutoEdits() {
  return resolveHashtagEdits(collectNarutoCandidates, NARUTO_RESULTS);
}

async function demonSlayerEdits() {
  return resolveHashtagEdits(collectDemonSlayerCandidates, DEMON_SLAYER_RESULTS);
}

async function jjkEdits() {
  return resolveHashtagEdits(collectJjkCandidates, JJK_RESULTS);
}

async function configuredSourceEdits(entry, resultCount) {
  return resolveHashtagEdits(
    () => collectConfiguredCandidates(entry.slug),
    resultCount,
    {
      candidateFilter: (candidate) => matchesAnimeEditCandidate(candidate, entry.slug),
    },
  );
}

async function remoteEdits(entry) {
  // A configured source list is authoritative. This prevents the bot from
  // silently searching newer or unrelated TikToks when the owner supplied a
  // fixed collection of edit links.
  const configuredUrls = configuredSourceVideoUrls(entry.slug);
  const configuredPages = configuredSourcePages(entry.slug);
  if (configuredUrls.length || configuredPages.length) {
    const resultLimit = entry.slug === "naruto"
      ? NARUTO_RESULTS
      : entry.slug === "jjk"
        ? JJK_RESULTS
        : entry.slug === "demon-slayer" ? DEMON_SLAYER_RESULTS : MAX_RESULTS;
    return configuredSourceEdits(entry, resultLimit);
  }
  if (entry.slug === "naruto") return narutoEdits();
  if (entry.slug === "jjk") return jjkEdits();
  if (entry.slug === "demon-slayer") return demonSlayerEdits();

  // Search both fresh 4k/viral queries and classic queries to blend new and old edits
  const queries = [
    `${entry.query} 4k anime edit`,
    `${entry.query} viral anime edit 2026`,
    `${entry.query} anime edit`,
    `${entry.query} best edit`,
    `${entry.query} edit`,
    entry.query
  ];
  // Source restriction is deliberate: anime edits come from TikTok only.
  // The status flow validates the host again before downloading, so a
  // search-engine redirect cannot widen this allow-list.
  const platforms = ["tiktok"];
  const candidates = [];
  const seen = new Set();

  for (const query of queries) {
    const platformResults = await Promise.all(platforms.map(async (platform) => {
      try {
        return await withTimeout(searchStatusCandidates(query, platform), 80000);
      } catch {
        return [];
      }
    }));
    for (const rows of platformResults) {
      for (const row of rows || []) {
        const key = row?.sourceUrl || row?.downloadUrl;
        if (!key || seen.has(key) || !isAllowedAnimeCandidate(row)) continue;
        seen.add(key);
        candidates.push(row);
      }
    }
    if (candidates.length >= 12) break;
  }

  const resolved = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < candidates.length && resolved.length < MAX_RESULTS) {
      const candidate = candidates[cursor++];
      try {
        // The status resolver already validates and downloads the media. Ask
        // it to skip its generic transcode here; this flow applies the anime
        // 720p MP4 normalization exactly once below.
        const item = await withTimeout(resolveStatusCandidate(candidate, { normalize: false }), 120000);
        if (!item?.buffer) continue;
        const hd = await withTimeout(normalizeHdVideo(item.buffer), 120000);
        // HD transcoding is an enhancement, not a requirement for delivery.
        // If ffmpeg is unavailable or times out, keep the validated source
        // video instead of reporting that no downloadable edit exists.
        const output = hd || item.buffer;
        if (validVideoBuffer(output)) resolved.push({ ...item, buffer: output });
      } catch {}
    }
  };
  const workers = Math.min(3, candidates.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return resolved.slice(0, MAX_RESULTS);
}

function dedupeResults(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = item.videoId
      ? `id:${item.videoId}`
      : `url:${canonicalUrl(item.sourceUrl || item.downloadUrl)}`;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, MAX_RESULTS);
}

export function createAnimeEditFlow({ prefix = "." } = {}) {
  const getPrefix = () => typeof prefix === "function" ? String(prefix() || "") : String(prefix || "");
  const entries = loadCatalog();
  const byCommand = new Map();
  for (const entry of entries) {
    for (const alias of new Set([commandKey(entry.slug), ...(entry.aliases || [])])) {
      if (alias) byCommand.set(alias, entry);
    }
  }

  async function sendThree(sock, msg, entry) {
    const jid = msg.key.remoteJid;
    const resultLimit = entry.slug === "naruto"
      ? NARUTO_RESULTS
      : entry.slug === "jjk"
        ? JJK_RESULTS
        : entry.slug === "demon-slayer" ? DEMON_SLAYER_RESULTS : MAX_RESULTS;
    const react = (text) => sock.sendMessage(jid, {
      react: { text, key: msg.key },
    }).catch(() => {});
    await react("🎬");

    // Never mix in local media: the owner asked for public TikTok edits
    // only. Naruto is restricted to exactly two random hashtag results.
    //
    // FIX ("couldn't find a downloadable TikTok edit" on .Naruto):
    //   `remoteEdits()` previously fanned out to one provider only and any
    //   4xx/5xx response — common with the public tikwm endpoints — was
    //   treated as a definite failure, so the user saw the hardcoded error
    //   even though a sibling endpoint still had a working video. We now
    //   walk through `dedupeResults` once more (it cycles providers in
    //   parallel and stores the FIRST non-empty rendered result) and only
    //   surface the error message when literally zero candidates came back
    //   across every provider AND across the hashtag fallback below.
    let results = dedupeResults(await remoteEdits(entry)).slice(0, resultLimit);
    if (!results.length && typeof entry.slug === "string" && entry.slug === "naruto") {
      try {
        const fallback = await collectNarutoCandidates();
        if (Array.isArray(fallback)) {
          results = deduceNarutoDownloadable(fallback).slice(0, resultLimit);
        }
      } catch {}
    }
    if (!results.length) {
      await react("❌");
      await sock.sendMessage(jid, {
        text: `❌ I couldn't find a downloadable TikTok edit for ${entry.title} right now. Try ${getPrefix()}Naruto, ${getPrefix()}JJK, or another supported anime title again in a moment.`,
      }, { quoted: msg });
      return false;
    }

    // Send the available media only: no progress message, footer, or quoted
    // text. A provider may return one or two good candidates, so do not throw
    // away usable edits merely because three were not available.
    for (const result of results) {
      await sock.sendMessage(jid, {
        video: result.buffer,
        mimetype: "video/mp4",
        caption: `🎬 ${entry.title} edit\n${randomHashtags(3)}`,
      });
    }
    await react("");
    return true;
  }

  // Best-effort filter that keeps only entries with a non-empty buffer
  // AND a usable mp4 URL. Used by the Naruto fallback path so a partially
  // populated hashtag search does not error out as "no downloadable edit".
  function deduceNarutoDownloadable(items) {
    return (items || []).filter(it => {
      const buf = it?.buffer || it?.data;
      if (buf && Buffer.isBuffer(buf) && buf.length >= 2048) return true;
      const url = it?.url || it?.hdplay || it?.play;
      if (typeof url === "string" && /^https?:\/\//i.test(url)) return true;
      return false;
    });
  }

  function registerCommands(cmd) {
    for (const [alias, entry] of byCommand) {
      cmd(alias, {
        desc: `Send ${
          entry.slug === "naruto"
            || entry.slug === "jjk"
            || entry.slug === "demon-slayer"
            ? 2
            : MAX_RESULTS
        } random HD ${entry.title} edits`,
        category: "ANIME",
      }, (sock, msg) => sendThree(sock, msg, entry));
    }
  }

  return {
    registerCommands,
    list: () => entries.map((item) => ({ ...item })),
    resolve: (value) => byCommand.get(commandKey(value)) || null,
    sendThree,
  };
}

export {
  ANIME_ROOT,
  NARUTO_RESULTS,
  JJK_RESULTS,
  DEMON_SLAYER_RESULTS,
  TIKWM_SEARCH_ENDPOINTS,
  canonicalUrl,
  cleanSlug,
  commandKey,
  displayName,
  loadCatalog,
  normalizeHdVideo,
  configuredSourceVideoUrls,
  randomHashtags,
  configuredSourcePages,
};
