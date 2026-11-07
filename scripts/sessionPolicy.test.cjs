'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { sessionDigits, parseDiscardSessions, matchesSession, shouldPruneSession,
  initializeSessionDirectory, connectedWorkerStatus } = require('./sessionPolicy.cjs');
const bootstrap = require('./sessionBootstrap.cjs');
const startup = require('./start-with-session-migration.cjs');
const store = require('../mias/sessionPersistence.cjs');
const { restoreSessionFromSessionId: restoreSession } = require('../mias/lib/sessionRestore.cjs');
const ROOT = path.join(__dirname, '..');
const A = '15550001001', B = '15550001002';
const jid = n => n + '@s.whatsapp.net';
function creds(number = A, name = 'Test Owner', counter = 0) {
  return { registered: true, me: { id: number + ':7@s.whatsapp.net', name },
    noiseKey: { private: { type: 'Buffer', data: 'AQI=' }, public: { type: 'Buffer', data: 'AwQ=' } },
    signedIdentityKey: { private: { type: 'Buffer', data: 'BQY=' }, public: { type: 'Buffer', data: 'Bwg=' } },
    accountSyncCounter: counter };
}
function boot(number = A, value = creds(number)) {
  return { canonicalJid: jid(number), digits: number, credsObj: value, sessionUserName: value.me.name, pushName: value.me.name };
}
function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mias-regression-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function environment(t, values) {
  const prior = { ...process.env };
  for (const key of ['SESSION_ID', 'RESET_SESSIONS', 'PURGE_ALL_SESSIONS', 'DISCARD_SESSIONS', 'OWNER_NAME', 'BOT_ACTIVE_USER', 'BOT_ACTIVE_JID']) delete process.env[key];
  Object.assign(process.env, values);
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in prior)) delete process.env[key]; Object.assign(process.env, prior); store.setPoolForTesting(null); });
}
function save(dir, name, value) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), typeof value === 'string' ? value : JSON.stringify(value));
}
function matchingBrace(source, open) {
  let depth = 0, quote = null;
  for (let i = open; i < source.length; i++) {
    const c = source[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  throw new Error('unbalanced function body');
}
function decoderPreamble(source) {
  const span = name => {
    const i = source.indexOf('function ' + name + '(');
    assert.ok(i >= 0, name + ' decoder exists');
    return source.slice(i, matchingBrace(source, source.indexOf('{', i)) + 1);
  };
  const iifeStart = source.indexOf('(function(_0x15ff90,_0x1a94a2)');
  const callEnd = '(_0x89a3,0xcb38c));';
  const iifeEnd = source.indexOf(callEnd, iifeStart) + callEnd.length;
  assert.ok(iifeStart >= 0 && iifeEnd > iifeStart, 'decoder rotation exists');
  return [span('_0x89a3'), span('_0x2462'), source.slice(iifeStart, iifeEnd), 'const _0x39d0fd=_0x2462;'].join('\n');
}
// The bot bundle is one minified line, so run its own string decoder and then take the real function.
function loadWorkerFunction(name, globals = {}) {
  const source = fs.readFileSync(path.join(ROOT, 'mias/index.js'), 'utf8');
  const start = source.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' exists');
  const end = matchingBrace(source, source.indexOf('{', start));
  const context = vm.createContext({ require: createRequire(path.join(ROOT, 'mias/index.js')), Buffer, console, process, ...globals });
  vm.runInContext(decoderPreamble(source), context);
  return { fn: vm.runInContext('(' + source.slice(start, end + 1) + ')', context), context };
}

test('normalizes WhatsApp JIDs with device suffixes', () => {
  assert.equal(sessionDigits(A + ':12@s.whatsapp.net'), A);
});
test('parses explicit discard entries without substring matching', () => {
  const entries = parseDiscardSessions('+' + A + ', 1555');
  assert.equal(entries.has(A), true); assert.equal(entries.has(A.slice(0, -1)), false);
});
test('SESSION_ID alone preserves every other paired bot', () => {
  assert.equal(matchesSession(jid(A), A), true);
  assert.equal(shouldPruneSession(jid(A), A), false);
  assert.equal(shouldPruneSession(jid(B), A), false);
});
test('explicit reset preserves env identity and prunes other numbered identities', () => {
  assert.equal(shouldPruneSession(jid(A), A, new Set(), true), false);
  assert.equal(shouldPruneSession(jid(B), A, new Set(), true), true);
});
test('discard requires an exact session identity, not a digit substring', () => {
  assert.equal(shouldPruneSession('session-' + B + '-backup', '', new Set([B])), false);
  assert.equal(shouldPruneSession(jid(B), '', new Set([B])), true);
});
test('first import creates credentials with restricted permissions', t => {
  const dir = path.join(temporary(t), jid(A));
  assert.equal(initializeSessionDirectory(dir, boot()).initialized, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'creds.json'))), creds());
  assert.equal(fs.statSync(path.join(dir, 'creds.json')).mode & 0o777, 0o600);
});
test('redeploy preserves rotated auth, username, keys and notice cooldown byte for byte', t => {
  const dir = path.join(temporary(t), jid(A));
  save(dir, 'creds.json', creds(A, 'Updated Name', 87));
  save(dir, 'session-peer.json', { ratchet: 999 });
  save(dir, '.last_alive_notice.json', { lastNoticeAt: Date.now() });
  const snapshot = new Map(fs.readdirSync(dir).map(name => [name, fs.readFileSync(path.join(dir, name))]));
  assert.equal(initializeSessionDirectory(dir, boot()).initialized, false);
  for (const [name, bytes] of snapshot) assert.deepEqual(fs.readFileSync(path.join(dir, name)), bytes);
});
test('corrupt local credentials are preserved instead of overwritten', t => {
  const dir = temporary(t); save(dir, 'creds.json', '{incomplete');
  assert.throws(() => initializeSessionDirectory(dir, boot()), /unreadable/);
  assert.equal(fs.readFileSync(path.join(dir, 'creds.json'), 'utf8'), '{incomplete');
});
test('incomplete or foreign session imports are refused', t => {
  const dir = temporary(t);
  assert.throws(() => initializeSessionDirectory(dir, boot(A, creds(B))), /paired identity/);
  assert.throws(() => initializeSessionDirectory(dir, boot(A, { ...creds(), registered: false })), /paired identity/);
  assert.equal(fs.existsSync(path.join(dir, 'creds.json')), false);
});
test('partial key stores without creds cannot be mixed with an import seed', t => {
  const dir = temporary(t); save(dir, 'session-peer.json', { ratchet: 12 });
  assert.throws(() => initializeSessionDirectory(dir, boot()), /without creds/);
});
test('bootstrap restores complete current DB snapshot before considering old env seed', async t => {
  environment(t, { STORAGE_MODE: 'postgres' });
  const dir = path.join(temporary(t), jid(A));
  store.setPoolForTesting({ query: async () => ({ rows: [
    { file_name: 'creds.json', content: JSON.stringify(creds(A, 'DB Name', 99)) },
    { file_name: 'session-peer.json', content: JSON.stringify({ ratchet: 42 }) }
  ] }) });
  const result = boot(); await bootstrap.prepareBootSession(dir, result);
  assert.equal(result.credsObj.accountSyncCounter, 99);
  assert.equal(result.sessionUserName, 'DB Name');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'session-peer.json'))).ratchet, 42);
});
test('unavailable DB cannot silently fall back to stale credentials', async t => {
  environment(t, { STORAGE_MODE: 'postgres' });
  const dir = path.join(temporary(t), jid(A));
  store.setPoolForTesting({ query: async () => { throw Object.assign(new Error('offline'), { code: 'ECONNREFUSED' }); } });
  await assert.rejects(bootstrap.prepareBootSession(dir, boot()), /backup unavailable/);
  assert.equal(fs.existsSync(path.join(dir, 'creds.json')), false);
});
test('legacy migration moves the entire snapshot and preserves signal keys', async t => {
  environment(t, { STORAGE_MODE: 'json' });
  const root = temporary(t), legacy = path.join(root, A), canonical = path.join(root, jid(A));
  save(legacy, 'creds.json', creds(A, 'Legacy Name', 20)); save(legacy, 'session-peer.json', { ratchet: 31 });
  await bootstrap.prepareBootSession(canonical, boot());
  assert.equal(fs.existsSync(legacy), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(canonical, 'session-peer.json'))).ratchet, 31);
});
test('repeated direct-server bootstrap preparations never reset current credentials', async t => {
  environment(t, { STORAGE_MODE: 'json' });
  const dir = path.join(temporary(t), jid(A));
  await bootstrap.prepareBootSession(dir, boot());
  save(dir, 'creds.json', creds(A, 'Current', 53));
  await bootstrap.prepareBootSession(dir, boot());
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'creds.json'))).accountSyncCounter, 53);
});
test('ordinary startup leaves other sessions, corrupt auth and live-owner markers untouched', async t => {
  const root = temporary(t), pairing = path.join(root, 'pairing');
  environment(t, { RAILWAY_VOLUME_MOUNT_PATH: root, SESSION_DIR: pairing, STORAGE_MODE: 'json' });
  save(path.join(pairing, jid(A)), 'creds.json', creds());
  save(path.join(pairing, jid(B)), 'creds.json', '{corrupt-but-preserved');
  save(path.join(pairing, jid(B)), '.runtime.lock', { pid: process.pid });
  const result = await startup.cleanLockedAndStaleSessions({ preserveSessionJid: jid(A) });
  assert.equal(result.reason, 'no_explicit_reset');
  assert.equal(fs.existsSync(path.join(pairing, jid(B), '.runtime.lock')), true);
  assert.equal(fs.readFileSync(path.join(pairing, jid(B), 'creds.json'), 'utf8'), '{corrupt-but-preserved');
});
test('explicit discard removes only selected identity from disk and metadata', async t => {
  const root = temporary(t), pairing = path.join(root, 'pairing');
  environment(t, { RAILWAY_VOLUME_MOUNT_PATH: root, SESSION_DIR: pairing, STORAGE_MODE: 'json', DISCARD_SESSIONS: B });
  for (const number of [A, B]) save(path.join(pairing, jid(number)), 'creds.json', creds(number));
  save(root, 'web_pairs.json', [{ number: A }, { number: B }]);
  save(root, 'bot_selections.json', { [A]: { bot: 'mias' }, [B]: { bot: 'mias' } });
  await startup.cleanLockedAndStaleSessions({ preserveSessionJid: jid(A) });
  assert.equal(fs.existsSync(path.join(pairing, jid(A), 'creds.json')), true);
  assert.equal(fs.existsSync(path.join(pairing, jid(B))), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'web_pairs.json'))).length, 1);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(root, 'bot_selections.json')))), [A]);
});
test('decoded SESSION_ID does not mark dashboard online before connection', async t => {
  const root = temporary(t), pairing = path.join(root, 'pairing');
  environment(t, { RAILWAY_VOLUME_MOUNT_PATH: root, SESSION_DIR: pairing, STORAGE_MODE: 'json', SESSION_ID: 'JUST_X~' + Buffer.from(JSON.stringify(creds())).toString('base64') });
  save(path.join(pairing, jid(B)), 'creds.json', creds(B));
  await startup.prepareSessionDatabase();
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'active_bot.json'))).live, false);
  assert.equal(process.env.BOT_IS_LIVE, 'false');
  assert.equal(fs.existsSync(path.join(pairing, jid(B), 'creds.json')), true);
});
test('bootstrap rejects unpaired SESSION_ID rather than faking registration', async t => {
  environment(t, { SESSION_ID: JSON.stringify({ ...creds(), registered: false }) });
  await assert.rejects(bootstrap.bootstrapSessionFromEnv(), /incomplete or unpaired/);
});
test('process alive is not WhatsApp connected; closed and stale states stay offline', () => {
  const worker = { number: jid(A), alive: true, paused: false, uptimeMs: 1000 };
  assert.equal(connectedWorkerStatus(worker, { number: A, state: 'starting', updatedAt: Date.now() }), false);
  assert.equal(connectedWorkerStatus(worker, { number: A, state: 'closed', updatedAt: Date.now() }), false);
  assert.equal(connectedWorkerStatus(worker, { number: A, state: 'open', updatedAt: Date.now() }), true);
  assert.equal(connectedWorkerStatus(worker, { number: B, state: 'open', updatedAt: Date.now() }), false);
  assert.equal(connectedWorkerStatus(worker, { number: A, state: 'open', updatedAt: Date.now() - 99999 }), false);
  assert.equal(connectedWorkerStatus({ ...worker, alive: false }, { number: A, state: 'open', updatedAt: Date.now() }), false);
});
test('worker fallback cannot import primary bot credentials into another bot directory', async t => {
  environment(t, { STORAGE_MODE: 'json' });
  const dir = path.join(temporary(t), jid(B));
  await assert.rejects(restoreSession({ sessionId: 'JUST_X~' + Buffer.from(JSON.stringify(creds(A))).toString('base64'), authDir: dir }), /different worker/);
  assert.equal(fs.existsSync(path.join(dir, 'creds.json')), false);
});
test('worker restoration preserves rotated disk credentials and rejects corrupt disk', async t => {
  environment(t, { STORAGE_MODE: 'json' });
  const dir = path.join(temporary(t), jid(A));
  save(dir, 'creds.json', creds(A, 'Rotated', 97));
  assert.equal(await restoreSession({ sessionId: JSON.stringify(creds()), authDir: dir }), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'creds.json'))).accountSyncCounter, 97);
  save(dir, 'creds.json', '{broken');
  await assert.rejects(restoreSession({ sessionId: JSON.stringify(creds()), authDir: dir }), /unreadable/);
  assert.equal(fs.readFileSync(path.join(dir, 'creds.json'), 'utf8'), '{broken');
});
test('legacy full-file worker export imports and normalizes the whole key snapshot', async t => {
  environment(t, { STORAGE_MODE: 'json' });
  const dir = path.join(temporary(t), jid(A));
  const files = { 'creds.json': creds(), 'session-peer.json': { secret: { type: 'Buffer', data: [3, 4] }, ratchet: 65 } };
  assert.equal(await restoreSession({ sessionId: Buffer.from(JSON.stringify(files)).toString('base64'), authDir: dir }), true);
  const { useMultiFileAuthState } = await import('@whiskeysockets/baileys');
  const { state } = await useMultiFileAuthState(dir);
  const key = (await state.keys.get('session', ['peer'])).peer;
  assert.deepEqual([...key.secret], [3, 4]); assert.equal(key.ratchet, 65);
});

