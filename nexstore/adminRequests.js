// Runs admin requests written by bot children (for example .delpair).
// Children cannot touch sibling bot processes, so they drop a JSON request in
// nexstore/admin-requests/. This watcher, started by mais_launcher.js, performs
// the action and writes the outcome to nexstore/admin-results/<id>.json.
const fs = require("fs");
const path = require("path");

const DEFAULT_REQUEST_DIR = path.join(__dirname, "admin-requests");
const DEFAULT_RESULT_DIR = path.join(__dirname, "admin-results");
const STALE_RESULT_MS = 10 * 60 * 1000;

function createWatcher({ deletePairing, intervalMs = 2000, requestDir = DEFAULT_REQUEST_DIR, resultDir = DEFAULT_RESULT_DIR } = {}) {
  let busy = false;

  function writeResult(id, result) {
    fs.mkdirSync(resultDir, { recursive: true });
    fs.writeFileSync(path.join(resultDir, `${id}.json`), JSON.stringify(result));
  }

  function cleanStaleResults() {
    try {
      for (const f of fs.readdirSync(resultDir)) {
        const file = path.join(resultDir, f);
        if (Date.now() - fs.statSync(file).mtimeMs > STALE_RESULT_MS) fs.unlinkSync(file);
      }
    } catch {}
  }

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      fs.mkdirSync(requestDir, { recursive: true });
      cleanStaleResults();
      for (const f of fs.readdirSync(requestDir)) {
        if (!f.endsWith(".json")) continue;
        const file = path.join(requestDir, f);
        const id = f.slice(0, -5);
        let req = null;
        try { req = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
        try { fs.unlinkSync(file); } catch {}
        if (!/^[A-Za-z0-9-]+$/.test(id)) continue;

        let result;
        if (!req || req.action !== "delpair") {
          result = { ok: false, message: "Unknown admin request." };
        } else {
          const digits = String(req.number || "").replace(/[^0-9]/g, "");
          if (digits.length < 7) {
            result = { ok: false, message: "Invalid number." };
          } else {
            try { result = await deletePairing(digits); }
            catch (e) { result = { ok: false, message: `Remove failed: ${e.message}` }; }
          }
        }
        writeResult(id, result);
        console.log(`[admin] ${req?.action || "request"} ${result.ok ? "done" : "failed"}: ${result.message}`);
      }
    } catch (e) {
      console.error(`[admin] watcher error: ${e.message}`);
    } finally {
      busy = false;
    }
  }

  const timer = setInterval(tick, intervalMs);
  if (timer.unref) timer.unref();
  return { tick, stop: () => clearInterval(timer) };
}

module.exports = { createWatcher };
