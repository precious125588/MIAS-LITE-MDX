'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MIB = 1024 * 1024;
const MIN_HEAP_MB = 128;
const MAX_HEAP_MB = 4096;
const CONTROL_RESERVE_MB = 140;
const WORKER_OVERHEAD_MB = 120;
const HEAP_SHARE = 0.72;

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

function readCgroupUsageBytes({ readFile = fs.readFileSync } = {}) {
  const paths = [
    '/sys/fs/cgroup/memory.current',
    '/sys/fs/cgroup/memory/memory.usage_in_bytes',
    '/sys/fs/cgroup/memory.usage_in_bytes',
  ];
  for (const file of paths) {
    const value = readLimitFile(file, readFile);
    if (value !== null) return value;
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
  // Some cgroup v1 hosts use a huge number to mean 'unlimited'.
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
  return Math.max(256, Math.floor(limitMb * 0.85));
}

function describeMemory({ env = process.env, totalMemoryBytes = os.totalmem(), readFile = fs.readFileSync } = {}) {
  const limitBytes = getMemoryLimitBytes({ env, totalMemoryBytes, readFile });
  const cgroupBytes = readCgroupLimitBytes({ readFile });
  const usageBytes = readCgroupUsageBytes({ readFile });
  return {
    limitMb: Math.floor(limitBytes / MIB),
    usedMb: usageBytes === null ? null : Math.floor(usageBytes / MIB),
    source: Number(env.BOT_MEMORY_LIMIT_MB) > 0 ? 'BOT_MEMORY_LIMIT_MB' : cgroupBytes ? 'cgroup' : 'os.totalmem',
  };
}

function autoDetectMemoryEnv({
  env = process.env,
  totalMemoryBytes = os.totalmem(),
  readFile = fs.readFileSync,
} = {}) {
  const cgroupBytes = readCgroupLimitBytes({ readFile });
  let realLimitBytes = totalMemoryBytes;
  let source = 'os.totalmem';
  if (cgroupBytes && cgroupBytes < totalMemoryBytes * 4) {
    realLimitBytes = Math.min(cgroupBytes, totalMemoryBytes);
    source = 'cgroup';
  }
  const realLimitMb = Math.floor(realLimitBytes / MIB);

  const userLimit = Number(env.BOT_MEMORY_LIMIT_MB);
  const limitMb = (Number.isFinite(userLimit) && userLimit > 320) ? Math.floor(userLimit) : realLimitMb;

  let botHeapMb;
  const userChildHeap = Number(env.BOT_CHILD_HEAP_MB);
  if (Number.isFinite(userChildHeap) && userChildHeap > 220) {
    botHeapMb = Math.max(MIN_HEAP_MB, Math.min(MAX_HEAP_MB, Math.floor(userChildHeap)));
  } else {
    if (limitMb <= 600) {
      botHeapMb = Math.max(MIN_HEAP_MB, Math.floor(limitMb * 0.65));
    } else if (limitMb <= 1200) {
      botHeapMb = Math.max(450, Math.min(850, Math.floor(limitMb * 0.72)));
    } else if (limitMb <= 2500) {
      botHeapMb = Math.max(800, Math.min(1600, Math.floor(limitMb * 0.72)));
    } else if (limitMb <= 4500) {
      botHeapMb = Math.min(2800, Math.floor(limitMb * 0.7));
    } else {
      botHeapMb = Math.min(4096, Math.floor(limitMb * 0.65));
    }
  }

  let serverHeapMb;
  const userServerHeap = Number(env.SERVER_HEAP_MB);
  if (Number.isFinite(userServerHeap) && userServerHeap > 220) {
    serverHeapMb = Math.max(MIN_HEAP_MB, Math.min(2048, Math.floor(userServerHeap)));
  } else {
    serverHeapMb = Math.max(256, Math.min(1024, Math.floor(botHeapMb * 0.6)));
  }

  const restartMb = Math.max(384, Math.floor(limitMb * 0.85));

  return {
    limitMb,
    botHeapMb,
    serverHeapMb,
    restartMb,
    source,
  };
}

function updateEnvFile(envPath, updates) {
  try {
    let content = '';
    if (fs.existsSync(envPath)) {
      content = fs.readFileSync(envPath, 'utf8');
    }
    const lines = content ? content.split('\n') : [];
    const updatedKeys = new Set();

    const newLines = lines.map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return line;
      const eqIdx = line.indexOf('=');
      if (eqIdx === -1) return line;
      const key = line.slice(0, eqIdx).trim();
      if (key in updates) {
        updatedKeys.add(key);
        return key + '=' + updates[key];
      }
      return line;
    });

    for (const [key, val] of Object.entries(updates)) {
      if (!updatedKeys.has(key)) {
        newLines.push(key + '=' + val);
      }
    }

    const finalContent = newLines.join('\n') + (newLines.length && !newLines[newLines.length - 1].endsWith('\n') ? '\n' : '');
    fs.writeFileSync(envPath, finalContent, 'utf8');
    return true;
  } catch (_) {
    return false;
  }
}

function applyAutoMemoryEnv({
  env = process.env,
  updateDotEnv = true,
  root = path.join(__dirname, '..', '..'),
} = {}) {
  const detected = autoDetectMemoryEnv({ env });

  env.BOT_MEMORY_LIMIT_MB = String(detected.limitMb);
  env.BOT_CHILD_HEAP_MB = String(detected.botHeapMb);
  env.SERVER_HEAP_MB = String(detected.serverHeapMb);

  if (updateDotEnv) {
    const envPath = path.join(root, '.env');
    updateEnvFile(envPath, {
      BOT_MEMORY_LIMIT_MB: String(detected.limitMb),
      BOT_CHILD_HEAP_MB: String(detected.botHeapMb),
      SERVER_HEAP_MB: String(detected.serverHeapMb),
    });
  }

  console.log(`[hostMemory] Auto-configured memory: limit=${detected.limitMb}MB (${detected.source}), botChildHeap=${detected.botHeapMb}MB, serverHeap=${detected.serverHeapMb}MB`);
  return detected;
}

module.exports = {
  MIN_HEAP_MB,
  MAX_HEAP_MB,
  readCgroupLimitBytes,
  readCgroupUsageBytes,
  getMemoryLimitBytes,
  getRecommendedBotHeapMB,
  getRecommendedRestartMB,
  describeMemory,
  autoDetectMemoryEnv,
  updateEnvFile,
  applyAutoMemoryEnv,
};
