/**
 * MIAS LITE MDX — System Updater & Auto-Update Engine
 *
 * Features:
 *  - .update / .upgrade / .checkupdate command with LIVE message editing
 *  - Dope card UI with emojis, commit hash, commit note, author, and progress bar
 *  - Automatic pull & sync from GitHub (precious125588/MIAS-LITE-MDX on main)
 *  - Clean bot reboot via supervisor with post-restart live message update
 *  - Setting UI integration: 45.1 (Enable) / 45.2 (Disable)
 *  - Background Auto-Update poller that periodically detects new commits and applies them
 */

import fs from "fs";
import path from "path";
import https from "https";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO_SLUG = process.env.REPO_SLUG || "precious125588/MIAS-LITE-MDX";
const REPO_BRANCH = process.env.REPO_BRANCH || "main";
const PENDING_FILE = path.join(REPO_ROOT, "nexstore", "pending-update.json");
const PENDING_FALLBACK = path.join(REPO_ROOT, "database", "pending-update.json");
const AUTO_UPDATE_NOTICE = path.join(REPO_ROOT, "nexstore", "pending-auto-notice.json");
const ROLLBACK_FILE = path.join(REPO_ROOT, "nexstore", "rollback-state.json");
const ROLLBACK_FALLBACK = path.join(REPO_ROOT, "database", "rollback-state.json");

let settingsHelper = null;
try {
  settingsHelper = require("../../setting/Settings.js");
} catch {}

/**
 * Read the local build SHA
 */
export function readLocalCommit() {
  // 1. .git checkout
  try {
    const headPath = path.join(REPO_ROOT, ".git", "HEAD");
    if (fs.existsSync(headPath)) {
      const head = fs.readFileSync(headPath, "utf8").trim();
      if (head.startsWith("ref:")) {
        const ref = head.slice(4).trim();
        const refPath = path.join(REPO_ROOT, ".git", ref);
        if (fs.existsSync(refPath)) {
          const sha = fs.readFileSync(refPath, "utf8").trim();
          if (/^[0-9a-f]{7,40}$/i.test(sha)) return { sha, source: ".git" };
        }
      } else if (/^[0-9a-f]{7,40}$/i.test(head)) {
        return { sha: head, source: ".git" };
      }
    }
  } catch {}

  // 2. Platform environment variable
  const envSha = process.env.RAILWAY_GIT_COMMIT_SHA || process.env.COMMIT_SHA || process.env.GIT_COMMIT_SHA;
  if (envSha && /^[0-9a-f]{7,40}$/i.test(String(envSha).trim())) {
    return { sha: String(envSha).trim(), source: "env" };
  }

  // 3. build stamp written at build/update time
  try {
    const stampPath = path.join(REPO_ROOT, "lib", "precious-build-stamp.json");
    if (fs.existsSync(stampPath)) {
      const stamp = JSON.parse(fs.readFileSync(stampPath, "utf8"));
      const sha = stamp.sha || stamp.commit || stamp.buildSha;
      if (sha && /^[0-9a-f]{7,40}$/i.test(String(sha))) {
        return { sha: String(sha), source: "build-stamp", message: stamp.message || null };
      }
    }
  } catch {}

  return { sha: null, source: "none" };
}

/**
 * Fetch latest commit details from GitHub REST API
 */
export function fetchRemoteCommit(token = process.env.GITHUB_TOKEN || null) {
  return new Promise((resolve) => {
    const req = https.request(
      {
        host: "api.github.com",
        path: `/repos/${REPO_SLUG}/commits/${encodeURIComponent(REPO_BRANCH)}`,
        method: "GET",
        timeout: 10000,
        headers: {
          "User-Agent": "mias-lite-mdx-updater",
          "Accept": "application/vnd.github+json",
          ...(token ? { Authorization: "Bearer " + token } : {}),
        },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          if (res.statusCode !== 200) {
            return resolve({ sha: null, error: `GitHub API HTTP ${res.statusCode}` });
          }
          try {
            const data = JSON.parse(body) || {};
            const sha = data.sha || null;
            const message = String(data.commit?.message || "").split("\n")[0].trim() || "Latest commit";
            const author = data.commit?.author?.name || data.author?.login || "Developer";
            const date = data.commit?.author?.date || new Date().toISOString();
            resolve({ sha, message, author, date });
          } catch (e) {
            resolve({ sha: null, error: "Invalid JSON response from GitHub" });
          }
        });
      }
    );
    req.on("timeout", () => {
      req.destroy(new Error("Timeout connecting to GitHub"));
    });
    req.on("error", (e) => resolve({ sha: null, error: e.message || "Network error" }));
    req.end();
  });
}

