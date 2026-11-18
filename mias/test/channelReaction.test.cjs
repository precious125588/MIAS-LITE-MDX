const test = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");

test("channelReaction module loads cleanly via dynamic import", async () => {
  const mod = await import("../features/channelReaction.js");
  assert.ok(mod, "module should import");
  assert.strictEqual(typeof mod.installChannelReaction, "function");
  assert.strictEqual(typeof mod.parseReactionCount, "function");
  assert.strictEqual(typeof mod.createAsithaHeaders, "function");
});

test("parseReactionCount correctly maps mass/max/all and numbers", async () => {
  const { parseReactionCount } = await import("../features/channelReaction.js");
  assert.strictEqual(parseReactionCount("mass"), "all");
  assert.strictEqual(parseReactionCount("MASS"), "all");
  assert.strictEqual(parseReactionCount("max"), "all");
  assert.strictEqual(parseReactionCount("all"), "all");
  assert.strictEqual(parseReactionCount("allbots"), "all");
  assert.strictEqual(parseReactionCount(""), "all");
  assert.strictEqual(parseReactionCount(null), "all");

  assert.strictEqual(parseReactionCount("1"), "1");
  assert.strictEqual(parseReactionCount("10"), "10");
  assert.strictEqual(parseReactionCount("20"), "20");
  assert.strictEqual(parseReactionCount("30"), "30");
  assert.strictEqual(parseReactionCount("40"), "40");
  assert.strictEqual(parseReactionCount("50"), "50");
  assert.strictEqual(parseReactionCount("100"), "all");
});

test("createAsithaHeaders generates valid HMAC-SHA256 signature and timestamp", async () => {
  const { createAsithaHeaders } = await import("../features/channelReaction.js");
  const nonce = "test-nonce-12345";
  const body = { post_link: "https://whatsapp.com/channel/0029Vaa1t6l5q08V1jdCS33q/1", reacts: "🦄,🩷", count: "all" };
  const headers = createAsithaHeaders(body, "POST", "", nonce);

  assert.strictEqual(headers["x-nonce"], nonce);
  assert.ok(headers["x-timestamp"]);
  assert.ok(headers["x-signature"]);
  assert.strictEqual(headers["Content-Type"], "application/json");

  // Recompute signature manually to confirm match
  const payload = `${headers["x-timestamp"]}.${nonce}.${JSON.stringify(body)}`;
  const expectedSig = crypto.createHmac("sha256", "AsithaApiSignatureKey2026!@#").update(payload).digest("hex");
  assert.strictEqual(headers["x-signature"], expectedSig);
});

test("decodeHtmlEntities correctly decodes emoji and entity titles", async () => {
  const { decodeHtmlEntities } = await import("../features/channelReaction.js");
  const raw = "&#x1f54a;&#xfe0f; A S I T H A &amp; Friends &quot;MD&quot;";
  const decoded = decodeHtmlEntities(raw);
  assert.strictEqual(decoded, "🕊️ A S I T H A & Friends \"MD\"");
});

test("installChannelReaction registers .react, .reaction, .coin with creator permissions", async () => {
  const { installChannelReaction } = await import("../features/channelReaction.js");
  const registry = new Map();
  const mockCmd = (names, opts, handler) => {
    for (const name of names) {
      registry.set(name, { opts, handler });
    }
  };

  const installed = installChannelReaction({
    cmd: mockCmd,
    sendReply: async () => {},
    react: async () => {},
    CONFIG: { PREFIX: "." },
    isCreator: (sender) => sender.includes("2347032259096"),
    isOwner: (sender) => sender.includes("2347032259096"),
    getSender: (msg) => msg?.key?.remoteJid || ""
  });

  assert.strictEqual(installed, true);
  assert.ok(registry.has("react"), "should register .react");
  assert.ok(registry.has("reaction"), "should register .reaction");
  assert.ok(registry.has("coin"), "should register .coin");
  assert.ok(registry.has("coins"), "should register .coins");

  const reactCmd = registry.get("react");
  assert.strictEqual(reactCmd.opts.ownerOnly, true);
  assert.strictEqual(reactCmd.opts.creatorOnly, true);
});

test("stranger request to .react is rejected with creator-only notice and ❌", async () => {
  const { installChannelReaction } = await import("../features/channelReaction.js");
  const registry = new Map();
  const mockCmd = (names, opts, handler) => {
    for (const name of names) registry.set(name, { opts, handler });
  };

  const reactions = [];
  const replies = [];

  installChannelReaction({
    cmd: mockCmd,
    sendReply: async (sock, msg, text) => { replies.push(text); },
    react: async (sock, msg, emoji) => { reactions.push(emoji); },
    CONFIG: { PREFIX: "." },
    isCreator: () => false,
    isOwner: () => false,
    getSender: () => "999888777@s.whatsapp.net"
  });

  const reactHandler = registry.get("react").handler;
  const mockMsg = { key: { remoteJid: "999888777@s.whatsapp.net", fromMe: false } };

  await reactHandler({}, mockMsg, ["https://whatsapp.com/channel/0029Vaa1t6l5q08V1jdCS33q/1", "mass"]);

  assert.ok(reactions.includes("❌"));
  assert.ok(replies.some(r => r.includes("restricted to the bot creator only")));
});

test("creator request to .react initiates with 🌀 and sends channel notification", async () => {
  const { installChannelReaction } = await import("../features/channelReaction.js");
  const registry = new Map();
  const mockCmd = (names, opts, handler) => {
    for (const name of names) registry.set(name, { opts, handler });
  };

  const reactions = [];
  const replies = [];

  installChannelReaction({
    cmd: mockCmd,
    sendReply: async (sock, msg, text) => { replies.push(text); },
    react: async (sock, msg, emoji) => { reactions.push(emoji); },
    CONFIG: { PREFIX: "." },
    isCreator: () => true,
    isOwner: () => true,
    getSender: () => "2347032259096@s.whatsapp.net"
  });

  const reactHandler = registry.get("react").handler;
  const mockMsg = { key: { remoteJid: "2347032259096@s.whatsapp.net", fromMe: true } };

  await reactHandler({}, mockMsg, ["https://whatsapp.com/channel/0029Vaa1t6l5q08V1jdCS33q/123", "mass"]);

  // First reaction must be 🌀
  assert.strictEqual(reactions[0], "🌀");
  // First status reply must announce sending reactions to channel
  assert.ok(replies[0].includes("Sending reactions to"));
});
