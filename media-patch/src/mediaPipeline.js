// Resilient media pipeline: provider fallback + parallel ranged download + retry.
// Dependency-free (Node 18+).
const fs = require('fs');
const { request } = require('./lib/http');

const CHUNK = 1024 * 1024; // 1 MB
const CONCURRENCY = Number(process.env.DL_CONCURRENCY || 6);
const TIMEOUT = Number(process.env.DL_TIMEOUT || 20000);

async function contentLength(url) {
  try {
    const r = await request(url, { method: 'HEAD', timeout: 8000 });
    const ranged = (r.headers.get('accept-ranges') || '').includes('bytes');
    return ranged ? Number(r.headers.get('content-length') || 0) : 0;
  } catch {
    return 0;
  }
}

async function downloadSimple(url, outPath) {
  const r = await request(url, { timeout: TIMEOUT });
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(outPath, buf);
}

async function downloadRanged(url, outPath, size) {
  fs.writeFileSync(outPath, Buffer.alloc(0));
  const jobs = [];
  for (let start = 0; start < size; start += CHUNK) {
    jobs.push({ start, end: Math.min(start + CHUNK - 1, size - 1) });
  }
  let cursor = 0;
  const fd = fs.openSync(outPath, 'w+');
  try {
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, async () => {
        while (cursor < jobs.length) {
          const j = jobs[cursor++];
          const r = await request(url, {
            headers: { Range: `bytes=${j.start}-${j.end}` },
            timeout: TIMEOUT,
          });
          const buf = Buffer.from(await r.arrayBuffer());
          fs.writeSync(fd, buf, 0, buf.length, j.start);
        }
      }),
    );
  } finally {
    fs.closeSync(fd);
  }
}

/** Download `url` to `outPath`, using parallel range requests when supported. */
async function download(url, outPath, tries = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const size = await contentLength(url);
      if (size > CHUNK) await downloadRanged(url, outPath, size);
      else await downloadSimple(url, outPath);
      if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) return outPath;
      throw new Error('empty file');
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 800 * attempt)); // backoff
    }
  }
  throw new Error(`Download failed after ${tries} tries: ${lastErr && lastErr.message}`);
}

/** Try every provider in order; the first that resolves wins. */
async function resolveMedia(providers, query) {
  const errors = [];
  for (const p of providers) {
    try {
      const meta = await p.searchTrack(query);
      if (!meta || (!meta.url && !meta.linkOnly)) throw new Error('no url in result');
      return meta;
    } catch (e) {
      errors.push(`${p.name || 'provider'}: ${e.message}`);
    }
  }
  const err = new Error('All providers failed -> ' + errors.join(' | '));
  err.providerErrors = errors;
  throw err;
}

/** One call: resolve then download to /tmp. Returns { ...meta, path }. */
async function fetchMedia(providers, query, dir = '/tmp') {
  const meta = await resolveMedia(providers, query);
  if (meta.linkOnly) return meta;
  const path = `${dir}/mais-${Date.now()}.${meta.ext || 'mp3'}`;
  await download(meta.url, path);
  return { ...meta, path };
}

module.exports = { download, resolveMedia, fetchMedia };
