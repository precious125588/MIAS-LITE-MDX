'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveExternalUrl, normalizeUrl, startKeepAlive, stopKeepAlive } = require('../lib/keepAlive.cjs');

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

test('Railway with no public URL uses the 12-minute fallback interval', () => {
  const keys = ['RAILWAY_PROJECT_ID', 'RAILWAY_PUBLIC_DOMAIN', 'RENDER_URL', 'APP_URL', 'SELF_PING_INTERVAL_MINUTES', 'KEEP_ALIVE_INTERVAL_MS', 'KEEP_ALIVE_SUPERVISOR_ACTIVE', 'PORT'];
  const saved = {};
  for (const key of keys) { saved[key] = process.env[key]; delete process.env[key]; }
  process.env.RAILWAY_PROJECT_ID = 'test-project';
  stopKeepAlive();
  try {
    const result = startKeepAlive({ port: 0 });
    assert.equal(result.started, true);
    assert.equal(result.externalUrl, null);
    assert.equal(result.intervalMinutes, 12);
  } finally {
    stopKeepAlive();
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  }
});

test('Optlink and panel URLs are accepted', () => {
  assert.equal(
    resolveExternalUrl({ OPTLINK_URL: 'https://mybot.optlink.app' }),
    'https://mybot.optlink.app/health'
  );
  assert.equal(
    resolveExternalUrl({ PANEL_URL: 'https://panel.example.com/custom' }),
    'https://panel.example.com/custom'
  );
  assert.equal(
    resolveExternalUrl({ SERVER_IP: '192.168.1.100', SERVER_PORT: '8080' }),
    'http://192.168.1.100:8080/health'
  );
});

test('isPanelEnvironment detects Optlink and Pterodactyl variables', () => {
  const { isPanelEnvironment } = require('../lib/keepAlive.cjs');
  assert.equal(isPanelEnvironment({ OPTLINK: 'true' }), true);
  assert.equal(isPanelEnvironment({ P_SERVER_UUID: 'abc-123' }), true);
  assert.equal(isPanelEnvironment({ SERVER_PORT: '25565' }), true);
  assert.equal(isPanelEnvironment({ PANEL_MODE: '1' }), true);
  assert.equal(isPanelEnvironment({}), false);
});
