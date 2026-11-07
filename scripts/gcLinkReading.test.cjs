'use strict';
// End-to-end check of the anime GC link reader: a paired library account
// attached to a fake socket, real messages.upsert events, and the stored links.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const EventEmitter = require('node:events');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-links-'));
process.env.ANIME_GC_DIR = dir;
const GC = require('../mias/features/animeGcLibrary.cjs');

const DEMON_JID = '120363000000000000@g.us';
const OTHER_JID = '120363999999999999@g.us';
const DM_JID = '2348000000000@s.whatsapp.net';

function setup() {
  // Every route resolved to a group the library account is in, so refresh() needs no network.
  const routes = {};
  GC.ROUTES.forEach((r, i) => {
    routes[r.key] = { jid: i === 0 ? DEMON_JID : `1203630000000${String(i).padStart(5, '0')}@g.us`,
      label: r.label, invite: r.invite, available: true, resolvedAt: Date.now(), lastError: '' };
  });
  fs.writeFileSync(path.join(dir, '_gc_groups.json'), JSON.stringify({ routes }));
  fs.rmSync(path.join(dir, '_gc_library.json'), { force: true });
  GC._resetForTests();
}
function libraryAccount() {
  const ev = new EventEmitter();
  // The account is a member of every registered group, as in production.
  const groups = {};
  for (const r of GC.ROUTES) groups[routeJid(r.key)] = {};
  return { ev, user: { id: GC.LIBRARY_DIGITS + ':5@s.whatsapp.net' },
    groupFetchAllParticipating: async () => groups };
}
function routeJid(key) {
  const g = JSON.parse(fs.readFileSync(path.join(dir, '_gc_groups.json'), 'utf8')).routes[key];
  return g.jid;
}
function post(sock, remoteJid, id, text) {
  sock.ev.emit('messages.upsert', { messages: [{ key: { remoteJid, id, fromMe: false }, message: { conversation: text } }] });
}

test('a paired library account stores TikTok links posted in its registered GC', () => {
  setup();
  const sock = libraryAccount();
  assert.equal(GC.attach(sock), true);
  post(sock, DEMON_JID, 'm1', 'new ep https://vt.tiktok.com/ZS8abc/ 🔥');
  post(sock, DEMON_JID, 'm2', 'and this one https://www.tiktok.com/@maker/video/7300000000000000001');
  const links = GC.linksFor('demonslayer');
  assert.equal(links.length, 2);
  assert.ok(links.some(l => l.url === 'https://vt.tiktok.com/ZS8abc'));
  assert.ok(links.some(l => l.cid === 'ttv_7300000000000000001'));
  assert.equal(GC.countForRoute('demonslayer'), 2);
});

test('the same TikTok link posted again is stored once', () => {
  setup();
  const sock = libraryAccount();
  GC.attach(sock);
  post(sock, DEMON_JID, 'm1', 'https://vt.tiktok.com/ZS8abc/');
  post(sock, DEMON_JID, 'm2', 'again https://vt.tiktok.com/ZS8abc/');
  assert.equal(GC.linksFor('demonslayer').length, 1);
});

test('links from unregistered groups, direct messages and non-TikTok text are ignored', () => {
  setup();
  const sock = libraryAccount();
  GC.attach(sock);
  post(sock, OTHER_JID, 'm1', 'https://vt.tiktok.com/ZS8abc/');
  post(sock, DM_JID, 'm2', 'https://vt.tiktok.com/ZS8abc/');
  post(sock, DEMON_JID, 'm3', 'https://example.com/not-tiktok');
  assert.equal(GC.linksFor('demonslayer').length, 0);
});

test('offline GC status names the missing library session instead of a bare warning', () => {
  setup();
  const status = GC.statusText();
  assert.match(status, /GC route animes isn't connected/);
  assert.match(status, /no paired session for \+2348152433778 on this volume/);
});
