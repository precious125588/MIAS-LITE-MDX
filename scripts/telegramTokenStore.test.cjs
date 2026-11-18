'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-token-'));
process.env.MIAS_SECRETS_DIR = DIR;
const BOOT = '111111111:AAAbbbCCCdddEEEfffGGGhhhIIIjjjKKKlll';
const SAVED = '222222222:AAAbbbCCCdddEEEfffGGGhhhIIIjjjKKKmmm';

function fresh() {
  for (const k of Object.keys(require.cache)) if (k.includes('telegramToken')) delete require.cache[k];
  return {
    store: require('../lib/telegramTokenStore.cjs'),
    cmd: require('../lib/telegramTokenCommand.cjs'),
  };
}

function fakeSock() {
  const sent = [];
  return { sent, sendMessage: async (jid, content) => { sent.push({ jid, content }); } };
}
const owner = (extra = {}) => ({ key: { remoteJid: '234801@s.whatsapp.net', fromMe: true, id: 'M1', ...extra }, message: {} });
const stranger = { key: { remoteJid: '999@s.whatsapp.net', participant: '999@s.whatsapp.net', fromMe: false, id: 'M2' }, message: {} };

test('token format validation', () => {
  const { store } = fresh();
  assert.equal(store.isValidTelegramToken(BOOT), true);
  assert.equal(store.isValidTelegramToken('not-a-token'), false);
  assert.equal(store.isValidTelegramToken('123:short'), false);
  assert.equal(store.isValidTelegramToken(''), false);
});

test('save then read back, file is private, nothing else leaks', () => {
  const { store } = fresh();
  store.saveStoredToken(SAVED, { botUsername: 'mias_bot' });
  assert.equal(store.readStoredToken(), SAVED);
  assert.equal(store.readStoredMeta().botUsername, 'mias_bot');
  const mode = fs.statSync(store.storeFile()).mode & 0o777;
  assert.equal(mode, 0o600);
  assert.ok(store.storeFile().startsWith(DIR));
});

test('saved token overrides the panel env token and survives a fresh process state', () => {
  const { store } = fresh();
  process.env.TELEGRAM_BOT_TOKEN = BOOT;
  store.saveStoredToken(SAVED);
  // simulate a restart: new module instance, env reset by the panel to the old value
  process.env.TELEGRAM_BOT_TOKEN = BOOT;
  const again = fresh().store;
  assert.equal(again.loadIntoEnv(), 'saved');
  assert.equal(process.env.TELEGRAM_BOT_TOKEN, SAVED);
});

test('corrupt or invalid saved file is ignored, env token still used', () => {
  const { store } = fresh();
  fs.writeFileSync(store.storeFile(), '{not json');
  process.env.TELEGRAM_BOT_TOKEN = BOOT;
  assert.equal(store.readStoredToken(), '');
  assert.equal(store.loadIntoEnv(), 'env');
  assert.equal(process.env.TELEGRAM_BOT_TOKEN, BOOT);
  fs.writeFileSync(store.storeFile(), JSON.stringify({ token: 'bogus' }));
  assert.equal(store.readStoredToken(), '');
});

test('clear removes the saved token and restores the panel env token', () => {
  const { store } = fresh();
  process.env.TELEGRAM_BOT_TOKEN = BOOT;
  store.loadIntoEnv();
  store.saveStoredToken(SAVED);
  assert.equal(process.env.TELEGRAM_BOT_TOKEN, SAVED);
  store.clearStoredToken();
  assert.equal(fs.existsSync(store.storeFile()), false);
  assert.equal(process.env.TELEGRAM_BOT_TOKEN, BOOT);
});

