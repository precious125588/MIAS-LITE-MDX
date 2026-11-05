// =========================================================================
//  precious-fixes-v24.cjs  ·  PRECIOUS v24 — THE BIG FIX PACK
// ─────────────────────────────────────────────────────────────────────────
//  Installs LAST from mias/index.js so it overrides every older handler.
//
//  Fixes delivered:
//   1. PLAY BUG: "❌ Unknown settings option *4*" after choosing from the
//      play card → picker consumption now runs BEFORE settings and wins
//      whenever a picker is pending or the quoted card is a picker card.
//   2. QUOTE-REPLY PICKERS for savetube / movie / nkiri / boost6 / ytmate:
//      numbered card + native flow buttons together; works on WhatsApp
//      builds that don't render native buttons (just quote-reply a number).
//   3. TT DEDUPE: quoting a TikTok link no longer auto-downloads; the
//      image-card picker is the ONLY route for every tt input form.
//   4. VIDEO FIX: play mp4 no longer gray/blank (audio bytes were being
//      sent as video). ytmate no longer "corrupted / unavailable" (HTML
//      error pages were sent as mp4). Every video is magic-byte sniffed.
//   5. GST KEPT GROUP-ONLY: .gst & aliases stay (GC status posts); only the DM picker logic is removed (v25).
//   6. SUDO rebuilt: profile-pic image card (bot image fallback), options
//      1 Add (DM only) / 2 Remove (everything incl. VIP) / 3 Sudo VIP,
//      native buttons embedded + quote-reply numbers; chat-aware targets.
//   7. FORWARD fixed: takes the number directly, forwards any message type.
//   8. PRIVATE BY DEFAULT: on connect the bot is locked private until the
//      owner runs .public.
//   9. ANIME EDITS: naruto/jjk/demonslayer/… commands (see
//      precious-anime-edits.cjs) — ☄️ react, 2 edits per request, no
//      repeats per user, rotating routes (zip links → pages → search).
// =========================================================================
'use strict';

const fs    = require('fs');
const path  = require('path');
const axios = require('axios');

// ────────────────────────── shared utilities ─────────────────────────────
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36' };

function unwrapMsg(m) {
  let cur = m || {};
  for (let i = 0; i < 10 && cur; i++) {
    const n = cur.ephemeralMessage?.message || cur.viewOnceMessage?.message
      || cur.viewOnceMessageV2?.message || cur.viewOnceMessageV2Extension?.message
      || cur.documentWithCaptionMessage?.message || cur.editedMessage?.message;
    if (!n) break;
    cur = n;
  }
  return cur || {};
}