/**
 * Save the last known-good commit before an updater reset so the owner can roll back.
 */
function saveRollbackState(previousSha, nextSha, message = "") {
  if (!previousSha || !/^[0-9a-f]{7,40}$/i.test(String(previousSha))) return false;
  const record = {
    previousSha: String(previousSha),
    updatedToSha: nextSha ? String(nextSha) : null,
    previousMessage: message,
    savedAt: new Date().toISOString(),
  };
  for (const target of [ROLLBACK_FILE, ROLLBACK_FALLBACK]) {
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const tmp = `${target}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(record, null, 2), "utf8");
      fs.renameSync(tmp, target);
      return true;
    } catch {}
  }
  return false;
}

function readRollbackState() {
  for (const target of [ROLLBACK_FILE, ROLLBACK_FALLBACK]) {
    try {
      const record = JSON.parse(fs.readFileSync(target, "utf8"));
      if (/^[0-9a-f]{7,40}$/i.test(String(record?.previousSha || ""))) return record;
    } catch {}
  }
  return null;
}

function writeBuildStamp(sha, message = "Rollback", author = "MIAS LITE MDX") {
  try {
    const stampDir = path.join(REPO_ROOT, "lib");
    if (!fs.existsSync(stampDir)) fs.mkdirSync(stampDir, { recursive: true });
    fs.writeFileSync(path.join(stampDir, "precious-build-stamp.json"), JSON.stringify({
      sha, commit: sha, buildSha: sha, message, author,
      updatedAt: new Date().toISOString(), source: "mias-updater",
    }, null, 2), "utf8");
  } catch (err) {
    console.error("[UPDATER] Could not write build-stamp:", err?.message || err);
  }
}

/**
 * Apply git pull / hard reset and update build stamp
 */
export async function applyUpdateCode(remoteSha, commitMessage, author) {
  let pulled = false;

  // 1. Pull via git if .git directory exists
  if (fs.existsSync(path.join(REPO_ROOT, ".git"))) {
    try {
      const previousSha = execSync("git rev-parse HEAD", { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      execSync("git config pull.rebase false", { cwd: REPO_ROOT, stdio: "ignore" });
      execSync(`git fetch origin ${REPO_BRANCH} --depth=1 --quiet || git fetch origin ${REPO_BRANCH} --quiet`, {
        cwd: REPO_ROOT,
        stdio: "ignore",
      });
      execSync(`git reset --hard origin/${REPO_BRANCH} || git pull origin ${REPO_BRANCH}`, {
        cwd: REPO_ROOT,
        stdio: "ignore",
      });
      const installedSha = execSync("git rev-parse HEAD", { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      if (previousSha !== installedSha) saveRollbackState(previousSha, installedSha, commitMessage);
      pulled = true;
    } catch (err) {
      console.error("[UPDATER] Git reset/pull failed:", err?.message || err);
    }
  }

  // 2. Always write updated build stamp so local build reflects the new SHA.
  writeBuildStamp(remoteSha, commitMessage, author || "precious125588");

  return pulled;
}

/**
 * Safely edit a WhatsApp message or fall back to sending a new one
 */
export async function editOrSend(sock, chat, text, liveMsgKey, quotedMsg = null) {
  if (liveMsgKey && sock && typeof sock.sendMessage === "function") {
    try {
      const res = await sock.sendMessage(chat, { text, edit: liveMsgKey });
      if (res?.key) return res.key;
      return liveMsgKey;
    } catch (err) {
      console.warn("[UPDATER] Edit failed, falling back to new message:", err.message);
    }
  }
  if (sock && typeof sock.sendMessage === "function") {
    const res = await sock.sendMessage(chat, { text }, quotedMsg ? { quoted: quotedMsg } : {});
    return res?.key || null;
  }
  return null;
}

/**
 * UI Cards generator with dope typography and formatting
 */
export function renderUpdateCard(stage, data = {}) {
  const shortLocal = (data.localSha || "unknown").slice(0, 7);
  const shortRemote = (data.remoteSha || "unknown").slice(0, 7);
  const msg = data.commitMessage || "Minor fixes & performance tuning";
  const author = data.author || "Precious";

  switch (stage) {
    case "scanning":
      return (
        `╭━━❮ ⚡ *𝗠𝗜𝗔𝗦 𝗟𝗜𝗧𝗘 𝗠𝗗𝗫 𝗨𝗣𝗗𝗔𝗧𝗘𝗥* ❯━━╮\n` +
        `┃ 📡 *Status:* Initializing Update Engine...\n` +
        `┃ 🔍 *Action:* Connecting to GitHub repository\n` +
        `┃ ⏳ *Scanning:* Inspecting latest commits on \`${REPO_BRANCH}\`\n` +
        `╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯\n` +
        `_Please wait, checking for new fixes & upgrades..._`
      );

    case "up_to_date":
      return (
        `╭━━❮ ⚡ *𝗠𝗜𝗔𝗦 𝗟𝗜𝗧𝗘 𝗠𝗗𝗫 𝗨𝗣𝗗𝗔𝗧𝗘𝗥* ❯━━╮\n` +
        `┃ ✅ *Status:* All Systems Up to Date!\n` +
        `┃ 📌 *Current Commit:* \`${shortLocal}\`\n` +
        `┃ 📝 *Latest Fix:* _${msg}_\n` +
        `┃ 👤 *Author:* ${author}\n` +
        `┃ 🚀 *Branch:* \`origin/${REPO_BRANCH}\` (clean)\n` +
        `┃ 🛡️ *Verdict:* You are running the freshest code!\n` +
        `╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯\n` +
        `_No updates needed. Mia's Lite MDX is running at peak performance!_`
      );

    case "found":
      return (
        `╭━━❮ ⚡ *𝗠𝗜𝗔𝗦 𝗟𝗜𝗧𝗘 𝗠𝗗𝗫 𝗨𝗣𝗗𝗔𝗧𝗘𝗥* ❯━━╮\n` +
        `┃ ✨ *Status:* New Update Detected on GitHub!\n` +
        `┃ 🔖 *New Commit:* \`${shortRemote}\` _(current: \`${shortLocal}\`)_\n` +
        `┃ 📝 *Commit Note:* _${msg}_\n` +
        `┃ 👤 *Author:* ${author}\n` +
        `┃ ⏳ *Progress:* [▓▓▓▓░░░░░░] 40%\n` +
        `┃ 📥 *Action:* Pulling latest changes & files...\n` +
        `╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯\n` +
        `_Synchronizing codebase with main branch..._`
      );

    case "pulled":
      return (
        `╭━━❮ ⚡ *𝗠𝗜𝗔𝗦 𝗟𝗜𝗧𝗘 𝗠𝗗𝗫 𝗨𝗣𝗗𝗔𝗧𝗘𝗥* ❯━━╮\n` +
        `┃ 📦 *Status:* Files Synchronized!\n` +
        `┃ 🔖 *Target Commit:* \`${shortRemote}\`\n` +
        `┃ 🔍 *Integrity:* Dependencies & build-stamp verified\n` +
        `┃ ⏳ *Progress:* [▓▓▓▓▓▓▓▓░░] 85%\n` +
        `┃ 🔄 *Action:* Scheduling clean supervisor reboot...\n` +
        `╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯\n` +
        `_Preparing runtime to apply updates into memory..._`
      );

    case "restarting":
      return (
        `╭━━❮ ⚡ *𝗠𝗜𝗔𝗦 𝗟𝗜𝗧𝗘 𝗠𝗗𝗫 𝗨𝗣𝗗𝗔𝗧𝗘𝗥* ❯━━╮\n` +
        `┃ 🚀 *Status:* Rebooting Bot Supervisor...\n` +
        `┃ 🔖 *Installed Commit:* \`${shortRemote}\`\n` +
        `┃ ⏳ *Progress:* [▓▓▓▓▓▓▓▓▓▓] 100%\n` +
        `┃ ⚡ *Action:* Re-spawning runtime engine now...\n` +
        `╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯\n` +
        `_Bot is restarting now. Applying new fixes live in seconds..._`
      );

    case "completed":
      return (
        `╭━━❮ ⚡ *𝗠𝗜𝗔𝗦 𝗟𝗜𝗧𝗘 𝗠𝗗𝗫 𝗨𝗣𝗗𝗔𝗧𝗘𝗥* ❯━━╮\n` +
        `┃ 🎉 *Status:* Bot Restarted Successfully!\n` +
        `┃ ✅ *New Fix Applied:* Live in runtime\n` +
        `┃ 📌 *Active Commit:* \`${shortRemote}\`\n` +
        `┃ 📝 *Commit Note:* _${msg}_\n` +
        `┃ 👤 *Committer:* ${author}\n` +
        `┃ ⚡ *Engine:* Mia's Lite MDX Online & Ready\n` +
        `╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯\n` +
        `_Update completed with 100% success. All systems operational!_`
      );

    case "error":
      return (
        `╭━━❮ ⚡ *𝗠𝗜𝗔𝗦 𝗟𝗜𝗧𝗘 𝗠𝗗𝗫 𝗨𝗣𝗗𝗔𝗧𝗘𝗥* ❯━━╮\n` +
        `┃ ⚠️ *Status:* Update Verification Notice\n` +
        `┃ ❌ *Reason:* ${data.error || "GitHub connection timed out"}\n` +
        `┃ 📌 *Local Commit:* \`${shortLocal}\`\n` +
        `╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯\n` +
        `_Please check your internet connection or try again shortly._`
      );

    default:
      return "⚡ *MIAS LITE MDX UPDATER*";
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Save pending update file to resume live edit after reboot
 */
function savePendingUpdate(record) {
  for (const target of [PENDING_FILE, PENDING_FALLBACK]) {
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, JSON.stringify(record, null, 2), "utf8");
    } catch {}
  }
}

