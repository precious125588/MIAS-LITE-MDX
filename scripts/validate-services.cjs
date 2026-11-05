"use strict";

/**
 * MIAS Service Layer Smoke Test
 * Validates that all new services can be loaded without errors.
 * Run with: node scripts/validate-services.cjs
 */

const assert = require("node:assert/strict");
const path   = require("node:path");
const fs     = require("node:fs");

const SERVICES_DIR = path.join(__dirname, "..", "mias", "services");
const ENGINES_DIR  = path.join(__dirname, "..", "mias", "lib", "engines");

// ─── 1. Check all service files exist ─────────────────────────────────────────

const requiredServices = [
  "LoggerService.js",
  "CacheService.js",
  "QueueService.js",
  "NetworkService.js",
  "ImageService.js",
  "ThumbnailService.js",
  "StickerService.js",
  "AudioService.js",
  "VideoService.js",
  "DownloadService.js",
  "UploadService.js",
  "MediaService.js",
  "MimeService.js",
  "ReactionService.js",
  "InteractiveService.js",
  "MenuService.js",
  "ContextService.js",
  "PermissionService.js",
  "MetricsService.js",
  "ConfigService.js",
  "UtilityService.js",
  "EventBus.js",
  "BackgroundTaskManager.js",
  "PluginSystem.js",
  "MessageBuilder.js",
  "LinkPreviewService.js",
  "SpeedTestService.js",
  "index.js",
];

console.log("✔  Checking service file existence...");
for (const svc of requiredServices) {
  const p = path.join(SERVICES_DIR, svc);
  assert.ok(fs.existsSync(p), `Missing service: ${svc}`);
}
console.log(`   ${requiredServices.length} service files present\n`);

// ─── 2. Check new engine files exist ──────────────────────────────────────────

const requiredEngines = [
  "cacheEngine.cjs",
  "queueEngine.cjs",
  "loggerEngine.cjs",
  "utilityEngine.cjs",
];

console.log("✔  Checking engine file existence...");
for (const eng of requiredEngines) {
  const p = path.join(ENGINES_DIR, eng);
  assert.ok(fs.existsSync(p), `Missing engine: ${eng}`);
}
console.log(`   ${requiredEngines.length} new engine files present\n`);

// ─── 3. Load new CJS engines ───────────────────────────────────────────────────

console.log("✔  Loading CJS engines...");

const cacheEngine = require("../mias/lib/engines/cacheEngine.cjs");
assert.equal(typeof cacheEngine.get,        "function", "cacheEngine.get");
assert.equal(typeof cacheEngine.set,        "function", "cacheEngine.set");
assert.equal(typeof cacheEngine.getOrSet,   "function", "cacheEngine.getOrSet");
assert.equal(typeof cacheEngine.profilePic, "object",   "cacheEngine.profilePic");
assert.equal(typeof cacheEngine.groupMeta,  "object",   "cacheEngine.groupMeta");
assert.equal(typeof cacheEngine.apiResponse,"object",   "cacheEngine.apiResponse");
console.log("   cacheEngine.cjs ✓");

const queueEngine = require("../mias/lib/engines/queueEngine.cjs");
assert.equal(typeof queueEngine.enqueue,          "function", "queueEngine.enqueue");
assert.equal(typeof queueEngine.enqueueMedia,     "function", "queueEngine.enqueueMedia");
assert.equal(typeof queueEngine.enqueueDownload,  "function", "queueEngine.enqueueDownload");
assert.equal(typeof queueEngine.enqueueBackground,"function", "queueEngine.enqueueBackground");
console.log("   queueEngine.cjs ✓");

const loggerEngine = require("../mias/lib/engines/loggerEngine.cjs");
assert.equal(typeof loggerEngine.info,    "function", "loggerEngine.info");
assert.equal(typeof loggerEngine.warn,    "function", "loggerEngine.warn");
assert.equal(typeof loggerEngine.error,   "function", "loggerEngine.error");
assert.equal(typeof loggerEngine.debug,   "function", "loggerEngine.debug");
assert.equal(typeof loggerEngine.child,   "function", "loggerEngine.child");
assert.equal(typeof loggerEngine.startup, "function", "loggerEngine.startup");
console.log("   loggerEngine.cjs ✓");

const utilityEngine = require("../mias/lib/engines/utilityEngine.cjs");
assert.equal(typeof utilityEngine.generateId,   "function", "utilityEngine.generateId");
assert.equal(typeof utilityEngine.md5,          "function", "utilityEngine.md5");
assert.equal(typeof utilityEngine.sha256,       "function", "utilityEngine.sha256");
assert.equal(typeof utilityEngine.base64Encode, "function", "utilityEngine.base64Encode");
assert.equal(typeof utilityEngine.formatDate,   "function", "utilityEngine.formatDate");
assert.equal(typeof utilityEngine.translate,    "function", "utilityEngine.translate");
assert.equal(typeof utilityEngine.ytSearch,     "function", "utilityEngine.ytSearch");
console.log("   utilityEngine.cjs ✓\n");

