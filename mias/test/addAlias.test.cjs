'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../lib/aliasStore.cjs');
const { buildAliasReport } = require('../lib/aliasCheck.cjs');

function registry() {
  const commands = new Map();
  const aliases = new Map();
  const handler = () => 'pong!';
  commands.set('ping', { handler, canonical: 'ping', isAlias: false, category: 'SYSTEM', disabled: false, enabled: true });
  commands.set('vv', { handler: () => 'vv', canonical: 'vv', isAlias: false, category: 'OWNER' });
  commands.set('latency', { handler, canonical: 'ping', isAlias: true });
  aliases.set('latency', 'ping');
  return { commands, aliases };
}
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'alias-')), 'nexstore', 'command_aliases.json');

test('parses "ping | fast" and "ping|fast"', () => {
  assert.deepEqual(store.parseAddAliasInput('ping | fast'), { command: 'ping', alias: 'fast' });
  assert.deepEqual(store.parseAddAliasInput('ping|fast'), { command: 'ping', alias: 'fast' });
  assert.deepEqual(store.parseAddAliasInput('.Ping | Fast'), { command: 'ping', alias: 'fast' });
});

test('rejects malformed input', () => {
  assert.equal(store.parseAddAliasInput('ping').error, 'usage');
  assert.equal(store.parseAddAliasInput('| fast').error, 'usage');
  assert.equal(store.parseAddAliasInput('ping |').error, 'usage');
  assert.equal(store.parseAddAliasInput('ping | a | b').error, 'usage');
  assert.equal(store.parseAddAliasInput('ping | fast extra').error, 'format');
  assert.equal(store.parseAddAliasInput('ping | fa$t').error, 'format');
  assert.equal(store.parseAddAliasInput('ping | ' + 'x'.repeat(31)).error, 'format');
});

test('adds a working alias that shares the command handler', () => {
  const { commands, aliases } = registry();
  const file = tmpFile();
  const msg = store.addAliasPersisted({ commands, aliases, file, command: 'ping', alias: 'fast' });
  assert.match(msg, /is now an alias of \*\.ping\*/);
  assert.equal(commands.get('fast').handler, commands.get('ping').handler);
  assert.equal(commands.get('fast').canonical, 'ping');
  assert.equal(commands.get('fast').isAlias, true);
  assert.equal(aliases.get('fast'), 'ping');
  assert.equal('disabled' in commands.get('fast'), false, 'copied enable/disable flags are dropped');
});

test('the alias shows up in checkalias', () => {
  const { commands, aliases } = registry();
  store.addAliasPersisted({ commands, aliases, file: tmpFile(), command: 'ping', alias: 'fast' });
  const report = buildAliasReport('ping', commands, aliases);
  assert.match(report, /Aliases: \.fast, \.latency/);
});

test('an alias of an alias resolves to the real command', () => {
  const { commands, aliases } = registry();
  const msg = store.addAliasPersisted({ commands, aliases, file: tmpFile(), command: 'latency', alias: 'fast' });
  assert.match(msg, /alias of \*\.ping\*/);
  assert.equal(aliases.get('fast'), 'ping');
});

test('refuses unknown commands, taken names and self-alias', () => {
  const { commands, aliases } = registry();
  const file = tmpFile();
  assert.match(store.addAliasPersisted({ commands, aliases, file, command: 'nope', alias: 'fast' }), /No command named \*\.nope\*/);
  assert.match(store.addAliasPersisted({ commands, aliases, file, command: 'ping', alias: 'vv' }), /\*\.vv\* is already used/);
  assert.match(store.addAliasPersisted({ commands, aliases, file, command: 'ping', alias: 'latency' }), /already used/);
  assert.match(store.addAliasPersisted({ commands, aliases, file, command: 'ping', alias: 'ping' }), /same/);
  assert.equal(commands.has('fast'), false);
  assert.equal(fs.existsSync(file), false, 'nothing saved on refusal');
});

test('survives a restart: saved alias is restored into fresh maps', () => {
  const file = tmpFile();
  const first = registry();
  store.addAliasPersisted({ commands: first.commands, aliases: first.aliases, file, command: 'ping', alias: 'fast' });

  const after = registry(); // a fresh process: only built-in commands exist
  assert.equal(after.commands.has('fast'), false);
  const n = store.restoreAliases(after.commands, after.aliases, store.loadAliasStore(file));
  assert.equal(n, 1);
  assert.equal(after.aliases.get('fast'), 'ping');
  assert.equal(after.commands.get('fast').handler(), 'pong!');
});

test('adding the same alias twice does not duplicate the saved entry', () => {
  const { commands, aliases } = registry();
  const file = tmpFile();
  store.addAliasPersisted({ commands, aliases, file, command: 'ping', alias: 'fast' });
  const second = store.addAliasPersisted({ commands, aliases, file, command: 'ping', alias: 'fast' });
  assert.match(second, /already used/);
  assert.equal(store.loadAliasStore(file).length, 1);
});

test('restore skips a stale alias whose name is now taken or whose command is gone', () => {
  const file = tmpFile();
  store.saveAliasStore(file, [
    { alias: 'pong', command: 'ping' },   // name now used by a real command
    { alias: 'zap', command: 'removed' }, // command no longer exists
    { alias: 'fast', command: 'ping' },
  ]);
  const { commands, aliases } = registry();
  commands.set('pong', { handler: () => 'real pong', canonical: 'pong', isAlias: false });
  const skipped = [];
  const n = store.restoreAliases(commands, aliases, store.loadAliasStore(file), (a, r) => skipped.push(a));
  assert.equal(n, 1);
  assert.deepEqual(skipped.sort(), ['pong', 'zap']);
  assert.equal(commands.get('pong').handler(), 'real pong', 'real command not overwritten');
});

test('a corrupt or missing store loads as empty and does not throw', () => {
  const file = tmpFile();
  assert.deepEqual(store.loadAliasStore(file), []);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{not json');
  assert.deepEqual(store.loadAliasStore(file), []);
});

test('a failed save rolls back the in-memory alias', () => {
  const { commands, aliases } = registry();
  const blocker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'alias-')), 'afile');
  fs.writeFileSync(blocker, 'x');
  const file = path.join(blocker, 'command_aliases.json'); // parent is a file, so the save cannot succeed
  const msg = store.addAliasPersisted({ commands, aliases, file, command: 'ping', alias: 'fast' });
  assert.match(msg, /Could not save/);
  assert.equal(commands.has('fast'), false);
  assert.equal(aliases.has('fast'), false);
});
