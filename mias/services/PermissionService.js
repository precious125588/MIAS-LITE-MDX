/**
 * MIAS — Permission Service
 *
 * Centralized permission and access-control checks.
 * Commands call these helpers instead of checking role arrays directly.
 *
 * Architecture: Commands → PermissionService → database / settings → decision
 */

import { isGroupJid } from "../handlers/utilityHandler.js";
import { createRequire as _createRequire } from "module";

// ─── Cooldown store (in-memory) ───────────────────────────────────────────────

const _cooldowns = new Map(); // key: "jid:cmd" → timestamp

// ─── Config resolvers ─────────────────────────────────────────────────────────

function _getOwnerJids() {
  try {
    const cfg = globalThis.__MIAS_CONFIG__;
    if (cfg?.OWNER_JID) return [].concat(cfg.OWNER_JID);
    const setting = globalThis.__GET_SETTING__?.("owner_jid");
    if (setting) return [].concat(setting);
  } catch {}
  return [];
}

function _getPremiumJids() {
  try {
    const cfg = globalThis.__MIAS_CONFIG__;
    if (cfg?.PREMIUM_JIDS) return [].concat(cfg.PREMIUM_JIDS);
    const setting = globalThis.__GET_SETTING__?.("premium_jids");
    if (setting) return [].concat(setting);
  } catch {}
  // Try to read from the JSON files
  try {
    const { createRequire } = await_import_sync();
    if (createRequire) {
      const require = createRequire(import.meta.url);
      const data = require("../../allfunc/premium.json");
      return Array.isArray(data) ? data : Object.keys(data);
    }
  } catch {}
  return [];
}

// FIXED: `await` inside a non-async function is a hard SyntaxError, which made
// the whole service barrel fail to load ("Service layer load error: Unexpected
// reserved word") and silently disabled the MIAS service layer.
function await_import_sync() { try { return { createRequire: _createRequire }; } catch { return {}; } }

function _getBannedJids() {
  try {
    const cfg = globalThis.__MIAS_CONFIG__;
    if (cfg?.BANNED_JIDS) return [].concat(cfg.BANNED_JIDS);
  } catch {}
  return [];
}

// ─── Permission checks ────────────────────────────────────────────────────────

/**
 * Check if a JID is the bot owner.
 * @param {string} jid
 * @returns {boolean}
 */
export function isOwner(jid) {
  if (!jid) return false;
  const owners = _getOwnerJids();
  const clean = String(jid).replace(/:.*@/, "@").replace(/:[0-9]+$/, "");
  return owners.some(o => String(o).replace(/:.*@/, "@") === clean || String(o) === clean);
}

/**
 * Check if a JID is a premium user.
 * @param {string} jid
 * @returns {boolean}
 */
export function isPremium(jid) {
  if (!jid) return false;
  if (isOwner(jid)) return true; // owners are always premium
  const list = _getPremiumJids();
  const clean = String(jid).replace(/:.*@/, "@");
  return list.some(p => String(p).replace(/:.*@/, "@") === clean);
}

/**
 * Check if a JID is banned.
 * @param {string} jid
 * @returns {boolean}
 */
export function isBanned(jid) {
  if (!jid) return false;
  const list = _getBannedJids();
  const clean = String(jid).replace(/:.*@/, "@");
  return list.some(b => String(b).replace(/:.*@/, "@") === clean);
}

/**
 * Check if the message sender is a group admin.
 * @param {object} groupMeta - Result of getGroupMetadata()
 * @param {string} participantJid
 * @returns {boolean}
 */
export function isAdmin(groupMeta, participantJid) {
  if (!groupMeta?.participants || !participantJid) return false;
  const clean = String(participantJid).replace(/:.*@/, "@");
  return groupMeta.participants.some(p => {
    const pClean = String(p.id || p.jid || "").replace(/:.*@/, "@");
    return pClean === clean && (p.admin === "admin" || p.admin === "superadmin");
  });
}

/**
 * Check if the bot is a group admin.
 * @param {object} groupMeta
 * @param {string} botJid
 * @returns {boolean}
 */
export function isBotAdmin(groupMeta, botJid) {
  return isAdmin(groupMeta, botJid);
}

/**
 * Check if a JID is a group JID.
 * @param {string} jid
 * @returns {boolean}
 */
export function isGroup(jid) {
  return isGroupJid(jid);
}

/**
 * Check if command is private only (non-group).
 * @param {string} jid
 * @returns {boolean}
 */
export function isPrivateChat(jid) {
  return !isGroupJid(jid);
}

// ─── Cooldown management ──────────────────────────────────────────────────────

/**
 * Check cooldown for a jid+command. Returns remaining seconds (0 = OK).
 *
 * @param {string} jid
 * @param {string} cmd
 * @param {number} cooldownSec
 * @returns {number} Remaining cooldown seconds (0 = allowed)
 */
export function checkCooldown(jid, cmd, cooldownSec) {
  if (!cooldownSec || cooldownSec <= 0) return 0;
  const key = `${jid}:${cmd}`;
  const last = _cooldowns.get(key);
  if (!last) return 0;
  const elapsed = (Date.now() - last) / 1000;
  if (elapsed >= cooldownSec) return 0;
  return Math.ceil(cooldownSec - elapsed);
}

/**
 * Set cooldown for jid+command.
 * @param {string} jid
 * @param {string} cmd
 */
export function setCooldown(jid, cmd) {
  _cooldowns.set(`${jid}:${cmd}`, Date.now());
}

/**
 * Clear cooldown for jid+command.
 * @param {string} jid
 * @param {string} cmd
 */
export function clearCooldown(jid, cmd) {
  _cooldowns.delete(`${jid}:${cmd}`);
}

// ─── Daily limit management ───────────────────────────────────────────────────

const _dailyUsage = new Map(); // key: "jid:cmd:YYYY-MM-DD" → count

function _dailyKey(jid, cmd) {
  const day = new Date().toISOString().slice(0, 10);
  return `${jid}:${cmd}:${day}`;
}

/**
 * Get daily usage count.
 * @param {string} jid
 * @param {string} cmd
 * @returns {number}
 */
export function getDailyUsage(jid, cmd) {
  return _dailyUsage.get(_dailyKey(jid, cmd)) || 0;
}

/**
 * Increment and return daily usage count.
 * @param {string} jid
 * @param {string} cmd
 * @returns {number}
 */
export function incrementDailyUsage(jid, cmd) {
  const key = _dailyKey(jid, cmd);
  const count = (_dailyUsage.get(key) || 0) + 1;
  _dailyUsage.set(key, count);
  return count;
}

/**
 * Check if daily limit is exceeded.
 * @param {string} jid
 * @param {string} cmd
 * @param {number} limit
 * @returns {boolean}
 */
export function isDailyLimitExceeded(jid, cmd, limit) {
  if (!limit || limit <= 0) return false;
  return getDailyUsage(jid, cmd) >= limit;
}

export default {
  isOwner, isPremium, isBanned, isAdmin, isBotAdmin, isGroup, isPrivateChat,
  checkCooldown, setCooldown, clearCooldown,
  getDailyUsage, incrementDailyUsage, isDailyLimitExceeded,
};
