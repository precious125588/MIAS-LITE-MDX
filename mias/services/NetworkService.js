/**
 * MIAS — Network Service
 *
 * All outbound HTTP requests must go through here.
 * Internally uses Axios with Axios-Retry — commands never import axios directly.
 *
 * Architecture: Commands → NetworkService → HttpEngine (axios + retry) → Internet
 */

import engineRegistryModule from "../lib/engineRegistry.cjs";

const _engine = engineRegistryModule.getEngineRegistry().get("http");

// Fallback HTTP using node built-ins (extremely unlikely to be needed)
async function _nodeFetch(url, opts = {}) {
  const https = await import("https");
  const http  = await import("http");
  const { URL: NURL } = await import("url");
  return new Promise((resolve, reject) => {
    const parsed = new NURL(String(url));
    const mod = parsed.protocol === "https:" ? https : http;
    const req = mod.get(String(url), opts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end",  () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

// ─── Public helpers ───────────────────────────────────────────────────────────

/**
 * Fetch a URL and return the raw Buffer.
 * @param {string} url
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]
 * @param {object} [opts.headers]
 * @param {number} [opts.retries]
 * @param {boolean}[opts.noCache]
 * @returns {Promise<Buffer>}
 */
export async function fetchBuffer(url, opts = {}) {
  if (_engine?.fetchBuffer) return _engine.fetchBuffer(url, opts);
  return _nodeFetch(url, opts);
}

/**
 * GET a URL and parse the JSON response.
 * @param {string} url
 * @param {object} [opts]
 * @returns {Promise<any>}
 */
export async function getJson(url, opts = {}) {
  if (_engine?.getJson) return _engine.getJson(url, opts);
  const buf = await fetchBuffer(url, opts);
  return JSON.parse(buf.toString());
}

/**
 * POST JSON to a URL and parse the response.
 * @param {string} url
 * @param {any}    body
 * @param {object} [opts]
 * @returns {Promise<any>}
 */
export async function postJson(url, body, opts = {}) {
  if (_engine?.postJson) return _engine.postJson(url, body, opts);
  throw new Error("NetworkService: postJson not available (http engine not loaded)");
}

/**
 * Generic request (GET by default).
 * Returns the Axios response object.
 * @param {string} url
 * @param {object} [opts] - Axios request config
 * @returns {Promise<object>}
 */
export async function request(url, opts = {}) {
  const client = _engine?.client || _engine?.defaultClient;
  if (!client) throw new Error("NetworkService: no HTTP client available");
  return client.request({ url: String(url), ...opts });
}

/**
 * GET request — returns the Axios response.
 * @param {string} url
 * @param {object} [config]
 * @returns {Promise<object>}
 */
export async function get(url, config = {}) {
  const client = _engine?.client || _engine?.defaultClient;
  if (!client) {
    const buf = await fetchBuffer(url, config);
    return { data: buf, status: 200, headers: {} };
  }
  return client.get(String(url), config);
}

/**
 * POST request — returns the Axios response.
 * @param {string} url
 * @param {any}    data
 * @param {object} [config]
 * @returns {Promise<object>}
 */
export async function post(url, data, config = {}) {
  const client = _engine?.client || _engine?.defaultClient;
  if (!client) throw new Error("NetworkService: no HTTP client available for POST");
  return client.post(String(url), data, config);
}

/**
 * Create a custom Axios client with specific options.
 * @param {object} opts - timeout, retries, maxContentLength, userAgent, etc.
 * @returns {object} Axios instance
 */
export function createClient(opts = {}) {
  if (_engine?.createHttpClient) return _engine.createHttpClient(opts);
  throw new Error("NetworkService: http engine not available");
}

/** The shared default Axios client. */
export const client = _engine?.client || _engine?.defaultClient || null;

export default { fetchBuffer, getJson, postJson, request, get, post, createClient, client };
