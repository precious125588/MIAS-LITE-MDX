'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { syncLatestCode, isKept, sha256 } = require('../lib/code-updater.cjs');

const NEW_SHA = 'b'.repeat(40);
const OLD_SHA = 'a'.repeat(40);

function write(root, rel, text) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
}

// Builds a GitHub-style archive: one top folder "<repo>-<sha>/" with the files.
function makeArchive(tmp, sha, files, stamp) {
  const remote = path.join(tmp, 'remote');
  const top = path.join(remote, 'MIAS-LITE-MDX-' + sha);
  for (const [rel, text] of Object.entries(files)) write(top, rel, text);
  write(top, 'lib/precious-build-stamp.json', JSON.stringify(stamp));
  const archive = path.join(tmp, 'src.tar.gz');
  execFileSync('tar', ['-czf', archive, '-C', remote, 'MIAS-LITE-MDX-' + sha]);
  return archive;
}

test('isKept protects user data and secrets, not code', () => {
  assert.equal(isKept('.env'), true);
  assert.equal(isKept('.env.local'), true);
  assert.equal(isKept('nexstore/settings.json'), true);
  assert.equal(isKept('node_modules/x/index.js'), true);
  assert.equal(isKept('mias/index.js'), false);
  assert.equal(isKept('server.js'), false);
  assert.equal(isKept('config.json'), false);
});

test('updates a plain folder: code replaced, user data kept, stamp matches', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-test-'));
  const newFiles = { 'server.js': 'new server', 'mias/index.js': 'new index', 'lib/keep.cjs': 'x' };
  const archive = makeArchive(tmp, NEW_SHA, newFiles, {
    buildId: 'old', builtAt: 'old', sha: NEW_SHA, files: { 'server.js': 'stale', 'mias/index.js': 'stale' }, mustNotExist: ['lib/old.cjs'],
  });
  const root = path.join(tmp, 'app');
  write(root, 'server.js', 'old server');
  write(root, 'mias/index.js', 'old index');
  write(root, 'lib/old.cjs', 'obsolete');
  write(root, 'nexstore/settings.json', '{"keep":true}');
  write(root, '.env', 'SESSION_ID=secret');
  write(root, 'local-only.txt', 'mine');
  write(root, 'lib/precious-build-stamp.json', JSON.stringify({ sha: OLD_SHA, files: { 'server.js': 'x' } }));

  const logs = [];
  const r = await syncLatestCode({
    root,
    env: { UPDATE_ARCHIVE_FILE: archive },
    local: { sha: OLD_SHA.slice(0, 7), source: 'test' },
    remote: { sha: NEW_SHA },
    log: (l) => logs.push(l),
  });

  assert.equal(r.updated, true, JSON.stringify(r));
  assert.equal(fs.readFileSync(path.join(root, 'server.js'), 'utf8'), 'new server');
  assert.equal(fs.readFileSync(path.join(root, 'mias/index.js'), 'utf8'), 'new index');
  assert.equal(fs.existsSync(path.join(root, 'lib/old.cjs')), false, 'mustNotExist removed');
  assert.equal(fs.readFileSync(path.join(root, 'nexstore/settings.json'), 'utf8'), '{"keep":true}');
  assert.equal(fs.readFileSync(path.join(root, '.env'), 'utf8'), 'SESSION_ID=secret');
  assert.equal(fs.readFileSync(path.join(root, 'local-only.txt'), 'utf8'), 'mine');

  const stamp = JSON.parse(fs.readFileSync(path.join(root, 'lib/precious-build-stamp.json'), 'utf8'));
  assert.equal(stamp.sha, NEW_SHA);
  assert.equal(stamp.files['server.js'], sha256(path.join(root, 'server.js')));
  assert.equal(stamp.files['mias/index.js'], sha256(path.join(root, 'mias/index.js')));

  const again = await syncLatestCode({ root, env: {}, local: { sha: NEW_SHA, source: 'test' }, remote: { sha: NEW_SHA }, log() {} });
  assert.equal(again.reason, 'current');
});

test('does nothing when already on the remote commit', async () => {
  const r = await syncLatestCode({ root: os.tmpdir(), env: {}, local: { sha: NEW_SHA.slice(0, 12), source: 't' }, remote: { sha: NEW_SHA }, log() {} });
  assert.equal(r.updated, false);
  assert.equal(r.reason, 'current');
});

test('respects AUTO_PULL=off', async () => {
  const r = await syncLatestCode({ root: os.tmpdir(), env: { AUTO_PULL: 'off' }, local: { sha: OLD_SHA }, remote: { sha: NEW_SHA }, log() {} });
  assert.equal(r.reason, 'disabled');
});

test('aborts before writing anything when the archive is incomplete', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-test-'));
  const archive = makeArchive(tmp, NEW_SHA, { 'server.js': 'new server' }, {
    sha: NEW_SHA, files: { 'server.js': 'x', 'lib/needed.cjs': 'y' },
  });
  const root = path.join(tmp, 'app');
  write(root, 'server.js', 'old server');
  const logs = [];
  const r = await syncLatestCode({ root, env: { UPDATE_ARCHIVE_FILE: archive }, local: { sha: OLD_SHA }, remote: { sha: NEW_SHA }, log: (l) => logs.push(l) });
  assert.equal(r.updated, false);
  assert.equal(r.reason, 'archive-failed');
  assert.equal(fs.readFileSync(path.join(root, 'server.js'), 'utf8'), 'old server');
  assert.ok(logs.some((l) => /could not update/i.test(l)));
});
