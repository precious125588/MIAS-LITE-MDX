import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isMenuEntryVisible, canonicalMenuEntries } from '../lib/premiumMenus.js';
import { formatPluginCard } from '../lib/miasPluginSearch.cjs';

test('formatPluginCard renders tight 3-line format without excess text', () => {
  const card = formatPluginCard({
    name: 'test-plugin',
    desc: 'Useful utility',
    url: 'https://gist.github.com/example/123'
  });
  const lines = card.split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^🔌 \*PLUGIN:\* \*test-plugin\*$/);
  assert.match(lines[1], /^📝 \*Desc:\* Useful utility$/);
  assert.match(lines[2], /^🔗 \*Gist:\* https:\/\/gist\.github\.com\/example\/123$/);
});

test('canonicalMenuEntries collapses aliases and excludes disabled/duplicate entries', () => {
  const commands = new Map();
  const aliases = new Map();

  commands.set('getplugin', { name: 'getplugin', handler: () => {}, category: 'CREATOR' });
  commands.set('getplugin1', { name: 'getplugin1', handler: () => {}, category: 'CREATOR' });
  commands.set('antivonce', { name: 'antivonce', handler: () => {}, category: 'GROUP' });
  commands.set('groupstatus', { name: 'groupstatus', handler: () => {}, category: 'GROUP' });
  commands.set('gst', { name: 'gst', handler: () => {}, category: 'GROUP' });
  commands.set('gstatus', { name: 'gstatus', handler: () => {}, category: 'GROUP' });
  commands.set('gcstatus', { name: 'gcstatus', handler: () => {}, category: 'GROUP' });
  commands.set('4k', { name: '4k', handler: () => {}, category: 'MEDIA' });
  commands.set('remini4k', { name: 'remini4k', handler: () => {}, category: 'MEDIA' });
  commands.set('hd', { name: 'hd', handler: () => {}, category: 'MEDIA' });
  commands.set('tthd', { name: 'tthd', handler: () => {}, category: 'MEDIA' });

  const categories = [
    { name: 'CREATOR', cmds: ['getplugin', 'getplugin1'] },
    { name: 'GROUP', cmds: ['groupstatus', 'gst', 'gstatus', 'gcstatus', 'antivonce'] },
    { name: 'MEDIA', cmds: ['4k', 'remini4k', 'hd', 'tthd'] }
  ];

  const entries = canonicalMenuEntries(commands, aliases, categories, { owner: true });
  const names = entries.map(e => e.name);

  assert.ok(names.includes('getplugin'), 'getplugin must be present');
  assert.ok(!names.includes('getplugin1'), 'getplugin1 must be excluded');
  assert.ok(!names.includes('antivonce'), 'antivonce must be excluded');
  assert.ok(names.includes('groupstatus'), 'groupstatus must be present');
  assert.ok(!names.includes('gst'), 'gst must be collapsed');
  assert.ok(!names.includes('gstatus'), 'gstatus must be collapsed');
  assert.ok(!names.includes('gcstatus'), 'gcstatus must be collapsed');
  assert.ok(names.includes('4k'), '4k must be present');
  assert.ok(!names.includes('remini4k'), 'remini4k must be collapsed');
  assert.ok(names.includes('hd'), 'hd must be present');
  assert.ok(!names.includes('tthd'), 'tthd must be collapsed');
});

test('cuzCustomization exposes callExclude as option 22 in status list', () => {
  const cuzFile = fs.readFileSync(new URL('../features/cuzCustomization.cjs', import.meta.url), 'utf8');
  assert.ok(cuzFile.includes('callExclude'), 'cuzCustomization must include callExclude');
  assert.ok(cuzFile.includes('22. Call Exceptions'), 'cuz menu prompt must include 22. Call Exceptions');
});
