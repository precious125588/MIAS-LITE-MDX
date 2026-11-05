/* ══════════════════════════════════════════════════════════════════════════
   precious-fixes-v20.js  ·  PRECIOUS FIX PACK  (drop-in replacement module)
   ──────────────────────────────────────────────────────────────────────────
   Installed LAST from mias/index.js, so it overrides every earlier patch.

   FIX 1 — .gst  stuck spinning reaction
     The status upload was awaited with NO timeout. When Baileys' upload to
     status@broadcast never settled, the promise never resolved, so the ✅/❌
     reaction was never emitted and the spinner stayed forever.
     → every network step is now raced against a hard timeout, the status is
       posted through the canonical status@broadcast + statusJidList path,
       and the reaction is resolved in a `finally` + a 90 s watchdog.

   FIX 2 — .play  "this file isn't available / something is wrong with this file"
     Causes found in the live code:
       • video shipped a raw thumbnail as `jpegThumbnail` (PNG/WebP/oversized)
         which WhatsApp rejects as a broken inline preview
       • mimetype/extension were trusted from the provider instead of sniffed
         from the bytes, so documents/audio arrived "corrupt"
       • no `seconds` on audio, so voice notes and audio burned clients
       • a failed video remux silently downgraded the file to a document
     → bytes are sniffed, mime/ext/seconds are derived from the real content,
       the thumbnail is dropped unless it is a real JPEG under 32 KB, and a
       real error is reported instead of a silent downgrade.

   FIX 3 — .play  view-once branches removed
     The JINX block re-registered .play with 6 formats (5 = view-once video,
     6 = view-once voice). .play / .music / .song are pinned back to the
     4-format card (1 audio · 2 document · 3 voice · 4 video). No view-once.

   FIX 4 — .setting  quoted reply went silent + buttons were a separate message
     → one single message: the settings menu WITH the native-flow picker
       embedded underneath (exactly the mechanism .tt uses), titled
       "Open settings"; tapping opens the toggle list, nothing to type.
     → the reply handler accepts a quoted reply, a typed number (6.1), a
       native tap (set:6.1 / paramsJson / rowId / selectedRowId) and no longer
       returns false (silence) on a bare section number — it now answers with
       the valid sub-options.

   FIX 5 — menu categories: ECONOMY (and every command that is only in it)
     removed from MENU_CATEGORIES and unregistered from the command map.
   ══════════════════════════════════════════════════════════════════════════ */

'use strict';

const CATEGORIES_TO_REMOVE = ['ECONOMY','RELIGION','TEXT'];   // add more names here if you want

