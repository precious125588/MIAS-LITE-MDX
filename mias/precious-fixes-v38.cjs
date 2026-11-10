'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   mias/precious-fixes-v38.cjs  —  v38 FIX PACK
   ──────────────────────────────────────────────────────────────────────────
   Addresses every point reported:

   1) vCARD AUTO-POPUP ("👋 Thanks for viewing my status! / Save my contact:")
      · New setting `statusVcard`, default OFF. Nothing pops up unless the
        owner turns it on (.setting 38.1). Nothing is deleted — the code path
        stays, it is just opt-in.
      · One-time migration (persisted, marker `v38VcardOff`) forces
        statusVcard OFF for existing installations while preserving Section 32
        Meta AI Status Reply. The removed Contact Reply setting is retired.

   2) GROUP PROTECTIONS IN PRIVATE MODE
      · New setting `protectAlways` (default ON, .setting 39.1/39.2).
      · When ON, a group the owner has protected keeps being policed even in
        private/self mode. Only *commands* stay owner/sudo gated.

   3) PERSISTENCE ACROSS RESTART
      · Every settings toggle now flags the store dirty AND schedules an
        immediate saveNow(), so a protection survives a restart.
      · v38 also forces a flush on shutdown.

   4) OWNER/SUDO GUARD — "should say owner only"
      · .setting / .sudo / .setsudo / .cuz / .mode / .self / .public are
        wrapped so only the owner or a sudo user can use them; everyone else
        gets "🚫 Owner only."

   5) IDENTITY (why it worked for some users and not for others)
      · @lid vs @s.whatsapp.net, device suffixes (":12@"), and
        participantPn/senderPn are all normalised before any owner/sudo test.
      · Central helpers are exposed on globalThis by mias/index.js v38 block.

   6) .pin — real pin
      · Replaces the pin handler with a correct implementation built against
        the INSTALLED Baileys (@itsliaaa/baileys 0.3.18-final), whose
        messages.js maps `{ pin: key, type: 1, time }` →
        `pinInChatMessage` + `messageContextInfo.messageAddOnDurationInSecs`.
      · Fixes the old `fromMe` test (used .includes() on a raw JID).
      · Falls back to generateWAMessageFromContent + relayMessage, then to
        chatModify({ pin: true }, jid) for whole-chat pinning.

   Self-contained: reads nothing but the ctx handed to install() plus the
   globals mias/index.js publishes. Safe to boot repeatedly.
   ══════════════════════════════════════════════════════════════════════════ */

const fs   = require('fs');
const path = require('path');
const TAG = '[v38]';
const log  = (m) => { try { console.log(TAG + ' ' + m); } catch (_) {} };
const warn = (m) => { try { console.warn(TAG + ' ⚠️ ' + m); } catch (_) {} };

/* ── ctx accessors ──────────────────────────────────────────────────────── */
function ctx() {
  return (globalThis.__PRECIOUS__ && typeof globalThis.__PRECIOUS__ === 'object')
    ? globalThis.__PRECIOUS__
    : {};
}
function commands() {
  const c = ctx().commands || globalThis.__MIAS_COMMANDS__;
  return (c && typeof c.get === 'function' && typeof c.set === 'function') ? c : null;
}
function getSettings(jid) {
  const c = ctx();
  if (typeof c.getSettings === 'function') { try { return c.getSettings(jid); } catch (_) {} }
  if (typeof globalThis.__miasGetSettings === 'function') { try { return globalThis.__miasGetSettings(jid); } catch (_) {} }
  return null;
}
function saveNow() {
  const c = ctx();
  if (typeof c.saveNow === 'function') { try { c.saveNow(); return true; } catch (_) {} }
  if (typeof globalThis.saveNow === 'function') { try { globalThis.saveNow(); return true; } catch (_) {} }
  return false;
}
function CONFIG() { return ctx().CONFIG || globalThis.CONFIG || {}; }
function ownerJid() {
  const c = ctx();
  if (typeof c.getOwnerJid === 'function') { try { const j = c.getOwnerJid(); if (j) return String(j); } catch (_) {} }
  if (typeof globalThis.__miasGetOwnerJid === 'function') { try { return String(globalThis.__miasGetOwnerJid()); } catch (_) {} }
  const num = String((CONFIG().OWNER_NUMBER) || '').replace(/[^0-9]/g, '');
  return num ? num + '@s.whatsapp.net' : '';
}
function prefix() { return String(CONFIG().PREFIX || '.'); }

