'use strict';

const PRESENCE_JID = /^\d{5,20}@s\.whatsapp\.net$/;

function validTimestamp(value) {
  const n = typeof value === 'number' ? value : (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : NaN);
  if (!Number.isFinite(n) || n <= 0) return null;
  const ms = n < 1e12 ? Math.floor(n * 1000) : Math.floor(n);
  return ms <= Date.now() + 60_000 ? ms : null;
}

function observationTimestamp(presence, now) {
  if (!presence || typeof presence !== 'object') return null;
  const known = validTimestamp(presence.lastSeen);
  if (known !== null) return known;
  if (String(presence.lastKnownPresence || '').toLowerCase() === 'available' && Number.isFinite(now) && now > 0) return Math.floor(now);
  return null;
}

function applyPresenceObservation(records, jid, presence, { enabled, frozen, now = Date.now(), selfJid = '' } = {}) {
  if (!enabled) return { records, updated: false, reason: 'disabled' };
  if (frozen) return { records, updated: false, reason: 'frozen' };
  const userJid = String(jid || '').trim().toLowerCase();
  if (!PRESENCE_JID.test(userJid) || userJid === String(selfJid || '').toLowerCase()) return { records, updated: false, reason: 'ineligible' };
  const timestamp = observationTimestamp(presence, now);
  if (timestamp === null) return { records, updated: false, reason: 'unobserved' };
  const current = records && typeof records === 'object' && !Array.isArray(records) ? records[userJid] : null;
  if (current?.frozen === true) return { records, updated: false, reason: 'frozen' };
  const priorTimestamp = Number.isFinite(current) ? current : (Number.isFinite(current?.timestamp) ? current.timestamp : null);
  if (priorTimestamp !== null && priorTimestamp >= timestamp) return { records, updated: false, reason: 'not_newer' };
  const kind = validTimestamp(presence?.lastSeen) !== null ? 'server_last_seen' : 'observed_online';
  return { records: { ...(records && typeof records === 'object' && !Array.isArray(records) ? records : {}), [userJid]: { timestamp, kind, frozen: current?.frozen === true } }, updated: true, reason: 'observed' };
}


function persistGuardSettingsJson(filePath, owner, keys, metadata = {}) {
  if (!filePath || !owner || typeof owner !== 'object' || !Array.isArray(keys)) return false;
  const fs = require('node:fs');
  const path = require('node:path');
  let temp = '';
  try {
    let existing = {};
    if (fs.existsSync(filePath)) {
      existing = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!existing || typeof existing !== 'object' || Array.isArray(existing)) return false;
    }
    const payload = { ...existing };
    for (const key of keys) if (Object.prototype.hasOwnProperty.call(owner, key)) payload[key] = owner[key];
    Object.assign(payload, metadata);
    const serialized = JSON.stringify(payload, null, 2);
    if (!serialized) return false;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    temp = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    fs.writeFileSync(temp, serialized, { flag: 'wx' });
    fs.renameSync(temp, filePath);
    return true;
  } catch (error) {
    if (temp) { try { fs.rmSync(temp, { force: true }); } catch {} }
    try { console.error('[guard-db] JSON persistence failed:', error?.message || error); } catch {}
    return false;
  }
}

function installLastSeenListener(sock, { getOwnerSettings, persist, getSelfJid = () => sock?.user?.id || '', now = Date.now } = {}) {
  if (!sock?.ev || typeof sock.ev.on !== 'function' || typeof getOwnerSettings !== 'function' || typeof persist !== 'function') return false;
  if (sock.__lastSeenPresenceListener) return false;
  const listener = async (event = {}) => {
    try {
      const owner = getOwnerSettings();
      if (!owner || owner.lastSeenEnabled !== true) return;
      const incoming = event?.presences;
      if (!incoming || typeof incoming !== 'object') return;
      const selfJid = String(getSelfJid() || '').split(':')[0].toLowerCase();
      for (const [jid, presence] of Object.entries(incoming)) {
        const previousRecord = owner.lastSeenRecords?.[String(jid || '').trim().toLowerCase()];
        const outcome = applyPresenceObservation(owner.lastSeenRecords, jid, presence, {
          enabled: owner.lastSeenEnabled === true,
          frozen: owner.lastSeenFrozen === true || previousRecord?.frozen === true,
          now: now(),
          selfJid,
        });
        if (!outcome.updated) continue;
        const previous = owner.lastSeenRecords;
        owner.lastSeenRecords = outcome.records;
        try {
          const saved = await persist(owner);
          if (saved === false) owner.lastSeenRecords = previous;
        } catch (error) {
          owner.lastSeenRecords = previous;
          try { console.error('[last-seen] persistence failed:', error?.message || error); } catch {}
        }
      }
    } catch (error) {
      try { console.error('[last-seen] presence handler failed:', error?.message || error); } catch {}
    }
  };
  sock.__lastSeenPresenceListener = listener;
  sock.ev.on('presence.update', listener);
  return true;
}

function setFrozen(records, frozen) {
  const source = records && typeof records === 'object' && !Array.isArray(records) ? records : {};
  return Object.fromEntries(Object.entries(source).map(([jid, value]) => [jid, {
    timestamp: Number.isFinite(value) ? value : value?.timestamp,
    kind: value?.kind || 'legacy',
    frozen: frozen === true,
  }]));
}

module.exports = { applyPresenceObservation, installLastSeenListener, observationTimestamp, persistGuardSettingsJson, setFrozen, validTimestamp };
