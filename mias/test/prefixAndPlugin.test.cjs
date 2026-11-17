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

test('formatPluginCard matches the compact requested layout exactly', () => {
  const plugin = {
    name: 'couple pp',
    desc: 'Generate couple profile pictures.',
    type: 'misc',
    url: 'https://gist.github.com/ayazaliofc/9a1fbda1888e1b7bb8e1d81f0fc99c82',
    score: 5,
    upvotes: 6,
    downvotes: 1,
    creator: { username: 'ayazaliofc', name: 'Ayaz Ali' }
  };

  const expected = [
    '\u200e╔══════════════════════╗',
    '\u200e   🔌 *LEVANTER PLUGIN*',
    '\u200e╚══════════════════════╝',
    '',
    '\u200e📦 *Name:* couple pp',
    '\u200e📝 *Desc:* Generate couple profile pictures.',
    '\u200e━━━━━━━━━━━━━━━━━━━━━━━━━',
    '',
    '\u200e🔗 *Gist URL:*',
    '\u200ehttps://gist.github.com/ayazaliofc/9a1fbda1888e1b7bb8e1d81f0fc99c82',
    '\u200e━━━━━━━━━━━━━━━━━━━━━━━━━'
  ].join('\n');

  assert.equal(formatPluginCard(plugin, { prefix: '.' }), expected);
  assert.equal(formatPluginCard(plugin, { allItems: [plugin], prefix: '' }), expected);
  assert.doesNotMatch(expected, /Creator|Type|Score|Install|Other Matches/);
});

test('formatPluginCard keeps multi-match results short', () => {
  const items = [
    { name: 'ig downloader', desc: 'Download reels', url: 'https://gist.github.com/user/12345' },
    { name: 'ig story', desc: 'Download stories', url: 'https://gist.github.com/user/67890' }
  ];

  const card = formatPluginCard(items[0], { allItems: items, prefix: '.' });
  assert.ok(card.includes('*Name:* ig downloader'));
  assert.ok(!card.includes('ig story'));
  assert.ok(!card.includes('Other Matches'));
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
