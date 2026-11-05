'use strict';

function isHttpUrl(value) {
  try {
    const u = new URL(String(value || ''));
    return (u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password;
  } catch { return false; }
}

function pickPrexzyVideo(data) {
  const d = data?.result || data?.data || data;
  const url = d?.download_url || d?.url || d?.video || d?.download;
  if (!isHttpUrl(url)) return null;
  return { url: String(url), title: d?.info?.title || d?.title || data?.info?.title || data?.title || 'YouTube' };
}

function hintedBytes(media) {
  const direct = Number(media?.filesize || media?.fileSize || media?.size || 0);
  if (Number.isFinite(direct) && direct > 0) return direct;
  try {
    const n = Number(new URL(media.url).searchParams.get('clen'));
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch { return 0; }
}

function quality(media) {
  const n = Number(media?.height || String(media?.quality || media?.label || '').match(/(\d{3,4})p?/i)?.[1] || 0);
  return Number.isFinite(n) ? n : 0;
}

function pickNexrayVideo(data, { maxBytes = 0 } = {}) {
  const root = data?.result || data?.data || data;
  if (!Array.isArray(root?.medias)) return null;
  let variants = root.medias.filter(m => m && String(m.type || '').toLowerCase() === 'video' && isHttpUrl(m.url));
  if (maxBytes > 0) {
    const withinLimit = variants.filter(m => !hintedBytes(m) || hintedBytes(m) <= maxBytes);
    if (withinLimit.length) variants = withinLimit;
  }
  if (!variants.length) return null;
  variants.sort((a, b) => quality(b) - quality(a));
  // Keep audio whenever a muxed format is offered, selecting the highest
  // resolution with audio first; otherwise use the highest playable video.
  const muxed = variants.filter(m => m.is_audio === true || /audio\//i.test(String(m.mimeType || '')));
  const selected = muxed[0] || variants[0];
  return { url: String(selected.url), title: root?.title || selected.title || 'YouTube', type: 'video', height: quality(selected), hasAudio: muxed.includes(selected) };
}

// Audio endpoints use either a top-level download_url (Prexzy), nested
// downloadUrl (Prince), or result.medias (NexRay). Never choose the source
// YouTube page or a video-only format as an audio download.
function pickAudio(data) {
  if (!data || data.status === false || data.success === false || data.error === true) return null;
  const root = data.result || data.data || data;
  const candidates = Array.isArray(root.medias)
    ? root.medias.filter(m => m && String(m.type || '').toLowerCase() === 'audio')
    : [root];
  const formats = { mp3: ['audio/mpeg', '.mp3'], m4a: ['audio/mp4', '.m4a'],
    aac: ['audio/aac', '.aac'], ogg: ['audio/ogg', '.ogg'], opus: ['audio/webm', '.webm'],
    webm: ['audio/webm', '.webm'], flac: ['audio/flac', '.flac'], wav: ['audio/wav', '.wav'] };
  const choices = [];
  for (const item of candidates) {
    const url = item.downloadUrl || item.download_url || item.audio || item.mp3 || item.url;
    if (!isHttpUrl(url)) continue;
    const host = new URL(url).hostname.toLowerCase();
    if (/(^|\.)(youtube\.com|youtu\.be)$/.test(host)) continue;
    const ext = String(item.ext || root.ext || new URL(url).pathname.split('.').pop() || '').toLowerCase();
    const format = formats[ext] || ['audio/mpeg', '.mp3'];
    choices.push({ url: String(url), title: root.info?.title || root.title || data.info?.title,
      author: root.info?.uploader || root.author || data.info?.uploader,
      mime: format[0], ext: format[1] });
  }
  // Prefer containers playable directly by WhatsApp over WebM/Opus streams.
  choices.sort((a, b) => Number(b.ext === '.mp3' || b.ext === '.m4a') - Number(a.ext === '.mp3' || a.ext === '.m4a'));
  return choices[0] || null;
}

module.exports = { isHttpUrl, pickPrexzyVideo, pickNexrayVideo, pickAudio };
