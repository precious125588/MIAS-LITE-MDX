'use strict';

const https = require('https');

const LEVANTER_API_BASE = 'https://levanter-plugin.levanter.site';
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const cache = new Map(); // query -> { timestamp, items }

function cleanQuery(query) {
  return String(query || '').trim().toLowerCase();
}

function httpGetJson(url, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*'
      },
      timeout: timeoutMs
    }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} from Levanter API`));
      }
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(raw);
          resolve(parsed);
        } catch (err) {
          reject(new Error(`Invalid JSON from Levanter API: ${err.message}`));
        }
      });
    });

    req.on('timeout', () => {
      req.destroy(new Error(`Request timed out after ${timeoutMs}ms`));
    });

    req.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Searches levanter.site for plugins matching the query.
 * @param {string} rawQuery
 * @returns {Promise<{ success: boolean, items: Array, query: string, error?: string }>}
 */
async function searchLevanterPlugins(rawQuery, opts = {}) {
  const query = cleanQuery(rawQuery);
  if (!query) {
    return { success: false, items: [], query: '', error: 'Query is empty' };
  }

  const now = Date.now();
  if (!opts.bypassCache && cache.has(query)) {
    const cached = cache.get(query);
    if (now - cached.timestamp < CACHE_TTL_MS) {
      return { success: true, items: cached.items, query, fromCache: true };
    }
  }

  try {
    const apiUrl = `${LEVANTER_API_BASE}/plugin?q=${encodeURIComponent(query)}`;
    const data = await (opts.fetcher || httpGetJson)(apiUrl, opts.timeoutMs || 12000);
    const rawItems = Array.isArray(data?.items) ? data.items : [];

    const items = rawItems.map((item) => ({
      id: item.id || '',
      name: item.name || 'Unnamed Plugin',
      desc: item.desc || '',
      type: item.type || 'misc',
      url: item.url || '',
      approved: Boolean(item.approved),
      upvotes: Number(item.upvotes || 0),
      downvotes: Number(item.downvotes || 0),
      score: Number(item.score || 0),
      creator: {
        username: item.creator?.username || 'anonymous',
        name: item.creator?.name || '',
        avatar: item.creator?.avatar || ''
      }
    })).filter((item) => item.url && item.url.includes('gist.github.com'));

    cache.set(query, { timestamp: now, items });
    return { success: true, items, query };
  } catch (err) {
    return { success: false, items: [], query, error: err.message || 'Network error' };
  }
}

/**
 * Formats a plugin card message.
 * @param {Object} plugin
 * @param {Object} opts
 * @returns {string}
 */
function formatPluginCard(plugin) {
  if (!plugin || !plugin.url) {
    return '❌ No plugin information available.';
  }

  const lines = [
    '\u200e╔══════════════════════╗',
    '\u200e   🔌 *LEVANTER PLUGIN*',
    '\u200e╚══════════════════════╝',
    '',
    `\u200e📦 *Name:* ${plugin.name || 'Unnamed Plugin'}`,
    `\u200e📝 *Desc:* ${plugin.desc || 'No description provided.'}`,
    '\u200e━━━━━━━━━━━━━━━━━━━━━━━━━',
    '',
    '\u200e🔗 *Gist URL:*',
    `\u200e${plugin.url}`,
    '\u200e━━━━━━━━━━━━━━━━━━━━━━━━━'
  ];

  return lines.join('\n');
}

module.exports = {
  searchLevanterPlugins,
  formatPluginCard,
  cleanQuery,
  _cache: cache
};
