const test = require('node:test');
const assert = require('node:assert/strict');
const sp = require('../sessionPersistence.cjs');

const KEYS = ['STORAGE_MODE', 'RAILWAY_SESSION_DATABASE_URL', 'SESSION_DATABASE_URL',
  'SESSION_DB_URL', 'SESSIONS_DATABASE_URL', 'RAILWAY_DATABASE_URL'];

function withEnv(env, fn) {
  const saved = {};
  for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, env);
  try { return fn(); } finally {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
}

test('JSON mode with no session URL stays on the volume', () => {
  withEnv({ STORAGE_MODE: 'json' }, () => assert.equal(sp.getDatabaseUrl(), ''));
});

test('JSON mode never uses the main app database URL', () => {
  withEnv({ STORAGE_MODE: 'json', RAILWAY_DATABASE_URL: 'postgres://main' },
    () => assert.equal(sp.getDatabaseUrl(), ''));
});

test('an explicit session URL is used even in JSON mode', () => {
  withEnv({ STORAGE_MODE: 'json', SESSION_DATABASE_URL: 'postgres://sess' },
    () => assert.equal(sp.getDatabaseUrl(), 'postgres://sess'));
});

test('an explicit session URL beats the main URL in postgres mode', () => {
  withEnv({ STORAGE_MODE: 'postgres', SESSION_DATABASE_URL: 'postgres://sess', RAILWAY_DATABASE_URL: 'postgres://main' },
    () => assert.equal(sp.getDatabaseUrl(), 'postgres://sess'));
});

test('postgres mode without a session URL falls back to the main URL', () => {
  withEnv({ STORAGE_MODE: 'postgres', RAILWAY_DATABASE_URL: 'postgres://main' },
    () => assert.equal(sp.getDatabaseUrl(), 'postgres://main'));
});
