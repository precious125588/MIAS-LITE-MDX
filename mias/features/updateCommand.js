/**
 * MIAS LITE MDX — System Updater, Rollback & Auto-Update Engine
 *
 * Commands:
 *  - .update: Live-edited updater (Searching -> Found (commits with what fixed) -> Pulling -> Restarting -> Updated!)
 *  - .check-up: Live-edited update checker (Searching -> Found / Up to date)
 *  - .commits: Shows numbered list of recent commits for rollback
 *  - .rollback [number|sha]: Rollback to commit number from .commits or previous commit
 *  - .autoupdate [on|off]: Toggle background auto-update engine
 */

import fs from "fs";
import path from "path";
import https from "https";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { isStampOnlyChange } from "../lib/stampOnlyUpdate.mjs";
import { isBotIdle, MAX_DEFER_MS } from "../lib/botBusy.mjs";

const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO_SLUG = process.env.REPO_SLUG || "precious125588/MIAS-LITE-MDX";
const REPO_BRANCH = process.env.REPO_BRANCH || "main";

const PENDING_FILE = path.join(REPO_ROOT, "nexstore", "pending-update.json");
const PENDING_FALLBACK = path.join(REPO_ROOT, "database", "pending-update.json");
const PENDING_ROLLBACK_FILE = path.join(REPO_ROOT, "nexstore", "pending-rollback.json");
const PENDING_ROLLBACK_FALLBACK = path.join(REPO_ROOT, "database", "pending-rollback.json");
const AUTO_UPDATE_NOTICE = path.join(REPO_ROOT, "nexstore", "pending-auto-notice.json");
const ROLLBACK_FILE = path.join(REPO_ROOT, "nexstore", "rollback-state.json");
const ROLLBACK_FALLBACK = path.join(REPO_ROOT, "database", "rollback-state.json");
const RECENT_COMMITS_CACHE = path.join(REPO_ROOT, "nexstore", "recent-commits.json");

let settingsHelper = null;
try {
  settingsHelper = require("../../setting/Settings.js");
} catch {}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
          if (/^[0-9a-f]{7,40}$/i.test(sha)) return { sha: sha.toLowerCase(), source: ".git" };
        }
      } else if (/^[0-9a-f]{7,40}$/i.test(head)) {
        return { sha: head.toLowerCase(), source: ".git" };
      }
    }
  } catch {}

  // 2. Platform environment variable
  const envSha = process.env.RAILWAY_GIT_COMMIT_SHA || process.env.COMMIT_SHA || process.env.GIT_COMMIT_SHA;
  if (envSha && /^[0-9a-f]{7,40}$/i.test(String(envSha).trim())) {
    return { sha: String(envSha).trim().toLowerCase(), source: "env" };
  }

  // 3. Build stamp written at build/update time
  try {
    const stampPath = path.join(REPO_ROOT, "lib", "precious-build-stamp.json");
    if (fs.existsSync(stampPath)) {
      const stamp = JSON.parse(fs.readFileSync(stampPath, "utf8"));
      const sha = stamp.sha || stamp.commit || stamp.buildSha;
      if (sha && /^[0-9a-f]{7,40}$/i.test(String(sha))) {
        return { sha: String(sha).toLowerCase(), source: "build-stamp", message: stamp.message || null };
      }
    }
  } catch {}

  return { sha: null, source: "none" };
}

/**
 * Files changed between two commits. Returns { files } when GitHub answered,
 * { unknown: true } when the commits cannot be compared (treated as a code change),
 * or null on a transient failure (the poller retries on its next cycle).
 */
export function fetchChangedFiles(baseSha, headSha, token = process.env.GITHUB_TOKEN || null) {
  return new Promise((resolve) => {
    const req = https.request(
      {
        host: "api.github.com",
        path: `/repos/${REPO_SLUG}/compare/${encodeURIComponent(baseSha)}...${encodeURIComponent(headSha)}`,
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
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => {
          if (res.statusCode === 404 || res.statusCode === 422) return resolve({ unknown: true });
          if (res.statusCode !== 200) return resolve(null);
          try {
            const files = (JSON.parse(body)?.files || []).map((f) => f.filename);
            // GitHub lists at most 300 files; a longer list cannot prove the change is stamp-only.
            if (files.length >= 300) return resolve({ unknown: true });
            resolve({ files });
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => req.destroy());
    req.end();
  });
}

/**
 * Fetch latest commit details from GitHub REST API
 */
export function fetchRemoteCommit(token = process.env.GITHUB_TOKEN || null) {
  return new Promise((resolve) => {
    const req = https.request(
      {
        host: "api.github.com",
        path: `/repos/${REPO_SLUG}/commits?sha=${encodeURIComponent(REPO_BRANCH)}&per_page=10`,
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
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => {
          if (res.statusCode !== 200) {
            return resolve({ sha: null, error: `GitHub API HTTP ${res.statusCode}` });
          }
          try {
            const parsed = JSON.parse(body);
            const list = Array.isArray(parsed) ? parsed : [];
            const head = list[0];
            const sha = (head?.sha || "").toLowerCase() || null;
            // The build-stamp commit sits on top of every code commit; report the real change instead.
            const real = list.find((c) => !isStampCommitMessage(c?.commit?.message)) || head;
            const message = String(real?.commit?.message || "").split("\n")[0].trim() || "Latest commit";
            const author = real?.commit?.author?.name || real?.author?.login || "Developer";
            const date = real?.commit?.author?.date || new Date().toISOString();
            resolve({ sha, message, author, date });
          } catch {
            resolve({ sha: null, error: "Invalid JSON response from GitHub" });
          }
        });
      }
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ sha: null, error: "Timeout connecting to GitHub" });
    });
    req.on("error", (e) => resolve({ sha: null, error: e.message || "Network error" }));
    req.end();
  });
}

