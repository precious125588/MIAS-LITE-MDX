'use strict';

const { extractTextFromMessage } = require('./messageContent.cjs');

const IMAGE_OR_METADATA_KEYS = /(?:thumbnail|thumb|cover|avatar|poster|preview|photo|image|author|owner|token|cookie|headers|metadata|description|duration|filesize|file_size|expiry|expires|timestamp|music|audio_only)/i;
const VIDEO_URL_KEYS = /^(?:hd|sd|url|link|src|download|downloadurl|download_url|downloadlink|download_link|dl|video|videourl|video_url|mediaurl|media_url|play|playurl|play_url|high|low|original|best|mp4|file)$/i;

function makeError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

function cleanLinkCandidate(value) {
  let candidate = String(value || '').trim();
  candidate = candidate.replace(/^[<([{"'`]+/, '').replace(/[>\])}"'`,;.!]+$/g, '');
  if (!candidate) return null;
  if (!/^https?:\/\//i.test(candidate)) candidate = `https://${candidate}`;

  try {
    const parsed = new URL(candidate);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
    const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
    const isFacebook = host === 'facebook.com'
      || host.endsWith('.facebook.com')
      || host === 'fb.com'
      || host.endsWith('.fb.com')
      || host === 'fb.watch';
    if (!isFacebook || (parsed.pathname === '/' && !parsed.search)) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function extractFacebookUrl(...values) {
  const text = values.flat(Infinity).map((value) => String(value || '')).join(' ');
  const matches = text.match(/(?:https?:\/\/)?(?:www\.)?(?:[a-z0-9-]+\.)*(?:facebook\.com|fb\.com|fb\.watch)\/[^\s<>"'`]+/gi) || [];
  for (const match of matches) {
    const url = cleanLinkCandidate(match);
    if (url) return url;
  }
  return cleanLinkCandidate(text);
}

function qualityScore(value = '') {
  const text = String(value)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase();
  const dimensions = text.match(/(?:^|\D)(\d{3,4})\s*[x×]\s*(\d{3,4})(?:\D|$)/);
  if (dimensions) {
    const height = Number(dimensions[2]);
    if (height >= 1080) return 4;
    if (height >= 720) return 3;
    if (height <= 480) return 1;
  }
  const numeric = text.match(/(?:^|\D)(2160|1440|1080|960|720|540|480|360|240)(?:p)?(?:\D|$)/);
  if (numeric) {
    const height = Number(numeric[1]);
    if (height >= 1080) return 4;
    if (height >= 720) return 3;
    return 1;
  }
  if (/\b(?:uhd|4k|full\s*hd|1080p)\b/.test(text)) return 4;
  if (/\b(?:hd|high|best|original)\b/.test(text)) return 3;
  if (/\b(?:sd|low|standard)\b/.test(text)) return 1;
  return 2;
}

function qualityName(score) {
  if (score >= 3) return 'HD';
  if (score <= 1) return 'SD';
  return 'Best available';
}

function normalizeFacebookCandidates(payload, source = 'provider') {
  const candidates = [];
  const seen = new Map();

  function add(value, hint, metadata = {}) {
    const url = typeof value === 'string' ? value.trim() : '';
    const directBuffer = Buffer.isBuffer(value) ? value : null;
    if (!url && !directBuffer) return;

    let safeUrl = null;
    if (url) {
      try {
        const parsed = new URL(url);
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return;
        const host = parsed.hostname.toLowerCase();
        if (!host || host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '::1') return;
        safeUrl = parsed.toString();
      } catch {
        return;
      }
    }

    const descriptor = [
      hint,
      metadata.quality,
      metadata.resolution,
      metadata.label,
      metadata.format,
      metadata.width && metadata.height ? `${metadata.width}x${metadata.height}` : '',
      metadata.height,
    ].filter(Boolean).join(' ');
    const score = qualityScore(descriptor);
    const key = safeUrl || `buffer:${source}:${directBuffer.length}:${metadata.contentType || ''}`;
    const candidate = {
      url: safeUrl,
      buffer: directBuffer || (Buffer.isBuffer(metadata.buffer) ? metadata.buffer : null),
      contentType: metadata.contentType || metadata.mimetype || '',
      title: String(metadata.title || metadata.caption || metadata.name || 'Facebook video').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 180),
      source,
      score,
      quality: qualityName(score),
    };
    const existing = seen.get(key);
    if (existing) {
      if (candidate.score > existing.score) Object.assign(existing, candidate);
      return;
    }
    seen.set(key, candidate);
    candidates.push(candidate);
  }

  function visit(value, pathHint = '', parentMetadata = {}, depth = 0) {
    if (depth > 8 || value == null) return;
    if (Buffer.isBuffer(value)) {
      add(value, pathHint, parentMetadata);
      return;
    }
    if (typeof value === 'string') {
      if (/^https?:\/\//i.test(value.trim())) add(value, pathHint, parentMetadata);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 100)) visit(item, pathHint, parentMetadata, depth + 1);
      return;
    }
    if (typeof value !== 'object') return;

    const metadata = {
      ...parentMetadata,
      title: value.title || value.caption || value.name || parentMetadata.title,
      quality: value.quality || value.video_quality || parentMetadata.quality,
      resolution: value.resolution || value.size || parentMetadata.resolution,
      width: value.width || parentMetadata.width,
      height: value.height || parentMetadata.height,
      label: value.label || parentMetadata.label,
      format: value.format || value.type || parentMetadata.format,
      contentType: value.contentType || value.content_type || value.mimetype || parentMetadata.contentType,
      buffer: Buffer.isBuffer(value.buffer) ? value.buffer : parentMetadata.buffer,
    };

    if (Buffer.isBuffer(value.buffer)) add(value.buffer, pathHint, metadata);

    for (const [key, child] of Object.entries(value)) {
      if (IMAGE_OR_METADATA_KEYS.test(key)) continue;
      const keyHint = `${pathHint} ${key}`;
      if (typeof child === 'string' && VIDEO_URL_KEYS.test(key)) {
        add(child, keyHint, metadata);
        continue;
      }
      visit(child, keyHint, metadata, depth + 1);
    }
  }

  visit(payload);
  return candidates.sort((a, b) => b.score - a.score);
}

function inspectFacebookVideo(input, contentType = '', maxBytes = 150 * 1024 * 1024) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
  if (buffer.length > maxBytes) {
    throw makeError('FB_FILE_TOO_LARGE', 'Facebook video exceeds the configured download size limit.');
  }
  if (buffer.length < 1024) {
    throw makeError('FB_INVALID_VIDEO', 'Facebook provider returned an empty or incomplete media file.');
  }

  const prefix = buffer.subarray(0, Math.min(buffer.length, 512)).toString('utf8').trimStart().toLowerCase();
  const mime = String(contentType || '').split(';', 1)[0].trim().toLowerCase();
  if (mime.includes('json') || mime.startsWith('text/html') || prefix.startsWith('<!doctype html') || prefix.startsWith('<html') || prefix.startsWith('{') || prefix.startsWith('[')) {
    throw makeError('FB_INVALID_VIDEO', 'Facebook provider returned an error page or JSON instead of a video.');
  }

  const ftypAt = buffer.indexOf('ftyp', 0, 'ascii');
  if (ftypAt >= 0 && ftypAt < 64) return { buffer, mimetype: 'video/mp4', extension: '.mp4' };
  if (buffer.length >= 4 && buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
    return { buffer, mimetype: 'video/webm', extension: '.webm' };
  }
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'AVI ') {
    return { buffer, mimetype: 'video/x-msvideo', extension: '.avi' };
  }
  if (mime.startsWith('video/') && !mime.includes('quicktime')) {
    throw makeError('FB_INVALID_VIDEO', 'Facebook provider returned a video response with an unsupported or incomplete file signature.');
  }
  throw makeError('FB_INVALID_VIDEO', 'Facebook provider returned a page, image, or unsupported file instead of a playable video.');
}

function maxFacebookBytes() {
  const configuredMb = Number(process.env.FB_MAX_VIDEO_MB);
  const mb = Number.isFinite(configuredMb) && configuredMb >= 10
    ? Math.min(configuredMb, 1024)
    : 150;
  return Math.floor(mb * 1024 * 1024);
}

function toDownloadError(error, response) {
  const status = Number(response?.status || error?.response?.status || 0);
  if (status && (status < 200 || status >= 300)) {
    return makeError('FB_HTTP_ERROR', 'Facebook media host rejected the download link.', { status });
  }
  if (error?.code === 'FB_FILE_TOO_LARGE' || error?.code === 'FB_INVALID_VIDEO') return error;
  if (error?.code === 'ECONNABORTED' || error?.code === 'ETIMEDOUT') {
    return makeError('FB_MEDIA_TIMEOUT', 'The Facebook media host timed out.');
  }
  return makeError('FB_MEDIA_DOWNLOAD_FAILED', 'The Facebook media link could not be downloaded.');
}

async function resolveAndDownloadFacebook(inputUrl, providers = [], options = {}) {
  const url = cleanLinkCandidate(inputUrl);
  if (!url) throw makeError('FB_INVALID_URL', 'Send a public Facebook video link or reply to a message containing one.');

  const download = options.download;
  if (typeof download !== 'function') throw makeError('FB_INTERNAL', 'Facebook download transport is not configured.');
  const maxBytes = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : maxFacebookBytes();
  const candidates = [];
  const providerErrors = [];
  const attempted = new Set();
  let lastDownloadError = null;

  async function tryCandidate(candidate) {
    const key = candidate.url || `buffer:${candidate.source}:${candidate.buffer?.length || 0}`;
    if (attempted.has(key)) return null;
    attempted.add(key);
    let response;
    try {
      response = candidate.buffer
        ? { data: candidate.buffer, status: 200, headers: { 'content-type': candidate.contentType } }
        : await download(candidate.url, candidate);
      const status = Number(response?.status ?? 200);
      if (status < 200 || status >= 300) throw makeError('FB_HTTP_ERROR', 'Facebook media host rejected the download link.', { status });
      const data = Buffer.isBuffer(response)
        ? response
        : Buffer.isBuffer(response?.buffer)
          ? response.buffer
          : Buffer.from(response?.data || []);
      const contentType = response?.contentType || response?.headers?.['content-type'] || candidate.contentType;
      const media = inspectFacebookVideo(data, contentType, maxBytes);
      return {
        ...media,
        title: candidate.title || 'Facebook video',
        source: candidate.source,
        quality: candidate.quality,
        score: candidate.score,
      };
    } catch (error) {
      lastDownloadError = toDownloadError(error, response);
      return null;
    }
  }

  for (const provider of providers) {
    const name = provider?.name || 'Facebook provider';
    if (typeof provider?.fetch !== 'function') continue;
    try {
      const payload = await provider.fetch(url);
      candidates.push(...normalizeFacebookCandidates(payload, name));
    } catch {
      providerErrors.push(name);
    }

    const highQuality = candidates
      .filter((candidate) => candidate.score >= 3)
      .sort((a, b) => b.score - a.score);
    for (const candidate of highQuality) {
      const media = await tryCandidate(candidate);
      if (media) return media;
    }
  }

  for (const candidate of candidates.sort((a, b) => b.score - a.score)) {
    const media = await tryCandidate(candidate);
    if (media) return media;
  }

  if (!candidates.length) {
    throw makeError('FB_NO_SOURCE', 'No provider returned a downloadable video. The post may be private, restricted, or not a video.', {
      providersTried: providers.length,
      failedProviders: providerErrors,
    });
  }
  throw lastDownloadError || makeError('FB_MEDIA_DOWNLOAD_FAILED', 'Every provider returned a link that failed media validation.');
}

function formatFacebookError(error) {
  switch (error?.code) {
    case 'FB_INVALID_URL':
      return '❌ Send a valid, public Facebook video URL or reply to a message containing the link.';
    case 'FB_NO_SOURCE':
      return '❌ No provider found a downloadable video. The post may be private, age-restricted, geo-blocked, expired, or not a video.';
    case 'FB_FILE_TOO_LARGE':
      return '❌ The video is larger than the configured download limit. Try a shorter clip or lower quality.';
    case 'FB_INVALID_VIDEO':
      return '❌ A provider returned an error page or unsupported file instead of a playable video. Try sharing the public video link again.';
    case 'FB_HTTP_ERROR':
      return `❌ The media server rejected its download link${error.status ? ` (HTTP ${error.status})` : ''}. The link may have expired; try again.`;
    case 'FB_MEDIA_TIMEOUT':
      return '❌ The media server timed out. Check the link and try again in a moment.';
    case 'FB_SEND_FAILED':
      return '❌ WhatsApp could not send the video or its file fallback. Try a shorter video or document mode.';
    case 'FB_AUDIO_FAILED':
      return '❌ Audio extraction failed. Try the normal video mode, or check that the server has its video tools installed.';
    default:
      return '❌ Facebook download failed after trying the available providers. Confirm the post is public and try again.';
  }
}

function createFacebookCommand(dependencies = {}) {
  return async function facebookCommand(sock, msg, args = []) {
    const jid = msg?.key?.remoteJid || '';
    const prefix = typeof dependencies.getPrefix === 'function' ? dependencies.getPrefix() : '.';
    const quotedText = typeof dependencies.getQuotedText === 'function'
      ? dependencies.getQuotedText(msg)
      : extractTextFromMessage(msg?.messageContext || {});
    const url = extractFacebookUrl(Array.isArray(args) ? args.join(' ') : args, quotedText);
    const mode = String(Array.isArray(args) ? args[1] || '' : '').trim().toLowerCase();
    let statusKey = null;

    const safeReact = async (emoji) => {
      try { await dependencies.react?.(sock, msg, emoji); } catch {}
    };
    const updateStatus = async (text) => {
      if (!statusKey || typeof dependencies.editStatus !== 'function') return;
      try { await dependencies.editStatus(sock, msg, statusKey, text); } catch {}
    };
    const usage = `Usage: ${prefix}fb <Facebook video URL> [hd|video|audio|doc]\nYou can also reply to a message containing a Facebook link and send ${prefix}fb.`;

    await safeReact('🌀');
    if (!url) {
      await safeReact('❌');
      const hasInput = (Array.isArray(args) && args.length > 0) || Boolean(quotedText);
      const message = hasInput ? `${formatFacebookError({ code: 'FB_INVALID_URL' })}\n\n${usage}` : usage;
      await dependencies.sendReply?.(sock, msg, message);
      return { ok: false, error: 'FB_INVALID_URL' };
    }

    try {
      const status = await dependencies.sendStatus?.(sock, msg, '🌀 Fetching Facebook video links (HD first)…');
      statusKey = status?.key || null;
    } catch {}

    try {
      const media = await dependencies.resolveMedia(url);
      const title = String(media.title || 'Facebook video').slice(0, 180);
      const quality = media.quality || 'Best available';
      const caption = `📘 *Facebook · ${quality}*\n\n${title}`;
      await updateStatus(`🌀 Downloaded ${quality} source. Sending the original video without re-encoding…`);

      let deliveredAs;
      if (mode === 'audio') {
        let audio;
        try {
          audio = await dependencies.extractAudio(media.buffer, media);
        } catch {
          throw makeError('FB_AUDIO_FAILED', 'Audio extraction failed.');
        }
        if (!Buffer.isBuffer(audio) || audio.length < 100) throw makeError('FB_AUDIO_FAILED', 'Audio extraction produced no usable audio.');
        await dependencies.sendAudio(sock, msg, audio, { title, mimetype: 'audio/mpeg' });
        deliveredAs = 'audio';
      } else if (mode === 'doc' || mode === 'document') {
        await dependencies.sendDocument(sock, msg, media, { caption });
        deliveredAs = 'file';
      } else {
        try {
          await dependencies.sendVideo(sock, msg, media, { caption });
          deliveredAs = 'video';
        } catch {
          try {
            await dependencies.sendDocument(sock, msg, media, { caption });
            deliveredAs = 'file';
          } catch {
            throw makeError('FB_SEND_FAILED', 'WhatsApp rejected both video and document delivery.');
          }
        }
      }

      await updateStatus(`✅ Facebook ${quality} ${deliveredAs} delivered.\n\n${title}`);
      await safeReact('✅');
      return { ok: true, url, quality, deliveredAs };
    } catch (error) {
      const message = formatFacebookError(error);
      await updateStatus(message);
      if (!statusKey) {
        try { await dependencies.sendReply?.(sock, msg, message); } catch {}
      }
      await safeReact('❌');
      return { ok: false, error: error?.code || 'FB_DOWNLOAD_FAILED', message };
    }
  };
}

module.exports = {
  cleanLinkCandidate,
  extractFacebookUrl,
  qualityScore,
  qualityName,
  normalizeFacebookCandidates,
  inspectFacebookVideo,
  maxFacebookBytes,
  resolveAndDownloadFacebook,
  formatFacebookError,
  createFacebookCommand,
};
