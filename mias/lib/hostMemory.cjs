'use strict';

const fs = require('node:fs');
const os = require('node:os');

const MIB = 1024 * 1024;
const MIN_HEAP_MB = 128;
const MAX_HEAP_MB = 1536;
const CONTROL_RESERVE_MB = 140;
const WORKER_OVERHEAD_MB = 120;
const HEAP_SHARE = 0.65;

function readLimitFile(file, readFile = fs.readFileSync) {
  try {
    const raw = String(readFile(file, 'utf8')).trim();
    if (!raw || raw === 'max') return null;
    const bytes = Number(raw);
    return Number.isFinite(bytes) && bytes > 0 ? bytes : null;
  } catch {
    return null;
  }
}

function readCgroupLimitBytes({ readFile = fs.readFileSync } = {}) {
  const paths = [
    '/sys/fs/cgroup/memory.max',
    '/sys/fs/cgroup/memory/memory.limit_in_bytes',
    '/sys/fs/cgroup/memory.limit_in_bytes',
  ];
  for (const file of paths) {
    const value = readLimitFile(file, readFile);
    if (value) return value;
  }
  return null;
}

function getMemoryLimitBytes({
  env = process.env,
  totalMemoryBytes = os.totalmem(),
  readFile = fs.readFileSync,
} = {}) {
  const configuredMb = Number(env.BOT_MEMORY_LIMIT_MB);
  if (Number.isFinite(configuredMb) && configuredMb > 0) return Math.floor(configuredMb * MIB);

  const cgroupBytes = readCgroupLimitBytes({ readFile });
  // Some cgroup v1 hosts use a huge number to mean "unlimited".
  if (cgroupBytes && cgroupBytes < totalMemoryBytes * 4) {
    return Math.min(cgroupBytes, totalMemoryBytes);
  }
  return totalMemoryBytes;
}

function getRecommendedBotHeapMB({
  memoryLimitBytes = getMemoryLimitBytes(),
  workerCount = 1,
  env = process.env,
} = {}) {
  const override = Number(env.BOT_CHILD_HEAP_MB);
  if (Number.isFinite(override) && override > 0) {
    return Math.max(MIN_HEAP_MB, Math.min(4096, Math.floor(override)));
  }

  const workers = Math.max(1, Math.floor(Number(workerCount) || 1));
  const limitMb = Math.floor(memoryLimitBytes / MIB);
  const availablePerWorker = (limitMb - CONTROL_RESERVE_MB - workers * WORKER_OVERHEAD_MB) / workers;
  const recommended = Math.floor(availablePerWorker * HEAP_SHARE);
  return Math.max(MIN_HEAP_MB, Math.min(MAX_HEAP_MB, recommended));
}

function getRecommendedRestartMB({ memoryLimitBytes = getMemoryLimitBytes() } = {}) {
  const limitMb = Math.floor(memoryLimitBytes / MIB);
  return Math.max(256, Math.floor(limitMb * 0.8));
}

function describeMemory({ env = process.env, totalMemoryBytes = os.totalmem(), readFile = fs.readFileSync } = {}) {
  const limitBytes = getMemoryLimitBytes({ env, totalMemoryBytes, readFile });
  const cgroupBytes = readCgroupLimitBytes({ readFile });
  return {
    limitMb: Math.floor(limitBytes / MIB),
    source: Number(env.BOT_MEMORY_LIMIT_MB) > 0 ? 'BOT_MEMORY_LIMIT_MB' : cgroupBytes ? 'cgroup' : 'os.totalmem',
  };
}

module.exports = {
  MIN_HEAP_MB,
  MAX_HEAP_MB,
  readCgroupLimitBytes,
  getMemoryLimitBytes,
  getRecommendedBotHeapMB,
  getRecommendedRestartMB,
  describeMemory,
};