/** True for the automatic build-stamp commit, which carries no fix of its own. */
export function isStampCommitMessage(message) {
  return /^chore: refresh build stamp/i.test(String(message || "").trim());
}

/**
 * Every real commit message between two commits, newest first, build-stamp commits left out.
 * Returns [] when GitHub cannot compare them.
 */
export function fetchFixes(baseSha, headSha, token = process.env.GITHUB_TOKEN || null) {
  return new Promise((resolve) => {
    const req = https.request(
      {
        host: "api.github.com",
        path: `/repos/${REPO_SLUG}/compare/${encodeURIComponent(baseSha)}...${encodeURIComponent(headSha)}`,
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
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => {
          if (res.statusCode !== 200) return resolve([]);
          try {
            const commits = JSON.parse(body)?.commits || [];
            const fixes = commits
              .slice()
              .reverse()
              .map((c) => String(c?.commit?.message || "").split("\n")[0].trim())
              .filter((m) => m && !isStampCommitMessage(m));
            resolve([...new Set(fixes)].slice(0, 6));
          } catch {
            resolve([]);
          }
        });
      }
    );
    req.on("error", () => resolve([]));
    req.on("timeout", () => req.destroy());
    req.end();
  });
}

/**
 * Fetch list of recent commits from GitHub REST API (fallback to local git log)
 */
export function fetchRecentCommits(count = 10, token = process.env.GITHUB_TOKEN || null) {
  return new Promise((resolve) => {
    const req = https.request(
      {
        host: "api.github.com",
        path: `/repos/${REPO_SLUG}/commits?sha=${encodeURIComponent(REPO_BRANCH)}&per_page=${count}`,
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
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => {
          if (res.statusCode !== 200) {
            return resolve(fetchLocalCommits(count));
          }
          try {
            const data = JSON.parse(body) || [];
            if (!Array.isArray(data) || data.length === 0) {
              return resolve(fetchLocalCommits(count));
            }
            const commits = data.map((item) => ({
              sha: (item.sha || "").toLowerCase(),
              shortSha: (item.sha || "").slice(0, 7).toLowerCase(),
              message: String(item.commit?.message || "").split("\n")[0].trim() || "Commit",
              author: item.commit?.author?.name || item.author?.login || "Developer",
              date: item.commit?.author?.date || "",
            }));
            saveRecentCommitsCache(commits);
            resolve(commits);
          } catch {
            resolve(fetchLocalCommits(count));
          }
        });
      }
    );
    req.on("timeout", () => {
      req.destroy();
      resolve(fetchLocalCommits(count));
    });
    req.on("error", () => resolve(fetchLocalCommits(count)));
    req.end();
  });
}

/**
 * Fallback to read commits from local git history
 */
function fetchLocalCommits(count = 10) {
  try {
    if (fs.existsSync(path.join(REPO_ROOT, ".git"))) {
      const output = execSync(`git log -n ${count} --pretty=format:"%H|%s|%an|%cI"`, {
        cwd: REPO_ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const commits = output
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [sha, message, author, date] = line.split("|");
          return {
            sha: (sha || "").toLowerCase(),
            shortSha: (sha || "").slice(0, 7).toLowerCase(),
            message: (message || "Commit").trim(),
            author: (author || "Developer").trim(),
            date: date || "",
          };
        });
      if (commits.length > 0) saveRecentCommitsCache(commits);
      return commits;
    }
  } catch {}
  return readRecentCommitsCache();
}

function saveRecentCommitsCache(commits) {
  try {
    fs.mkdirSync(path.dirname(RECENT_COMMITS_CACHE), { recursive: true });
    fs.writeFileSync(RECENT_COMMITS_CACHE, JSON.stringify(commits, null, 2), "utf8");
  } catch {}
}

