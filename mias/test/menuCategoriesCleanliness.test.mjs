import test from "node:test";
import assert from "node:assert/strict";
import { REMOVED_MENU_CATEGORIES, canonicalMenuEntries, activeMenuCategories, GAMES_MENU_EXCLUSIONS } from "../lib/premiumMenus.js";
import { createExternalPluginSystem } from "../lib/externalPlugins.js";
import { createMessage } from "../lib/eplugins/messageApi.js";
import { readRollbackState, saveRollbackState } from "../features/updateCommand.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("REMOVED_MENU_CATEGORIES excludes MAKER and PHOTO while GAMES shows only new games", () => {
  assert.ok(!REMOVED_MENU_CATEGORIES.has("GAMES"), "GAMES should be active for new game commands");
  assert.ok(REMOVED_MENU_CATEGORIES.has("MAKER"), "MAKER must be in REMOVED_MENU_CATEGORIES");
  assert.ok(REMOVED_MENU_CATEGORIES.has("PHOTO"), "PHOTO must be in REMOVED_MENU_CATEGORIES");
  assert.ok(REMOVED_MENU_CATEGORIES.has("TEXTMAKER"), "TEXTMAKER must be in REMOVED_MENU_CATEGORIES");
  assert.ok(REMOVED_MENU_CATEGORIES.has("LOGO"), "LOGO must be in REMOVED_MENU_CATEGORIES");

  const commands = new Map();
  const aliases = new Map();
  const categories = [
    { name: "GAMES", cmds: ["tictactoe", "wcg", "wrg", "trivia", "hangman", "asahotak"] },
    { name: "MAKER", cmds: ["balogo", "fakechat"] },
    { name: "PHOTO", cmds: ["ephoto-anime", "ephoto-art"] },
    { name: "TOOLS", cmds: ["calc", "afk"] },
    { name: "AI", cmds: ["gpt", "gemini", "dall", "groq", "or"] },
  ];

  commands.set("tictactoe", { name: "tictactoe", handler: () => {}, category: "GAMES" });
  commands.set("wcg", { name: "wcg", handler: () => {}, category: "GAMES" });
  commands.set("wrg", { name: "wrg", handler: () => {}, category: "GAMES" });
  commands.set("trivia", { name: "trivia", handler: () => {}, category: "GAMES" });
  commands.set("hangman", { name: "hangman", handler: () => {}, category: "GAMES" });
  commands.set("asahotak", { name: "asahotak", handler: () => {}, category: "GAMES" });
  commands.set("balogo", { name: "balogo", handler: () => {}, category: "MAKER" });
  commands.set("fakechat", { name: "fakechat", handler: () => {}, category: "MAKER" });
  commands.set("ephoto-anime", { name: "ephoto-anime", handler: () => {}, category: "PHOTO" });
  commands.set("calc", { name: "calc", handler: () => {}, category: "TOOLS" });
  commands.set("afk", { name: "afk", handler: () => {}, category: "TOOLS" });
  commands.set("gpt", { name: "gpt", handler: () => {}, category: "AI" });
  commands.set("gemini", { name: "gemini", handler: () => {}, category: "AI" });
  commands.set("dall", { name: "dall", handler: () => {}, category: "AI" });
  commands.set("groq", { name: "groq", handler: () => {}, category: "AI" });
  commands.set("or", { name: "or", handler: () => {}, category: "AI" });

  const entries = canonicalMenuEntries(commands, aliases, categories, { owner: true });
  const activeCats = activeMenuCategories(commands, aliases, categories, { owner: true });

  const activeNames = activeCats.map(c => c.name);
  assert.ok(activeNames.includes("GAMES"), "GAMES category should appear in active menu");
  assert.ok(activeNames.includes("AI"), "AI category should appear in active menu");
  assert.ok(!activeNames.includes("MAKER"), "MAKER category should not appear in active menu");
  assert.ok(!activeNames.includes("PHOTO"), "PHOTO category should not appear in active menu");
  assert.ok(activeNames.includes("TOOLS"), "TOOLS category should appear");

  const gamesCat = activeCats.find(c => c.name === "GAMES");
  assert.deepEqual(gamesCat.cmds.sort(), ["tictactoe", "wcg", "wrg"].sort(), "GAMES should only have the 3 new games");

  const aiCat = activeCats.find(c => c.name === "AI");
  assert.ok(aiCat.cmds.includes("dall"), "AI should include dall");
  assert.ok(aiCat.cmds.includes("groq"), "AI should include groq");
  assert.ok(aiCat.cmds.includes("or"), "AI should include or");
});

test("builtin plugin replaces active host command without conflict and disables old host entry", async () => {
  const commands = new Map();
  const aliases = new Map();
  const menuCategories = [
    { name: "GROUP", emoji: "👥", cmds: [] },
    { name: "TOOLS", emoji: "🛠️", cmds: [] },
  ];

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

test("messageApi onWhatsapp bridges correctly to sock.onWhatsApp", async () => {
  let queriedJid = null;
  const mockSock = {
    user: { id: "12345:0@s.whatsapp.net" },
    onWhatsApp: async (jid) => {
      queriedJid = jid;
      return [{ exists: true, jid }];
    },
    sendMessage: async () => ({ key: {} }),
  };

  const msg = createMessage({
    sock: mockSock,
    msg: { key: { remoteJid: "123@s.whatsapp.net" }, message: {} },
    session: "0",
    text: ".ison 2348152433778",
    host: {},
  });

  const res = await msg.onWhatsapp("2348152433778@s.whatsapp.net");
  assert.equal(queriedJid, "2348152433778@s.whatsapp.net");
  assert.equal(res[0].exists, true);
});

test("rollback state saves inRollback and guards auto-update", () => {
  saveRollbackState("abc1234", "def5678", "Testing rollback", true);
  const state = readRollbackState();
  assert.equal(state.inRollback, true);
  assert.equal(state.targetSha, "def5678");

  saveRollbackState(null, "latest123", "Manual update", false);
  const updatedState = readRollbackState();
  assert.equal(updatedState.inRollback, false);
});
