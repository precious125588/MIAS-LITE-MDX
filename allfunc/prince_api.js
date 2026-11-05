/**
 * PRINCE API HELPER
 * Base: https://api.princetechn.com
 * Key:  prince
 * All endpoints wired here — import and use princeGet() / princePost()
 */

const { httpClient: axios } = require('../mias/lib/engineAccess.cjs');

const BASE = 'https://api.princetechn.com';
const KEY  = 'prince';
const TIMEOUT = 25000;

/**
 * GET wrapper — adds apikey automatically
 * @param {string} endpoint  e.g. '/api/fun/jokes'
 * @param {object} params    extra query params
 */
async function princeGet(endpoint, params = {}) {
  try {
    const res = await axios.get(`${BASE}${endpoint}`, {
      params: { apikey: KEY, ...params },
      timeout: TIMEOUT,
      responseType: 'json',
    });
    return { ok: true, data: res.data };
  } catch (e) {
    return { ok: false, error: e.message, data: null };
  }
}

/**
 * GET wrapper that returns the result field directly (or null on failure)
 */
async function princeResult(endpoint, params = {}) {
  const r = await princeGet(endpoint, params);
  if (!r.ok || !r.data?.success) return null;
  return r.data.result ?? r.data.results ?? null;
}

/**
 * Convenience: fetch a random fun/text result (string)
 */
async function princeFun(category) {
  const r = await princeGet(`/api/fun/${category}`);
  if (!r.ok || !r.data?.success) return null;
  const res = r.data.result;
  if (typeof res === 'string') return res;
  if (res?.text)      return res.text;
  if (res?.message)   return res.message;
  if (res?.quote)     return res.quote;
  if (res?.advice)    return res.advice;
  if (res?.setup)     return `${res.setup}\n\n_${res.punchline || ''}_`;
  if (res?.joke)      return res.joke;
  if (res?.punchline) return res.punchline;
  if (Array.isArray(res)) return res[0]?.text || JSON.stringify(res[0]);
  return JSON.stringify(res).slice(0, 300);
}

/**
 * Pick a download URL out of a Prince API `result` object.
 * The upstream API is inconsistent about the field name
 * (`downloadUrl`, `download_url`, `dl_link`, `apkUrl`, ...), which is why a
 * lot of download commands used to report failure on a successful response.
 */
function pickDownloadUrl(res) {
  if (!res) return null;
  if (typeof res === 'string') return /^https?:\/\//i.test(res) ? res : null;
  const keys = [
    'downloadUrl','download_url','download','dl_link','dllink','dl','url','link',
    'directUrl','direct_url','direct','apkUrl','apk','audio','video','hd','sd',
    'file','fileUrl','media','result',
  ];
  for (const k of keys) {
    const v = res[k];
    if (typeof v === 'string' && /^https?:\/\//i.test(v)) return v;
  }
  for (const k of ['variants','formats','links','medias']) {
    const arr = res[k];
    if (Array.isArray(arr)) {
      const hit = arr.map(x => (typeof x === 'string' ? x : x?.url || x?.link || x?.downloadUrl))
                     .find(u => typeof u === 'string' && /^https?:\/\//i.test(u));
      if (hit) return hit;
    }
  }
  return null;
}

/** Some endpoints answer 200 + success:true with an error payload inside result. */
function isApiErrorResult(res) {
  return !!(res && typeof res === 'object' && (res.error || res.Error) && !pickDownloadUrl(res));
}

module.exports = { princeGet, princeResult, princeFun, pickDownloadUrl, isApiErrorResult, BASE, KEY };

