// .sudo and .setsudo commands, moved out of mias/index.js. Handler code is unchanged.
// Everything they need is passed in through `ctx`.
import axios from "axios";

// Pending .sudo confirmations. index.js reads this same Map (and exposes it on globalThis).
export const sudoPending = new Map();

export function installSetsudoCommand(ctx) {
  const { cmd, sendReply, CONFIG, toStandardJid, resolveLid, sudoUsers, saveNow } = ctx;
cmd("setsudo", { desc: "Add sudo user", category: "OWNER", ownerOnly: true }, async (sock, msg, args) => {
    const mCtx = msg.message?.extendedTextMessage?.contextInfo;
    const mentions = mCtx?.mentionedJid || [];
    let _st = mentions[0] || mCtx?.participant;
    if (!_st && args[0]) { const n = args[0].replace(/[^0-9]/g,""); if (n.length>=7) _st = n+"@s.whatsapp.net"; }
    if (!_st) { await sendReply(sock, msg, `Usage: ${CONFIG.PREFIX}setsudo @user  OR reply to their message  OR ${CONFIG.PREFIX}setsudo <number>`); return; }
    // v14: resolve @lid → real phone JID FIRST, then standardise
    _st = toStandardJid(resolveLid(_st));
    const _sNum = _st.split("@")[0];
    const botNum = String(sock.user?.id || "").replace(/[^0-9]/g, "");
    if (_sNum && botNum && _sNum === botNum) {
      await sendReply(sock, msg, "🚫 Unauthorized behavior: you can't be bot and sudo!");
      return;
    }
     // v9: creator/owner CAN be added as sudo (user request). Only refuse no-op duplicates.
     if (sudoUsers.has(_sNum)) { await sendReply(sock, msg, `ℹ️ +${_sNum} is already sudo.`); return; }
    sudoUsers.add(_sNum);
    saveNow();
    // Use the ORIGINAL mention JID so WhatsApp renders the correct contact
    // name on the recipient's device (was incorrectly showing owner's name).
    const _mentionJid = mentions[0] || _st;
    const _mentionNum = String(_mentionJid).split("@")[0];
    await sendReply(sock, msg, `✅ @${_mentionNum} added to sudo!`, [_mentionJid]);
  });
}

export function installSudoCommand(appCtx) {
  const { cmd, react, isGroup, sendReply, _cleanNum, getBotPic, getSender } = appCtx;
  const _sudoPending = sudoPending;
cmd(["sudo"], { desc: "Grant sudo: .sudo in a DM or reply to a user", category: "OWNER", ownerOnly: true }, async (sock, msg, args) => {
  const jid = msg.key.remoteJid;
  try {
    try { await react(sock, msg, "🌀"); } catch {}
    const mCtx = msg.message?.extendedTextMessage?.contextInfo;
    let target = mCtx?.mentionedJid?.[0] || mCtx?.participant || "";
    if (!target && args[0]) { const n = String(args[0]).replace(/[^0-9]/g,""); if (n.length>=7) target = n + "@s.whatsapp.net"; }
    if (!target && !isGroup(msg)) target = jid; // DM → the other person

    const botJidRaw = (typeof _botJid !== "undefined" && _botJid) ? _botJid : (appCtx?.botJid || sock.user?.id || sock.user?.jid || "");
    const botNum = _cleanNum(String(botJidRaw).split(":")[0].split("@")[0]);
    const senderJid = msg.key.fromMe
      ? (sock.user?.id || "")
      : (getSender ? getSender(msg) : (msg.key.participant || jid));
    const senderNum = _cleanNum(String(senderJid).split(":")[0].split("@")[0]);
    const tNum = _cleanNum(String(target).split(":")[0].split("@")[0]);

    // Guard: Prevent self-sudo or targeting the bot itself
    const isBotTarget = (tNum && botNum && tNum === botNum);
    const isSelfTarget = (tNum && senderNum && tNum === senderNum);

    if (isBotTarget || isSelfTarget) {
      try { await react(sock, msg, "🚫"); } catch {}
      await sendReply(sock, msg, "🚫 Unauthorized behavior: you cannot be bot or self as sudo!");
      return;
    }

    if (!target || target === jid && isGroup(msg)) {
      try { await react(sock, msg, "❌"); } catch {}
      await sendReply(sock, msg, "❌ Reply to a user, tag them, give a number, or use inside their DM.");
      return;
    }
    let card = null;
    try { const u = await sock.profilePictureUrl(target, "image"); if (u) card = Buffer.from((await axios.get(u,{responseType:"arraybuffer",timeout:12000})).data); } catch {}
    if (!card) { try { card = await getBotPic(); } catch {} }
    
    const pendData = { target, tNum, ts: Date.now(), cmdKey: msg.key, jid };
    const sSender = _cleanNum(getSender(msg));
    _sudoPending.set(sSender + "|" + jid, pendData);
    _sudoPending.set(jid, pendData);
    _sudoPending.set(tNum, pendData);
    _sudoPending.set(target, pendData);
    globalThis.__lastSudoPending = pendData;

    const cap = `👑 *SUDO — ACCESS CONTROL*\n\nTarget: @${tNum}\n\n*1.* Sudo (DM only)\n*2.* Sudo VIP (Group + DM)\n*3.* Remove (revoke all access)\n\n_Quote this card and reply with 1, 2 or 3_`;
    if (card) await sock.sendMessage(jid, { image: card, caption: cap, mentions: [target] }, { quoted: msg });
    else await sendReply(sock, msg, cap, [target]);
  } catch (e) {
    try { await react(sock, msg, "❌"); } catch {}
    await sendReply(sock, msg, "❌ Sudo failed: " + (e?.message||e));
  }
});
}
