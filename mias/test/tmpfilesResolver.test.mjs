import test from 'node:test';
import assert from 'node:assert/strict';
import resolver from '../lib/tmpfilesResolver.cjs';

const { isTmpfilesUrl, extractDownloadUrl, resolveTmpfilesDownload } = resolver;

// Trimmed copy of a real tmpfiles.org page: a promo link, then the download link.
const PAGE = `
<div class="topbar-promo">Use <a href="https://onlyfiles.com" target="_blank" rel="noopener noreferrer">Only<b>Files</b></a></div>
<h2 class="file-title">file.mp3</h2>
<p><a class="download" href="https://tmpfiles.org/dl/1794954368.b9633514e4376c57/wTA2tNjwmRD0/file.mp3">Download (764.77 KB)</a></p>
<p class="file-meta">File expires in 58 minutes</p>`;
const PAGE_URL = 'https://tmpfiles.org/dl/wTA2tNjwmRD0/file.mp3';
const DIRECT = 'https://tmpfiles.org/dl/1794954368.b9633514e4376c57/wTA2tNjwmRD0/file.mp3';

test('extracts the direct download link and ignores the promo link', () => {
  assert.equal(extractDownloadUrl(PAGE, PAGE_URL), DIRECT);
});

test('resolves a relative download href against the page URL', () => {
  const html = '<a class="download" href="/dl/abc123/x.mp3">Download</a>';
  assert.equal(extractDownloadUrl(html, PAGE_URL), 'https://tmpfiles.org/dl/abc123/x.mp3');
});

test('decodes &amp; in the href', () => {
  const html = '<a class="download" href="https://tmpfiles.org/dl/a/b.mp3?x=1&amp;y=2">Download</a>';
  assert.equal(extractDownloadUrl(html, PAGE_URL), 'https://tmpfiles.org/dl/a/b.mp3?x=1&y=2');
});

test('returns null when the page has no download link', () => {
  assert.equal(extractDownloadUrl('<p>File not found</p>', PAGE_URL), null);
  assert.equal(extractDownloadUrl('', PAGE_URL), null);
});

test('refuses download links on other hosts or outside /dl/', () => {
  const evil = '<a class="download" href="https://evil.example/dl/a/b.mp3">Download</a>';
  const lookalike = '<a class="download" href="https://tmpfiles.org.evil.example/dl/a/b.mp3">Download</a>';
  const notDl = '<a class="download" href="https://tmpfiles.org/about">Download</a>';
  const http = '<a class="download" href="http://tmpfiles.org/dl/a/b.mp3">Download</a>';
  for (const html of [evil, lookalike, notDl, http]) assert.equal(extractDownloadUrl(html, PAGE_URL), null);
});

test('isTmpfilesUrl accepts https tmpfiles.org hosts only', () => {
  assert.equal(isTmpfilesUrl('https://tmpfiles.org/dl/a/b.mp3'), true);
  assert.equal(isTmpfilesUrl('https://www.tmpfiles.org/x'), true);
  assert.equal(isTmpfilesUrl('http://tmpfiles.org/x'), false);
  assert.equal(isTmpfilesUrl('https://tmpfiles.org.evil.example/x'), false);
  assert.equal(isTmpfilesUrl('not a url'), false);
});

test('resolveTmpfilesDownload only acts on HTML from a tmpfiles page', () => {
  const body = Buffer.from(PAGE);
  assert.equal(resolveTmpfilesDownload({ contentType: 'text/html; charset=utf-8', url: PAGE_URL, body }), DIRECT);
  // Real audio bytes are never scanned: non-HTML responses pass through untouched.
  assert.equal(resolveTmpfilesDownload({ contentType: 'audio/mpeg', url: PAGE_URL, body }), null);
  // HTML from another site is left alone.
  assert.equal(resolveTmpfilesDownload({ contentType: 'text/html', url: 'https://example.com/x', body }), null);
  // Already pointing at the direct link: nothing to resolve.
  assert.equal(resolveTmpfilesDownload({ contentType: 'text/html', url: DIRECT, body }), null);
});
