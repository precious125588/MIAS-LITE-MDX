'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { resolveHttpServerMode, loopbackArgs, PRELOAD_PATH } = require('../lib/http-port-mode.cjs');

const execFileAsync = promisify(execFile);
const LOOP = { port: 0, host: '127.0.0.1' };

test('a panel (no deploy variables) runs without a fixed web port', () => {
  assert.equal(resolveHttpServerMode({ PORT: '8080' }).enabled, false);
  assert.equal(resolveHttpServerMode({}).enabled, false);
});

test('Railway, Render and Koyeb enable the web port', () => {
  assert.equal(resolveHttpServerMode({ RAILWAY_ENVIRONMENT: 'production', PORT: '8080' }).port, 8080);
  assert.equal(resolveHttpServerMode({ RAILWAY_ENVIRONMENT: 'production' }).enabled, true);
  assert.equal(resolveHttpServerMode({ RENDER: 'true', PORT: '10000' }).port, 10000);
  assert.equal(resolveHttpServerMode({ KOYEB_APP_NAME: 'bot' }).enabled, true);
});

test('port defaults to 3000 and an invalid PORT falls back to 3000', () => {
  assert.equal(resolveHttpServerMode({ RENDER: 'true' }).port, 3000);
  assert.equal(resolveHttpServerMode({ RENDER: 'true', PORT: 'abc' }).port, 3000);
  assert.equal(resolveHttpServerMode({ RENDER: 'true', PORT: '99999' }).port, 3000);
});

test('BOT_HTTP_SERVER overrides detection', () => {
  assert.equal(resolveHttpServerMode({ BOT_HTTP_SERVER: 'on' }).enabled, true);
  assert.equal(resolveHttpServerMode({ RENDER: 'true', BOT_HTTP_SERVER: 'off' }).enabled, false);
  assert.equal(resolveHttpServerMode({ RENDER: 'false' }).enabled, false);
});

test('every TCP listen is moved to 127.0.0.1 on a random port', () => {
  const cb = () => {};
  assert.deepEqual(loopbackArgs([3000]), [LOOP]);
  assert.deepEqual(loopbackArgs(['3000']), [LOOP]);
  assert.deepEqual(loopbackArgs([3000, '0.0.0.0', cb]), [LOOP, cb]);
  assert.deepEqual(loopbackArgs([{ port: 3000, host: '0.0.0.0' }, cb]), [LOOP, cb]);
  assert.deepEqual(loopbackArgs([cb]), [LOOP, cb]);
  assert.deepEqual(loopbackArgs([]), [LOOP]);
});

test('unix socket paths are left alone', () => {
  assert.deepEqual(loopbackArgs(['/tmp/app.sock']), ['/tmp/app.sock']);
  assert.deepEqual(loopbackArgs([{ path: '/tmp/app.sock' }]), [{ path: '/tmp/app.sock' }]);
});

test('with the preload, a server asking for a busy port binds loopback instead', async () => {
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(0, '0.0.0.0', resolve));
  const busy = blocker.address().port;
  try {
    const script = `const s=require('http').createServer().listen(${busy},'0.0.0.0',()=>{console.log(JSON.stringify(s.address()));s.close();});`;
    const { stdout } = await execFileAsync(process.execPath, ['-r', PRELOAD_PATH, '-e', script],
      { env: { ...process.env, BOT_HTTP_SERVER_OFF: 'true' }, timeout: 15000 });
    const addr = JSON.parse(stdout.trim());
    assert.equal(addr.address, '127.0.0.1');
    assert.notEqual(addr.port, busy);
  } finally {
    blocker.close();
  }
});

test('without the preload the same server hits the busy port', async () => {
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(0, '0.0.0.0', resolve));
  const busy = blocker.address().port;
  try {
    const script = `require('http').createServer().listen(${busy},'0.0.0.0');`;
    await assert.rejects(
      execFileAsync(process.execPath, ['-e', script], { env: { ...process.env, BOT_HTTP_SERVER_OFF: '' }, timeout: 15000 }),
      (err) => /EADDRINUSE/.test(String(err.stderr || err.message)),
    );
  } finally {
    blocker.close();
  }
});
