/**
 * blocklist.js — official-Baileys block/unblock helpers.
 *
 * Why this exists:
 *   • `.block` returned "Bad Request" because the caller passed raw targets to
 *     WhatsApp: @lid jids, device-suffixed jids (`:12@`), group jids, or
 *     status@broadcast. The blocklist IQ only accepts a bare user jid
 *     (`<digits>@s.whatsapp.net`); anything else is rejected with bad-request.
 *   • `.unblock` "said done but did nothing" because the code returned success
 *     as soon as ANY jid candidate stopped throwing, without ever awaiting a
 *     state check. We now verify against `sock.fetchBlocklist()`.
 *
 * Everything here uses documented Baileys APIs only
 * (`updateBlockStatus`, `fetchBlocklist`, `onWhatsApp`, `blocklist.*` events).
 * Nothing bypasses or evades WhatsApp enforcement.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const NON_USER_SUFFIXES = [
  "@g.us",            // groups
  "@broadcast",       // status@broadcast + broadcast lists
  "@newsletter",      // channels
  "@call",
  "@bot",
];
const NAMES_DB_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "database",
  "names.js",
);

/** Digits only, no leading +, 7..15 digits (E.164 max). */
export function normalizeNumber(input) {
  const raw = String(input == null ? "" : input);
  if (!raw) return "";
  const local = raw.includes("@") ? raw.split("@")[0] : raw;
  const digits = local.split(":")[0].split("_")[0].replace(/[^0-9]/g, "");
  if (digits.length < 7 || digits.length > 15) return "";
  return digits;
}

function normalizedLid(input) {
  const raw = String(input == null ? "" : input).trim().toLowerCase();
  if (!raw.endsWith("@lid")) return "";
  const number = normalizeNumber(raw);
  return number ? `${number}@lid` : "";
}

/**
 * Normalize any target to a blockable user jid, or "" when it is not a valid
 * individual WhatsApp user (group / status / broadcast / newsletter / junk).
 * @lid targets return "" here — resolve them with resolveBlockTarget().
 */
export function normalizeUserJid(input) {
  const raw = String(input == null ? "" : input).trim();
  if (!raw) return "";
  const lower = raw.toLowerCase();
  if (NON_USER_SUFFIXES.some((s) => lower.endsWith(s))) return "";
  if (lower === "status@broadcast") return "";
  if (lower.endsWith("@lid")) return ""; // needs phone-number resolution first
  const num = normalizeNumber(raw);
  if (!num) return "";
  return `${num}@s.whatsapp.net`;
}

export function isBlockableTarget(input) {
  return normalizeUserJid(input) !== "";
}

/**
 * Return only explicit block targets from a command message.
 *
 * Do not use msg.key.participant or msg.key.remoteJid here: those identify
 * the person who sent the command/chat, not the person being blocked. Using
 * either one is what makes `.block` accidentally target the bot account.
 */
