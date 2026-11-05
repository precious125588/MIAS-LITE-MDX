// davidcyril.js — shared DavidCyril API client (ESM)
//
// The public API currently exposes hundreds of endpoints with a mix of GET,
// POST, JSON, text, and binary responses. Keep all calls behind this boundary
// so commands and auto-downloaders use the same URL validation, query
// encoding, timeout, and response handling.
import { httpClient as axios } from "./lib/engineAccess.js";

export const DC_BASE = String(
  process.env.DAVIDCYRIL_API_BASE || "https://apis.davidcyril.name.ng",
).replace(/\/+$/, "");
export const DC_TIMEOUT = 25000;
const DC_USER_AGENT = "MAIS-MDX/5 (+https://github.com/precious125588/fantastic-waddle)";

function cleanParams(params = {}) {
  const result = {};
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === "") continue;
    result[key] = Array.isArray(value) ? value.join(",") : String(value);
  }
  return result;
}

function endpointUrl(endpoint, params = {}) {
  const path = String(endpoint || "").trim();
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) {
    throw new TypeError("DavidCyril endpoint must be an absolute API path beginning with /");
  }
  const query = new URLSearchParams(cleanParams(params)).toString();
  return `${DC_BASE}${path}${query ? `?${query}` : ""}`;
}

function parseResponse(data, contentType = "", preserveBinary = false) {
  if (Buffer.isBuffer(data)) {
    if (preserveBinary) return data;
    if (/json|text|javascript|xml/i.test(contentType)) {
      const text = data.toString("utf8");
      try { return JSON.parse(text); } catch { return text; }
    }
    return data;
  }
  if (typeof data === "string" && /json/i.test(contentType)) {
    try { return JSON.parse(data); } catch { return data; }
  }
  return data;
}

/**
 * Call any documented DavidCyril endpoint.
 *
 * @returns {{ok: boolean, status: number|null, data: unknown, error?: string,
 *            contentType?: string}}
 */
