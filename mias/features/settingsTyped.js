/* Typed `.setting <code>` — e.g. `.setting 1.2` or `.setting 44.1`.
   Applies the option straight away, with no menu card. An option that is already
   in that state is reported and left alone. A code the menu does not know gets a
   "not a setting" reply. Anything that is not a typed code returns false, so the
   normal settings command runs. */

const TYPED = [
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
  ['7.1', 'Auto React', 'ENABLE', s => !!s.autoReactMsgs],
  ['7.2', 'Auto React', 'DISABLE', s => !s.autoReactMsgs],
  ['7.3', 'Command React', 'ON', s => s.cmdReact !== false],
  ['7.4', 'Command React', 'OFF', s => s.cmdReact === false],
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
  ['29.1', 'Auto Downloader', 'OFF', s => !s.autoDownload || s.autoDownload === 'off'],
  ['29.2', 'Auto Downloader', 'DM ONLY', s => s.autoDownload === 'dm'],
  ['29.3', 'Auto Downloader', 'ALL CHATS', s => s.autoDownload === 'global'],
  ['29.4', 'Auto Downloader', 'THIS CHAT', s => s.autoDownload === 'here'],
  ['30.1', 'Anti-Broadcast', 'ENABLE', s => !!s.antiBroadcast],
  ['30.2', 'Anti-Broadcast', 'DISABLE', s => !s.antiBroadcast],
  ['32.1', 'Status Reply', 'ENABLE', s => !!s.statusReply],
  ['32.2', 'Status Reply', 'DISABLE', s => !s.statusReply],
  ['33.1', 'Group Protections', 'ENABLE', s => s.protectAlways !== false],
  ['33.2', 'Group Protections', 'DISABLE', s => s.protectAlways === false],
  ['34.1', 'Auto Send Status', 'ENABLE', s => s.autoSendStatus !== false],
  ['34.2', 'Auto Send Status', 'DISABLE', s => s.autoSendStatus === false],
  ['35.1', 'Auto Send Aza', 'ENABLE', s => s.autoSendAza !== false],
  ['35.2', 'Auto Send Aza', 'DISABLE', s => s.autoSendAza === false],
  ['36.1', 'Last Seen', 'ENABLE', s => !!s.lastSeenEnabled],
  ['36.2', 'Last Seen', 'DISABLE', s => !s.lastSeenEnabled],
  ['37.1', 'Freeze Last Seen', 'ENABLE', s => !!s.lastSeenFrozen],
  ['37.2', 'Freeze Last Seen', 'DISABLE', s => !s.lastSeenFrozen],
  ['38.1', 'Status Forwarder', 'ENABLE', s => !!s.statusForwarder],
  ['38.2', 'Status Forwarder', 'DISABLE', s => !s.statusForwarder],
  ['39.1', 'Anti ViewOnce', 'ENABLE', s => !!s.antiViewOnce],
  ['39.2', 'Anti ViewOnce', 'DISABLE', s => !s.antiViewOnce],
  ['40.1', 'Anti ViewOnce Mode', 'CHAT', s => (s.antiViewOnceMode || 'private') === 'chat'],
  ['40.2', 'Anti ViewOnce Mode', 'PRIVATE', s => (s.antiViewOnceMode || 'private') === 'private'],
  ['41.1', 'Anti Delete Status', 'ENABLE', s => !!s.antiDStatus],
  ['41.2', 'Anti Delete Status', 'DISABLE', s => !s.antiDStatus],
  ['42.1', 'Steeze Mode', 'ENABLE', s => !!s.steezeMode],
  ['42.2', 'Steeze Mode', 'DISABLE', s => !s.steezeMode],
  ['43.1', 'Anti Edit', 'ENABLE', s => !!s.antiEdit],
  ['43.2', 'Anti Edit', 'DISABLE', s => !s.antiEdit],
  ['43.3', 'Anti Edit', 'DELIVER IN CHAT', s => s.antiEditDestination === 'chat'],
  ['43.4', 'Anti Edit', 'DELIVER IN OWNER DM', s => s.antiEditDestination === 'private'],
  ['44.1', 'Vcard Status', 'ENABLE', s => !!s.vcardStatus],
  ['44.2', 'Vcard Status', 'DISABLE', s => !s.vcardStatus],
];

function unwrapMessage(msg) {
  return (msg && msg.message && msg.message.ephemeralMessage && msg.message.ephemeralMessage.message) || (msg && msg.message) || {};
}

// ".setting 1.2", "!setting 44.1", "setting 1.2" (no-prefix mode) -> "1.2" / "44.1"; anything else -> ""
export function typedSettingCode(msg) {
  const m = unwrapMessage(msg);
  const text = String(m.conversation || (m.extendedTextMessage && m.extendedTextMessage.text) || '').trim();
  const r = text.match(/^\S{0,3}\s*(?:setting|settings|config)\s+(\d{1,2}(?:\.\d{1,2})?)(?:\s|$)/i);
  return r ? r[1] : '';
}

export async function applyTypedSetting({ sock, msg, code, sendReply, settingsSession, getSettings, ownerJid, settingsMap, prefix }) {
  const jid = msg.key.remoteJid;
  const send = (text) => sendReply(sock, msg, text);
  const row = TYPED.find(r => r[0] === code);
  const map = settingsMap || globalThis.SETTINGS_MAP || null;
  const hasMap = !!(map && typeof map[code] === 'function');
  if (!row && !hasMap) {
    const p = prefix === '' ? '' : (prefix || '.');
    await send('❌ *' + code + '* is not a setting. Send *' + p + 'setting* to see the options.');
    return true;
  }
  try { if (settingsSession && typeof settingsSession.delete === 'function') settingsSession.delete(jid); } catch (_) {}

  if (row) {
    let already = false;
    try { already = !!row[3](getSettings(jid)); } catch (_) {}
    if (already) {
      const st = row[2] === 'ENABLE' ? 'enabled' : row[2] === 'DISABLE' ? 'disabled' : row[2].toLowerCase();
      await send('✅ *' + row[1] + '* is already *' + st + '*. No action done.');
      return true;
    }
  }
  if (hasMap) {
    let out = '';
    try { out = map[code](getSettings(jid), { jid }); } catch (e) { out = '❌ ' + (e && e.message); }
    if (ownerJid && ownerJid !== jid) { try { map[code](getSettings(ownerJid)); } catch (_) {} }
    await send(String(out || '✅ Updated.'));
    return true;
  }
  return false;
}