test('legacy worker exports cannot write outside their auth directory', async t => {
  environment(t, { STORAGE_MODE: 'json' });
  const root = temporary(t), dir = path.join(root, jid(A));
  const files = { 'creds.json': creds(), '../escape.json': { data: 'forbidden' } };
  await assert.rejects(restoreSession({ sessionId: Buffer.from(JSON.stringify(files)).toString('base64'), authDir: dir }), /Unsafe session export/);
  assert.equal(fs.existsSync(path.join(root, 'escape.json')), false);
  assert.equal(fs.existsSync(path.join(dir, 'creds.json')), false);
});

test('dynamic owner name never borrows a different deployed account identity', t => {
  environment(t, { BOT_ACTIVE_JID: jid(A), BOT_ACTIVE_USER: 'Primary Owner' });
  const CONFIG = {}, { fn, context } = loadWorkerFunction('__miasApplyDynamicOwnerName', {
    CONFIG, _sessionOwnerName: '', usableOwnerName: value => typeof value === 'string' && value.trim() ? value.trim() : ''
  });
  fn({ user: { id: jid(B) }, authState: { creds: { me: { id: jid(B) } } } });
  assert.equal(CONFIG.OWNER_NAME, undefined); assert.equal(CONFIG.OWNER_JID, jid(B));
  fn({ user: { id: jid(B) }, authState: { creds: { me: { name: 'Second Owner' } } } });
  assert.equal(context._sessionOwnerName, 'Second Owner');
});
test('root node index.js actually starts the bootstrap main function', async () => {
  const source = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8'); let calls = 0;
  vm.runInNewContext(source, { __dirname: ROOT, console: { log() {}, error() {} }, process: { exitCode: 0 },
    require: name => name === 'dotenv' ? { config() {} } : name === 'node:fs' ? { existsSync: () => true } :
      name === 'node:path' ? path : { main: async () => { calls++; } } });
  assert.equal(calls, 1);
});
test('bot startup uses only the generation-guarded credential writer', () => {
  const source = fs.readFileSync(path.join(ROOT, 'mias/index.js'), 'utf8');
  assert.match(source, /applyKevdraToSock\([^,]+,AUTH_DIR,undefined\)/);
});
test('legacy Node buffer arrays are converted without changing their bytes or ratchets', async t => {
  environment(t, { STORAGE_MODE: 'json' });
  const dir = path.join(temporary(t), jid(A));
  const legacy = creds(A, 'Legacy Owner', 47);
  legacy.noiseKey.private.data = [1, 2];
  save(dir, 'creds.json', legacy);
  save(dir, 'session-peer.json', { secret: { type: 'Buffer', data: [9, 10] }, ratchet: 81 });
  await bootstrap.prepareBootSession(dir, boot());
  const { useMultiFileAuthState } = await import('@whiskeysockets/baileys');
  const { state } = await useMultiFileAuthState(dir);
  assert.deepEqual([...state.creds.noiseKey.private], [1, 2]);
  assert.equal(state.creds.accountSyncCounter, 47);
  const key = (await state.keys.get('session', ['peer'])).peer;
  assert.deepEqual([...key.secret], [9, 10]);
  assert.equal(key.ratchet, 81);
});

