'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execShellAsync, spawnAsync } = require('../lib/asyncExec.cjs');
const { vcfLines } = require('../lib/contactsIndex.cjs');

test('execShellAsync resolves output and rejects on non-zero exit', async () => {
  const ok = await execShellAsync('echo hello', { timeout: 5000 });
  assert.equal(ok.stdout.trim(), 'hello');
  await assert.rejects(execShellAsync('exit 3', { timeout: 5000 }));
});

test('execShellAsync does not block the event loop', async () => {
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 20);
  await execShellAsync('sleep 0.4', { timeout: 5000 });
  clearInterval(timer);
  assert.ok(ticks >= 5, `event loop ticked ${ticks} times while the command ran`);
});

test('execShellAsync respects its timeout', async () => {
  await assert.rejects(execShellAsync('sleep 5', { timeout: 200 }));
});

test('spawnAsync returns status and output and never rejects', async () => {
  const r = await spawnAsync('sh', ['-c', 'echo out; echo err 1>&2; exit 2'], { timeout: 5000 });
  assert.equal(r.status, 2);
  assert.equal(r.stdout.trim(), 'out');
  assert.equal(r.stderr.trim(), 'err');
});

test('spawnAsync reports a missing binary instead of throwing', async () => {
  const r = await spawnAsync('definitely-not-a-binary-xyz', [], { timeout: 2000 });
  assert.equal(r.status, null);
  assert.ok(r.error);
});

test('spawnAsync kills a process past its timeout', async () => {
  const started = Date.now();
  const r = await spawnAsync('sleep', ['10'], { timeout: 300 });
  assert.ok(Date.now() - started < 5000);
  assert.notEqual(r.status, 0);
});

test('vcfLines caches the parsed file and refreshes when it changes', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vcf-')), 'contacts.vcf');
  fs.writeFileSync(file, 'TEL;waid=2348000000001:+234 800 000 0001\r\nFN:Ada\r\n\r\n');
  const first = vcfLines(file);
  assert.deepEqual(first, ['TEL;waid=2348000000001:+234 800 000 0001', 'FN:Ada']);
  assert.equal(vcfLines(file), first, 'same array while unchanged');
  fs.writeFileSync(file, 'FN:Bola\n');
  assert.deepEqual(vcfLines(file), ['FN:Bola']);
  assert.deepEqual(vcfLines(file + '.missing'), []);
});
