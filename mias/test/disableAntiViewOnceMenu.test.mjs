import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMenuEntryVisible, canonicalMenuEntries } from '../lib/premiumMenus.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('antivonce is removed from groupAdvCmds in mias/index.js', () => {
  const indexPath = path.join(__dirname, '../index.js');
  const indexContent = fs.readFileSync(indexPath, 'utf8');

  // Verify groupAdvCmds doesn't have antivonce
  const groupAdvMatch = indexContent.match(/const groupAdvCmds = \{([\s\S]*?)\};/);
  assert.ok(groupAdvMatch, 'groupAdvCmds block should exist in index.js');
  assert.equal(groupAdvMatch[1].includes("'antivonce'"), false, 'groupAdvCmds should not contain antivonce');

  // Verify DISABLED_COMMANDS contains antivonce
  const disabledMatch = indexContent.match(/const DISABLED_COMMANDS = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(disabledMatch, 'DISABLED_COMMANDS block should exist in index.js');
  assert.ok(disabledMatch[1].includes('"antivonce"'), 'DISABLED_COMMANDS should contain antivonce');
});

test('isMenuEntryVisible hides antivonce, antiviewonce and antivo from all menus including GROUP', () => {
  const dummyEntry = {
    desc: '🛡️ Anti-view-once: Bot will save view-once messages.',
    category: 'GROUP',
    handler: async () => {},
    enabled: true
  };

  assert.equal(isMenuEntryVisible('antivonce', dummyEntry), false, 'antivonce should be hidden from menu');
  assert.equal(isMenuEntryVisible('antiviewonce', dummyEntry), false, 'antiviewonce should be hidden from menu');
  assert.equal(isMenuEntryVisible('antivo', dummyEntry), false, 'antivo should be hidden from menu');
});

test('canonicalMenuEntries excludes antivonce from the GROUP menu category', () => {
  const commands = new Map();
  commands.set('antivonce', {
    desc: '🛡️ Anti-view-once',
    category: 'GROUP',
    enabled: true,
    handler: async () => {}
  });
  commands.set('tagall', {
    desc: 'Tag all members',
    category: 'GROUP',
    enabled: true,
    handler: async () => {}
  });

  const categories = [{ name: 'GROUP', emoji: '👥', cmds: ['tagall'] }];
  const entries = canonicalMenuEntries(commands, new Map(), categories, { owner: true, group: true });

  const names = entries.map(e => e.name);
  assert.ok(names.includes('tagall'), 'tagall should be present');
  assert.equal(names.includes('antivonce'), false, 'antivonce must not be present in canonical entries');
});
