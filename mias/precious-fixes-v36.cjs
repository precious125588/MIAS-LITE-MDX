// =============================================================================
// precious-fixes-v36.cjs — MIAX MDX unified fix pack (REPLACES v20..v29).
// Install: in mias/index.js, AFTER all other fix-pack requires, add ONE line:
//
//   try { require("./precious-fixes-v36.cjs")({ commands, cmd, CONFIG, sendReply, react, getBotPic, getSettings, getOwnerJid, axios, downloadContentFromMessage }); } catch (e) { console.log("[v36] load error:", e.message); }
//
// Then DELETE the require lines for precious-fixes-v20/v21/v24/v27/v28/v29.
// =============================================================================
'use strict';
module.exports = function installV36(ctx) {
  const P = ctx || {};
  const { commands = new Map(), CONFIG, sendReply, react, getBotPic, getSettings, getOwnerJid, axios, downloadContentFromMessage } = P;
  const fs = require('fs'), os = require('os'), path = require('path');
  const { execFile } = require('child_process');
  const ffBin = (() => {
    try {
      const p = require('ffmpeg-static');
      if (p && typeof p === 'string' && fs.existsSync(p)) return p;
    } catch {}
    for (const p of ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/bin/ffmpeg']) {
      try { if (fs.existsSync(p)) return p; } catch {}
    }
    return 'ffmpeg';
  })();
  const runFF = (args, ms = 600000) => new Promise((res, rej) => execFile(ffBin, args, { timeout: ms }, e => e ? rej(e) : res()));

  // ── 1. HOISTED media grabber (fixes: "_cmfGrabMedia is not defined") ─────
  const grab = async (sock, msg) => {
    const q = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    let node = q || msg.message;
    for (const k of ['ephemeralMessage','viewOnceMessage','viewOnceMessageV2','viewOnceMessageV2Extension','documentWithCaptionMessage'])
      if (node?.[k]?.message) { node = node[k].message; break; }
    const KINDS = { imageMessage:'image', videoMessage:'video', audioMessage:'audio', stickerMessage:'sticker', documentMessage:'document', ptvMessage:'video' };
    let kind = null, raw = null;
    for (const k of Object.keys(KINDS)) if (node?.[k]) { kind = KINDS[k]; raw = node[k]; break; }
    if (!kind) return { kind: null, buf: null };
    try {
      const stream = await downloadContentFromMessage(raw, kind === 'sticker' ? 'sticker' : kind);
      const chunks = [];
      await Promise.race([
        (async () => { for await (const c of stream) chunks.push(c); })(),
        new Promise((_, rj) => setTimeout(() => rj(new Error('grab-timeout')), 30000))
      ]);
      return { kind, buf: Buffer.concat(chunks), raw };
    } catch (e) { console.error('[v36 grab] ' + e.message); return { kind: null, buf: null }; }
  };
  globalThis._cmfGrabMedia = grab;   // legacy path used by remini/hd/enhance
  globalThis.__mfGrabMedia = grab;   // wizard path

  // ── 2. QUALITY PIPELINE (sharp/jimp for images, ffmpeg for video/audio) ──
  async function remuxVideoFast(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 100) return buf;
    const inp = path.join(os.tmpdir(), "v_remux_in_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7) + ".mp4");
    const out = path.join(os.tmpdir(), "v_remux_out_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7) + ".mp4");
    try {
      fs.writeFileSync(inp, buf);
      // Ultra-fast stream-copy with faststart moov placement (<250ms, zero re-encode, pristine original quality)
      await runFF(["-hide_banner", "-loglevel", "error", "-y", "-i", inp, "-c", "copy", "-movflags", "+faststart", "-f", "mp4", out], 8000);
      const ob = fs.readFileSync(out);
      if (ob.length > 1000) return ob;
    } catch (e) {
      console.warn("[v36 remux fast fallback]", e?.message || e);
      try {
        const _pv = require("./lib/portableVideo.cjs");
        if (_pv && typeof _pv.normalizeVideoBuffer === "function") {
          const _n = await _pv.normalizeVideoBuffer(buf, { timeoutMs: 5000 });
          if (_n && _n.length > 1000) return _n;
        }
      } catch {}
    } finally {
      try { fs.unlinkSync(inp); } catch {}
      try { fs.unlinkSync(out); } catch {}
    }
    return buf;
  }
  globalThis.remuxVideoFast = remuxVideoFast;

  async function enhanceImage(buf) {
    // 4K image state: upscale with lanczos & unsharp filter up to 4K resolution (3840 long edge / 2160 short edge)
    const inp = path.join(os.tmpdir(), "img4k_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7) + ".jpg");
    const out = path.join(os.tmpdir(), "img4k_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7) + "_4k.jpg");
    try {
      fs.writeFileSync(inp, buf);
      const filter = "scale='if(gte(iw,ih),3840,-2)':'if(gte(iw,ih),-2,3840)':flags=lanczos,unsharp=5:5:0.8:3:3:0.4";
      await runFF(["-y", "-v", "error", "-i", inp, "-vf", filter, "-q:v", "2", out], 30000);
      if (fs.existsSync(out)) {
        const ob = fs.readFileSync(out);
        if (ob.length > 1000) return ob;
      }
    } catch (e) {
      console.error("[img4k enhance error]", e?.message || e);
    } finally {
      try { fs.unlinkSync(inp); } catch {}
      try { fs.unlinkSync(out); } catch {}
    }

    try {
      const sharp = require('sharp');
      const m = await sharp(buf).metadata();
      return await sharp(buf)
        .resize(Math.min((m.width || 1080) * 2, 8000), Math.min((m.height || 1080) * 2, 8000), { kernel: 'lanczos3', fit: 'inside' })
        .sharpen({ sigma: 1.1 })
        .jpeg({ quality: 95, mozjpeg: true })
        .toBuffer();
    } catch {}
    try { const J = require('jimp'); const j = await J.read(buf); return await j.scale(2).quality(95).getBufferAsync(J.MIME_JPEG); } catch {}
    return buf;
  }
  async function enhanceVideo(buf) {
    const inp = path.join(os.tmpdir(), "v36_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7) + ".mp4");
    const out = path.join(os.tmpdir(), "v36_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7) + "_o.mp4");
    try {
      fs.writeFileSync(inp, buf);
      // Fast bounded transcode (max 1280p width, preset veryfast, 15s timeout)
      await runFF(["-hide_banner", "-loglevel", "error", "-y", "-i", inp, "-vf", "scale=min(1280\,iw):-2", "-c:v", "libx264", "-crf", "22", "-preset", "ultrafast", "-c:a", "copy", "-movflags", "+faststart", out], 15000);
      const ob = fs.readFileSync(out);
      if (ob.length > 10000 && ob.length < 64 * 1024 * 1024) return ob;
    } catch (e) {
      console.error("[v36 video enhance]", e?.message || e);
      return await remuxVideoFast(buf);
    } finally {
      try { fs.unlinkSync(inp); } catch {}
      try { fs.unlinkSync(out); } catch {}
    }
    return buf;
  }
  async function audioToOpus(buf) {
    // WhatsApp status voice note strictly requires audio/ogg with opus codec and ptt: true.
    // Raw MP3 triggers "You shared a status but your version of WhatsApp doesn't support it. Update WhatsApp".
    const inp = path.join(os.tmpdir(), 'v37_' + Date.now() + '.input');
    const out = path.join(os.tmpdir(), 'v37_' + Date.now() + '.ogg');
    try {
      fs.writeFileSync(inp, buf);
      await runFF(['-y', '-i', inp, '-vn', '-c:a', 'libopus', '-b:a', '64k', '-ar', '48000', '-ac', '1', '-vbr', 'on', '-compression_level', '10', out]);
      const ob = fs.readFileSync(out);
      if (ob.length > 100) return ob;
    } catch (e) { console.error('[v37 opus transcode] ' + e.message); }
    finally { try { fs.unlinkSync(inp); } catch {} try { fs.unlinkSync(out); } catch {} }
    return buf;
  }

    // ── 3. GST wrapper — quality pipeline + MP3 audio + 🌀→✅ reactions ──────
  const memberJids = (meta) => (meta.participants || [])
    .map(p => (typeof p.id === 'string' ? p.id : String(p.id || '')))
    .filter(j => j.endsWith('@s.whatsapp.net'));

  const wrapGst = (orig) => async (sock, msg, args) => {
    const ctx0 = msg.message?.extendedTextMessage?.contextInfo;
    const q = ctx0?.quotedMessage;
    if (!q) return orig(sock, msg, args);
    const jid = msg.key.remoteJid;
    let targetGid = jid && jid.endsWith('@g.us') ? jid : '';
    const rawArgs = (args || []).map(a => String(a || '').trim()).filter(Boolean);
    let targetArgIdx = -1;

    // Detect target from args: JID or WhatsApp invite URL/code
    if (rawArgs.length > 0) {
      const first = rawArgs[0];
      if (first.endsWith('@g.us') || first.endsWith('@lid')) {
        targetGid = first;
        targetArgIdx = 0;
      } else if (/^\d{10,}$/.test(first)) {
        targetGid = first + '@g.us';
        targetArgIdx = 0;
      } else {
        const invMatch = first.match(/chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/i);
        const invCode = invMatch ? invMatch[1] : (/^[A-Za-z0-9_-]{18,}$/.test(first) ? first : null);
        if (invCode) {
          try {
            const info = await sock.groupGetInviteInfo(invCode).catch(() => null);
            if (info?.id) {
              targetGid = info.id.endsWith('@g.us') ? info.id : `${info.id}@g.us`;
              targetArgIdx = 0;
            }
          } catch {}
        }
      }
    }
    if (!targetGid) return orig(sock, msg, args);

    // Compute clean caption: exclude command names, target JID, and invite URLs
    const customWords = rawArgs.filter((a, idx) => {
      if (idx === targetArgIdx) return false;
      let rawStr = String(a || '').trim();
      if (/chat\.whatsapp\.com/i.test(rawStr) || /^https?:\/\//i.test(rawStr)) return false;
      if (/^[A-Za-z0-9_-]{20,}$/.test(rawStr)) return false;
      let s = rawStr.replace(/^[\(\[{<"']+|[\)\]}>"']+$/g, '').toLowerCase().replace(/^[.!#/]/, '');
      if (['gst', 'gstatus', 'groupstatus'].includes(s)) return false;
      if (s.endsWith('@g.us') || s.endsWith('@lid') || s.endsWith('@s.whatsapp.net') || /^[0-9\-]+@g\.us$/i.test(s) || /^\d{10,}$/.test(s)) return false;
      return true;
    });
    const customCap = customWords.join(' ').trim();
    const quotedCap = q.imageMessage?.caption || q.videoMessage?.caption || q.documentMessage?.caption || '';
    const finalCaption = customCap || '';

    try {
      const isAudio = q.audioMessage || (q.documentMessage && /audio/i.test(q.documentMessage?.mimetype || ''));
      if (isAudio) {
        const audioMsg = q.audioMessage || q.documentMessage;
        const st = await downloadContentFromMessage(audioMsg, 'audio');
        const chunks = []; for await (const c of st) chunks.push(c);
        let audioBuf = Buffer.concat(chunks);
        try {
          audioBuf = await audioToOpus(audioBuf);
        } catch (_) {}
        const meta = await sock.groupMetadata(targetGid).catch(() => ({ participants: [], subject: '' }));
        const members = memberJids(meta);
        await react(sock, msg, '🌀').catch(() => {});
        // Direct send to group
        await sock.sendMessage(targetGid, { audio: audioBuf, mimetype: 'audio/ogg; codecs=opus', ptt: true }).catch(() => {});
        // Relay status (clean voice note format with status background color & font)
        await sock.sendMessage('status@broadcast',
          { audio: audioBuf, mimetype: 'audio/ogg; codecs=opus', ptt: true },
          { statusJidList: members, backgroundColor: '#242220', font: 1, messageId: 'MIAS36' + Date.now().toString(36).toUpperCase() }).catch(() => {});
        await react(sock, msg, '✅').catch(() => {});
        await sendReply(sock, msg, `*AUDIO UPLOADED TO ${String(meta.subject || targetGid).toUpperCase()}*\n\nSENT TO *${members.length}* GROUP MEMBERS.`);
        return;
      }
      if (q.imageMessage || q.videoMessage) {
        const kind = q.imageMessage ? 'image' : 'video';
        const st = await downloadContentFromMessage(q.imageMessage || q.videoMessage, kind);
        const chunks = []; for await (const c of st) chunks.push(c);
        const better = kind === 'image' ? await enhanceImage(Buffer.concat(chunks)) : await enhanceVideo(Buffer.concat(chunks));
        const meta = await sock.groupMetadata(targetGid).catch(() => ({ participants: [], subject: '' }));
        const members = memberJids(meta);
        await react(sock, msg, '🌀').catch(() => {});
        const payload = kind === 'image'
          ? { image: better, caption: finalCaption, mimetype: 'image/jpeg', contextInfo: { isGroupStatus: true } }
          : { video: better, caption: finalCaption, mimetype: 'video/mp4', gifPlayback: false, contextInfo: { isGroupStatus: true } };
        // Direct send to target group
        await sock.sendMessage(targetGid, kind === 'image' ? { image: better, caption: finalCaption } : { video: better, caption: finalCaption, mimetype: 'video/mp4' }).catch(() => {});
        // Group status relay
        await sock.sendMessage('status@broadcast', payload,
          { statusJidList: members, messageId: 'MIAS36' + Date.now().toString(36).toUpperCase() }).catch(() => {});
        await react(sock, msg, '✅').catch(() => {});
        const lbl = kind === 'image' ? '*IMAGE' : '*VIDEO';
        await sendReply(sock, msg, `${lbl} UPLOADED TO ${String(meta.subject || targetGid).toUpperCase()}*\n\nSENT TO *${members.length}* GROUP MEMBERS. (HD ENHANCED)`);
        return;
      }
    } catch (e) { console.error('[v36 gst] ' + e.message); }
    return orig(sock, msg, args);
  };
  for (const n of ['gst','gstatus','groupstatus']) {
    const e = commands.get(n); if (!e || e.__v36) continue;
    const orig = e._origHandler || e.handler;
    e.handler = wrapGst(orig); e.__v36 = true; commands.set(n, e);
  }

  // ── 4. STATUS AUTO-SEND ("send" / "send pls" / "share" / "send boss") ────
  //     Call from your messages.upsert status-reply branch:
  //       if (globalThis.V36_STATUS_SEND && isSendKeyword) return globalThis.V36_STATUS_SEND(sock, msg, quoted);
  globalThis.V36_STATUS_SEND = async function (sock, msg, quoted) {
    const chat = msg?.key?.remoteJid;
    const requester = (chat === "status@broadcast" || chat?.endsWith("@g.us"))
      ? (msg?.key?.participant || msg?.participant) : chat;
    const quietReact = async emoji => { try { await react(sock, msg, emoji); } catch {} };
    const bounded = async (operation, ms, label) => {
      let timer;
      try {
        return await Promise.race([operation, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(label + " timed out")), ms);
          timer.unref?.();
        })]);
      } finally { clearTimeout(timer); }
    };
    let dir;
    const confirm = result => {
      if (!result?.key?.id) throw new Error("WhatsApp did not confirm the status send");
      return result;
    };
    await quietReact("🌀");
    try {
      if (!requester) throw new Error("Cannot determine status recipient");
      const kind = ["image", "video", "audio", "document"].find(k => quoted?.[k + "Message"]);
      if (!kind) {
        const text = quoted?.conversation || quoted?.extendedTextMessage?.text;
        if (!text) throw new Error("Unsupported or missing status content");
        confirm(await bounded(sock.sendMessage(requester, { text }), 180000, "Status delivery"));
      } else {
        const { pipeline } = require("node:stream/promises");
        const { Transform } = require("node:stream");
        dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mais_status_"));
        const raw = quoted[kind + "Message"];
        const ext = ({ image: "jpg", video: "mp4", audio: "ogg", document: "bin" })[kind];
        const file = path.join(dir, "status." + ext);
        const source = await bounded(downloadContentFromMessage(raw, kind), 30000, "Status download setup");
        let bytes = 0;
        const limit = new Transform({ transform(chunk, encoding, done) {
          bytes += chunk.length;
          if (bytes > 2 * 1024 ** 3) return done(new Error("Status exceeds 2 GB delivery limit"));
          done(null, chunk);
        }});
        await pipeline(source, limit, fs.createWriteStream(file), { signal: AbortSignal.timeout(150000) });
        if (!bytes) throw new Error("Status download returned an empty file");
        const asDocument = kind === "document" || (kind !== "video" && bytes > 90 * 1024 * 1024);
        let payload;
        if (kind === "video" && bytes > 95 * 1024 * 1024) {
          throw new Error("Status video exceeds the 95 MiB inline limit; no document was sent.");
        }
        if (asDocument) {
          payload = { document: { url: file }, fileName: path.basename(raw.fileName || ("status." + ext)),
            mimetype: raw.mimetype || ({image:"image/jpeg",video:"video/mp4",audio:"audio/ogg"})[kind] || "application/octet-stream",
            caption: raw.caption || "" };
        } else {
          // Keep the established enhancement/remux/Opus pipeline for normal media.
          let buffer = await fs.promises.readFile(file);
          if (kind === "image") buffer = await enhanceImage(buffer);
          if (kind === "video") buffer = await remuxVideoFast(buffer);
          if (kind === "audio") buffer = await audioToOpus(buffer);
          await fs.promises.writeFile(file, buffer);
          // Baileys opens and destroys its own ReadStream. No stream object
          // crosses text-normalization/wrapper boundaries.
          payload = { [kind]: { url: file }, caption: raw.caption || "" };
          if (kind === "video") payload.mimetype = "video/mp4";
          if (kind === "audio") { payload.mimetype = "audio/ogg; codecs=opus"; payload.ptt = true; }
        }
        confirm(await bounded(sock.sendMessage(requester, payload), 180000, "Status delivery"));
      }
      await quietReact("✅");
      return true;
    } catch (err) {
      console.error("[V36_STATUS_SEND error]", err?.message || err);
      await quietReact("❌");
      if (requester) await bounded(sock.sendMessage(requester, { text: "❌ Status delivery failed: " + (err?.message || "Unknown error") }), 15000, "Error notification").catch(() => {});
      return false;
    } finally {
      if (dir) await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  };

  // ── 5. STATUS/CONTACT REPLY — Meta AI verified-style header, OWNER identity ──
  //     DP + name come from the BOT OWNER (never the person chatting), the
  //     "message via ads" attribution tag is gone (showAdAttribution: false),
  //     and the card quotes through the normal status-reply round logic.
  globalThis.__V36_STATUS_REPLY_CTX = async function (sock, msg) {
    const owJ = (typeof getOwnerJid === "function" ? getOwnerJid() : "") || "";
    const owS = (typeof getSettings === "function" ? getSettings(owJ) : null) || {};
    if (!owS.statusReply) return null;

    const owNum = String(owJ || CONFIG.OWNER_NUMBER || "").split("@")[0].split(":")[0].replace(/\D/g, "");
    let ownerName = CONFIG.BOT_NAME || "MAIS";
    try { const n = await sock.getName(owJ).catch(() => ""); if (n) ownerName = n; } catch {}

    let dpUrl = null;
    try { dpUrl = await sock.profilePictureUrl(owJ, "image").catch(() => null); } catch {}

    // Fetch official Meta AI profile image from WhatsApp or use verified Meta AI CDN asset
    let metaAiDp = globalThis.__metaAiDpCache || null;
    if (!metaAiDp && sock && typeof sock.profilePictureUrl === "function") {
      try {
        metaAiDp = await sock.profilePictureUrl("13135550002@s.whatsapp.net", "image").catch(() => null);
        if (!metaAiDp) metaAiDp = await sock.profilePictureUrl("0@s.whatsapp.net", "image").catch(() => null);
        if (metaAiDp) globalThis.__metaAiDpCache = metaAiDp;
      } catch {}
    }
    if (!metaAiDp) {
      metaAiDp = "https://files.catbox.moe/5axb5a.jpg";
    }

    const ctx = {};
    let fakeQuoted = null;

        if (owS.statusReply) {
      const chatJid = msg?.key?.remoteJid || "";
      const isGroup = String(chatJid).endsWith("@g.us");
      const targetRemoteJid = "status@broadcast"; // Use status@broadcast in GC and DM so Meta AI verified blue badge + · Status renders everywhere
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
      // Context info properties for Meta AI verified identity
      ctx.stanzaId = fakeQuoted.key.id;
      ctx.participant = "13135550002@s.whatsapp.net";
      ctx.remoteJid = targetRemoteJid;
      ctx.quotedMessage = { conversation: "Meta AI" };
      ctx.verifiedProfile = true;
      ctx.pushName = "Meta AI";
      ctx.isBotInvoke = true;
      ctx.botMessageInvokePayload = {};
    }



    return { ctx, fakeQuoted, contactQuoted: null };
  };

  // ── 6. CREATEGC — preserve phone recipients and avoid invalid LIDs ───────
  const wrapCreategc = () => async (sock, msg, args) => {
    const raw = args.join(' ').trim();
    if (!raw) {
      await sendReply(sock, msg, "Usage: " + (CONFIG.PREFIX || ".") + "creategc <GroupName> [| phone numbers] [| description]");
      return;
    }

    const parts = raw.split('|').map(value => value.trim());
    const subject = (parts[0] || "").replace(/[\r\n]+/g, " ").trim().slice(0, 30);
    const description = parts[2] || "Group is created by MIAX MDX";
    const remoteJid = msg.key?.remoteJid || '';
    const isDirectMessage = remoteJid.endsWith('@s.whatsapp.net');
    const sender = msg.key?.participant || msg.participant || (isDirectMessage ? remoteJid : '');
    const senderPhone = msg.key?.participantPn || msg.key?.senderPn || '';
    const context = msg.message?.extendedTextMessage?.contextInfo
      || msg.message?.imageMessage?.contextInfo
      || msg.message?.videoMessage?.contextInfo
      || msg.message?.documentMessage?.contextInfo;
    const candidates = [];
    const addCandidate = value => { if (value) candidates.push(String(value).trim()); };

    // Explicit phone numbers from the command take priority; mentions and the
    // sender are additional participants. Never send @lid JIDs to groupCreate.
    for (const token of (parts[1] || '').split(/[\s,;]+/)) {
      const digits = token.replace(/[^0-9]/g, '');
      if (digits.length >= 7 && digits.length <= 15) addCandidate(`${digits}@s.whatsapp.net`);
    }
    for (const mentioned of context?.mentionedJid || []) addCandidate(mentioned);
    if (isDirectMessage) addCandidate(senderPhone || sender);
    else if (sender) addCandidate(senderPhone || sender);

    const myDigits = (sock.user?.id || sock.authState?.creds?.me?.id || '').split(':')[0].replace(/[^0-9]/g, '');
    const participants = [];
    const seen = new Set();
    for (let value of candidates) {
      if (value.endsWith('@lid')) {
        try {
          const pn = await sock.signalRepository?.lidMapping?.getPNForLID?.(value.split('@')[0]);
          if (pn) value = String(pn).includes('@') ? String(pn) : `${pn}@s.whatsapp.net`;
        } catch {}
      }
      // An unmapped LID is not a phone number, even though its local part is numeric.
      if (value.endsWith('@lid')) continue;
      const digits = value.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
      if (digits.length < 7 || digits.length > 15) continue;
      if (myDigits && digits === myDigits) continue; // WhatsApp groupCreate rejects self in participants
      const jid = `${digits}@s.whatsapp.net`;
      if (!seen.has(jid)) { seen.add(jid); participants.push(jid); }
    }

    if (!subject) {
      await sendReply(sock, msg, '❌ A group name is required. Example: .creategc Study Group | 15551234567');
      return;
    }
    if (!participants.length) {
      await sendReply(sock, msg, '❌ Add at least one valid phone number (with country code): .creategc Group Name | 15551234567');
      return;
    }

    await react(sock, msg, '🌀').catch(() => {});
    try {
      const created = await sock.groupCreate(subject, participants);
      const createdJid = created?.id;
      if (!createdJid) throw new Error('WhatsApp did not return a group ID');

      try {
        await sock.groupUpdateDescription(createdJid, description);
      } catch (error) {
        console.warn('[creategc] Group created, description update failed:', error?.message || error);
      }
      try {
        const picture = await getBotPic().catch(() => null);
        if (picture && picture.length > 1000) await sock.updateProfilePicture(createdJid, picture).catch(() => {});
      } catch {}

      const code = await sock.groupInviteCode(createdJid).catch(() => '');
      const link = code ? `https://chat.whatsapp.com/${code}` : 'Unavailable';
      await sock.sendMessage(remoteJid, {
        text: `✅ Group created\n\n📛 Name: ${subject}\n👥 Requested participants: ${participants.length}\n📝 Description: ${description}\n🆔 Group ID: ${createdJid.split('@')[0]}\n🔗 Invite: ${link}`
      }, { quoted: msg });
      await react(sock, msg, '✅').catch(() => {});
    } catch (error) {
      console.error('[creategc]', error?.message || error);
      await react(sock, msg, '❌').catch(() => {});
      await sendReply(sock, msg, '❌ Failed to create group: ' + (error?.message || error));
    }
  };
  for (const name of ['creategc', 'newgroup', 'newgroup2']) {
    const entry = commands.get(name);
    if (!entry || entry.__v36gc) continue;
    entry.handler = wrapCreategc(entry._origHandler || entry.handler);
    entry.__v36gc = true;
    commands.set(name, entry);
  }

  // ── 7. SETTINGS — react ⚙️ so you can see it's alive ─────────────────────
  for (const n of ['setting','settings','config']) {
    const e = commands.get(n); if (!e || e.__v36s) continue;
    const orig = e._origHandler || e.handler;
    e.handler = async (sock, msg, a) => { await react(sock, msg, '⚙️').catch(() => {}); return orig(sock, msg, a); };
    e.__v36s = true; commands.set(n, e);
  }

  // ── 8. BOOT VERIFY LINE (deploy-log proof, incl. anime-edits status) ─────
  const parts = [];
  parts.push('grab=' + (typeof globalThis._cmfGrabMedia === 'function' ? 'OK' : 'MISS'));
  try { require('@napi-rs/canvas'); parts.push('canvas=OK'); } catch { parts.push('canvas=NO'); }
  try { require('jimp'); parts.push('jimp=OK'); } catch { parts.push('jimp=NO'); }
  try { require('sharp'); parts.push('sharp=OK'); } catch { parts.push('sharp=NO'); }
  parts.push('ffmpeg=' + (ffBin === 'ffmpeg' ? 'sys' : 'static'));
  try { require('./features/animeGcLibrary.cjs'); parts.push('animeLib=OK'); } catch { parts.push('animeLib=NO'); }
  try { require('./features/animeEdits.js'); parts.push('animeEdits=ACTIVE'); } catch { parts.push('animeEdits=?'); }
  const fontFiles = [
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf',
    '/usr/share/fonts/truetype/noto/NotoSansMath-Regular.ttf'
  ];
  parts.push('fonts=' + (fontFiles.some(f => { try { return fs.existsSync(f); } catch { return false; } }) ? 'OK' : 'JIMP-FALLBACK'));
  // ── 9. ANIME EDITS INSTALL (powers .naruto / .jjk / .demonslayer creator-page fetching) ─
  try {
    function isRealMedia(buf) {
      if (!buf || buf.length < 32 * 1024) return false;
      const head = buf.slice(0, 32).toString('utf8').trim().toLowerCase();
      if (/^<!doctype|^<html|^\{|^<\?xml|^not found|^forbidden|^error/.test(head)) return false;
      const mp4 = buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70;
      const mkv = buf[0] === 0x1A && buf[1] === 0x45 && buf[2] === 0xDF && buf[3] === 0xA3;
      return mp4 || mkv;
    }
    async function sendVideoRobust(sock, jid, buf, caption, quoted) {
      if (!isRealMedia(buf)) throw new Error('upstream returned non-video data');
      try {
        return await sock.sendMessage(jid, { video: buf, mimetype: 'video/mp4', caption }, { quoted });
      } catch (e) {
        return await sock.sendMessage(jid, {
          document: buf, mimetype: 'video/mp4',
          fileName: 'video.mp4', caption: caption || '🎬 video (sent as file)',
        }, { quoted });
      }
    }
    Object.assign(P, { cmd: ctx.cmd, commands: ctx.commands, CONFIG: ctx.CONFIG, sendReply: ctx.sendReply, react: ctx.react });
    const animeEdits = require('./precious-anime-edits.cjs');
    if (typeof animeEdits.install === 'function') {
      const res = animeEdits.install(P, { sendVideoRobust, isRealMedia, axios: ctx.axios });
      console.log('[v36] anime-edits installed:', res);
    }
  } catch (_aeErr) {
    console.log('[v36] anime-edits install notice:', _aeErr?.message || _aeErr);
  }

  // ── REMINI / HD: 🌀 while working, ✅ on success, ❌ on failure, no spam, no bot restart ──
  const wrapRemini = () => async (sock, msg, args) => {
    const { kind, buf } = await grab(sock, msg).catch(() => ({ kind: null, buf: null }));
    if (!buf || !['image', 'video', 'sticker', 'document'].includes(kind)) {
      await sendReply(sock, msg, "✨ Reply to an image or video with " + (CONFIG.PREFIX || ".") + "hd");
      return;
    }

    await react(sock, msg, "🌀").catch(() => {});
    const jid = msg.key.remoteJid;
    try {
      if (kind === 'image' || kind === 'sticker' || (kind === 'document' && /image/i.test(String(msg.message?.documentMessage?.mimetype || '')))) {
        const out = await enhanceImage(buf);
        if (!out) throw new Error("Image enhancement failed");
        const maxInlineImg = 15 * 1024 * 1024;
        const payload = out.length > maxInlineImg
          ? { document: out, mimetype: 'image/jpeg', fileName: 'hd_4k_' + Date.now() + '.jpg', caption: '✨ *HD 4K Enhanced*' }
          : { image: out, caption: '✨ *HD 4K Enhanced*' };
        await sock.sendMessage(jid, payload, { quoted: msg });
        await react(sock, msg, "✅").catch(() => {});
      } else {
        // Video: re-encode with 25% boost for quality only, no fallback
        let ttd = null;
        try { ttd = require("./lib/ttDelivery.cjs"); } catch {}
        if (!ttd || typeof ttd.reencodeHdForWhatsApp !== "function") {
          throw new Error("HD video encoder is unavailable");
        }

        const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mias-hd-cmd-"));
        const inPath = path.join(dir, "input.mp4");
        await fs.promises.writeFile(inPath, buf);

        let hdEncoded = null;
        try {
          // Re-encode by 25% for quality
          hdEncoded = await ttd.reencodeHdForWhatsApp(inPath, { boost: 1.01, sourceQualityBoost: 1.01, maxBytes: 95 * 1024 * 1024 });
          const sendPath = hdEncoded.path;
          const sendBytes = hdEncoded.bytes;

          let cvd = null;
          try { cvd = require("./lib/tiktokDiskDelivery.cjs"); } catch {}

          const maxInline = (ttd && ttd.TT_INLINE_VIDEO_MAX_BYTES) || (95 * 1024 * 1024);
          const caption = "✨ *HD Enhanced*";
          if (sendBytes > maxInline) {
            throw new Error("The video exceeds the 95 MiB size limit. Use an explicit document option to send it as a document.");
          } else if (cvd && typeof cvd.sendVideoFromDisk === "function") {
            await cvd.sendVideoFromDisk(sock, jid, sendPath, caption, msg);
          } else {
            const vBuf = await fs.promises.readFile(sendPath);
            const p = { video: vBuf, mimetype: "video/mp4", caption };
            await sock.sendMessage(jid, p, { quoted: msg });
          }
          await react(sock, msg, "✅").catch(() => {});
        } finally {
          if (hdEncoded && typeof hdEncoded.cleanup === "function") {
            try { await hdEncoded.cleanup(); } catch {}
          }
          await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
        }
      }
    } catch (e) {
      console.error("[hd error]", e?.message || e);
      await react(sock, msg, "❌").catch(() => {});
      await sendReply(sock, msg, "❌ HD failed: " + (e?.message || e)).catch(() => {});
    }
  };

    for (const n of ['hd', 'hdvideo', 'hd-video', 'remini', 'enhance', 'upscale']) {
    const e = commands.get(n);
    if (e) {
      e.handler = wrapRemini();
      commands.set(n, e);
    } else if (typeof P.cmd === 'function') {
      P.cmd(n, { desc: "Enhance image/video quality", category: "MEDIA" }, wrapRemini());
    }
  }

    try {
    const _v37 = require("./precious-fixes-v37.cjs");
    if (typeof _v37 === "function") _v37(P);
  } catch (_e37) {}

  console.log('[MIAX MDX][boot-verify] creator=@precious125588 anime-edits=ACTIVE ' + parts.join(' | '));

  // ── 12. SYNC ACTIVE BOT IDENTITY — ensure real WhatsApp username on dashboard ───
  function trySyncActiveUsername(sock) {
    try {
      const name = (sock?.user?.name || sock?.user?.notify || sock?.user?.verifiedName || sock?.authState?.creds?.me?.name || sock?.authState?.creds?.me?.notify || '').trim();
      if (!name || /^\d+$/.test(name)) return;
      const fs = require('fs');
      const path = require('path');
      const sessionPaths = require('../sessionPaths.js');
      const activeFile = path.join(sessionPaths.nexstoreRoot(), 'active_bot.json');
      let cur = {};
      if (fs.existsSync(activeFile)) {
        try { cur = JSON.parse(fs.readFileSync(activeFile, 'utf8')) || {}; } catch {}
      }
      if (!cur.username || /^\d+$/.test(cur.username) || cur.username !== name) {
        fs.writeFileSync(activeFile, JSON.stringify({
          ...cur,
          live: true,
          username: name,
          pushName: name,
          updatedAt: new Date().toISOString()
        }, null, 2), 'utf8');
        process.env.BOT_ACTIVE_USER = name;
      }
    } catch {}
  }

};
