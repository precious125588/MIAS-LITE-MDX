/**
 * Levanter's media helpers for external plugins:
 *   sticker, cropsticker, addExif   (lib/fFmpeg.js)
 *   genThumbnail                    (lib/constant.js)
 *   textMaker                       (lib/textmaker.js)
 *   getImgUrl                       (lib/misc.js)
 *   pinterestSearch                 (lib/ss/pinterest.js)
 *   upscale, getTelegramStickers    (lib/index.js)
 *   getUrl (catbox upload)          (lib/utils.js)
 *
 * Copyright (c) lyfe00011, MIT License (see LICENSE-LEVANTER.txt).
 *
 * Ported from Levanter's decoded source. Option lists, URLs, form field names, EXIF layout and
 * the sticker pack id are copied as-is. Two deliberate differences, both noted where they apply:
 *   - Levanter reads the sticker pack name from a per-session config; MIAS has one bot, so the
 *     session argument is accepted for parity and the STICKER_PACKNAME env value is used.
 *   - Network calls go through an injectable `http` client (axios by default) so they can be tested.
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ffmpeg = require("fluent-ffmpeg");
const sharp = require("sharp");
const webpmux = require("node-webpmux");
const cookie = require("cookie");
const cheerio = require("cheerio");
const FormData = require("form-data");
const defaultHttp = require("axios");

// The same preset table as ffmpegMedia.js (Levanter's fFmpeg.js b8 object, copied verbatim).
const PRESETS = JSON.parse(
  fs.readFileSync(fileURLToPath(new URL("./ffmpegPresets.json", import.meta.url)), "utf8"),
);
const DEFAULT_TEMP_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../temp");

// exact: fFmpeg.js b6 (addExif) constants.
const STICKER_PACK_ID = "a855bd1fa49c0a05940f8ec2f47dca0b64bbd801e3b2d29e1f654574d4b294c5";
const EXIF_HEADER = Buffer.from([73, 73, 42, 0, 8, 0, 0, 0, 1, 0, 65, 87, 7, 0, 0, 0, 0, 0, 22, 0, 0, 0]);
const DEFAULT_EMOJI = "🥰";
// Levanter's config.js default for STICKER_PACKNAME.
const DEFAULT_PACK_NAME = "❤️,LyFE";

// exact: textmaker.js and misc.js user agents.
const GOOGLE_BOT = "GoogleBot";
const PINTEREST_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36";

// exact: lang/en.json plugins.common.upscale_* messages.
const UPSCALE_FAILED = "Failed to upscale image. Please try again later.";
const UPSCALE_UPLOAD_FAILED = "Failed to upload image";
// MIAS: the public upscaler (NexRay), overridable like the other NexRay calls.
const NEXRAY_API = () => String(process.env.NEXRAY_API || "https://api.nexray.eu.cc").replace(/\/$/, "");

// The error every upscale failure reports, with the step that failed in `reason`.
function upscaleFailure(reason) {
  const error = new Error(UPSCALE_FAILED);
  error.reason = reason;
  return error;
}

// JPEG, PNG or WebP by its first bytes.
function looksLikeImage(buf) {
  if (!buf || buf.length < 12) return false;
  const jpeg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const png = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  const webp = buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP";
  return jpeg || png || webp;
}

function removeFile(file) {
  // exact: fFmpeg.js b5. Deletes a temp file unless it is a mention file. Errors are ignored.
  if (typeof file !== "string" || !file || file.includes("mention")) return;
  try {
    fs.unlinkSync(file);
  } catch {
    // Already gone.
  }
}

/** Builds the Levanter media helpers. `http` needs get/post in axios' shape. */
export function createLevanterMedia({ tempDir = DEFAULT_TEMP_DIR, http = defaultHttp, env = process.env } = {}) {
  const tempPath = (name) => {
    fs.mkdirSync(tempDir, { recursive: true });
    return path.join(tempDir, name);
  };

  // exact: fFmpeg.js b6 (addExif). `packName` may be "name,publisher,emojis" as in Levanter.
  async function addExif(input, packName, session = "0", publisher, emojis = [DEFAULT_EMOJI], extra = {}) {
    const configured = env.STICKER_PACKNAME || DEFAULT_PACK_NAME;
    const [envName, envPublisher] = configured === "false" ? [] : configured.split(",");
    let name = envName;
    let pub = publisher || envPublisher;
    let emo = Array.isArray(emojis) ? emojis : [emojis];
    if (packName) {
      const [n, o, p] = String(packName).split(",");
      name = n;
      pub = o;
      emo = p;
    }
    const json = Buffer.from(
      JSON.stringify({
        "sticker-pack-id": STICKER_PACK_ID,
        "sticker-pack-name": name,
        "sticker-pack-publisher": pub,
        emojis: emo,
        ...extra,
      }),
      "utf8",
    );
    const exif = Buffer.concat([EXIF_HEADER, json]);
    exif.writeUIntLE(json.length, 14, 4);
    const img = new webpmux.Image();
    await img.load(input);
    img.exif = exif;
    return await img.save(null);
  }

  // exact: fFmpeg.js sticker(). `animation` 2 and 3 pick the animated presets. The 4th argument
  // (session) is accepted for parity; see the header note.
  function sticker(name, input, animation = 1, session = "0", emoji = DEFAULT_EMOJI) {
    return new Promise((resolve, reject) => {
      let preset = PRESETS.nonanimated;
      if (animation == 2) preset = PRESETS.animated2;
      if (animation == 3) preset = PRESETS.animated1;
      const out = tempPath(`${name}.webp`);
      ffmpeg(input)
        .addOutputOptions(preset)
        .save(out)
        .on("error", (error) => reject(error.message))
        .on("end", async () => {
          try {
            const buffer = await addExif(fs.readFileSync(out), undefined, session, undefined, [emoji]);
            removeFile(input);
            removeFile(out);
            resolve(buffer);
          } catch (error) {
            removeFile(input);
            removeFile(out);
            reject(error);
          }
        });
    });
  }

  // exact: fFmpeg.js cropsticker(). Crops to a square first, then writes the sticker EXIF.
  function cropsticker(name, input, animation = 1, session = "0", emoji = DEFAULT_EMOJI) {
    return new Promise((resolve, reject) => {
      let preset = PRESETS.newnonanimated;
      if (animation == 2) preset = PRESETS.newanimated1;
      if (animation == 3) preset = PRESETS.newanimated2;
      const out = tempPath(`${name}c.webp`);
      ffmpeg(input)
        .outputOptions(preset)
        .save(out)
        .on("error", (error) => reject(new Error(error.message)))
        .on("end", async () => {
          try {
            const buffer = await addExif(out, undefined, session, undefined, [emoji]);
            removeFile(input);
            removeFile(out);
            resolve(buffer);
          } catch (error) {
            removeFile(input);
            removeFile(out);
            reject(new Error(error.message));
          }
        });
    });
  }

  // exact: constant.js genThumbnail. Resizes inside a square and returns base64 JPEG.
  async function genThumbnail(input, size = 64, quality = 64) {
    const buffer = await sharp(input).resize(size, size, { fit: "inside" }).jpeg({ quality }).toBuffer();
    return buffer.toString("base64");
  }

  const cookieHeaderFrom = (setCookie) => {
    const jar = {};
    for (const c of [].concat(setCookie || [])) Object.assign(jar, cookie.parse(String(c)));
    // exact: textmaker.js keeps only __cfduid and PHPSESSID.
    return Object.entries({ __cfduid: jar.__cfduid, PHPSESSID: jar.PHPSESSID })
      .map(([k, v]) => cookie.serialize(k, v))
      .join("; ");
  };

  // exact: textmaker.js textMaker(url, text, extra). Returns { status, url }.
  async function textMaker(url, text, extra = "") {
    const base = `https://${new URL(url).host}/`;
    const first = await http.get(url, { headers: { "User-Agent": GOOGLE_BOT }, responseType: "text", transformResponse: [(d) => d] });
    const cookies = cookieHeaderFrom(first.headers["set-cookie"]);
    const page = cheerio.load(String(first.data));
    const token = page('input[name="token"]').attr("value");
    const buildServer = page('input[name="build_server"]').attr("value");
    const buildServerId = page('input[name="build_server_id"]').attr("value");

    const form = new FormData();
    String(text).split(";").forEach((line) => form.append("text[]", line.trim()));
    form.append("submit", "Go");
    if (extra) form.append("radio0[radio]", extra);
    form.append("token", token);
    form.append("build_server", buildServer);
    form.append("build_server_id", buildServerId);
    const second = await http.post(url, form.getBuffer(), {
      headers: {
        Accept: "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "User-Agent": GOOGLE_BOT,
        Cookie: cookies,
        ...form.getHeaders(),
      },
      responseType: "text",
      transformResponse: [(d) => d],
    });
    const result = cheerio.load(String(second.data));
    const raw = base === "https://en.ephoto360.com/"
      ? result('input[name="form_value_input"]').attr("value")
      : result("#form_value").first().text();
    if (!raw) return { status: false };

    const data = JSON.parse(raw);
    const create = new FormData();
    create.append("id", data.id);
    data.text.forEach((line) => create.append("text[]", line));
    create.append("token", data.token);
    create.append("build_server", data.build_server);
    create.append("build_server_id", data.build_server_id);
    if (Object.prototype.hasOwnProperty.call(data, "radio0")) create.append("radio0[radio]", data.radio0.radio);
    const made = await http.post(`${base}effect/create-image`, create.getBuffer(), {
      headers: {
        Accept: "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "User-Agent": GOOGLE_BOT,
        Cookie: cookies,
        ...create.getHeaders(),
      },
    });
    const body = typeof made.data === "string" ? JSON.parse(made.data) : made.data;
    if (!body.image) throw new Error("textmaker: failed image processing");
    return { status: body.success, url: `${buildServer}${body.image}` };
  }

  // exact: misc.js getImgUrl(url). Reads the first Google Images result from the page.
  async function getImgUrl(url) {
    const res = await http.get(url, { responseType: "text", transformResponse: [(d) => d], validateStatus: () => true });
    if (res.status < 200 || res.status > 299) {
      throw new Error(`Failed to fetch data: ${res.statusText || res.status}`);
    }
    return cheerio.load(String(res.data))("#il_fi").attr("src");
  }

  // exact: utils.js getUrl (catbox branch, the default). Uploads a file, returns its URL.
  async function uploadToCatbox(file) {
    const form = new FormData();
    form.append("reqtype", "fileupload");
    form.append("fileToUpload", fs.createReadStream(file));
    const res = await http.post("https://catbox.moe/user/api.php", form, { headers: form.getHeaders(), responseType: "text", transformResponse: [(d) => d] });
    return String(res.data).trim();
  }

  // MIAS: Levanter's upscale() sent the file to catbox and asked api.nekolabs.web.id, which no longer
  // resolves, and catbox now refuses scripted uploads. The file goes to the first upload host that
  // accepts it, and NexRay's remini enhances it. Any failure still gives Levanter's message, and the
  // step that failed is attached as the reason (MIAS error reports show it).
  async function uploadToUguu(file) {
    const form = new FormData();
    form.append("files[]", fs.createReadStream(file));
    const res = await http.post("https://uguu.se/upload.php", form, { headers: form.getHeaders() });
    const body = typeof res.data === "string" ? JSON.parse(res.data) : res.data;
    const url = body?.files?.[0]?.url;
    if (!url) throw new Error("no link in the reply");
    return String(url).replace(/\\\//g, "/");
  }

  async function uploadToTmpfiles(file) {
    const form = new FormData();
    form.append("file", fs.createReadStream(file));
    const res = await http.post("https://tmpfiles.org/api/v1/upload", form, { headers: form.getHeaders() });
    const body = typeof res.data === "string" ? JSON.parse(res.data) : res.data;
    const url = body?.data?.url;
    if (!url) throw new Error("no link in the reply");
    return String(url).replace("https://tmpfiles.org/", "https://tmpfiles.org/dl/");
  }

  async function uploadToCatboxChecked(file) {
    const url = await uploadToCatbox(file);
    if (!/^https?:\/\//.test(url)) throw new Error(url || "no link in the reply");
    return url;
  }

  const UPLOAD_STEPS = [["uguu", uploadToUguu], ["tmpfiles", uploadToTmpfiles], ["catbox", uploadToCatboxChecked]];

  async function upscale(file) {
    const problems = [];
    let imageUrl = "";
    for (const [name, send] of UPLOAD_STEPS) {
      try {
        imageUrl = await send(file);
        if (imageUrl) break;
        problems.push(`${name}: no link`);
      } catch (error) {
        problems.push(`${name}: ${error.message}`);
      }
    }
    if (!imageUrl) throw upscaleFailure(`${UPSCALE_UPLOAD_FAILED.toLowerCase()} (${problems.join("; ")})`);
    try {
      const api = `${NEXRAY_API()}/tools/remini?${new URLSearchParams({ url: imageUrl }).toString()}`;
      const res = await http.get(api, { responseType: "arraybuffer", validateStatus: () => true });
      const buf = Buffer.from(res.data);
      if (res.status === 200 && looksLikeImage(buf)) return buf;
      let detail = `HTTP ${res.status}`;
      try {
        detail = JSON.parse(buf.toString("utf8")).error || detail;
      } catch {
        // Not JSON: keep the status.
      }
      throw new Error(detail);
    } catch (error) {
      throw upscaleFailure(`the upscale service did not return an image (${error.message})`);
    }
  }

  // exact: index.js getTelegramStickers(url). Asks Levanter's hosted service.
  async function getTelegramStickers(url) {
    return (await http.post("https://levanter.onrender.com/sticker", { url })).data;
  }

  // exact: ss/pinterest.js pinterestSearch(query). Returns image URLs, or [] on failure.
  async function pinterestSearch(query) {
    try {
      const home = await http.get("https://www.pinterest.com/", { headers: { "User-Agent": PINTEREST_UA } });
      const cookies = [].concat(home.headers["set-cookie"] || []).map((c) => String(c).split(";")[0]).join("; ");
      const options = {
        article: null,
        appliedProductFilters: "---",
        rs: "typed",
        scope: "pins",
        query,
      };
      const sourceUrl = `/search/pins/?q=${encodeURIComponent(query)}&rs=typed`;
      const res = await http.get("https://www.pinterest.com/resource/BaseSearchResource/get/", {
        params: { source_url: sourceUrl, data: JSON.stringify({ options, context: {} }), _: Date.now() },
        headers: {
          accept: "application/json, text/javascript, */*, q=0.01",
          "accept-language": "en-GB,en;q=0.9",
          "cache-control": "no-cache",
          pragma: "no-cache",
          "sec-fetch-dest": "empty",
          "sec-fetch-mode": "cors",
          "sec-fetch-site": "same-origin",
          "User-Agent": PINTEREST_UA,
          "x-pinterest-appstate": "active",
          "x-pinterest-pws-handler": "www/search/[scope].js",
          "x-pinterest-source-url": sourceUrl,
          "x-requested-with": "XMLHttpRequest",
          Cookie: cookies,
          Referer: "https://www.pinterest.com/",
        },
      });
      return res.data.resource_response.data.results
        .map((item) => item.images?.orig?.url)
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  return {
    addExif,
    sticker,
    cropsticker,
    genThumbnail,
    textMaker,
    getImgUrl,
    upscale,
    getTelegramStickers,
    pinterestSearch,
    uploadToCatbox,
  };
}
