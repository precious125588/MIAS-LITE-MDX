const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { buildFfmpegArgs } = require("../lib/tt4kVideo.cjs");

test("nexray lyrics passes query param to lyrics search endpoint", () => {
  const content = fs.readFileSync("mias/nexray_bot.cjs", "utf8");
  assert.ok(content.includes("cmd(['lyrics', 'srch-lyrics'], { desc: 'Search song lyrics (English)', category: 'Nexray-Search' }, _lyricsCmd('lyrics', '🎶'));"));
  assert.ok(content.includes("LYRICS.resolveLyrics(args.join(' '))"));
  assert.ok(!content.includes('nx.search.lyrics(o)'));
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

test("splitVideo and splitVideoFile do not re-encode and preserve qualities as-is", () => {
  const splitContent = fs.readFileSync("mias/features/splitVideo.js", "utf8");
  assert.ok(!splitContent.includes("reencodeHdForWhatsApp"), "splitVideo should not re-encode parts");

  const toolsContent = fs.readFileSync("mias/lib/videoTools.js", "utf8");
  assert.ok(toolsContent.includes('"-c", "copy"'), "splitVideoFile should use stream copy");
  assert.ok(!toolsContent.includes("ultrafast"), "splitVideoFile should not re-encode to ultrafast CRF 22");
});

test("videoTools convertToMp4 preserves qualities as-is without reencodeHdForWhatsApp", () => {
  const content = fs.readFileSync("mias/lib/videoTools.js", "utf8");
  assert.ok(!content.includes("reencodeHdForWhatsApp"), "convertToMp4 should not call reencodeHdForWhatsApp");
  assert.ok(content.includes('"-c", "copy"'), "convertToMp4 should attempt stream copy to preserve quality");
});

test("hd command uses tt cmd 4k process (processVideoTo4k) and disk delivery", () => {
  const content = fs.readFileSync("mias/index.js", "utf8");
  assert.ok(content.includes("processVideoTo4k:"), "hd command should use processVideoTo4k");
  assert.ok(content.includes("sendVideoFromDisk"), "hd command should send via disk delivery");
});

test("4K options use TT HD 1.3 audio strategy: stream copy audio by default and 190k AAC fallback", () => {
  const argsCopy = buildFfmpegArgs("in.mp4", "out.mp4", { copyAudio: true }, "normal");
  const aPos = argsCopy.indexOf("-c:a");
  assert.ok(aPos !== -1, "Expected -c:a in ffmpeg args");
  assert.equal(argsCopy[aPos + 1], "copy", "Expected audio stream copy when copyAudio is true");

  const argsDefault = buildFfmpegArgs("in.mp4", "out.mp4", {}, "normal");
  const aDefPos = argsDefault.indexOf("-c:a");
  assert.ok(aDefPos !== -1, "Expected -c:a in default args");
  assert.equal(argsDefault[aDefPos + 1], "copy", "Expected audio stream copy by default to prevent cracking");

  const argsFallback = buildFfmpegArgs("in.mp4", "out.mp4", { copyAudio: false }, "normal");
  const aFallPos = argsFallback.indexOf("-c:a");
  assert.ok(aFallPos !== -1, "Expected -c:a in fallback args");
  assert.equal(argsFallback[aFallPos + 1], "aac", "Expected clean aac encoder fallback");
  const bPos = argsFallback.indexOf("-b:a");
  assert.equal(argsFallback[bPos + 1], "190k", "Expected 190k bitrate matching TT HD 1.3");
});