function install(ctx) {
  const report = { gst: false, play: false, playViewOnce: false, settings: false, settingsReply: false, categories: [], rows: 0 };

  const try_ = (fn, label) => { try { return fn(); } catch (e) { console.log('[precious-v20] ' + label + ' error:', e && e.message); } };

  /* ══════════════════════════════════════════════════════════════════════
     FIX 1 — .gst
     ══════════════════════════════════════════════════════════════════════ */

  const genId = () => 'PREC' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

  const race = (p, ms, tag) => Promise.race([
    Promise.resolve(p),
    new Promise((_, rj) => setTimeout(() => rj(new Error(tag + ' timed out after ' + Math.round(ms / 1000) + 's')), ms)),
  ]);

  const unwrap = (m) => (!m || typeof m !== 'object') ? m : (
    m.ephemeralMessage?.message ||
    m.viewOnceMessage?.message ||
    m.viewOnceMessageV2?.message ||
    m.viewOnceMessageV2Extension?.message ||
    m.documentWithCaptionMessage?.message ||
    m);

  const innerOf = (m) => {
    if (!m) return null;
    if (m.imageMessage) return { kind: 'image', raw: m.imageMessage };
    if (m.videoMessage) return { kind: 'video', raw: m.videoMessage };
    if (m.audioMessage) return { kind: 'audio', raw: m.audioMessage };
    if (m.stickerMessage) return { kind: 'sticker', raw: m.stickerMessage };
    if (m.documentMessage) return { kind: 'document', raw: m.documentMessage };
    return null;
  };

  const textOf = (m) => {
    if (!m) return '';
    return m.conversation
      || m.extendedTextMessage?.text
      || m.imageMessage?.caption
      || m.videoMessage?.caption
      || m.documentMessage?.caption
      || '';
  };

  // Download a quoted media stanza with a hard timeout.
  async function downloadQuoted(kind, raw, ms) {
    const streamer = ctx.downloadContentFromMessage || ctx.Baileys?.downloadContentFromMessage;
    if (!streamer) throw new Error('download helper unavailable');
    const type = kind === 'ptv' ? 'video' : kind;
    const stream = await race(streamer(raw, type), ms, 'download');
    let buf = Buffer.alloc(0);
    for await (const c of stream) buf = Buffer.concat([buf, c]);
    return buf;
  }

  async function postStatus(sock, chat, memberJids, payload) {
    const opts = { statusJidList: memberJids, messageId: genId() };
    const errors = [];

    // 1) canonical path — Baileys builds the correct status stanza itself
    try {
      await race(sock.sendMessage('status@broadcast', { ...payload, contextInfo: { isGroupStatus: true, mentionedJid: [] } }, opts), 45000, 'status upload');
      return true;
    } catch (e) { errors.push('status@broadcast: ' + (e && e.message)); }

    // 2) relay path (only when the helpers really exist)
    try {
      const gwc = ctx.generateWAMessageContent
        || (typeof generateWAMessageContent === 'function' ? generateWAMessageContent : null);
      if (gwc && sock.relayMessage && sock.waUploadToServer) {
        const inner = await race(gwc(payload, { upload: sock.waUploadToServer }), 45000, 'content build');
        await race(sock.relayMessage(chat, { groupStatusMessageV2: { message: inner } }, opts), 30000, 'relay');
        return true;
      }
    } catch (e) { errors.push('relay: ' + (e && e.message)); }

    // 3) last resort — in-chat post flagged as a group status
    try {
      await race(sock.sendMessage(chat, { ...payload, contextInfo: { isGroupStatus: true } }), 30000, 'in-chat post');
      return true;
    } catch (e) { errors.push('in-chat: ' + (e && e.message)); }

    throw new Error(errors.join(' | ') || 'all posting methods failed');
  }

  async function gstHandler(sock, msg, args) {
    const chat = msg.key.remoteJid;
    const prefix = (ctx.CONFIG && ctx.CONFIG.PREFIX) || '.';

    if (!String(chat || '').endsWith('@g.us')) {
      await ctx.sendReply(sock, msg, 'ℹ️ Legacy GST handler disabled; use the active v21 handler.').catch(() => {});
      return;
    }

    // The reaction resolver — single shot, always fires, never throws.
    let settled = false;
    const reactOnce = async (emoji) => {
      if (settled) return;
      settled = true;
      try { await ctx.forceReaction(sock, msg, emoji); } catch (e) {}
    };

    await reactOnce('🌀');
    settled = false;                       // re-arm: 🌀 is shown, result comes later
    const watchdog = setTimeout(() => { reactOnce('❌'); }, 90000);

    try {
      const text = (args || []).join(' ').trim();
      const ctxInfo = msg.message?.extendedTextMessage?.contextInfo
        || msg.message?.imageMessage?.contextInfo
        || msg.message?.videoMessage?.contextInfo
        || msg.message?.audioMessage?.contextInfo
        || msg.message?.documentMessage?.contextInfo
        || null;

      const quoted = ctxInfo?.quotedMessage ? unwrap(ctxInfo.quotedMessage) : null;
      const qInner = innerOf(quoted) || innerOf(unwrap(msg.message || {}));
      const quotedText = quoted ? textOf(quoted) : '';

      if (!qInner && !text && !quotedText) {
        clearTimeout(watchdog);
        await reactOnce('❌');
        return ctx.sendReply(sock, msg,
          '📢 *Group Status*\n\nReply to an image, video, audio, sticker or document and send *' + prefix + 'gst*\nOr type: *' + prefix + 'gst <text>* to post a text status.').catch(() => {});
      }

      // Group members that should receive the status
      let memberJids = [];
      try {
        const meta = await race(sock.groupMetadata(chat), 15000, 'groupMetadata');
        memberJids = (meta?.participants || [])
          .map(p => {
            const id = typeof p.id === 'string' ? p.id : String(p.id || '');
            try { return typeof resolveLid === 'function' ? resolveLid(id) : id; } catch (e) { return id; }
          })
          .filter(j => typeof j === 'string' && j.endsWith('@s.whatsapp.net'));
      } catch (e) {}

      const selfJid = String(sock.user?.id || '').split(':')[0].split('@')[0] + '@s.whatsapp.net';
      if (!memberJids.length && selfJid.length > 5) memberJids = [selfJid];

      let payload;
      let what = 'Text';

      if (!qInner) {
        payload = { text: text || quotedText };
      } else {
        const buf = await downloadQuoted(qInner.kind, qInner.raw, 60000);
        if (!buf || buf.length < 128) throw new Error('the quoted media could not be downloaded (empty file)');
        const mime = qInner.raw.mimetype || '';
        const cap = text || '';
        const k = qInner.kind;
        if (k === 'image')         { payload = { image: buf, caption: cap, mimetype: mime || 'image/jpeg' }; what = 'Image'; }
        else if (k === 'video')    { payload = { video: buf, caption: cap, mimetype: mime || 'video/mp4', gifPlayback: false }; what = 'Video'; }
        else if (k === 'audio')    { payload = { audio: buf, mimetype: /ogg|opus/i.test(mime) ? 'audio/ogg; codecs=opus' : (mime || 'audio/mpeg'), ptt: !!qInner.raw.ptt }; what = 'Audio'; }
        else if (k === 'sticker')  { payload = { image: buf, mimetype: 'image/webp', caption: cap }; what = 'Sticker'; }
        else if (k === 'document') { payload = { document: buf, mimetype: mime || 'application/octet-stream', fileName: qInner.raw.fileName || 'file', caption: cap }; what = 'Document'; }
        else throw new Error('unsupported quoted media type: ' + k);
      }

      await postStatus(sock, chat, memberJids, payload);

      clearTimeout(watchdog);
      await reactOnce('✅');
      const sent = memberJids.length || 1;
      await ctx.sendReply(sock, msg, '✅ *' + what + ' uploaded to group status.*\n👥 Delivered to *' + sent + '* member(s).').catch(() => {});
      console.log('[gst] posted kind=' + (qInner ? qInner.kind : 'text') + ' members=' + sent + ' chat=' + chat);
    } catch (e) {
      clearTimeout(watchdog);
      await reactOnce('❌');
      await ctx.sendReply(sock, msg, '❌ *GST failed:* ' + ((e && e.message) || e)).catch(() => {});
      console.log('[gst] FAILED chat=' + chat + ' err=' + ((e && e.message) || e));
    } finally {
      clearTimeout(watchdog);
    }
  }

  if (try_(() => {
    for (const n of ['gst_v20_disabled', 'gstatus_v20_disabled', 'groupstatus_v20_disabled']) {
      if (ctx.commands) ctx.commands.delete(n);
      if (ctx.aliases) ctx.aliases.delete(n);
    }
    return true;
  }, 'gst')) report.gst = true;

  /* ══════════════════════════════════════════════════════════════════════
     FIX 2 — .play delivery
     ══════════════════════════════════════════════════════════════════════ */

  async function asBuffer(v) {
    if (!v) return null;
    if (Buffer.isBuffer(v)) return v;
    if (v.buf && Buffer.isBuffer(v.buf)) return v.buf;
    if (typeof v === 'string') {
      try { const fs = require('fs'); if (fs.existsSync(v)) return fs.readFileSync(v); } catch (e) {}
      return Buffer.from(v, 'binary');
    }
    if (v.data && Buffer.isBuffer(v.data)) return Buffer.from(v.data);
    return null;
  }

  function durSec(v) {
    if (v == null) return 0;
    if (typeof v === 'number') return Math.round(v > 10000 ? v / 1000 : v);
    const parts = String(v).trim().split(':').map(x => parseInt(x, 10));
    if (parts.some(isNaN)) return 0;
    return parts.reduce((a, b) => a * 60 + b, 0);
  }

  // Only a genuine JPEG under WhatsApp's ~32 KB inline-preview cap survives.
  function safeJpeg(buf) {
    try {
      const b = Buffer.isBuffer(buf) ? buf : null;
      if (!b || b.length < 128 || b.length > 32 * 1024) return null;
      if (b[0] !== 0xFF || b[1] !== 0xD8 || b[b.length - 2] !== 0xFF || b[b.length - 1] !== 0xD9) return null;
      return b;
    } catch (e) { return null; }
  }

  function looksLikeJunk(buf) {
    const head = buf.slice(0, 400).toString('utf8').trim().toLowerCase();
    return head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')
      || head.startsWith('{') || head.startsWith('[');
  }

  async function playDeliver(sock, entry, n, quotedKey) {
    const meta = entry.meta || {};
    const title = meta.title || 'audio';
    const safe = String(title).replace(/[^a-zA-Z0-9 _-]/g, '').trim().replace(/\s+/g, '_').slice(0, 60) || 'audio';
    const sockJid = (quotedKey && quotedKey.key && quotedKey.key.remoteJid) || entry.jid;
    const opt = quotedKey ? { quoted: quotedKey } : {};
    const secs = durSec(meta.duration);

    if (![1, 2, 3, 4].includes(n)) throw new Error('format ' + n + ' is not available on this card (1 audio · 2 document · 3 voice · 4 video)');

    let buf = await asBuffer(n === 4 ? await ctx._p2VideoBuf(meta) : await ctx._p2AudioBuf(meta));
    if (!buf || buf.length < 2048) throw new Error('the provider returned an empty file — try the command again');
    if (looksLikeJunk(buf)) throw new Error('the provider returned a web page instead of media — try again in a moment');

    const sniff = (ctx._mfSniff && ctx._mfSniff(buf)) || { kind: 'unknown', mime: 'application/octet-stream', ext: '.bin' };

    /* ── 4 · VIDEO ─────────────────────────────────────────────────────── */
    if (n === 4) {
      let vbuf = buf, mime = 'video/mp4';
      const vidKinds = ['mp4', 'webm', 'mkv', 'mov'];
      if (!vidKinds.includes(sniff.kind)) {
        // provider handed us audio/nothing — stop, do not send a fake video
        throw new Error('that link returned audio (' + sniff.kind + '), not video — pick *1* for audio');
      }
      if (ctx._mfPrepareVideo) {
        try {
          const p = await ctx._mfPrepareVideo(buf);
          if (p && p.ok && p.buf && p.buf.length > 2048) { vbuf = p.buf; mime = p.mime || mime; }
        } catch (e) { console.log('[play] prepareVideo:', e && e.message); }
      }
      const payload = {
        video: vbuf,
        mimetype: mime || 'video/mp4',
        fileName: safe + '.mp4',
        caption: '🎬 *' + title + '*\n👤 ' + (meta.artists || meta.author || 'Unknown') + (secs ? '  ⏱️ ' + (meta.duration || '') : ''),
        gifPlayback: false,
      };
      if (secs) payload.seconds = secs;
      const jt = safeJpeg(await ctx._p2ThumbBuf(meta).catch(() => null));
      if (jt) payload.jpegThumbnail = jt;        // ← only real JPEG < 32KB, else omitted
      await sock.sendMessage(sockJid, payload, opt);
      return { ok: true, kind: 'video' };
    }

    /* ── 2 · DOCUMENT ──────────────────────────────────────────────────── */
    if (n === 2) {
      let dbuf = buf, mime = sniff.mime, ext = sniff.ext;
      if (ctx._mfPrepareAudioDoc) {
        try {
          const p = await ctx._mfPrepareAudioDoc(buf);
          if (p && p.buf) { dbuf = p.buf; mime = p.mime || mime; ext = p.ext || ext; }
        } catch (e) {}
      }
      await sock.sendMessage(sockJid, {
        document: dbuf,
        mimetype: mime || 'audio/mpeg',
        fileName: safe + (ext || '.mp3'),
        caption: '📄 *' + title + '*\n👤 ' + (meta.artists || meta.author || 'Unknown'),
      }, opt);
      return { ok: true, kind: 'document' };
    }

    /* ── 3 · VOICE NOTE ────────────────────────────────────────────────── */
    if (n === 3) {
      let ogg = null;
      try { if (ctx._p2ToPtt) ogg = await ctx._p2ToPtt(buf); } catch (e) {}
      if (!ogg || (ctx._mfSniff && ctx._mfSniff(ogg).kind !== 'ogg')) {
        try { if (ctx._mfToOggOpus) ogg = await ctx._mfToOggOpus(buf); } catch (e) {}
      }
      if (ogg && ctx._mfSniff && ctx._mfSniff(ogg).kind === 'ogg' && ogg.length > 1024) {
        const payload = {
          audio: ogg,
          mimetype: 'audio/ogg; codecs=opus',
          ptt: true,
          fileName: safe + '.ogg',
        };
        if (secs) payload.seconds = secs;
        await sock.sendMessage(sockJid, payload, opt);
        return { ok: true, kind: 'ptt' };
      }
      // No Opus encoder → send plain audio and say so instead of a broken file.
      const plain = (ctx._mfPrepareAudio && await ctx._mfPrepareAudio(buf).catch(() => null)) || { buf, mime: sniff.mime, ext: sniff.ext };
      await sock.sendMessage(sockJid, {
        audio: plain.buf, mimetype: plain.mime || 'audio/mpeg', ptt: false, fileName: safe + (plain.ext || '.mp3'),
      }, opt);
      await ctx.sendReply(sock, quotedKey || { key: { remoteJid: sockJid } }, '⚠️ ffmpeg is unavailable on the host, so the voice note was sent as normal audio instead.').catch(() => {});
      return { ok: true, kind: 'audio-fallback' };
    }

    /* ── 1 · AUDIO ─────────────────────────────────────────────────────── */
    let abuf = buf, amime = sniff.mime, aext = sniff.ext;
    if (ctx._mfPrepareAudio) {
      try {
        const p = await ctx._mfPrepareAudio(buf);
        if (p && p.buf) { abuf = p.buf; amime = p.mime || amime; aext = p.ext || aext; }
      } catch (e) {}
    }
    if (sniff.kind === 'unknown') { amime = 'audio/mpeg'; aext = '.mp3'; }
    const apayload = { audio: abuf, mimetype: amime, ptt: false, fileName: safe + (aext || '.mp3') };
    if (secs) apayload.seconds = secs;
    await sock.sendMessage(sockJid, apayload, opt);
    return { ok: true, kind: 'audio' };
  }

  if (try_(() => { ctx.setDeliver(playDeliver); return true; }, 'play-deliver')) report.play = true;

  // .play/.music/.song is handled by the main ads player (__rdlPlayCard) in mias/index.js
  // Legacy card rebinding disabled permanently to prevent JINX card override.
  report.playViewOnce = true;

  /* ══════════════════════════════════════════════════════════════════════
     FIX 4 — .setting  (native picker embedded, quoted reply works)
     ══════════════════════════════════════════════════════════════════════ */

  // code → [group, label, check(settings)]
  const T = [
    ['1.1', 'Block Calls', 'ENABLE', s => !!s.blockCalls],
    ['1.2', 'Block Calls', 'DISABLE', s => !s.blockCalls],
    ['2.1', 'Link Guard', 'DELETE', s => s.linkGuard === 'delete'],
    ['2.2', 'Link Guard', 'KICK', s => s.linkGuard === 'kick'],
    ['2.3', 'Link Guard', 'WARN', s => s.linkGuard === 'warn'],
    ['3.1', 'Bad Word Guard', 'DELETE', s => s.badWordGuard === 'delete'],
    ['3.2', 'Bad Word Guard', 'KICK', s => s.badWordGuard === 'kick'],
    ['3.3', 'Bad Word Guard', 'WARN', s => s.badWordGuard === 'warn'],
    ['4.1', 'Status Mention', 'DELETE', s => s.statusMention === 'delete'],
    ['4.2', 'Status Mention', 'KICK', s => s.statusMention === 'kick'],
    ['4.3', 'Status Mention', 'WARN', s => s.statusMention === 'warn'],
    ['4.4', 'Status Mention', 'FALSE', s => s.statusMention === 'false'],
    ['5.1', 'Call Action', 'CUT', s => s.callAction === 'cut'],
    ['5.2', 'Call Action', 'BLOCK', s => s.callAction === 'block'],
    ['6.1', 'Anti Delete', 'ENABLE', s => !!s.antiDelete],
    ['6.2', 'Anti Delete', 'DISABLE', s => !s.antiDelete],
    ['7.1', 'Auto React', 'ENABLE', s => !!s.autoReact],
    ['7.2', 'Auto React', 'DISABLE', s => !s.autoReact],
    ['8.1', 'Auto Block', 'ENABLE', s => !!s.autoBlock],
    ['8.2', 'Auto Block', 'DISABLE', s => !s.autoBlock],
    ['9.1', 'Read Msgs', 'ENABLE', s => !!s.readMsgs],
    ['9.2', 'Read Msgs', 'DISABLE', s => !s.readMsgs],
    ['10.1', 'View Status', 'ENABLE', s => !!s.viewStatus],
    ['10.2', 'View Status', 'DISABLE', s => !s.viewStatus],
    ['11.1', 'React Status', 'ENABLE', s => !!s.reactStatus],
    ['11.2', 'React Status', 'DISABLE', s => !s.reactStatus],
    ['12.1', 'Welcome Msg', 'ENABLE', s => !!s.welcome],
    ['12.2', 'Welcome Msg', 'DISABLE', s => !s.welcome],
    ['13.1', 'Auto Voice', 'ENABLE', s => !!s.autoVoice],
    ['13.2', 'Auto Voice', 'DISABLE', s => !s.autoVoice],
    ['14.1', 'Auto Sticker', 'ENABLE', s => !!s.autoSticker],
    ['14.2', 'Auto Sticker', 'DISABLE', s => !s.autoSticker],
    ['15.1', 'Auto Reply', 'ENABLE', s => !!s.autoReply],
    ['15.2', 'Auto Reply', 'DISABLE', s => !s.autoReply],
    ['16.1', 'Recording', 'ENABLE', s => !!s.recording],
    ['16.2', 'Recording', 'DISABLE', s => !s.recording],
    ['17.1', 'Typing', 'ENABLE', s => !!s.typing],
    ['17.2', 'Typing', 'DISABLE', s => !s.typing],
    ['18.1', 'Always Online', 'ENABLE', s => !!s.alwaysOnline],
    ['18.2', 'Always Online', 'DISABLE', s => !s.alwaysOnline],
    ['19.1', 'Work Mode', 'PUBLIC', s => s.workMode === 'public'],
    ['19.2', 'Work Mode', 'PRIVATE', s => s.workMode === 'private'],
    ['19.3', 'Work Mode', 'ONLY GROUP', s => s.workMode === 'only_group'],
    ['19.4', 'Work Mode', 'INBOX', s => s.workMode === 'inbox'],
    ['20.1', 'Language', 'EN', s => s.language === 'en'],
    ['20.2', 'Language', 'FR', s => s.language === 'fr'],
    ['21.1', 'Chat Bot Mode', 'ENABLE', s => !!s.chatBotMode],
    ['21.2', 'Chat Bot Mode', 'DISABLE', s => !s.chatBotMode],
    ['22.1', 'Owner React', 'ENABLE', s => !!s.ownerReact],
    ['22.2', 'Owner React', 'DISABLE', s => !s.ownerReact],
    ['23.1', 'Adult Mode', 'ENABLE', s => !!s.adultMode],
    ['23.2', 'Adult Mode', 'DISABLE', s => !s.adultMode],
    ['24.1', 'Movie DL', 'ONLY ME', s => s.movieDl === 'only_me'],
    ['24.2', 'Movie DL', 'ONLY OWNERS', s => s.movieDl === 'only_owners'],
    ['24.3', 'Movie DL', 'ALL', s => s.movieDl === 'all'],
    ['24.4', 'Movie DL', 'DISABLE', s => s.movieDl === 'disable'],
    ['25.1', 'Anti-Del Scope', 'ONLY INBOX', s => s.antiDelScope === 'only_inbox'],
    ['25.2', 'Anti-Del Scope', 'ONLY GROUP', s => s.antiDelScope === 'only_group'],
    ['25.3', 'Anti-Del Scope', 'ALL', s => s.antiDelScope === 'all'],
    ['26.1', 'Anti Mention', 'ENABLE', s => !!s.antiMention],
    ['26.2', 'Anti Mention', 'DISABLE', s => !s.antiMention],
    ['27.1', 'Anti-Bug Shield', 'ENABLE', s => s.antiBug !== false],
    ['27.2', 'Anti-Bug Shield', 'DISABLE', s => s.antiBug === false],
    ['28.1', 'Force Private', 'ENABLE', s => !!s.forcePrivate],
    ['28.2', 'Force Private', 'DISABLE', s => !s.forcePrivate],
    ['29.1', 'Auto Downloader', 'OFF', s => s.autoDownload === 'off' || !s.autoDownload],
    ['29.2', 'Auto Downloader', 'DM ONLY', s => s.autoDownload === 'dm'],
    ['29.3', 'Auto Downloader', 'ALL CHATS', s => s.autoDownload === 'global'],
    ['30.1', 'Status Forwarder', 'ENABLE', s => !!s.statusForwarder],
    ['30.2', 'Status Forwarder', 'DISABLE', s => !s.statusForwarder],
    ['32.1', 'Status Reply', 'ENABLE', s => !!s.statusReply],
    ['32.2', 'Status Reply', 'DISABLE', s => !s.statusReply],
    ['39.1', 'Anti ViewOnce', 'ENABLE', s => !!s.antiViewOnce],
    ['39.2', 'Anti ViewOnce', 'DISABLE', s => !s.antiViewOnce],
    ['40.1', 'Anti ViewOnce Mode', 'CHAT', s => (s.antiViewOnceMode || 'private') === 'chat'],
    ['40.2', 'Anti ViewOnce Mode', 'PRIVATE', s => (s.antiViewOnceMode || 'private') === 'private'],
    ['41.1', 'Anti Delete Status', 'ENABLE', s => !!s.antiDStatus],
    ['41.2', 'Anti Delete Status', 'DISABLE', s => !s.antiDStatus],
  ];
  report.rows = T.length;

  // WhatsApp wants a small number of sections — pack rows greedily.
  function buildSections(jid) {
    const s = ctx.getSettings(jid) || {};
    const rows = T.map(([code, group, label, check]) => {
      let on = false;
      try { on = !!check(s); } catch (e) {}
      return {
        code, group,
        title: (on ? '✅ ' : '⬜ ') + code + ' · ' + label,
        description: group + (on ? ' — currently ON' : ''),
        id: 'set:' + code,
      };
    });
    const MAXR = 9, sections = [];
    let cur = null;
    for (const r of rows) {
      if (!cur || cur.rows.length >= MAXR) {
        cur = { title: '⚙️ ' + r.group + (sections.length ? ' (cont.)' : ''), rows: [] };
        sections.push(cur);
      }
      cur.rows.push({ title: r.title, description: r.description, id: r.id });
      if (sections.length > 9) break;
    }
    return sections;
  }

  const LEGACY_BTN = {
    blockcalls: ['1.1', '1.2'], linkguard: ['2.1', '2.3'], badword: ['3.1', '3.3'],
    statusmention: ['4.1', '4.4'], callaction: ['5.1', '5.2'], antidelete: ['6.1', '6.2'], antidstatus: ['41.1', '41.2'],
    autoreact: ['7.1', '7.2'], autoblock: ['8.1', '8.2'], readmsgs: ['9.1', '9.2'],
    viewstatus: ['10.1', '10.2'], reactstatus: ['11.1', '11.2'], welcome: ['12.1', '12.2'],
    autovoice: ['13.1', '13.2'], autosticker: ['14.1', '14.2'], autoreply: ['15.1', '15.2'],
    typing: ['17.1', '17.2'], alwaysonline: ['18.1', '18.2'], antimention: ['26.1', '26.2'],
    adultmode: ['23.1', '23.2'], typing2: ['16.1', '16.2'],
  };

  function clean(v) {
    let s = String(v == null ? '' : v);
    try { s = ctx.normalizeSettingsChoice ? ctx.normalizeSettingsChoice(s) : s; } catch (e) {}
    return s
      .replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '')
      .replace(/^[\s*`~>•·.,\-–—]+/, '')
      .replace(/[\s*`~<•·.,\-–—]+$/, '')
      .trim();
  }

  // Pull the tapped id / typed number out of every WhatsApp reply flavour.
  function extractChoice(msg, body) {
    const m = msg && msg.message ? msg.message : {};
    const cands = [];
    const push = (v) => { if (v != null && String(v).trim()) cands.push(String(v)); };

    push(body);
    push(m.conversation);
    push(m.extendedTextMessage && m.extendedTextMessage.text);
    push(m.buttonsResponseMessage && m.buttonsResponseMessage.selectedButtonId);
    push(m.listResponseMessage && m.listResponseMessage.singleSelectReply && m.listResponseMessage.singleSelectReply.selectedRowId);
    push(m.listResponseMessage && m.listResponseMessage.selectedRowId);
    push(m.templateButtonReplyMessage && m.templateButtonReplyMessage.selectedId);
    push(m.interactiveResponseMessage && m.interactiveResponseMessage.nativeFlowResponseMessage && m.interactiveResponseMessage.nativeFlowResponseMessage.paramsJson);
    push(m.interactiveResponseMessage && m.interactiveResponseMessage.buttonReply && m.interactiveResponseMessage.buttonReply.selectedId);
    const q = m.extendedTextMessage && m.extendedTextMessage.contextInfo && m.extendedTextMessage.contextInfo.quotedMessage;
    if (q) { push(q.conversation); push(q.extendedTextMessage && q.extendedTextMessage.text); }

    for (const raw of cands) {
      let v = clean(raw);
      if (!v) continue;
      if (v.startsWith('{') || v.startsWith('[')) {
        try {
          const o = JSON.parse(v);
          const stack = [o];
          while (stack.length) {
            const cur = stack.shift();
            if (cur == null) continue;
            if (typeof cur === 'string') { const s = clean(cur); if (s) return s; continue; }
            if (typeof cur !== 'object') continue;
            for (const k of ['id', 'rowId', 'selectedRowId', 'selectedId', 'buttonId', 'selectedButtonId']) {
              if (cur[k]) { const s = clean(cur[k]); if (s) return s; }
            }
            for (const k of Object.keys(cur)) stack.push(cur[k]);
          }
        } catch (e) {}
        continue;
      }
      if (/^set:/i.test(v) || /^\d{1,2}(\.\d{1,2})?$/.test(v) || v === '0') return v;
      const m2 = v.match(/\b(\d{1,2}(?:\.\d{1,2})?)\b/);
      if (m2) return m2[1];
    }
    return '';
  }

  function currentUserAllowed(sock, msg) {
    try {
      const sender = ctx.getSender(msg);
      if (msg.key.fromMe) return true;
      if (typeof ctx.isOwner === 'function' && ctx.isOwner(sender)) return true;
      if (typeof ctx.isSudo === 'function' && ctx.isSudo(sender)) return true;
    } catch (e) {}
    return false;
  }

  async function applyChoice(sock, msg, code) {
    const jid = msg.key.remoteJid;
    const prefix = (ctx.CONFIG && ctx.CONFIG.PREFIX) || '.';

    if (code === '0') {
      try { ctx.settingsSession.delete(jid); } catch (e) {}
      await ctx.sendReply(sock, msg, '✅ Settings closed.').catch(() => {});
      return true;
    }

    const fn = ctx.SETTINGS_MAP[code];
    if (!fn) {
      // If the user did not explicitly quote settings or tap a button, do not hijack!
      const _isSettingsTap = /^set:/i.test(code);
      let _isQuotingSettings = false;
      try {
        const _qm = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        const _txt = JSON.stringify(_qm || "");
        _isQuotingSettings = /settings|⚙️|section/i.test(_txt);
      } catch {}
      if (!_isSettingsTap && !_isQuotingSettings) return false;
      const major = String(code).split('.')[0];
      const subs = Object.keys(ctx.SETTINGS_MAP).filter(k => k.split('.')[0] === major).sort();
      if (subs.length) {
        await ctx.sendReply(sock, msg, '⚠️ *' + code + '* is not a settings option.\n\nFor section *' + major + '* use: *' + subs.join('* or *') + '*').catch(() => {});
        return true;
      }
      await ctx.sendReply(sock, msg, '❌ Unknown settings option *' + code + '*.\nReply a number from the menu, or *0* to close.').catch(() => {});
      return true;
    }

    // 28.x (Force Private) and 30.x (Status Forwarder) are creator-only
    if (/^(28|30)\.\d+$/.test(code) && !currentUserAllowed(sock, msg)) {
      await ctx.sendReply(sock, msg, '🚫 *Only the bot creator can change this setting.*').catch(() => {});
      return true;
    }

    const ownerJ = (ctx.CONFIG.OWNER_NUMBER || '').replace(/[^0-9]/g, '') + '@s.whatsapp.net';
    let out = '';
    try { out = fn(ctx.getSettings(jid)); } catch (e) { out = '❌ ' + (e && e.message); }
    try { fn(ctx.getSettings(ownerJ)); } catch (e) {}
    try { ctx.saveNow && ctx.saveNow(); } catch (e) {}

    await ctx.sendReply(sock, msg, String(out || '✅ Updated.') + '\n\n_Tap *⚙️ Open settings* below to change something else, or reply *0* to close._').catch(() => {});
    try { await ctx.forceReaction(sock, msg, '✅'); } catch (e) {}
    console.log('[settings] applied ' + code + ' in ' + jid);
    return true;
  }

  // Does a .play card own this reply? If yes the settings handler must stay out.
  function playCardOwnsReply(msg) {
    try {
      if (!ctx._P2_PENDING || ctx._P2_PENDING.size === 0) return false;
      const jid = msg.key.remoteJid;
      const qid = ctx._p2QuotedId ? ctx._p2QuotedId(msg) : null;
      if (qid && ctx._P2_PENDING.has(qid)) return true;
      for (const kv of ctx._P2_PENDING) {
        if (ctx._p2SameChat(kv[1].jid, jid) && Date.now() - kv[1].ts < 60 * 1000) return true;
      }
    } catch (e) {}
    return false;
  }

  async function settingsReply(sock, msg, body) {
    const jid = msg && msg.key && msg.key.remoteJid;
    if (!jid) return false;
    // Owner-global settings must not be authorized by a quoted panel or stale session.
    if (!currentUserAllowed(sock, msg)) return false;

    const raw = extractChoice(msg, body);
    if (!raw) return false;

    // native tap on the picker → set:<code>
    let tag = raw;
    if (/^set:/i.test(raw)) {
      tag = raw.slice(4).trim();
      if (LEGACY_BTN[tag.toLowerCase()]) tag = LEGACY_BTN[tag.toLowerCase()][0];
      else if (/^[\w]+:(on|off|enable|disable|toggle|1|2)$/i.test(tag)) {
        const bits = tag.split(':');
        const pair = LEGACY_BTN[bits[0].toLowerCase()];
        tag = pair ? (/(1|on|enable)$/i.test(bits[1]) ? pair[0] : pair[1]) : '';
      }
      if (!tag || !ctx.SETTINGS_MAP[tag]) {
        await ctx.sendReply(sock, msg, '⚠️ That button is out of date — send *' + ((ctx.CONFIG.PREFIX) || '.') + 'setting* to open the panel again.').catch(() => {});
        return true;
      }
    }

    const isCode = /^\d{1,2}(\.\d{1,2})?$/.test(tag);
    if (!isCode && tag !== '0') return false;

    // v23 (TDZ crash fix): `active` was used below BEFORE its `const`
    // declaration, which threw a ReferenceError on every quoted reply. The
    // catch-all in the caller then fell through to the legacy handler, which
    // auto-armed a settings session on the digit and answered "❌ Unknown
    // settings option *1*". Declared HERE so the quoted-card guard can use it.
    const active = !!(ctx.settingsSession && ctx.settingsSession.get(jid));

    // never steal a .play picker reply
    if (playCardOwnsReply(msg) && !/^set:/i.test(raw)) return false;

    // QUOTED-CARD FIX (v23 — hardened): a numeric reply that QUOTES a message
    // is normally a reply to one of the bot's download cards (.play / .nkiri /
    // .tt / .movie / .savetube / .ytmate), NOT a settings panel answer — and on
    // normal (non-Business) WhatsApp the native-flow taps never arrive at all,
    // so quoting + typing the number is the ONLY way users can use those
    // pickers. What actually happened: the user quoted the play card, typed 1,
    // and — because a stale settings session was still alive in the chat — the
    // panel auto-armed and answered "❌ Unknown settings option *1*" right
    // after the file had already been delivered. From now on, a QUOTED numeric
    // reply only belongs to settings when the quoted message really IS the
    // settings panel (its text contains ⚙️/Settings) — everything else is
    // handed back to the picker.
    const _quotedHas = !!(msg.message?.extendedTextMessage?.contextInfo?.quotedMessage);
    if (_quotedHas && isCode && !/^set:/i.test(raw)) {
      try {
        const _unwrapQ = (m) => {
          let cur = m;
          for (let i = 0; i < 6 && cur && typeof cur === 'object'; i++) {
            const nxt = cur.ephemeralMessage?.message
              || cur.viewOnceMessage?.message
              || cur.viewOnceMessageV2?.message
              || cur.viewOnceMessageV2Extension?.message
              || cur.documentWithCaptionMessage?.message
              || cur.editedMessage?.message || null;
            if (!nxt) break;
            cur = nxt;
          }
          return cur;
        };
        const _rawQ = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage
          || msg.message?.imageMessage?.contextInfo?.quotedMessage
          || msg.message?.videoMessage?.contextInfo?.quotedMessage
          || msg.message?.audioMessage?.contextInfo?.quotedMessage
          || msg.message?.documentMessage?.contextInfo?.quotedMessage || null;
        const _q = _unwrapQ(_rawQ);
        const _collectQ = (m, acc) => {
          acc = acc || [];
          if (!m || typeof m !== 'object') return acc;
          acc.push(
            m.conversation, m.extendedTextMessage?.text,
            m.imageMessage?.caption, m.videoMessage?.caption, m.documentMessage?.caption,
            m.interactiveMessage?.body?.text, m.interactiveMessage?.footer?.text,
            m.interactiveMessage?.header?.title,
            m.buttonsMessage?.contentText, m.buttonsMessage?.footer,
            m.listMessage?.description, m.listMessage?.title,
          );
          for (const k of Object.keys(m)) {
            const v = m[k];
            if (v && typeof v === 'object' && v.message && typeof v.message === 'object') _collectQ(v.message, acc);
          }
          return acc;
        };
        const _qText = _q ? _collectQ(_q).filter(Boolean).join(' ') : '';
        const _isSettingsPanel = /settings|⚙️/i.test(_qText);
        if (_q && !_isSettingsPanel) return false; // quoted a download card — not settings
      } catch (e) {}
    }
    if (!active && _quotedHas && isCode && !/^set:/i.test(raw)) return false;

    // a settings panel must be alive, a quoted panel must work, and a tap must always work
    const quoted = !!(msg.message?.extendedTextMessage?.contextInfo?.quotedMessage) || /^set:/i.test(raw);
    if (!active && !quoted) return false;

    try {
      if (ctx.settingsSession) {
        ctx.settingsSession.set(jid, { sender: ctx.getSender(msg) });
        const t = setTimeout(() => { try { ctx.settingsSession.delete(jid); } catch (e) {} }, 180000);
        if (t.unref) t.unref();
      }
    } catch (e) {}

    if (tag === '0') return applyChoice(sock, msg, '0');
    if (isCode && !ctx.SETTINGS_MAP[tag]) return applyChoice(sock, msg, tag);
    return applyChoice(sock, msg, tag);
  }

  if (try_(() => { ctx.setSettingsReply(settingsReply); return true; }, 'settings-reply')) report.settingsReply = true;

  // .setting — ONE message, menu + native picker embedded underneath (tt style)
  if (try_(() => {
    const handler = async (sock, msg) => {
      const jid = msg.key.remoteJid;
      const sender = ctx.getSender(msg);
      const inGroup = ctx.isGroup(msg);
      const isFromOwner = msg.key.fromMe || ctx.isOwner(sender) || ctx.isSudo(sender);
      const isAdmin = inGroup ? await ctx.isGroupAdmin(sock, jid, sender) : false;
      if (!isFromOwner) {
        if (inGroup && !isAdmin) { await ctx.sendReply(sock, msg, '🚫 Admins/Owner only.'); return; }
        if (!inGroup) { await ctx.sendReply(sock, msg, '🚫 Owner only.'); return; }
      }

      try {
        ctx.settingsSession.set(jid, { sender });
        const t = setTimeout(() => { try { ctx.settingsSession.delete(jid); } catch (e) {} }, 180000);
        if (t.unref) t.unref();
      } catch (e) {}

      const text = ctx.buildSettingsMenu(jid);
      const sections = buildSections(jid);
      const footer = (ctx.CONFIG.BOT_NAME || 'MIAS') + ' • settings';
      let pic = null;
      try { pic = await ctx.getBotPic(); } catch (e) {}
      if (pic && !Buffer.isBuffer(pic)) pic = null;

      try {
        await ctx.sendNativeFlowListMenu(
          sock, jid, msg, text, sections,
          [{ text: '⚙️ Open settings', id: 'setting' }],
          footer,
          { headerImage: pic || undefined, headerText: '⚙️ Settings' },
        );
        await ctx.forceReaction(sock, msg, '✅');
        return;
      } catch (e) {
        console.log('[settings] native picker unavailable, text fallback:', e && e.message);
      }
      // fallback: plain text panel (typed numbers still work)
      if (pic) { try { await sock.sendMessage(jid, { image: pic, caption: text }, { quoted: msg }); return; } catch (e) {} }
      await ctx.sendReply(sock, msg, text);
    };

    for (const n of ['setting', 'settings', 'config']) {
      const e = ctx.commands.get(n) || { category: 'SETTINGS' };
      e.handler = handler;
      e.desc = 'Open bot settings (tap the native buttons)';
      e.category = 'SETTINGS';
      ctx.commands.set(n, e);
    }
    return true;
  }, 'settings-cmd')) report.settings = true;

  /* ══════════════════════════════════════════════════════════════════════
     FIX 5 — remove menu categories + their commands
     ══════════════════════════════════════════════════════════════════════ */

  try_(() => {
    const cats = ctx.MENU_CATEGORIES;
    if (!Array.isArray(cats)) return;
    for (const wanted of CATEGORIES_TO_REMOVE) {
      const idx = cats.findIndex(c => String(c && c.name).toUpperCase() === wanted.toUpperCase());
      if (idx < 0) continue;
      const cat = cats[idx];
      const others = new Set();
      cats.forEach((c, i) => { if (i !== idx && Array.isArray(c.cmds)) c.cmds.forEach(x => others.add(String(x).toLowerCase())); });
      let removed = 0;
      for (const name of (cat.cmds || [])) {
        const key = String(name).toLowerCase();
        if (others.has(key)) continue;          // still used by another category → keep
        if (ctx.commands.delete(key)) removed++;
      }
      cats.splice(idx, 1);
      report.categories.push(wanted + ' (' + removed + ' commands unregistered)');
      console.log('[precious-v20] removed category ' + wanted + ' — ' + removed + ' commands unregistered');
    }
  }, 'categories');

  console.log('[precious-v20] installed → gst:' + report.gst + ' playDeliver:' + report.play
    + ' playCard:' + report.playViewOnce + ' settings:' + report.settings
    + ' settingsReply:' + report.settingsReply + ' rows:' + report.rows
    + ' categories:' + (report.categories.join(', ') || 'none'));

  return report;
}

module.exports = { install, CATEGORIES_TO_REMOVE };
