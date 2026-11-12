const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { HD_OPTIONS, reencodeFileHd, reencodeBufferHd } = require("../lib/hdVideoPipeline.cjs");

function tmpFile(name, data) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hdtest-"));
  const p = path.join(dir, name);
  fs.writeFileSync(p, data);
  return p;
}

test("HD options match the TikTok 1.3 command (1.2 boost, 95 MB cap)", () => {
  assert.equal(HD_OPTIONS.boost, 1.2);
  assert.equal(HD_OPTIONS.sourceQualityBoost, 1.2);
  assert.equal(HD_OPTIONS.maxBytes, 95 * 1024 * 1024);
});

test("reencodeFileHd sends the re-encoded file and passes HD options to the encoder", async () => {
  const input = tmpFile("in.mp4", Buffer.from("original-bytes"));
  const out = tmpFile("out.mp4", Buffer.from("hd-encoded-bytes-that-are-longer"));
  let seen = null;
  let cleaned = false;
  const res = await reencodeFileHd(input, {
    encoder: async (p, opts) => {
      seen = { p, opts };
      return { path: out, bytes: fs.statSync(out).size, cleanup: async () => { cleaned = true; } };
    },
  });
  assert.equal(res.path, out);
  assert.equal(res.hd, true);
  assert.equal(seen.p, input);
  assert.equal(seen.opts.boost, 1.2);
  assert.equal(seen.opts.sourceQualityBoost, 1.2);
  await res.cleanup();
  assert.equal(cleaned, true);
});

test("reencodeFileHd falls back to the original file when the encoder throws", async () => {
  const input = tmpFile("in.mp4", Buffer.from("original"));
  const res = await reencodeFileHd(input, { encoder: async () => { throw new Error("ffmpeg missing"); } });
  assert.equal(res.path, input);
  assert.equal(res.hd, false);
  await res.cleanup();
});

test("reencodeFileHd keeps the original when no encoder is available", async () => {
  const input = tmpFile("in.mp4", Buffer.from("original"));
  const res = await reencodeFileHd(input, { encoder: null });
  assert.equal(res.path, input);
  assert.equal(res.hd, false);
});

test("reencodeFileHd ignores an encoder result that points at a missing file", async () => {
  const input = tmpFile("in.mp4", Buffer.from("original"));
  const res = await reencodeFileHd(input, {
    encoder: async () => ({ path: "/nonexistent/hd.mp4", bytes: 100, cleanup: async () => {} }),
  });
  assert.equal(res.path, input);
  assert.equal(res.hd, false);
});

test("reencodeBufferHd returns the re-encoded bytes", async () => {
  const buf = Buffer.from("original-video");
  const hdBytes = Buffer.from("HD-VIDEO-BYTES-LARGER-THAN-ORIGINAL");
  const res = await reencodeBufferHd(buf, {
    encoder: async (p) => {
      const out = tmpFile("out.mp4", hdBytes);
      return { path: out, bytes: hdBytes.length, cleanup: async () => fs.rmSync(path.dirname(out), { recursive: true, force: true }) };
    },
  });
  assert.equal(res.hd, true);
  assert.deepEqual(res.buf, hdBytes);
});

test("reencodeBufferHd returns the original buffer when encoding fails", async () => {
  const buf = Buffer.from("original-video");
  const res = await reencodeBufferHd(buf, { encoder: async () => { throw new Error("boom"); } });
  assert.equal(res.hd, false);
  assert.equal(res.buf, buf);
});

test("reencodeBufferHd leaves empty or non-buffer input alone", async () => {
  const empty = Buffer.alloc(0);
  assert.equal((await reencodeBufferHd(empty, { encoder: async () => { throw new Error("x"); } })).buf, empty);
  assert.equal((await reencodeBufferHd("nope", { encoder: async () => { throw new Error("x"); } })).hd, false);
});

test("AIO, YouTube, Facebook, Terabox and ytmate/savetube send video through the HD pipeline", () => {
  const v21 = fs.readFileSync("mias/precious-fixes-v21.cjs", "utf8");
  assert.ok(v21.includes("hdVideoPipeline.reencodeFileHd(fetched.filePath)"), "sendByFetched must re-encode video");
  assert.ok(v21.includes("import('./lib/autoDownloader.js')"), "aio must fall back to the resolver chain");
  assert.ok(v21.includes("ad.resolveMediaUrl(url, platform)"));

  const v24 = fs.readFileSync("mias/precious-fixes-v24.cjs", "utf8");
  assert.ok(v24.includes("const hd = await hdBuf(buf);"), "sendVideoRobust must re-encode video");
  assert.ok(v24.includes("const hdDoc = await hdBuf(r.buf);"), "ytmate document video must re-encode");
  assert.ok(v24.includes("if (mode === 'doc') {\n          const hdDoc = await hdBuf(r.buf);"), "savetube document video must re-encode");

  const ad = fs.readFileSync("mias/lib/autoDownloader.js", "utf8");
  assert.ok(ad.includes("1.3 HD pipeline for every video platform"));
  assert.ok(!ad.includes('if (platform === "tiktok") {\n        try {\n          const req'), "auto-download must no longer be TikTok-only");
});