function readRecentCommitsCache() {
  try {
    if (fs.existsSync(RECENT_COMMITS_CACHE)) {
      const data = JSON.parse(fs.readFileSync(RECENT_COMMITS_CACHE, "utf8"));
      if (Array.isArray(data)) return data;
    }
  } catch {}
  return [];
}

/**
 * Save rollback state
 */
function saveRollbackState(previousSha, nextSha, message = "") {
  if (!previousSha || !/^[0-9a-f]{7,40}$/i.test(String(previousSha))) return false;
  const record = {
    previousSha: String(previousSha).toLowerCase(),
    updatedToSha: nextSha ? String(nextSha).toLowerCase() : null,
    previousMessage: message,
    savedAt: new Date().toISOString(),
  };
  for (const target of [ROLLBACK_FILE, ROLLBACK_FALLBACK]) {
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, JSON.stringify(record, null, 2), "utf8");
      return true;
    } catch {}
  }
  return false;
}

function readRollbackState() {
  for (const target of [ROLLBACK_FILE, ROLLBACK_FALLBACK]) {
    try {
      if (fs.existsSync(target)) {
        const record = JSON.parse(fs.readFileSync(target, "utf8"));
        if (/^[0-9a-f]{7,40}$/i.test(String(record?.previousSha || ""))) return record;
      }
    } catch {}
  }
  return null;
}

function writeBuildStamp(sha, message = "Rollback", author = "MIAS LITE MDX") {
  try {
    const stampDir = path.join(REPO_ROOT, "lib");
    const stampFile = path.join(stampDir, "precious-build-stamp.json");
    if (!fs.existsSync(stampDir)) fs.mkdirSync(stampDir, { recursive: true });
    let existing = {};
    if (fs.existsSync(stampFile)) {
      try {
        existing = JSON.parse(fs.readFileSync(stampFile, "utf8"));
      } catch {}
    }
    fs.writeFileSync(
      stampFile,
      JSON.stringify(
        {
          ...existing,
          sha: String(sha).toLowerCase(),
          commit: String(sha).toLowerCase(),
          buildSha: String(sha).toLowerCase(),
          message,
          author,
          updatedAt: new Date().toISOString(),
          source: "mias-updater",
        },
        null,
        2
      ),
      "utf8"
    );
  } catch (err) {
    console.error("[UPDATER] Could not write build-stamp:", err?.message || err);
  }
}

/**
 * Apply git pull / hard reset and update build stamp
 */
