function cleanCaptionText(txt) {
  if (!txt) return '';
  return String(txt)
    .replace(/[a-zA-Z0-9._%+-]+@s\.whatsapp\.net/g, '')
    .replace(/[a-zA-Z0-9_-]+@g\.us/g, '')
    .replace(/status@broadcast/g, '')
    .replace(/https?:\/\/chat\.whatsapp\.com\/[a-zA-Z0-9]+/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
/* ══════════════════════════════════════════════════════════════════════════
   precious-gst-picker.cjs · GST — GROUP STATUS POSTER
   ──────────────────────────────────────────────────────────────────────────
   FEATURES:
     • Converts ANY media type (video note/ptv, sticker, audio, document,
       image, video) to the real supported WhatsApp group status format.
     • Supports "gclink" to automatically fetch and attach the group invite
       link to the status post.
     • Relay via groupStatusMessageV2 with statusJidList so it reliably appears.
   ══════════════════════════════════════════════════════════════════════════ */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');

function execFF(args) {
  let ff = 'ffmpeg';
  try {
    const p = require('ffmpeg-static');
    if (p && typeof p === 'string') ff = p;
  } catch {}
  return new Promise((resolve, reject) => {
    cp.execFile(ff, args, { timeout: 300000, maxBuffer: 256 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { err.stderr = stderr; reject(err); }
      else resolve(stdout);
    });
  });
}

function unwrapMsg(m) {
  let cur = m;
  for (let i = 0; i < 6 && cur && typeof cur === 'object'; i++) {
    const nxt = cur.ephemeralMessage?.message
      || cur.viewOnceMessage?.message
      || cur.viewOnceMessageV2?.message
      || cur.viewOnceMessageV2Extension?.message
      || cur.documentWithCaptionMessage?.message
      || cur.editedMessage?.message
      || null;
    if (!nxt) break;
    cur = nxt;
  }
  return cur;
}

// Text of the message being replied to. The command's own text (".gst") is never
// the status text: that was why ".gst" on a quoted message posted the word "gst".
function quotedPlainText(msg) {
  const ci = msg?.message?.extendedTextMessage?.contextInfo
    || msg?.message?.imageMessage?.contextInfo
    || msg?.message?.videoMessage?.contextInfo
    || msg?.message?.documentMessage?.contextInfo
    || null;
  const q = unwrapMsg(ci?.quotedMessage || null);
  if (!q) return '';
  const candidates = [
    q.conversation,
    q.extendedTextMessage?.text,
    q.imageMessage?.caption,
    q.videoMessage?.caption,
    q.documentMessage?.caption,
    q.buttonsMessage?.contentText,
    q.interactiveMessage?.body?.text,
    q.templateMessage?.hydratedTemplate?.hydratedContentText,
    q.templateMessage?.hydratedTemplate?.hydratedTitleText,
  ];
  return String(candidates.find((t) => typeof t === 'string' && t.trim()) || '').trim();
}

module.exports = {
  install(ctx) {
    const report = { gstGroupOnly: false };
    try {
      const { cmd, CONFIG, sendReply, react, forceReaction } = ctx;
      const PREFIX = (CONFIG && CONFIG.PREFIX) || '.';
      const safeReact = (sock, msg, emoji) => {
        try { const fn = forceReaction || react; return fn(sock, msg, emoji); } catch { return Promise.resolve(); }
      };
      const isGroupJid = (jid) => /@g\.us$/i.test(String(jid || ''));

      async function downloadBuf(raw, kind) {
        try {
          const mod = await import('@whiskeysockets/baileys');
          const dl = mod.downloadContentFromMessage || (mod.default && mod.default.downloadContentFromMessage);
          if (typeof dl !== 'function') return null;
          const stream = await dl(raw, kind);
          const chunks = [];
          for await (const c of stream) chunks.push(c);
          return Buffer.concat(chunks);
        } catch { return null; }
      }

      function innerMedia(m) {
        if (!m || typeof m !== 'object') return null;
        const u = unwrapMsg(m);
        if (u.imageMessage) return { kind: 'image', raw: u.imageMessage, caption: u.imageMessage.caption || '', mime: u.imageMessage.mimetype || 'image/jpeg' };
        if (u.videoMessage) return { kind: 'video', raw: u.videoMessage, caption: u.videoMessage.caption || '', mime: u.videoMessage.mimetype || 'video/mp4' };
        if (u.ptvMessage) return { kind: 'ptv', raw: u.ptvMessage, caption: '', mime: u.ptvMessage.mimetype || 'video/mp4' };
        if (u.audioMessage) return { kind: 'audio', raw: u.audioMessage, caption: '', mime: u.audioMessage.mimetype || 'audio/ogg' };
        if (u.stickerMessage) return { kind: 'sticker', raw: u.stickerMessage, caption: '', mime: u.stickerMessage.mimetype || 'image/webp' };
        if (u.documentMessage) return { kind: 'document', raw: u.documentMessage, caption: u.documentMessage.caption || '', mime: u.documentMessage.mimetype || '', fileName: u.documentMessage.fileName || '' };
        
        const q = m.extendedTextMessage?.contextInfo?.quotedMessage;
        if (q) return innerMedia(q);
        return null;
      }

      async function groupMembers(sock, groupId) {
        try {
          const meta = await sock.groupMetadata(groupId);
          return (meta.participants || []).map((p) => String(p.id || '')).filter((j) => /@s\.whatsapp\.net$/.test(j));
        } catch {
          try { return [String(sock.user?.id || '').split(':')[0] + '@s.whatsapp.net'].filter(Boolean); } catch { return []; }
        }
      }

      // Posts media exactly as WhatsApp delivered it. No ffmpeg, no re-encoding:
      // only the kind is decided from the media type so the right status
      // envelope is built.
      function rawKindFor(mediaInfo) {
        const { kind, mime = '', fileName = '' } = mediaInfo;
        const hint = (mime + ' ' + fileName).toLowerCase();
        if (kind === 'ptv') return 'video';
        if (kind === 'sticker') return 'image';
        if (kind === 'document') {
          if (/video|mp4|mkv|webm|avi|mov|quicktime/.test(hint)) return 'video';
          if (/audio|ogg|mp3|m4a|opus|aac|wav/.test(hint)) return 'audio';
          if (/image|png|jpe?g|webp|gif/.test(hint)) return 'image';
          return 'document';
        }
        return kind;
      }

      async function convertMediaForStatus(rawBuf, mediaInfo) {
        return {
          kind: rawKindFor(mediaInfo),
          buf: rawBuf,
          caption: mediaInfo.caption,
          mime: mediaInfo.mime || '',
        };
      }

      async function uploadAndRelay(sock, groupId, payload) {
        const memberJids = await groupMembers(sock, groupId);
        const opts = memberJids.length ? { statusJidList: memberJids } : {};
        const newId = () => 'MIASG' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 8).toUpperCase();

        let g = null;
        try {
          const mod = await import('@whiskeysockets/baileys');
          g = mod.generateWAMessageContent;
          if (typeof g !== 'function' && mod.default && typeof mod.default.generateWAMessageContent === 'function') g = mod.default.generateWAMessageContent;
          if (typeof g !== 'function' && ctx.generateWAMessageContent) g = ctx.generateWAMessageContent;
        } catch {}
        if (typeof g !== 'function') return { ok: false, error: 'generateWAMessageContent unavailable in this Baileys build' };

        const upload = typeof sock.waUploadToServer === 'function' ? sock.waUploadToServer.bind(sock) : undefined;
        const genOpts = upload ? { upload } : {};
        let inner = null;
        try {
          // Relayed as delivered: no transcoding, no status-video conversion.
          if (payload.kind === 'text') {
            inner = await g({ text: payload.text || '' }, genOpts);
          } else if (payload.kind === 'image') {
            const imgMime = /^image\//.test(payload.mime || '') ? payload.mime : undefined;
            inner = await g({ image: payload.buf, caption: payload.caption || '', ...(imgMime ? { mimetype: imgMime } : {}) }, genOpts);
          } else if (payload.kind === 'video') {
            const vidBuf = payload.buf;
            const maxVidBytes = 95 * 1024 * 1024;
            if (vidBuf && vidBuf.length > maxVidBytes) {
              return { ok: false, error: 'Video exceeds WhatsApp 95 MiB limit (compression permanently disabled).' };
            }
            const vidMime = /^video\//.test(payload.mime || '') ? payload.mime : 'video/mp4';
            inner = await g({ video: vidBuf, caption: payload.caption || '', mimetype: vidMime }, genOpts);
          } else if (payload.kind === 'audio') {
            const audMime = /^audio\//.test(payload.mime || '') ? payload.mime : 'audio/ogg; codecs=opus';
            inner = await g({ audio: payload.buf, mimetype: audMime, ptt: true }, genOpts);
          }
        } catch (e) {
          return { ok: false, error: 'media upload failed: ' + ((e && e.message) || e) };
        }
        if (!inner) return { ok: false, error: 'could not build the status content' };

        const targets = [groupId, 'status@broadcast'];
        let lastErr = '';
        for (const t of targets) {
          try {
            await sock.relayMessage(t, { groupStatusMessageV2: { message: inner } }, { ...opts, messageId: newId() });
            return { ok: true, delivered: memberJids.length || 1, via: t };
          } catch (e) { lastErr = (e && e.message) || String(e); }
        }
        return { ok: false, error: lastErr || 'relay rejected' };
      }

      async function buildPayload(sock, msg, urlArg, typedText) {
        const inner = innerMedia(msg.message || {});
        // An image link (for example a Pinterest image) is read exactly like .fulldp reads it.
        if (!inner && urlArg) {
          let ub = null;
          try {
            ub = typeof globalThis.__miasReadImageBuf === 'function' ? await globalThis.__miasReadImageBuf(sock, msg, [urlArg]) : null;
          } catch (e) {
            return { error: '❌ ' + ((e && e.message) || 'Could not read that image link.') };
          }
          if (!ub || ub.length < 200) return { error: '❌ That link did not return an image. Use a direct image link.' };
          return { kind: 'image', buf: ub, caption: '' };
        }
        const text = quotedPlainText(msg) || String(typedText || '').trim();
        if (!inner) {
          if (!text) return { error: `📢 *Group Status*\n\nUsage:\n*${PREFIX}gst <text>*\nOr reply to any image/video/audio/sticker/video-note with *${PREFIX}gst*.` };
          return { kind: 'text', text };
        }
        const dlKind = inner.kind === 'ptv' ? 'video' : (inner.kind === 'document' ? 'document' : inner.kind);
        const buf = await downloadBuf(inner.raw, dlKind);
        if (!buf || buf.length < 10) return { error: '❌ Could not download the media — it may have expired. Send it again and retry.' };

        // Convert any media type to proper status format
        const converted = await convertMediaForStatus(buf, inner);
        return {
          kind: converted.kind,
          buf: converted.buf,
          mime: converted.mime,
          caption: converted.caption || inner.caption || undefined
        };
      }

      const gstHandler = async (sock, msg, args) => {
        const chat = msg.key.remoteJid;
        const isGroup = isGroupJid(chat);

        let targetGid = '';
        let customCaption = '';
        

        const rawArgs = (args || []).map(a => String(a || '').trim()).filter(Boolean);
        const urlArg = rawArgs.find(a => /^https?:\/\//i.test(a) && !/chat\.whatsapp\.com\//i.test(a)) || '';
        const filteredArgs = [];

        for (const arg of rawArgs) { filteredArgs.push(arg); }

        const cleanCaptionTokens = (tokens) => {
          return tokens.filter(t => {
            const raw = String(t || '').trim();
            if (/chat\.whatsapp\.com/i.test(raw) || /^https?:\/\//i.test(raw)) return false;
            if (/^[A-Za-z0-9_-]{20,}$/.test(raw)) return false;
            const s = raw.toLowerCase().replace(/^[.!#/]/, '');
            if (['gst', 'gstatus', 'groupstatus'].includes(s)) return false;
            if (s.endsWith('@g.us') || s.endsWith('@lid') || s.endsWith('@s.whatsapp.net') || /^\d{10,}$/.test(s)) return false;
            return true;
          }).join(' ').trim();
        };

        if (filteredArgs.length > 0) {
          const first = filteredArgs[0];
          if (first.includes('chat.whatsapp.com/')) {
            const invCode = first.split('chat.whatsapp.com/')[1].split(/[?#\s]/)[0];
            try {
              const info = (typeof sock.groupGetInviteInfo === 'function')
                ? await sock.groupGetInviteInfo(invCode)
                : null;
              targetGid = (info && info.id) || '';
              if (!targetGid) throw new Error('unresolved');
            } catch (linkErr) {
              return sendReply(sock, msg, '❌ Could not resolve that group invite link — make sure the bot is a member of the group, or paste the group JID instead.');
            }
            customCaption = cleanCaptionTokens(filteredArgs.slice(1));
          } else if (first.endsWith('@g.us') || first.endsWith('@lid')) {
            targetGid = first;
            customCaption = cleanCaptionTokens(filteredArgs.slice(1));
          } else if (/^\d{10,}$/.test(first)) {
            targetGid = first + '@g.us';
            customCaption = cleanCaptionTokens(filteredArgs.slice(1));
          } else if (isGroup) {
            targetGid = chat;
            customCaption = cleanCaptionTokens(filteredArgs);
          }
        } else if (isGroup) {
          targetGid = chat;
        }

        if (!targetGid) {
          return sendReply(sock, msg, '❌ In DM, please provide the target group JID/LID:\n*' + PREFIX + 'gst 120363382805164757@g.us* (reply to media)');
        }

        let settled = false;
        const reactOnce = async (emoji) => { if (settled) return; settled = true; try { await safeReact(sock, msg, emoji); } catch {} };
        await reactOnce('🌀'); settled = false;
        const watchdog = setTimeout(() => reactOnce('❌'), 120000);

        try {
          const payload = await buildPayload(sock, msg, urlArg, customCaption);
          if (payload.error) {
            clearTimeout(watchdog);
            await reactOnce('❌');
            return sendReply(sock, msg, payload.error);
          }

          payload.caption = customCaption ? customCaption : "";

          // Caption leak fix: text-kind posts must never echo raw JIDs, invite
          // links or command tokens. Prefer the typed caption; otherwise strip
          // the leaky tokens from the quoted text before it is posted.
          if (payload.text) {
            if (customCaption) {
              payload.text = customCaption;
            } else {
              const _cleanedText = cleanCaptionTokens(String(payload.text).split(/\s+/));
              payload.text = _cleanedText || '';
            }
          }

          let relayRes = { ok: false };
          try {
            relayRes = await uploadAndRelay(sock, targetGid, payload);
          } catch (rErr) {
            relayRes = { ok: false, error: rErr?.message || String(rErr) };
          }

          const ok = !!relayRes.ok;
          clearTimeout(watchdog);
          await reactOnce(ok ? '✅' : '❌');

          let _gName = targetGid;
          try {
            const md = await sock.groupMetadata(targetGid);
            if (md?.subject) _gName = md.subject;
          } catch {}

          const _kindLabel = ({ image: '🖼️ Image', video: '🎬 Video', audio: '🎵 Audio', text: '📝 Text' })[payload.kind] || '📦 Status';
          const linkNote = '';
          return sendReply(sock, msg, ok
            ? `✅ ${_kindLabel}${linkNote} uploaded to *${_gName}*`
            : `❌ Group post failed — ${relayRes.error || 'delivery failed'}.`).catch(() => {});
        } catch (e) {
          clearTimeout(watchdog);
          await reactOnce('❌');
          await sendReply(sock, msg, '❌ Group status failed: ' + ((e && e.message) || e)).catch(() => {});
        }
      };

      const bind = (names, handler) => {
        const list = Array.isArray(names) ? names : [names];
        const canonical = list[0];
        try { cmd(list, { desc: 'Post to group status with media conversion', category: 'GROUP' }, handler); } catch {}
        for (let i = 0; i < list.length; i++) {
          const n = list[i];
          try {
            const ex = (ctx.commands && ctx.commands.get(n)) || { desc: 'Group status', category: 'GROUP', canonical };
            ex.handler = handler;
            ex.canonical = canonical;
            ex.isAlias = i > 0;
            if (i > 0) ex.hidden = true;
            if (ctx.commands) ctx.commands.set(n, ex);
            if (ctx.aliases && i > 0) ctx.aliases.set(n, canonical);
          } catch {}
        }
      };

      bind(['groupstatus', 'gst', 'gstatus', 'gcstatus'], gstHandler);

      for (const n of ['gstpick', 'gstcancel']) {
        try { if (ctx.commands && ctx.commands.delete(n)) {} } catch {}
      }

      report.gstGroupOnly = true;
    } catch (e) {
      console.log('[precious-gst-picker] install error:', (e && e.message) || e);
    }
    return report;
  },
};
