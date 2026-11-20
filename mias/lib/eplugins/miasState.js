/**
 * In-memory and persistent state management for Levanter plugins in MIAS
 * Handles AFK, Lydia/Nix, PDM, AntiGM, AntiFake, AntiSpam, AutoMute, Group Message Counts, and Status Schedules.
 */

// AFK state: Map<string, { isAfk: boolean, reason: string, lastseen: number, p: string }>
const afkStore = new Map();

export function setAfk(enabled, reason = "", lastseen = Date.now(), participant = "", id = "0") {
  const key = `${id}_${participant}`;
  if (!enabled) {
    afkStore.delete(key);
    return false;
  }
  afkStore.set(key, { isAfk: true, reason, lastseen, p: participant });
  return true;
}

export function getAfk(id = "0", participant = "") {
  const key = `${id}_${participant}`;
  return afkStore.get(key) || { isAfk: false, reason: "", lastseen: 0, p: participant };
}

// Lydia / Nix state: Map<string, { status: boolean, user: string }>
const lydiaStore = new Map();

export function setLydia(chatJid, enabled, user = "", sessionId = "0") {
  const key = `${sessionId}_${chatJid}`;
  if (!enabled) {
    lydiaStore.delete(key);
    return false;
  }
  lydiaStore.set(key, { status: true, user: user || "" });
  return true;
}

export function getLydia(chatJid, sessionId = "0", user = "") {
  const key = `${sessionId}_${chatJid}`;
  const record = lydiaStore.get(key);
  if (!record || !record.status) return null;
  if (record.user && user && record.user !== user) return null;
  return record;
}

// PDM state: Map<string, boolean>
const pdmStore = new Map();

export function setPdm(chatJid, status, sessionId = "0") {
  const key = `${sessionId}_${chatJid}`;
  if (!status) {
    pdmStore.delete(key);
    return false;
  }
  pdmStore.set(key, true);
  return true;
}

export function getPdm(chatJid, sessionId = "0") {
  const key = `${sessionId}_${chatJid}`;
  return !!pdmStore.get(key);
}

// Anti-GM (Group Mention): Map<string, { action: string, enabled: boolean, filter: string }>
const gmStore = new Map();

export function setGroupMention(config, sessionId = "0") {
  const key = String(sessionId);
  if (!config || !config.enabled) {
    gmStore.delete(key);
    return;
  }
  gmStore.set(key, {
    action: config.action || "warn",
    enabled: true,
    filter: config.filter || ""
  });
}

export function getGroupMention(sessionId = "0") {
  const key = String(sessionId);
  return gmStore.get(key) || null;
}

// Anti-Fake: Map<string, { status: boolean, codes: string[] }>
const fakeStore = new Map();

export function getFake(chatJid, sessionId = "0") {
  const key = `${sessionId}_${chatJid}`;
  return fakeStore.get(key) || { status: false, codes: [] };
}

export function setFake(chatJid, enabled, sessionId = "0") {
  const key = `${sessionId}_${chatJid}`;
  const curr = fakeStore.get(key) || { status: false, codes: [] };
  curr.status = !!enabled;
  fakeStore.set(key, curr);
  return curr;
}

export function addCode(chatJid, code, sessionId = "0") {
  const key = `${sessionId}_${chatJid}`;
  const curr = fakeStore.get(key) || { status: true, codes: [] };
  const clean = String(code).replace(/\D/g, "");
  if (clean && !curr.codes.includes(clean)) {
    curr.codes.push(clean);
  }
  fakeStore.set(key, curr);
  return curr;
}

export function removeCode(chatJid, code, sessionId = "0") {
  const key = `${sessionId}_${chatJid}`;
  const curr = fakeStore.get(key);
  if (!curr) return;
  const clean = String(code).replace(/\D/g, "");
  curr.codes = curr.codes.filter(c => c !== clean);
  fakeStore.set(key, curr);
  return curr;
}

// Anti-Spam: Map<string, { enabled: boolean, level: string, action: string }>
const spamStore = new Map();

export function getSpam(chatJid, sessionId = "0") {
  const key = `${sessionId}_${chatJid}`;
  return spamStore.get(key) || null;
}

export function setSpam(chatJid, config, sessionId = "0") {
  const key = `${sessionId}_${chatJid}`;
  if (!config || !config.enabled) {
    spamStore.delete(key);
    return null;
  }
  spamStore.set(key, {
    enabled: true,
    level: config.level || "medium",
    action: config.action || "kick"
  });
  return spamStore.get(key);
}

