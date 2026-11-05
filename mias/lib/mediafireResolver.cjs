'use strict';
/**
 * Safe MediaFire resolver/downloader/extractor helpers.
 * Network functions are injectable for controlled tests. Only HTTP(S) URLs
 * on MediaFire domains are accepted for resolution; all download redirects
 * are manually validated and private/reserved destinations are rejected.
 */
const dns = require('dns').promises;
const net = require('net');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { randomUUID } = require('crypto');

const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 6;
const axiosGet = (...args) => require('axios').get(...args);

function isPrivateIPv4(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19));
}

function isPrivateIPv6(ip) {
  const normalized = ip.toLowerCase().split('%')[0];
  if (normalized === '::' || normalized === '::1') return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) return true;
  if (normalized.startsWith('::ffff:')) {
    const v4 = normalized.slice(7);
    if (net.isIPv4(v4)) return isPrivateIPv4(v4);
    const hex = v4.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
    if (hex) return isPrivateIPv4(`${parseInt(hex[1], 16) >> 8}.${parseInt(hex[1], 16) & 255}.${parseInt(hex[2], 16) >> 8}.${parseInt(hex[2], 16) & 255}`);
    return true;
  }
  return false;
}

async function assertPublicHttpUrl(raw, { lookup = dns.lookup } = {}) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('Invalid download URL'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Unsupported download URL');
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) throw new Error('Restricted download destination');
  const ipType = net.isIP(host);
  if (ipType === 4 && isPrivateIPv4(host)) throw new Error('Restricted download destination');
  if (ipType === 6 && isPrivateIPv6(host)) throw new Error('Restricted download destination');
  if (!ipType) {
    let addresses;
    try { addresses = await lookup(host, { all: true, verbatim: true }); }
    catch { throw new Error('Unable to resolve download host'); }
    if (!addresses.length || addresses.some(({ address }) => net.isIPv4(address) ? isPrivateIPv4(address) : isPrivateIPv6(address))) throw new Error('Restricted download destination');
  }
  return url;
}

function isMediaFireUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return false; }
  return ['mediafire.com', 'www.mediafire.com', 'mfi.re', 'www.mfi.re'].includes(u.hostname.toLowerCase()) && ['http:', 'https:'].includes(u.protocol);
}

async function resolveMediaFire(url, options = {}) {
  if (!isMediaFireUrl(url)) throw new Error('Unsupported MediaFire URL');
  const fetch = options.fetch || axiosGet;
  const res = await fetch(url, { timeout: options.timeoutMs || DEFAULT_TIMEOUT_MS, maxRedirects: 0, responseType: 'text', validateStatus: s => s >= 200 && s < 400 });
  if (res.status >= 300 && res.status < 400 && res.headers?.location) {
    const target = new URL(res.headers.location, url).href;
    if (!isMediaFireUrl(target)) throw new Error('MediaFire redirected to an unsupported destination');
    return target;
  }
  const html = String(res.data || '');
  const candidates = [
    ...html.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*(?:id=["']downloadButton["']|class=["'][^"']*download[^"']*["'])/gi),
    ...html.matchAll(/(?:href|content)=["']([^"']+(?:download|file)[^"']*)["']/gi),
  ];
  for (const match of candidates) {
    const candidate = new URL(match[1].replace(/&amp;/g, '&'), url);
    if (candidate.protocol === 'https:' && /mediafire\.com$/i.test(candidate.hostname)) return candidate.href;
  }
  throw new Error('Could not locate a direct MediaFire download link');
}

