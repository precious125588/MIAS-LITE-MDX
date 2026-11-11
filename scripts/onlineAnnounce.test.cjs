'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');

const execFileAsync = promisify(execFile);
const MODULE = path.join(__dirname, '..', 'lib', 'online-announce.cjs');

async function run(script) {
  const { stdout } = await execFileAsync(process.execPath,
    ['-e', `require(${JSON.stringify(MODULE)}).install(); const E = require('node:events'); const e = new E(); ${script}`],
    { timeout: 15000 });
  return stdout.split('\n').filter((line) => line.includes('is online'));
}

test('prints once per open and re-arms after close', async () => {
  const lines = await run(`
    e.emit('connection.update', { connection: 'open' });
    e.emit('connection.update', { connection: 'open' });
    e.emit('connection.update', { connection: 'close' });
    e.emit('connection.update', { connection: 'open' });`);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /MIAS LITE MDX is online/);
});

test('ignores other events and updates without a connection state', async () => {
  const lines = await run(`
    e.emit('messages.upsert', { connection: 'open' });
    e.emit('connection.update', { isOnline: true });
    e.emit('connection.update', null);`);
  assert.equal(lines.length, 0);
});

test('other listeners still receive the event unchanged', async () => {
  const { stdout } = await execFileAsync(process.execPath,
    ['-e', `require(${JSON.stringify(MODULE)}).install(); const E = require('node:events'); const e = new E();
      e.on('connection.update', (u) => process.stdout.write('listener got ' + u.connection + '\\n'));
      e.emit('connection.update', { connection: 'open' });`],
    { timeout: 15000 });
  assert.match(stdout, /listener got open/);
  assert.match(stdout, /is online/);
});