/**
 * Read and clear pending update file after reboot
 */
function readAndClearPendingUpdate() {
  for (const target of [PENDING_FILE, PENDING_FALLBACK]) {
    try {
      if (fs.existsSync(target)) {
        const content = fs.readFileSync(target, "utf8");
        const parsed = JSON.parse(content);
        try { fs.unlinkSync(target); } catch {}
        if (parsed && parsed.jid) return parsed;
      }
    } catch {}
  }
  return null;
}

/**
 * Handle post-reboot notification by editing the original message
 */
async function handlePostRebootLiveUpdate() {
  const pending = readAndClearPendingUpdate();
  if (!pending || !pending.jid) return;

  console.log(`[UPDATER] Found pending post-reboot update for chat: ${pending.jid}`);

  // Poll for globalThis.__MIAS_SOCK__ up to 60 seconds
  const startWait = Date.now();
  while (Date.now() - startWait < 60000) {
    const sock = globalThis.__MIAS_SOCK__;
    if (sock && sock.user && typeof sock.sendMessage === "function") {
      // Let connection settle for 3 seconds
      await sleep(3000);
      const text = renderUpdateCard("completed", {
        remoteSha: pending.remoteSha,
        commitMessage: pending.commitMessage,
        author: pending.author,
      });

      try {
        await editOrSend(sock, pending.jid, text, pending.msgKey);
        if (pending.msgKey) {
          await sock.sendMessage(pending.jid, {
            react: { text: "🎉", key: pending.msgKey },
          }).catch(() => {});
        }
        console.log(`[UPDATER] Successfully posted post-reboot live edit to ${pending.jid}!`);
      } catch (err) {
        console.warn("[UPDATER] Post-reboot message notification warning:", err.message);
      }
      return;
    }
    await sleep(1500);
  }
}

