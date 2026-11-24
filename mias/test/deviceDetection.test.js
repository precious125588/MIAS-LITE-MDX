import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const indexPath = fileURLToPath(new URL("../index.js", import.meta.url));
const content = fs.readFileSync(indexPath, "utf8");

const sandbox = {
  globalThis: {},
  Baileys: {
    getDevice: (id) => {
      if (/^3A.{18}$/.test(id)) return "ios";
      if (/^3E.{20}$/.test(id)) return "web";
      if (/^(.{21}|.{32})$/.test(id)) return "android";
      if (/^(3F|.{18}$)/.test(id)) return "desktop";
      return "unknown";
    }
  },
  console
};
sandbox.globalThis = sandbox;

const idx1 = content.indexOf("function _safeCleanNum");
const idx2 = content.indexOf("function unwrapMessageContent");
assert.ok(idx1 !== -1 && idx2 !== -1 && idx2 > idx1, "Found device detection block in mias/index.js");

vm.runInNewContext(content.slice(idx1, idx2), sandbox);

const { _detectUserDevice, _recordUserDevice, humanizeDeviceName } = sandbox;

test("detects Android 32-char, 20-char, 22-char, 24-char, and base64 message IDs", () => {
  const ids = [
    "0123456789ABCDEF0123456789ABCDEF", // 32-char hex
    "C4A731F890B123456789",             // 20-char hex
    "C4A731F890B123456789AB",           // 22-char hex
    "C4A731F890B123456789ABCD",         // 24-char hex
    "WAbc1234567890_xyz123"             // 21-char base64
  ];

  for (const id of ids) {
    const res = _detectUserDevice(id, "2349012345678@s.whatsapp.net");
    assert.equal(res.platform, "android", `Failed for id ${id}`);
    assert.equal(res.deviceName, "Android Phone");
  }
});

test("detects iPhone (iOS) with 3A prefix across various lengths", () => {
  const ids = [
    "3A123456789012345678",
    "3A1234567890123456789012",
    "3Aabcdef1234_xyz"
  ];

  for (const id of ids) {
    const res = _detectUserDevice(id, "2349012345678@s.whatsapp.net");
    assert.equal(res.platform, "ios", `Failed for id ${id}`);
    assert.equal(res.emoji, "🍎");
  }
});

test("detects WhatsApp Web and Bots", () => {
  assert.equal(_detectUserDevice("3EB01234567890ABCDEF", "").platform, "web");
  assert.equal(_detectUserDevice("3EB012345678", "").platform, "web");
  assert.equal(_detectUserDevice("BAE51234567890AB", "").platform, "web");
});

test("detects WhatsApp Desktop", () => {
  assert.equal(_detectUserDevice("3F12345678901234", "").platform, "desktop");
  assert.equal(_detectUserDevice("A1B2C3D4E5F67890", "").platform, "desktop");
});

test("detects linked devices from JID", () => {
  const res = _detectUserDevice("", "2349012345678:1@s.whatsapp.net");
  assert.equal(res.platform, "web");
  assert.match(res.deviceName, /Linked #1/);
});

test("falls back to user cache if tagged without a reply", () => {
  _recordUserDevice("2348011112222@s.whatsapp.net", "3A123456789012345678");
  const res = _detectUserDevice("", "2348011112222@s.whatsapp.net");
  assert.equal(res.platform, "ios");
});

test("humanizeDeviceName formats emoji and label properly", () => {
  assert.equal(humanizeDeviceName("3A123456789012345678", ""), "🍎 iPhone (iOS)");
  assert.equal(humanizeDeviceName("C4A731F890B123456789AB", ""), "📱 Android Phone");
});
