// =========================================================================
//  download-worker.cjs  · mias/lib/download-worker.cjs
//
//  ROOT CAUSE FIX for Issue #6 (bot SIGKILL on >1.5 GB downloads):
//   The original handlers used axios with responseType:'arraybuffer' and
//   no maxContentLength, so a 2 GB response would allocate a 2 GB Buffer
//   and the Node process would be OOM-killed (RSS > cgroup limit on
//   hosts like Railway). After the kill, systemd / Dockerfile restarted
//   the bot and the user saw "bot just restarted again".
//
//  THIS MODULE:
//   - Streams response data to a temp file (fs.createWriteStream).
//   - Enforces a 5 GB hard cap via Content-Length AND live byte counter.
//   - Returns {ok,path,size,mime,sha256} so callers can stream the file
//     directly to WA without re-buffering.
//   - Queues with FIFO + bounded concurrency (env DOWNLOAD_WORKER_COUNT,
//     default 2) so a flood of /play .3 commands cannot OOM the box.
// =========================================================================

'use strict';
const fs       = require('fs');
const path     = require('path');
const crypto   = require('crypto');
const http     = require('http');
const https    = require('https');
const { URL }  = require('url');

const MAX_DOWNLOAD_BYTES = Number(process.env.MAX_DOWNLOAD_BYTES) || (5 * 1024 * 1024 * 1024); // 5 GB
const DOWNLOAD_DIR       = process.env.DOWNLOAD_DIR || path.join(require('os').tmpdir(), 'p2-dl');
const WORKER_COUNT       = Number(process.env.DOWNLOAD_WORKER_COUNT) || 2;
const CHILD_PROCESS      = process.env.DOWNLOAD_AS_CHILD === '1';

try { fs.mkdirSync(DOWNLOAD_DIR, { recursive: true }); } catch (_e) {}

const _queue = [];
const _active = new Set();
const _stats  = { ok: 0, fail: 0, bytes: 0, inflight: 0 };

function _newId() {
  return Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
}

function _enqueue(job) {
  return new Promise((resolve, reject) => {
    _queue.push({ ...job, resolve, reject });
    _drain();
  });
}

function _drain() {
  while (_active.size < WORKER_COUNT && _queue.length > 0) {
    const job = _queue.shift();
    _active.add(job);
    _stats.inflight = _active.size;
    _run(job).finally(() => {
      _active.delete(job);
      _stats.inflight = _active.size;
      _drain();
    });
  }
}

async function _run({ url, timeoutMs, hintMime, resolve, reject }) {
  if (CHILD_PROCESS) {
    // Optional: fork this same file as a child so memory is isolated.
    return _runChild({ url, timeoutMs, hintMime, resolve, reject });
  }
  return _runInline({ url, timeoutMs, hintMime, resolve, reject });
}

