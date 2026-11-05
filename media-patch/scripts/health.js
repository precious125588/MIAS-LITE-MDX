#!/usr/bin/env node
// Live check of every provider. Run:  node scripts/health.js "yala"
require('dotenv').config?.();
const { audioChain, videoChain } = require('../src/providers');
const { resolveMedia } = require('../src/mediaPipeline');

const query = process.argv[2] || 'yala';

(async () => {
  for (const p of [...audioChain, ...videoChain]) {
    const t0 = Date.now();
    try {
      const m = await p.searchTrack(query);
      console.log(
        `OK   ${String(p.name).padEnd(14)} ${Date.now() - t0}ms  ${m.title} — ${m.author}` +
          (m.preview ? '  (30s preview)' : '') +
          (m.linkOnly ? '  (link only)' : ''),
      );
    } catch (e) {
      console.log(`FAIL ${String(p.name).padEnd(14)} ${Date.now() - t0}ms  ${e.message}`);
    }
  }
  try {
    const best = await resolveMedia(audioChain, query);
    console.log(`\nChain winner: ${best.provider} -> ${best.url.slice(0, 80)}`);
  } catch (e) {
    console.log(`\nChain failed: ${e.message}`);
  }
})();
