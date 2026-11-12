'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveExternalUrl, normalizeUrl } = require('../lib/keepAlive.cjs');

test('Railway public domain becomes the health-check URL', () => {
  assert.equal(
    resolveExternalUrl({ RAILWAY_PUBLIC_DOMAIN: 'bot-production.up.railway.app' }),
    'https://bot-production.up.railway.app/health'
  );
});

test('Render external URL is used when set by the platform', () => {
  assert.equal(
    resolveExternalUrl({ RENDER_EXTERNAL_URL: 'https://bot.onrender.com' }),
    'https://bot.onrender.com/health'
  );
});

test('RENDER_URL (Prince MDX variable name) is accepted', () => {
  assert.equal(
    resolveExternalUrl({ RENDER_URL: 'https://bot.onrender.com' }),
    'https://bot.onrender.com/health'
  );
});

test('an explicit APP_URL wins over platform defaults', () => {
  assert.equal(
    resolveExternalUrl({ APP_URL: 'https://mine.example.com', RAILWAY_PUBLIC_DOMAIN: 'x.up.railway.app' }),
    'https://mine.example.com/health'
  );
});

test('no public URL means no external ping', () => {
  assert.equal(resolveExternalUrl({}), null);
});

test('normalizeUrl adds https and keeps an existing path', () => {
  assert.equal(normalizeUrl('bot.example.com'), 'https://bot.example.com/health');
  assert.equal(normalizeUrl('https://bot.example.com/custom'), 'https://bot.example.com/custom');
});
