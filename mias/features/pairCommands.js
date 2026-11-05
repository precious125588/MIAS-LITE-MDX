// .listpair and .delpair (creator only), in their own module.
// Each paired number runs in its own child process, so this process cannot stop
// its siblings. .delpair therefore writes a request file that the launcher
// (nexstore/adminRequests.js) picks up, then waits for the launcher's result.
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PAIRING_ROOT = path.join(REPO_ROOT, "nexstore", "pairing");
const REGISTRY_FILE = path.join(REPO_ROOT, "nexstore", "session_registry.json");
const REQUEST_DIR = path.join(REPO_ROOT, "nexstore", "admin-requests");
const RESULT_DIR = path.join(REPO_ROOT, "nexstore", "admin-results");
const RESULT_WAIT_MS = 30000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pairedNumbers() {
  try {
    return fs.readdirSync(PAIRING_ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^\d{7,}$/.test(d.name)
        && fs.existsSync(path.join(PAIRING_ROOT, d.name, "creds.json")))
      .map((d) => d.name)
      .sort();
  } catch { return []; }
}

function registryStatuses() {
  const out = {};
  try {
    const raw = JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8")) || {};
    for (const [jid, row] of Object.entries(raw)) {
      out[String(jid).split("@")[0]] = row?.status || "unknown";
    }
  } catch {}
  return out;
}

export function installPairCommands(ctx) {
  const { cmd, sendReply, CONFIG } = ctx;
  const P = CONFIG?.PREFIX || ".";

  cmd(["listpair"], { desc: "List paired numbers and their status — creator only", category: "CREATOR", ownerOnly: true, creatorOnly: true }, async (sock, msg) => {
    const nums = pairedNumbers();
    if (!nums.length) { await sendReply(sock, msg, "📭 No paired numbers found."); return; }
    const status = registryStatuses();
    const lines = nums.map((n, i) => `${i + 1}. +${n} — ${status[n] || "unknown"}`);
    await sendReply(sock, msg, `📋 *Paired numbers (${nums.length})*\n\n${lines.join("\n")}\n\n_Remove one with ${P}delpair <number>_`);
  });

  cmd(["delpair"], { desc: "Remove a paired number: stops its bot and deletes its session — creator only", category: "CREATOR", ownerOnly: true, creatorOnly: true }, async (sock, msg, args) => {
    const digits = String(args?.[0] || "").replace(/[^0-9]/g, "");
    if (digits.length < 7) {
      await sendReply(sock, msg, `Usage: ${P}delpair <number>\nExample: ${P}delpair 2348012345678`);
      return;
    }
    if (!fs.existsSync(path.join(PAIRING_ROOT, digits, "creds.json"))) {
      await sendReply(sock, msg, `❌ +${digits} is not paired.`);
      return;
    }
    const id = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    fs.mkdirSync(REQUEST_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(REQUEST_DIR, `${id}.json`),
      JSON.stringify({ action: "delpair", number: digits, requestedAt: new Date().toISOString() })
    );
    await sendReply(sock, msg, `⏳ Removing +${digits}…`);

    const resultFile = path.join(RESULT_DIR, `${id}.json`);
    const deadline = Date.now() + RESULT_WAIT_MS;
    while (Date.now() < deadline) {
      if (fs.existsSync(resultFile)) {
        let res = null;
        try { res = JSON.parse(fs.readFileSync(resultFile, "utf8")); } catch {}
        try { fs.unlinkSync(resultFile); } catch {}
        if (res) {
          await sendReply(sock, msg, res.ok ? `✅ ${res.message}` : `❌ ${res.message}`);
          return;
        }
      }
      await sleep(500);
    }
    await sendReply(sock, msg, `⚠️ No confirmation from the server yet. Run ${P}listpair to check.`);
  });
}