export function setAntiSpamLevel(chatJid, level, sessionId = "0") {
  const key = `${sessionId}_${chatJid}`;
  const curr = spamStore.get(key) || { enabled: true, level: "medium", action: "kick" };
  curr.level = level;
  curr.enabled = true;
  spamStore.set(key, curr);
  return curr;
}

export function setAntiSpamAction(chatJid, action, sessionId = "0") {
  const key = `${sessionId}_${chatJid}`;
  const curr = spamStore.get(key) || { enabled: true, level: "medium", action: "kick" };
  curr.action = action;
  curr.enabled = true;
  spamStore.set(key, curr);
  return curr;
}

// Auto-Mute / Aunmute schedule: Map<string, { amute: object, aunmute: object }>
const muteStore = new Map();

export function setMute(chatJid, type, enabled, sessionId = "0", hour = 0, min = 0, msg = "") {
  const key = `${sessionId}_${chatJid}`;
  const curr = muteStore.get(key) || { amute: null, aunmute: null };
  if (!enabled) {
    curr[type] = null;
  } else {
    curr[type] = { hour: Number(hour), min: Number(min), msg: msg || "", enabled: true };
  }
  muteStore.set(key, curr);
  return curr[type];
}

export function getMute(chatJid, type, sessionId = "0") {
  const key = `${sessionId}_${chatJid}`;
  const curr = muteStore.get(key);
  if (!curr) return null;
  return curr[type] || null;
}

export function addTask(chatJid, type, hour, min, msg, sessionId = "0") {
  return setMute(chatJid, type, true, sessionId, hour, min, msg);
}

// Group Message Count: Map<string, Map<string, number>>
const msgStore = new Map();

export function addMsg(chatJid, sender, sessionId = "0") {
  const key = `${sessionId}_${chatJid}`;
  if (!msgStore.has(key)) {
    msgStore.set(key, new Map());
  }
  const groupCounts = msgStore.get(key);
  const userCount = (groupCounts.get(sender) || 0) + 1;
  groupCounts.set(sender, userCount);
  return userCount;
}

export function getMsg(chatJid, sender = null, sessionId = "0") {
  const key = `${sessionId}_${chatJid}`;
  const groupCounts = msgStore.get(key);
  if (!groupCounts) return sender ? 0 : [];
  if (sender) {
    return groupCounts.get(sender) || 0;
  }
  const list = [];
  for (const [user, count] of groupCounts.entries()) {
    list.push({ sender: user, count });
  }
  list.sort((a, b) => b.count - a.count);
  return list;
}

export function resetMsgs(chatJid, sender = null, sessionId = "0") {
  const key = `${sessionId}_${chatJid}`;
  const groupCounts = msgStore.get(key);
  if (!groupCounts) return true;
  if (sender) {
    groupCounts.delete(sender);
  } else {
    groupCounts.clear();
  }
  return true;
}

// Common members utility
export function getCommon(arrays, isAny = false) {
  if (!arrays || arrays.length < 2) return [];
  if (isAny) {
    const set = new Set();
    for (const arr of arrays) {
      for (const item of arr) set.add(item);
    }
    return Array.from(set);
  }
  return arrays.reduce((acc, curr) => acc.filter(item => curr.includes(item)));
}

// Status Schedule store: Map<string, Array<{ time: string, msg: string, jids: string[] }>>
const statusScheduleStore = new Map();

export async function createStatusSchedule(time, msg, jids = [], sessionId = "0") {
  const key = String(sessionId);
  if (!statusScheduleStore.has(key)) {
    statusScheduleStore.set(key, []);
  }
  const list = statusScheduleStore.get(key);
  const entry = { time, msg: typeof msg === "object" ? JSON.stringify(msg) : String(msg), jids: Array.isArray(jids) ? jids : [jids] };
  list.push(entry);
  return entry;
}

export async function getScheduleStatus(sessionId = "0") {
  const key = String(sessionId);
  return statusScheduleStore.get(key) || [];
}

export async function delScheduleStatus(time, sessionId = "0") {
  const key = String(sessionId);
  const list = statusScheduleStore.get(key);
  if (!list) return false;
  const filtered = list.filter(item => item.time !== time);
  statusScheduleStore.set(key, filtered);
  return true;
}

export async function deleteScheduleStatusTask(time, sessionId = "0") {
  return delScheduleStatus(time, sessionId);
}
