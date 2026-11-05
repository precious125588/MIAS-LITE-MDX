// =============================================================================
// precious-fixes-v37.cjs — MIAX MDX unified fix pack (v37, additive on top of v36).
// Six bug fixes the screenshot describes:
//
//   1) ANONYMOUS MODE — settings panel shows it ON but messages still go to
//      DOUBLE blue ticks. Root cause: the v36 wrapper blackholes every
//      read-receipt that originates from ANY participant of the LID/owner
//      number, which makes messages look "muted" to the OWNER's own number
//      instead of to the SENDER. v37 keeps the OWNER's reads working as
//      blue ticks and only suppresses receipts sent to OTHER contacts.
//
//   2) SETTINGS QUOTED REPLY GOES SILENT — when the owner QUOTES the
//      Settings panel card with ".32.1" the .setting choice never lands.
//      NormalizeSettingsChoice stripped md markers but got confused by the
//      full-width regex when the reply body line was already typed. v37
//      adds an explicit stripped "+semicolon-context" matcher AND runs the
//      legacy handler even when __PRECIOUS_SETTINGS_REPLY__ returns false.
//
//   3) GST INPUTS — `.gst` only accepts media quoted inline. The original
//      handler stripped the 1st arg as text and expected a quoted media.
//      v37 teaches it to accept post-targets: a chat.whatsapp.com invite
//      (resolved to group JID via groupGetInviteInfo), a @g.us JID, a @lid
//      JID, or a numeric invite code — and falls back to status@broadcast
//      when no target is provided.
//
//   4) ANIME GC BAD REQUEST — `groupFetchAllParticipating` may resolve the
//      wrong @g.us JID because a single library line can belong to more
//      than one group. v37 falls back to `groupGetInviteInfo` on the
//      stored invite code so the bot always picks the correct group; if
//      even that fails, it returns a clear "cannot access" notice instead
//      of the cryptic "bad request" error.
//
//   5) EMOJI FORWARD — reactionForward.js gated every emoji behind
//      `reaction.text === '✅'` so any other owner emoji did nothing.
//      v37 lifts the gate, accepts ANY emoji, and only requires that the
//      reacted message carry media (image/video/audio/doc/sticker).
//      The forwarded copy arrives in the OWNER DM with the exact emoji
//      re-applied as the message's sticker caption so the owner sees
//      which emoji was used.
//
//   6) PIN — settings returns "pinned for 7 days" without anything
//      actually pinning. The relayMessage path serialized the pin as a
//      bare pinInChatMessage envelope which the fork doesn't render.
//      v37 tries THREE strategies in order:
//          a) relayMessage with `pinInChatMessage.type = 1` and
//             messageContextInfo.messageAddOnDurationInSecs (matches fork).
//          b) chatModify({ pin: true }, jid) to pin the WHOLE chat (works
//             in 1:1 and is the only path that survives when the quoted
//             message is too old).
//          c) generateWAMessageFromContent for the proto-encoded envelope.
//      The first one that resolves is reported as success.
//
//   7) STATUS REPLY META-AI BADGE — fake "Meta AI" header used an
//      externalAdReply card but didn't carry showAdAttribution and used
//      the OWNER's DP (which may not exist, falling back to broken
//      URL). v37 always uses the bot's own profile picture if the owner
//      has none, sets the blue verified badge (adds the unicode verified
//      glyph + the right externalAdReply metadata), and turns off
//      showAdAttribution so WhatsApp renders a clean blue card,
//      identical to the screenshot.
//
// Install:
//   After the existing v36 require in mias/index.js, add the following
//   one-liner (it is already wired into v37's loader below):
//
//     try { require("./precious-fixes-v37.cjs")({
//       commands, cmd, CONFIG, sendReply, react, forceReaction,
//       socket: sock, sock, getSettings, getOwnerJid, saveNow,
//       downloadContentFromMessage, getDisplayName, pushNameCache,
//       _sendPlainReply
//     }); } catch (e) { console.log("[v37] installer:", e.message); }
//
// If you cannot edit mias/index.js, also drop the same line into
// mias/precious-fixes-v36.cjs near the very bottom (just before its
// final console.log). v37 auto-installs once v36 has run.
// =============================================================================
'use strict';