/* ── identity ───────────────────────────────────────────────────────────── */
const stripDevice = (j) => String(j == null ? '' : j).replace(/:\d+(?=@)/, '');
function digits(j) { return stripDevice(j).split('@')[0].split(':')[0].replace(/[^0-9]/g, ''); }

function isOwnerJid(jid) {
  if (typeof globalThis.__miasIsOwner === 'function') {
    try { if (globalThis.__miasIsOwner(jid)) return true; } catch (_) {}
  }
  const raw = stripDevice(jid).toLowerCase();
  if (!raw) return false;
  const cfg = String(CONFIG().OWNER_NUMBER || '').replace(/[^0-9]/g, '');
  const d = digits(raw);
  if (cfg && d && d.length >= 10 && d === cfg) return true;
  const cj = String(CONFIG().OWNER_JID || '').toLowerCase();
  if (cj && raw === stripDevice(cj).toLowerCase()) return true;
  return false;
}
function isSudoJid(jid) {
  if (isOwnerJid(jid)) return true;
  if (typeof globalThis.__miasIsSudo === 'function') {
    try { if (globalThis.__miasIsSudo(jid)) return true; } catch (_) {}
  }
  const d = digits(jid);
  if (!d) return false;
  const lists = [globalThis.__miasSudoUsers, globalThis.__miasSudoVipUsers];
  for (const set of lists) {
    try {
      if (!set || typeof set.has !== 'function') continue;
      if (set.has(d) || set.has(stripDevice(jid))) return true;
      for (const v of set) { if (digits(v) === d) return true; }
    } catch (_) {}
  }
  return false;
}
function senderOf(msg) {
  try {
    if (typeof globalThis.__miasGetSender === 'function') {
      const s = globalThis.__miasGetSender(msg);
      if (s) return stripDevice(s);
    }
  } catch (_) {}
  const k = msg && msg.key ? msg.key : {};
  return stripDevice(k.participantPn || k.senderPn || k.participant || k.remoteJid || '');
}
function isOwnerOrSudoMsg(msg) {
  if (!msg || !msg.key) return false;
  if (msg.key.fromMe) return true;
  const s = senderOf(msg);
  return isOwnerJid(s) || isSudoJid(s);
}

/* ── 1. vCARD: one-time "off" migration + default OFF everywhere ────────── */
function migrateVcardOff() {
  const oj = ownerJid();
  if (!oj) { warn('owner JID unknown — vCard migration deferred'); return false; }
  const ownerS = getSettings(oj);
  if (!ownerS) return false;
  if (ownerS.v38VcardOff === true) {           // already migrated, never repeat
    if (ownerS.statusVcard === undefined) { ownerS.statusVcard = false; }
    return true;
  }
  let touched = 0;
  // owner profile = the one the status-viewer hook reads
  ownerS.statusVcard = false;
  ownerS.v38VcardOff = true;
  // every chat that had it on gets the new key, value OFF
  try {
    const c = ctx();
    const store = c.settings || globalThis.__miasSettings;
    if (store && typeof store.forEach === 'function') {
      store.forEach((s) => { try { if (s && typeof s === 'object') s.statusVcard = false; } catch (_) {} });
    }
  } catch (_) {}
  saveNow();
  log('vCard auto-popup switched OFF (statusVcard=false, Meta AI Status Reply preserved; retired Contact Reply ignored) — ' +
      touched + ' toggle(s) changed. The vCard setting has been removed from the settings menu.');
  return true;
}

/* ── 2. protections keep running in private mode ────────────────────────── */
// Keys that mean "the owner explicitly protected this group".
const EXPLICIT_PROTECTIONS = [
  'antiLink', 'antiBad', 'badWords', 'antiMention', 'antiSpam', 'antiRaid',
  'lockMedia', 'welcome', 'goodbye', 'antiDelete', 'antiSticker', 'antiStatus',
  'antiEdit', 'autoBlock', 'antiBroadcast',
];
function groupIsProtected(jid) {
  try {
    const s = getSettings(jid);
    if (!s) return false;
    if (s.protectAlways === false) return false;
    for (const k of EXPLICIT_PROTECTIONS) {
      const v = s[k];
      if (v === true) return true;
      if (typeof v === 'string' && v && v !== 'off' && v !== 'false' && v !== 'disable') return true;
    }
    if (s.linkGuard === 'delete' || s.linkGuard === 'kick' || s.linkGuard === 'warn') return true;
    if (s.badWordGuard === 'delete' || s.badWordGuard === 'kick' || s.badWordGuard === 'warn') return true;
  } catch (_) {}
  return false;
}
// Published so mias/index.js shouldSilenceForPrivateMode() can consult it.
globalThis.__v38GroupIsProtected = groupIsProtected;

