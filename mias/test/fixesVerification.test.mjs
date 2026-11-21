import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createExternalPluginSystem } from "../lib/externalPlugins.js";
import { createMessage } from "../lib/eplugins/messageApi.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("dall, groq, and or commands execute properly through miasSuite", async () => {
  const commands = new Map();
  const aliases = new Map();
  const host = {
    libDir: path.resolve(__dirname, "..", "lib"),
    commands,
    aliases,
    cmd(names, opts, handler) {
      for (const n of names) {
        commands.set(n, { ...opts, name: n, handler });
      }
    },
    addMenu() {},
    prefixes: () => ["."],
    getBody: (msg) => msg?.text || "",
    isSudo: () => false,
    getSender: () => "123@s.whatsapp.net",
    isDisabled: () => false,
    requireFn: (mod) => {
      if (mod === "fs-extra") return {};
      return {};
    },
    httpGet: async () => ({ data: Buffer.from("image_data"), headers: { "content-type": "image/jpeg" } })
  };

  const sys = createExternalPluginSystem(host);
  await sys.loadBuiltins();

  assert.equal(commands.has("dall"), true, "dall must be registered");
  assert.equal(commands.has("groq"), true, "groq must be registered");
  assert.equal(commands.has("or"), true, "or must be registered");

  const dallEntry = commands.get("dall");
  assert.equal(dallEntry.category, "AI");
  assert.equal(dallEntry.ownerOnly, false);
});

test("scstatus handler processes reply to media without returning usage text", async () => {
  const commands = new Map();
  const aliases = new Map();
  const sentMessages = [];

  const host = {
    libDir: path.resolve(__dirname, "..", "lib"),
    commands,
    aliases,
    cmd(names, opts, handler) {
      for (const n of names) {
        commands.set(n, { ...opts, name: n, handler });
      }
    },
    addMenu() {},
    prefixes: () => ["."],
    getBody: (msg) => msg?.message?.conversation || msg?.message?.extendedTextMessage?.text || "",
    isSudo: () => true,
    getSender: () => "123@s.whatsapp.net",
    isDisabled: () => false,
    requireFn: () => ({}),
  };

  const sys = createExternalPluginSystem(host);
  await sys.loadBuiltins();

  assert.equal(commands.has("scstatus"), true, "scstatus must be registered");
  const scstatus = commands.get("scstatus");

  // Mock socket and message
  const mockSock = {
    user: { id: "123@s.whatsapp.net" },
    sendMessage: async (jid, content) => {
      if (content?.text) sentMessages.push(content.text);
      return { key: { id: "S1" } };
    }
  };

  const rawMsg = {
    key: { remoteJid: "123@s.whatsapp.net", id: "MSG1", fromMe: true },
    message: {
      extendedTextMessage: {
        text: ".scstatus",
        contextInfo: {
          quotedMessage: {
            imageMessage: {
              mimetype: "image/jpeg",
              caption: "status media"
            }
          }
        }
      }
    }
  };

  await scstatus.handler(mockSock, rawMsg, []);

  assert.equal(sentMessages.length > 0, true);
  const reply = sentMessages[0];
  assert.equal(reply.includes("Usage:"), false, `scstatus on media reply should not return usage text. Got: ${reply}`);
  assert.equal(reply.includes("Status"), true, "scstatus should confirm status action");
});

test("messageApi setStatus accepts direct Buffer for video/image", async () => {
  const statusRelays = [];
  const mockSock = {
    user: { id: "123456@s.whatsapp.net" },
    store: { contacts: { "987@s.whatsapp.net": {} } },
    sendMessage: async (dest, content) => {
      statusRelays.push({ dest, content });
      return { key: { id: "STAT1" } };
    }
  };

  const msg = createMessage({
    sock: mockSock,
    msg: { key: { remoteJid: "123@s.whatsapp.net", id: "M1", fromMe: true }, message: { conversation: "hello" } },
    host: { httpGet: async () => ({ data: [] }) }
  });

  const testBuf = Buffer.from("test-image-data");
  await msg.setStatus(testBuf, { type: "image", caption: "my caption" });

  assert.equal(statusRelays.length, 1);
  assert.equal(statusRelays[0].dest, "status@broadcast");
  assert.deepEqual(statusRelays[0].content.image, testBuf);
  assert.equal(statusRelays[0].content.caption, "my caption");
});
