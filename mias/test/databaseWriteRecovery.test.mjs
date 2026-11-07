// Regression tests for the "[DB] Failed to save badwords.json: ENOENT" bug.
// Each scenario runs database.js in a fresh child process, because DB_DIR is
// resolved from AUTH_DIR when the module loads.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const DB_MODULE = path.join(here, "..", "database.js");

// Child script: import the module with AUTH_DIR set, run the given action, save.
const CHILD = `
  const { DB_FILES, saveAllData } = await import(${JSON.stringify(DB_MODULE)});
  const stores = {};
  for (const key of Object.keys(DB_FILES)) stores[key] = ["sudo", "sudoVip"].includes(key) ? new Set() : new Map();
  stores.badwords.set("chat-1", { words: ["foo"] });
  const action = process.env.TEST_ACTION;
  const fs = await import("node:fs");
  if (action === "remove-database-dir") fs.rmSync(process.env.TEST_DB_DIR, { recursive: true, force: true });
  if (action === "remove-session-dir") fs.rmSync(process.env.AUTH_DIR, { recursive: true, force: true });
  const ok = await saveAllData(stores);
  await saveAllData(stores);
  console.log("RESULT " + JSON.stringify({ ok }));
`;

function runChild(env) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", CHILD], {
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `child exited ${result.status}: ${result.stderr}`);
  return `${result.stdout}\n${result.stderr}`; // console.error goes to stderr
}

function runScenario(action) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "db-recovery-"));
  const authDir = path.join(root, "pairing", "2349068551055@s.whatsapp.net");
  const dbDir = path.join(authDir, "database");
  fs.mkdirSync(authDir, { recursive: true });
  // First run creates the database folder just like a normal bot start.
  runChild({ AUTH_DIR: authDir, TEST_ACTION: "" });
  const out = runChild({ AUTH_DIR: authDir, TEST_DB_DIR: dbDir, TEST_ACTION: action });
  return { root, authDir, dbDir, out };
}

test("database folder removed while session still exists: badwords.json is written again", () => {
  const { dbDir, out } = runScenario("remove-database-dir");
  assert.match(out, /RESULT \{"ok":true\}/);
  assert.doesNotMatch(out, /Failed to save/);
  const file = path.join(dbDir, "badwords.json");
  assert.equal(fs.existsSync(file), true, "badwords.json should be recreated");
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(saved["chat-1"], { words: ["foo"] });
});

test("whole session folder removed: no ghost folder is recreated and no ENOENT error", () => {
  const { authDir, out } = runScenario("remove-session-dir");
  assert.match(out, /RESULT \{"ok":true\}/);
  assert.doesNotMatch(out, /Failed to save/);
  assert.match(out, /Session folder is gone/);
  assert.equal(fs.existsSync(authDir), false, "removed session must not be recreated");
});

test("normal save writes every store file without errors", () => {
  const { dbDir, out } = runScenario("");
  assert.doesNotMatch(out, /Failed to save/);
  for (const name of ["badwords.json", "economy.json", "sudo.json"]) {
    assert.equal(fs.existsSync(path.join(dbDir, name)), true, `${name} should exist`);
  }
});
