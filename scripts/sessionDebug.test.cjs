'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sd = require('./sessionDebug.cjs');

function tmp(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-dbg-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

test('missing creds.json is reported as missing', t => {
  const dir = path.join(tmp(t), 'a');
  fs.mkdirSync(dir);
  assert.equal(sd.describeSession(dir).status, 'missing');
});

test('corrupt creds.json is reported as unreadable', t => {
  const dir = path.join(tmp(t), 'b');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'creds.json'), '{broken');
  assert.equal(sd.describeSession(dir).status, 'unreadable');
});

test('creds without an account id or marked unregistered are unregistered', t => {
  const root = tmp(t);
  const a = path.join(root, 'a'); fs.mkdirSync(a);
  fs.writeFileSync(path.join(a, 'creds.json'), JSON.stringify({ registered: false, me: { id: '1:2@s.whatsapp.net' } }));
  const b = path.join(root, 'b'); fs.mkdirSync(b);
  fs.writeFileSync(path.join(b, 'creds.json'), JSON.stringify({ registered: true }));
  assert.equal(sd.describeSession(a).status, 'unregistered');
  assert.equal(sd.describeSession(b).status, 'unregistered');
});

test('a paired session is ok, and an old one gets a stale hint', t => {
  const dir = path.join(tmp(t), 'c'); fs.mkdirSync(dir);
  const credsPath = path.join(dir, 'creds.json');
  fs.writeFileSync(credsPath, JSON.stringify({ registered: true, me: { id: '2349068551055:12@s.whatsapp.net' } }));
  const old = new Date(Date.now() - 30 * 86400000);
  fs.utimesSync(credsPath, old, old);
  const s = sd.describeSession(dir);
  assert.equal(s.status, 'ok');
  assert.equal(s.jid, '2349068551055:12@s.whatsapp.net');
  assert.ok(s.reasons.some(r => /stale/.test(r)));
});

test('summary skips quarantined folders and logs a verdict', t => {
  const root = tmp(t);
  const ok = path.join(root, 'ok'); fs.mkdirSync(ok);
  fs.writeFileSync(path.join(ok, 'creds.json'), JSON.stringify({ registered: true, me: { id: 'x@s.whatsapp.net' } }));
  fs.mkdirSync(path.join(root, 'x.quarantine-1'));
  const lines = [];
  sd.logSessionDebug(root, l => lines.push(l));
  assert.equal(lines.length, 2);
  assert.match(lines[1], /1\/1 session\(s\) usable/);
});

test('disconnect codes map to plain reasons and flag invalid sessions', () => {
  assert.equal(sd.classifyDisconnect(401).name, 'loggedOut');
  assert.equal(sd.classifyDisconnect(401).sessionInvalid, true);
  assert.equal(sd.classifyDisconnect(500).sessionInvalid, true);
  assert.equal(sd.classifyDisconnect(440).sessionInvalid, false);
  assert.equal(sd.classifyDisconnect(515).name, 'restartRequired');
  assert.equal(sd.classifyDisconnect(999).name, 'unknown');
});