test('.settoken <token>: owner, valid on Telegram, saved, reply never echoes token, chat message deleted', async () => {
  const { store, cmd } = fresh();
  const replies = [];
  const sock = fakeSock();
  const axios = { get: async (url) => {
    assert.ok(url.endsWith('/getMe'));
    return { status: 200, data: { ok: true, result: { username: 'mias_bot' } } };
  } };
  const handler = cmd.createSetTokenHandler({ sendReply: async (s, m, t) => replies.push(t), react: async () => {}, axios, log: console });
  await handler(sock, owner(), [SAVED]);
  assert.equal(store.readStoredToken(), SAVED);
  assert.equal(replies.length, 1);
  assert.match(replies[0], /saved for @mias_bot/);
  assert.ok(!replies[0].includes(SAVED), 'reply must not contain the full token');
  assert.equal(sock.sent.length, 1, 'owner message holding the token is deleted');
  assert.equal(sock.sent[0].content.delete.id, 'M1');
});

test('.settoken rejected by Telegram (401) is not saved', async () => {
  const { store, cmd } = fresh();
  store.clearStoredToken();
  const replies = [];
  const axios = { get: async () => ({ status: 401, data: { ok: false, error_code: 401, description: 'Unauthorized' } }) };
  const handler = cmd.createSetTokenHandler({ sendReply: async (s, m, t) => replies.push(t), react: async () => {}, axios });
  await handler(fakeSock(), owner(), [SAVED]);
  assert.equal(store.readStoredToken(), '');
  assert.match(replies[0], /rejected/);
});

test('.settoken saves with a warning when Telegram cannot be reached', async () => {
  const { store, cmd } = fresh();
  const replies = [];
  const axios = { get: async () => { throw new Error('getaddrinfo ENOTFOUND api.telegram.org'); } };
  const handler = cmd.createSetTokenHandler({ sendReply: async (s, m, t) => replies.push(t), react: async () => {}, axios, log: { warn() {}, error() {} } });
  await handler(fakeSock(), owner(), [SAVED]);
  assert.equal(store.readStoredToken(), SAVED);
  assert.match(replies[0], /could not be reached/);
});

test('.settoken is refused for non-owners and nothing changes', async () => {
  const { store, cmd } = fresh();
  store.clearStoredToken();
  const replies = [];
  let called = false;
  const axios = { get: async () => { called = true; return { status: 200, data: { ok: true, result: {} } }; } };
  const handler = cmd.createSetTokenHandler({ sendReply: async (s, m, t) => replies.push(t), react: async () => {}, axios });
  await handler(fakeSock(), stranger, [SAVED]);
  assert.equal(store.readStoredToken(), '');
  assert.equal(called, false);
  assert.match(replies[0], /Only the bot owner/);
});

test('.settoken with junk input is rejected without a Telegram call', async () => {
  const { store, cmd } = fresh();
  store.clearStoredToken();
  const replies = [];
  let called = false;
  const axios = { get: async () => { called = true; return {}; } };
  const handler = cmd.createSetTokenHandler({ sendReply: async (s, m, t) => replies.push(t), react: async () => {}, axios });
  await handler(fakeSock(), owner(), ['hello']);
  assert.equal(called, false);
  assert.equal(store.readStoredToken(), '');
  assert.match(replies[0], /not a valid bot token/);
});

test('.settoken status shows only the masked token and where it comes from', async () => {
  const { store, cmd } = fresh();
  store.saveStoredToken(SAVED, { botUsername: 'mias_bot' });
  const replies = [];
  const handler = cmd.createSetTokenHandler({ sendReply: async (s, m, t) => replies.push(t), react: async () => {}, axios: {} });
  await handler(fakeSock(), owner(), []);
  assert.match(replies[0], /…Kmmm/);
  assert.match(replies[0], /persistent/);
  assert.ok(!replies[0].includes(SAVED));
});

test('.settoken clear removes the saved token', async () => {
  const { store, cmd } = fresh();
  store.saveStoredToken(SAVED);
  const replies = [];
  const handler = cmd.createSetTokenHandler({ sendReply: async (s, m, t) => replies.push(t), react: async () => {}, axios: {} });
  await handler(fakeSock(), owner(), ['clear']);
  assert.equal(store.readStoredToken(), '');
  assert.match(replies[0], /removed/);
});
