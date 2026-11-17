'use strict';
// Resolves tmpfiles.org web pages to their direct download link.
// Only https links on tmpfiles.org are followed, so a page cannot send the bot to another host.

const TMPFILES_HOST = /^(?:[a-z0-9-]+\.)*tmpfiles\.org$/i;

function isTmpfilesUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && TMPFILES_HOST.test(u.hostname);
  } catch {
    return false;
  }
}

function isHtml(contentType) {
  return /text\/html/i.test(String(contentType || ''));
}

// Returns the absolute download URL from a tmpfiles page, or null when none is found.
function extractDownloadUrl(html, pageUrl) {
  const tags = String(html || '').match(/<a\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const isDownload = /\bclass\s*=\s*["'][^"']*\bdownload\b[^"']*["']/i.test(tag) || /\sdownload(\s|=|>)/i.test(tag);
    if (!isDownload) continue;
    const m = tag.match(/\bhref\s*=\s*["']([^"']+)["']/i);
    if (!m) continue;
    const href = m[1].replace(/&amp;/g, '&');
    try {
      const abs = new URL(href, pageUrl);
      if (abs.protocol === 'https:' && TMPFILES_HOST.test(abs.hostname) && abs.pathname.startsWith('/dl/')) {
        return abs.href;
      }
    } catch { /* skip malformed href */ }
  }
  return null;
}

// Decides whether a fetched response is a tmpfiles web page that should be replaced by its download link.
function resolveTmpfilesDownload({ contentType, url, body }) {
  if (!isTmpfilesUrl(url) || !isHtml(contentType)) return null;
  const html = Buffer.isBuffer(body) ? body.toString('utf8') : Buffer.from(body || '').toString('utf8');
  const direct = extractDownloadUrl(html, url);
  if (!direct || direct === url) return null;
  return direct;
}

module.exports = { isTmpfilesUrl, extractDownloadUrl, resolveTmpfilesDownload };
