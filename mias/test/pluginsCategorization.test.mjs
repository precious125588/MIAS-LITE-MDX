import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createExternalPluginSystem } from "../lib/externalPlugins.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("external plugins suite recategorization, duplicate handling, and removed commands", async () => {
  const commands = new Map();
  const aliases = new Map();
  const menuCategories = [
    { name: "TOOLS", emoji: "🛠️", cmds: [] },
    { name: "AI", emoji: "🤖", cmds: [] },
    { name: "GROUP", emoji: "👥", cmds: [] },
    { name: "GAMES", emoji: "🎮", cmds: [] },
    { name: "DOWNLOAD", emoji: "📥", cmds: [] },
    { name: "WHATSAPP", emoji: "📱", cmds: [] },
    { name: "PLUGINS", emoji: "🔌", cmds: [] },
  ];

  // Old host commands marked disabled
  commands.set("afk", { name: "afk", desc: "Old AFK", category: "TOOLS", disabled: true });
  commands.set("unafk", { name: "unafk", desc: "Old Unafk", category: "TOOLS", disabled: true });
  commands.set("poll", { name: "poll", desc: "Old Poll", category: "GROUP", disabled: true });
  commands.set("antispam", { name: "antispam", desc: "Old Antispam", category: "GROUP", disabled: true });
  commands.set("wcg", { name: "wcg", desc: "Old WCG", category: "GAMES", disabled: true });

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

  const registered = Array.from(commands.keys());

  // 1. nix, gupload, gauth, reminder MUST NOT exist
  for (const removed of ["nix", "gupload", "gauth", "reminder"]) {
    assert.equal(commands.has(removed), false, `Command ${removed} should not be registered`);
  }

  // 2. No numbered duplicates (like afk1, poll1, wcg1, ping1)
  const numbered = registered.filter(n => /^[a-z]+1$/.test(n));
  assert.deepEqual(numbered, [], "No numbered duplicate commands should exist");

  // 3. Category assignments
  const getCat = (cmd) => menuCategories.find(c => c.cmds.includes(cmd))?.name;

  assert.equal(getCat("afk"), "TOOLS");
  assert.equal(getCat("fancy"), "TOOLS");
  assert.equal(getCat("page"), "TOOLS");
  assert.equal(getCat("weather"), "TOOLS");

  assert.equal(getCat("dall"), "AI");
  assert.equal(getCat("groq"), "AI");
  assert.equal(getCat("or"), "AI");

  assert.equal(getCat("upload"), "DOWNLOAD");

  assert.equal(getCat("setstatus"), "WHATSAPP");
  assert.equal(getCat("scstatus"), "WHATSAPP");
  assert.equal(getCat("ison"), "WHATSAPP");

  assert.equal(getCat("tictactoe"), "GAMES");
  assert.equal(getCat("wcg"), "GAMES");
  assert.equal(getCat("wrg"), "GAMES");

  assert.equal(getCat("poll"), "GROUP");
  assert.equal(getCat("antispam"), "GROUP");
  assert.equal(getCat("antigm"), "GROUP");
  assert.equal(getCat("antifake"), "GROUP");

  // 4. PLUGINS category should have 0 commands
  const pluginsCategory = menuCategories.find(c => c.name === "PLUGINS");
  assert.equal(pluginsCategory?.cmds.length || 0, 0, "PLUGINS category must be empty");
});
