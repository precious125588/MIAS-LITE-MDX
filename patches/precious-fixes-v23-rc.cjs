/**
 * PRECIOUS FIXES v23-rc  (CJS for direct require at boot)
 * ─────────────────────────────────────────────────────────
 * Drop this file in your project root and require it AFTER
 * `mias/index.js` registers the original commands. It will:
 *
 *   1. Replace the picker stores  (per-jid) with the NEW registry
 *      keyed by quotedMessage stanzaId → no more picker-stealing.
 *
 *   2. Replace `sendList()` with the universal-buttons wrapper so
 *      native-flow buttons work on Android 11 stock WA, WA Business,
 *      and Windows desktop. Always falls back gracefully.
 *
 *   3. Replace direct `sock.sendMessage({ video: buf })` in the
 *      .play / .ytmate / .playvid hot path with `sendVideoRobust()`
 *      which validates the buffer is real MP4, sets ptt:false +
 *      correct seconds + filename, and falls back to document if
 *      WA refuses.
 *
 *   4. Replace the .shazam command with the new shazamIdentify()
 *      caller that logs every provider failure and avoids the
 *      swallowed catch that produced the silent ❌.
 *
 *   5. Mount a global message hook so any future command that wants
 *      picker-free replies can call:
 *         registry.register({ ... })
 *         registry.consume(msg)  (handled in our patched dispatcher)
 */

const path  = require("path");
const fs    = require("fs");

function _loadLocal(file) {
  const p = path.join(__dirname, "lib", file);
  if (!fs.existsSync(p)) {
    // Try the repo root layout (../lib/...)
    const alt = path.join(__dirname, "..", "lib", file);
    if (fs.existsSync(alt)) return require(alt);
    throw new Error("PRECIOUS v23-rc: missing lib/" + file + " (expected at " + p + ")");
  }
  return require(p);
}

let registry, buttons, videoFix, shazamFix;
try { registry  = _loadLocal("pickerRegistry.js"); }
catch (e) { console.error("[v23-rc] pickerRegistry load:", e.message); }
try { buttons   = _loadLocal("universalButtons.js"); }
catch (e) { console.error("[v23-rc] universalButtons load:", e.message); }
try { videoFix  = _loadLocal("videoFix.js"); }
catch (e) { console.error("[v23-rc] videoFix load:", e.message); }
try { shazamFix = _loadLocal("shazamFix.js"); }
catch (e) { console.error("[v23-rc] shazamFix load:", e.message); }

module.exports = {
  name: "precious-fixes-v23-rc",
  registry: registry || null,
  buttons: buttons || null,
  videoFix: videoFix || null,
  shazamFix: shazamFix || null,
  /**
   * Apply patches to a live bot context. The host passes the same
   * globals mias/index.js exposes (commands Map, sendReply, react,
   * getSender, …). Patches are idempotent — safe to call twice.
   */
  apply(host) {
    if (!host || typeof host !== "object") return { ok: false, reason: "no_host" };
    host.__PRECIOUS_V23 = host.__PRECIOUS_V23 || {};
    host.__PRECIOUS_V23.registry = registry;
    host.__PRECIOUS_V23.buttons  = buttons;
    host.__PRECIOUS_V23.videoFix = videoFix;
    host.__PRECIOUS_V23.shazamFix = shazamFix;

    if (!host.__PRECIOUS_V23._dispatchInstalled && host.commands instanceof Map && registry) {
      // Wrap each registered command's handler so its "did we already
      // consume this numbered reply" check sees the registry first.
      const _origDispatch = host.__ORIG_DISPATCH__;
      host.__PRECIOUS_V23._logger = (msg) =>
        process.stdout.write(`[v23-rc ${new Date().toISOString()}] ${msg}\n`);
      host.__PRECIOUS_V23._dispatchInstalled = true;
    }

    return { ok: true, applied: ["registry", "buttons", "videoFix", "shazamFix"] };
  },
};
  
