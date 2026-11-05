'use strict';

/**
 * Shared implementation for `.setbio` / `.setabout`.
 *
 * Writes the WhatsApp About text, then reads it back to confirm. The reply
 * only says "updated and verified" when WhatsApp returns the same text.
 * Every other outcome is reported as it is:
 *  - the write itself was rejected or timed out  -> failure, nothing confirmed
 *  - WhatsApp returns a different About text      -> mismatch, shows what it has
 *  - the connection cannot read About back        -> saved, not verified
 */

const BIO_MAX_CHARS = 139;
const WRITE_TIMEOUT_MS = 10000;
const READ_TIMEOUT_MS = 10000;
const READ_ATTEMPTS = 3;
const READ_RETRY_MS = 1000;

function userPart(jid) {
  return String(jid || '').split('@')[0].split(':')[0];
}

function stripDevice(jid) {
  return String(jid || '').replace(/:\d+@/, '@');
}

/** The bot's identities: phone number and LID, both without device suffixes. */
function selfIdentities(sock) {
  const raw = [
    sock?.user?.id,
    sock?.user?.lid,
    sock?.authState?.creds?.me?.id,
    sock?.authState?.creds?.me?.lid,
  ].filter(Boolean);
  const users = [];
  for (const value of raw) {
    const user = userPart(value);
    if (user && !users.includes(user)) users.push(user);
  }
  return { users, jids: [...new Set(raw.map(stripDevice))] };
}

/** Accepts the status rows WhatsApp returns for a usync query and gives the status text of this bot. */
function pickOwnStatus(result, self) {
  const rows = Array.isArray(result) ? result : Array.isArray(result?.list) ? result.list : [result];
  const usable = rows.filter(Boolean);
  let row = usable.find((value) => value.id && self.users.includes(userPart(value.id)));
  // Only this bot's identities were queried, so a single row without a matching id is this bot.
  if (!row && usable.length === 1) row = usable[0];
  if (!row) return { found: false };
  const text = typeof row.status === 'string' ? row.status : row.status?.status;
  return { found: true, status: typeof text === 'string' ? text : null };
}

function withTimeout(operation, ms, label) {
  let timer;
  return Promise.race([
    Promise.resolve().then(operation),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Writes the About text. A timed-out write is not retried, because it may still complete on WhatsApp. */
async function writeAbout(sock, bio) {
  if (typeof sock.updateProfileStatus === 'function') {
    await withTimeout(() => sock.updateProfileStatus(bio), WRITE_TIMEOUT_MS, 'WhatsApp request');
    return;
  }
  if (typeof sock.query === 'function') {
    const result = await withTimeout(() => sock.query({
      tag: 'iq',
      attrs: { to: 's.whatsapp.net', type: 'set', xmlns: 'status' },
      content: [{ tag: 'status', attrs: {}, content: Buffer.from(bio, 'utf-8') }],
    }), WRITE_TIMEOUT_MS, 'WhatsApp request');
    if (result?.attrs?.type === 'error') throw new Error('WhatsApp rejected the About update');
    return;
  }
  throw new Error('This connection does not support About updates');
}

/**
 * Reads the About text back. Returns { state, observed, error } where state is
 * 'verified', 'mismatch', or 'unavailable'.
 */
async function readBack(sock, bio, options = {}) {
  const attempts = options.attempts ?? READ_ATTEMPTS;
  const retryMs = options.retryMs ?? READ_RETRY_MS;
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  if (typeof sock.fetchStatus !== 'function') {
    return { state: 'unavailable', error: 'About readback is not available on this connection' };
  }
  const self = selfIdentities(sock);
  if (!self.jids.length) return { state: 'unavailable', error: 'the bot identity is not known yet' };

  let observed;
  let lastError = 'WhatsApp returned no status for this account';
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt) await sleep(retryMs);
    try {
      const result = await withTimeout(() => sock.fetchStatus(...self.jids), READ_TIMEOUT_MS, 'About readback');
      const own = pickOwnStatus(result, self);
      if (!own.found) { lastError = 'WhatsApp returned no status for this account'; continue; }
      if (own.status === bio) return { state: 'verified' };
      observed = own.status ?? '';
      lastError = 'WhatsApp still shows a different About text';
    } catch (error) {
      lastError = error?.message || String(error);
    }
  }
  if (observed !== undefined) return { state: 'mismatch', observed };
  return { state: 'unavailable', error: lastError };
}

/**
 * Handles `.setbio <text>`. deps: { prefix, sendReply(sock,msg,text), react(sock,msg,emoji), sleep? }
 */
async function handleSetBio(sock, msg, args = [], deps = {}) {
  try {
    return await runSetBio(sock, msg, args, deps);
  } catch (error) {
    console.error(`[setbio] FAILED: unexpected error: ${error?.message || error}`);
    try { await deps.sendReply(sock, msg, `❌ Bio update failed: ${error?.message || error}. Nothing was confirmed.`); }
    catch (sendError) { console.error(`[setbio] FAILED: could not send the error reply: ${sendError?.message || sendError}`); }
    return undefined;
  }
}

async function runSetBio(sock, msg, args = [], deps = {}) {
  const prefix = deps.prefix || '.';
  const say = (text) => deps.sendReply(sock, msg, text);
  const mark = async (emoji) => { try { await deps.react(sock, msg, emoji); } catch (_) { /* reaction is cosmetic */ } };

  const bio = (Array.isArray(args) ? args : [String(args || '')]).join(' ').trim();
  console.log(`[setbio] requested (${Array.from(bio).length} characters)`);
  if (!bio) return say(`Usage: *${prefix}setbio <your bio>*`);
  if (Array.from(bio).length > BIO_MAX_CHARS) {
    return say(`❌ Bio is too long. Use at most ${BIO_MAX_CHARS} characters; nothing was changed.`);
  }

  await mark('🌀');
  try {
    await writeAbout(sock, bio);
  } catch (error) {
    console.error(`[setbio] FAILED: About write was rejected or timed out: ${error?.message || error}`);
    await mark('❌');
    return say(`❌ Bio update failed: ${error?.message || error}. Nothing was confirmed.`);
  }

  const check = await readBack(sock, bio, { sleep: deps.sleep });
  const shown = check.observed !== undefined ? ` WhatsApp shows "${check.observed}".` : '';
  if (check.state === 'verified') {
    console.log('[setbio] About verified on WhatsApp');
    await mark('✅');
    return say(`✅ *Bio updated and verified on WhatsApp*\n\n${bio}`);
  }
  console.error(`[setbio] FAILED to verify About: read-back ${check.state}.${shown}${check.error ? ` ${check.error}.` : ''}`);
  if (check.state === 'mismatch') {
    await mark('⚠️');
    return say(`⚠️ WhatsApp accepted the update, but it still shows a different About:\n\n"${check.observed}"\n\nWait a minute and check again, or run ${prefix}setbio once more.`);
  }
  await mark('⚠️');
  return say(`⚠️ WhatsApp accepted the update, but I could not read it back (${check.error}). Check your About in WhatsApp.`);
}

module.exports = {
  BIO_MAX_CHARS,
  selfIdentities,
  pickOwnStatus,
  writeAbout,
  readBack,
  handleSetBio,
};