async function downloadMediaFireFileToTemp(url, options = {}) {
  const maxBytes = options.maxBytes || DEFAULT_MAX_BYTES;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const directory = options.tempDir || require('os').tmpdir();
  await fsp.mkdir(directory, { recursive: true });
  const file = path.join(directory, `mias-mediafire-${randomUUID()}.bin`);
  let current = url;
  let response;
  try {
    for (let i = 0; i <= MAX_REDIRECTS; i++) {
      await assertPublicHttpUrl(current, options);
      response = await (options.fetch || axiosGet)(current, {
        timeout: timeoutMs, maxRedirects: 0, responseType: 'stream',
        validateStatus: status => status >= 200 && status < 400,
        headers: { 'User-Agent': 'Mozilla/5.0 MIAS-MDX downloader' },
      });
      if (response.status >= 300 && response.status < 400 && response.headers?.location) {
        if (i === MAX_REDIRECTS) throw new Error('Too many download redirects');
        current = new URL(response.headers.location, current).href;
        continue;
      }
      if (response.status !== 200) throw new Error(`Download failed with HTTP ${response.status}`);
      const contentType = String(response.headers?.['content-type'] || '').toLowerCase();
      if (contentType.includes('text/html') || contentType.includes('application/json')) throw new Error('MediaFire returned a webpage instead of a file');
      const contentLength = Number(response.headers?.['content-length']);
      if (Number.isFinite(contentLength) && contentLength > maxBytes) throw new Error('Download exceeds the allowed file size');
      break;
    }
    if (!response || response.status !== 200) throw new Error('Unable to download the MediaFire file');
    let total = 0;
    const limiter = new (require('stream').Transform)({
      transform(chunk, _encoding, callback) {
        total += chunk.length;
        if (total > maxBytes) return callback(new Error('Download exceeds the allowed file size'));
        callback(null, chunk);
      },
    });
    await require('stream/promises').pipeline(response.data, limiter, fs.createWriteStream(file, { flags: 'wx', mode: 0o600 }));
    if (total < 4) throw new Error('Downloaded file is empty or incomplete');
    const handle = await fsp.open(file, 'r');
    const head = Buffer.alloc(Math.min(total, 512));
    try { await handle.read(head, 0, head.length, 0); } finally { await handle.close(); }
    const text = head.toString('utf8').trimStart().toLowerCase();
    if (text.startsWith('<!doctype') || text.startsWith('<html') || text.startsWith('{') || text.startsWith('<?xml')) throw new Error('MediaFire returned an error page instead of a file');
    const disposition = String(response.headers?.['content-disposition'] || '');
    const dispositionName = disposition.match(/filename\*=UTF-8''([^;]+)|filename=["']?([^;"']+)/i);
    let fileName = dispositionName?.[1] ? decodeURIComponent(dispositionName[1]) : dispositionName?.[2];
    if (!fileName) { try { fileName = decodeURIComponent(path.basename(new URL(current).pathname)); } catch (_) {} }
    fileName = String(fileName || 'mediafire-file').replace(/[\\/\0-\x1f]/g, '_').slice(0, 180);
    return { path: file, size: total, contentType: String(response.headers?.['content-type'] || 'application/octet-stream'), url: current, fileName };
  } catch (error) {
    try { response?.data?.destroy?.(); } catch (_) {}
    try { await fsp.unlink(file); } catch (_) {}
    throw error;
  }
}

async function downloadMediaFire(url, options = {}) {
  const maxBytes = options.maxBytes || DEFAULT_MAX_BYTES;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  let current = url;
  let response;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    await assertPublicHttpUrl(current, options);
    response = await (options.fetch || axiosGet)(current, {
      timeout: timeoutMs, maxRedirects: 0, responseType: 'stream',
      validateStatus: status => status >= 200 && status < 400,
      headers: { 'User-Agent': 'Mozilla/5.0 MIAS-MDX downloader' },
    });
    if (response.status >= 300 && response.status < 400 && response.headers?.location) {
      if (i === MAX_REDIRECTS) throw new Error('Too many download redirects');
      current = new URL(response.headers.location, current).href;
      continue;
    }
    if (response.status !== 200) throw new Error(`Download failed with HTTP ${response.status}`);
    const contentType = String(response.headers?.['content-type'] || '').toLowerCase();
    if (contentType.includes('text/html')) throw new Error('The server returned an HTML page instead of a ZIP file');
    const contentLength = Number(response.headers?.['content-length']);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) throw new Error('Download exceeds the allowed file size');
    break;
  }
  if (!response || response.status !== 200) throw new Error('Unable to download the MediaFire file');
  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of response.data) {
      total += chunk.length;
      if (total > maxBytes) {
        response.data.destroy?.();
        throw new Error('Download exceeds the allowed file size');
      }
      chunks.push(Buffer.from(chunk));
    }
  } catch (error) {
    throw new Error(error.message === 'Download exceeds the allowed file size' ? error.message : 'Download failed or was incomplete');
  }
  if (!total) throw new Error('Downloaded file is empty');
  const buffer = Buffer.concat(chunks, total);
  if (buffer.length < 4 || !(buffer[0] === 0x50 && buffer[1] === 0x4b && [0x03, 0x05, 0x07].includes(buffer[2]) && [0x04, 0x06, 0x08].includes(buffer[3]))) {
    throw new Error('Downloaded content is not a valid ZIP archive');
  }
  try { unzipSync(buffer); } catch { throw new Error('ZIP archive is corrupt or incomplete'); }
  return buffer;
}

function safeEntryPath(rootDir, entryName) {
  if (typeof entryName !== 'string' || !entryName || entryName.includes('\0')) throw new Error('Unsafe ZIP entry path');
  const normalized = entryName.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized) || normalized.split('/').some(part => part === '..')) throw new Error('Unsafe ZIP entry path');
  const root = path.resolve(rootDir);
  const target = path.resolve(root, normalized);
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error('Unsafe ZIP entry path');
  return target;
}

function extractZipBuffer(buffer, destination, options = {}) {
  const maxEntries = options.maxEntries || 1000;
  const maxUncompressedBytes = options.maxUncompressedBytes || 1024 * 1024 * 1024;
  const entries = require('fflate').unzipSync(buffer);
  const names = Object.keys(entries);
  if (!names.length) throw new Error('ZIP archive is empty');
  if (names.length > maxEntries) throw new Error('ZIP archive contains too many entries');
  const root = path.resolve(destination);
  let total = 0;
  const files = [];
  for (const name of names) {
    const target = safeEntryPath(root, name);
    const data = Buffer.from(entries[name]);
    total += data.length;
    if (total > maxUncompressedBytes) throw new Error('ZIP archive expands beyond the allowed size');
    files.push({ target, data });
  }
  fs.mkdirSync(root, { recursive: true });
  for (const file of files) {
    fs.mkdirSync(path.dirname(file.target), { recursive: true });
    fs.writeFileSync(file.target, file.data, { flag: 'wx' });
  }
  return files.map(file => file.target);
}

async function downloadToTemp(url, options = {}) {
  const directory = options.tempDir || require('os').tmpdir();
  await fsp.mkdir(directory, { recursive: true });
  const file = path.join(directory, `mias-mediafire-${randomUUID()}.zip`);
  try {
    const data = await downloadMediaFire(url, options);
    await fsp.writeFile(file, data, { flag: 'wx', mode: 0o600 });
    return file;
  } catch (error) {
    try { await fsp.unlink(file); } catch (_) {}
    throw error;
  }
}

module.exports = {
  isMediaFireUrl,
  assertPublicHttpUrl,
  resolveMediaFire,
  downloadMediaFire,
  downloadMediaFireFileToTemp,
  downloadToTemp,
  extractZipBuffer,
  safeEntryPath,
};