export function extractBlockTargetCandidates(msg, args = []) {
  const candidates = [];
  const add = (value) => {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (trimmed && !candidates.includes(trimmed)) candidates.push(trimmed);
  };

  const containers = [];
  const seen = new Set();
  const visit = (node) => {
    if (!node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if (node.contextInfo && typeof node.contextInfo === "object") {
      containers.push(node.contextInfo);
    }
    for (const [key, value] of Object.entries(node)) {
      if (key !== "contextInfo" && value && typeof value === "object") {
        visit(value);
      }
    }
  };
  visit(msg?.message || msg);

  // A mention is the most reliable target, including modern @lid mentions.
  for (const context of containers) {
    for (const jid of context.mentionedJid || []) add(jid);
  }

  // A quoted sender is a target only when there really is a quoted message.
  for (const context of containers) {
    if (context.quotedMessage && context.participant) add(context.participant);
  }
  if (msg?.quoted?.sender) add(String(msg.quoted.sender));

  // Finally accept an explicitly typed number/JID. Never fall back to the
  // command sender or chat JID.
  const tokens = Array.isArray(args) ? args : [args];
  for (const token of tokens) add(String(token));
  if (Array.isArray(args) && args.length) add(args.join(" "));

  return candidates;
}

function contactStores(sock) {
  return [
    sock?.store?.contacts,
    sock?.contactStore?.contacts,
    sock?.contacts,
  ].filter(Boolean);
}

function contactEntries(store) {
  if (store instanceof Map) return [...store.entries()];
  if (typeof store === "object") return Object.entries(store);
  return [];
}

function contactNumbers(key, contact) {
  const values = [
    contact?.jid,
    contact?.id,
    contact?.pn,
    contact?.phone,
    contact?.phoneNumber,
    key,
  ].filter((value) => !String(value || "").toLowerCase().endsWith("@lid"));
  return values
    .map((value) => normalizeNumber(value))
    .filter(Boolean);
}

function cleanContactName(value) {
  const name = String(value || "").replace(/\s+/g, " ").trim();
  if (!name || /^\+?\d[\d\s-]*$/.test(name) || name.includes("@")) return "";
  return name;
}

function nameKey(value) {
  return cleanContactName(String(value || "").trim().replace(/^@+/, ""))
    .toLocaleLowerCase()
    .replace(/\s+/g, " ");
}

function readNamesDb() {
  try {
    const raw = fs.readFileSync(NAMES_DB_PATH, "utf8");
    const match = raw.match(/=\s*(\{[\s\S]*\})\s*;?\s*$/);
    return JSON.parse(match ? match[1] : raw);
  } catch {
    return {};
  }
}

/**
 * Resolve an exact contact name to one WhatsApp user only.
 * Ambiguous names are rejected rather than guessing the wrong person.
 */
export function findContactByName(sock, input) {
  const wanted = nameKey(input);
  if (!wanted || /\d/.test(wanted)) return "";
  const matches = new Set();
  for (const store of contactStores(sock)) {
    for (const [key, contact] of contactEntries(store)) {
      const jid = contactNumbers(key, contact)
        .map((number) => `${number}@s.whatsapp.net`)
        .find(Boolean) || "";
      if (!jid) continue;
      const names = [
        contact?.name,
        contact?.notify,
        contact?.verifiedName,
        contact?.displayName,
      ].map(cleanContactName).filter(Boolean);
      if (names.some((name) => nameKey(name) === wanted)) matches.add(jid);
    }
  }
  const db = readNamesDb();
  for (const [num, value] of Object.entries(db || {})) {
    if (nameKey(value) === wanted) {
      const jid = normalizeUserJid(`${num}@s.whatsapp.net`);
      if (jid) matches.add(jid);
    }
  }
  return matches.size === 1 ? [...matches][0] : "";
}

/**
 * Resolve a raw target (jid, @lid, mention, phone string) to a jid WhatsApp
 * will accept for block/unblock. Verifies existence via onWhatsApp when
 * available so we never send a bad-request for a non-existent number.
 * @returns {Promise<{jid:string, num:string, reason:string}>}
 */
export async function resolveBlockTarget(sock, ...inputs) {
  const tried = [];
  for (const input of inputs.flat()) {
    if (!input) continue;
    const raw = String(input).trim();
    tried.push(raw);
    const lower = raw.toLowerCase();
    if (NON_USER_SUFFIXES.some((s) => lower.endsWith(s))) {
      return { jid: "", num: "", reason: "not-a-user" };
    }
    const direct = normalizeUserJid(raw);
    if (direct) return { jid: direct, num: normalizeNumber(direct), reason: "" };
    // @lid — try the socket's lid mapping, then onWhatsApp
    if (lower.endsWith("@lid")) {
      const mapped = await resolveLidToPhone(sock, raw);
      if (mapped) return { jid: mapped, num: normalizeNumber(mapped), reason: "" };
    }
    const named = findContactByName(sock, raw);
    if (named) return { jid: named, num: normalizeNumber(named), reason: "" };
  }
  return { jid: "", num: "", reason: tried.length ? "unresolvable" : "no-target" };
}

async function resolveLidToPhone(sock, lidJid) {
  const lid = normalizedLid(lidJid);
  if (!lid) return "";
  try {
    const store = sock?.signalRepository?.lidMapping;
    if (store && typeof store.getPNForLID === "function") {
      const pn = await store.getPNForLID(lid);
      const jid = normalizeUserJid(pn);
      if (jid) return jid;
    }
  } catch {}
  // Some Baileys stores expose the mapping as a contact record rather than
  // through signalRepository.lidMapping.
  for (const contacts of contactStores(sock)) {
    for (const [key, contact] of contactEntries(contacts)) {
      if (normalizedLid(key) !== lid && normalizedLid(contact?.jid || contact?.id) !== lid) continue;
      const mapped = [contact?.pn, contact?.phone, contact?.phoneNumber]
        .map(normalizeUserJid)
        .find(Boolean);
      if (mapped) return mapped;
    }
  }
  try {
    // Prefer the LID itself when asking Baileys. Never reinterpret an
    // unresolved LID number as a phone number: that can block the wrong user.
    if (typeof sock?.onWhatsApp === "function") {
      const res = (await sock.onWhatsApp(lid)) || [];
      for (const r of res) {
        const jid = normalizeUserJid(r?.jid || r?.pn);
        if (jid && r?.exists !== false) return jid;
      }
    }
  } catch {}
  return "";
}

// ── blocklist cache ─────────────────────────────────────────────────────────
const CACHE_TTL_MS = 30_000;
const VERIFY_DELAYS_MS = [350, 750, 1500];
const cache = { jids: new Set(), names: new Map(), at: 0, supported: true };
const pending = new Map();
const PENDING_TTL_MS = 60_000;

function blocklistEntries(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return value.trim() ? [value] : [];
  if (!value || typeof value !== "object") return null;
  if (value instanceof Map) {
    return [...value.entries()].map(([key, entry]) => (
      entry && typeof entry === "object"
        ? { ...entry, jid: entry.jid || key }
        : key
    ));
  }
  for (const key of ["blocklist", "entries", "items", "jids"]) {
    if (Array.isArray(value[key])) return value[key];
  }
  if (value.jid || value.id || value.pn || value.phone || value.phoneNumber || value.userJid) {
    return [value];
  }
  if (typeof value[Symbol.iterator] === "function") return [...value];
  return null;
}

function blocklistCandidates(entry) {
  if (typeof entry === "string" || typeof entry === "number") return [String(entry).trim()];
  if (!entry || typeof entry !== "object") return [];
  return [
    entry.pn,
    entry.phoneNumber,
    entry.phone,
    entry.jid,
    entry.id,
    entry.userJid,
    entry.user,
  ].map((value) => String(value || "").trim()).filter(Boolean);
}

function blocklistNumber(entry) {
  for (const candidate of blocklistCandidates(entry)) {
    // An unresolved LID is not a phone number; never display or cache its digits.
    if (candidate.toLowerCase().endsWith("@lid")) continue;
    const jid = normalizeUserJid(candidate);
    if (jid) return normalizeNumber(jid);
  }
  return "";
}

async function resolvedBlocklistNumber(sock, entry) {
  const direct = blocklistNumber(entry);
  if (direct) return direct;
  for (const candidate of blocklistCandidates(entry)) {
    if (!candidate.toLowerCase().endsWith("@lid")) continue;
    const mapped = await resolveLidToPhone(sock, candidate);
    const jid = normalizeUserJid(mapped);
    if (jid) return normalizeNumber(jid);
  }
  return "";
}

function blocklistDisplayName(entry) {
  if (!entry || typeof entry !== "object") return "";
  return [
    entry.notify,
    entry.name,
    entry.pushName,
    entry.displayName,
    entry.verifiedName,
  ].map(cleanContactName).find(Boolean) || "";
}

export function _resetCacheForTests() {
  cache.jids = new Set();
  cache.names = new Map();
  cache.at = 0;
  cache.supported = true;
  pending.clear();
}

/** Fetch the account blocklist (normalized numbers). Returns null if unreadable. */
export async function fetchBlocklist(sock, { force = false } = {}) {
  if (!force && cache.at && Date.now() - cache.at < CACHE_TTL_MS) {
    return new Set(cache.jids);
  }
  if (typeof sock?.fetchBlocklist !== "function") {
    cache.supported = false;
    return null;
  }
  try {
    const entries = blocklistEntries(await sock.fetchBlocklist());
    if (!entries) {
      cache.supported = false;
      return null;
    }
    const set = new Set();
    const names = new Map();
    let unresolved = false;
    for (const entry of entries) {
      const n = await resolvedBlocklistNumber(sock, entry);
      if (!n) {
        unresolved = true;
        continue;
      }
      set.add(n);
      const name = blocklistDisplayName(entry);
      if (name) names.set(n, name);
    }
    // Do not report an unreadable/non-empty server list as "empty" or silently
    // return a partial set when a blocked identity could not be resolved.
    if (entries.length && (unresolved || !set.size)) {
      cache.supported = false;
      return null;
    }
    cache.jids = set;
    cache.names = names;
    cache.at = Date.now();
    cache.supported = true;
    return new Set(set);
  } catch {
    cache.supported = false;
    return null;
  }
}

/**
 * Detailed blocklist read for display. Unlike fetchBlocklist, it keeps every
 * entry whose phone number is known and only counts the ones that still need
 * a contact sync. Returns null only when the server list itself is unreadable.
 */
export async function fetchBlocklistDetailed(sock) {
  if (typeof sock?.fetchBlocklist !== "function") return null;
  try {
    const entries = blocklistEntries(await sock.fetchBlocklist());
    if (!entries) return null;
    const numbers = new Set();
    const names = new Map();
    let unresolved = 0;
    for (const entry of entries) {
      const n = await resolvedBlocklistNumber(sock, entry);
      if (!n) { unresolved++; continue; }
      numbers.add(n);
      const name = blocklistDisplayName(entry);
      if (name) names.set(n, name);
    }
    return { numbers, names, unresolved, total: entries.length };
  } catch {
    return null;
  }
}

/** Return a safe display name reported with the blocklist entry, if available. */
export function getBlocklistDisplayName(number) {
  const name = cache.names.get(normalizeNumber(number));
  return name || "";
}

/** Synchronous best-effort check against the cached blocklist. */
export function isBlockedNumber(num) {
  const n = normalizeNumber(num);
  return !!n && cache.jids.has(n);
}

export function isBlockedJid(jid) {
  return isBlockedNumber(jid);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function applyLocal(num, action) {
  const n = typeof num === "object" ? blocklistNumber(num) : normalizeNumber(num);
  if (!n) return;
  if (action === "block") cache.jids.add(n);
  else cache.jids.delete(n);
}

/** Keep the cache warm from Baileys' own blocklist events. */
export function attachBlocklistEvents(sock) {
  if (!sock?.ev || sock.__miasBlocklistEvents) return;
  sock.__miasBlocklistEvents = true;
  try {
    sock.ev.on("blocklist.set", ({ blocklist } = {}) => {
      const set = new Set();
      const names = new Map();
      for (const entry of blocklistEntries(blocklist) || []) {
        const n = blocklistNumber(entry);
        if (n) set.add(n);
        const name = blocklistDisplayName(entry);
        if (n && name) names.set(n, name);
      }
      cache.jids = set;
      cache.names = names;
      cache.at = Date.now();
    });
    sock.ev.on("blocklist.update", ({ blocklist, type } = {}) => {
      for (const entry of blocklistEntries(blocklist) || []) {
        applyLocal(entry, type === "add" ? "block" : "unblock");
        const n = blocklistNumber(entry);
        const name = blocklistDisplayName(entry);
        if (n && type === "add" && name) cache.names.set(n, name);
        else if (n && type !== "add") cache.names.delete(n);
      }
      cache.at = Date.now();
    });
  } catch {}
  // Warm it once.
  fetchBlocklist(sock, { force: true }).catch(() => {});
}

/**
 * Block or unblock a target, transparently.
 * @returns {Promise<{ok:boolean, jid:string, num:string, verified:(boolean|null), error:string, code:(string|number|null), alreadyInState:boolean}>}
 */
export async function setBlockStatus(sock, target, action) {
  if (action !== "block" && action !== "unblock") {
    return { ok: false, jid: "", num: "", verified: null, error: `invalid action "${action}"`, code: null, alreadyInState: false };
  }
  const { jid, num, reason } = await resolveBlockTarget(sock, target);
  if (!jid) {
    const msg = reason === "not-a-user"
      ? "that target is not an individual WhatsApp user (groups, status and channels cannot be blocked)"
      : "could not resolve that target to a valid WhatsApp number";
    return { ok: false, jid: "", num: "", verified: null, error: msg, code: "invalid-target", alreadyInState: false };
  }
  const pendingEntry = pending.get(num);
  const pendingAction = pendingEntry && Date.now() - pendingEntry.at < PENDING_TTL_MS
    ? pendingEntry.action
    : null;
  if (pendingEntry && !pendingAction) pending.delete(num);
  const before = await fetchBlocklist(sock, { force: true });
  const wasBlocked = before ? before.has(num) : null;
  const serverAlreadyInState = before
    && ((action === "block" && wasBlocked) || (action === "unblock" && !wasBlocked));
  if (serverAlreadyInState && (!pendingAction || pendingAction === action)) {
    pending.delete(num);
    return { ok: true, jid, num, verified: true, error: "", code: null, alreadyInState: true };
  }

  if (typeof sock?.updateBlockStatus !== "function") {
    return { ok: false, jid, num, verified: null, error: "this Baileys build has no updateBlockStatus()", code: "unsupported", alreadyInState: false };
  }

  try {
    await sock.updateBlockStatus(jid, action); // official API, awaited
  } catch (e) {
    const code = e?.output?.statusCode || e?.data || e?.code || null;
    return {
      ok: false, jid, num, verified: null, alreadyInState: false, code,
      error: e?.message ? String(e.message) : String(e),
    };
  }

  applyLocal(num, action);
  pending.set(num, { action, at: Date.now() });
  // WhatsApp can acknowledge the IQ before fetchBlocklist catches up. Retry the
  // official read-back briefly, but keep the accepted operation as successful
  // when every read is stale. This also preserves the local state so a matching
  // unblock in another chat does not incorrectly say "nothing to undo".
  let verified = null;
  let serverState = null;
  for (const waitMs of VERIFY_DELAYS_MS) {
    await delay(waitMs);
    const after = await fetchBlocklist(sock, { force: true });
    if (!after) break;
    const nowBlocked = after.has(num);
    serverState = nowBlocked;
    verified = action === "block" ? nowBlocked : !nowBlocked;
    if (verified) break;
  }
  if (verified === true) pending.delete(num);
  if (verified !== true) {
    applyLocal(num, action);
    return {
      ok: true, jid, num, verified: null, alreadyInState: false, code: "pending-sync",
      error: serverState === null ? "" : "WhatsApp accepted the request; blocklist read-back is still syncing",
    };
  }
  return { ok: true, jid, num, verified, error: "", code: null, alreadyInState: false };
}

export default {
  normalizeNumber,
  normalizeUserJid,
  isBlockableTarget,
  resolveBlockTarget,
  findContactByName,
  fetchBlocklist,
  getBlocklistDisplayName,
  isBlockedNumber,
  isBlockedJid,
  attachBlocklistEvents,
  setBlockStatus,
  _resetCacheForTests,
};
