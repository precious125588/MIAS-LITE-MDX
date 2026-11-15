'use strict';
/* precious-fixes-v42.cjs — typed `.setting <code>` for the LIVE command chain.
   Installed LAST by precious-master-fix-boot (after v41).
   - `. setting 1.2` applies that option directly: no menu card, no panel hint.
   - Option already in that state -> "<Group> is already enabled/disabled. No action done." and nothing changes.
   - Unknown code (e.g. 44.1) -> "not a setting" reply.
   - Plain `.setting` (no code) and non-owner callers go to the original handler unchanged.
*/
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

const ctxObj = () => (globalThis.__PRECIOUS__ && typeof globalThis.__PRECIOUS__ === 'object') ? globalThis.__PRECIOUS__ : {};
function commandsMap() {
  const c = ctxObj().commands || globalThis.__MIAS_COMMANDS__;
  return (c && typeof c.get === 'function' && typeof c.set === 'function') ? c : null;
}
function settingsFor(jid) {
  const c = ctxObj();
  try { if (typeof c.getSettings === 'function') return c.getSettings(jid) || {}; } catch (_) {}
  try { if (typeof globalThis.__MIAS_GET_SETTINGS__ === 'function') return globalThis.__MIAS_GET_SETTINGS__(jid) || {}; } catch (_) {}
  return {};
}
function ownerJid() {
  const c = ctxObj();
  try { if (typeof c.getOwnerJid === 'function') { const j = c.getOwnerJid(); if (j) return String(j); } } catch (_) {}
  const n = String((c.CONFIG && c.CONFIG.OWNER_NUMBER) || '').replace(/[^0-9]/g, '');
  return n ? n + '@s.whatsapp.net' : '';
}
function unwrap(msg) {
  return (msg && msg.message && msg.message.ephemeralMessage && msg.message.ephemeralMessage.message) || (msg && msg.message) || {};
}
// `.setting 1.2`, `. setting 1.2`, `!setting 39.1` -> "1.2" / "39.1"; anything else -> ''
function typedCode(msg) {
  const m = unwrap(msg);
  const text = String(m.conversation || (m.extendedTextMessage && m.extendedTextMessage.text) || '').trim();
  const r = text.match(/^\S{0,3}\s*(?:setting|settings|config)\s+(\d{1,2}(?:\.\d{1,2})?)(?:\s|$)/i);
  return r ? r[1] : '';
}
function isOwnerMsg(msg) {
  const c = ctxObj();
  if (msg && msg.key && msg.key.fromMe) return true;
  let sender = '';
  try { sender = typeof c.getSender === 'function' ? c.getSender(msg) : ((msg.key && (msg.key.participant || msg.key.remoteJid)) || ''); } catch (_) {}
  try { if (typeof c.isOwner === 'function' && c.isOwner(sender)) return true; } catch (_) {}
  return false;
}

async function applyTyped(sock, msg, code) {
  const c = ctxObj();
  const jid = msg.key.remoteJid;
  const send = async (text) => {
    const fn = c.sendReply || globalThis.sendReply;
    if (typeof fn === 'function') return fn(sock, msg, text);
    return sock.sendMessage(jid, { text }, { quoted: msg });
  };
  const row = T.find(r => r[0] === code);
  if (!row) {
    await send('❌ *' + code + '* is not a setting. Send *' + ((c.CONFIG && c.CONFIG.PREFIX) || '.') + 'setting* to see the options.');
    return true;
  }
  // A typed command must not also be answered by the panel reply handler.
  try { if (c.settingsSession && typeof c.settingsSession.delete === 'function') c.settingsSession.delete(jid); } catch (_) {}

  let already = false;
  try { already = !!row[3](settingsFor(jid)); } catch (_) {}
  if (already) {
    const st = row[2] === 'ENABLE' ? 'enabled' : row[2] === 'DISABLE' ? 'disabled' : row[2].toLowerCase();
    await send('✅ *' + row[1] + '* is already *' + st + '*. No action done.');
    return true;
  }

  const map = globalThis.SETTINGS_MAP || c.SETTINGS_MAP || null;
  if (map && typeof map[code] === 'function') {
    let out = '';
    try { out = map[code](settingsFor(jid)); } catch (e) { out = '❌ ' + (e && e.message); }
    const owner = ownerJid();
    if (owner && owner !== jid) { try { map[code](settingsFor(owner)); } catch (_) {} }
    try { if (typeof c.saveNow === 'function') c.saveNow(); } catch (_) {}
    await send(String(out || '✅ Updated.'));
    return true;
  }
  // No in-memory map exposed: hand the code to the existing settings bridge.
  if (typeof globalThis.__PRECIOUS_SETTINGS_REPLY__ === 'function') {
    return !!(await globalThis.__PRECIOUS_SETTINGS_REPLY__(sock, msg, code));
  }
  return false;
}

function wrapCommands() {
  const cmds = commandsMap();
  if (!cmds) return 0;
  let n = 0;
  for (const name of ['setting', 'settings', 'config']) {
    const e = cmds.get(name);
    if (!e || typeof e.handler !== 'function' || e.__v42Typed) continue;
    const orig = e.handler;
    e.__v42Typed = true;
    e.handler = async function (sock, msg, args) {
      try {
        const code = typedCode(msg);
        if (code && isOwnerMsg(msg)) {
          const done = await applyTyped(sock, msg, code);
          if (done) return;
        }
      } catch (err) {
        console.log('[v42] typed setting error:', err && err.message);
      }
      return orig.call(this, sock, msg, args);
    };
    cmds.set(name, e);
    n++;
  }
  return n;
}

function install() {
  if (globalThis.__V42_INSTALLED__) return globalThis.__V42_INSTALLED__;
  const n = wrapCommands();
  globalThis.__V42_INSTALLED__ = { wrapped: n };
  if (!n) {
    for (const ms of [3000, 10000]) {
      try { const t = setTimeout(() => { try { wrapCommands(); } catch (_) {} }, ms); if (t && t.unref) t.unref(); } catch (_) {}
    }
  }
  return globalThis.__V42_INSTALLED__;
}

module.exports = install;
module.exports.install = install;
module.exports.apply = install;
module.exports.typedCode = typedCode;
