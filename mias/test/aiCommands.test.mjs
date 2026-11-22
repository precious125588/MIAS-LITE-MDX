import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { activeMenuCategories } from "../lib/premiumMenus.js";

const source = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");

test("DALL, Groq and OpenRouter are registered with AI handlers and survive the purge", () => {
  for (const command of ["dall", "groq", "or"]) {
    assert.match(source, new RegExp(`cmd\\(\\[[^\\]]*\\b${command}\\b[^\\]]*\\]\\s*,\\s*\\{[\\s\\S]*?category.?\\s*:\\s*["']AI["']`, "i"));
  }
  assert.match(source, /getDallEResponse/);
  assert.match(source, /groqResponse/);
  assert.match(source, /openRouter/);

  // Assert AI purge explicitly preserves dall, groq, and or
  assert.match(source, /!\["dall",\s*"groq",\s*"groqai",\s*"or",\s*"openrouter"\]\.includes/);
});

test("AI commands appear in both category and all-command menus when registered", () => {
  const handler = async () => {};
  const commands = new Map([
    ["dall", { handler, category: "AI", canonical: "dall" }],
    ["groq", { handler, category: "AI", canonical: "groq" }],
    ["or", { handler, category: "AI", canonical: "or" }],
  ]);
  const categories = [{ name: "AI", emoji: "🤖", cmds: ["dall", "groq", "or"] }];
  const active = activeMenuCategories(commands, new Map(), categories, { owner: false });
  assert.deepEqual(active.find(item => item.name === "AI")?.cmds, ["dall", "groq", "or"]);
});

test("ytmp4 uses .video command encode playback and does not drop with host conversion error", () => {
  // Ensure the old host conversion rejection message is gone
  assert.doesNotMatch(source, /Video failed: couldn't convert it to a WhatsApp-playable format on this host/);
  // Ensure prepareTikTokVideo is called for encoding playback like .video
  assert.match(source, /prepareTikTokVideo\(playbackBuffer\)/);
  // Ensure large videos fall back to document delivery so WhatsApp never rejects playback
  assert.match(source, /mimetype:\s*"video\/mp4"/);
});
