"use strict";
// Helpers for owner/admin commands that ask a yes/no question first.
// Pure logic only (no sockets, no globals) so it can be unit tested.

const DEFAULT_TTL_MS = 60_000;

function parseYesNo(text) {
  const t = String(text ?? "").trim().toLowerCase();
  if (t === "yes" || t === "y") return "yes";
  if (t === "no" || t === "n") return "no";
  return null;
}

// The message id a reply quotes (the confirmation prompt), or null.
function getQuotedStanzaId(msg) {
  const content = msg?.message;
  if (!content || typeof content !== "object") return null;
  for (const type of Object.keys(content)) {
    const id = content[type]?.contextInfo?.stanzaId;
    if (id) return String(id);
  }
  return null;
}

// Pending confirmations keyed by the prompt's message id. An answer only
// counts when it quotes the prompt in the same chat, and each prompt is used once.
function createConfirmStore({ ttlMs = DEFAULT_TTL_MS, now = () => Date.now() } = {}) {
  const pending = new Map();
  const prune = () => {
    const t = now();
    for (const [id, entry] of pending) if (entry.expiresAt <= t) pending.delete(id);
  };
  return {
    open(promptId, chatJid, data) {
      if (!promptId || !chatJid) return false;
      prune();
      pending.set(String(promptId), { ...data, chatJid, expiresAt: now() + ttlMs });
      return true;
    },
    peek(promptId, chatJid) {
      prune();
      const entry = pending.get(String(promptId || ""));
      return entry && entry.chatJid === chatJid ? entry : null;
    },
    take(promptId, chatJid) {
      const entry = this.peek(promptId, chatJid);
      if (entry) pending.delete(String(promptId));
      return entry;
    },
    get size() { prune(); return pending.size; },
  };
}

function normalizeJid(jid) {
  return String(jid || "").replace(/:\d+@/, "@");
}

// Private contacts and chats that can be blocked (groups, status, newsletters excluded).
function isBlockableJid(jid) {
  return typeof jid === "string" && (jid.endsWith("@s.whatsapp.net") || jid.endsWith("@lid"));
}

function listKeys(src) {
  if (!src) return [];
  try {
    if (typeof src.all === "function") return src.all().map(c => c?.id).filter(Boolean);
    if (src instanceof Map) return [...src.keys()];
    if (typeof src === "object") return Object.keys(src);
  } catch {}
  return [];
}

function buildBlockTargets({ knownContacts, chats, contacts, excludeJids = [] } = {}) {
  const exclude = new Set(excludeJids.filter(Boolean).map(normalizeJid));
  const out = new Set();
  const add = (raw) => {
    const jid = normalizeJid(raw);
    if (isBlockableJid(jid) && !exclude.has(jid)) out.add(jid);
  };
  for (const jid of Array.from(knownContacts || [])) add(jid);
  for (const jid of listKeys(chats)) add(jid);
  for (const jid of listKeys(contacts)) add(jid);
  return [...out];
}

// Blocks one jid at a time with a pause between calls, so WhatsApp is not flooded.
async function runBlockAll(targets, {
  block,
  delayMs = 700,
  sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms)),
  onProgress,
} = {}) {
  if (typeof block !== "function") throw new Error("block function unavailable");
  const list = Array.isArray(targets) ? targets : [];
  const result = { total: list.length, ok: 0, failed: 0, failedSample: [] };
  for (let i = 0; i < list.length; i++) {
    try {
      await block(list[i]);
      result.ok++;
    } catch (e) {
      result.failed++;
      if (result.failedSample.length < 5) {
        result.failedSample.push({ number: String(list[i]).split("@")[0], error: String(e?.message || e).slice(0, 120) });
      }
    }
    const done = i + 1;
    if (typeof onProgress === "function") {
      try { await onProgress({ done, total: list.length, ok: result.ok, failed: result.failed }); } catch {}
    }
    if (done < list.length && delayMs > 0) await sleep(delayMs);
  }
  return result;
}

function describePostFailure(stage, err, prefix = ".") {
  const detail = String(err?.message || err || "unknown error").replace(/\s+/g, " ").slice(0, 200);
  if (stage === "download") {
    return `❌ *Post failed:* couldn't read the media from WhatsApp, so nothing was posted.\n_Send the media again and retry ${prefix}post._\n📌 ${detail}`;
  }
  if (stage === "send") {
    return `❌ *Post failed:* WhatsApp rejected the status post, so nothing was posted.\n_Check the connection and retry ${prefix}post._\n📌 ${detail}`;
  }
  return `❌ *Post failed.*\n📌 ${detail}`;
}

module.exports = {
  parseYesNo,
  getQuotedStanzaId,
  createConfirmStore,
  buildBlockTargets,
  runBlockAll,
  describePostFailure,
  isBlockableJid,
  normalizeJid,
};
