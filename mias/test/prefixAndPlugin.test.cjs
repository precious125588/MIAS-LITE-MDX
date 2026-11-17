'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { searchLevanterPlugins, formatPluginCard, cleanQuery } = require('../lib/levanterPluginSearch.cjs');
const { buildAliasReport } = require('../lib/aliasCheck.cjs');

test('cleanQuery trims and lowercases inputs', () => {
  assert.equal(cleanQuery('  COUPLE  '), 'couple');
  assert.equal(cleanQuery(''), '');
  assert.equal(cleanQuery(null), '');
});

test('formatPluginCard renders card with couple plugin and Gist URL', () => {
  const plugin = {
    name: 'couple pp',
    desc: 'Generate couple profile pictures.',
    type: 'misc',
    url: 'https://gist.github.com/ayazaliofc/9a1fbda1888e1b7bb8e1d81f0fc99c82',
    score: 5,
    upvotes: 6,
    downvotes: 1,
    creator: {
      username: 'ayazaliofc',
      name: 'Ayaz Ali'
    }
  };

  const cardWithDot = formatPluginCard(plugin, { prefix: '.' });
  assert.ok(cardWithDot.includes('couple pp'), 'Card should contain plugin name');
  assert.ok(cardWithDot.includes('Generate couple profile pictures.'), 'Card should contain description');
  assert.ok(cardWithDot.includes('https://gist.github.com/ayazaliofc/9a1fbda1888e1b7bb8e1d81f0fc99c82'), 'Card should contain Gist URL');
  assert.ok(cardWithDot.includes('.plugin https://gist.github.com'), 'Card should show install instruction with prefix');

  // Test with empty prefix (none/null mode)
  const cardRaw = formatPluginCard(plugin, { prefix: '' });
  assert.ok(cardRaw.includes('plugin https://gist.github.com'), 'Card should show raw install command without dot in none mode');
});

test('formatPluginCard renders multiple matches cleanly', () => {
  const items = [
    {
      name: 'ig downloader',
      desc: 'Download reels',
      url: 'https://gist.github.com/user/12345',
      creator: { username: 'testuser' }
    },
    {
      name: 'ig story',
      desc: 'Download stories',
      url: 'https://gist.github.com/user/67890',
      creator: { username: 'testuser' }
    }
  ];

  const card = formatPluginCard(items[0], { allItems: items, prefix: '.' });
  assert.ok(card.includes('ig downloader'));
  assert.ok(card.includes('Other Matches (1):'));
  assert.ok(card.includes('.getplugin ig story'));
});

test('searchLevanterPlugins fetches real plugins from levanter-plugin.levanter.site', async () => {
  const res = await searchLevanterPlugins('couple');
  assert.equal(res.success, true, 'Search should succeed');
  assert.ok(Array.isArray(res.items), 'Items should be an array');
  assert.ok(res.items.length > 0, 'Should find at least 1 couple plugin');

  const first = res.items[0];
  assert.ok(first.name.toLowerCase().includes('couple'), 'Plugin name should match couple query');
  assert.ok(first.url.startsWith('https://gist.github.com/'), 'Plugin URL must be a GitHub Gist URL');
});

test('buildAliasReport respects prefix setting', () => {
  const commands = new Map([['ping', { canonical: 'ping' }]]);
  const aliases = new Map([['latency', 'ping']]);

  const reportDot = buildAliasReport('ping', commands, aliases, { prefix: '.' });
  assert.ok(reportDot.includes('*.ping*'));
  assert.ok(reportDot.includes('.latency'));

  const reportNone = buildAliasReport('ping', commands, aliases, { prefix: '' });
  assert.ok(reportNone.includes('*ping*'));
  assert.ok(reportNone.includes('latency'));
  assert.ok(!reportNone.includes('*.ping*'));
});
