"use strict";

/**
 * MIAS Engine Registry  v2
 *
 * The registry is intentionally CommonJS so both the root CJS application and
 * the ESM mias/ application can use the same singleton without a module-system
 * migration. Engine modules are loaded once, lazily at registry initialization,
 * and a failed optional engine is isolated from the rest of the bot.
 *
 * v2: Adds cache, queue, logger, utility engines.
 */

const ENGINE_LOADERS = Object.freeze({
  // ── Original engines ──────────────────────────────────────────────────────
  canvas:       () => require("./engines/canvasEngine.cjs"),
  cards:        () => require("./engines/cardEngine.cjs"),
  fileDetection:() => require("./engines/fileDetection.cjs"),
  http:         () => require("./engines/httpClient.cjs"),
  image:        () => require("./engines/imageProcessing.cjs"),
  linkPreview:  () => require("./engines/linkPreview.cjs"),
  media:        () => require("./engines/mediaEngine.cjs"),
  speedTest:    () => require("./engines/speedTest.cjs"),
  sticker:      () => require("./engines/stickerEngine.cjs"),
  svg:          () => require("./engines/svgEngine.cjs"),
  // ── New v2 engines ────────────────────────────────────────────────────────
  cache:        () => require("./engines/cacheEngine.cjs"),
  queue:        () => require("./engines/queueEngine.cjs"),
  logger:       () => require("./engines/loggerEngine.cjs"),
  utility:      () => require("./engines/utilityEngine.cjs"),
});

let singleton = null;

function logEngineError(name, error) {
  console.error(`[MIAS Engine Registry] ${name} disabled:`, error?.message || error);
}

function safeLoad(name, loader) {
  try {
    const value = loader();
    return { name, enabled: true, initialized: true, error: null, value };
  } catch (error) {
    logEngineError(name, error);
    return { name, enabled: false, initialized: true, error: error?.message || String(error), value: null };
  }
}

function createAdapterService(name, adapter = {}) {
  const isOptionalAdapter = name === "gktw";
  const hasAvailabilityProbe = typeof adapter.isAvailable === "function";
  return {
    name,
    enabled: true,
    initialized: true,
    optional: isOptionalAdapter,
    fallback: isOptionalAdapter ? "baileys" : null,
    available: name === "baileys" ? true : null,
    mode: isOptionalAdapter
      ? (hasAvailabilityProbe ? "gktw-or-baileys" : "baileys-fallback")
      : "native",
    ...adapter,
  };
}

function attachAdapter(existing, name, adapter = {}) {
  if (!adapter || typeof adapter !== "object") return;
  Object.assign(existing, adapter);
  if (name === "gktw" && typeof existing.isAvailable !== "function") {
    existing.available = false;
    existing.mode = "baileys-fallback";
  }
}

function initializeEngineRegistry(options = {}) {
  if (singleton) {
    const adapters = options.adapters || {};
    attachAdapter(singleton.public.get("gktw"), "gktw", adapters.gktw);
    attachAdapter(singleton.public.get("baileys"), "baileys", adapters.baileys);
    if (adapters.gktw) {
      singleton.public.refreshPromise = null;
      void singleton.public.refreshAdapters();
    }
    return singleton.public;
  }

  const records = Object.create(null);
  const engines = Object.create(null);

  for (const [name, loader] of Object.entries(ENGINE_LOADERS)) {
    const record = safeLoad(name, loader);
    records[name] = record;
    if (record.enabled) engines[name] = record.value;
  }

  // ── Stable aliases for future commands ──────────────────────────────────
  if (engines.canvas || engines.cards) {
    engines.graphics = Object.freeze({
      canvas: engines.canvas || null,
      cards:  engines.cards  || null,
    });
    records.graphics = {
      name: "graphics", enabled: Boolean(engines.graphics.canvas || engines.graphics.cards),
      initialized: true, error: null, value: engines.graphics,
    };
  }
  if (engines.linkPreview) engines.preview = engines.linkPreview;
  if (engines.fileDetection) engines.file = engines.fileDetection;
  if (engines.speedTest) engines.speed = engines.speedTest;

  // ── GKTW / Baileys adapter services ─────────────────────────────────────
  const adapters = options.adapters || {};
  const gktw    = createAdapterService("gktw",    adapters.gktw);
  const baileys = createAdapterService("baileys", adapters.baileys);
  engines.gktw    = gktw;
  engines.baileys = baileys;
  records.gktw    = { name: "gktw",    enabled: true, initialized: true, error: null, value: gktw };
  records.baileys = { name: "baileys", enabled: true, initialized: true, error: null, value: baileys };

  const publicRegistry = {
    version: 2,
    initializedAt: new Date().toISOString(),
    engines: Object.freeze(engines),
    refreshPromise: null,

    get(name) { return this.engines[name] || null; },
    has(name) { return Boolean(this.engines[name]); },

    status() {
      const result = {};
      for (const [name, record] of Object.entries(records)) {
        result[name] = {
          name: record.name,
          enabled: record.enabled,
          initialized: record.initialized,
          error: record.error,
        };
      }
      result.gktw.available = gktw.available;
      result.gktw.mode      = gktw.mode;
      return result;
    },

    diagnostics() {
      return {
        version: this.version,
        initializedAt: this.initializedAt,
        engines: this.status(),
      };
    },

    refreshAdapters() {
      if (this.refreshPromise) return this.refreshPromise;
      if (typeof gktw.isAvailable !== "function") {
        gktw.available = false;
        gktw.mode = "baileys-fallback";
        return Promise.resolve(this.status());
      }
      this.refreshPromise = Promise.resolve()
        .then(() => gktw.isAvailable())
        .then((available) => {
          gktw.available = available === true;
          gktw.mode = gktw.available ? "gktw" : "baileys-fallback";
          return this.status();
        })
        .catch((error) => {
          gktw.available = false;
          gktw.mode = "baileys-fallback";
          console.error("[MIAS Engine Registry] GKTW unavailable; Baileys fallback active:", error?.message || error);
          return this.status();
        });
      return this.refreshPromise;
    },
  };

  singleton = { public: publicRegistry, records };
  void publicRegistry.refreshAdapters();
  return publicRegistry;
}

function getEngineRegistry(options = {}) {
  return initializeEngineRegistry(options);
}

function getEngine(name, options = {}) {
  return getEngineRegistry(options).get(name);
}

module.exports = { getEngine, getEngineRegistry, initializeEngineRegistry };