export async function applyUpdateCode(remoteSha, commitMessage, author) {
  let pulled = false;

  if (fs.existsSync(path.join(REPO_ROOT, ".git"))) {
    try {
      const previousSha = execSync("git rev-parse HEAD", {
        cwd: REPO_ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim().toLowerCase();

      execSync("git config pull.rebase false", { cwd: REPO_ROOT, stdio: "ignore" });
      execSync(`git fetch origin ${REPO_BRANCH} --quiet`, { cwd: REPO_ROOT, stdio: "ignore" });
      execSync(`git reset --hard origin/${REPO_BRANCH}`, { cwd: REPO_ROOT, stdio: "ignore" });

      const installedSha = execSync("git rev-parse HEAD", {
        cwd: REPO_ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim().toLowerCase();

      if (previousSha !== installedSha) {
        saveRollbackState(previousSha, installedSha, commitMessage);
      }
      pulled = true;
    } catch (err) {
      console.error("[UPDATER] Git reset/pull failed:", err?.message || err);
    }
  }

  writeBuildStamp(remoteSha, commitMessage, author || "precious125588");
  return pulled;
}

/**
 * Apply git rollback to target commit
 */
export function applyRollbackCode(targetSha, commitMessage = "Rollback") {
  let success = false;
  if (fs.existsSync(path.join(REPO_ROOT, ".git"))) {
    try {
      execSync(`git fetch origin ${REPO_BRANCH} --quiet`, { cwd: REPO_ROOT, stdio: "ignore" });
      execSync(`git reset --hard ${targetSha}`, { cwd: REPO_ROOT, stdio: "ignore" });
      const installedSha = execSync("git rev-parse HEAD", {
        cwd: REPO_ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim().toLowerCase();

      if (installedSha.startsWith(targetSha.slice(0, 7).toLowerCase())) {
        success = true;
        writeBuildStamp(installedSha, commitMessage, "MIAS LITE MDX");
      }
    } catch (err) {
      console.error("[UPDATER] Git rollback failed:", err?.message || err);
    }
  } else {
    // If no .git, write build stamp
    writeBuildStamp(targetSha, commitMessage, "MIAS LITE MDX");
    success = true;
  }
  return success;
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
 * Save pending rollback file to resume live edit after reboot
 */
function savePendingRollback(record) {
  for (const target of [PENDING_ROLLBACK_FILE, PENDING_ROLLBACK_FALLBACK]) {
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, JSON.stringify(record, null, 2), "utf8");
    } catch {}
  }
}

function readAndClearPendingRollback() {
  for (const target of [PENDING_ROLLBACK_FILE, PENDING_ROLLBACK_FALLBACK]) {
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
 * Handle post-reboot notification for .update by editing the original message
 */
async function handlePostRebootLiveUpdate() {
  const pending = readAndClearPendingUpdate();
  if (!pending || !pending.jid) return;

  const startWait = Date.now();
  while (Date.now() - startWait < 60000) {
    const sock = globalThis.__MIAS_SOCK__;
    if (sock && sock.user && typeof sock.sendMessage === "function") {
      await sleep(2500);
      const shortSha = (pending.remoteSha || "").slice(0, 7);
      const text =
        `✅ *Update applied successfully!*\n` +
        `📌 *Commit:* \`${shortSha}\`\n` +
        `📝 *Fixed:* _${pending.commitMessage || "Latest fixes"}_`;

      try {
        await editOrSend(sock, pending.jid, text, pending.msgKey);
        if (pending.msgKey) {
          await sock.sendMessage(pending.jid, { react: { text: "🎉", key: pending.msgKey } }).catch(() => {});
        }
      } catch (err) {
        console.warn("[UPDATER] Post-reboot live edit warning:", err.message);
      }
      return;
    }
    await sleep(1500);
  }
}

/**
 * Handle post-reboot notification for .rollback by editing the original message
 */
async function handlePostRollbackLiveUpdate() {
  const pending = readAndClearPendingRollback();
  if (!pending || !pending.jid) return;

  const startWait = Date.now();
  while (Date.now() - startWait < 60000) {
    const sock = globalThis.__MIAS_SOCK__;
    if (sock && sock.user && typeof sock.sendMessage === "function") {
      await sleep(2500);
      const shortSha = (pending.targetSha || "").slice(0, 7);
      const text =
        `✅ *Rollback complete!*\n` +
        `📌 *Active Commit:* \`${shortSha}\`\n` +
        `📝 *Note:* _${pending.commitMessage || "Restored previous commit"}_`;

      try {
        await editOrSend(sock, pending.jid, text, pending.msgKey);
        if (pending.msgKey) {
          await sock.sendMessage(pending.jid, { react: { text: "🎉", key: pending.msgKey } }).catch(() => {});
        }
      } catch (err) {
        console.warn("[UPDATER] Post-rollback live edit warning:", err.message);
      }
      return;
    }
    await sleep(1500);
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
        await sleep(3000);
        const text =
          `⚡ *Auto-Update Applied*\n` +
          `📌 *Installed:* \`${(data.remoteSha || "").slice(0, 7)}\`\n` +
          `📝 *Fixed:* _${data.commitMessage || "New commit"}_\n` +
          `👤 *Committer:* ${data.author || "Developer"}\n` +
          `🚀 *Bot restarted cleanly with fresh code.*`;

        await sock.sendMessage(data.ownerJid, { text }).catch(() => {});
        return;
      }
      await sleep(1500);
    }
  } catch {}
}

/**
 * Background auto-update check daemon: runs 20s after boot, then every 3 minutes
 */
let _autoUpdateTimer = null;
let _lastStampOnlySha = null;
function startAutoUpdatePoller(ctx) {
  if (_autoUpdateTimer) return;
  const { getSettings, CONFIG } = ctx;

  // A new commit is queued and applied only when the bot is idle: no command running,
  // no recent output, and the owner not using it. MAX_DEFER_MS caps the wait.
  let _pendingCode = null; // { sha, message, author, queuedAt }
  let _applyingCode = false;
  let _idleWatcher = null;

  const applyPendingCode = async () => {
    if (_applyingCode || !_pendingCode) return;
    const pending = _pendingCode;
    const local = readLocalCommit();
    if (local.sha && local.sha.toLowerCase() === pending.sha.toLowerCase()) {
      _pendingCode = null; // already on this commit (a manual .update got there first)
      return;
    }
    const waited = Date.now() - pending.queuedAt;
    if (!isBotIdle() && waited < MAX_DEFER_MS) return;

    _applyingCode = true;
    _pendingCode = null;
    try {
      console.log(`[AUTO-UPDATE] Bot idle after ${Math.round(waited / 1000)}s. Applying ${pending.sha.slice(0, 7)} — "${pending.message}"...`);
      await applyUpdateCode(pending.sha, pending.message, pending.author);

      const ownerNumber = String(CONFIG?.OWNER_NUMBER || "").replace(/[^0-9]/g, "");
      if (ownerNumber) {
        try {
          fs.mkdirSync(path.dirname(AUTO_UPDATE_NOTICE), { recursive: true });
          fs.writeFileSync(
            AUTO_UPDATE_NOTICE,
            JSON.stringify(
              {
                ownerJid: `${ownerNumber}@s.whatsapp.net`,
                remoteSha: pending.sha,
                commitMessage: pending.message,
                author: pending.author,
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
      setTimeout(() => process.exit(0), 1500);
    } catch (err) {
      console.warn("[AUTO-UPDATE] Apply failed:", err?.message || err);
    } finally {
      _applyingCode = false;
    }
  };

  const ensureIdleWatcher = () => {
    if (_idleWatcher) return;
    _idleWatcher = setInterval(() => { applyPendingCode().catch(() => {}); }, 15 * 1000);
    if (typeof _idleWatcher.unref === "function") _idleWatcher.unref();
  };

  const runCheck = async () => {
    try {
      const botSettings = typeof getSettings === "function" ? getSettings("bot") : null;
      // Auto-update is ON by default unless explicitly set to false
      const isEnabled = botSettings?.autoUpdate !== false && String(process.env.AUTO_UPDATE || "").toLowerCase() !== "off";
      if (!isEnabled) return;

      const local = readLocalCommit();
      const remote = await fetchRemoteCommit();
      if (!remote.sha || !local.sha) return;

      if (remote.sha.toLowerCase() !== local.sha.toLowerCase()) {
        if (remote.sha.toLowerCase() === _lastStampOnlySha) return;
        const diff = await fetchChangedFiles(local.sha, remote.sha);
        if (!diff) return; // GitHub unreachable right now; try again on the next poll
        if (!diff.unknown && isStampOnlyChange(diff.files)) {
          // Only the build-stamp commit changed: there is no new code to load, so no restart.
          _lastStampOnlySha = remote.sha.toLowerCase();
          writeBuildStamp(remote.sha, remote.message, remote.author);
          console.log(`[AUTO-UPDATE] ${remote.sha.slice(0, 7)} only refreshed the build stamp; no restart needed.`);
          return;
        }

        const fixes = await fetchFixes(local.sha, remote.sha);
        if (fixes.length) remote.message = fixes.join(" • ");

        const sameTarget = _pendingCode && _pendingCode.sha.toLowerCase() === remote.sha.toLowerCase();
        if (!sameTarget) {
          _pendingCode = {
            sha: remote.sha,
            message: remote.message,
            author: remote.author,
            queuedAt: _pendingCode ? _pendingCode.queuedAt : Date.now(),
          };
          console.log(`[AUTO-UPDATE] New commit ${remote.sha.slice(0, 7)} — "${remote.message}" queued. It applies once the bot is idle.`);
        }
        ensureIdleWatcher();
        await applyPendingCode();
      }
    } catch (err) {
      console.warn("[AUTO-UPDATE] Background poll error:", err?.message || err);
    }
  };

  // Initial check shortly after boot (20 seconds)
  setTimeout(runCheck, 20000);

  // Periodic poll every 3 minutes
  const pollInterval = 3 * 60 * 1000;
  _autoUpdateTimer = setInterval(runCheck, pollInterval);
  if (_autoUpdateTimer && typeof _autoUpdateTimer.unref === "function") {
    _autoUpdateTimer.unref();
  }
}

/**
 * Install all updater, check-up, commits, rollback & autoupdate commands
 */
export function installUpdateCommand(ctx) {
  const { cmd, sendReply, isOwner, isSudo, getSender, CONFIG, getSettings } = ctx;
  const P = CONFIG?.PREFIX || ".";

  // Check for pending post-reboot notifications
  handlePostRebootLiveUpdate().catch(() => {});
  handlePostRollbackLiveUpdate().catch(() => {});
  handleAutoUpdateBackgroundNotice().catch(() => {});
  startAutoUpdatePoller(ctx);

  // 1. .check-up — Fast, live-edited update check
  cmd(
    ["check-up", "checkup", "checkupdate"],
    { desc: "Check for latest GitHub commits with live status", category: "OWNER", ownerOnly: true },
    async (sock, msg) => {
      const jid = msg.key.remoteJid;
      const sender = getSender(msg);
      const isFromOwner = msg.key.fromMe || isOwner(sender) || (typeof isSudo === "function" && isSudo(sender));

      if (!isFromOwner) {
        await sendReply(sock, msg, "🚫 *Access Denied:* Check-up is restricted to Bot Owner / Sudo.");
        return;
      }

      await sock.sendMessage(jid, { react: { text: "🔍", key: msg.key } }).catch(() => {});

      // Frame 1: Searching
      let liveMsg = null;
      try {
        liveMsg = await sock.sendMessage(jid, { text: "🔍 _Searching for latest commit..._" }, { quoted: msg });
      } catch {
        liveMsg = await sendReply(sock, msg, "🔍 _Searching for latest commit..._");
      }
      let liveKey = liveMsg?.key || null;

      const local = readLocalCommit();
      const remote = await fetchRemoteCommit();

      if (!remote.sha) {
        await sock.sendMessage(jid, { react: { text: "⚠️", key: msg.key } }).catch(() => {});
        const errText = `❌ *Check-up failed:* ${remote.error || "GitHub connection timed out"}`;
        await editOrSend(sock, jid, errText, liveKey, msg);
        return;
      }

      if (local.sha && local.sha.toLowerCase() === remote.sha.toLowerCase()) {
        await sleep(800);
        await sock.sendMessage(jid, { react: { text: "✅", key: msg.key } }).catch(() => {});
        const upToDateText =
          `✅ *All systems up to date!*\n` +
          `📌 *Commit:* \`${local.sha.slice(0, 7)}\` 🟢 *(current)*\n` +
          `📝 *Fixed:* _${remote.message}_\n` +
          `👤 *Author:* ${remote.author}`;
        await editOrSend(sock, jid, upToDateText, liveKey, msg);
        return;
      }

      // New commit found
      await sleep(800);
      await sock.sendMessage(jid, { react: { text: "✨", key: msg.key } }).catch(() => {});
      const foundText =
        `✨ *New update found!*\n` +
        `📌 *Commit:* \`${remote.sha.slice(0, 7)}\` _(current: \`${(local.sha || "unknown").slice(0, 7)}\`)_\n` +
        `📝 *Fixed:* _${remote.message}_\n` +
        `👤 *Author:* ${remote.author}\n\n` +
        `💡 Send \`${P}update\` to install now.`;
      await editOrSend(sock, jid, foundText, liveKey, msg);
    }
  );

  // 2. .update — Fast, short live-edited update & supervisor restart
  cmd(
    ["update", "upgrade", "gitupdate"],
    { desc: "Pull latest commit from GitHub and restart with live message editing", category: "OWNER", ownerOnly: true },
    async (sock, msg) => {
      const jid = msg.key.remoteJid;
      const sender = getSender(msg);
      const isFromOwner = msg.key.fromMe || isOwner(sender) || (typeof isSudo === "function" && isSudo(sender));

      if (!isFromOwner) {
        await sendReply(sock, msg, "🚫 *Access Denied:* Update is restricted to Bot Owner / Sudo.");
        return;
      }

      await sock.sendMessage(jid, { react: { text: "🔄", key: msg.key } }).catch(() => {});

      // Frame 1: Searching for latest commit
      let liveMsg = null;
      try {
        liveMsg = await sock.sendMessage(jid, { text: "🔍 _Searching for latest commit..._" }, { quoted: msg });
      } catch {
        liveMsg = await sendReply(sock, msg, "🔍 _Searching for latest commit..._");
      }
      let liveKey = liveMsg?.key || null;

      const local = readLocalCommit();
      const remote = await fetchRemoteCommit();
      if (remote.sha && local.sha && local.sha.toLowerCase() !== remote.sha.toLowerCase()) {
        const fixes = await fetchFixes(local.sha, remote.sha);
        if (fixes.length) remote.message = fixes.join(" • ");
      }

      if (!remote.sha) {
        await sock.sendMessage(jid, { react: { text: "⚠️", key: msg.key } }).catch(() => {});
        const errText = `❌ *Update failed:* ${remote.error || "GitHub connection timed out"}`;
        await editOrSend(sock, jid, errText, liveKey, msg);
        return;
      }

      // Already up to date
      if (local.sha && local.sha.toLowerCase() === remote.sha.toLowerCase()) {
        await sleep(800);
        await sock.sendMessage(jid, { react: { text: "✅", key: msg.key } }).catch(() => {});
        const upToDateText =
          `✅ *Already on latest commit!*\n` +
          `📌 *Commit:* \`${local.sha.slice(0, 7)}\` 🟢 *(current)*\n` +
          `📝 *Fixed:* _${remote.message}_`;
        await editOrSend(sock, jid, upToDateText, liveKey, msg);
        return;
      }

      // Frame 2: Found commit with what was fixed
      await sleep(800);
      await sock.sendMessage(jid, { react: { text: "📥", key: msg.key } }).catch(() => {});
      const foundText =
        `✨ *Found:* \`${remote.sha.slice(0, 7)}\`\n` +
        `📝 *Fixed:* _${remote.message}_\n` +
        `👤 *Author:* ${remote.author}\n` +
        `⏳ _Pulling changes..._`;
      liveKey = await editOrSend(sock, jid, foundText, liveKey, msg);

      // Frame 3: Pull code and apply
      await sleep(1000);
      await applyUpdateCode(remote.sha, remote.message, remote.author);

      await sock.sendMessage(jid, { react: { text: "🚀", key: msg.key } }).catch(() => {});
      const installedText =
        `📦 *Installed:* \`${remote.sha.slice(0, 7)}\`\n` +
        `📝 *Fixed:* _${remote.message}_\n` +
        `🔄 _Restarting bot..._`;
      liveKey = await editOrSend(sock, jid, installedText, liveKey, msg);

      // Save pending update to edit message live after restart
      savePendingUpdate({
        jid,
        msgKey: liveKey,
        remoteSha: remote.sha,
        commitMessage: remote.message,
        author: remote.author,
        updatedAt: Date.now(),
      });

      // Restart bot supervisor
      setTimeout(() => {
        try {
          process.exit(0);
        } catch {
          process.kill(process.pid, "SIGTERM");
        }
      }, 1200);
    }
  );

  // 3. .commits — Check all recent commits list
  cmd(
    ["commits", "commitlist", "gitcommits"],
    { desc: "List recent GitHub commits with rollback numbers", category: "OWNER", ownerOnly: true },
    async (sock, msg) => {
      const jid = msg.key.remoteJid;
      const sender = getSender(msg);
      const isFromOwner = msg.key.fromMe || isOwner(sender) || (typeof isSudo === "function" && isSudo(sender));

      if (!isFromOwner) {
        await sendReply(sock, msg, "🚫 *Access Denied:* Commits list is restricted to Bot Owner / Sudo.");
        return;
      }

      await sock.sendMessage(jid, { react: { text: "📜", key: msg.key } }).catch(() => {});

      const local = readLocalCommit();
      const allCommits = await fetchRecentCommits(12);

      if (!allCommits || allCommits.length === 0) {
        await sendReply(sock, msg, "⚠️ No commits found or unable to reach GitHub API.");
        return;
      }

      const currentSha = (local.sha || allCommits[0]?.sha || "").slice(0, 7).toLowerCase();
      const commitsToShow = allCommits.slice(0, 10);

      // Render recent commits with 🟢 (current) labeled on the running commit
      let listText = `📜 *Recent Commits:*\n\n📌 *Active (Running):* \`${currentSha}\`\n\n`;

      commitsToShow.forEach((c, idx) => {
        const isCurrent =
          c.shortSha === currentSha ||
          (local.sha && c.sha.toLowerCase() === local.sha.toLowerCase());
        const label = isCurrent ? " 🟢 *(current)*" : "";
        listText += `*[${idx + 1}]* \`${c.shortSha}\`${label} — _${c.message}_\n`;
      });

      listText += `\n💡 Use \`${P}rollback <number>\` or \`${P}rollback\` for previous.`;

      // Cache commit list for fast lookup in .rollback
      saveRecentCommitsCache(commitsToShow);

      await sendReply(sock, msg, listText);
    }
  );

  // 4. .rollback [number|sha] — Revert to selected or previous commit
  cmd(
    ["rollback", "revertupdate", "undoupdate"],
    { desc: "Rollback to a commit number from .commits or previous commit", category: "OWNER", ownerOnly: true },
    async (sock, msg, args) => {
      const jid = msg.key.remoteJid;
      const sender = getSender(msg);
      const isFromOwner = msg.key.fromMe || isOwner(sender) || (typeof isSudo === "function" && isSudo(sender));

      if (!isFromOwner) {
        await sendReply(sock, msg, "🚫 *Access Denied:* Rollback is restricted to Bot Owner / Sudo.");
        return;
      }

      const local = readLocalCommit();
      const currentSha = (local.sha || "").slice(0, 7).toLowerCase();

      const arg = String(args?.[0] || "").trim();
      let targetSha = null;
      let targetMsg = "Previous commit";

      // 1. If user supplied a commit number (e.g. 1, 2, 3)
      if (/^\d+$/.test(arg)) {
        const num = parseInt(arg, 10);
        let cached = readRecentCommitsCache();
        if (!cached || cached.length === 0) {
          cached = await fetchRecentCommits(10);
        }
        if (cached && cached.length >= num && num > 0) {
          const picked = cached[num - 1];
          targetSha = picked.sha;
          targetMsg = picked.message;
        } else {
          await sendReply(sock, msg, `⚠️ Invalid commit number [${num}]. Send \`${P}commits\` to view available numbers.`);
          return;
        }
      } else if (/^[0-9a-f]{7,40}$/i.test(arg)) {
        // 2. If user supplied a commit SHA directly
        targetSha = arg.toLowerCase();
        targetMsg = `Commit ${arg.slice(0, 7)}`;
      } else {
        // 3. No argument: rollback to previous commit
        const state = readRollbackState();
        if (state?.previousSha && state.previousSha.slice(0, 7).toLowerCase() !== currentSha) {
          targetSha = state.previousSha;
          targetMsg = state.previousMessage || "Previous commit";
        } else {
          // Fallback to reading first non-current commit from cache/API
          let cached = readRecentCommitsCache();
          if (!cached || cached.length === 0) {
            cached = await fetchRecentCommits(10);
          }
          if (cached && cached.length > 0) {
            const prev = cached.find((c) => c.shortSha !== currentSha);
            if (prev) {
              targetSha = prev.sha;
              targetMsg = prev.message;
            }
          }
        }
      }

      if (!targetSha || !/^[0-9a-f]{7,40}$/i.test(targetSha)) {
        await sendReply(
          sock,
          msg,
          `⚠️ No saved rollback commit found.\nSend \`${P}commits\` to view recent commits and pick a number with \`${P}rollback <number>\`.`
        );
        return;
      }

      const shortTarget = targetSha.slice(0, 7);
      if (currentSha && shortTarget === currentSha) {
        await sendReply(
          sock,
          msg,
          `⚠️ \`${shortTarget}\` is already the current running version!\nPick an earlier commit from \`${P}commits\` (e.g. \`${P}rollback 2\`).`
        );
        return;
      }
      await sock.sendMessage(jid, { react: { text: "🔄", key: msg.key } }).catch(() => {});

      // Frame 1: Rolling back
      let liveMsg = null;
      try {
        liveMsg = await sock.sendMessage(jid, { text: `⏳ _Rolling back to commit \`${shortTarget}\`..._` }, { quoted: msg });
      } catch {
        liveMsg = await sendReply(sock, msg, `⏳ _Rolling back to commit \`${shortTarget}\`..._`);
      }
      let liveKey = liveMsg?.key || null;

      // Apply rollback
      await sleep(1000);
      const applied = applyRollbackCode(targetSha, targetMsg);

      if (!applied) {
        await sock.sendMessage(jid, { react: { text: "❌", key: msg.key } }).catch(() => {});
        await editOrSend(sock, jid, `❌ Rollback to \`${shortTarget}\` failed. Check bot logs.`, liveKey, msg);
        return;
      }

      // Frame 2: Pre-restart notification
      await sock.sendMessage(jid, { react: { text: "🚀", key: msg.key } }).catch(() => {});
      const rebootText =
        `🔄 *Rolled back to:* \`${shortTarget}\`\n` +
        `📝 *Note:* _${targetMsg}_\n` +
        `🚀 _Restarting bot..._`;
      liveKey = await editOrSend(sock, jid, rebootText, liveKey, msg);

      // Save pending rollback live edit
      savePendingRollback({
        jid,
        msgKey: liveKey,
        targetSha,
        commitMessage: targetMsg,
        updatedAt: Date.now(),
      });

      // Restart bot supervisor
      setTimeout(() => {
        try {
          process.exit(0);
        } catch {
          process.kill(process.pid, "SIGTERM");
        }
      }, 1200);
    }
  );

  // 5. .autoupdate [on|off] — Toggle automatic background commit updates
  cmd(
    ["autoupdate", "autoupdater"],
    { desc: "Toggle automatic background commit updates (on / off)", category: "OWNER", ownerOnly: true },
    async (sock, msg, args) => {
      const jid = msg.key.remoteJid;
      const sender = getSender(msg);
      const isFromOwner = msg.key.fromMe || isOwner(sender) || (typeof isSudo === "function" && isSudo(sender));

      if (!isFromOwner) {
        await sendReply(sock, msg, "🚫 *Access Denied:* Auto-Update setting is restricted to Bot Owner / Sudo.");
        return;
      }

      const sub = String(args?.[0] || "").toLowerCase().trim();
      const current = Boolean(getSettings("bot")?.autoUpdate !== false);

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
          `✅ *Auto-Update: ON*\nBot will automatically detect & apply new GitHub commits and restart smoothly.`
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
          `❌ *Auto-Update: OFF*\nAutomatic background updates disabled. You can run manual updates with \`${P}update\`.`
        );
        return;
      }

      // Show status
      await sendReply(
        sock,
        msg,
        `⚡ *Auto-Update Setting:*\n` +
        `🤖 *Status:* ${current ? "🟢 ON (Active)" : "🔴 OFF (Disabled)"}\n\n` +
        `💡 Toggle: \`${P}autoupdate on\` or \`${P}autoupdate off\`\n` +
        `🔄 Manual update: \`${P}update\``
      );
    }
  );
}
