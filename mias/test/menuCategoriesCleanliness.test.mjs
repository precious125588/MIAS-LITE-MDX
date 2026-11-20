import test from "node:test";
import assert from "node:assert/strict";
import { REMOVED_MENU_CATEGORIES, canonicalMenuEntries, activeMenuCategories } from "../lib/premiumMenus.js";
import { createExternalPluginSystem } from "../lib/externalPlugins.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("REMOVED_MENU_CATEGORIES excludes legacy GAMES, MAKER, and PHOTO categories", () => {
  assert.ok(REMOVED_MENU_CATEGORIES.has("GAMES"), "GAMES must be in REMOVED_MENU_CATEGORIES");
  assert.ok(REMOVED_MENU_CATEGORIES.has("MAKER"), "MAKER must be in REMOVED_MENU_CATEGORIES");
  assert.ok(REMOVED_MENU_CATEGORIES.has("PHOTO"), "PHOTO must be in REMOVED_MENU_CATEGORIES");
  assert.ok(REMOVED_MENU_CATEGORIES.has("TEXTMAKER"), "TEXTMAKER must be in REMOVED_MENU_CATEGORIES");
  assert.ok(REMOVED_MENU_CATEGORIES.has("LOGO"), "LOGO must be in REMOVED_MENU_CATEGORIES");

  const commands = new Map();
  const aliases = new Map();
  const categories = [
    { name: "GAMES", cmds: ["trivia", "hangman", "asahotak"] },
    { name: "MAKER", cmds: ["balogo", "fakechat"] },
    { name: "PHOTO", cmds: ["ephoto-anime", "ephoto-art"] },
    { name: "TOOLS", cmds: ["calc", "afk"] },
  ];

  commands.set("trivia", { name: "trivia", handler: () => {}, category: "GAMES" });
  commands.set("hangman", { name: "hangman", handler: () => {}, category: "GAMES" });
  commands.set("asahotak", { name: "asahotak", handler: () => {}, category: "GAMES" });
  commands.set("balogo", { name: "balogo", handler: () => {}, category: "MAKER" });
  commands.set("fakechat", { name: "fakechat", handler: () => {}, category: "MAKER" });
  commands.set("ephoto-anime", { name: "ephoto-anime", handler: () => {}, category: "PHOTO" });
  commands.set("ephoto-art", { name: "ephoto-art", handler: () => {}, category: "PHOTO" });
  commands.set("calc", { name: "calc", handler: () => {}, category: "TOOLS" });
  commands.set("afk", { name: "afk", handler: () => {}, category: "TOOLS" });

  const entries = canonicalMenuEntries(commands, aliases, categories, { owner: true });
  const activeCats = activeMenuCategories(commands, aliases, categories, { owner: true });

  const activeNames = activeCats.map(c => c.name);
  assert.ok(!activeNames.includes("GAMES"), "GAMES category should not appear in active menu");
  assert.ok(!activeNames.includes("MAKER"), "MAKER category should not appear in active menu");
  assert.ok(!activeNames.includes("PHOTO"), "PHOTO category should not appear in active menu");
  assert.ok(activeNames.includes("TOOLS"), "TOOLS category should appear");

  const entryNames = entries.map(e => e.name);
  assert.ok(!entryNames.includes("trivia"), "trivia should not appear in menu entries");
  assert.ok(!entryNames.includes("balogo"), "balogo should not appear in menu entries");
  assert.ok(!entryNames.includes("ephoto-anime"), "ephoto-anime should not appear in menu entries");
  assert.ok(entryNames.includes("calc"), "calc should appear in menu entries");
  assert.ok(entryNames.includes("afk"), "afk should appear in menu entries");
});

test("builtin plugin replaces active host command without conflict and disables old host entry", async () => {
  const commands = new Map();
  const aliases = new Map();
  const menuCategories = [
    { name: "GROUP", emoji: "👥", cmds: [] },
    { name: "TOOLS", emoji: "🛠️", cmds: [] },
  ];

  // Old host command that is NOT disabled initially
  commands.set("multipoll", { name: "multipoll", desc: "Old multipoll", category: "GROUP", disabled: false });
  aliases.set("mpoll", "multipoll");

  const host = {
    libDir: path.resolve(__dirname, "..", "lib"),
    commands,
    aliases,
    cmd(names, opts, handler) {
      for (const n of names) {
        commands.set(n, { ...opts, name: n, handler });
      }
    },
    addMenu(cmd, cat) {
      let c = menuCategories.find(m => m.name === cat);
      if (!c) {
        c = { name: cat, emoji: "✨", cmds: [] };
        menuCategories.push(c);
      }
      if (!c.cmds.includes(cmd)) c.cmds.push(cmd);
    },
    prefixes: () => ["."],
    getBody: (msg) => msg?.text || "",
    isSudo: () => false,
    getSender: () => "123@s.whatsapp.net",
    isDisabled: () => false,
  };

  const sys = createExternalPluginSystem(host);
  await sys.loadBuiltins();

  const entry = commands.get("multipoll");
  assert.ok(entry, "multipoll must be registered");
  assert.equal(entry.eplugin, "miasSuite", "multipoll must now belong to miasSuite plugin");
  assert.equal(entry.disabled, undefined, "plugin multipoll should be enabled");
});
