import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { parseBareCommand } = require("../lib/commandPrefix.cjs");
const known = name => ["menu", ".menu", "ytmp4", "groq", "dall", "or"].includes(name);

test("no-prefix mode accepts a known bare command", () => {
  assert.deepEqual(parseBareCommand("ytmp4 https://example.test/video", known), {
    isCommand: true, prefix: "", raw: "ytmp4 https://example.test/video", name: "ytmp4"
  });
  assert.deepEqual(parseBareCommand("dall cat in space", known), {
    isCommand: true, prefix: "", raw: "dall cat in space", name: "dall"
  });
});

test("no-prefix mode silently ignores prefixed commands even if alias starts with dot", () => {
  for (const text of [".menu", "!groq hello", "/ytmp4 https://example.test/video", "#dall cat", ".ping", "?help"]) {
    assert.equal(parseBareCommand(text, known).isCommand, false, text);
  }
});