export async function dcRequest(endpoint, {
  method = "GET",
  params = {},
  body,
  timeout = DC_TIMEOUT,
  headers = {},
  responseType = "auto",
} = {}) {
  const upperMethod = String(method).toUpperCase();
  if (!["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].includes(upperMethod)) {
    return { ok: false, status: null, data: null, error: `Unsupported method: ${upperMethod}` };
  }

  let url;
  try {
    url = endpointUrl(endpoint, params);
  } catch (error) {
    return { ok: false, status: null, data: null, error: error.message };
  }

  try {
    const requestHeaders = {
      "User-Agent": DC_USER_AGENT,
      Accept: responseType === "binary" ? "*/*" : "application/json,text/plain,*/*",
      ...headers,
    };
    if (body !== undefined && typeof body?.getHeaders !== "function" &&
        !Object.keys(requestHeaders).some((key) => key.toLowerCase() === "content-type")) {
      requestHeaders["Content-Type"] = "application/json";
    }
    const response = await axios.request({
      url,
      method: upperMethod,
      timeout,
      responseType: responseType === "binary" ? "arraybuffer" : "arraybuffer",
      maxContentLength: 100 * 1024 * 1024,
      maxBodyLength: 10 * 1024 * 1024,
      headers: requestHeaders,
      ...(body === undefined ? {} : { data: body }),
    });
    const contentType = response.headers?.["content-type"] || "";
    const data = parseResponse(response.data, contentType, responseType === "binary");
    const apiRejected = data && typeof data === "object" && data.success === false;
    return {
      ok: response.status >= 200 && response.status < 300 && !apiRejected,
      status: response.status,
      data,
      contentType,
    };
  } catch (error) {
    const status = error?.response?.status || null;
    const contentType = error?.response?.headers?.["content-type"] || "";
    const responseData = error?.response?.data;
    return {
      ok: false,
      status,
      data: responseData === undefined ? null : parseResponse(responseData, contentType, responseType === "binary"),
      contentType,
      error: error?.message || "DavidCyril request failed",
    };
  }
}

export async function dcGet(path, params = {}, timeout = DC_TIMEOUT) {
  return dcRequest(path, { method: "GET", params, timeout });
}

export async function dcPost(path, body = {}, timeout = DC_TIMEOUT) {
  return dcRequest(path, { method: "POST", body, timeout });
}

// Download binary (image, audio, video) from a DC endpoint. Existing command
// handlers expect a Buffer directly, so keep this helper intentionally small.
export async function dcGetBinary(path, params = {}, timeout = 60000) {
  const result = await dcRequest(path, { method: "GET", params, timeout, responseType: "binary" });
  return result.ok && Buffer.isBuffer(result.data) ? result.data : null;
}

export async function dcPostBinary(path, body = {}, timeout = 60000) {
  const result = await dcRequest(path, { method: "POST", body, timeout, responseType: "binary" });
  return result.ok && Buffer.isBuffer(result.data) ? result.data : null;
}

// Resolve audio download URL from DC Spotify API responses
export function extractDcSpotify(data) {
  if (!data) return {};
  const d = data?.data || data?.result || data;
  return {
    dlUrl: d?.download_url || d?.audio || d?.url || d?.mp3 || d?.link || null,
    title: d?.title || d?.name || null,
    artists: Array.isArray(d?.artists) ? d.artists.map(a => a?.name || a).join(", ") : (d?.artist || d?.artists || null),
    thumbUrl: d?.thumbnail || d?.cover || d?.image || d?.album_art || d?.cover_url || null,
    duration: d?.duration ? `${Math.floor(d.duration / 60)}:${String(d.duration % 60).padStart(2, "0")}` : null,
  };
}

// Normalise DavidCyril Play / YouTube-MP3 responses.
//   GET /play?query=<search>      -> result{title,video_url,thumbnail,duration,views,published,download_url}
//   GET /download/ytmp3?url=<url> -> result{title,thumbnail,format,type,download_url}
// Both shapes are documented at https://apis.davidcyril.name.ng/docs/#
export function extractDcPlay(data) {
  if (!data || typeof data !== "object") return null;
  const r = data.result || data.data || data;
  if (!r || typeof r !== "object") return null;
  const dlUrl = r.download_url || r.downloadUrl || r.url || r.audio || r.mp3 || r.link || null;
  if (!dlUrl || typeof dlUrl !== "string" || !/^https?:\/\//i.test(dlUrl)) return null;
  const fmt = String(r.format || r.quality || "mp3").toLowerCase();
  const isM4a = /m4a|mp4a/.test(fmt);
  const isOpus = /opus|ogg|webm/.test(fmt);
  const thumbUrl = r.thumbnail || r.thumb || r.image || r.cover || null;
  return {
    dlUrl,
    title: r.title || r.name || null,
    artists: r.author || r.artist || r.channel || null,
    duration: r.duration || r.timestamp || null,
    views: r.views || null,
    published: r.published || r.publishedAt || null,
    videoUrl: r.video_url || r.videoUrl || r.youtube_url || null,
    thumbUrl: typeof thumbUrl === "string" && /^https?:\/\//i.test(thumbUrl) ? thumbUrl : null,
    mimetype: isM4a ? "audio/mp4" : isOpus ? "audio/ogg; codecs=opus" : "audio/mpeg",
    ext: isM4a ? ".m4a" : isOpus ? ".ogg" : ".mp3",
  };
}

// Resolve video download URL from DC TikTok API responses
export function extractDcTiktok(data, isAudio = false) {
  if (!data) return null;
  const d = data?.data || data?.result || data;
  if (isAudio) return d?.music || d?.wmplay || d?.audio || d?.play || null;
  return d?.hdplay || d?.play || d?.video || d?.url || d?.nwm_video_url_HQ || null;
}

export default {
  DC_BASE,
  dcRequest,
  dcGet,
  dcPost,
  dcGetBinary,
  dcPostBinary,
  extractDcSpotify,
  extractDcTiktok,
  extractDcPlay,
};