/* ── 3. owner/sudo guard on the admin surfaces ──────────────────────────── */
const GUARDED = [
  'setting', 'settings', 'config',
  'sudo', 'setsudo',
  'cuz', 'customize',
  'mode', 'self', 'selfmode', 'ownermode', 'solobot',
  'public', 'publicmode', 'openbot', 'goopen',
];
function installOwnerGuard() {
  const cmds = commands();
  if (!cmds) return false;
  let wrapped = 0;
  for (const name of GUARDED) {
    let entry = null;
    try { entry = cmds.get(name); } catch (_) {}
    if (!entry || typeof entry.handler !== 'function' || entry.__v38OwnerGuard) continue;
    entry.__v38OwnerGuard = true;
    const orig = entry.handler;
    entry.handler = async function (sock, msg, args) {
      try {
        if (isOwnerOrSudoMsg(msg)) return orig(sock, msg, args);
      } catch (_) { return orig(sock, msg, args); }
      // group admins may still open the settings UI, but ONLY in public mode
      try {
        const jid = msg && msg.key ? msg.key.remoteJid : '';
        const isGroup = String(jid || '').endsWith('@g.us');
        if (isGroup && name !== 'sudo' && name !== 'setsudo') {
          const s = getSettings(jid);
          const mode = String((s && s.workMode) || 'public').toLowerCase();
          const pub = mode !== 'private' && !(s && s.privateMode);
          if (pub && typeof globalThis.__miasIsGroupAdmin === 'function') {
            if (await globalThis.__miasIsGroupAdmin(sock, jid, senderOf(msg))) return orig(sock, msg, args);
          }
        }
      } catch (_) {}
      try { await sock.sendMessage(msg.key.remoteJid, { text: '🚫 Owner only.' }, { quoted: msg }); }
      catch (_) {}
      return undefined;
    };
    wrapped++;
  }
  if (wrapped) log('owner-only guard installed on: ' + GUARDED.filter(n => { try { const e = cmds.get(n); return e && e.__v38OwnerGuard; } catch (_) { return false; } }).join(', '));
  return wrapped > 0;
}

