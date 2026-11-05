"use strict";
/**
 * CJS compatibility access layer for engine registry.
 * Mirrors engineAccess.js for CJS consumers (bridge.cjs, nexray_bot.cjs).
 *
 * v3: Adds linkPreview, speedTest.
 */
const registryModule = require("./engineRegistry.cjs");
const registry = registryModule.getEngineRegistry();

module.exports = {
  registry,
  // Original
  http:        registry.get("http"),
  httpClient:  registry.get("http")?.client || null,
  image:       registry.get("image"),
  jimp:        registry.get("image")?.library || null,
  file:        registry.get("fileDetection"),
  fileType:    registry.get("fileDetection")?.library || null,
  media:       registry.get("media"),
  graphics:    registry.get("graphics"),
  svg:         registry.get("svg"),
  sticker:     registry.get("sticker"),
  // v2
  cache:       registry.get("cache"),
  queue:       registry.get("queue"),
  logger:      registry.get("logger"),
  utility:     registry.get("utility"),
  // v3
  linkPreview: registry.get("linkPreview"),
  speedTest:   registry.get("speedTest"),
};
