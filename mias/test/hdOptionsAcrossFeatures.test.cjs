const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

test("nexray lyrics passes query param to lyrics search endpoint", () => {
  const content = fs.readFileSync("mias/nexray_bot.cjs", "utf8");
  assert.ok(content.includes("cmd(['lyrics', 'srch-lyrics'], { desc: 'Search song lyrics (English)', category: 'Nexray-Search' }, _search(o => nx.search.lyrics(o), 'Lyrics Search', '🎶', 'query'));"));
  assert.ok(content.includes("cmd(['search-lirik', 'srch-lirik'], { desc: 'Search song lyrics', category: 'Nexray-Search' }, _search(o => nx.search.lirik(o), 'Lirik Search', '🎵', 'query'));"));
  assert.ok(content.includes("const param = { text: q, query: q, q };"));
});

test("precious-fixes-v21 aioHandler intercepts TikTok and routes to __miasTikTokHdDownload", () => {
  const content = fs.readFileSync("mias/precious-fixes-v21.cjs", "utf8");
  assert.ok(content.includes("globalThis.__miasTikTokHdDownload"));
  assert.ok(content.includes("tiktok\\.com"));
});

test("autoDownloader applies reencodeHdForWhatsApp for TikTok platform", () => {
  const content = fs.readFileSync("mias/lib/autoDownloader.js", "utf8");
  assert.ok(content.includes("if (platform === \"tiktok\")"));
  assert.ok(content.includes("reencodeHdForWhatsApp"));
  assert.ok(content.includes("boost: 1.2"));
  assert.ok(content.includes("sourceQualityBoost: 1.2"));
});

test("splitVideo sendVideoFile applies reencodeHdForWhatsApp with 1.2 boost", () => {
  const content = fs.readFileSync("mias/features/splitVideo.js", "utf8");
  assert.ok(content.includes("reencodeHdForWhatsApp(file, {"));
  assert.ok(content.includes("boost: 1.2"));
  assert.ok(content.includes("sourceQualityBoost: 1.2"));
});

test("videoTools convertToMp4 applies reencodeHdForWhatsApp with 1.2 boost", () => {
  const content = fs.readFileSync("mias/lib/videoTools.js", "utf8");
  assert.ok(content.includes("reencodeHdForWhatsApp(outPath, {"));
  assert.ok(content.includes("boost: 1.2"));
  assert.ok(content.includes("sourceQualityBoost: 1.2"));
});