test('real Baileys auth load/save/key roundtrip survives a redeploy import', async t => {
  environment(t, { STORAGE_MODE: 'json' });
  const dir = path.join(temporary(t), jid(A));
  await bootstrap.prepareBootSession(dir, boot());
  const { useMultiFileAuthState } = await import('@whiskeysockets/baileys');
  const { state, saveCreds } = await useMultiFileAuthState(dir);
  assert.equal(Buffer.isBuffer(state.creds.noiseKey.private), true);
  state.creds.accountSyncCounter = 123;
  state.creds.me.name = 'Name From WhatsApp';
  await state.keys.set({ session: { peer: { ratchet: 73 } } });
  await saveCreds();
  await bootstrap.prepareBootSession(dir, boot());
  const reloaded = await useMultiFileAuthState(dir);
  assert.equal(reloaded.state.creds.accountSyncCounter, 123);
  assert.equal(reloaded.state.creds.me.name, 'Name From WhatsApp');
  assert.equal((await reloaded.state.keys.get('session', ['peer'])).peer.ratchet, 73);
});

test('bot-info request is read-only and requires actual connection status', async t => {
  const root = temporary(t), pairing = path.join(root, 'pairing');
  environment(t, { RAILWAY_VOLUME_MOUNT_PATH: root, SESSION_DIR: pairing, STORAGE_MODE: 'json', BOT_ACTIVE_JID: jid(B), BOT_IS_LIVE: 'false' });
  save(root, 'active_bot.json', { jid: jid(A), username: 'Wrong Owner', live: true });
  save(path.join(pairing, jid(A)), 'creds.json', creds(A, 'Wrong Owner'));
  save(path.join(pairing, jid(B)), 'creds.json', creds(B, 'Right Owner'));
  save(path.join(root, 'bot_status'), B + '.json', { number: B, state: 'closed', updatedAt: Date.now() });
  const source = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const start = source.indexOf("app.get('/api/bot-info', "); const end = source.indexOf('\n});', start);
  let handler, response;
  vm.runInNewContext(source.slice(start, end + 4), { app: { get: (_url, fn) => { handler = fn; } },
    require: createRequire(path.join(ROOT, 'server.js')), fs, path, process, NEXSTORE: root,
    _launcher: { list: () => [{ number: jid(B), alive: true, uptimeMs: 2000 }] },
    _bootstrapEnvSession: () => { throw new Error('GET must not bootstrap or write auth'); } });
  const before = fs.readFileSync(path.join(pairing, jid(B), 'creds.json'));
  for (let i = 0; i < 3; i++) await handler({}, { json: value => { response = value; } });
  assert.equal(response.live, false); assert.equal(response.username, 'Right Owner');
  assert.deepEqual(fs.readFileSync(path.join(pairing, jid(B), 'creds.json')), before);
  save(path.join(root, 'bot_status'), B + '.json', { number: B, state: 'open', updatedAt: Date.now() });
  await handler({}, { json: value => { response = value; } }); assert.equal(response.live, true);
});
