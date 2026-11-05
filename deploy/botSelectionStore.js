'use strict';
/**
 * Bot Selection Store
 * ===================
 * Single source of truth for "which bot did this number choose".
 *
 * Why this exists
 * ---------------
 * Bot choice used to live only in a WhatsApp menu sent to the freshly paired
 * number. Right after pairing, WhatsApp has not finished syncing the new
 * device's encryption keys, so that first self-message very often lands as
 * "Waiting for this message. This may take a while." — the user physically
 * cannot tap it, so nothing is ever deployed.
 *
 * The choice now lives here and can be driven from ANY surface:
 *   - Telegram  (/number)  <- primary
 *   - Admin web panel
 *   - the WhatsApp menu    <- best effort only, never required
 *
 * Locking
 * -------
 * Once a number picks a bot the record is LOCKED. It cannot be changed until
 * the number is unpaired (which calls clearSelection) and paired again.
 */

const fs   = require('fs');
const path = require('path');

const { jidKey } = require('./jid');

const NEXSTORE       = path.join(__dirname, '..', 'nexstore');
const SELECTIONS_FILE = path.join(NEXSTORE, 'bot_selections.json');
const PENDING_FILE    = path.join(NEXSTORE, 'pending_selections.json');
const OWNERS_FILE     = path.join(NEXSTORE, 'tg_owners.json');

function _read(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}
  return fallback;
}

function _write(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Atomic write: two surfaces choosing at the same moment used to be able to
    // read a half-written selections file and lose a lock.
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch (e) {
    console.warn(`[SelectionStore] write failed (${path.basename(file)}): ${e.message}`);
    return false;
  }
}

// ── Selections (locked once written) ─────────────────────────────────────────

function allSelections() {
  const raw = _read(SELECTIONS_FILE, {});
  return raw && typeof raw === 'object' ? raw : {};
}

function getSelection(numberOrJid) {
  const key = jidKey(numberOrJid);
  if (!key) return null;
  const rec = allSelections()[key];
  return rec && rec.botId ? { number: key, ...rec } : null;
}

function isLocked(numberOrJid) {
  const rec = getSelection(numberOrJid);
  return !!(rec && rec.locked !== false);
}

/**
 * Persist a choice. Refuses to overwrite a locked record.
 * @returns {{ok:boolean, locked?:boolean, record?:object, error?:string}}
 */
function setSelection(numberOrJid, bot, opts = {}) {
  const key = jidKey(numberOrJid);
  if (!key) return { ok: false, error: 'Invalid number.' };
  if (!bot || !bot.id) return { ok: false, error: 'Invalid bot.' };

  const data = allSelections();
  const current = data[key];

  // Re-picking the SAME bot is not a conflict — it is a redeploy. Returning an
  // error here made the second tap of an identical selector look like a
  // failure even though nothing was wrong.
  if (current && current.botId === bot.id && !opts.force) {
    return { ok: true, alreadyLocked: true, record: { number: key, ...current } };
  }

  if (current && current.botId && current.locked !== false && !opts.force) {
    return {
      ok: false,
      locked: true,
      record: { number: key, ...current },
      error: `${key} is already locked to ${current.botName || current.botId}. ` +
             `Unpair the number and pair it again to change bots.`,
    };
  }

  const record = {
    botId:    bot.id,
    botName:  bot.name || bot.id,
    chosenAt: new Date().toISOString(),
    source:   opts.source || 'unknown',
    chosenBy: opts.chosenBy || null,   // telegram user id / 'web-admin'
    locked:   true,
    deployed: false,
  };

  data[key] = record;
  _write(SELECTIONS_FILE, data);
  clearPending(key);
  return { ok: true, record: { number: key, ...record } };
}

function markDeployed(numberOrJid, deployed = true) {
  const key = jidKey(numberOrJid);
  const data = allSelections();
  if (!data[key]) return false;
  data[key].deployed = !!deployed;
  data[key].deployedAt = deployed ? new Date().toISOString() : null;
  return _write(SELECTIONS_FILE, data);
}

/** Unlock — only ever called when a number is genuinely unpaired. */
function clearSelection(numberOrJid) {
  const key = jidKey(numberOrJid);
  if (!key) return false;
  const data = allSelections();
  if (!data[key]) return false;
  delete data[key];
  _write(SELECTIONS_FILE, data);
  clearPending(key);
  return true;
}

