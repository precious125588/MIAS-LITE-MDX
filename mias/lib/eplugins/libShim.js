/**
 * The `require('../lib/')` surface that Levanter plugins use, ported from
 * Levanter's readable and decoded lib code (utils.js, lib/index.js, plugins/plugins.js).
 * Copyright (c) lyfe00011, MIT License (see LICENSE-LEVANTER.txt).
 *
 * Helpers marked "exact" are ported from Levanter's source. The others follow
 * the same behaviour for standard WhatsApp JIDs. Any Levanter helper MIAS does
 * not provide yet throws a clear error when a plugin calls it, instead of
 * failing silently.
 */
import { readFileSync } from "node:fs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import moment from "moment-timezone";
import { CronTime } from "cron";
import { fileURLToPath } from "node:url";
import { normalizeBotOptions } from "./dispatchRules.js";
import { getFfmpegBuffer, audioCut, videoHeightWidth } from "./ffmpegMedia.js";
import { createLevanterMedia } from "./levanterMedia.js";
import { yts as ytsSearch, song as songDownload } from "./youtubeEngine.js";
import { createWordChecker } from "./wcgDictionary.js";

export const LANG = JSON.parse(
  fs.readFileSync(fileURLToPath(new URL("./levanter-en.json", import.meta.url)), "utf8"),
);

/** Levanter defines String.prototype.format for its lang strings ({0}, {1}, ...). */
export function installStringFormat() {
  if (typeof String.prototype.format === "function") return;
  Object.defineProperty(String.prototype, "format", {
    value: function format(...args) {
      return this.replace(/\{(\d+)\}/g, (match, i) => (args[i] !== undefined ? args[i] : match));
    },
    writable: true,
    configurable: true,
    enumerable: false,
  });
}

// exact: utils.js parseGistUrls. Returns the raw URL of each gist (or false).
const GIST_RE = /https:\/\/gist.(githubusercontent|github).com\/([-_.0-9A-Za-z]{0,37})\/([-_0-9A-Za-z]{32})/gm;
export function parseGistUrls(text) {
  const found = String(text ?? "").match(GIST_RE);
  return !!found && found.filter((url) => !url.includes("mask-sir")).map((url) => `${url}/raw`);
}