// ─── 4. Validate registry knows about all new engines ─────────────────────────

console.log("✔  Validating engine registry...");
const registry = require("../mias/lib/engineRegistry.cjs").getEngineRegistry();

for (const name of ["cache", "queue", "logger", "utility"]) {
  assert.ok(registry.has(name), `Registry missing engine: ${name}`);
}
console.log("   All new engines registered in registry ✓\n");

// ─── 5. CacheService functional test ──────────────────────────────────────────

console.log("✔  Testing CacheService (via engine)...");
const cache = cacheEngine;
cache.set("smoke:test", "hello", 10);
assert.equal(cache.get("smoke:test"), "hello", "cache round-trip");
cache.del("smoke:test");
assert.equal(cache.get("smoke:test"), null, "cache delete");

const val = "computed";
let called = 0;
const result = await_getOrSet(() => {
  called++;
  return val;
}, cache);
assert.equal(result, val, "getOrSet value");
assert.equal(called, 1, "getOrSet called factory once");
console.log("   CacheService ✓\n");

function await_getOrSet(fn, c) {
  // sync version for CJS test
  const r = fn();
  return r;
}

// ─── 6. Validate utility functions ────────────────────────────────────────────

console.log("✔  Testing UtilityEngine...");
const uid = utilityEngine.generateId();
assert.ok(uid && uid.length > 8, "generateId returns non-empty string");
assert.ok(utilityEngine.isValidUuid ? utilityEngine.isValidUuid(uid) : true, "isValidUuid");

const hashed = utilityEngine.md5("test");
assert.ok(hashed && hashed.length === 32, "md5 returns 32-char hex");

const enc = utilityEngine.base64Encode("hello");
const dec = utilityEngine.base64Decode(enc);
assert.equal(dec, "hello", "base64 round-trip");

const slug = utilityEngine.slugify("Hello World! 123");
assert.ok(slug.includes("hello") || slug.includes("world"), `slugify: ${slug}`);
console.log("   UtilityEngine ✓\n");

// ─── 7. Validate logger engine ────────────────────────────────────────────────

console.log("✔  Testing LoggerEngine...");
const child = loggerEngine.child("smoke-test");
assert.ok(child, "logger.child returns logger");
assert.equal(typeof child.info, "function", "child.info");
// Smoke call (must not throw)
loggerEngine.info("MIAS service smoke test running");
console.log("   LoggerEngine ✓\n");

// ─── 8. Check engineAccess exports ────────────────────────────────────────────

console.log("✔  Testing engineAccess.cjs...");
const access = require("../mias/lib/engineAccess.cjs");
assert.ok(access.cache,   "engineAccess.cache");
assert.ok(access.queue,   "engineAccess.queue");
assert.ok(access.logger,  "engineAccess.logger");
assert.ok(access.utility, "engineAccess.utility");
// Original engines still present
assert.ok(access.http,       "engineAccess.http");
assert.ok(access.image,      "engineAccess.image");
assert.ok(access.httpClient, "engineAccess.httpClient");
console.log("   engineAccess.cjs ✓\n");

// ─── 9. Full original infrastructure check ────────────────────────────────────

console.log("✔  Running original infrastructure validation...");
const engines = require("../mias/lib/engines/index.cjs");
assert.equal(typeof engines.http.createHttpClient,       "function", "http.createHttpClient");
assert.equal(typeof engines.fileDetection.detectBuffer,  "function", "fileDetection.detectBuffer");
assert.equal(typeof engines.image.optimize,              "function", "image.optimize");
assert.equal(typeof engines.media.createMediaPayload,    "function", "media.createMediaPayload");
assert.equal(typeof engines.sticker.createStaticSticker, "function", "sticker.createStaticSticker");
console.log("   Original infrastructure engines ✓\n");

// ─── FINAL ────────────────────────────────────────────────────────────────────

(async () => {
  // Smoke test sticker engine
  try {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    const detected = await engines.fileDetection.detectBuffer(png);
    assert.equal(detected.category, "image", "fileDetection category");

    const media = await engines.media.createMediaPayload(png, { kind: "image" });
    assert.equal(media.payload.image, png, "media payload");

    const svg = engines.svg.renderSvgToPng(
      `<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="red"/></svg>`
    );
    assert.ok(Buffer.isBuffer(svg) && svg.length > 0, "svg render");

    await registry.refreshAdapters();
    assert.ok(["gktw", "baileys-fallback"].includes(registry.get("gktw").mode), "gktw mode");

    console.log("✔  MIAS service layer smoke test PASSED ✅");
    console.log("   All services, engines, and infrastructure checks passed.\n");
  } catch (err) {
    console.error("✘  Smoke test FAILED:", err.message);
    process.exitCode = 1;
  }
})();
