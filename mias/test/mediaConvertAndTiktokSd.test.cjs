"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("tomp3 and tovn commands are registered with 🌀✅❌ and clean error handling", () => {
  const indexSource = fs.readFileSync(path.join(__dirname, "../index.js"), "utf8");

  // Verify tomp3 has react 🌀, ✅, ❌
  assert.match(indexSource, /cmd\(\["tomp3",\s*"toaudio"\]/);
  assert.match(indexSource, /react\(_0x1947df,\s*_0x5ae6a0,\s*['"]🌀['"]\)/);
  assert.match(indexSource, /react\(_0x1947df,\s*_0x5ae6a0,\s*['"]✅['"]\)/);
  assert.match(indexSource, /react\(_0x1947df,\s*_0x5ae6a0,\s*['"]❌['"]\)/);

  // Verify tovn has react 🌀, ✅, ❌
  assert.match(indexSource, /cmd\(\["tovn",\s*"toptt"\]/);
  assert.match(indexSource, /react\(_0x2c35b5,\s*_0x21cb8b,\s*['"]🌀['"]\)/);
  assert.match(indexSource, /react\(_0x2c35b5,\s*_0x21cb8b,\s*['"]✅['"]\)/);
  assert.match(indexSource, /react\(_0x2c35b5,\s*_0x21cb8b,\s*['"]❌['"]\)/);

  // Verify pan=stereo channel layout fix is present in audio conversion
  assert.match(indexSource, /pan=stereo\|c0=c0\|c1=c1/);
  assert.match(indexSource, /_cmfExtractCleanError/);
});

test("selectTikTokUrl chooses SD stream for SD modes (1.1, 1.2) and highest HD stream for 1.3/1.4", async () => {
  const { selectTikTokUrl } = await import("../features/tiktok.js");

  const mockInfo = {
    title: "Test Video",
    author: "Creator",
    videoHd: "https://v16-webapp-prime.tiktok.com/video/hd1080p.mp4",
    videoSd: "https://v16-webapp-prime.tiktok.com/video/sd720p.mp4",
    video: "https://v16-webapp-prime.tiktok.com/video/default.mp4",
    audio: "https://v16-webapp-prime.tiktok.com/audio/music.mp3",
  };

  // SD mode 1.1 should fetch true SD stream
  const sdUrl = selectTikTokUrl(mockInfo, { id: "1.1", kind: "video", quality: "sd" });
  assert.equal(sdUrl, "https://v16-webapp-prime.tiktok.com/video/sd720p.mp4");

  // SD mode 1.2 (document) should fetch true SD stream
  const sdDocUrl = selectTikTokUrl(mockInfo, { id: "1.2", kind: "video", quality: "sd", document: true });
  assert.equal(sdDocUrl, "https://v16-webapp-prime.tiktok.com/video/sd720p.mp4");

  // HD mode 1.3 should fetch the highest stream quality (HD 1080p)
  const hdUrl = selectTikTokUrl(mockInfo, { id: "1.3", kind: "video", quality: "hd" });
  assert.equal(hdUrl, "https://v16-webapp-prime.tiktok.com/video/hd1080p.mp4");

  // HD mode 1.4 (document) should fetch the highest stream quality (HD 1080p)
  const hdDocUrl = selectTikTokUrl(mockInfo, { id: "1.4", kind: "video", quality: "hd", document: true });
  assert.equal(hdDocUrl, "https://v16-webapp-prime.tiktok.com/video/hd1080p.mp4");

  // 1.8 and 1.9 (4K modes) remain untouched, fetching HD stream for 4K upscale
  const fourKUrl = selectTikTokUrl(mockInfo, { id: "1.8", kind: "video", quality: "4k", upscale4k: true });
  assert.equal(fourKUrl, "https://v16-webapp-prime.tiktok.com/video/hd1080p.mp4");

  const fourKDocUrl = selectTikTokUrl(mockInfo, { id: "1.9", kind: "video", quality: "4k", document: true, upscale4k: true });
  assert.equal(fourKDocUrl, "https://v16-webapp-prime.tiktok.com/video/hd1080p.mp4");

  // Fallback to videoHd when videoSd is absent for SD
  const mockHdOnly = {
    videoHd: "https://v16-webapp-prime.tiktok.com/video/hd1080p.mp4",
  };
  const fallbackHd = selectTikTokUrl(mockHdOnly, { id: "1.1", kind: "video", quality: "sd" });
  assert.equal(fallbackHd, "https://v16-webapp-prime.tiktok.com/video/hd1080p.mp4");

  // Fallback to videoSd when videoHd is absent for HD
  const mockSdOnly = {
    videoSd: "https://v16-webapp-prime.tiktok.com/video/sd720p.mp4",
  };
  const fallbackSd = selectTikTokUrl(mockSdOnly, { id: "1.3", kind: "video", quality: "hd" });
  assert.equal(fallbackSd, "https://v16-webapp-prime.tiktok.com/video/sd720p.mp4");
});

test("deliverTikTokFile skips re-encode completely for SD modes (1.1 and 1.2)", async () => {
  const delivery = require("../lib/ttDelivery.cjs");
  const os = require("node:os");

  const tmpFile = path.join(os.tmpdir(), "test_sd_direct_bypass_" + Date.now() + ".mp4");
  fs.writeFileSync(tmpFile, Buffer.alloc(4096, 0x33));

  let sentVideoPath = null;
  let sentDocPath = null;
  const mockSock = {
    user: { id: "bot@s.whatsapp.net" },
    sendMessage: async (jid, content) => {
      if (content?.video?.url) sentVideoPath = content.video.url;
      if (content?.document?.url) sentDocPath = content.document.url;
      return { key: { id: "SD_BYPASS_TEST" } };
    },
  };

  try {
    // Mode 1.1 SD inline video
    const res1 = await delivery.deliverTikTokFile({
      sock: mockSock,
      jid: "user@s.whatsapp.net",
      file: { path: tmpFile, bytes: 4096 },
      mode: { id: "1.1", format: "video", quality: "sd" },
      caption: "SD Test",
      fileName: "test_1_1.mp4",
    });
    assert.equal(res1.type, "video");
    assert.equal(sentVideoPath, tmpFile, "1.1 SD video must be sent directly from disk without re-encode");

    // Mode 1.2 SD document
    const res2 = await delivery.deliverTikTokFile({
      sock: mockSock,
      jid: "user@s.whatsapp.net",
      file: { path: tmpFile, bytes: 4096 },
      mode: { id: "1.2", format: "video", quality: "sd", document: true },
      caption: "SD Doc Test",
      fileName: "test_1_2.mp4",
    });
    assert.equal(res2.type, "document");
    assert.equal(sentDocPath, tmpFile, "1.2 SD document must be sent directly from disk without re-encode");
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
});

test("index.js TikTok picker streams SD choices to disk and preserves HD re-encode", () => {
  const indexSource = fs.readFileSync(path.join(__dirname, "../index.js"), "utf8");

  // Verify maxBufferedBytes streams SD choices to disk
  assert.match(indexSource, /maxBufferedBytes['"]?:\s*_isSdChoice\s*\?\s*0x0/);

  // Verify _isSdChoice is scoped to SD modes
  assert.match(indexSource, /const _isSdChoice = Boolean\(_0x16720b && \(_0x16720b\[['"]quality['"]\] === ['"]sd['"]/);

  // Verify HD 1.3/1.4 line 60018 re-encodes with 1.2 boost
  assert.match(indexSource, /sourceQualityBoost['"]?:\s*_0x1f5e2c\[['"]id['"]\] === ['"]1\.3['"] \|\| _0x1f5e2c\[['"]id['"]\] === ['"]1\.4['"] \? 1\.2 : null/);
});
