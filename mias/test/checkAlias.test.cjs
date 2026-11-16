'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeCommandName, buildAliasReport } = require('../lib/aliasCheck.cjs');

function registry() {
  const commands = new Map();
  const aliases = new Map();
  const handler = () => {};
  commands.set('ping', { handler, canonical: 'ping', isAlias: false });
  commands.set('latency', { handler, canonical: 'ping', isAlias: true });
  commands.set('pong', { handler, canonical: 'ping', isAlias: true });
  aliases.set('latency', 'ping');
  aliases.set('pong', 'ping');
  commands.set('vv', { handler, canonical: 'vv', isAlias: false });
  return { commands, aliases };
}

test('normalizeCommandName strips prefixes, spaces and case', () => {
  assert.equal(normalizeCommandName('.Ping'), 'ping');
  assert.equal(normalizeCommandName('  !vv extra words'), 'vv');
  assert.equal(normalizeCommandName(''), '');
  assert.equal(normalizeCommandName(undefined), '');
});

test('canonical command lists all its aliases', () => {
  const { commands, aliases } = registry();
  const text = buildAliasReport('ping', commands, aliases);
  assert.match(text, /Command: \*\.ping\*/);
  assert.match(text, /Aliases: \.latency, \.pong/);
});

test('alias input resolves to canonical and says so', () => {
  const { commands, aliases } = registry();
  const text = buildAliasReport('.latency', commands, aliases);
  assert.match(text, /Command: \*\.ping\*/);
  assert.match(text, /\*\.latency\* is an alias of \*\.ping\*/);
});

test('command with no aliases shows None', () => {
  const { commands, aliases } = registry();
  const text = buildAliasReport('vv', commands, aliases);
  assert.match(text, /Aliases: None/);
});

test('unknown command gets a clear not-found reply', () => {
  const { commands, aliases } = registry();
  assert.equal(buildAliasReport('nope', commands, aliases), '❌ No command named *.nope* was found.');
});

test('missing argument shows usage', () => {
  const { commands, aliases } = registry();
  assert.match(buildAliasReport('', commands, aliases), /Usage: \.checkalias <command>/);
});

test('disabled flag is reported when provided', () => {
  const { commands, aliases } = registry();
  const text = buildAliasReport('ping', commands, aliases, { isDisabled: n => n === 'ping' });
  assert.match(text, /currently disabled/);
});