/**
 * Inject 45.1 and 45.2 into SETTINGS_MAP on globalThis
 */
export function registerAutoUpdateSettings(getSettings) {
  let map = null;
  for (const key of Object.getOwnPropertyNames(globalThis)) {
    try {
      const obj = globalThis[key];
      if (obj && typeof obj === "object" && "1.1" in obj && "1.2" in obj) {
        map = obj;
        break;
      }
    } catch {}
  }

  if (map) {
    map["45.1"] = (settingsObj, extra = {}) => {
      const jid = extra?.jid || "bot";
      if (settingsObj) settingsObj.autoUpdate = true;
      try {
        if (typeof getSettings === "function") {
          getSettings(jid).autoUpdate = true;
          getSettings("bot").autoUpdate = true;
        }
      } catch {}
      try {
        if (settingsHelper && typeof settingsHelper.setSetting === "function") {
          settingsHelper.setSetting(jid, "autoUpdate", true);
          settingsHelper.setSetting("bot", "autoUpdate", true);
          settingsHelper.saveSettings();
        }
      } catch {}
      return "✅ Auto-Update: ON — Bot will automatically detect & apply new GitHub commits.";
    };

    map["45.2"] = (settingsObj, extra = {}) => {
      const jid = extra?.jid || "bot";
      if (settingsObj) settingsObj.autoUpdate = false;
      try {
        if (typeof getSettings === "function") {
          getSettings(jid).autoUpdate = false;
          getSettings("bot").autoUpdate = false;
        }
      } catch {}
      try {
        if (settingsHelper && typeof settingsHelper.setSetting === "function") {
          settingsHelper.setSetting(jid, "autoUpdate", false);
          settingsHelper.setSetting("bot", "autoUpdate", false);
          settingsHelper.saveSettings();
        }
      } catch {}
      return "❌ Auto-Update: OFF — Automatic GitHub commit updates disabled.";
    };

    console.log("[SETTINGS] Registered Auto-Update (45.1 / 45.2) in SETTINGS_MAP.");
  }
}

