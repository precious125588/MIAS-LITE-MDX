import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { activeMenuCategories } from '../lib/premiumMenus.js';

const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');

test('DALL, Groq and OpenRouter are registered with AI handlers', () => {
  for (const command of ['dall', 'groq', 'or']) {
    assert.match(source, new RegExp(`cmd\\(\\[[^\\]]*\\b${command}\\b[^\\]]*\\]\\s*,\\s*\\{[\\s\\S]*?category.?\\s*:\\s*["']AI["']`, 'i'));
  }
  assert.match(source, /getDallEResponse/);
  assert.match(source, /groqResponse/);
  assert.match(source, /openRouter/);
});

test('AI commands appear in both category and all-command menus when registered', () => {
  const handler = async () => {};
  const commands = new Map([
    ['dall', { handler, category: 'AI', canonical: 'dall' }],
    ['groq', { handler, category: 'AI', canonical: 'groq' }],
    ['or', { handler, category: 'AI', canonical: 'or' }],
  ]);
  const categories = [{ name: 'AI', emoji: '🤖', cmds: ['dall', 'groq', 'or'] }];
  const active = activeMenuCategories(commands, new Map(), categories, { owner: false });
  assert.deepEqual(active.find(item => item.name === 'AI')?.cmds, ['dall', 'groq', 'or']);
});