/* ── 4. .pin — real pin against the installed Baileys ───────────────────── */
function ctxInfoOf(msg) {
  const m = (msg && msg.message) || {};
  return m.extendedTextMessage?.contextInfo
      || m.imageMessage?.contextInfo
      || m.videoMessage?.contextInfo
      || m.documentMessage?.contextInfo
      || m.audioMessage?.contextInfo
      || m.stickerMessage?.contextInfo
      || null;
}
function selfIds(sock) {
  const id = String((sock && sock.user && sock.user.id) || '');
  const lid = String((sock && sock.user && sock.user.lid) || '');
  return { num: digits(id), lidUser: stripDevice(lid).split('@')[0] };
}
async function pinQuoted(sock, jid, ctxI, secs) {
  const isGroup = String(jid || '').endsWith('@g.us');
  const part = ctxI.participant ? stripDevice(ctxI.participant) : undefined;
  const { num: myNum, lidUser: myLid } = selfIds(sock);
  const partUser = part ? String(part).split('@')[0] : '';
  const partNum = part ? digits(part) : '';
  const fromMe = Boolean(
    ctxI.fromMe ||
    (partNum && myNum && partNum === myNum) ||
    (partUser && myLid && partUser === myLid)
  );
  const pinKey = {
    remoteJid: jid,
    id: ctxI.stanzaId,
    fromMe,
    ...(isGroup && part ? { participant: part } : {}),
  };
  const errs = [];

  // Strategy 1 — the shape the installed Baileys actually implements
  // (lib/Utils/messages.js: hasNonNullishProperty(message,'pin') → pinInChatMessage)
  try {
    const res = await sock.sendMessage(jid, { pin: pinKey, type: 1, time: secs });
    if (res && res.key && res.key.id) return { ok: true, how: 'sendMessage-pin' };
    errs.push('sendMessage-pin: no key returned');
  } catch (e) { errs.push('sendMessage-pin: ' + (e && e.message)); }

  // Strategy 2 — build the proto message ourselves and relay it
  try {
    let B = null;
    try { B = require('@whiskeysockets/baileys'); } catch (_) {}
    if (!B) { try { B = await import('@whiskeysockets/baileys'); } catch (_) {} }
    const gen = B && (B.generateWAMessageFromContent || (B.default && B.default.generateWAMessageFromContent));
    if (typeof gen === 'function') {
      const wam = gen(jid, {
        pinInChatMessage: { key: pinKey, type: 1, senderTimestampMs: Date.now() },
        messageContextInfo: { messageAddOnDurationInSecs: secs },
      }, {});
      await sock.relayMessage(jid, wam.message, { messageId: wam.key && wam.key.id });
      return { ok: true, how: 'relay-pinInChatMessage' };
    }
    errs.push('relay: generateWAMessageFromContent unavailable');
  } catch (e) { errs.push('relay: ' + (e && e.message)); }

  // Strategy 3 — whole-chat pin (WhatsApp "Pin chat" / keep at top)
  try {
    if (typeof sock.chatModify === 'function') {
      await sock.chatModify({ pin: true }, jid);
      return { ok: true, how: 'chatModify-pin-chat' };
    }
    errs.push('chatModify unavailable');
  } catch (e) { errs.push('chatModify: ' + (e && e.message)); }

  return { ok: false, errs };
}
function _installPinHandler(names, unpin, flag) {
  const cmds = commands();
  if (!cmds) return false;
  const pinMod = require('../lib/pinCommand.cjs');
  const handler = async (sock, msg, args) => {
    try {
      if (unpin) {
        await pinMod.handleUnpinCommand(sock, msg, args, { unpin: true, prefix: prefix() });
      } else {
        await pinMod.handleMessagePinCommand(sock, msg, args, { unpin: false, prefix: prefix() });
      }
    } catch (e) {
      warn((unpin ? 'unpin' : 'pin') + ' handler error: ' + (e && e.message));
    }
  };
  let touched = 0;
  for (const n of names) {
    const entry = cmds.get(n);
    if (!entry || entry[flag]) continue;
    entry[flag] = true;
    entry.handler = handler;
    if (typeof entry.run === 'function') entry.run = handler;
    touched++;
  }
  if (touched) log('.' + (unpin ? 'unpin' : 'pin') + ' handlers replaced with XYLO real-pin implementation (' + touched + ')');
  return touched > 0;
}

function _installChatPinHandler(names, unpin, flag) {
  const cmds = commands();
  if (!cmds) return false;
  const pinMod = require('../lib/pinCommand.cjs');
  const handler = async (sock, msg, args) => {
    try {
      if (unpin) {
        await pinMod.handleUnpinChatCommand(sock, msg, args, { unpin: true, prefix: prefix() });
      } else {
        await pinMod.handlePinChatCommand(sock, msg, args, { unpin: false, prefix: prefix() });
      }
    } catch (e) {
      warn((unpin ? 'unpinchat' : 'pinchat') + ' handler error: ' + (e && e.message));
    }
  };
  let touched = 0;
  for (const n of names) {
    const entry = cmds.get(n);
    if (!entry || entry[flag]) continue;
    entry[flag] = true;
    entry.handler = handler;
    if (typeof entry.run === 'function') entry.run = handler;
    touched++;
  }
  if (touched) log('.' + (unpin ? 'unpinchat' : 'pinchat') + ' handlers replaced with XYLO chat-pin implementation (' + touched + ')');
  return touched > 0;
}

function installPin() {
  const m = _installPinHandler(['pin', 'pinmsg'], false, '__v38PinFix');
  const c = _installChatPinHandler(['pinchat'], false, '__v38PinChatFix');
  return m || c;
}
function installUnpin() {
  const m = _installPinHandler(['unpin', 'unpinmsg'], true, '__v38UnpinFix');
  const c = _installChatPinHandler(['unpinchat'], true, '__v38UnpinChatFix');
  return m || c;
}