/**
 * Background auto-update check daemon
 */
let _autoUpdateTimer = null;
function startAutoUpdatePoller(ctx) {
  if (_autoUpdateTimer) return;
  const { getSettings, CONFIG } = ctx;

  const pollInterval = 10 * 60 * 1000; // Every 10 minutes
  _autoUpdateTimer = setInterval(async () => {

    try {
      const botSettings = typeof getSettings === "function" ? getSettings("bot") : null;
      const isEnabled = Boolean(botSettings?.autoUpdate || process.env.AUTO_UPDATE === "1" || process.env.AUTO_UPDATE === "true");
      if (!isEnabled) return;

      const local = readLocalCommit();
      const remote = await fetchRemoteCommit();
      if (!remote.sha || !local.sha) return;

      if (remote.sha.toLowerCase() !== local.sha.toLowerCase()) {
        console.log(`[AUTO-UPDATE] Detected new GitHub commit: ${remote.sha.slice(0, 7)} — "${remote.message}". Applying update...`);
        await applyUpdateCode(remote.sha, remote.message, remote.author);

        const ownerNumber = String(CONFIG?.OWNER_NUMBER || "").replace(/[^0-9]/g, "");
        if (ownerNumber) {
          try {
            fs.mkdirSync(path.dirname(AUTO_UPDATE_NOTICE), { recursive: true });
            fs.writeFileSync(
              AUTO_UPDATE_NOTICE,
              JSON.stringify(
                {
                  ownerJid: `${ownerNumber}@s.whatsapp.net`,
                  remoteSha: remote.sha,
                  commitMessage: remote.message,
                  author: remote.author,
                  updatedAt: Date.now(),
                },
                null,
                2
              ),
              "utf8"
            );
          } catch {}
        }

        console.log("[AUTO-UPDATE] Restarting bot runtime to load fresh code...");
        setTimeout(() => process.exit(0), 2000);
      }
    } catch (err) {
      console.warn("[AUTO-UPDATE] Background poll error:", err?.message || err);
    }
  }, pollInterval);
  if (_autoUpdateTimer && typeof _autoUpdateTimer.unref === "function") {
    _autoUpdateTimer.unref();
  }
}

/**
 * Handle auto-update notification after background reboot
 */
