// Tiny dependency-free HTTP helpers (Node 18+ global fetch).
// No axios needed — keeps the patch installable on any host.

function withParams(url, params) {
  if (!params) return url;
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
  }
  return u.toString();
}

const UA =
  'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36';

async function request(url, { params, timeout = 12000, method = 'GET', headers = {}, body } = {}) {
  const res = await fetch(withParams(url, params), {
    method,
    headers: { 'user-agent': UA, accept: '*/*', ...headers },
    body,
    redirect: 'follow',
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${new URL(url).host}`);
  return res;
}

async function getJSON(url, opts) {
  const res = await request(url, opts);
  return res.json();
}

module.exports = { request, getJSON, withParams, UA };
