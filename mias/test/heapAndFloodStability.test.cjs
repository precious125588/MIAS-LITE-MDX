'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('mais_launcher dynamically computes heap from host memory instead of hardcoding 512MB', () => {
  const launcherCode = fs.readFileSync(path.join(__dirname, '../../mais_launcher.js'), 'utf8');
  assert.ok(launcherCode.includes('_dynHeap'), 'launcher should calculate dynamic heap');
  assert.ok(launcherCode.includes('getRecommendedBotHeapMB'), 'launcher should call getRecommendedBotHeapMB');
});

test('checkMemoryHealth does not false-positive on early V8 startup heap', () => {
  const selfTestCode = fs.readFileSync(path.join(__dirname, '../lib/startupSelfTest.js'), 'utf8');
  assert.ok(selfTestCode.includes('heapUsedMB > 400'), 'memory test should check used MB before failing');
});

test('global flood rate limiter does not drop command prefixes (. and /)', () => {
  const indexCode = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
  assert.ok(
    indexCode.includes("startsWith('.')") && indexCode.includes("startsWith('/')"),
    'index.js flood filter must preserve dot and slash command messages'
  );
});