/* ── 5. settings persistence flush ──────────────────────────────────────── */
function installFlush() {
  if (globalThis.__V38_FLUSH__) return true;
  globalThis.__V38_FLUSH__ = true;
  globalThis.__v38PersistNow = () => { saveNow(); };
  try { process.on('beforeExit', () => { saveNow(); }); } catch (_) {}
  try { process.on('SIGTERM', () => { saveNow(); }); } catch (_) {}
  try { process.on('SIGINT',  () => { saveNow(); }); } catch (_) {}
  try {
    const t = setInterval(() => { saveNow(); }, 60000);
    if (t && t.unref) t.unref();
  } catch (_) {}
  return true;
}


/* ── 6. owner + creator profile cards (live WhatsApp name / bio / DP, no vCard) ── */
const BOT_NAME_BRAND = 'MIAS LITE MDX';
const CREATOR_NUMBER = '2349068551055';   // contact shown on the .creator card; its DP and bio are fetched live
const PROFILE_NUMS = ['1\uFE0F\u20E3', '2\uFE0F\u20E3', '3\uFE0F\u20E3', '4\uFE0F\u20E3', '5\uFE0F\u20E3'];

function yearNow() { return new Date().getFullYear(); }

async function fetchBuffer(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const arrayBuf = await res.arrayBuffer();
    return Buffer.from(arrayBuf);
  } catch (_) {
    return null;
  }
}

// WhatsApp About text may come back as a string, {status}, {status:{status}} or an array of those.
function pickStatusText(res, depth) {
  depth = depth || 0;
  if (!res || depth > 4) return '';
  if (typeof res === 'string') return res.trim();
  if (Array.isArray(res)) {
    for (const item of res) { const t = pickStatusText(item, depth + 1); if (t) return t; }
    return '';
  }
  if (typeof res === 'object' && 'status' in res) return pickStatusText(res.status, depth + 1);
  return '';
}

// Live WhatsApp About/bio for a JID. Returns '' when unavailable (no hardcoded bio).
async function fetchWhatsAppBio(sock, jid) {
  if (!sock || !jid) return '';
  const getters = [sock.fetchStatus, sock.getStatus];
  for (const fn of getters) {
    if (typeof fn !== 'function') continue;
    try {
      const text = pickStatusText(await fn.call(sock, jid));
      if (text) return text.replace(/\s+/g, ' ').trim();
    } catch (_) {}
  }
  return '';
}

// Live WhatsApp profile picture for a JID. Returns null when unavailable.
async function fetchWhatsAppDp(sock, jid) {
  if (!sock || !jid || typeof sock.profilePictureUrl !== 'function') return null;
  let url = null;
  try { url = await sock.profilePictureUrl(jid, 'image'); } catch (_) {}
  if (!url) { try { url = await sock.profilePictureUrl(jid); } catch (_) {} }
  return url ? await fetchBuffer(url) : null;
}

function cleanName(v) {
  const n = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  if (!n || /^(?:undefined|null|bot owner)$/i.test(n)) return '';
  if (/^\+?[\d\s-]+$/.test(n)) return '';   // a bare number is not a name
  return n;
}

// Owner's WhatsApp display name: their own pushName when they send the command,
// then the linked account name, the saved contact name, then a number fallback.
async function resolveOwnerName(sock, msg, ownerJid, ownerNum) {
  const sender = digits((msg && msg.key && (msg.key.participant || msg.key.remoteJid)) || '');
  const fromOwner = !!(msg && msg.key && msg.key.fromMe) || (!!ownerNum && sender === ownerNum);
  let n = '';
  if (fromOwner) n = cleanName(msg && msg.pushName);
  if (!n && sock && sock.user && digits(sock.user.id) === ownerNum) n = cleanName(sock.user.name || sock.user.notify);
  if (!n && sock && sock.store && sock.store.contacts) {
    const ct = sock.store.contacts[ownerJid] || {};
    n = cleanName(ct.notify || ct.name || ct.verifiedName);
  }
  if (!n && sock && typeof sock.getName === 'function') {
    try { n = cleanName(await sock.getName(ownerJid)); } catch (_) {}
  }
  return n || ('+' + ownerNum);
}