// ── Pending (paired, waiting for a bot to be chosen) ─────────────────────────

function allPending() {
  const raw = _read(PENDING_FILE, {});
  return raw && typeof raw === 'object' ? raw : {};
}

function markPending(numberOrJid, meta = {}) {
  const key = jidKey(numberOrJid);
  if (!key) return false;
  if (isLocked(key)) return false;
  const data = allPending();
  data[key] = {
    number: key,
    pairedAt: data[key]?.pairedAt || new Date().toISOString(),
    source: meta.source || 'web',
    sessionDir: meta.sessionDir || data[key]?.sessionDir || null,
    notified: data[key]?.notified || false,
  };
  return _write(PENDING_FILE, data);
}

function markNotified(numberOrJid) {
  const key = jidKey(numberOrJid);
  const data = allPending();
  if (!data[key]) return false;
  data[key].notified = true;
  return _write(PENDING_FILE, data);
}

function isPending(numberOrJid) {
  return !!allPending()[jidKey(numberOrJid)];
}

function clearPending(numberOrJid) {
  const key = jidKey(numberOrJid);
  const data = allPending();
  if (!data[key]) return false;
  delete data[key];
  return _write(PENDING_FILE, data);
}

function listPending() {
  return Object.values(allPending()).sort(
    (a, b) => String(a.pairedAt).localeCompare(String(b.pairedAt)),
  );
}

// ── Telegram ownership (who paired which number) ─────────────────────────────

function allOwners() {
  const raw = _read(OWNERS_FILE, {});
  return raw && typeof raw === 'object' ? raw : {};
}

function setOwner(numberOrJid, telegramUser) {
  const key = jidKey(numberOrJid);
  if (!key || !telegramUser?.id) return false;
  const data = allOwners();
  data[key] = {
    id: String(telegramUser.id),
    username: telegramUser.username || null,
    firstName: telegramUser.first_name || null,
    linkedAt: new Date().toISOString(),
  };
  return _write(OWNERS_FILE, data);
}

function getOwner(numberOrJid) {
  return allOwners()[jidKey(numberOrJid)] || null;
}

function clearOwner(numberOrJid) {
  const key = jidKey(numberOrJid);
  if (!key) return false;
  const data = allOwners();
  if (!data[key]) return false;
  delete data[key];
  return _write(OWNERS_FILE, data);
}

function numbersOwnedBy(telegramUserId) {
  const id = String(telegramUserId);
  return Object.entries(allOwners())
    .filter(([, v]) => String(v.id) === id)
    .map(([number]) => number);
}

/** Single combined record for one number. */
function get(numberOrJid) {
  const key = jidKey(numberOrJid);
  if (!key) return null;
  return overview().find(r => r.number === key) || {
    number: key, botId: null, botName: null, locked: false,
    deployed: false, awaiting: false, telegram: getOwner(key),
  };
}

// ── Combined view for admin UIs ──────────────────────────────────────────────

function overview() {
  const selections = allSelections();
  const pending    = allPending();
  const owners     = allOwners();
  const keys = new Set([...Object.keys(selections), ...Object.keys(pending)]);

  return [...keys].map(number => ({
    number,
    botId:     selections[number]?.botId    || null,
    botName:   selections[number]?.botName  || null,
    chosenAt:  selections[number]?.chosenAt || null,
    source:    selections[number]?.source   || pending[number]?.source || null,
    locked:    !!selections[number]?.botId,
    deployed:  !!selections[number]?.deployed,
    awaiting:  !!pending[number] && !selections[number]?.botId,
    pairedAt:  pending[number]?.pairedAt || null,
    telegram:  owners[number] || null,
  })).sort((a, b) => Number(b.awaiting) - Number(a.awaiting));
}

module.exports = {
  get,
  SELECTIONS_FILE,
  PENDING_FILE,
  OWNERS_FILE,
  allSelections,
  getSelection,
  isLocked,
  setSelection,
  markDeployed,
  clearSelection,
  markPending,
  markNotified,
  isPending,
  clearPending,
  listPending,
  setOwner,
  getOwner,
  clearOwner,
  numbersOwnedBy,
  overview,
};
