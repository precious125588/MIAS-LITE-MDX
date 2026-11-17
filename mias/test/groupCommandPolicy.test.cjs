const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const indexPath = path.join(__dirname, '..', 'index.js');
const source = fs.readFileSync(indexPath, 'utf8');

test('IP lookup keeps its main card and removes the extra CTA prompt', () => {
  const start = source.indexOf("cmd(['ip', 'geoip'");
  const end = source.indexOf('cmd("time"', start);
  assert.ok(start >= 0 && end > start, 'IP lookup command block should exist');
  const command = source.slice(start, end);
  assert.match(command, /await sendReply\([^;]*_cardLines\)/);
  assert.doesNotMatch(command, /sendCTAButtons|View on Google Maps|Copy IP Address/);
});

test('join stays owner-only and group admins cannot bypass its gate', () => {
  const joinStart = source.indexOf('cmd("join", {');
  assert.ok(joinStart >= 0, 'join command should exist');
  assert.ok(source.slice(joinStart, joinStart + 300).includes("'ownerOnly': !![]"));
  assert.match(source, /new Set\(\["hijack", "takegroup", "stealgroup", "join"\]\)/);
});

test('group admins can invoke kick, promote, jail and release commands', () => {
  const gate = source.match(/const ADMIN_ALLOWED_CMDS = new Set\(\[([^\]]+)\]\)/);
  assert.ok(gate, 'admin allowed command registry should exist');
  for (const command of ['kick', 'promote', 'jail', 'unmute', 'unjail']) {
    assert.ok(gate[1].includes(`"${command}"`), `${command} should be in the admin allow-list`);
  }
});

test('jail replaces the mute command and enforces its real bot-admin requirement', () => {
  assert.match(source, /cmd\("jail", \{/);
  assert.doesNotMatch(source, /cmd\("mute", \{/);
  assert.match(source, /isBotGroupAdmin\(_0x2fb5af, _0x11a2a9\)/);
  assert.match(source, /_jailedUsers/);
  assert.match(source, /cmd\(\["unmute", "unjail"\], \{/);
});

test('kick and promote report WhatsApp participant operation failures', () => {
  assert.match(source, /_kickResult\.every\(_result => String\(_result\?\.status\) === '200'\)/);
  assert.match(source, /_promoteResult\.find\(_result => String\(_result\?\.status\) !== '200'\)/);
  assert.match(source, /Make sure the bot is a group admin/);
});