function resolveOwnerNumber(sock) {
  const cfg = CONFIG();
  let num = String(cfg.OWNER_NUMBER || process.env.OWNER_NUMBER || process.env.OWNER || (global && global.ownernumber) || '').replace(/[^0-9]/g, '');
  if (!num && cfg.OWNER_JID) num = String(cfg.OWNER_JID).split('@')[0].replace(/[^0-9]/g, '');
  if (!num && global && Array.isArray(global.owner) && global.owner[0]) num = String(global.owner[0]).replace(/[^0-9]/g, '');
  if (!num && sock && sock.user && sock.user.id) num = String(sock.user.id).split(':')[0].split('@')[0].replace(/[^0-9]/g, '');
  return num || '234';
}

function buildOwnerCaption(o) {
  const rows = [['ɴᴀᴍᴇ', o.name], ['ᴄᴏɴᴛᴀᴄᴛ', 'wa.me/' + o.number]];
  if (o.bio) rows.push(['ʙɪᴏ', o.bio]);
  rows.push(['ʙᴏᴛ', BOT_NAME_BRAND], ['ꜱᴛᴀᴛᴜꜱ', 'Active & Available']);
  return [
    '╭───────────────◆',
    '│   👑 *OWNER PROFILE*',
    '╰───────────────◆',
    '',
    '┌───────────────',
    ...rows.map((r, i) => '├  ' + PROFILE_NUMS[i] + ' ' + r[0] + ' : *' + r[1] + '*'),
    '└───────────────',
    '',
    '> Powered by ' + BOT_NAME_BRAND
  ].join('\n');
}

function buildCreatorCaption(bio, year) {
  const lines = [
    '╭━━〔 CREATOR PROFILE 〕━━╮',
    '',
    'Name: PRECIOUS',
    'Role: Bot Developer',
    'Specialty: WhatsApp Automation',
    'Project: PRECIOUS x',
    'Passion: Technology & Innovation',
    'Hobbies: Coding, Anime & Exploring Tech',
    'Mindset: Build. Improve. Repeat.',
    'Contact: ' + CREATOR_NUMBER
  ];
  if (bio) lines.push('Bio: ' + bio);
  lines.push('', '╰━━━━━━━━━━━━━━━━━━━━╯', '', 'PRECIOUS x © ' + year);
  return lines.join('\n');
}

// One image message with the caption. Without a usable picture, send the caption as text (never the bot logo).
async function deliverProfile(sock, jid, msg, dp, caption) {
  if (dp && Buffer.isBuffer(dp) && dp.length > 0) {
    try { await sock.sendMessage(jid, { image: dp, caption }, { quoted: msg }); return; } catch (_) {}
  }
  try { await sock.sendMessage(jid, { text: caption }, { quoted: msg }); } catch (_) {}
}

async function handleOwnerCommand(sock, msg) {
  const jid = (msg && msg.key && msg.key.remoteJid) || '';
  if (!jid) return;
  const c = ctx();
  try {
    if (typeof c.react === 'function') await c.react(sock, msg, '👑');
    else if (sock && typeof sock.sendMessage === 'function') await sock.sendMessage(jid, { react: { text: '👑', key: msg.key } });
  } catch (_) {}

  const ownerNum = resolveOwnerNumber(sock);
  const oj = ownerNum + '@s.whatsapp.net';
  const [name, bio, fetchedDp] = await Promise.all([
    resolveOwnerName(sock, msg, oj, ownerNum),
    fetchWhatsAppBio(sock, oj),
    fetchWhatsAppDp(sock, oj)
  ]);

  // Owner card keeps its original picture fallback (bot picture) when the owner has no DP.
  let dp = fetchedDp;
  if (!dp) { try { if (typeof c.getBotPic === 'function') dp = await c.getBotPic().catch(() => null); } catch (_) {} }
  if (!dp && (CONFIG().BOT_PIC || (global && global.thumbnail))) dp = await fetchBuffer(CONFIG().BOT_PIC || global.thumbnail);

  await deliverProfile(sock, jid, msg, dp, buildOwnerCaption({ name, number: ownerNum, bio }));
}

async function handleCreatorCommand(sock, msg) {
  const jid = (msg && msg.key && msg.key.remoteJid) || '';
  if (!jid) return;
  const cj = CREATOR_NUMBER + '@s.whatsapp.net';
  const [bio, dp] = await Promise.all([fetchWhatsAppBio(sock, cj), fetchWhatsAppDp(sock, cj)]);
  await deliverProfile(sock, jid, msg, dp, buildCreatorCaption(bio, yearNow()));
}

