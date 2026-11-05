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

const NON_USER_SUFFIXES = [
  "@g.us",            // groups
  "@broadcast",       // status@broadcast + broadcast lists
  "@newsletter",      // channels
  "@call",
  "@bot",
];

/** Digits only, no leading +, 7..15 digits (E.164 max). */
export function normalizeNumber(input) {
  const raw = String(input == null ? "" : input);
  if (!raw) return "";
  const local = raw.includes("@") ? raw.split("@")[0] : raw;
  const digits = local.split(":")[0].split("_")[0].replace(/[^0-9]/g, "");
  if (digits.length < 7 || digits.length > 15) return "";
  return digits;
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
  }
  return { jid: "", num: "", reason: tried.length ? "unresolvable" : "no-target" };
}

async function resolveLidToPhone(sock, lidJid) {
  try {
    const store = sock?.signalRepository?.lidMapping;
    if (store && typeof store.getPNForLID === "function") {
      const pn = await store.getPNForLID(lidJid);
      const jid = normalizeUserJid(pn);
      if (jid) return jid;
    }
  } catch {}
  try {
    const num = normalizeNumber(lidJid);
    if (num && typeof sock?.onWhatsApp === "function") {
      const res = (await sock.onWhatsApp(`+${num}`)) || [];
      for (const r of res) {
        const jid = normalizeUserJid(r?.jid);
        if (jid && r?.exists !== false) return jid;
      }
    }
  } catch {}
  return "";
}

// ── blocklist cache ─────────────────────────────────────────────────────────
const CACHE_TTL_MS = 30_000;
const VERIFY_DELAYS_MS = [350, 750, 1500];
const cache = { jids: new Set(), at: 0, supported: true };
const pending = new Map();
const PENDING_TTL_MS = 60_000;

export function _resetCacheForTests() {
  cache.jids = new Set();
  cache.at = 0;
  cache.supported = true;
  pending.clear();
}

/** Fetch the account blocklist (normalized numbers). Returns null if unsupported. */
export async function fetchBlocklist(sock, { force = false } = {}) {
  if (!force && cache.at && Date.now() - cache.at < CACHE_TTL_MS) {
    return new Set(cache.jids);
  }
  if (typeof sock?.fetchBlocklist !== "function") {
    cache.supported = false;
    return null;
  }
  try {
    const list = (await sock.fetchBlocklist()) || [];
    const set = new Set();
    for (const j of list) {
      const n = normalizeNumber(j);
      if (n) set.add(n);
    }
    cache.jids = set;
    cache.at = Date.now();
    cache.supported = true;
    return new Set(set);
  } catch {
    cache.supported = false;
    return null;
  }
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
  const n = normalizeNumber(num);
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
      for (const j of blocklist || []) {
        const n = normalizeNumber(j);
        if (n) set.add(n);
      }
      cache.jids = set;
      cache.at = Date.now();
    });
    sock.ev.on("blocklist.update", ({ blocklist, type } = {}) => {
      for (const j of blocklist || []) applyLocal(j, type === "add" ? "block" : "unblock");
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
  const myNum = normalizeNumber(sock?.user?.id || "");
  if (myNum && myNum === num) {
    return { ok: false, jid, num, verified: null, error: "cannot block the bot's own account", code: "self-target", alreadyInState: false };
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
  fetchBlocklist,
  isBlockedNumber,
  isBlockedJid,
  attachBlocklistEvents,
  setBlockStatus,
  _resetCacheForTests,
};
