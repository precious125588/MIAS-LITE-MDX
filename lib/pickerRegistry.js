/**
 * PICKER REGISTRY  (PRECIOUS v1)
 * ─────────────────────────────
 * Old behavior: every picker (.play, .ytmate, .movie, .nkiri, .tt,
 * .savetube, .search, adult picker, …) was keyed ONLY by chat jid in a
 * shared Map. When two pickers were waiting in the same chat (e.g. user
 * fired .play and immediately .movie) they would steal each other's
 * numbered replies ("1" was consumed by whichever one fired first, the
 * other one then said "Unknown settings option 1").
 *
 * New behavior: every picker registers itself under BOTH the chat jid
 * AND the prompt message key (stanzaId + participant). Consumer callers
 * match an incoming reply against the quoted message key first; if the
 * quoted message is one of OUR prompts belonging to picker X, we route
 * to X — even if a different picker is also pending in the chat.
 *
 * If the user does not quote the prompt, we fall back to the most
 * recently registered picker in that chat (the legacy behavior, kept
 * for backwards compat).
 */

const _byJid = new Map();            // jid → Array<PickerEntry>
const _byKey = new Map();            // `${participant}:${stanzaId}` → PickerEntry
const TTL_MS = 10 * 60 * 1000;       // 10-minute picker window

function makeKey(msg) {
  const ctx = msg?.message?.extendedTextMessage?.contextInfo
           || msg?.message?.imageMessage?.contextInfo
           || msg?.message?.videoMessage?.contextInfo;
  const stanzaId = ctx?.stanzaId || msg?.key?.id || "";
  const participant = ctx?.participant || msg?.key?.participant || msg?.key?.remoteJid || "";
  return `${String(participant).replace(/:\d+(?=@)/, "")}::${String(stanzaId)}`;
}

function makeOwnKey(sent) {
  return `${String(sent?.key?.participant || "")?.replace(/:\d+(?=@)/, "")}::${String(sent?.key?.id || "")}`;
}

function _gc(jid) {
  const now = Date.now();
  const arr = _byJid.get(jid) || [];
  const kept = arr.filter(e => now - e.ts <= TTL_MS);
  if (kept.length) _byJid.set(jid, kept);
  else _byJid.delete(jid);
  for (const e of arr) {
    if (now - e.ts > TTL_MS) {
      _byKey.delete(e.key);
    }
  }
}

export function register(opts) {
  const { jid, sent, kind, payload, handler } = opts || {};
  if (!jid) return null;
  _gc(jid);
  const key = makeOwnKey(sent) || `auto:${Date.now()}:${Math.random()}`;
  const entry = { jid, key, kind, payload, handler, sent, ts: Date.now() };
  _byKey.set(key, entry);
  const arr = _byJid.get(jid) || [];
  arr.push(entry);
  _byJid.set(jid, arr);
  return entry;
}

export function consume(jid, msg) {
  // 1) Try by quoted message key
  const ctx = msg?.message?.extendedTextMessage?.contextInfo
           || msg?.message?.imageMessage?.contextInfo
           || msg?.message?.videoMessage?.contextInfo;
  if (ctx?.stanzaId) {
    const participant = (ctx.participant || "").replace(/:\d+(?=@)/, "");
    const key = `${participant}::${ctx.stanzaId}`;
    const e = _byKey.get(key);
    if (e && Date.now() - e.ts <= TTL_MS) {
      _byKey.delete(key);
      const arr = (_byJid.get(jid) || []).filter(x => x !== e);
      if (arr.length) _byJid.set(jid, arr);
      else _byJid.delete(jid);
      return e;
    }
  }
  // 2) Fall back to most recent pending picker in this chat
  _gc(jid);
  const arr = _byJid.get(jid);
  if (!arr || !arr.length) return null;
  const e = arr[arr.length - 1];
  _byKey.delete(e.key);
  arr.pop();
  if (arr.length) _byJid.set(jid, arr);
  else _byJid.delete(jid);
  return e;
}

export function hasAny(jid) {
  _gc(jid);
  return (_byJid.get(jid) || []).length > 0;
}

export function clear(jid) {
  const arr = _byJid.get(jid) || [];
  for (const e of arr) _byKey.delete(e.key);
  _byJid.delete(jid);
}

export function stats() {
  return { byJidCount: _byJid.size, byKeyCount: _byKey.size };
}

export const _makeKey = makeKey;
export const _makeOwnKey = makeOwnKey;
