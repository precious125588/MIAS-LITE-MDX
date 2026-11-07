'use strict';
// Startup should not print known-harmless lines: the SQLite experimental
// warning and the dotenv "injected env" banner. Real warnings still print.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { isExpectedWarning } = require('../lib/crash-shield.cjs');

test('the SQLite experimental warning is filtered', () => {
  const w = { name: 'ExperimentalWarning', message: 'SQLite is an experimental feature and might change at any time' };
  assert.equal(isExpectedWarning(w), true);
});

test('other warnings still print', () => {
  assert.equal(isExpectedWarning({ name: 'DeprecationWarning', message: 'SQLite is an experimental feature' }), false);
  assert.equal(isExpectedWarning({ name: 'ExperimentalWarning', message: 'Something else is experimental' }), false);
});

test('the server child is started with the dotenv banner silenced', () => {
  const src = fs.readFileSync(path.join(__dirname, 'start-with-session-migration.cjs'), 'utf8');
  assert.match(src, /DOTENV_CONFIG_QUIET: 'true'/);
  assert.match(src, /--disable-warning=ExperimentalWarning/);
});