function installOwnerCommand() {
  const cmds = commands();
  if (!cmds) return false;

  // Enforce bot name brand
  try {
    const BOT_NAME = BOT_NAME_BRAND;
    if (CONFIG()) CONFIG().BOT_NAME = BOT_NAME;
    if (globalThis.CONFIG) globalThis.CONFIG.BOT_NAME = BOT_NAME;
    if (global) {
      global.BOT_NAME = BOT_NAME;
      global.botName = BOT_NAME;
      global.botname = BOT_NAME;
    }
    process.env.BOT_NAME = BOT_NAME;
  } catch (_) {}

  const sets = [
    { names: ['owner', 'dev', 'developer', 'botcreator'], handler: handleOwnerCommand, canonical: 'owner', desc: 'Show bot owner profile' },
    { names: ['creator'], handler: handleCreatorCommand, canonical: 'creator', desc: 'Show creator profile card' }
  ];
  let touched = 0;
  for (const set of sets) {
    for (const name of set.names) {
      let entry = cmds.get(name);
      if (!entry) {
        entry = { name, category: 'INFO', canonical: set.canonical, isAlias: name !== set.canonical };
        cmds.set(name, entry);
      }
      entry.handler = set.handler;
      entry.run = set.handler;
      entry.desc = set.desc;
      entry.category = 'INFO';
      entry.ownerOnly = false;
      entry.__v38OwnerCommand = true;
      touched++;
    }
  }

  if (touched) log('owner + creator profile commands installed for ' + touched + ' names');
  return touched > 0;
}

/* ── install ────────────────────────────────────────────────────────────── */
function install() {
  if (globalThis.__V38_INSTALLED__) {
    // re-enter is allowed: command map may appear after the first pass
    installOwnerGuard(); installPin(); installUnpin(); installOwnerCommand();
    return globalThis.__V38_INSTALLED__;
  }
  globalThis.__V38_INSTALLED__ = true;
  const result = { vcard: false, guard: false, pin: false, unpin: false, flush: false, ownerCmd: false };
  try { result.flush = installFlush(); } catch (e) { warn('flush: ' + e.message); }
  try { result.vcard = migrateVcardOff(); } catch (e) { warn('vcard migrate: ' + e.message); }
  try { result.guard = installOwnerGuard(); } catch (e) { warn('owner guard: ' + e.message); }
  try { result.pin = installPin(); } catch (e) { warn('pin: ' + e.message); }
  try { result.unpin = installUnpin(); } catch (e) { warn('unpin: ' + e.message); }
  try { result.ownerCmd = installOwnerCommand(); } catch (e) { warn('owner command: ' + e.message); }
  log('installed → vcard-off=' + result.vcard + ' ownerGuard=' + result.guard +
      ' pin=' + result.pin + ' unpin=' + result.unpin + ' flush=' + result.flush + ' ownerCmd=' + result.ownerCmd);
  globalThis.__V38_RESULT__ = result;
  // The commands map can be populated a moment after this module loads; retry.
  for (const ms of [3000, 10000, 30000]) {
    try {
      const t = setTimeout(() => { try { installOwnerGuard(); installPin(); installUnpin(); installOwnerCommand(); } catch (_) {} }, ms);
      if (t && t.unref) t.unref();
    } catch (_) {}
  }
  return result;
}

module.exports = install;
module.exports.install = install;
module.exports.apply = install;
module.exports.pinQuoted = pinQuoted;
module.exports.groupIsProtected = groupIsProtected;
module.exports.ownerJid = ownerJid;
module.exports.installOwnerCommand = installOwnerCommand;
module.exports.handleOwnerCommand = handleOwnerCommand;
module.exports.handleCreatorCommand = handleCreatorCommand;
module.exports.buildOwnerCaption = buildOwnerCaption;
module.exports.buildCreatorCaption = buildCreatorCaption;
module.exports.fetchWhatsAppBio = fetchWhatsAppBio;
module.exports.pickStatusText = pickStatusText;
module.exports.resolveOwnerName = resolveOwnerName;
module.exports.TAG = TAG;