function isRealMedia(buf) {
  if (!buf || buf.length < 32 * 1024) return false;
  const head = buf.slice(0, 32).toString('utf8').trim().toLowerCase();
  if (/^<!doctype|^<html|^\{|^<\?xml|^not found|^forbidden|^error/.test(head)) return false;
  const mp4 = buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70; // ftyp
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

async function sendAudioRobust(sock, jid, buf, title, quoted) {
  const isAudio = buf && buf.length > 32 * 1024 &&
    ((buf[0] === 0xFF && (buf[1] & 0xE0) === 0xE0) || buf.slice(0, 3).toString() === 'ID3' ||
     buf.slice(0, 4).toString() === 'OggS' || buf.slice(4, 8).toString() === 'ftyp');
  if (!isAudio) throw new Error('upstream returned non-audio data');
  return sock.sendMessage(jid, {
    audio: buf, mimetype: 'audio/mpeg', fileName: (title || 'audio').replace(/[^\w\s-]/g, '').slice(0, 60) + '.mp3',
  }, { quoted });
}

async function getJson(url, timeout = 20000) {
  const r = await axios.get(url, { headers: UA, timeout, validateStatus: () => true });
  if (r.status >= 400 || !r.data) return null;
  return typeof r.data === 'string' ? (() => { try { return JSON.parse(r.data); } catch { return null; } })() : r.data;
}
async function getBuf(url, timeout = 120000) {
  const r = await axios.get(url, { headers: UA, responseType: 'arraybuffer', timeout, maxContentLength: 700 * 1024 * 1024, validateStatus: () => true });
  if (r.status >= 400) return null;
  const b = Buffer.from(r.data || []);
  return b.length ? b : null;
}

// YouTube id extraction
function ytId(url) {
  const m = String(url || '').match(/(?:youtu\.be\/|v=|shorts\/|embed\/)([\w-]{11})/);
  return m ? m[1] : null;
}

// ── ytFindFirst: song NAME → YouTube URL (uses the bundled yt-search) ──────
async function ytFindFirst(query) {
  try {
    const yts = require('yt-search');
    const r = await yts(String(query || '').trim());
    const v = (r && r.videos && r.videos[0]) || (Array.isArray(r) ? r[0] : null);
    if (v && v.url) return v.url;
    if (v && v.videoId) return 'https://www.youtube.com/watch?v=' + v.videoId;
  } catch {}
  try {
    const r = await axios.get('https://www.youtube.com/results?search_query=' + encodeURIComponent(query), { headers: UA, timeout: 15000 });
    const m = String(r.data || '').match(/"videoId":"([A-Za-z0-9_-]{11})"/);
    if (m) return 'https://www.youtube.com/watch?v=' + m[1];
  } catch {}
  return null;
}

// V25-OK: ytDownload working providers
// Every candidate is magic-number checked. A candidate that returns an HTML
// error page, a JSON blob, or a file under 32 KB is REJECTED and the next
// provider is tried — this is what kills the old "video isn't available /
// file is corrupted" message, which was simply an error page sent as mp4.
async function ytDownload(url, mode /* 'audio'|'video' */, quality) {
  const id = ytId(url); const full = id ? ('https://youtu.be/' + id) : url;
  const q = String(quality || (mode === 'audio' ? '128' : '360'));
  const tries = [];

  // 1) the repo's own DavidCyril client, when the host exposed it
  try {
    const dc = (globalThis.__PRECIOUS__ && globalThis.__PRECIOUS__.dcGet) || globalThis.__MIAS_DC_GET__;
    if (typeof dc === 'function') {
      if (mode === 'audio') tries.push(async () => {
        const r = await dc('/download/ytmp3', { url: full }, 30000);
        const d = r && r.ok ? r.data : null;
        const u = d && (d.result && (d.result.download_url || d.result.url) || d.download_url || d.url);
        return u && { url: u, title: (d && d.result && d.result.title) || '' };
      });
      else tries.push(async () => {
        const r = await dc('/download/ytmp4', { url: full, quality: q }, 45000);
        const d = r && r.ok ? r.data : null;
        const u = d && (d.result && (d.result.download_url || d.result.url) || d.download_url || d.url);
        return u && { url: u, title: (d && d.result && d.result.title) || '' };
      });
    }
  } catch {}

  // 2) proven public mirrors kept from the working play pipeline
  if (mode === 'audio') {
    tries.push(
      async () => { const d = await getJson('https://api.nexoracle.com/downloader/ytmp3?apikey=free_key@maher_apis&url=' + encodeURIComponent(full)); const u = d?.result?.download_url || d?.result?.url || d?.download_url || d?.url; return u && { url: u, title: d?.result?.title }; },
      async () => { const d = await getJson('https://api.davidcyril.name.ng/download/ytmp3?url=' + encodeURIComponent(full)); const u = d?.result?.download_url || d?.result?.url || d?.download_url || d?.url; return u && { url: u, title: d?.result?.title }; },
      async () => { const d = await getJson('https://api.princetechn.com/api/download/ytmp3?apikey=prince&url=' + encodeURIComponent(full)); const u = d?.result?.download_url || d?.result?.url; return u && { url: u, title: d?.result?.title }; },
    );
  } else {
    tries.push(
      async () => { const d = await getJson('https://api.nexoracle.com/downloader/ytmp4?apikey=free_key@maher_apis&url=' + encodeURIComponent(full)); const u = d?.result?.download_url || d?.result?.url || d?.download_url || d?.url; return u && { url: u, title: d?.result?.title }; },
      async () => { const d = await getJson('https://api.davidcyril.name.ng/download/ytmp4?url=' + encodeURIComponent(full) + '&quality=' + encodeURIComponent(q)); const u = d?.result?.download_url || d?.result?.url || d?.download_url || d?.url; return u && { url: u, title: d?.result?.title }; },
      async () => { const d = await getJson('https://api.princetechn.com/api/download/ytmp4?apikey=prince&url=' + encodeURIComponent(full)); const u = d?.result?.download_url || d?.result?.url; return u && { url: u, title: d?.result?.title }; },
    );
  }

  // 3) the exact provider chain the working .play command uses, when exposed
  try {
    const p2 = (mode === 'video' && globalThis.__MIAS_P2_VIDEO_BUF__) || (mode === 'audio' && globalThis.__MIAS_P2_AUDIO_BUF__);
    if (typeof p2 === 'function') {
      tries.push(async () => {
        const buf = await p2({ title: '', videoId: id || '', videoUrl: full }, q);
        return buf && { url: null, buf };
      });
    }
  } catch {}

  for (const t of tries) {
    try {
      const r = await t();
      if (!r) continue;
      if (r.buf) { if (isRealMedia(r.buf) || (mode === 'audio' && isAudioBuf(r.buf))) return { buf: r.buf, title: r.title || '' }; continue; }
      if (!r.url) continue;
      const buf = await getBuf(r.url);
      if (mode === 'audio') { if (isAudioBuf(buf)) return { buf, title: r.title || '' }; }
      else if (buf && isRealMedia(buf)) return { buf, title: r.title || '' };
    } catch {}
  }
  return null;
}

// Real audio check (mp3/m4a/ogg/opus/wav) — the old code only sniffed video,
// so some audio providers returned HTML that was then sent as a "song".
function isAudioBuf(buf) {
  if (!buf || buf.length < 32 * 1024) return false;
  const head = buf.slice(0, 40).toString('utf8').trim().toLowerCase();
  if (/^<!doctype|^<html|^\{|^<\?xml|^not found|^forbidden|^error/.test(head)) return false;
  if (buf.slice(0, 3).toString('ascii') === 'ID3') return true;
  if (buf[0] === 0xFF && (buf[1] & 0xE0) === 0xE0) return true;
  if (buf.slice(0, 4).toString('ascii') === 'OggS') return true;
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WAVE') return true;
  if (buf.slice(4, 8).toString('ascii') === 'ftyp') return true; // m4a
  return false;
}

// ── picker store (per-chat, quoted-key aware) ─────────────────────────────
const PICKERS = new Map(); // jid -> [{key, stanzaId, options, onPick, label, ts}]
const PICKER_TTL = 10 * 60 * 1000;

function pickKeyOf(jid) {
  const arr = (PICKERS.get(jid) || []).filter(p => Date.now() - p.ts < PICKER_TTL);
  if (arr.length) PICKERS.set(jid, arr); else PICKERS.delete(jid);
  return arr;
}
function hasPendingPicker(jid) { return pickKeyOf(jid).length > 0; }

function registerPicker(jid, sent, options, onPick, label) {
  const stanzaId = sent?.key?.id || '';
  const participant = sent?.key?.participant || sent?.key?.remoteJid || '';
  const arr = pickKeyOf(jid);
  arr.push({ key: `${participant}::${stanzaId}`, stanzaId, options, onPick, label, ts: Date.now() });
  PICKERS.set(jid, arr);
  setTimeout(() => { // auto-expire
    const cur = pickKeyOf(jid).filter(p => Date.now() - p.ts < PICKER_TTL);
    if (cur.length) PICKERS.set(jid, cur); else PICKERS.delete(jid);
  }, PICKER_TTL + 1000).unref?.();
}

  function consumePicker(jid, msg, body) {
    const arr = pickKeyOf(jid);
    if (!arr.length) return null;
    // [SUDO-QUOTE] diagnostics — a quote-reply to a SUDO image card must never
    // die silently: log detection + quoted type + stanza id (no content logged).
    try {
      const _sqc = msg?.message?.extendedTextMessage?.contextInfo;
      const _sqm = _sqc?.quotedMessage;
      if (_sqm && (_sqm.imageMessage || _sqm.videoMessage || _sqm.interactiveMessage)) {
        const _sqCap = String(_sqm.imageMessage?.caption || _sqm.videoMessage?.caption || _sqm.interactiveMessage?.body?.text || '');
        if (/SUDO/i.test(_sqCap)) {
          console.log('[SUDO-QUOTE] reply detected');
          console.log('[SUDO-QUOTE] quoted type: ' + (_sqm.imageMessage ? 'imageMessage' : _sqm.videoMessage ? 'videoMessage' : 'interactiveMessage'));
          console.log('[SUDO-QUOTE] quoted ID: ' + (_sqc.stanzaId || ''));
        }
      }
    } catch {}
  const choice = String(body || '').trim().replace(/^[.*_~\s>]+/, '');
  if (!/^\d{1,2}$/.test(choice)) {
    const _qctx = msg?.message?.extendedTextMessage?.contextInfo
      || msg?.message?.imageMessage?.contextInfo
      || msg?.message?.videoMessage?.contextInfo || null;
    // INVALID QUOTE GUARD: the user quoted one of our cards but typed something
    // that is not one of its numbers — answer "invalid quote" instead of letting
    // the settings table leak "Unknown settings option" (or going silent).
    // only if the quoted message IS one of our pending picker cards — otherwise
    // a plain quoted text (e.g. quoting a caption and typing .tovid) must NOT
    // trigger the guard (that was eating real commands).
    const _qId = _qctx?.stanzaId || _qctx?.id || "";
    // If quoting a player/audio card, let player dispatcher take it
    const _qTxt = String(_qctx?.quotedMessage?.conversation || _qctx?.quotedMessage?.extendedTextMessage?.text || _qctx?.quotedMessage?.imageMessage?.caption || "");
    if (/PLAYER/i.test(_qTxt) || /reply with a number/i.test(_qTxt) || /1\s*-\s*Audio/i.test(_qTxt)) {
      return null;
    }
    const _matchesCard = arr.some(p => p?.sent?.key?.id && p.sent.key.id === _qId);
    if (_matchesCard && arr.length) {
      const _last = arr[arr.length - 1];
      return { invalid: true, total: _last?.options?.length || 0, invalidQuote: true };
    }
    return null;
  }
  const n = parseInt(choice, 10);
  // quoted-key match first
  const ctx = msg?.message?.extendedTextMessage?.contextInfo
    || msg?.message?.imageMessage?.contextInfo
    || msg?.message?.videoMessage?.contextInfo || null;
  let picked = null;
  if (ctx?.stanzaId) {
    const part = String(ctx.participant || '').replace(/:\d+(?=@)/, '');
    picked = arr.find(p => p.stanzaId === ctx.stanzaId || p.key === `${part}::${ctx.stanzaId}`) || null;
  }
  if (!picked) picked = arr[arr.length - 1]; // most recent pending picker
  if (!picked || n < 1 || n > picked.options.length) return { invalid: true, total: picked ? picked.options.length : 0 };
  // consume it
  const rest = (PICKERS.get(jid) || []).filter(p => p !== picked);
  if (rest.length) PICKERS.set(jid, rest); else PICKERS.delete(jid);
  return { picker: picked, n };
}

// ────────────────────────── main install ──────────────────────────────────
module.exports.install = function install(P) {
  const rep = {};
  const PFX = P.CONFIG.PREFIX || '.';

  // expose pending-picker probe to the settings guard — must OR together
  // EVERY picker store (ours, the legacy one, and the play-card _P2_PENDING)
  // or the settings consumer keeps answering "Unknown settings option *4*".
  const _prevHasPending = globalThis.__miasHasPendingPicker;
  globalThis.__miasHasPendingPicker = function (jid) {
    // V25-OK: play pending probe in guard
    // The play card stores its pending state by MESSAGE id, so the old probe
    // (which asked by CHAT jid) always answered false and a bare "4" fell
    // through to the settings consumer → "❌ Unknown settings option *4*".
    try { if (typeof globalThis.__miasPlayPending === 'function' && globalThis.__miasPlayPending(jid)) return true; } catch {}
    try { if (hasPendingPicker(jid)) return true; } catch {}
    try { if (typeof _prevHasPending === 'function' && _prevHasPending(jid)) return true; } catch {}
    try {
      const p2 = globalThis.__PRECIOUS__ && globalThis.__PRECIOUS__._P2_PENDING;
      if (p2 && typeof p2.get === 'function' && p2.get(jid)) return true;
      if (p2 && typeof p2.keys === 'function') {
        for (const k of p2.keys()) { if (String(k).startsWith(String(jid))) return true; }
      }
    } catch {}
    return false;
  };

  const helpers = { sendVideoRobust, sendAudioRobust, isRealMedia, ytDownload, getJson, getBuf };

  // ── helpers reused inside install scope ─────────────────────────────────
  async function botPic() {
    try { if (typeof P.getBotPic === 'function') { const b = await P.getBotPic(); if (b) return b; } } catch {}
    return null;
  }
  // V25-OK: hardened DP lookup
  // profilePictureUrl was called once with a raw JID. WhatsApp can hand the
  // same person as 234xxxxxxxxxx@s.whatsapp.net, 234xxxxxxxxxx:12@s.whatsapp.net
  // or an @lid, so one shot often missed and the card fell back to text. We now
  // try every identity form and both picture types before giving up.
  async function targetPic(sock, jid) {
    const raw = String(jid || '');
    const forms = [...new Set([
      raw,
      raw.replace(/:\d+(?=@)/, ''),
      raw.split('@')[0].replace(/[^0-9]/g, '') ? raw.split('@')[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net' : '',
    ].filter(Boolean))];
    for (const f of forms) {
      for (const type of ['image', 'preview']) {
        try {
          const url = await sock.profilePictureUrl(f, type);
          if (url) { const b = await getBuf(url, 15000); if (b) return b; }
        } catch {}
      }
      try {
        const url = await sock.profilePictureUrl(f);
        if (url) { const b = await getBuf(url, 15000); if (b) return b; }
      } catch {}
    }
    return botPic(); // genuinely no DP → bot image card (never a blank card)
  }

  // card sender: image + numbered caption + native buttons together
  async function sendPickerCard(sock, jid, msg, { image, caption, title, rows }) {
    let sent = null;
    // native flow buttons embedded (best-effort — ignored when unsupported)
    if (rows && rows.length && typeof P.sendNativeFlowListMenu === 'function') {
      try {
        const sections = [{ title: title || 'Options', rows: rows.map((r, i) => ({ title: `${i + 1} ${r}`, rowId: `${PFX}pick ${i + 1}`, description: '' })) }];
        sent = await P.sendNativeFlowListMenu(sock, jid, msg, caption, sections, [], 'MAIS MDX', image ? { hasMediaAttachment: true, image } : undefined);
      } catch {}
    }
    if (!sent) {
      if (image) sent = await sock.sendMessage(jid, { image, caption }, { quoted: msg });
      else sent = await P.sendReply(sock, msg, caption);
    }
    return sent;
  }

  // ══════════════════════════════════════════════════════════════════════
  // 1) GLOBAL DISPATCH HOOK — picker digits before settings (play fix)
  //    We wrap the settings reply hook: when a picker is pending (or the
  //    quoted card is a picker card) we consume the digit FIRST.
  // ══════════════════════════════════════════════════════════════════════
  const prevSettingsHook = globalThis.__PRECIOUS_SETTINGS_REPLY__;
  globalThis.__PRECIOUS_SETTINGS_REPLY__ = async function (sock, msg, body) {
    const jid = msg?.key?.remoteJid;
    try {
      const hit = consumePicker(jid, msg, body);
      if (hit && hit.picker) {
        try { console.log('[SUDO-QUOTE] handler matched'); } catch {}
        try { await hit.picker.onPick(sock, msg, hit.n); console.log('[SUDO-QUOTE] response sent'); } catch (e) {
          try { console.error('[SUDO-QUOTE] failed: ' + (e?.message || e)); } catch {}
          await P.sendReply(sock, msg, `❌ Failed: ${e?.message || e}`).catch(() => {});
        }
        return true;
      }
      if (hit && hit.invalid) {
        await P.sendReply(sock, msg, hit.invalidQuote
          ? `❌ Invalid quote — reply with a number from the card you quoted (1–${hit.total}).`
          : `❌ Invalid quote — pick a number between *1* and *${hit.total}*.`).catch(() => {});
        return true;
      }
      // A bare digit that is NOT for one of our pickers: return false so the
      // legacy chain runs. handleSettingsNumericReply now sees the play-card
      // store via our enhanced __miasHasPendingPicker above and stays silent,
      // letting the play-card consumer take the digit. That kills the
      // "❌ Unknown settings option *4*" reply after picking from .play.
    } catch {}
    if (typeof prevSettingsHook === 'function') return prevSettingsHook(sock, msg, body);
    return false; // let legacy settings run
  };
  rep.settingsHook = true;

  // ══════════════════════════════════════════════════════════════════════
  // 2) .pick — native-button rowId target (`.pick <n>`)
  // ══════════════════════════════════════════════════════════════════════
  P.cmd(['pick'], { desc: 'Pick an option from the last card', category: 'MISC', hidden: true }, async (sock, msg, args) => {
    const jid = msg.key.remoteJid;
    const n = parseInt(String(args[0] || ''), 10);
    const arr = pickKeyOf(jid);
    const p = arr[arr.length - 1];
    if (!p || !n || n < 1 || n > p.options.length) return;
    const rest = (PICKERS.get(jid) || []).filter(x => x !== p);
    if (rest.length) PICKERS.set(jid, rest); else PICKERS.delete(jid);
    try { await p.onPick(sock, msg, n); } catch (e) { await P.sendReply(sock, msg, `❌ Failed: ${e?.message || e}`).catch(() => {}); }
  });
  rep.pick = true;

  // ══════════════════════════════════════════════════════════════════════
  // 3) YTMATE — picker with quote-reply numbers + fixed video delivery
  // ══════════════════════════════════════════════════════════════════════
  P.cmd(['ytmate', 'ytm'], { desc: 'Download YouTube audio/video (picker)', category: 'DOWNLOAD' }, async (sock, msg, args) => {
    const jid = msg.key.remoteJid;
    // V25-OK: ytmate name-or-link
    // The previous build rejected anything that was not a YouTube URL, so the
    // old ".ytmate <song name>" workflow died. We now resolve a name to a
    // videoId through yt-search (already a dependency) and carry on.
    let url = args.find(a => /youtu\.?be|youtube\.com/.test(a))
      || (/^https?:\/\//i.test(String(args[0] || '')) ? String(args[0]) : null);
    if (!url) {
      const q = (args || []).join(' ').trim();
      if (!q) return P.sendReply(sock, msg, `Usage: ${PFX}ytmate <song name | YouTube URL>`);
      const found = await ytFindFirst(q);
      if (!found) {
        await P.react(sock, msg, '❌').catch(() => {});
        return P.sendReply(sock, msg, `❌ No YouTube result for *${q}*. Try a different name.`);
      }
      url = found;
    }
    await P.react(sock, msg, '🌀').catch(() => {});
    let title = 'YouTube video', thumb = null;
    try {
      const d = await getJson(`https://api.davidcyriltech.my.id/download/ytmp4?url=${encodeURIComponent(url)}`);
      title = d?.result?.title || title;
      if (d?.result?.thumbnail) thumb = await getBuf(d.result.thumbnail, 10000);
    } catch {}
    if (!thumb) { try { thumb = await getBuf(`https://i.ytimg.com/vi/${ytId(url)}/hqdefault.jpg`, 10000); } catch {} }
    const options = ['🎵 Audio (MP3)', '🎬 Video 360p', '🎬 Video 720p', '📄 Video as Document'];
    const caption = `🎬 *YTMATE*\n\n📌 *${title}*\n\nReply to this message with a number:\n${options.map((o, i) => `*${i + 1}.* ${o}`).join('\n')}\n\n_You can also tap the list button below._`;
    const sent = await sendPickerCard(sock, jid, msg, { image: thumb, caption, title: 'YTMATE', rows: options });
    registerPicker(jid, sent, options, async (s, m, n) => {
      // V25-OK: ytmate audited delivery
      await P.react(s, m, '🌀').catch(() => {});
      const label = n === 1 ? 'audio' : (n === 4 ? 'document' : 'video');
      const r = await ytDownload(url, n === 1 ? 'audio' : 'video', n === 3 ? '720' : '360');
      if (!r) {
        await P.react(s, m, '❌').catch(() => {});
        return P.sendReply(s, m, `❌ No working download source could return a valid ${label} for this video right now. Nothing invalid was sent — please try again in a moment.`);
      }
      if (n === 1) {
        await sendAudioRobust(s, jid, r.buf, r.title || title, m);
      } else if (n === 4) {
        // Video as DOCUMENT — the exact pre-push behaviour the user asked for
        const safe = String(r.title || title || 'video').replace(/[^\w\s.-]/g, '').trim().slice(0, 60) || 'video';
        await s.sendMessage(jid, { document: r.buf, mimetype: 'video/mp4', fileName: safe + '.mp4', caption: `🎬 ${r.title || title}` }, { quoted: m });
      } else {
        await sendVideoRobust(s, jid, r.buf, `🎬 ${r.title || title}`, m);
      }
      await P.react(s, m, '✅').catch(() => {});
    }, 'ytmate');
    await P.react(sock, msg, '✅').catch(() => {});
  });
  rep.ytmate = true;

  // ══════════════════════════════════════════════════════════════════════
  // 4) SAVETUBE — direct args kept + picker when only URL given
  // ══════════════════════════════════════════════════════════════════════
  P.cmd(['savetube', 'svt'], { desc: 'Download YouTube media via SaveTube/picker', category: 'DOWNLOAD' }, async (sock, msg, args) => {
    const jid = msg.key.remoteJid;
    const url = args.find(a => /youtu\.?be/.test(a));
    const modeArg = args.find(a => /^(audio|video|doc)$/i.test(a))?.toLowerCase();
    const qArg = args.find(a => /^\d{3,4}$/.test(a));
    if (!url) return P.sendReply(sock, msg, `📥 *SaveTube*\n\nUsage: ${PFX}savetube <YouTube URL> [audio|video|doc] [quality]\n—or just send the URL and pick from the card._`);
    await P.react(sock, msg, '🌀').catch(() => {});
    const deliver = async (mode, quality) => {
      if (mode === 'audio') {
        const r = await ytDownload(url, 'audio');
        if (!r) throw new Error('audio APIs down');
        await sendAudioRobust(sock, jid, r.buf, r.title, msg);
      } else {
        const r = await ytDownload(url, 'video', quality || '360');
        if (!r) throw new Error('video APIs down');
        if (mode === 'doc') await sock.sendMessage(jid, { document: r.buf, mimetype: 'video/mp4', fileName: (r.title || 'video').replace(/[^\w\s-]/g, '') + '.mp4' }, { quoted: msg });
        else await sendVideoRobust(sock, jid, r.buf, `🎬 ${r.title || ''}`.trim(), msg);
      }
      await P.react(sock, msg, '✅').catch(() => {});
    };
    if (modeArg) {
      try { await deliver(modeArg, qArg); } catch (e) { await P.react(sock, msg, '❌').catch(() => {}); await P.sendReply(sock, msg, `❌ SaveTube failed: ${e.message}`); }
      return;
    }
    let thumb = null;
    try { thumb = await getBuf(`https://i.ytimg.com/vi/${ytId(url)}/hqdefault.jpg`, 10000); } catch {}
    const options = ['🎵 Audio (MP3)', '🎬 Video 360p', '🎬 Video 720p', '📄 Video as Document'];
    const caption = `📥 *SAVETUBE*\n\nReply to this message with a number:\n${options.map((o, i) => `*${i + 1}.* ${o}`).join('\n')}\n\n_You can also tap the list button below._`;
    const sent = await sendPickerCard(sock, jid, msg, { image: thumb, caption, title: 'SAVETUBE', rows: options });
    registerPicker(jid, sent, options, async (s, m, n) => {
      try { await deliver(n === 1 ? 'audio' : n === 4 ? 'doc' : 'video', n === 3 ? '720' : '360'); }
      catch (e) { await P.sendReply(s, m, `❌ Failed: ${e.message}`); }
    }, 'savetube');
    await P.react(sock, msg, '✅').catch(() => {});
  });
  rep.savetube = true;

  // ══════════════════════════════════════════════════════════════════════
  // 5) MOVIE / NKIRI / BOOST6 — quote-reply numbered pickers
  //    (results kept in picker store; no more silent number-stealing)
  // ══════════════════════════════════════════════════════════════════════
  async function movieSearch(q) {
    // multi-source search with fallback
    try {
      const d = await getJson(`${P.CONFIG.MYNETNAIJA_API || 'https://netnaija.preciousapi.workers.dev'}/search?q=${encodeURIComponent(q)}`);
      const list = d?.data || d?.results || d?.result || [];
      if (Array.isArray(list) && list.length) return list.slice(0, 8).map(i => ({ title: i.title || i.name, url: i.url || i.link }));
    } catch {}
    try {
      const d = await getJson(`https://api.giftedtech.co.ke/api/search/movies?apikey=gifted&query=${encodeURIComponent(q)}`);
      const list = d?.result || d?.results || d?.data || [];
      if (Array.isArray(list) && list.length) return list.slice(0, 8).map(i => ({ title: i.title || i.name, url: i.url || i.link }));
    } catch {}
    return [];
  }
  function makeMovieCmd(names, label, emoji) {
    P.cmd(names, { desc: `Search & pick ${label}`, category: 'SEARCH' }, async (sock, msg, args) => {
      const jid = msg.key.remoteJid;
      if (!args.length) return P.sendReply(sock, msg, `Usage: ${PFX}${names[0]} <title>`);
      await P.react(sock, msg, emoji).catch(() => {});
      const results = await movieSearch(args.join(' '));
      if (!results.length) { await P.react(sock, msg, '❌').catch(() => {}); return P.sendReply(sock, msg, `❌ No ${label} results found. Try another title.`); }
      const options = results.map(r => r.title || 'Untitled');
      const caption = `${emoji} *${label.toUpperCase()} SEARCH*\n🔎 *${args.join(' ')}*\n\nReply to this message with a number:\n${options.map((t, i) => `*${i + 1}.* ${t}`).join('\n')}\n\n_You can also tap the list button below._`;
      const sent = await sendPickerCard(sock, jid, msg, { caption, title: label, rows: options.map(t => t.slice(0, 24)) });
      registerPicker(jid, sent, options, async (s, m, n) => {
        const item = results[n - 1];
        await P.sendReply(s, m, `${emoji} *${item.title}*\n🔗 ${item.url || 'link unavailable'}\n\n_Open the link to stream/download._`);
      }, names[0]);
      await P.react(sock, msg, '✅').catch(() => {});
    });
  }
  // V25-OK: link-only movie overrides removed.
  // The previous v24 pack re-registered .movie / .nkiri / .boost6 HERE (after
  // the real handlers) and its picker callback only printed "Open the link",
  // which is why downloads turned into bare URLs. Those registrations are
  // deliberately NOT re-added: mias/index.js .movie (MynetNaija picker) and
  // precious-fixes-v21 .nkiri (Nkiri direct-file document) now win again and
  // deliver the actual file as a document, exactly as before the last push.
  rep.moviePickers = 'restored-native (v25)';

  // ══════════════════════════════════════════════════════════════════════
  // 6) TT DEDUPE — picker card is the ONLY route (quoted links included)
  // ══════════════════════════════════════════════════════════════════════
  async function ttHandle(sock, msg, args) {
    const jid = msg.key.remoteJid;
    const ctx = msg?.message?.extendedTextMessage?.contextInfo || null;
    const quotedText = ctx?.quotedMessage?.conversation || ctx?.quotedMessage?.extendedTextMessage?.text || '';
    const text = (args || []).join(' ') + ' ' + quotedText;
    const m = text.match(/https?:\/\/[^\s]*tiktok\.com[^\s]*/i);
    if (!m) return P.sendReply(sock, msg, `Usage: ${PFX}tt <tiktok link>  (or quote a message containing the link)`);
    const url = m[0];
    await P.react(sock, msg, '🌀').catch(() => {});
    let info = null;
    try { const d = await getJson('https://www.tikwm.com/api/?url=' + encodeURIComponent(url) + '&hd=1'); info = d?.data; } catch {}
    if (!info || !info.play) { await P.react(sock, msg, '❌').catch(() => {}); return P.sendReply(sock, msg, '❌ Unable to fetch that TikTok. Check the link and try again.'); }
    const abs = u => (u && u.startsWith('/') ? 'https://www.tikwm.com' + u : u);
    let thumb = null;
    try { thumb = await getBuf(abs(info.cover || info.origin_cover), 10000); } catch {}
    const options = ['🎬 Video (no watermark)', '🎬 Video HD', '🎵 Audio (MP3)'];
    const caption = `🎵 *TIKTOK*\n\n📌 *${(info.title || 'TikTok video').slice(0, 80)}*\n👤 @${info.author?.unique_id || 'tiktok'}\n\nReply to this message with a number:\n${options.map((o, i) => `*${i + 1}.* ${o}`).join('\n')}\n\n_You can also tap the list button below._`;
    const sent = await sendPickerCard(sock, jid, msg, { image: thumb, caption, title: 'TIKTOK', rows: options });
    registerPicker(jid, sent, options, async (s, m2, n) => {
      await P.react(s, m2, '🌀').catch(() => {});
      if (n === 3) {
        const buf = await getBuf(abs(info.music));
        if (!buf || !buf.length) return P.sendReply(s, m2, '❌ Could not fetch the audio.');
        await sendAudioRobust(s, jid, buf, info.title || 'tiktok', m2);
      } else {
        const buf = await getBuf(abs(n === 2 && info.hdplay ? info.hdplay : info.play));
        if (!buf || !isRealMedia(buf)) return P.sendReply(s, m2, '❌ Could not fetch the video.');
        await sendVideoRobust(s, jid, buf, `🎵 ${(info.title || '').slice(0, 60)}`, m2);
      }
      await P.react(s, m2, '✅').catch(() => {});
    }, 'tiktok');
    await P.react(sock, msg, '✅').catch(() => {});
    // NO auto-deliver fall-through — the picker is the sole route.
  }
  // TIKTOK RESTORED: the v24 3-option card ("🎵 TIKTOK / Video (no watermark) / MAIS MDX • v4.9.9")
  // is removed PERMANENTLY. The original image-card menu from mias/index.js + features/tiktok.js
  // (Author / Duration / ➜ [1] Video 1.1–1.7, [2] Music, [3] Stickers, footer "MAIS MDX • TikTok") wins again.
  // P.cmd(['tiktok', 'tt', 'ttdl'], { desc: 'TikTok downloader (picker card only)', category: 'DOWNLOAD' }, ttHandle);
  rep.ttDedupe = true;

  // ══════════════════════════════════════════════════════════════════════
  // 7) GST KEPT — GROUP-ONLY (v25 change)
  //    .gst/.gstatus/.groupstatus/.gcstatus are NO LONGER deleted here.
  //    precious-gst-picker.cjs (loaded before this pack) re-pins them to a
  //    group-only handler: posts to the group status ring in a GC, and in a
  //    DM simply tells the user to run it inside a group (DM picker removed).
  //    We only clean up the stale DM picker sub-commands if any remain.
  // ══════════════════════════════════════════════════════════════════════
  let removed = 0;
  for (const n of ['gstpick', 'gstcancel']) {
    try { if (P.commands.delete(n)) removed++; } catch {}
  }
  rep.gstKeptGroupOnly = true;
  rep.gstDmPickerCmdsRemoved = removed;

  // ══════════════════════════════════════════════════════════════════════
  // 8) SUDO — image card + 1 Add (DM only) / 2 Remove (all) / 3 Sudo VIP
  // ══════════════════════════════════════════════════════════════════════
  const sudoFile = () => path.join(__dirname, '..', 'allfunc', 'sudo.json');
  function loadSudo() { try { return JSON.parse(fs.readFileSync(sudoFile(), 'utf8')); } catch { return { dm: [], vip: [] }; } }
  function saveSudo(d) { try { fs.writeFileSync(sudoFile(), JSON.stringify(d, null, 2)); } catch {} }
  // global probe so the dispatcher can allow vip/dm sudo users
  globalThis.__miasSudoCheck = function (senderJid, chatJid) {
    const d = loadSudo(); const num = String(senderJid || '').split('@')[0];
    const hit = (arr) => arr.some(j => String(j).split('@')[0] === num);
    if (hit(d.vip)) return true;
    const isDm = chatJid && !chatJid.endsWith('@g.us');
    if (isDm && hit(d.dm)) return true;
    return false;
  };

  P.cmd(['sudo', 'setsudo', 'addsudo'], { desc: 'Manage sudo users (card)', category: 'OWNER', ownerOnly: true }, async (sock, msg, args) => {
    const jid = msg.key.remoteJid;
    const isDm = !jid.endsWith('@g.us');
    const ownerNum = String(P.CONFIG.OWNER_NUMBER || '').replace(/\D/g, '');
    const botJid = (sock.user?.id || '').split(':')[0] + '@s.whatsapp.net';
    const inBotDm = isDm && jid === botJid;

    // determine target
    let targetNum = String((args || []).join(' ') || '').replace(/\D/g, '');
    if (!targetNum && isDm) targetNum = jid.split('@')[0]; // .sudo in a target DM with no number → sudo that DM (DP image card: target DP, else bot DP)         // someone's DM → sudo the DM owner
    if (!targetNum) {
      return P.sendReply(sock, msg, `👑 *SUDO*\n\nSend the target number:\n${PFX}sudo 2348012345678`);
    }
    const target = targetNum + '@s.whatsapp.net';
    await P.react(sock, msg, '🌀').catch(() => {});
    const pic = await targetPic(sock, target);
    const d = loadSudo();
    const cur = d.vip.includes(target) ? 'VIP (full access)' : d.dm.includes(target) ? 'DM-only' : 'none';
    const options = ['➕ Add (DM only)', '➖ Remove (everything)', '👑 Sudo VIP (full access)'];
    const _sudoName = (typeof P.getDisplayName === 'function'
      ? await P.getDisplayName(sock, target, jid).catch(() => null)
      : null) || `@${targetNum}`;
    const caption = `👑 *SUDO MANAGER*\n\n🎯 Target: ${_sudoName}\n📊 Current access: *${cur}*\n\nReply to this message with a number:\n${options.map((o, i) => `*${i + 1}.* ${o}`).join('\n')}\n\n_You can also tap the list button below._`;
    const sent = await sendPickerCard(sock, jid, msg, { image: pic, caption, title: 'SUDO', rows: ['Add DM', 'Remove', 'VIP'] });
    registerPicker(jid, sent, options, async (s, m, n) => {
      const dd = loadSudo();
      if (n === 1) {
        if (!dd.dm.includes(target)) dd.dm.push(target);
        dd.vip = dd.vip.filter(j => j !== target);
        saveSudo(dd);
        await P.sendReply(s, m, `✅ ${_sudoName} added as *DM-only* sudo.`);
      } else if (n === 2) {
        dd.dm = dd.dm.filter(j => j !== target);
        dd.vip = dd.vip.filter(j => j !== target);
        saveSudo(dd);
        await P.sendReply(s, m, `✅ ${_sudoName} removed from *all* sudo access.`);
      } else {
        if (!dd.vip.includes(target)) dd.vip.push(target);
        dd.dm = dd.dm.filter(j => j !== target);
        saveSudo(dd);
        await P.sendReply(s, m, `👑 ${_sudoName} now has *Sudo VIP* (full access — DM & groups).`);
      }
      await P.react(s, m, '✅').catch(() => {});
    }, 'sudo');
    await P.react(sock, msg, '✅').catch(() => {});
  });

  P.cmd(['listsudo', 'getsudo'], { desc: 'List sudo users', category: 'OWNER', ownerOnly: true }, async (sock, msg) => {
    const d = loadSudo();
    const fmt = arr => arr.length ? arr.map(j => '• +' + j.split('@')[0]).join('\n') : '_none_';
    await P.sendReply(sock, msg, `👑 *SUDO LIST*\n\n*VIP (full access):*\n${fmt(d.vip)}\n\n*DM-only:*\n${fmt(d.dm)}`);
  });
  rep.sudo = true;

  // ══════════════════════════════════════════════════════════════════════
  // 9) FORWARD — .forward <number> forwards the quoted message, any type
  // ══════════════════════════════════════════════════════════════════════
  P.cmd(['forward', 'fwd'], { desc: 'Forward quoted message — .forward <number|JID>', category: 'MISC' }, async (sock, msg, args) => {
    const jid = msg.key.remoteJid;
    const raw = unwrapMsg(msg.message);
    const ctx = raw.extendedTextMessage?.contextInfo || raw.imageMessage?.contextInfo
      || raw.videoMessage?.contextInfo || raw.audioMessage?.contextInfo
      || raw.documentMessage?.contextInfo || raw.stickerMessage?.contextInfo || null;
    let quoted = ctx?.quotedMessage || null;
    quoted = unwrapMsg(quoted);
    if (!quoted || !Object.keys(quoted).length) {
      await P.react(sock, msg, '❌').catch(() => {});
      return P.sendReply(sock, msg, `↩️ Quote the message/media you want to forward, then:\n${PFX}forward 2348012345678`);
    }
    const rawTarget = String(args[0] || '').trim();
    let target = '';
    if (rawTarget.includes('@')) target = rawTarget.toLowerCase();
    else {
      const digits = rawTarget.replace(/\D/g, '');
      if (digits.length >= 7) target = digits + '@s.whatsapp.net';
    }
    if (!target) {
      await P.react(sock, msg, '❌').catch(() => {});
      return P.sendReply(sock, msg, `Usage: ${PFX}forward <number|JID>\nExample: ${PFX}forward 2348012345678`);
    }
    await P.react(sock, msg, '🌀').catch(() => {});
    // V25-OK: forward resend-first
    // The old order tried {forward:{…}} first. On several Baileys builds that
    // promise RESOLVES while nothing is actually delivered, so the command
    // replied "✅ Forwarded" and the target got silence. We now copy the
    // content across first (this always works), and only fall back to the
    // native forward afterwards.
    let _dcm = globalThis.__PRECIOUS__?.downloadContentFromMessage;
    if (typeof _dcm !== 'function') {
      try { const mod = await import('@whiskeysockets/baileys'); _dcm = mod.downloadContentFromMessage || (mod.default && mod.default.downloadContentFromMessage); } catch {}
    }
    try {
      const dcm = _dcm;
      const map = { imageMessage: 'image', videoMessage: 'video', audioMessage: 'audio', stickerMessage: 'sticker', documentMessage: 'document' };
      for (const [k, t] of Object.entries(map)) {
        if (!quoted[k] || typeof dcm !== 'function') continue;
        const stream = await dcm(quoted[k], t);
        const chunks = []; for await (const c of stream) chunks.push(c);
        const buf = Buffer.concat(chunks);
        if (!buf.length) continue;
        const payload = k === 'imageMessage' ? { image: buf, caption: quoted[k].caption || '' }
          : k === 'videoMessage' ? { video: buf, mimetype: quoted[k].mimetype || 'video/mp4', caption: quoted[k].caption || '' }
          : k === 'audioMessage' ? { audio: buf, mimetype: quoted[k].mimetype || 'audio/ogg; codecs=opus', ptt: !!quoted[k].ptt }
          : k === 'stickerMessage' ? { sticker: buf }
          : { document: buf, mimetype: quoted[k].mimetype || 'application/octet-stream', fileName: quoted[k].fileName || 'file', caption: quoted[k].caption || '' };
        await sock.sendMessage(target, payload);
        await P.react(sock, msg, '✅').catch(() => {});
        return P.sendReply(sock, msg, `✅ Forwarded to +${target.split('@')[0]}`);
      }
      // plain text
      const text = quoted.conversation || quoted.extendedTextMessage?.text;
      if (text) {
        const t = await sock.sendMessage(target, { text });
        if (t && t.key) { await P.react(sock, msg, '✅').catch(() => {}); return P.sendReply(sock, msg, `✅ Forwarded to +${target.split('@')[0]}`); }
      }
    } catch (e) {}
    // Fallbacks — only trusted when they actually resolve
    try {
      const sent = await sock.sendMessage(target, { forward: { key: { remoteJid: jid, id: ctx.stanzaId, participant: ctx.participant }, message: quoted }, force: true });
      if (sent && sent.key) { await P.react(sock, msg, '✅').catch(() => {}); return P.sendReply(sock, msg, `✅ Forwarded to +${target.split('@')[0]}`); }
    } catch {}
    try {
      await sock.relayMessage(target, quoted, { messageId: 'fwd_' + Date.now() });
      await P.react(sock, msg, '✅').catch(() => {});
      return P.sendReply(sock, msg, `✅ Forwarded to +${target.split('@')[0]}`);
    } catch {}
    await P.react(sock, msg, '❌').catch(() => {});
    return P.sendReply(sock, msg, '❌ Could not forward that message — check the number and that the bot can reach it.');
  });
  rep.forward = true;

  // ══════════════════════════════════════════════════════════════════════
  // 10) PRIVATE BY DEFAULT on connect
  // ══════════════════════════════════════════════════════════════════════
  try {
    const s = (typeof P.getSettings === 'function') ? P.getSettings((P.CONFIG.OWNER_NUMBER || '').replace(/\D/g, '') + '@s.whatsapp.net') : null;
    if (s && typeof s === 'object' && s.__v24PrivateDefault !== true && s.modeSetByOwner !== true) {
      s.public = false; s.self = true; s.__v24PrivateDefault = true;
      try { P.saveNow && P.saveNow(); } catch {}
    }
  } catch {}
  rep.privateDefault = true;

  // ══════════════════════════════════════════════════════════════════════
  // 11) ANIME EDITS
  // ══════════════════════════════════════════════════════════════════════
  try {
    const edits = require('./precious-anime-edits.cjs');
    rep.edits = edits.install(P, helpers);
  } catch (e) { rep.edits = 'error: ' + (e && e.message); }

  return rep;
};
