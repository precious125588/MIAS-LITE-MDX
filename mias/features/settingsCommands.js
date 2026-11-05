// Settings command, moved out of mias/index.js. Handler code is unchanged.
// Everything it needs is passed in through `ctx`.
export function installSettingsCommand(ctx) {
  const { cmd, getSender, isOwner, isSudo, isGroup, isGroupAdmin, sendReply, settingsSession, getSettings, getBotPic, CONFIG, buildSettingsMenu } = ctx;
cmd(["setting", "settings", "config"], { desc: "Open bot settings", category: "SETTINGS" }, async (sock, msg) => {
  const jid = msg.key.remoteJid, sender = getSender(msg);
  const isFromOwner = msg.key.fromMe || isOwner(sender) || isSudo(sender);
  const isAdmin = isGroup(msg) ? await isGroupAdmin(sock, jid, sender) : false;
  const inGroup = isGroup(msg);
  if (!isFromOwner) {
    if (inGroup && !isAdmin) { await sendReply(sock, msg, "🚫 Admins/Owner only."); return; }
    if (!inGroup) { await sendReply(sock, msg, "🚫 Owner only."); return; }
  }
  settingsSession.set(jid, { sender, ts: Date.now() }); setTimeout(() => settingsSession.delete(jid), 120000);
  const s = getSettings(jid);
  const settingsPic = await getBotPic().catch(() => null);
  const footerText = `${CONFIG.BOT_NAME} v${CONFIG.VERSION} • Tap to toggle`;

  // Native interactive list sections for settings
  const settingsSections = [
    {
      title: "🛡️ Moderation & Safety",
      rows: [
        { id: "1.1", title: `Block Calls [${s.blockCalls ? "ON" : "OFF"}]`, description: "Auto-reject incoming WhatsApp calls" },
        { id: "2.1", title: `Link Guard [${s.linkGuard ? "ON" : "OFF"}]`, description: "Delete links or warn sender in groups" },
        { id: "3.1", title: `Badword Filter [${s.badWords ? "ON" : "OFF"}]`, description: "Filter toxic and swear words" },
        { id: "6.1", title: `Anti-Delete [${s.antiDelete ? "ON" : "OFF"}]`, description: "Forward deleted messages to owner DM" },
        { id: "26.1", title: `Anti-Mention [${s.antiMention ? "ON" : "OFF"}]`, description: "Block everyone/channel mass mentions" },
        { id: "27.1", title: `Anti-Bug [${s.antiBug ? "ON" : "OFF"}]`, description: "Drop crash and freeze payloads" },
        { id: "39.1", title: `Anti-ViewOnce [${s.antiViewOnce ? "ON" : "OFF"}]`, description: "Auto-capture view-once media" },
        { id: "40.1", title: `Anti-ViewOnce Mode [${(s.antiViewOnceMode || "private").toUpperCase()}]`, description: "Send to chat or private DM" },
      ]
    },
    {
      title: "🤖 Automation & Chatbot",
      rows: [
        { id: "21.1", title: `Chatbot [${s.chatBotMode ? "ON" : "OFF"}]`, description: "Toggle intelligent AI chatbot responses" },
        { id: "7.1", title: `Auto-React [${s.autoReactMsgs ? "ON" : "OFF"}]`, description: "Random emoji on normal messages (not commands)" },
        { id: "7.3", title: `Command React [${s.cmdReact !== false ? "ON" : "OFF"}]`, description: "React to commands you send" },
        { id: "10.1", title: `View Status [${s.viewStatus ? "ON" : "OFF"}]`, description: "Auto-view contacts' status updates" },
        { id: "11.1", title: `React Status [${s.reactStatus ? "ON" : "OFF"}]`, description: "Auto-react to viewed statuses" },
        { id: "15.1", title: `Auto-Reply [${s.autoReply ? "ON" : "OFF"}]`, description: "Auto-reply to incoming trigger keywords" },
        { id: "13.1", title: `Auto-Voice [${s.autoVoice ? "ON" : "OFF"}]`, description: "Auto-reply with voice notes" },
        { id: "14.1", title: `Auto-Sticker [${s.autoSticker ? "ON" : "OFF"}]`, description: "Auto-convert images to stickers" },
      ]
    },
    {
      title: "🏷️ Verified Badges & Context",
      rows: [
        { id: "32.1", title: `Status Reply (Meta AI) [${s.statusReply ? "ON" : "OFF"}]`, description: "Meta AI verified blue badge on replies" },
      ]
    },
    {
      title: "⚙️ Presence & Groups",
      rows: [
        { id: "12.1", title: `Welcome & Goodbye [${s.welcome ? "ON" : "OFF"}]`, description: "Welcome/farewell cards for new members" },
        { id: "16.1", title: `Recording Status [${s.recording ? "ON" : "OFF"}]`, description: "Show 'recording audio...' presence" },
        { id: "17.1", title: `Typing Status [${s.typing ? "ON" : "OFF"}]`, description: "Show 'typing...' presence" },
        { id: "18.1", title: `Always Online [${s.alwaysOnline ? "ON" : "OFF"}]`, description: "Keep bot account active/online" },
        { id: "37.1", title: `Anonymous Mode [${s.anonymous ? "ON" : "OFF"}]`, description: "Hide online/last seen — reads stay one tick" },
      ]
    }
  ];

  let nativeSuccess = false;
  // [FIX] Owner request: the native interactive-list settings panel (added in
  // 2574cc8) is disabled — always use the classic boxed settings UI (the one
  // with the < Category > sections + Open Categories / Open settings buttons).
  if (false) try {
    const { sendList } = await import("../handlers/interactiveHandler.js");
    await sendList(sock, jid, `⚙️ *${CONFIG.BOT_NAME} Settings*
Select a setting from the interactive menu below to toggle:`, settingsSections, {
      title: "⚙️ BOT SETTINGS",
      buttonText: "⚙️ Toggle Settings",
      footer: footerText,
      quoted: msg,
    });
    nativeSuccess = true;
  } catch (errNative) {
    console.log("[settings-native-list]", errNative?.message || errNative);
  }

  if (!nativeSuccess) {
    const settingsText = buildSettingsMenu(jid);
    if (settingsPic) {
      try {
        await sock.sendMessage(jid, { image: settingsPic, caption: settingsText }, { quoted: msg });
      } catch { await sendReply(sock, msg, settingsText); }
    } else {
      await sendReply(sock, msg, settingsText);
    }
  }
});
}
