'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15000;

function detectImageMime(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return '';
  const signature = buffer.subarray(0, 12);
  if (signature[0] === 0xff && signature[1] === 0xd8 && signature[2] === 0xff) return 'image/jpeg';
  if (signature.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (signature.subarray(0, 3).toString('ascii') === 'GIF') return 'image/gif';
  if (
    signature.subarray(0, 4).toString('ascii') === 'RIFF'
    && signature.subarray(8, 12).toString('ascii') === 'WEBP'
  ) return 'image/webp';
  return '';
}

function isSupportedImage(buffer) {
  return Boolean(detectImageMime(buffer));
}

async function downloadImageToDisk(url, {
  axiosImpl,
  tempRoot = os.tmpdir(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = DEFAULT_MAX_BYTES,
  headers = {},
} = {}) {
  if (typeof axiosImpl?.get !== 'function') throw new TypeError('An axios-compatible client is required');
  let parsed;
  try { parsed = new URL(String(url)); } catch { throw Object.assign(new Error('Invalid image URL'), { code: 'IMAGE_URL_INVALID' }); }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw Object.assign(new Error('Only HTTP image URLs are supported'), { code: 'IMAGE_URL_INVALID' });
  }

  const max = Math.max(1, Number(maxBytes) || DEFAULT_MAX_BYTES);
  const timeout = Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT_MS);
  const dir = await fs.promises.mkdtemp(path.join(tempRoot, 'mias-image-'));
  const filePath = path.join(dir, 'image');
  let response;
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    await fs.promises.rm(dir, { recursive: true, force: true });
  };

  try {
    response = await axiosImpl.get(parsed.toString(), {
      responseType: 'stream',
      timeout,
      maxRedirects: 5,
      maxContentLength: max,
      headers: {
        'User-Agent': 'Mozilla/5.0 (WhatsApp; Pinterest image search)',
        Referer: 'https://www.pinterest.com/',
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        ...headers,
      },
    });
    const contentType = String(response?.headers?.['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (contentType && /^(?:text\/|application\/(?:json|xml|xhtml\+xml))/i.test(contentType)) {
      throw Object.assign(new Error('Image host returned a non-image response'), { code: 'IMAGE_CONTENT_TYPE_INVALID' });
    }
    if (!response?.data || typeof response.data.pipe !== 'function') {
      throw Object.assign(new Error('Image host returned no stream'), { code: 'IMAGE_STREAM_MISSING' });
    }

    let bytes = 0;
    const limit = new Transform({
      transform(chunk, encoding, callback) {
        bytes += chunk.length;
        if (bytes > max) {
          callback(Object.assign(new Error('Image exceeds the configured size limit'), { code: 'IMAGE_TOO_LARGE' }));
          return;
        }
        callback(null, chunk);
      },
    });
    await pipeline(response.data, limit, fs.createWriteStream(filePath, { flags: 'wx' }));
    if (bytes < 1000) {
      throw Object.assign(new Error('Image response was empty or too small'), { code: 'IMAGE_TOO_SMALL' });
    }

    const handle = await fs.promises.open(filePath, 'r');
    let signature;
    try {
      signature = Buffer.alloc(12);
      await handle.read(signature, 0, signature.length, 0);
    } finally {
      await handle.close();
    }
    const detectedMime = detectImageMime(signature);
    if (!detectedMime) {
      throw Object.assign(new Error('Image host returned invalid image data'), { code: 'IMAGE_DATA_INVALID' });
    }

    return {
      path: filePath,
      bytes,
      contentType: detectedMime,
      cleanup,
    };
  } catch (error) {
    response?.data?.destroy?.();
    await cleanup();
    throw error;
  }
}

module.exports = { detectImageMime, downloadImageToDisk, isSupportedImage };