function _runInline({ url, timeoutMs, hintMime, resolve, reject }) {
  let u;
  try { u = new URL(url); } catch (e) { return reject(new Error('bad-url')); }

  const lib   = u.protocol === 'https:' ? https : http;
  const id    = _newId();
  const ext   = _extFromMime(hintMime) || 'bin';
  const dest  = path.join(DOWNLOAD_DIR, `dl_${id}.${ext}`);
  const hash  = crypto.createHash('sha256');
  const ws    = fs.createWriteStream(dest);
  const timer = setTimeout(() => { ws.destroy(new Error('timeout')); }, timeoutMs || 120000);

  let received = 0;
  let aborted  = false;
  let mime     = hintMime || 'application/octet-stream';

  const req = lib.request(
    {
      method: 'GET',
      hostname: u.hostname,
      port:     u.port || (u.protocol === 'https:' ? 443 : 80),
      path:     u.pathname + u.search,
      headers:  {
        'User-Agent': 'Mozilla/5.0 (compatible; jinx-dl/1.0)',
        'Accept':     '*/*',
      },
    },
    (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // follow one redirect (recursive)
        clearTimeout(timer);
        ws.destroy();
        try { fs.unlinkSync(dest); } catch (_e) {}
        return _runInline({
          url:      new URL(res.headers.location, url).toString(),
          timeoutMs, hintMime, resolve, reject,
        });
      }
      if (res.statusCode !== 200) {
        clearTimeout(timer);
        ws.destroy();
        try { fs.unlinkSync(dest); } catch (_e) {}
        return reject(new Error('http-' + res.statusCode));
      }
      const cl = Number(res.headers['content-length'] || 0);
      if (cl > MAX_DOWNLOAD_BYTES) {
        clearTimeout(timer);
        ws.destroy();
        try { fs.unlinkSync(dest); } catch (_e) {}
        return reject(new Error('too-large-cl:' + cl));
      }
      if (res.headers['content-type']) mime = res.headers['content-type'].split(';')[0].trim();

      res.on('data', (chunk) => {
        if (aborted) return;
        received += chunk.length;
        if (received > MAX_DOWNLOAD_BYTES) {
          aborted = true;
          ws.destroy(new Error('too-large-stream:' + received));
          return;
        }
        hash.update(chunk);
        ws.write(chunk);
      });
      res.on('end', () => {
        clearTimeout(timer);
        ws.end(() => {
          if (aborted) {
            try { fs.unlinkSync(dest); } catch (_e) {}
            return reject(new Error('aborted-stream'));
          }
          _stats.ok++; _stats.bytes += received;
          resolve({ ok: true, path: dest, size: received, mime, sha256: hash.digest('hex') });
        });
      });
      res.on('error', (e) => {
        clearTimeout(timer);
        ws.destroy();
        try { fs.unlinkSync(dest); } catch (_e) {}
        reject(e);
      });
    }
  );
  req.on('error', (e) => {
    clearTimeout(timer);
    ws.destroy();
    try { fs.unlinkSync(dest); } catch (_e) {}
    reject(e);
  });
  req.end();
}

function _runChild(args) {
  const { spawn } = require('child_process');
  const child = spawn(process.execPath, [__filename, 'inline', JSON.stringify(args)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { err += d.toString(); });
  child.on('close', (code) => {
    _stats.inflight = _active.size;
    if (code !== 0) return args.reject(new Error('child-exit-' + code + ':' + err));
    try { args.resolve(JSON.parse(out)); } catch (_e) { args.reject(new Error('child-bad-json')); }
    _drain();
  });
}

// CLI: invoked as child process for the `CHILD_PROCESS=1` mode.
if (require.main === module && process.argv[2] === 'inline') {
  try {
    const args = JSON.parse(process.argv[3]);
    _runInline({
      url: args.url, timeoutMs: args.timeoutMs, hintMime: args.hintMime,
      resolve: (r) => { console.log(JSON.stringify(r)); process.exit(0); },
      reject:  (e) => { console.error(String(e?.message || e)); process.exit(1); },
    });
  } catch (e) { console.error(String(e?.message || e)); process.exit(1); }
}

function _extFromMime(m) {
  if (!m) return null;
  if (m.startsWith('audio/mpeg'))  return 'mp3';
  if (m.startsWith('audio/ogg'))   return 'ogg';
  if (m.startsWith('audio/mp4'))   return 'm4a';
  if (m.startsWith('audio/aac'))   return 'aac';
  if (m.startsWith('video/mp4'))   return 'mp4';
  if (m.startsWith('video/quicktime')) return 'mov';
  return null;
}

/**
 * Fetch a file with capped streaming.
 * @param {object} req        { url, timeoutMs?, hintMime? }
 * @returns {Promise<{ok:true,path,size,mime,sha256}|{ok:false,error:string}>}
 */
async function fetch(req) {
  try {
    const r = await _enqueue(req);
    return r;
  } catch (e) {
    _stats.fail++;
    return { ok: false, error: String(e?.message || e) };
  }
}

function stats() {
  return { ..._stats, queue: _queue.length, active: _active.size, maxBytes: MAX_DOWNLOAD_BYTES };
}

module.exports = { fetch, stats, MAX_DOWNLOAD_BYTES, DOWNLOAD_DIR };
