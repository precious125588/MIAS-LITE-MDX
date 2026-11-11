import { test } from "node:test";
import assert from "node:assert/strict";
import { isBotIdle, runCommandDetached, wrapOutbound, getBusyStatus, _resetBusyForTests } from "../lib/botBusy.mjs";

test("bot is idle only after the output and owner quiet windows", async () => {
  _resetBusyForTests();
  const sock = { sendMessage: async () => ({}) };
  wrapOutbound(sock);
  await sock.sendMessage("x@s.whatsapp.net", { text: "hi" });
  assert.equal(isBotIdle(Date.now() + 10_000), false, "output window still open");
  assert.equal(isBotIdle(Date.now() + 130_000), true, "all windows closed");
});

test("a running command blocks idle and does not block the caller", async () => {
  _resetBusyForTests();
  let release;
  const gate = new Promise((r) => (release = r));
  let finished = false;
  const sock = { sendMessage: async () => ({}) };
  const msg = { key: { remoteJid: "x@s.whatsapp.net" } };
  const p = runCommandDetached(sock, msg, "slow", true, async () => { await gate; finished = true; });
  assert.equal(finished, false);
  assert.equal(isBotIdle(Date.now() + 500_000), false, "command still running");
  release();
  await p;
  assert.equal(finished, true);
  assert.equal(isBotIdle(Date.now() + 130_000), true);
});

test("a failing command sends one error reply and clears the busy count", async () => {
  _resetBusyForTests();
  const sent = [];
  const sock = { sendMessage: async (jid, content) => { sent.push(content.text); return {}; } };
  const msg = { key: { remoteJid: "x@s.whatsapp.net" } };
  await runCommandDetached(sock, msg, "boom", false, async () => { throw new Error("bad input"); });
  assert.equal(sent.length, 1);
  assert.match(sent[0], /Error running \*boom\*: bad input/);
  assert.equal(getBusyStatus().active, 0);
});

test("a command that returns immediately still ends the busy count", async () => {
  _resetBusyForTests();
  const sock = { sendMessage: async () => ({}) };
  await runCommandDetached(sock, { key: { remoteJid: "x" } }, "quick", false, async () => {});
  assert.equal(getBusyStatus().active, 0);
});