// exact: utils.js pluginsList. Command names from the `pattern:` lines of a plugin.
export function pluginsList(source) {
  return (String(source ?? "").match(/pattern: ["'](.*)["'],/gm) || []).map((line) =>
    line.match(/["'](.*)["'],/gm)[0].split(" ")[0].replace(/'|"/g, ""),
  );
}

// exact: utils.js. The bot's URL matcher (isUrl returns the matched text or false).
const URL_RE = /((http|https):\/\/)?(www\.)?([a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+)(\/[-a-zA-Z0-9@:%_\+.~#?&//=]*)?/;
export function isUrl(text = "null") {
  if (typeof text !== "string") return false;
  const m = text.match(URL_RE);
  return !!m && m[0];
}

// exact: utils.js parsedJid.
export function parsedJid(text) {
  return String(text ?? "").match(/[0-9]+(-[0-9]+|)(@g.us|@s.whatsapp.net|@lid|@newsletter)/g) || [];
}

// exact: utils.js escapeRegExp.
export function escapeRegExp(text) {
  return String(text ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// exact: utils.js getFloor.
export function getFloor(value) {
  return Math.floor(value);
}

// exact: utils.js addSpace.
export function addSpace(value, text) {
  return " ".repeat(("" + text).length - ("" + value).length);
}

// exact: lib/index.js sleep (milliseconds).
export function sleep(ms = 1) {
  return new Promise((resolve) => setTimeout(resolve, Number(ms) || 0));
}

// exact: utils.js secondsToHms, with Levanter's English time labels.
export function secondsToHms(value, lang = LANG) {
  const t = lang.plugins.common;
  const V = Number(value);
  const days = Math.floor(V / 86400);
  const hours = Math.floor((V % 86400) / 3600);
  const minutes = Math.floor((V % 3600) / 60);
  const seconds = Math.floor(V % 60);
  return (
    (days > 0 ? days + (days === 1 ? t.time_day : t.time_days) : "") +
    (hours > 0 ? hours + (hours === 1 ? t.time_hour : t.time_hours) : "") +
    (minutes > 0 ? minutes + (minutes === 1 ? t.time_minute : t.time_minutes) : "") +
    (seconds && !days > 0 ? seconds + (seconds === 1 ? t.time_second : t.time_seconds) : "")
  ).trim();
}

// utils.js formatTime: "hh:mm a D-M-YYYY". `isMs` true means `value` is milliseconds.
export function formatTime(value, isMs) {
  const d = isMs ? new Date(Number(value)) : new Date(Number(value) * 1000);
  const hour12 = d.getHours() % 12 || 12;
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(hour12)}:${pad(d.getMinutes())} ${d.getHours() < 12 ? "am" : "pm"} ${d.getDate()}-${d.getMonth() + 1}-${d.getFullYear()}`;
}

export const jidToNum = (jid) => String(jid ?? "").split("@")[0].split(":")[0];
export const numToJid = (num) => `${String(num ?? "").replace(/\D/g, "")}@s.whatsapp.net`;
export const isGroup = (jid) => String(jid ?? "").endsWith("@g.us");
export const isUser = (jid) => String(jid ?? "").endsWith("@s.whatsapp.net");

/** Exact in behaviour: finds the member, then reads its admin role. */
export function isAdmin(participants, jid, lang = LANG) {
  const list = Array.isArray(participants) ? participants : [];
  let user = list.find((p) => p.phoneNumber === jid || p.id === jid);
  if (!user) {
    const want = jidToNum(jid);
    user = list.find((p) => [p.id, p.phoneNumber, p.lid].filter(Boolean).some((x) => jidToNum(x) === want));
  }
  if (!user) {
    throw new Error(lang.plugins.common.group_not_found.format(jidToNum(jid), JSON.stringify(list.slice(0, 3))));
  }
  return user.admin === "admin" || user.admin === "superadmin";
}

// exact: utils.js rmComma. Drops empty items from a comma list.
export function rmComma(text) {
  return String(text).split(",").filter((x) => x !== "").join(",");
}

// exact: lib/index.js filteredArray. Unique items, split on `sep` when given a string.
export function filteredArray(list, sep = ",") {
  if (!Array.isArray(list)) list = String(list).split(sep);
  return Array.from(new Set(list));
}

// exact: lib/index.js parseNum. Every run of digits, ignoring "+" and spaces.
export function parseNum(text = "") {
  if (!text) return [];
  const digits = String(text).replace(/[+\s]+/g, "").match(/\d+/g);
  return digits || [];
}

// exact: lib/index.js sortObject. Same keys, sorted alphabetically.
export function sortObject(obj) {
  const out = {};
  Object.keys(obj).sort().forEach((key) => {
    out[key] = obj[key];
  });
  return out;
}

// exact: lib/index.js getRandom. A random item from an array.
export function getRandom(list) {
  return list[getFloor(Math.random() * list.length)];
}

// exact: lib/index.js getRam. "free/total MB".
export const getRam = () =>
  Math.floor(os.freemem() / 1048576) + "/" + Math.floor(os.totalmem() / 1048576) + "MB";

// exact: lib/index.js formatDate. DD/MM/YYYY in the bot's timezone.
export function formatDate(date) {
  const tz = process.env.TIMEZONE || process.env.TZ || "UTC";
  return moment.tz(date, tz).format("DD/MM/YYYY");
}

// exact: lib/index.js isValidDate. Accepts e.g. "5 March 2026".
export function isValidDate(text) {
  return moment(text, "D MMMM YYYY").isValid();
}

// exact: lib/index.js c24to12. "14:05" becomes "2:05 PM"; other text is returned as is.
export function c24to12(value) {
  let parts = String(value).match(/^([01]\d|2[0-3])(:)([0-5]\d)(:[0-5]\d)?$/) || [value];
  if (parts.length > 1) {
    parts = parts.slice(1);
    parts[5] = +parts[0] < 12 ? " AM" : " PM";
    parts[0] = +parts[0] % 12 || 12;
  }
  return parts.join("");
}

// exact: lib/fetch.js nameFromUrl. The file name at the end of a URL.
export function nameFromUrl(url) {
  return path.basename(new URL(url).pathname);
}

// exact: lib/index.js fetch. node-fetch, loaded on first use.
export const fetch = (...args) => import("node-fetch").then((m) => m.default(...args));

// exact: lib/fancy.js. Font id (1-47) to the font style name used by the .fancy commands.
const FONT_TYPES = {
  "1": "bold",
  "2": "sans-italic",
  "3": "bold-italic",
  "4": "sans",
  "5": "boldSans",
  "6": "boldItalic",
  "7": "uu",
  "8": "gg",
  "9": "script",
  "10": "cursive",
  "11": "oldEnglish",
  "12": "medieval",
  "13": "doubleStruck",
  "14": "mono",
  "15": "cc",
  "16": "round",
  "17": "round-b",
  "18": "squares",
  "19": "invertedSquares",
  "20": "wideText",
  "21": "superscript",
  "22": "bb",
  "23": "subscript",
  "24": "small-caps",
  "25": "coptic",
  "26": "wavy",
  "27": "flag",
  "28": "bentText",
  "29": "china",
  "30": "cyrilic-to-latin",
  "31": "upside-down",
  "32": "futureAlien",
  "33": "xx",
  "34": "squiggle6",
  "35": "squiggle3",
  "36": "asianStyle",
  "37": "squiggle4",
  "38": "neon",
  "39": "currency",
  "40": "symbols",
  "41": "squiggle",
  "42": "upperAngles",
  "43": "taiViet",
  "44": "smallcaps",
  "45": "littleTiny",
  "46": "superTiny",
  "47": "tt",
};
export function fontType(id) {
  return FONT_TYPES[id];
}

// exact: lib/fonts.js. Font tables for the stylish-text commands, stored as data in fontTable.json.
// Copied from Levanter (MIT, Copyright (c) lyfe00011, see LICENSE-LEVANTER.txt). Levanter's module-level
// integrity wrapper (test/test.js iChecker, which checks its Dockerfile) is not carried over.
const FANCY_STYLES = JSON.parse(readFileSync(new URL("./fontTable.json", import.meta.url), "utf8"));
export const STYLISH_STYLES = Object.keys(FANCY_STYLES);

// exact: lib/utils.js textToStylist(text, style). Characters a style does not map are kept as they are.
export function textToStylist(text, style) {
  const table = Object.hasOwn(FANCY_STYLES, style) ? FANCY_STYLES[style] : undefined;
  if (!table) throw new Error(`Unknown font style "${style}". Available: ${STYLISH_STYLES.join(", ")}`);
  let out = "";
  for (const ch of String(text ?? "").split("")) {
    out += Object.hasOwn(table, ch) && table[ch] != null ? table[ch] : ch;
  }
  return out;
}

// exact: lib/utils.js stylishTextGen(text). One line per style: its number padded to the width of "53",
// a space, then the styled text, then a newline.
export function stylishTextGen(text) {
  let out = "";
  STYLISH_STYLES.forEach((style, i) => {
    const n = String(i + 1);
    out += `${n}${" ".repeat(String(53).length - n.length)} ${textToStylist(text, style)}\n`;
  });
  return out;
}

// exact: lib/index.js fB. Replaces each placeholder ("x" by default) with the digits 0-9 and
// calls cb for every complete string. Recurses while a placeholder is still left.
function expandPlaceholder(text, cb, placeholder) {
  const ch = placeholder || "x";
  const count = String(text).includes(ch) ? 10 : 1;
  const re = new RegExp(ch);
  for (let i = 0; i < count; i++) {
    const out = String(text).replace(ch, i);
    if (!re.test(out)) cb(out, i);
    if (re.test(out)) expandPlaceholder(out, cb, ch);
  }
}

// exact: lib/index.js getNumbers. Every unique number that a text with "x" placeholders can become.
export function getNumbers(text = "") {
  const found = [];
  expandPlaceholder(text, (value) => {
    if (!found.includes(value)) found.push(value);
  });
  return found;
}

// exact: lib/index.js YT_URL_REGEX. Captures the 11-character YouTube video id in group 1.
export const YT_URL_REGEX =
  /(?:http(?:s|):\/\/|)(?:(?:www\.|)youtube(?:\-nocookie|)\.com\/(?:watch\?.*(?:|\&)v=|embed|shorts\/|v\/)|youtu\.be\/)([-_0-9A-Za-z]{11})/;

// exact: lib/constant.js TEMP_DIR is "<bot root>/temp". MIAS's bot root is mias/.
export const TEMP_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../temp");

// exact: lib/index.js PLATFORM. Same environment checks as Levanter, read from process.env.
function platformName(env = process.env) {
  if (env.HEROKU_API_KEY && env.HEROKU_APP_NAME) return "heroku";
  if (env.KOYEB_API && env.KOYEB_NAME) return "koyeb";
  if (env.RENDER_NAME && env.RENDER_API_KEY) return "render";
  if (env.VPS) return "vps";
  return "unknown";
}

// exact: lib/index.js getPlatform. Example: "railway (Linux 6.8.0 ubuntu)".
export function getPlatform(env = process.env) {
  const match = os.release().match(/(\d+\.\d+\.\d+)-\d+-(\w+)/);
  return platformName(env) + " (" + os.type() + (match ? " " + match[2] : "") + ")";
}

// exact: utils.js trt. Translates text with translate-google-api, same tld and output as Levanter.
// The library loads on first use, so a bot that never translates does not load it.
let translateGoogleApi = null;
export async function trt(text, to, from, translate) {
  if (!translate) {
    if (!translateGoogleApi) {
      const { createRequire } = await import("node:module");
      translateGoogleApi = createRequire(import.meta.url)("translate-google-api");
    }
    translate = translateGoogleApi;
  }
  return (await translate(text, { tld: "co.in", to, from }))?.join();
}

// exact: utils.js clearFiles. Empties the mention media folder (MIAS root is mias/, Levanter's is its root).
export function clearFiles() {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../media/mention");
  fs.mkdirSync(dir, { recursive: true });
  for (const name of fs.readdirSync(dir)) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
}

// exact: lib/index.js parseSchedule. Splits "<jids> <time> <once|repeat>" from a schedule command.
export function parseSchedule(text) {
  const JID_RE = /[\w-]+@(s\.whatsapp\.net|g\.us)/g;
  const jids = text.match(JID_RE) || [];
  const rest = text.replace(JID_RE, "").trim().replace(/^,|,$/g, "").trim();
  const timeMatch = rest.match(/^([0-9*\/\- ,:]+)/);
  const time = timeMatch ? timeMatch[0].trim() : null;
  const tail = time ? rest.slice(rest.indexOf(time) + time.length)?.replace(/^[, ]+/, "").trim() : null;
  let once = "once";
  if (tail && (tail.includes("repeat") || tail.includes("every"))) once = "repeat";
  return { jids, time, once };
}

// exact: lib/index.js normalizeUrl (antilink.js). Lower-cases and strips scheme, www and a trailing slash.
export function normalizeUrl(input) {
  try {
    let url = input.trim().toLowerCase();
    url = url.replace(/^https?:\/\//, "");
    url = url.replace(/^ftp:\/\//, "");
    url = url.replace(/^www\./, "");
    if (!url.includes("?") && url.endsWith("/") && url.split("/").length === 2) url = url.slice(0, -1);
    return url;
  } catch {
    return input.trim().toLowerCase();
  }
}

// exact: lib/index.js getDate. Returns [Date, "hh:mm A", "DD/MM/YYYY"] in the bot's timezone.
// Levanter reads config TIMEZONE; MIAS reads the same TIMEZONE / TZ environment values.
export function getDate(env = process.env) {
  const zone = env.TIMEZONE || env.TZ || "UTC";
  const now = moment.tz(new Date(), zone);
  return [now.toDate(), now.format("hh:mm A"), now.format("DD/MM/YYYY")];
}

// exact: lib/index.js clearTempDir. Empties the temp folder and keeps the folder itself.
export async function clearTempDir(dir = TEMP_DIR) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    for (const name of fs.readdirSync(dir)) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  } catch (err) {
    console.error("Failed to clear temp directory: " + err.message);
  }
}

// exact: alive.js getUptime. With a truthy flag, "Xh Ym Zs" from the process uptime; otherwise secondsToHms.
export function getUptime(withFormat) {
  if (withFormat) {
    const total = Number(process.uptime());
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = Math.floor((total % 3600) % 60);
    return (0 == h ? "" : h + "h ") + (0 == m ? "" : m + "m ") + (0 == s ? "" : s + "s");
  }
  return secondsToHms(process.uptime());
}

// Levanter's quote endpoint (utils.js getQuote). Set MIAS_QUOTE_URL to use a different endpoint.
export const QUOTE_URL = process.env.MIAS_QUOTE_URL || "http://levanter.onrender.com/quote";

// exact: utils.js getQuote. Fetches the quote and returns its `content`, or "" on any failure
// (Levanter does `(await fetch(url).catch(() => {})).content || ""`).
export async function fetchQuote(getJson, url = QUOTE_URL) {
  try {
    const body = await getJson(url);
    return body?.content || "";
  } catch {
    return "";
  }
}

// exact: alive.js uptimeQuoteReplace. Replaces #uptime and #quote in a text.
export async function uptimeQuoteReplace(text, removePattern, getQuote) {
  let out = text;
  if (removePattern) out = out.replace(removePattern, "");
  out = out.replace("#uptime", getUptime()).trim();
  if (/#quote/.test(out)) {
    const quote = await getQuote();
    out = out.replace("#quote", quote || "");
  }
  return out;
}

// exact: mute.js validateTime. Turns "min hour day month weekday" (or dash-separated) into a
// six-field cron string whose seconds field is (5 * (sec ?? 1)) % 60. Returns false when cron rejects it.
export function validateTime(text, sec) {
  if (!text) return text;
  if (!text.length) return text;
  const parts = text.includes(" ") ? text.split(/\s+/).slice(0, 5) : text.split("-");
  const fields = ["*", "*", "*", "*", "*"].map((def, i) => {
    if (!parts[i]) return "*";
    const value = parts[i].trim();
    return /^[\d\*\/\-,]+$/.test(value) ? value : "*";
  });
  const cronText = [(5 * (sec ?? 1)) % 60, ...fields].join(" ");
  try {
    new CronTime(cronText);
    return cronText;
  } catch {
    return false;
  }
}

// exact: utils.js genListMessage. Builds a WhatsApp list message; each row's id is the bot prefix plus the id.
export function genListMessage(items, title, buttonText, sectionTitle = "", description = "\u200e", prefix = ".") {
  const rows = [];
  for (const { id, text, desc } of items) {
    rows.push({ title: text, rowId: "" + prefix + id, description: desc || "" });
  }
  const section = { title: sectionTitle, rows };
  return { title, buttonText, description, sections: [section], listType: 1 };
}

const UNAVAILABLE = (name) =>
  new Error(`lib.${name} is not available in MIAS yet. This plugin needs a Levanter helper that MIAS has not ported.`);

/**
 * The object a plugin receives from require('../lib/').
 * @param {object} ctx
 * @param {(opts, handler) => void} ctx.bot   collects bot() calls during a plugin load
 * @param {object} ctx.store                  the plugin table (setPlugin/getPlugin/delPlugin)
 * @param {object} ctx.manager                installPlugin / removePlugin
 * @param {Function} ctx.httpGet              axios-like client
 * @param {string} ctx.session                Levanter's session id for the plugin table
 */
// Levanter's wcg word list is read once per file and shared by every plugin compile.
const wordCheckers = new Map();
function sharedWordChecker(file, httpGet) {
  if (!wordCheckers.has(file)) {
    const checker = createWordChecker({ file, httpGet });
    checker.load().catch((e) => console.error("[eplugin] wcg dictionary:", e.message));
    wordCheckers.set(file, checker);
  }
  return wordCheckers.get(file);
}

export function createLibShim({ bot, store, manager, httpGet, session, findJid, settings, plugins, groupSubject, pushName, wcgFile }) {
  const media = createLevanterMedia({ tempDir: TEMP_DIR });
  const wordChecker = wcgFile ? sharedWordChecker(wcgFile, httpGet) : null;
  const api = {
    bot(opts, handler) {
      return bot(normalizeBotOptions(opts, handler));
    },
    lang: LANG,
    parseGistUrls,
    pluginsList,
    isUrl,
    parsedJid,
    escapeRegExp,
    getFloor,
    addSpace,
    sleep,
    secondsToHms,
    formatTime,
    jidToNum,
    numToJid,
    rmComma,
    filteredArray,
    parseNum,
    sortObject,
    getRandom,
    getRam,
    formatDate,
    isValidDate,
    c24to12,
    nameFromUrl,
    fetch,
    fontType,
    getNumbers,
    YT_URL_REGEX,
    TEMP_DIR,
    getPlatform,
    trt: (text, to, from) => trt(text, to, from),
    clearFiles,
    getUptime,
    QUOTE_URL,
    genListMessage,
    validateTime,
    // Levanter's getQuote fetches the quote from its hosted endpoint. A failure returns "" (see fetchQuote).
    getQuote() {
      return fetchQuote((url) => api.getJson(url, { timeout: 10000 }));
    },
    textToStylist,
    stylishTextGen,
    STYLISH_STYLES,
    uptimeQuoteReplace(text, removePattern) {
      return uptimeQuoteReplace(text, removePattern, () => api.getQuote());
    },
    parseSchedule,
    normalizeUrl,
    getDate,
    clearTempDir,
    // exact: fFmpeg.js helpers, writing to MIAS temp dir (TEMP_DIR).
    getFfmpegBuffer: (input, outName, preset) => getFfmpegBuffer(input, outName, preset, TEMP_DIR),
    audioCut: (input, start, duration, name) => audioCut(input, start, duration, name, TEMP_DIR),
    videoHeightWidth,
    // exact: Levanter's sticker, cropsticker, addExif, genThumbnail, textMaker, getImgUrl,
    // pinterestSearch, upscale, getTelegramStickers (see levanterMedia.js). Images and stickers
    // are written to MIAS temp dir (TEMP_DIR), as Levanter writes to its own.
    ...media,
    // exact: lib/utils.js yts (Innertube video search).
    yts: (query) => ytsSearch(query),
    // Levanter's song(videoId) resolves the MP3. The audio comes from public APIs (NexRay, Prexzy)
    // rather than Levanter's SABR stream; see youtubeEngine.js. Resolves { buffer, title, id, provider }.
    song: (videoId) => songDownload(videoId),
    // Levanter's getJid maps a @lid to a phone JID through the session's findJid.
    // MIAS passes that lookup in as ctx.findJid; without it the JID is returned unchanged.
    async getJid(jid, sess = session) {
      if (!jid || !sess || !String(jid).endsWith("@lid") || typeof findJid !== "function") return jid;
      return (await findJid(jid, sess)) || jid;
    },
    isGroup,
    isUser,
    isAdmin,
    async getJson(url, opts = {}) {
      const res = await httpGet(String(url), { timeout: 20000, ...opts });
      return res.data;
    },
    async getBuffer(url, opts = {}) {
      const res = await httpGet(String(url), { responseType: "arraybuffer", timeout: 20000, ...opts });
      return Buffer.from(res.data);
    },
    async forwardOrBroadCast(jid, message, opts) {
      const sock = message?.client;
      const raw = message?.data || message;
      if (!sock || typeof sock.copyNForward !== "function") throw new Error("forwardOrBroadCast: no socket available");
      return sock.copyNForward(jid, raw, false, opts);
    },
    // Levanter's logger (pino in Levanter). Writes to the bot log with the plugin tag.
    logger: {
      info: (...a) => console.log("[eplugin]", ...a),
      warn: (...a) => console.warn("[eplugin]", ...a),
      error: (...a) => console.error("[eplugin]", ...a),
      debug: () => {},
    },
    // Levanter's levanter.on(event, handler). Only "reaction.message" is produced by MIAS.
    levanter: { on: (event, handler) => api.bot({ on: String(event), fromMe: false }, handler) },
    // Names of the external plugins loaded now (Levanter's PLUGINS list).
    get PLUGINS() { return typeof plugins === "function" ? plugins() : []; },
    // Plugin settings (see settingsStore.js). Same names and argument order as Levanter.
    ...(settings ? {
      // Levanter lib/vars.js also writes each value to the process environment; plugins read their
      // settings from there (for example ANTIREACT in the anti-reaction plugin).
      setVar: (obj, sess = session) => {
        const out = settings.setVar(obj, sess);
        for (const [k, v] of Object.entries(out)) process.env[k] = v;
        return true;
      },
      getVars: (sess = session, raw = false) => settings.getVars(sess, raw),
      setData: (key, value, sess = session) => settings.setData(key, value, sess),
      getData: (key, sess = session) => settings.getData(key, sess),
      delData: (key, sess = session) => settings.delData(key, sess),
      setFilter: (type, pattern, text, isRegex, sess = session) => settings.setFilter(type, pattern, text, isRegex, sess),
      getFilter: (type, sess = session) => settings.getFilter(type, sess),
      deleteFilter: (type, pattern, sess = session) => settings.deleteFilter(type, pattern, sess),
      setAmenu: (jid, input, sess = session) => settings.setAmenu(jid, input, sess),
      getAmenu: (jid, sess = session) => settings.getAmenu(jid, sess),
      delAmenu: (jid, input, sess = session) => settings.delAmenu(jid, input, sess),
    } : {}),
    // Levanter lib/index.js getName(chat, sender): the group subject when only a group is given,
    // otherwise the sender's stored name.
    async getName(chat, sender) {
      if (!chat && !sender) return "";
      if (chat && !sender) return groupSubject ? groupSubject(chat) : "";
      return pushName ? pushName(sender) : "";
    },
    // Levanter's wcg.exist(word): true when the word is in the word list (see wcgDictionary.js).
    wcg: { exist: (word) => (wordChecker ? wordChecker.exist(word) : false) },
    // Levanter's lib/index.js exports getGids and getGroupMembers, but neither has an implementation
    // in its source, so both are undefined there too.
    getGids: undefined,
    getGroupMembers: undefined,
    // Plugin table, same names and argument order as Levanter.
    setPlugin: (name, url, sess = session, source) => store.setPlugin(name, url, sess, source ?? manager.sourceOf(name, sess)),
    getPlugin: (sess = session, name) => store.getPlugin(sess, name),
    delPlugin: (name, sess = session) => store.delPlugin(name, sess),
    installPlugin: (filePath, sess = session) => manager.installPlugin(filePath, sess),
    removePlugin: (name, sess = session) => manager.removePlugin(name, sess),
    // MIAS: a second gist whose plugin name is taken gets the next free name (play1, play2, ...).
    uniquePluginName: (base, url, sess = session) => manager.uniquePluginName(base, url, sess),
  };
  return new Proxy(api, {
    get(target, key) {
      if (key in target) return target[key];
      if (typeof key === "symbol" || String(key).startsWith("__") || key === "then") return undefined;
      return () => {
        throw UNAVAILABLE(String(key));
      };
    },
  });
}
