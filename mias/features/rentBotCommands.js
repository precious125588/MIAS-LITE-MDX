// .rentbot, .delbot, and .listbot / ..listbot commands
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const sessionPaths = require(path.join(REPO_ROOT, "sessionPaths.js"));
const ownership = require(path.join(REPO_ROOT, "sessionOwnership.js"));
const pairingHandshake = require(path.join(REPO_ROOT, "mias", "lib", "pairingHandshake.cjs"));
const companionSyncGrace = require(path.join(REPO_ROOT, "mias", "lib", "companionSyncGrace.cjs"));

function dispatchAdminRequest(payload) {
  try {
    const adminReqDir = sessionPaths?.nexstoreRoot ? path.join(sessionPaths.nexstoreRoot(), "admin-requests") : path.join(REPO_ROOT, "nexstore", "admin-requests");
    fs.mkdirSync(adminReqDir, { recursive: true });
    const reqId = `${payload.action || "req"}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    fs.writeFileSync(path.join(adminReqDir, `${reqId}.json`), JSON.stringify({
      ...payload,
      requestedAt: new Date().toISOString()
    }));
    console.log(`[rentbot] Dispatched ${payload.action} admin request (${reqId}).`);
  } catch (err) {
    console.warn("[rentbot] Admin request dispatch notice:", err?.message);
  }
}


const silentLogger = {
  level: "silent",
  child() { return this; },
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
};

const _rentPairingInFlight = new Set();

function getRentedBotsFile() {
  const root = sessionPaths?.nexstoreRoot ? sessionPaths.nexstoreRoot() : path.join(REPO_ROOT, "nexstore");
  try { fs.mkdirSync(root, { recursive: true }); } catch {}
  return path.join(root, "rented_bots.json");
}

function loadRentedBots() {
  try {
    const file = getRentedBotsFile();
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      if (Array.isArray(data)) return data;
      if (Array.isArray(data?.rentedBots)) return data.rentedBots;
    }
  } catch {}
  return [];
}

function saveRentedBots(list) {
  try {
    const file = getRentedBotsFile();
    fs.writeFileSync(file, JSON.stringify({ rentedBots: list }, null, 2), "utf8");
  } catch (err) {
    console.warn("[rentbot] Failed to save rented_bots.json:", err.message);
  }
}

function isCurrentBotRented(sock) {
  const myNum = String(sock?.user?.id || "").split("@")[0].split(":")[0].replace(/[^0-9]/g, "");
  const authDir = process.env.AUTH_DIR || "";
  const list = loadRentedBots();
  return list.some(b => (b.number && b.number === myNum) || (authDir && b.sessionDir && path.resolve(authDir) === path.resolve(b.sessionDir)));
}

export function installRentBotCommands(ctx) {
  const {
    cmd,
    sendReply,
    CONFIG,
    makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    Browsers,
    DisconnectReason,
    getSender,
    isOwner,
    isCreator,
  } = ctx;

  const P = CONFIG?.PREFIX || ".";

  // ── 1) .rentbot <phone_number> ───────────────────────────────────────────
  cmd(["rentbot"], { desc: "Rent a bot to a user (max 2 bots per user)", category: "RENTBOT" }, async (sock, msg, args) => {
    // Rented bots cannot rent another person
    if (isCurrentBotRented(sock)) {
      await sendReply(sock, msg, "❌ Rented bots cannot rent another bot.");
      return;
    }

    const digits = String(args?.[0] || "").replace(/[^0-9]/g, "");
    if (!digits || digits.length < 7) {
      await sendReply(sock, msg, `❌ Please provide a valid phone number with country code.\n\nUsage: *${P}rentbot 234XXXXXXXXXX*\nExample: *${P}rentbot 2348012345678*`);
      return;
    }

    const sender = (typeof getSender === "function") ? getSender(msg) : (msg?.key?.participant || msg?.key?.remoteJid);
    const senderNum = String(sender || "").split("@")[0].split(":")[0].replace(/[^0-9]/g, "");
    const senderJid = senderNum ? `${senderNum}@s.whatsapp.net` : String(sender || "");

    // User can only rent two bots
    const allRented = loadRentedBots();
    const userBots = allRented.filter(b => b.renterNumber === senderNum || b.renterJid === senderJid);
    if (userBots.length >= 2) {
      await sendReply(sock, msg, `❌ You have reached your limit of 2 rented bots.\n\nUse *${P}delbot <number>* to delete an existing one before renting a new bot.`);
      return;
    }

    // Check if the target number is already rented or is the host bot
    if (allRented.some(b => b.number === digits)) {
      await sendReply(sock, msg, `❌ +${digits} is already an active rented bot.\n\nUse *${P}delbot ${digits}* to remove it first.`);
      return;
    }

    const myNum = String(sock?.user?.id || "").split("@")[0].split(":")[0].replace(/[^0-9]/g, "");
    if (digits === myNum) {
      await sendReply(sock, msg, "❌ You cannot rent the host bot's own number.");
      return;
    }

    const targetJid = `${digits}@s.whatsapp.net`;
    if (_rentPairingInFlight.has(targetJid)) {
      await sendReply(sock, msg, `⏳ Pairing for +${digits} is already in progress. Please complete the current pairing or wait for it to time out.`);
      return;
    }

    const chat = msg?.key?.remoteJid;
    _rentPairingInFlight.add(targetJid);

    // Initial output text: "renting bot to 236367228+++"
    let outputMsg = null;
    try {
      outputMsg = await sock.sendMessage(chat, {
        text: `⏳ Renting bot to +${digits}…`
      }, { quoted: msg });
    } catch (e) {
      console.warn("[rentbot] initial output message notice:", e?.message);
    }

    // Prepare session directory
    const tmpDir = sessionPaths.sessionDirFor(targetJid);
    try { fs.mkdirSync(tmpDir, { recursive: true }); } catch {}

    const ownerFile = path.join(tmpDir, ".owner.json");
    try {
      fs.writeFileSync(ownerFile, JSON.stringify({
        owner: "pairing",
        pid: process.pid,
        at: Date.now(),
      }), "utf8");
    } catch {}

    let sub = null;
    let isLinked = false;
    let cleanedUp = false;
    let liveMsg = null;

    const cleanup = (wipe = false) => {
      if (cleanedUp) return;
      cleanedUp = true;
      _rentPairingInFlight.delete(targetJid);
      if (sub) sub.__retired = true;
      try { sub?.ev?.removeAllListeners?.("creds.update"); } catch {}
      try { sub?.ev?.removeAllListeners?.("connection.update"); } catch {}
      try { sub?.ws?.close?.(); } catch {}
      try { sub?.ws?.socket?.terminate?.(); } catch {}
      try { sub?.end?.(undefined); } catch {}
      if (wipe) {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      }
    };

    const ownerNum = (CONFIG?.OWNER_NUMBER || "").replace(/[^0-9]/g, "");
    const ownerUrl = `https://wa.me/${ownerNum}`;

    // 2-minute deadline for pairing
    const pairTimeout = setTimeout(async () => {
      if (isLinked || cleanedUp) return;
      cleanup(true);
      if (liveMsg) {
        const failText = `❌ *Bot failed for @${digits}*

├ 👤 *User:* @${digits}
├ 📱 *Number:* +${digits}
├ ⚠️ *Status:* Pairing timed out after 2 minutes
└ 👑 *Owner:* _${ownerUrl}_`;
        try {
          await sock.sendMessage(chat, {
            text: failText,
            edit: liveMsg.key,
            mentions: [targetJid],
          });
        } catch {}
      }
    }, 120000);

    try {
      const { state, saveCreds } = await useMultiFileAuthState(tmpDir);
      let credentialWrites = Promise.resolve();
      const persistCreds = () => {
        const write = credentialWrites.catch(() => {}).then(() => {
          if (!cleanedUp) return saveCreds();
        });
        credentialWrites = write;
        return write;
      };

      let version = [2, 3000, 1015901307];
      if (typeof fetchLatestBaileysVersion === "function") {
        try {
          const v = await Promise.race([
            fetchLatestBaileysVersion(),
            new Promise((_, r) => setTimeout(() => r(new Error("timeout")), 3500))
          ]);
          if (v?.version) version = v.version;
        } catch {}
      }

      sub = makeWASocket({
        version,
        logger: (ctx.logger || silentLogger),
        printQRInTerminal: false,
        auth: { creds: state.creds, keys: state.keys },
        browser: (Browsers?.macOS) ? Browsers.macOS("Safari") : ["Mac OS", "Safari", "17.4.1"],
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: false,
        defaultQueryTimeoutMs: 60000,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 30000,
      });

      sub.ev.on("creds.update", () => {
        if (cleanedUp || sub.__retired) return;
        void persistCreds().catch(() => {});
      });

      sub.ev.on("connection.update", async (u) => {
        try {
          if (cleanedUp || sub.__retired) return;
          if (u.qr) sub.__pairingReady = true;

          if (u.connection === "open") {
            if (isLinked) return;
            isLinked = true;
            clearTimeout(pairTimeout);

            try {
              await companionSyncGrace.waitForCompanionSync({
                eventEmitter: sub.ev,
                saveCreds: persistCreds,
                minMs: process.env.COMPANION_SYNC_MIN_MS ? Number(process.env.COMPANION_SYNC_MIN_MS) : 12000,
                maxMs: 25000,
              });
              await persistCreds();

              // Generate SESSION_ID
              let creds = {};
              try {
                creds = JSON.parse(fs.readFileSync(path.join(tmpDir, "creds.json"), "utf8"));
              } catch {}
              const sessionId = "prezzy_" + Buffer.from(JSON.stringify(creds)).toString("base64");

              // 1) Automatically send session ID to person's DM
              let dmSessionMsg = null;
              try {
                dmSessionMsg = await sock.sendMessage(targetJid, {
                  text: `${sessionId}`
                });
              } catch (e) {
                console.warn("[rentbot] DM session ID notice:", e?.message);
              }

              // 2) Bot replies to it like "Starting up bot"
              try {
                await sock.sendMessage(targetJid, {
                  text: `🚀 Starting up bot...`
                }, dmSessionMsg ? { quoted: dmSessionMsg } : {});
              } catch (e) {
                console.warn("[rentbot] DM startup reply notice:", e?.message);
              }

              // 3) Mark session as handed off to bot
              ownership.handOffToBot(targetJid);

              // 4) Add to rented_bots registry
              const list = loadRentedBots().filter(b => b.number !== digits);
              list.push({
                number: digits,
                jid: targetJid,
                renterJid: senderJid,
                renterNumber: senderNum,
                username: digits,
                rentedAt: Date.now(),
                sessionDir: tmpDir,
                status: "live",
              });
              saveRentedBots(list);

              // 5) Dispatch launch request to the parent launcher process
              dispatchAdminRequest({ action: "launch", jid: targetJid, sessionDir: tmpDir });
              console.log(`[rentbot] Rented bot +${digits} launch request dispatched.`);

              // 6) Edit the live tracking message:
              // "bot is live for username ... url of the owner should become little small ... has tree line"
              const dateStr = new Date().toLocaleString("en-US", {
                timeZone: "Africa/Lagos",
                dateStyle: "medium",
                timeStyle: "short",
              });

              const liveSuccessText = `🤖 *Bot is live for @${digits}*

├ 👤 *User:* @${digits}
├ 📱 *Number:* +${digits}
├ ⚡ *Status:* Online & Active
├ ⏱️ *Rented At:* ${dateStr}
└ 👑 *Owner:* _${ownerUrl}_`;

              if (liveMsg) {
                await sock.sendMessage(chat, {
                  text: liveSuccessText,
                  edit: liveMsg.key,
                  mentions: [targetJid],
                });
              } else {
                await sock.sendMessage(chat, {
                  text: liveSuccessText,
                  mentions: [targetJid],
                });
              }
            } catch (err) {
              console.error("[rentbot] Error completing link:", err);
              if (liveMsg) {
                const failText = `❌ *Bot failed for @${digits}*

├ 👤 *User:* @${digits}
├ 📱 *Number:* +${digits}
├ ⚠️ *Error:* ${err?.message || "Setup failed"}
└ 👑 *Owner:* _${ownerUrl}_`;
                await sock.sendMessage(chat, {
                  text: failText,
                  edit: liveMsg.key,
                  mentions: [targetJid],
                });
              }
            } finally {
              cleanup(false);
            }
          } else if (u.connection === "close") {
            const sc = u.lastDisconnect?.error?.output?.statusCode;
            if (sc === 401 && !isLinked) {
              clearTimeout(pairTimeout);
              cleanup(true);
              if (liveMsg) {
                const failText = `❌ *Bot failed for @${digits}*

├ 👤 *User:* @${digits}
├ 📱 *Number:* +${digits}
├ ⚠️ *Reason:* Pairing was rejected or unlinked
└ 👑 *Owner:* _${ownerUrl}_`;
                await sock.sendMessage(chat, {
                  text: failText,
                  edit: liveMsg.key,
                  mentions: [targetJid],
                });
              }
            }
          }
        } catch (e) {
          console.error("[rentbot] connection.update handler error:", e);
        }
      });

      // Wait for socket open & pairing ready
      if (!await pairingHandshake.waitForSocketOpen(sub, 35000)) {
        throw new Error("Could not reach WhatsApp servers. Please retry.");
      }
      if (!await pairingHandshake.waitForPairingReady(sub, 35000)) {
        throw new Error("WhatsApp registration handshake timed out. Please retry.");
      }

      // Request pairing code
      let code = null;
      let reqTimer;
      try {
        code = await Promise.race([
          sub.requestPairingCode(digits),
          new Promise((_, reject) => {
            reqTimer = setTimeout(() => reject(new Error("Pairing code request timed out")), 20000);
          })
        ]);
      } finally {
        clearTimeout(reqTimer);
      }

      if (!code) throw new Error("WhatsApp did not return a pairing code.");
      const rawCode = String(code).trim();

      // "then delete the output and drop pair code to the person"
      if (outputMsg?.key) {
        try {
          await sock.sendMessage(chat, { delete: outputMsg.key });
        } catch {}
      }

      // Drop pair code in chat for 1-tap copy
      await sock.sendMessage(chat, {
        text: `${rawCode}`
      }, { quoted: msg });

      // If called elsewhere, also send code directly to person's DM
      if (targetJid !== chat) {
        try {
          await sock.sendMessage(targetJid, {
            text: `🔑 *Your Rentbot Pairing Code:* ${rawCode}\n\nEnter this code in WhatsApp > Linked Devices to link your rented bot.`
          });
        } catch {}
      }

      // Drop the live tracking message that will be edited when connected
      liveMsg = await sock.sendMessage(chat, {
        text: `⏳ *Pairing in progress for +${digits}*\nEnter code *${rawCode}* on WhatsApp Linked Devices within 2 minutes…`
      });

    } catch (err) {
      clearTimeout(pairTimeout);
      cleanup(true);
      if (outputMsg?.key) {
        try { await sock.sendMessage(chat, { delete: outputMsg.key }); } catch {}
      }
      await sendReply(sock, msg, `❌ Could not start rentbot for +${digits}: ${err?.message || err}`);
    }
  });

  // ── 2) .delbot <phone_number> ─────────────────────────────────────────────
  cmd(["delbot"], { desc: "Delete a rented bot anytime by number", category: "RENTBOT" }, async (sock, msg, args) => {
    const digits = String(args?.[0] || "").replace(/[^0-9]/g, "");
    if (!digits || digits.length < 7) {
      await sendReply(sock, msg, `Usage: *${P}delbot <number>*\nExample: *${P}delbot 2348012345678*`);
      return;
    }

    const sender = (typeof getSender === "function") ? getSender(msg) : (msg?.key?.participant || msg?.key?.remoteJid);
    const senderNum = String(sender || "").split("@")[0].split(":")[0].replace(/[^0-9]/g, "");
    const senderJid = senderNum ? `${senderNum}@s.whatsapp.net` : String(sender || "");
    const canAdmin = (typeof isOwner === "function" && isOwner(sender)) || (typeof isCreator === "function" && isCreator(sender));

    const list = loadRentedBots();
    const entry = list.find(b => b.number === digits);
    if (!entry) {
      await sendReply(sock, msg, `❌ +${digits} is not currently registered in the rented bots list.`);
      return;
    }

    // Permission check: only the user who rented it or bot owner/creator can delete it
    const isRenter = entry.renterNumber === senderNum || entry.renterJid === senderJid;
    if (!isRenter && !canAdmin) {
      await sendReply(sock, msg, "🚫 You can only delete bots that you rented.");
      return;
    }

    await sendReply(sock, msg, `⏳ Deleting rented bot for +${digits}…`);

    const targetJid = `${digits}@s.whatsapp.net`;

    // 1. Stop running child process via admin-request
    dispatchAdminRequest({ action: "delbot", number: digits, jid: targetJid });

    // 2. Release ownership marker
    try { ownership.release(targetJid); } catch {}

    // 3. Purge session from disk
    const sDir = entry.sessionDir || sessionPaths.sessionDirFor(targetJid);
    try {
      if (sDir && fs.existsSync(sDir)) {
        fs.rmSync(sDir, { recursive: true, force: true });
      }
    } catch {}

    // 4. Remove from rented_bots.json
    const updated = list.filter(b => b.number !== digits);
    saveRentedBots(updated);

    await sendReply(sock, msg, `✅ Successfully deleted rented bot for +${digits}.`);
  });

  // ── 3) .listbot and ..listbot ─────────────────────────────────────────────
  cmd(["listbot", ".listbot"], { desc: "Check rented bots list", category: "RENTBOT" }, async (sock, msg) => {
    const sender = (typeof getSender === "function") ? getSender(msg) : (msg?.key?.participant || msg?.key?.remoteJid);
    const senderNum = String(sender || "").split("@")[0].split(":")[0].replace(/[^0-9]/g, "");
    const senderJid = senderNum ? `${senderNum}@s.whatsapp.net` : String(sender || "");
    const canAdmin = (typeof isOwner === "function" && isOwner(sender)) || (typeof isCreator === "function" && isCreator(sender));

    const all = loadRentedBots();
    // Bot owners can see all rented bots; normal users see their own rented bots
    const visible = canAdmin ? all : all.filter(b => b.renterNumber === senderNum || b.renterJid === senderJid);

    if (!visible.length) {
      await sendReply(sock, msg, `📭 No active rented bots found.\n\nUse *${P}rentbot <number>* to rent a bot (max 2).`);
      return;
    }

    const lines = visible.map((b, i) => {
      const date = new Date(b.rentedAt).toLocaleDateString("en-US", {
        timeZone: "Africa/Lagos",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
      return `├ [${i + 1}] +${b.number} (@${b.username || b.number})\n├ ⚡ Status: ${b.status || "Active"}\n└ ⏱️ Rented: ${date}`;
    });

    const header = `📋 *RENTED BOTS (${visible.length}/2)*\n\n`;
    const footer = `\n\n_Delete with ${P}delbot <number>_`;
    await sendReply(sock, msg, header + lines.join("\n\n") + footer);
  });
}