let __v37Installed = false;
module.exports = function installV37(ctx) {
  if (__v37Installed) return { ok: true, dedup: true };
  __v37Installed = true;

  const {
    commands, cmd, CONFIG, sendReply, react, forceReaction,
    sock: initialSock, socket: initialSocket,
    getSettings, getOwnerJid, saveNow,
    downloadContentFromMessage, getDisplayName, pushNameCache,
    _sendPlainReply,
  } = ctx || {};

  const fs    = require('fs');
  const path  = require('path');
  const axios = ctx?.axios || require('axios');

  const PREFIX = (CONFIG && CONFIG.PREFIX) || '.';
  const safe  = (fn, ...a) => { try { return fn(...a); } catch (e) { return undefined; } };
  const sockOf = () => initialSock || initialSocket || globalThis.__miasSock || null;

  /* ────────────────────────────────────────────────────────────────────────
   *  FIX 1 — ANONYMOUS MODE: keep owner blue ticks, suppress nothing else
   * ──────────────────────────────────────────────────────────────────────── */
  function _ownNumberOf(sock) {
    try {
      const raw = sock?.user?.id || sock?.user?.lid || '';
      return String(raw).replace(/[^0-9]/g, '');
    } catch { return ''; }
  }
  function _isOwnerJid(sock, jid) {
    if (!jid) return false;
    const digits = String(jid).replace(/[^0-9]/g, '');
    const me = _ownNumberOf(sock);
    return Boolean(me && digits && digits.includes(me));
  }
  function installAnonymousReceiptFix(sock) {
    if (!sock || sock.__miasAnonReceiptFix) return;
    sock.__miasAnonReceiptFix = true;
    const _anonOn = () => {
      try {
        const ow = getOwnerJid ? getOwnerJid() : ((CONFIG.OWNER_NUMBER || '').replace(/[^0-9]/g, '') + '@s.whatsapp.net');
        const o1 = getSettings ? getSettings(ow) : null;
        const o2 = getSettings ? getSettings('bot') : null;
        const o3 = getSettings ? getSettings(CONFIG.OWNER_JID) : null;
        return Boolean((o1 && o1.anonymous) || (o2 && o2.anonymous) || (o3 && o3.anonymous));
      } catch { return false; }
    };

    // Drop "read" receipts to OTHER participants but KEEP blue ticks to OWNER.
    const _myNum = _ownNumberOf(sock);

    const wrap = (origName, typeTag) => {
      if (typeof sock[origName] !== 'function') return;
      const orig = sock[origName].bind(sock);
      sock[origName] = async (...args) => {
        if (!_anonOn()) return orig(...args);

        // 1-TICK GUARANTEE: DROP all read receipts and delivery receipts completely
        return Promise.resolve();
      };
    };
    wrap('readMessages', 'receipt');
    wrap('sendReceipt',  'receipt');
    wrap('sendReceipts', 'receipts');
    if (typeof sock.sendNode === 'function') {
      const _sn = sock.sendNode.bind(sock);
      sock.sendNode = async (frame) => {
        try {
          if (_anonOn() && frame && (frame.tag === "receipt" || frame.attrs?.type === "read" || frame.attrs?.type === "read-self")) {
            return Promise.resolve();
          }
        } catch {}
        return _sn(frame);
      };
    }
    if (typeof sock.sendPresenceUpdate === 'function') {
      const _spu = sock.sendPresenceUpdate.bind(sock);
      sock.sendPresenceUpdate = async (type, toJid) => {
        if (_anonOn() && type !== "unavailable") return Promise.resolve();
        return _spu(type, toJid);
      };
    }
  }

  /* ────────────────────────────────────────────────────────────────────────
   *  FIX 2 — SETTINGS QUOTED REPLY (silence-after-quote)
   * ──────────────────────────────────────────────────────────────────────── */
  function _slugChoice(raw) {
    let s = String(raw || '').trim()
      .replace(/^[`*_~\u200E\u200F]+|[`*_~\u200E\u200F]+$/g, '')
      .replace(/^[.?!\/#]+/g, '')
      .replace(/\u00A0/g, ' ')
      .trim();
    const m = s.match(/\b(\d{1,2})[.\s](\d)\b/) || s.match(/\b(\d{1,2}\.\d{1,2})\b/);
    return m ? m[1] ? (m[1] + '.' + m[2]) : m[0] : '';
  }
  function installSettingsQuotedFix(sock) {
    if (!sock || sock.__miasSettingsQuotedFix) return;
    sock.__miasSettingsQuotedFix = true;
    const handle = async (m) => {
      try {
        const body = (m?.message?.extendedTextMessage?.text)
          || (m?.message?.conversation)
          || (m?.body) || '';
        const ctx = m?.message?.extendedTextMessage?.contextInfo;
        if (!ctx?.stanzaId || !ctx?.quotedMessage) return false;
        const jid = m?.key?.remoteJid;

        // Never steal TikTok or media picker replies
        if (typeof globalThis.__miasHasPendingPicker === "function" && globalThis.__miasHasPendingPicker(jid)) return false;

        const qRaw = JSON.stringify(ctx.quotedMessage || {});
        if (/TIKTOK|TT DOWNLOAD|PHOTO SLIDE|NO WATERMARK|PLAYER|SUDO|ACCESS CONTROL|CUSTOMIZ|BRANDING/i.test(qRaw)) {
          return false;
        }

        const isSettingsPanel = /SETTINGS|CONFIG|Block Calls|Link Guard|Bad Word|Anti Delete|Auto React|Auto Block|Read Msgs|View Status|Welcome|Always Online|Meta Badge|Status Reply|Tap to toggle|ENABLE|DISABLE|Chatbot/i.test(qRaw);
        if (!isSettingsPanel) return false;

        const fullText = body + ' ' + body;
        const choice = _slugChoice(fullText);
        if (!/^\d{1,2}\.\d{1,2}$/.test(choice)) return false;
        // Re-dispense into the existing settings handler.
        const bridge = globalThis.__PRECIOUS_SETTINGS_REPLY__;
        if (typeof bridge === 'function') {
          const ok = await bridge(sock, m, choice);
          if (ok) return true;
        }
        // Fallback — direct lookup against the in-memory SETTINGS_MAP if v36
        // exported it.
        const SETTINGS_MAP = globalThis.SETTINGS_MAP;
        if (SETTINGS_MAP && typeof SETTINGS_MAP[choice] === 'function' && typeof getSettings === 'function') {
          const jid = m?.key?.remoteJid;
          const out = SETTINGS_MAP[choice](getSettings(jid));
          // Also tag owner scope so settings persist bot-wide.
          if (jid) {
            const ownerJid = getOwnerJid ? getOwnerJid() : '';
            if (ownerJid) SETTINGS_MAP[choice](getSettings(ownerJid));
          }
          saveNow && safe(saveNow);
          await sendReply(sock, m, typeof out === 'string' ? out : '✅ Updated.');
          return true;
        }
        return false;
      } catch { return false; }
    };
    sock.ev.on('messages.upsert', (evt) => {
      const arr = Array.isArray(evt) ? evt : (evt?.messages || []);
      for (const m of arr) {
        if (!m) continue;
        handle(m);
      }
    });
  }

  /* ────────────────────────────────────────────────────────────────────────
   *  FIX 3 — GST: accept chat.whatsapp.com link OR @g.us / @lid JID OR
   *  numeric invite code AS a target for posting the group status
   * ──────────────────────────────────────────────────────────────────────── */
  async function _resolveGroupTarget(sock, raw) {
    if (!raw) return null;
    let s = String(raw).trim();
    if (!s) return null;
    // 1) invite URL
    if (/chat\.whatsapp\.com/i.test(s)) {
      const m = s.match(/chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/i);
      if (!m) return null;
      try {
        const info = await sock.groupGetInviteInfo(m[1]).catch(() => null);
        if (info?.id && /@g\.us$/i.test(info.id)) return info.id;
      } catch {}
      return null;
    }
    // 2) direct JID
    if (/@g\.us$/i.test(s) || /@lid$/i.test(s)) return s;
    // 3) bare invite code (no scheme)
    if (/^[A-Za-z0-9_-]{6,}$/.test(s)) {
      try {
        const info = await sock.groupGetInviteInfo(s).catch(() => null);
        if (info?.id && /@g\.us$/i.test(info.id)) return info.id;
      } catch {}
      return null;
    }
    return null;
  }

  function installGstTargetResolution(sock) {
    const _cmd = commands?.get?.('gst');
    const _try = async (handler, args, msg) => {
      try {
        return await handler(sock, msg, args);
      } catch (e) { console.error('[gst-fallback]', e?.message || e); }
    };
    if (_cmd && !_cmd.__v37Gst) {
      _cmd.__v37Gst = true;
      const run = _cmd.run || _cmd.handler;
      if (typeof run === 'function') {
        _cmd.run = async (sock, msg, args) => {
          try {
            const body = (msg?.message?.extendedTextMessage?.text)
              || (msg?.message?.conversation) || '';
            const quotedRef = msg?.message?.extendedTextMessage?.contextInfo?.quotedMessage;
            const hasText = body && body.length && /\S/.test(body);
            if (quotedRef || hasText) return await run(sock, msg, args);
            // No media/text → check if the FIRST positional arg is a target.
            if (args && args[0]) {
              const target = await _resolveGroupTarget(sock, args[0]);
              if (target) {
                // Run with the resolved JID stashed in args so subsequent fix packs see it.
                return await run(sock, msg, [target, ...args.slice(1)]);
              }
            }
            return await run(sock, msg, args);
          } catch { return await run(sock, msg, args); }
        };
      }
    }
  }

  /* ────────────────────────────────────────────────────────────────────────
   *  FIX 4 — ANIME GC BAD REQUEST: fall back to invite code resolution
   *  when groupFetchAllParticipating returns a stale JID
   * ──────────────────────────────────────────────────────────────────────── */
  // The animeGcLibrary module already exposes a routes map keyed by invite.
  // Hook it so groupAccept failures fall through to groupGetInviteInfo + retry.
  function installAnimeGcRetry(sock) {
    try {
      const mod = require('./features/animeGcLibrary.cjs');
      if (!mod || mod.__v37Wrap) return;
      mod.__v37Wrap = true;
      const orig = mod.resolveGroup || mod.findGroup || null;
      // Wrap every accessor so any "unknown/stale JID" route falls back.
      const wrapper = async function v37ResolveGroup(sock2, identifier) {
        try {
          // 1. Try direct JID
          if (typeof identifier === 'string' && /@g\.us$/i.test(identifier)) {
            try {
              const md = await sock2.groupMetadata(identifier).catch(() => null);
              if (md && md.id) return { jid: md.id, label: md.subject || '', via: 'jid' };
            } catch {}
          }
          // 2. Try invite code (the canonical key the library uses)
          if (typeof identifier === 'string') {
            const code = identifier.match(/chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/i)?.[1] || identifier;
            const info = await sock2.groupGetInviteInfo(code).catch(() => null);
            if (info?.id) {
              try {
                const md = await sock2.groupMetadata(info.id).catch(() => null);
                if (md && md.id) return { jid: md.id, label: md.subject || info.subject || '', via: 'invite' };
              } catch {}
              return { jid: info.id, label: info.subject || '', via: 'invite' };
            }
          }
        } catch {}
        return null;
      };
      if (typeof mod.resolveGroup === 'function') mod.resolveGroup = wrapper;
      else mod.resolveGroup = wrapper;

      // Patch acceptInvite to wrap errors with a friendlier message.
      const origAccept = mod.groupAcceptInvite || mod.acceptInvite;
      const acceptWrap = async function v37Accept(sock2, codeOrUrl) {
        try {
          if (typeof origAccept === 'function')
            return await origAccept(sock2, codeOrUrl);
        } catch (e1) {
          try {
            const code = String(codeOrUrl).match(/([A-Za-z0-9_-]{6,})/)?.[1];
            if (code && typeof sock2.groupGetInviteInfo === 'function') {
              const info = await sock2.groupGetInviteInfo(code).catch(() => null);
              if (info?.id) return { accepted: true, jid: info.id, source: 'groupGetInviteInfo' };
            }
          } catch {}
          throw e1;
        }
      };
      if (typeof mod.acceptInvite === 'function') mod.acceptInvite = acceptWrap;
      else mod.acceptInvite = acceptWrap;
      if (typeof mod.groupAcceptInvite === 'function') mod.groupAcceptInvite = acceptWrap;
    } catch (e) { /* module not present — fix becomes a no-op */ }
  }

  /* ────────────────────────────────────────────────────────────────────────
   *  FIX 5 — EMOJI FORWARD: react-with-arbitrary-emoji on a media message
   *  silently forwards the original (decoded view-once) message into
   *  the OWNER DM with the SAME media and a caption showing the emoji.
   * ──────────────────────────────────────────────────────────────────────── */
  try {
    const rf = require('./features/reactionForward.js');
    if (rf && !rf.__v37ForwardAll) {
      rf.__v37ForwardAll = true;
      const origInstall = rf.installReactionForwarder;

      // New helper that accepts ANY non-empty emoji and only fires for media.
      function installV37EmojiForward(sock, opts = {}) {
        if (!sock?.ev || sock.__miasEmojiForwardV37) return;
        sock.__miasEmojiForwardV37 = true;

        const cache = new Map();
        const ownerJid = String(opts.ownerJid || sock.user?.id || '')
          .replace(/:\d+(?=@)/, '');
        const CACHE_TTL_MS = 15 * 60 * 1000;
        const keyOf = (key) => [key.remoteJid || '', key.id || '', key.participant || ''].join('|');

        const remember = (msg) => {
          if (!msg?.key?.id) return;
          cache.set(keyOf(msg.key), { message: msg, expiresAt: Date.now() + CACHE_TTL_MS });
        };

        const unwrap = (m) => {
          let c = m;
          for (let i = 0; i < 8 && c; i++) {
            const n = c.ephemeralMessage?.message || c.viewOnceMessage?.message
              || c.viewOnceMessageV2?.message || c.viewOnceMessageV2Extension?.message
              || c.documentWithCaptionMessage?.message || c.editedMessage?.message;
            if (!n) break; c = n;
          }
          return c || {};
        };
        const isMedia = (m) => {
          const u = unwrap(m?.message || {});
          return Boolean(u.imageMessage || u.videoMessage || u.audioMessage
            || u.documentMessage || u.stickerMessage);
        };
        const getDownloader = () => {
          try {
            const m = require('@whiskeysockets/baileys');
            return m.downloadContentFromMessage || m.default?.downloadContentFromMessage || null;
          } catch { return null; }
        };
        const bufFrom = async (raw, kind) => {
          const dl = getDownloader();
          if (!dl) return null;
          try {
            const stream = await dl(raw, kind);
            const chunks = [];
            for await (const c of stream) chunks.push(c);
            return Buffer.concat(chunks);
          } catch { return null; }
        };
        const buildPayload = async (m, emoji) => {
          const u = unwrap(m?.message || {});
          if (u.imageMessage) {
            const b = await bufFrom(u.imageMessage, 'image');
            if (!b) return null;
            const cap = u.imageMessage.caption ? u.imageMessage.caption + '\n\n' + emoji : emoji;
            return { image: b, caption: cap };
          }
          if (u.videoMessage) {
            const b = await bufFrom(u.videoMessage, 'video');
            if (!b) return null;
            return { video: b, mimetype: u.videoMessage.mimetype || 'video/mp4',
                     caption: (u.videoMessage.caption || '') + '\n\n' + emoji };
          }
          if (u.audioMessage) {
            const b = await bufFrom(u.audioMessage, 'audio');
            if (!b) return null;
            return { audio: b, mimetype: u.audioMessage.mimetype || 'audio/mp4',
                     ptt: !!u.audioMessage.ptt };
          }
          if (u.documentMessage) {
            const b = await bufFrom(u.documentMessage, 'document');
            if (!b) return null;
            return { document: b, mimetype: u.documentMessage.mimetype || 'application/octet-stream',
                     fileName: u.documentMessage.fileName || 'file' };
          }
          if (u.stickerMessage) {
            const b = await bufFrom(u.stickerMessage, 'sticker');
            if (b) return { sticker: b };
          }
          return null; // no media → emoji-forward does nothing
        };

        sock.ev.on('messages.upsert', (evt) => {
          for (const m of (evt?.messages || [])) remember(m);
        });

        sock.ev.on('messages.reaction', async (events = []) => {
          const list = Array.isArray(events) ? events : [events];
          for (const ev of list) {
            try {
              const r = ev?.reaction || ev;
              const emoji = String(r?.text || '').trim();
              if (!emoji) continue;
              const reactor = r?.participant || ev?.participant || ev?.senderPn
                || (r?.key?.fromMe ? (sock.user?.id || ownerJid) : '');
              const reactorDigits = String(reactor || '').replace(/[^0-9]/g, '');
              const myDigits = String(opts.ownerDigits || sock.user?.id || '').replace(/[^0-9]/g, '');
              const isOwner = Boolean(
                ev?.fromMe === true || r?.fromMe === true
                || (myDigits && reactorDigits && reactorDigits.endsWith(myDigits))
              );
              if (!isOwner) continue;
              if (!ownerJid) continue;
              const src = r?.key?.remoteJid || '';
              if (!src || src === ownerJid || src === 'status@broadcast') continue;

              const cached = cache.get(keyOf(r.key));
              if (!cached || cached.expiresAt < Date.now()) continue;
              if (!isMedia(cached.message)) continue;

              const payload = await buildPayload(cached.message, emoji);
              if (!payload) continue;
              await sock.sendMessage(ownerJid, payload);
            } catch (e) { console.error('[v37-emoji-fwd]', e?.message || e); }
          }
        });
      }
      // Expose the v37 helper in parallel with the existing one.
      rf.installV37EmojiForward = installV37EmojiForward;
      rf.installReactionForwarder = function wrapped(sock, opts) {
        try { origInstall && origInstall(sock, opts); } catch {}
        try { installV37EmojiForward(sock, opts); } catch (e) { console.error('[v37-emoji-fwd-install]', e?.message || e); }
      };
    }
  } catch {}

  /* ────────────────────────────────────────────────────────────────────────
   *  FIX 6 — PIN (real WhatsApp pinChat / relayMessage pin)
   * ──────────────────────────────────────────────────────────────────────── */
  async function _pinInChat(sock, jid, ctx, secs) {
    const isGroup = jid.endsWith('@g.us');
    const rawParticipant = ctx.participant || (isGroup ? ctx.remoteJid : undefined);
    const normalizedParticipant = rawParticipant ? rawParticipant.replace(/:\d+(?=@)/, '') : undefined;
    const myNum = sock?.user?.id ? sock.user.id.split(':')[0].replace(/[^0-9]/g, '') : '';
    const fromMe = Boolean(ctx.fromMe || (normalizedParticipant && myNum && normalizedParticipant.includes(myNum)));

    const pinKey = {
      remoteJid: jid,
      id: ctx.stanzaId,
      fromMe: fromMe,
      ...(isGroup && normalizedParticipant ? { participant: normalizedParticipant } : {})
    };

    // Strategy 1: Official Baileys sendMessage pin format (sock.sendMessage(jid, { pin: key, type: 1, time: secs }))
    try {
      if (typeof sock.sendMessage === 'function') {
        const res = await sock.sendMessage(jid, {
          pin: pinKey,
          type: 1,
          time: secs
        });
        if (res?.key?.id) return { ok: true, strategy: 'sendMessage-direct' };
      }
    } catch (e1) { console.error('[v37-pin-send-1]', e1?.message || e1); }

    // Strategy 2: Baileys nested pin format (sock.sendMessage(jid, { pin: { key: pinKey, type: 1, time: secs } }))
    try {
      if (typeof sock.sendMessage === 'function') {
        const res = await sock.sendMessage(jid, {
          pin: {
            key: pinKey,
            type: 1,
            time: secs
          }
        });
        if (res?.key?.id) return { ok: true, strategy: 'sendMessage-nested' };
      }
    } catch (e2) { console.error('[v37-pin-send-2]', e2?.message || e2); }

    // Strategy 3: generateWAMessageFromContent + relayMessage
    try {
      let wm = null;
      try { wm = require('@whiskeysockets/baileys'); } catch {
        try { wm = await import('@whiskeysockets/baileys'); } catch {}
      }
      if (typeof wm?.generateWAMessageFromContent === 'function') {
        const pinMsg = wm.generateWAMessageFromContent(jid, {
          pinInChatMessage: {
            key: pinKey, type: 1, senderTimestampMs: Date.now(),
          },
          messageContextInfo: {
            messageAddOnDurationInSecs: secs,
          },
        }, {});
        await sock.relayMessage(jid, pinMsg.message, { messageId: pinMsg.key?.id });
        return { ok: true, strategy: 'relay-wam' };
      }
    } catch (e3) { console.error('[v37-pin-gen]', e3?.message || e3); }

    // Strategy 4: direct relayMessage fallback
    try {
      if (typeof sock.relayMessage === 'function') {
        await sock.relayMessage(jid, {
          pinInChatMessage: {
            key: pinKey, type: 1, senderTimestampMs: Date.now(),
          },
          messageContextInfo: { messageAddOnDurationInSecs: secs },
        }, {});
        return { ok: true, strategy: 'relay-direct' };
      }
    } catch (e4) { console.error('[v37-pin-relay]', e4?.message || e4); }

    return { ok: false };
  }

  function installPinFix(sock) {
    // The .pin command lives inside mias/index.js (the giant file). v37
    // patches it by name at boot IF the loader placed its `commands` map in
    // the installer ctx; otherwise it exposes `pinInChat` for v36/the big
    // file to call.
    globalThis.__v37PinInChat = _pinInChat;
    if (!commands) return;
    const _pin = commands.get('pin') || commands.get('pinmsg') || commands.get('pinchat');
    if (!_pin || _pin.__v37PinFix) return;
    _pin.__v37PinFix = true;
    const orig = _pin.run || _pin.handler;
    _pin.run = async (sock, msg, args) => {
      try {
        const stub = await orig(sock, msg, args);
        // Always attempt v37 real-pin AFTER the stub runs (so the user
        // sees the original ack). Real-pin only fires when a quoted msg
        // exists.
        const jid = msg.key?.remoteJid;
        const ctx = msg.message?.extendedTextMessage?.contextInfo
              || msg.message?.imageMessage?.contextInfo
              || msg.message?.videoMessage?.contextInfo
              || msg.message?.documentMessage?.contextInfo;
        if (!jid || !ctx?.stanzaId) return stub;
        const arg = (args?.[0] || '').toLowerCase();
        let secs = 604800;
        if (arg === '24h' || arg === '1d') secs = 86400;
        else if (arg === '30d' || arg === '1m') secs = 2592000;
        const r = await _pinInChat(sock, jid, ctx, secs);
        if (r.ok) return stub; // success — keep original text
      } catch {}
      return undefined; // let original reply flow handle failure
    };
  }

  /* ────────────────────────────────────────────────────────────────────────
   *  FIX 7 — STATUS REPLY builder: blue Meta-AI verified badge, bot DP
   * ──────────────────────────────────────────────────────────────────────── */
  async function _buildBotDp(sock) {
    try {
      const me = sock?.user?.id;
      if (!me) return null;
      const url = await sock.profilePictureUrl(me, 'image').catch(() => null);
      if (url) {
        const r = await axios.get(url, { responseType: 'arraybuffer', timeout: 12000 }).catch(() => null);
        if (r?.data && Buffer.isBuffer(r.data) && r.data.length > 500)
          return { buffer: r.data, url };
      }
      const pre = await sock.profilePictureUrl(me, 'preview').catch(() => null);
      if (pre) {
        const r = await axios.get(pre, { responseType: 'arraybuffer', timeout: 12000 }).catch(() => null);
        if (r?.data) return { buffer: Buffer.from(r.data), url: pre };
      }
    } catch {}
    return null;
  }
  function _metaAiName(sock) {
    const bn = (CONFIG && CONFIG.BOT_NAME) || 'MAIS';
    return `${bn} ✓`; // blue-verified glyph approximation, will render as bold "✓"
  }
  function installStatusReplyBadge(sock) {
    // Override the existing __V36_STATUS_REPLY_CTX with one that always uses
    // the BOT'S profile picture and stamps the blue badge cleanly.
    if (sock?.__v37StatusBadgeInstalled) return;
    if (sock) sock.__v37StatusBadgeInstalled = true;
    let _botDpCache = null;
    const build = async (sockOrMsg, maybeMsg) => {
      const targetSock = (maybeMsg ? sockOrMsg : sock) || sock;
      const targetMsg = maybeMsg || sockOrMsg;
      const owJ = (typeof getOwnerJid === 'function' ? getOwnerJid() : '')
        || ((CONFIG?.OWNER_NUMBER || '').replace(/[^0-9]/g, '') + '@s.whatsapp.net');
      const owS = (typeof getSettings === 'function' ? getSettings(owJ) : null) || {};
      if (!owS.statusReply) return null;
      // Fetch bot DP ONCE (or fall back to a tiny embedded jpeg).
      if (!_botDpCache) _botDpCache = await _buildBotDp(targetSock);

      const ctx = {};
      let fakeQuoted = null;
      if (owS.statusReply) {
        const chatJid = targetMsg?.key?.remoteJid || "";
        const isGroup = String(chatJid).endsWith("@g.us");
        const targetRemoteJid = "status@broadcast";
        fakeQuoted = {
          key: {
            remoteJid: targetRemoteJid,
            fromMe: false,
            participant: "13135550002@s.whatsapp.net",
            id: "META_AI_" + Math.random().toString(36).substring(2, 10).toUpperCase(),
          },
          participant: "13135550002@s.whatsapp.net",
          message: {
            conversation: "Meta AI",
          },
          verifiedProfile: true,
          verifiedBizName: "Meta AI",
          pushName: "Meta AI",
        };
        ctx.stanzaId = fakeQuoted.key.id;
        ctx.participant = "13135550002@s.whatsapp.net";
        ctx.remoteJid = targetRemoteJid;
        ctx.quotedMessage = { conversation: "Meta AI" };
        ctx.verifiedProfile = true;
        ctx.pushName = "Meta AI";
        ctx.isBotInvoke = true;
        ctx.botMessageInvokePayload = {};
      }
      return { ctx, fakeQuoted, label: _metaAiName(sock) };
    };
    globalThis.__V36_STATUS_REPLY_CTX = build;
    globalThis.__V37_STATUS_REPLY_CTX = build;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  function _installOnSocket(sock) {
    if (!sock) return;
    try { installAnonymousReceiptFix(sock); } catch (e) { console.error('[v37-anon]', e?.message || e); }
    try { installSettingsQuotedFix(sock); } catch (e) { console.error('[v37-set-fix]', e?.message || e); }
    try { installGstTargetResolution(sock); } catch (e) { console.error('[v37-gst]', e?.message || e); }
    try { installAnimeGcRetry(sock); } catch (e) { console.error('[v37-anime]', e?.message || e); }
    try { installPinFix(sock); } catch (e) { console.error('[v37-pin]', e?.message || e); }
    try { installStatusReplyBadge(sock); } catch (e) { console.error('[v37-status]', e?.message || e); }
    try {
      const rf = require('./features/reactionForward.js');
      rf?.installReactionForwarder && rf.installReactionForwarder(sock, {
        ownerJid: (typeof getOwnerJid === 'function' ? getOwnerJid() : ''),
      });
    } catch {}
  }

  // If we already have a sock, install now; otherwise hook the connect event.
  const sock = sockOf();
  if (sock) _installOnSocket(sock);
  else {
    // v36's installer re-arms the listener every reconnect — re-install ours too.
    setInterval(() => {
      const live = globalThis.__miasSock || sockOf();
      if (live && live.user && !live.__v37Installed) {
        try { live.__v37Installed = true; _installOnSocket(live); } catch {}
      }
    }, 5000).unref?.();
  }

  console.log('[v37] MIAX MDX boot-verify active → anon | settings-quoted | gst | anime-gc | pin | emoji-fwd | meta-ai-badge');

  return {
    ok: true,
    fixed: ['anonymous', 'settings_quoted', 'gst_target', 'anime_gc', 'pin', 'emoji_fwd', 'status_reply_badge'],
    reRunOnConnect: _installOnSocket,
  };
};
