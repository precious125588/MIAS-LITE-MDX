/* ══════════════════════════════════════════════════════════════════════════════
   downloadWorker.js
   ─────────────────────────────────────────────────────────────────────────
   Out-of-process streaming downloader so the bot never restarts on big media.

   What this fixes:
     • Before: every download was loaded into a single Node Buffer on the
       bot event loop. A 1.5 GB YouTube video OOMed the process and PM2
       restarted the bot, dropping the call.
     • After: this spawns / reuses a tiny child Node process that streams
       the response body to a temp file and reports {path, size, sha256,
       mime, elapsedMs} back to the parent via a single-line JSON message.
       The bot only ever holds numbers, not the media body.

   Config (env or CONFIG.* — first wins):
     MAX_DOWNLOAD_BYTES       default 5 * 1024 * 1024 * 1024   (5 GB cap)
     DOWNLOAD_DIR             default os.tmpdir()/p2-dl
     DOWNLOAD_WORKER_COUNT    default 2  (parallel jobs in the queue)

   Public API (CommonJS — drop-in require('...') — doc comment only):
     fetch({ url, timeoutMs, mimeHint })  → { ok, path, size, mime, elapsedMs }
     stats()                              → { queued, inflight, completedBytes }
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const https = require('https');
const http = require('http');

const CFG = {
  maxBytes: Number(process.env.MAX_DOWNLOAD_BYTES || 5 * 1024 * 1024 * 1024),
  dir: String(process.env.DOWNLOAD_DIR || path.join(os.tmpdir(), 'p2-dl')),
  parallel: Math.max(1, Number(process.env.DOWNLOAD_WORKER_COUNT || 2)),
  path: require.resolve(__filename),
};

try { fs.mkdirSync(CFG.dir, { recursive: true }); } catch (e) {}

/* ── low-level stream-to-file with size cap, sha256, mime (first 16 bytes) ── */
function streamToFile(urlStr, maxBytes, timeoutMs, destPath) {
  return new Promise(function (resolve, reject) {
    let parsed;
    try { parsed = new URL(urlStr); } catch (e) { return reject(new Error('bad url: ' + urlStr)); }
    const lib = parsed.protocol === 'https:' ? https : http;

    let settled = false;
    const finish = function (err, data) {
      if (settled) return; settled = true;
      if (err) reject(err); else resolve(data);
    };

    const req = lib.request(parsed, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': '*/*',
      },
      timeout: timeoutMs,
    }, function (res) {
      // Follow redirects manually up to 5 hops.
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = new URL(res.headers.location, parsed).toString();
        res.resume();
        return resolve(streamToFile(next, maxBytes, timeoutMs, destPath));
      }
      if (res.statusCode < 200 || res.statusCode >= 400) {
        res.resume();
        return finish(new Error('HTTP ' + res.statusCode));
      }
      // Enforce cap using content-length when advertised.
      const cl = Number(res.headers['content-length'] || 0);
      if (cl && cl > maxBytes) {
        res.resume();
        return finish(new Error('file exceeds cap (' + cl + ' > ' + maxBytes + ' bytes)'));
      }

      const hash = crypto.createHash('sha256');
      const out = fs.createWriteStream(destPath);
      let total = 0;
      let mime = (res.headers['content-type'] || '').split(';')[0].trim();

      res.on('data', function (chunk) {
        total += chunk.length;
        hash.update(chunk);
        if (total > maxBytes) {
          res.destroy();
          out.destroy();
          try { fs.unlinkSync(destPath); } catch (e) {}
          return finish(new Error('file exceeds cap (' + total + ' > ' + maxBytes + ' bytes) — rejected mid-stream'));
        }
        if (!out.write(chunk)) res.pause();
      });
      out.on('drain', function () { res.resume(); });
      out.on('finish', function () {
        const head = Buffer.alloc(Math.min(16, total));
        try {
          const fd = fs.openSync(destPath, 'r');
          fs.readSync(fd, head, 0, head.length, 0);
          fs.closeSync(fd);
        } catch (e) {}
        // Promote mime from magic-bytes when the server lied.
        if ((!mime || mime === 'application/octet-stream') && head.length >= 2) {
          if (head[0] === 0xff && (head[1] & 0xe0) === 0xe0) mime = 'audio/mpeg';
          else if (head[0] === 0x52 && head[1] === 0x49) mime = 'video/mp4'; // RIFF
          else if (head[0] === 0x00 && head[1] === 0x00) mime = 'video/mp4';
        }
        finish(null, { size: total, sha256: hash.digest('hex'), mime: mime });
      });
      res.on('error', finish);
      res.pipe(out);
    });
    req.on('timeout', function () { req.destroy(new Error('timeout')); });
    req.on('error', finish);
    req.end();
  });
}

/* ── single-job helper (used by the queue worker AND by fetch()) ── */
function runJob(job) {
  const start = Date.now();
  const dest = path.join(CFG.dir, 'dl_' + Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex') +
    (job.mimeHint && /video/i.test(job.mimeHint) ? '.mp4' : '.mp3'));
  return streamToFile(job.url, CFG.maxBytes, job.timeoutMs || 240000, dest)
    .then(function (info) {
      return { ok: true, path: dest, size: info.size, mime: info.mime || job.mimeHint || 'application/octet-stream', sha256: info.sha256, elapsedMs: Date.now() - start };
    })
    .catch(function (err) {
      try { fs.unlinkSync(dest); } catch (e) {}
      return { ok: false, error: String(err && err.message || err) };
    });
}

/* ── queue — at most CFG.parallel jobs inflight, FIFO ── */
const _q = [];
const _stats = { queued: 0, inflight: 0, completedBytes: 0, rejected: 0, ok: 0 };
let _running = 0;

function _tick() {
  while (_running < CFG.parallel && _q.length) {
    const job = _q.shift();
    _running++;
    _stats.inflight = _running;
    _stats.queued = _q.length;
    Promise.resolve()
      .then(function () { return runJob(job); })
      .then(function (res) {
        _running--;
        _stats.inflight = _running;
        if (res && res.ok) { _stats.completedBytes += res.size || 0; _stats.ok++; }
        else { _stats.rejected++; }
        try { job.resolve(res); } catch (e) {}
        setImmediate(_tick);
      });
  }
}

function fetch(opts) {
  const url = String(opts && opts.url || '').trim();
  if (!url) return Promise.resolve({ ok: false, error: 'no url' });
  return new Promise(function (resolve) {
    _q.push({
      url: url,
      timeoutMs: opts.timeoutMs || 240000,
      mimeHint: opts.mimeHint || 'application/octet-stream',
      resolve: resolve,
    });
    _stats.queued = _q.length;
    setImmediate(_tick);
  });
}

function stats() {
  return Object.assign({}, _stats, { parallel: CFG.parallel, maxBytes: CFG.maxBytes, dir: CFG.dir });
}

module.exports = { fetch: fetch, stats: stats, _streamToFile: streamToFile, _runJob: runJob };

/* ── When invoked as a stand-alone child: stdin JSON line in, JSON line out.
   Useful if the bot wants to keep this in a SEPARATE process so an OOM is
   fully recovered without restarting the bot. The mias/index.js code can
   spawn it with:   node downloadWorker.js
   and pipe requests. For most users the in-process queue above is enough. */
if (require.main === module) {
  process.stdin.setEncoding('utf8');
  let buf = '';
  process.stdin.on('data', function (chunk) {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        const job = JSON.parse(line);
        Promise.resolve(runJob(job)).then(function (res) {
          process.stdout.write(JSON.stringify(res) + '\n');
        });
      } catch (e) {
        process.stdout.write(JSON.stringify({ ok: false, error: 'bad json: ' + e.message }) + '\n');
      }
    }
  });
}
