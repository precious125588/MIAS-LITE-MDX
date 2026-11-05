/**
 * MIAS — CJS Handler Bridge
 *
 * This CommonJS file gives CJS modules (case.js, nexray_bot.cjs, etc.)
 * access to the full MIAS handler system without importing ESM directly.
 *
 * Usage in case.js or any CJS file:
 *
 *   const MIAS = require('./bridge.cjs');
 *   await MIAS.sendText(sock, jid, 'Hello!');
 *   await MIAS.sendImage(sock, jid, buffer, { caption: 'Hi' });
 *   await MIAS.reactSuccess(sock, msg);
 *
 * All functions are forwarded to the ESM handler system via globalThis.__MIAS__
 * which mias/index.js populates at startup.
 *
 * Architecture:  Commands → [this bridge] → Handlers → Baileys Adapter → WhatsApp
 */

"use strict";

// Fail-loud guard (no-op if strict-boot was not loaded by index.js).
const _STRICT = globalThis.__MAIS_STRICT_BOOT__ || null;
const _isStrict = !!(_STRICT && _STRICT.STRICT);

// ─── Proxy factory ────────────────────────────────────────────────────────────
// We return a Proxy that resolves each function call through globalThis.__MIAS__
// at call time, so it always reflects the current (possibly not-yet-loaded) handlers.

const MIAS_BRIDGE = new Proxy({}, {
  get(_, prop) {
    // Expose isReady flag directly
    if (prop === "isReady") {
      return !!(globalThis.__MIAS__ && Object.keys(globalThis.__MIAS__).length > 0);
    }

    // Expose the raw handlers object
    if (prop === "handlers") {
      return globalThis.__MIAS__ || {};
    }
    if (prop === "engines") {
      return globalThis.__MIAS_ENGINES__ || {};
    }
    if (prop === "engineStatus") {
      return async function () {
        return typeof globalThis.__MIAS_ENGINE_STATUS__ === "function"
          ? globalThis.__MIAS_ENGINE_STATUS__()
          : {};
      };
    }
    if (prop === "getEngine") {
      return async function (name) {
        return typeof globalThis.__MIAS_GET_ENGINE__ === "function"
          ? globalThis.__MIAS_GET_ENGINE__(name)
          : null;
      };
    }

    // Forward any function call through __MIAS__
    return async function (...args) {
      const handlers = globalThis.__MIAS__;
      if (!handlers) {
        // The handler system never finished loading. Returning null here is what
        // made the bot look paired while every command silently did nothing.
        const msg =
          `[MIAS Bridge] HANDLERS NOT LOADED — command "${String(prop)}" cannot run.\n` +
          `Cause: mias/index.js did not populate globalThis.__MIAS__ (it crashed or was never required).`;
        if (_isStrict) {
          _STRICT.fatal("HANDLER SYSTEM NOT LOADED", [
            ["Called", String(prop)],
            ["Reason", "globalThis.__MIAS__ is empty — mias/index.js never finished loading."],
            ["Meaning", "WhatsApp would connect but no command would ever reply."],
            ["Stack", new Error("trace").stack],
          ]);
        }
        console.warn(msg);
        return null;
      }
      const fn = handlers[prop];
      if (typeof fn !== "function") {
        if (_isStrict) {
          _STRICT.fatal("HANDLER MISSING", [
            ["Called", String(prop)],
            ["Reason", `No handler named "${String(prop)}" exists in the loaded handler set.`],
            ["Available", Object.keys(handlers).slice(0, 40).join(", ")],
            ["Stack", new Error("trace").stack],
          ]);
        }
        return null;
      }
      try {
        return await fn(...args);
      } catch (err) {
        // Runtime send errors stay non-fatal, but they are now reported in full
        // (message + stack) instead of a one-line shrug.
        console.error(
          `[MIAS Bridge] Error in ${String(prop)}:`,
          err?.message || err,
          "\n" + String(err?.stack || "").split("\n").slice(0, 6).join("\n")
        );
        return null;
      }
    };
  },

  has(_, prop) {
    if (prop === "isReady" || prop === "handlers" || prop === "engines") return true;
    const handlers = globalThis.__MIAS__ || {};
    return prop in handlers;
  },
});

module.exports = MIAS_BRIDGE;