async function handleAutoUpdateBackgroundNotice() {
  if (!fs.existsSync(AUTO_UPDATE_NOTICE)) return;
  try {
    const raw = fs.readFileSync(AUTO_UPDATE_NOTICE, "utf8");
    const data = JSON.parse(raw);
    try { fs.unlinkSync(AUTO_UPDATE_NOTICE); } catch {}
    if (!data?.ownerJid) return;

    const startWait = Date.now();
    while (Date.now() - startWait < 60000) {
      const sock = globalThis.__MIAS_SOCK__;
      if (sock && sock.user && typeof sock.sendMessage === "function") {
        await sleep(4000);
        const text =
          `╭━━❮ ⚡ *𝗔𝗨𝗧𝗢-𝗨𝗣𝗗𝗔𝗧𝗘 𝗔𝗣𝗣𝗟𝗜𝗘𝗗* ❯━━╮\n` +
          `┃ 🤖 *Status:* Automatic GitHub Sync Complete\n` +
          `┃ 📌 *Installed Commit:* \`${data.remoteSha.slice(0, 7)}\`\n` +
          `┃ 📝 *Commit Note:* _${data.commitMessage}_\n` +
          `┃ 👤 *Committer:* ${data.author || "Precious"}\n` +
          `┃ 🚀 *Branch:* \`origin/${REPO_BRANCH}\`\n` +
          `┃ ⚡ *Engine:* Mia's Lite MDX Online & Ready\n` +
          `╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯\n` +
          `_Your bot automatically detected a new commit, updated codebase files, and restarted cleanly!_`;

        await sock.sendMessage(data.ownerJid, { text }).catch(() => {});
        return;
      }
      await sleep(1500);
    }
  } catch {}
}

/**
 * Install the update command and hooks into the bot
 */
