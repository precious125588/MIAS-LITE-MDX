// diskStreamDl.cjs — Safe disk-streaming downloader for heavy tasks
// Prevents buffering huge files into Node.js heap to eliminate SIGKILL (exit code 137)

const fs = require('fs');
const path = require('path');
const os = require('os');
const { pipeline } = require('stream/promises');

function getTempDlDir() {
  const dir = path.join(os.tmpdir(), 'mias_stream_dl');
  if (!fs.existsSync(dir)) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  }
  return dir;
}

// Stream an HTTP/HTTPS resource directly to a temporary file on disk
async function streamUrlToDisk(url, options = {}) {
  const {
    timeoutMs = 180000,
    maxBytes = 80 * 1024 * 1024, // 80 MB default WhatsApp boundary
    ext = '.tmp',
    prefix = 'dl_'
  } = options;

  const tempDir = getTempDlDir();
  const filePath = path.join(tempDir, `${prefix}${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
  
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      redirect: 'follow',
      signal: controller.signal
    });

    if (!res.ok) {
      throw new Error(`HTTP_${res.status}_DOWNLOAD_FAILED`);
    }

    const outStream = fs.createWriteStream(filePath);
    let bytesWritten = 0;

    const { Readable } = require('stream');
    const nodeReadable = Readable.fromWeb(res.body);

    for await (const chunk of nodeReadable) {
      bytesWritten += chunk.length;
      if (bytesWritten > maxBytes) {
        outStream.destroy();
        try { fs.unlinkSync(filePath); } catch (_) {}
        throw new Error(`FILE_TOO_LARGE_LIMIT_${Math.round(maxBytes / (1024 * 1024))}MB`);
      }
      if (!outStream.write(chunk)) {
        await new Promise(r => outStream.once('drain', r));
      }
    }
    outStream.end();
    await new Promise((r, reject) => {
      outStream.once('finish', r);
      outStream.once('error', reject);
    });

    return { filePath, bytes: bytesWritten };
  } catch (err) {
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (_) {}
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Sweeper function to clean up any leftover temp files older than 15 minutes
function sweepStaleDlFiles(maxAgeMs = 15 * 60 * 1000) {
  try {
    const dir = getTempDlDir();
    if (!fs.existsSync(dir)) return;
    const now = Date.now();
    for (const f of fs.readdirSync(dir)) {
      try {
        const full = path.join(dir, f);
        const st = fs.statSync(full);
        if (now - st.mtimeMs > maxAgeMs) {
          fs.unlinkSync(full);
        }
      } catch (_) {}
    }
  } catch (_) {}
}

module.exports = {
  getTempDlDir,
  streamUrlToDisk,
  sweepStaleDlFiles
};
