// The bot socket must present the same browser identity as the pairing code
// (macOS / Safari). This guards against a switch to another fingerprint. A change to another browser fingerprint breaks the link
// between the paired session and the running bot.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, "..", "index.js"), "utf8");

function browserSettings() {
  const out = [];
  let i = src.indexOf("'browser':");
  while (i >= 0) {
    const end = src.indexOf("'markOnlineOnConnect':", i);
    out.push(src.slice(i, end > i ? end : i + 400));
    i = src.indexOf("'browser':", i + 10);
  }
  return out;
}

test("no socket browser setting uses the Ubuntu/Chrome fingerprint", () => {
  // Most settings are obfuscated, so this checks the regression that shipped:
  // the Ubuntu/Chrome literal must not come back.
  const settings = browserSettings();
  assert.ok(settings.length > 0, "expected at least one browser setting in mias/index.js");
  for (const s of settings) {
    assert.doesNotMatch(s, /ubuntu/i, `browser setting must not use Ubuntu: ${s.slice(0, 120)}`);
    assert.doesNotMatch(s, /'Chrome'/, `browser setting must not use Chrome: ${s.slice(0, 120)}`);
  }
});
