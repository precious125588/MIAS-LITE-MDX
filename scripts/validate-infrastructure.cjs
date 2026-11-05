"use strict";

const assert = require("node:assert/strict");
const engines = require("../mias/lib/engines/index.cjs");
const registryModule = require("../mias/lib/engineRegistry.cjs");
const access = require("../mias/lib/engineAccess.cjs");

assert.equal(typeof engines.http.createHttpClient, "function");
assert.equal(typeof engines.fileDetection.detectBuffer, "function");
assert.equal(typeof engines.image.optimize, "function");
assert.equal(typeof engines.media.createMediaPayload, "function");
assert.equal(typeof engines.linkPreview.previewLink, "function");
assert.equal(typeof engines.sticker.createStaticSticker, "function");
assert.equal(typeof engines.speedTest.runSpeedTest, "function");
assert.equal(typeof engines.canvas.renderCard, "function");
assert.equal(typeof engines.svg.renderSvgToPng, "function");
assert.equal(typeof engines.cards.createWelcomeCard, "function");
assert.ok(["@napi-rs/canvas", "canvas"].includes(engines.canvas.getCanvas().backend));
assert.equal(access.registry, registryModule.getEngineRegistry());
assert.equal(access.httpClient, engines.http.client);
assert.equal(access.jimp, engines.image.library);
assert.equal(access.fileType, engines.fileDetection.library);
const registry = registryModule.getEngineRegistry();
assert.equal(registry, registryModule.getEngineRegistry());
for (const name of [
  "canvas", "cards", "graphics", "file", "http", "image", "media",
  "preview", "speed", "sticker", "svg", "gktw", "baileys",
]) assert.equal(registry.has(name), true, `missing registry engine: ${name}`);

(async () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const detected = await engines.fileDetection.detectBuffer(png);
  assert.equal(detected.category, "image");
  const media = await engines.media.createMediaPayload(png, { kind: "image", caption: "smoke test" });
  assert.equal(media.payload.image, png);
  const svg = engines.svg.renderSvgToPng("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"2\" height=\"2\"><rect width=\"2\" height=\"2\" fill=\"red\"/></svg>");
  assert.ok(Buffer.isBuffer(svg) && svg.length > 0);
  const rendered = await engines.cards.createWelcomeCard({
    title: "MIAS",
    subtitle: `Canvas backend: ${engines.canvas.getCanvas().backend}`,
    width: 480,
    height: 260,
  });
  assert.ok(Buffer.isBuffer(rendered) && rendered.length > 100);
  await registry.refreshAdapters();
  assert.ok(["gktw", "baileys-fallback"].includes(registry.get("gktw").mode));
  console.log("MIAS infrastructure smoke checks passed.");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});