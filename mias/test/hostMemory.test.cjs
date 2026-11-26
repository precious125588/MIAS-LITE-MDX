'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const memory = require('../lib/hostMemory.cjs');
const MIB = 1024 * 1024;

function reader(files) {
  return (file) => {
    if (!(file in files)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return files[file];
  };
}

test('reads cgroup v2 memory limit', () => {
  const readFile = reader({ '/sys/fs/cgroup/memory.max': String(768 * MIB) });
  assert.equal(memory.readCgroupLimitBytes({ readFile }), 768 * MIB);
});

test('falls through from unlimited cgroup v2 to cgroup v1', () => {
  const readFile = reader({
    '/sys/fs/cgroup/memory.max': 'max',
    '/sys/fs/cgroup/memory/memory.limit_in_bytes': String(512 * MIB),
  });
  assert.equal(memory.readCgroupLimitBytes({ readFile }), 512 * MIB);
});

test('reads cgroup memory usage for container-aware diagnostics', () => {
  const readFile = reader({ '/sys/fs/cgroup/memory.current': String(300 * MIB) });
  assert.equal(memory.readCgroupUsageBytes({ readFile }), 300 * MIB);
});

test('uses explicit host memory override before cgroup files', () => {
  assert.equal(memory.getMemoryLimitBytes({
    env: { BOT_MEMORY_LIMIT_MB: '640' },
    totalMemoryBytes: 2048 * MIB,
    readFile: () => { throw new Error('should not read cgroup'); },
  }), 640 * MIB);
});

test('derives a smaller per-worker heap as active worker count increases', () => {
  const limit = 2048 * MIB;
  const single = memory.getRecommendedBotHeapMB({ memoryLimitBytes: limit, workerCount: 1, env: {} });
  const multiple = memory.getRecommendedBotHeapMB({ memoryLimitBytes: limit, workerCount: 3, env: {} });
  assert.ok(single > multiple);
  assert.ok(multiple >= memory.MIN_HEAP_MB);
});

test('honors a valid explicit child heap override', () => {
  assert.equal(memory.getRecommendedBotHeapMB({
    memoryLimitBytes: 512 * MIB,
    env: { BOT_CHILD_HEAP_MB: '384' },
  }), 384);
});

test('clamps explicit child heap override to safe minimum', () => {
  assert.equal(memory.getRecommendedBotHeapMB({
    memoryLimitBytes: 256 * MIB,
    env: { BOT_CHILD_HEAP_MB: '32' },
  }), memory.MIN_HEAP_MB);
});
test('autoDetectMemoryEnv calculates correct values for 1GB container', () => {
  const readFile = reader({ '/sys/fs/cgroup/memory.max': String(1024 * MIB) });
  const detected = memory.autoDetectMemoryEnv({ env: {}, totalMemoryBytes: 2048 * MIB, readFile });
  assert.equal(detected.limitMb, 1024);
  assert.ok(detected.botHeapMb >= 650 && detected.botHeapMb <= 850);
  assert.ok(detected.serverHeapMb >= 350 && detected.serverHeapMb <= 550);
});

test('updateEnvFile creates or updates env variables in file', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const tmp = path.join(require('node:os').tmpdir(), 'test_mem.env');
  fs.writeFileSync(tmp, 'PORT=5000\nBOT_MEMORY_LIMIT_MB=300\n');
  memory.updateEnvFile(tmp, { BOT_MEMORY_LIMIT_MB: '1024', BOT_CHILD_HEAP_MB: '720' });
  const content = fs.readFileSync(tmp, 'utf8');
  assert.match(content, /BOT_MEMORY_LIMIT_MB=1024/);
  assert.match(content, /BOT_CHILD_HEAP_MB=720/);
  assert.match(content, /PORT=5000/);
  fs.unlinkSync(tmp);
});
