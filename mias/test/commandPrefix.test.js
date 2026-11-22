import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parseBareCommand } = require('../lib/commandPrefix.cjs');
const known = name => ['menu', 'ytmp4', 'groq'].includes(name);

test('no-prefix mode accepts a known bare command', () => {
  assert.deepEqual(parseBareCommand('ytmp4 https://example.test/video', known), {
    isCommand: true, prefix: '', raw: 'ytmp4 https://example.test/video', name: 'ytmp4'
  });
});

test('no-prefix mode silently ignores prefixed commands', () => {
  for (const text of ['.menu', '!groq hello', '/ytmp4 https://example.test/video']) {
    assert.equal(parseBareCommand(text, known).isCommand, false, text);
  }
});