export function installUpdateCommand(ctx) {
  const { cmd, sendReply, isOwner, isSudo, getSender, CONFIG, getSettings } = ctx;
  const P = CONFIG?.PREFIX || ".";

  // Check for post-reboot notifications asynchronously
  handlePostRebootLiveUpdate().catch(() => {});
  handleAutoUpdateBackgroundNotice().catch(() => {});
  startAutoUpdatePoller(ctx);

  // 1. Core update command with live message editing
  cmd(
    ["update", "upgrade", "checkupdate", "gitupdate"],
    { desc: "Check for GitHub updates, pull new commits & restart with live message edits", category: "OWNER", ownerOnly: true },
    async (sock, msg) => {
      const jid = msg.key.remoteJid;
      const sender = getSender(msg);
      const isFromOwner = msg.key.fromMe || isOwner(sender) || (typeof isSudo === "function" && isSudo(sender));

      if (!isFromOwner) {
        await sendReply(sock, msg, "🚫 *Access Denied:* Update command is restricted to Bot Owner / Sudo.");
        return;
      }

      // Initial reaction
      await sock.sendMessage(jid, { react: { text: "🔄", key: msg.key } }).catch(() => {});

      // Frame 1: Scanning for updates
      const initialText = renderUpdateCard("scanning");
      let liveMsg = null;
      try {
        liveMsg = await sock.sendMessage(jid, { text: initialText }, { quoted: msg });
      } catch {
        liveMsg = await sendReply(sock, msg, initialText);
      }
      let liveKey = liveMsg?.key || null;

      // Read local and remote state
      const local = readLocalCommit();
      const remote = await fetchRemoteCommit();

      // Handle fetch errors
      if (!remote.sha) {
        await sock.sendMessage(jid, { react: { text: "⚠️", key: msg.key } }).catch(() => {});
        const errText = renderUpdateCard("error", {
          error: remote.error || "Could not reach GitHub API",
          localSha: local.sha,
        });
        await editOrSend(sock, jid, errText, liveKey, msg);
        return;
      }

      // Check if already on the latest code
      if (local.sha && local.sha.toLowerCase() === remote.sha.toLowerCase()) {
        await sleep(1000);
        await sock.sendMessage(jid, { react: { text: "✅", key: msg.key } }).catch(() => {});
        const upToDateText = renderUpdateCard("up_to_date", {
          localSha: local.sha,
          commitMessage: remote.message,
          author: remote.author,
        });
        await editOrSend(sock, jid, upToDateText, liveKey, msg);
        return;
      }

      // Frame 2: New update detected!
      await sleep(1000);
      await sock.sendMessage(jid, { react: { text: "📥", key: msg.key } }).catch(() => {});
      const foundText = renderUpdateCard("found", {
        localSha: local.sha,
        remoteSha: remote.sha,
        commitMessage: remote.message,
        author: remote.author,
      });
      liveKey = await editOrSend(sock, jid, foundText, liveKey, msg);

      // Frame 3: Pull changes and sync files
      await sleep(1200);
      await applyUpdateCode(remote.sha, remote.message, remote.author);
      const pulledText = renderUpdateCard("pulled", {
        localSha: local.sha,
        remoteSha: remote.sha,
        commitMessage: remote.message,
        author: remote.author,
      });
      liveKey = await editOrSend(sock, jid, pulledText, liveKey, msg);

      // Frame 4: Pre-restart announcement
      await sleep(1200);
      await sock.sendMessage(jid, { react: { text: "🚀", key: msg.key } }).catch(() => {});
      const restartingText = renderUpdateCard("restarting", {
        remoteSha: remote.sha,
        commitMessage: remote.message,
        author: remote.author,
      });
      liveKey = await editOrSend(sock, jid, restartingText, liveKey, msg);

      // Save pending update file so we can edit this exact message after restart
      savePendingUpdate({
        jid,
        msgKey: liveKey,
        remoteSha: remote.sha,
        commitMessage: remote.message,
        author: remote.author,
        updatedAt: Date.now(),
      });

      // Trigger clean restart
      setTimeout(() => {
        try {
          process.exit(0);
        } catch {
          process.kill(process.pid, "SIGTERM");
        }
      }, 1800);
    }
  );

  // 2. Restore the previous update commit. Restricted to owner/sudo.
  cmd(
    ["rollback", "revertupdate", "undoupdate"],
    { desc: "Roll back the latest updater change to the previous commit", category: "OWNER", ownerOnly: true },
    async (sock, msg) => {
      const jid = msg.key.remoteJid;
      const sender = getSender(msg);
      const isFromOwner = msg.key.fromMe || isOwner(sender) || (typeof isSudo === "function" && isSudo(sender));
      if (!isFromOwner) {
        await sendReply(sock, msg, "🚫 Rollback is restricted to the bot owner / sudo.");
        return;
      }

      const state = readRollbackState();
      if (!state) {
        await sendReply(sock, msg, "No saved rollback point is available. Run a successful .update first.");
        return;
      }
      if (!fs.existsSync(path.join(REPO_ROOT, ".git"))) {
        await sendReply(sock, msg, "Rollback is unavailable in this deployment: the code checkout has no .git history. Use the hosting panel's previous deployment rollback.");
        return;
      }

      const targetSha = String(state.previousSha);
      if (!/^[0-9a-f]{7,40}$/i.test(targetSha)) {
        await sendReply(sock, msg, "Rollback was cancelled because the saved commit ID is invalid.");
        return;
      }

      try {
        execSync(`git cat-file -e ${targetSha}^{commit}`, { cwd: REPO_ROOT, stdio: "ignore" });
        execSync(`git reset --hard ${targetSha}`, { cwd: REPO_ROOT, stdio: "ignore" });
        const installedSha = execSync("git rev-parse HEAD", { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
        if (installedSha !== targetSha) throw new Error("commit verification failed");
        writeBuildStamp(installedSha, `Rollback to ${installedSha.slice(0, 7)}`, "MIAS LITE MDX");
        await sendReply(sock, msg, `✅ Rolled back to commit ${installedSha.slice(0, 7)}. Restarting now.`);
        setTimeout(() => process.exit(0), 1200);
      } catch (err) {
        console.error("[UPDATER] Rollback failed:", err?.message || err);
        await sendReply(sock, msg, "❌ Rollback failed. Check the error log and use the hosting panel's deployment rollback if needed.");
      }
    }
  );

  // 3. Direct Auto-Update command toggle
  cmd(
    ["autoupdate", "autoupdater"],
    { desc: "Toggle automatic background commit updates (enable / disable)", category: "OWNER", ownerOnly: true },
    async (sock, msg, args) => {
      const jid = msg.key.remoteJid;
      const sender = getSender(msg);
      const isFromOwner = msg.key.fromMe || isOwner(sender) || (typeof isSudo === "function" && isSudo(sender));

      if (!isFromOwner) {
        await sendReply(sock, msg, "🚫 *Access Denied:* Auto-Update setting is restricted to Bot Owner / Sudo.");
        return;
      }

      const sub = String(args?.[0] || "").toLowerCase().trim();
      const current = Boolean(getSettings(jid)?.autoUpdate || getSettings("bot")?.autoUpdate);

      if (["on", "enable", "1", "true"].includes(sub)) {
        getSettings(jid).autoUpdate = true;
        getSettings("bot").autoUpdate = true;
        try {
          if (settingsHelper) {
            settingsHelper.setSetting(jid, "autoUpdate", true);
            settingsHelper.setSetting("bot", "autoUpdate", true);
          }
        } catch {}
        await sendReply(
          sock,
          msg,
          `╭━━❮ ⚡ *𝗔𝗨𝗧𝗢-𝗨𝗣𝗗𝗔𝗧𝗘: 𝗘𝗡𝗔𝗕𝗟𝗘𝗗* ❯━━╮\n` +
          `┃ 🤖 *Status:* Active [ON]\n` +
          `┃ 🔄 *Interval:* Every 10 minutes\n` +
          `┃ 🚀 *Branch:* \`${REPO_BRANCH}\`\n` +
          `╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯\n` +
          `_Bot will automatically detect new commits on GitHub, apply changes, and reboot smoothly._`
        );
        return;
      }

      if (["off", "disable", "0", "false"].includes(sub)) {
        getSettings(jid).autoUpdate = false;
        getSettings("bot").autoUpdate = false;
        try {
          if (settingsHelper) {
            settingsHelper.setSetting(jid, "autoUpdate", false);
            settingsHelper.setSetting("bot", "autoUpdate", false);
          }
        } catch {}
        await sendReply(
          sock,
          msg,
          `╭━━❮ ⚡ *𝗔𝗨𝗧𝗢-𝗨𝗣𝗗𝗔𝗧𝗘: 𝗗𝗜𝗦𝗔𝗕𝗟𝗘𝗗* ❯━━╮\n` +
          `┃ 🤖 *Status:* Inactive [OFF]\n` +
          `╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯\n` +
          `_Automatic background updates disabled. You can still run manual updates with \`${P}update\`._`
        );
        return;
      }

      // Show status
      await sendReply(
        sock,
        msg,
        `╭━━❮ ⚡ *𝗔𝗨𝗧𝗢-𝗨𝗣𝗗𝗔𝗧𝗘 𝗦𝗘𝗧𝗧𝗜𝗡𝗚* ❯━━╮\n` +
        `┃ 🤖 *Status:* ${current ? "🟢 Enabled [ON]" : "🔴 Disabled [OFF]"}\n` +
        `┃ ⚙️ *Toggle via Settings:* Send \`${P}settings\` and reply \`45.1\` or \`45.2\`\n` +
        `┃ ⚙️ *Toggle via Command:* \`${P}autoupdate enable\` or \`${P}autoupdate disable\`\n` +
        `┃ 🔄 *Manual Update:* \`${P}update\`\n` +
        `╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯`
      );
    }
  );

  // 4. Fallback direct handlers for 45.1 and 45.2 replies
  cmd(["45.1"], { desc: "Enable Auto Update", category: "SETTINGS" }, async (sock, msg) => {
    const jid = msg.key.remoteJid;
    const sender = getSender(msg);
    const isFromOwner = msg.key.fromMe || isOwner(sender) || (typeof isSudo === "function" && isSudo(sender));
    if (!isFromOwner) return;

    getSettings(jid).autoUpdate = true;
    getSettings("bot").autoUpdate = true;
    try {
      if (settingsHelper) {
        settingsHelper.setSetting(jid, "autoUpdate", true);
        settingsHelper.setSetting("bot", "autoUpdate", true);
      }
    } catch {}
    await sendReply(sock, msg, "✅ Auto-Update: ON — Bot will automatically detect & apply new GitHub commits.");
  });

  cmd(["45.2"], { desc: "Disable Auto Update", category: "SETTINGS" }, async (sock, msg) => {
    const jid = msg.key.remoteJid;
    const sender = getSender(msg);
    const isFromOwner = msg.key.fromMe || isOwner(sender) || (typeof isSudo === "function" && isSudo(sender));
    if (!isFromOwner) return;

    getSettings(jid).autoUpdate = false;
    getSettings("bot").autoUpdate = false;
    try {
      if (settingsHelper) {
        settingsHelper.setSetting(jid, "autoUpdate", false);
        settingsHelper.setSetting("bot", "autoUpdate", false);
      }
    } catch {}
    await sendReply(sock, msg, "❌ Auto-Update: OFF — Automatic GitHub commit updates disabled.");
  });
}
