'use strict';
/**
 * MIAS Deployment Manager
 *
 * Scans bots/ for manifest.json files, sends the WhatsApp selection menu,
 * waits for the user's choice, reports progress, and launches the chosen bot.
 *
 * FIXED (was broken):
 *   1. JID MISMATCH — pending selections were keyed by bare phone number
 *      (from pair.js) but looked up by full JID (from Baileys). No selection
 *      ever matched, so every deploy hit the timeout branch.
 *   2. TIMEOUT AUTO-PICKED bots[0] (= MIAS MDX). Deployment is now never
 *      chosen for the user: the menu is re-sent on a reminder interval and
 *      the flow gives up without launching anything if the user never answers.
 *   3. EMPTY-TEXT MATCHED EVERYTHING — `b.id.includes('')` is always true, so
 *      any non-text event (sticker, reaction, protocol message) resolved to
 *      the first bot. Matching is now strict.
 *   4. Wrapped messages (ephemeral / viewOnce) were never unwrapped, so real
 *      button replies were missed.
 */

const fs    = require('fs');
const ownership = require('../sessionOwnership');
const path  = require('path');
const chalk = require('chalk');

const { jidKey, toJid } = require('./jid');
const selectorRegistry  = require('./selectorRegistry');

const BOTS_DIR        = path.join(__dirname, '..', 'bots');
const _sessionPaths = require('../sessionPaths');
const SELECTIONS_FILE = path.join(_sessionPaths.nexstoreRoot(), 'bot_selections.json');

// How often to re-send the menu while waiting, and when to give up entirely.
const REMINDER_MS = 3 * 60 * 1000;   // re-prompt every 3 minutes
const GIVE_UP_MS  = 30 * 60 * 1000;  // stop waiting after 30 minutes

// The chosen bot must be up this fast after the user picks it.
const SPAWN_DELAY_MS = 3000;

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }


// digitsOnlyKey -> { resolve, timer, reminder }
const _pendingSelections = new Map();

const REMOVED_BOT_IDS = new Set(['new-page']);

let _botCache = null;

// ── Bot discovery ────────────────────────────────────────────────────────────
function scanBots() {
  if (_botCache) return _botCache;
  const result = [];
  try {
    if (!fs.existsSync(BOTS_DIR)) {
      console.warn(chalk.yellow('[DeployMgr] bots/ not found — using defaults'));
      _botCache = _getDefaultBots();
      return _botCache;
    }
    for (const entry of fs.readdirSync(BOTS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      // The "new-page" bot was removed from this project. Ignore any stale
      // folder so the deploy menu can never offer a bot that has no code.
      if (REMOVED_BOT_IDS.has(entry.name.toLowerCase())) continue;
      const mf = path.join(BOTS_DIR, entry.name, 'manifest.json');
      if (!fs.existsSync(mf)) continue;
      try {
        const manifest = JSON.parse(fs.readFileSync(mf, 'utf8'));
        if (REMOVED_BOT_IDS.has(String(manifest.id || '').toLowerCase())) continue;
        if (manifest.id && manifest.name) result.push(manifest);
      } catch (e) {
        console.warn(chalk.yellow(`[DeployMgr] Skipping ${entry.name}: ${e.message}`));
      }
    }
    result.sort((a, b) => {
      const order = { stable: 0, beta: 1, experimental: 2 };
      const ao = order[a.status] ?? 9;
      const bo = order[b.status] ?? 9;
      return ao !== bo ? ao - bo : a.name.localeCompare(b.name);
    });
  } catch (e) {
    console.error(chalk.red(`[DeployMgr] scanBots error: ${e.message}`));
    _botCache = _getDefaultBots();
    return _botCache;
  }
  _botCache = result.length ? result : _getDefaultBots();
  return _botCache;
}

function clearBotCache() { _botCache = null; }

function _getDefaultBots() {
  return [
    {
      id: 'mias-mdx', name: 'MIAS MDX', tagline: 'Stable • Full Features',
      version: '2.0.1', status: 'stable', entry: 'mias/index.js',
      env: { BOT_NAME: 'MIAS MDX' },
      deploySteps: ['Session created', 'Plugins loaded', 'Database initialized', 'Deployment complete'],
    },
  ];
}

function getBotById(id) {
  if (!id) return null;
  const wanted = String(id).replace(/^deploy:/, '').trim().toLowerCase();
  return scanBots().find(b => b.id.toLowerCase() === wanted) || null;
}

// ── Persisted selections (delegated to the shared, lockable store) ───────────
const store = require('./botSelectionStore');

function _writeSelection(userKey, botId, opts = {}) {
  const bot = getBotById(botId);
  if (!bot) return { ok: false, error: `Unknown bot "${botId}"` };
  return store.setSelection(userKey, bot, opts);
}

function getStoredSelection(numberOrJid) {
  return store.getSelection(numberOrJid)?.botId || null;
}

function getSelectionRecord(numberOrJid) {
  return store.getSelection(numberOrJid);
}

// ── Message unwrapping ───────────────────────────────────────────────────────
function _unwrap(message, depth = 0) {
  if (!message || depth > 4) return message;
  if (message.ephemeralMessage)     return _unwrap(message.ephemeralMessage.message, depth + 1);
  if (message.viewOnceMessage)      return _unwrap(message.viewOnceMessage.message, depth + 1);
  if (message.viewOnceMessageV2)    return _unwrap(message.viewOnceMessageV2.message, depth + 1);
  if (message.viewOnceMessageV2Extension)
    return _unwrap(message.viewOnceMessageV2Extension.message, depth + 1);
  if (message.documentWithCaptionMessage)
    return _unwrap(message.documentWithCaptionMessage.message, depth + 1);
  return message;
}

/**
 * Pull a bot id out of any WhatsApp reply shape.
 * Returns a canonical bot id, or null when the message is not a valid choice.
 */
function _extractSelection(rawMessage) {
  const message = _unwrap(rawMessage);
  if (!message) return null;

  const bots = scanBots();
  const candidates = [];

  // 1. List reply
  const listReply = message.listResponseMessage?.singleSelectReply?.selectedRowId;
  if (listReply) candidates.push(listReply);

  // 2. Interactive / native flow reply
  const nf = message.interactiveResponseMessage?.nativeFlowResponseMessage;
  if (nf?.paramsJson) {
    try {
      const parsed = JSON.parse(nf.paramsJson);
      for (const k of ['id', 'rowId', 'selected_id', 'selectedId']) {
        if (parsed?.[k]) candidates.push(parsed[k]);
      }
      // single_select nests the choice one level deeper on some clients
      const nested = parsed?.selectedRowId || parsed?.selected_row_id;
      if (nested) candidates.push(nested);
    } catch {}
  }

  // 2b. Some clients answer a native flow with a plain body text or a
  //     `interactiveResponseMessage.body.text` holding the row title.
  const irBody = message.interactiveResponseMessage?.body?.text;
  if (irBody) candidates.push(irBody);
  const nfName = message.interactiveResponseMessage?.nativeFlowResponseMessage?.name;
  if (nfName && nfName !== 'single_select' && nfName !== 'quick_reply') candidates.push(nfName);

  // 3. Buttons / template replies
  if (message.buttonsResponseMessage?.selectedButtonId) {
    candidates.push(message.buttonsResponseMessage.selectedButtonId);
  }
  if (message.templateButtonReplyMessage?.selectedId) {
    candidates.push(message.templateButtonReplyMessage.selectedId);
  }

  // Any structured candidate must resolve to a real bot.
  for (const c of candidates) {
    const bot = getBotById(c);
    if (bot) return bot.id;
    const lcc = String(c)
      .replace(/^deploy:/i, '')
      .replace(/^[^a-z0-9]+/i, '')
      .trim()
      .toLowerCase();
    const byName = bots.find(
      b => b.name.toLowerCase() === lcc || lcc.includes(b.id.toLowerCase()) || lcc.includes(b.name.toLowerCase()),
    );
    if (byName) return byName.id;
  }

  // 4. Typed reply — strict, and never matches empty/blank input.
  const text = (
    message.conversation ||
    message.extendedTextMessage?.text ||
    ''
  ).trim();

  if (!text) return null;

  // "1" / "2"
  if (/^\d{1,2}$/.test(text)) {
    const idx = parseInt(text, 10) - 1;
    if (idx >= 0 && idx < bots.length) return bots[idx].id;
    return null;
  }

  const lc = text.toLowerCase();
  // Exact id or exact name
  const exact = bots.find(b => b.id.toLowerCase() === lc || b.name.toLowerCase() === lc);
  if (exact) return exact.id;

  // Native-flow fallbacks on some WhatsApp versions send the visible row
  // title (for example "🟢 New Page") as extended text instead of the row id.
  const undecorated = lc.replace(/^[^a-z0-9]+/i, '').trim();
  const visibleTitle = bots.find(
    b => b.id.toLowerCase() === undecorated || b.name.toLowerCase() === undecorated,
  );
  if (visibleTitle) return visibleTitle.id;

  // Whole-word-ish partial: require at least 3 characters so stray chatter
  // cannot silently pick a bot.
  if (lc.length >= 3) {
    const partial = bots.filter(
      b => b.name.toLowerCase().includes(lc) || b.id.toLowerCase().includes(lc)
    );
    if (partial.length === 1) return partial[0].id;
  }

  return null;
}

/**
 * Called from pair.js `messages.upsert`.
 * @returns {boolean} true when the message was consumed by the deploy flow.
 */
function handleIncomingMessage(numberOrJid, rawMessage) {
  const key = jidKey(numberOrJid);
  if (!key) return false;

  const entry = _pendingSelections.get(key);
  if (!entry) return false;

  const selectedId = _extractSelection(rawMessage);
  if (!selectedId) {
    // Visible diagnostics: previously a tap that we failed to parse looked
    // exactly like "the user never answered".
    try {
      const m = _unwrap(rawMessage) || {};
      console.log(chalk.gray(
        `[DeployMgr] ${key} sent "${Object.keys(m)[0] || 'unknown'}" while awaiting selection — not a valid choice`,
      ));
    } catch {}
    return false; // let the normal command pipeline handle it
  }

  clearTimeout(entry.timer);
  clearInterval(entry.reminder);
  _pendingSelections.delete(key);
  entry.resolve(selectedId);
  return true;
}

/** True while we are waiting on this user to pick a bot. */
function isAwaitingSelection(numberOrJid) {
  return _pendingSelections.has(jidKey(numberOrJid));
}

/** Cancel a pending wait (e.g. the socket dropped). */
function cancelSelection(numberOrJid) {
  const key = jidKey(numberOrJid);
  const entry = _pendingSelections.get(key);
  if (!entry) return false;
  clearTimeout(entry.timer);
  clearInterval(entry.reminder);
  _pendingSelections.delete(key);
  entry.resolve(null);
  return true;
}

// ── Wait for the user's choice — never guesses on their behalf ───────────────
function _waitForSelection(userKey, onRemind) {
  // Clean up any stale in-memory waiter before creating a new one.
  // Without this, a reconnect spawns a second startDeploymentFlow which
  // overwrites _pendingSelections[userKey] — the orphaned timer for the
  // first call eventually fires and sends "No bot chosen yet" even after
  // the user already picked (or is still picking) via the new connection.
  const stale = _pendingSelections.get(userKey);
  if (stale) {
    clearTimeout(stale.timer);
    clearInterval(stale.reminder);
    _pendingSelections.delete(userKey);
    // Intentionally NOT calling stale.resolve(null) here — the previous
    // startDeploymentFlow's await is already abandoned by the caller-side
    // guard in pair.js (isAwaitingSelection check). If somehow the old await
    // is still live it will simply never resolve, which is harmless compared
    // to sending a spurious "No bot chosen yet" message.
  }

  return new Promise(resolve => {
    const timer = setTimeout(() => {
      const e = _pendingSelections.get(userKey);
      if (e) clearInterval(e.reminder);
      _pendingSelections.delete(userKey);
      resolve(null); // null == no choice made; caller must NOT pick for them
    }, GIVE_UP_MS);

    const reminder = setInterval(() => {
      Promise.resolve()
        .then(onRemind)
        .catch(e => console.warn(chalk.yellow(`[DeployMgr] Reminder failed: ${e.message}`)));
    }, REMINDER_MS);

    if (typeof timer.unref === 'function') timer.unref();
    if (typeof reminder.unref === 'function') reminder.unref();

    _pendingSelections.set(userKey, { resolve, timer, reminder });
  });
}


// ── Live deploy context, so any surface can deploy after the socket is gone ──
// key -> { sessionDir, launcher, nexus, tracker }
const _deployContext = new Map();

function rememberContext(numberOrJid, ctx) {
  const key = jidKey(numberOrJid);
  if (!key) return;
  _deployContext.set(key, { ...(_deployContext.get(key) || {}), ...ctx });
}

function _resolveContext(numberOrJid) {
  const key = jidKey(numberOrJid);
  const ctx = _deployContext.get(key) || {};

  let sessionDir = ctx.sessionDir;
  if (!sessionDir) {
    try {
      const pairMod = require('../pair.js');
      if (typeof pairMod.getSessionPath === 'function') {
        sessionDir = path.resolve(pairMod.getSessionPath(`${key}@s.whatsapp.net`));
      }
    } catch {}
  }
  if (!sessionDir) {
    sessionDir = _sessionPaths.sessionDirFor(key);
  }

  let launcher = ctx.launcher;
  if (!launcher) {
    try { launcher = require('../mais_launcher'); } catch {}
  }

  return { ...ctx, sessionDir, launcher };
}

// ── Launch a bot for a number (surface-agnostic) ─────────────────────────────
/**
 * Records the choice (respecting the lock) and boots the bot.
 * Safe to call from Telegram, the admin panel, or the WhatsApp menu.
 *
 * @returns {Promise<{ok:boolean, bot?:object, locked?:boolean, error?:string}>}
 */
const _deployInFlight = new Map();

async function deployBotForNumber(numberOrJid, botId, opts = {}) {
  const key = jidKey(numberOrJid);
  if (!key) return { ok: false, error: 'Invalid number.' };

  // Serialise per number: the WhatsApp selector, a Telegram admin and the web
  // panel can all fire within the same second for one number. Without this the
  // second call ran the whole handoff again while the first was still sleeping.
  const busy = _deployInFlight.get(key);
  if (busy) {
    console.log(chalk.gray(`[DeployMgr] Deployment already in progress for ${key} — joining it`));
    return busy;
  }
  const run = _deployBotForNumber(key, botId, opts).finally(() => _deployInFlight.delete(key));
  _deployInFlight.set(key, run);
  return run;
}

async function _deployBotForNumber(key, botId, opts = {}) {

  const bot = getBotById(botId);
  if (!bot) return { ok: false, error: `Unknown bot "${botId}".` };

  const written = store.setSelection(key, bot, {
    source:   opts.source || 'unknown',
    chosenBy: opts.chosenBy || null,
    force:    !!opts.force,
  });

  if (!written.ok) return written; // locked — caller shows the message

  // ── The choice is made: kill every selector on EVERY platform right now ──
  // (WhatsApp menu + Telegram menus sent to the owner and to each admin.)
  try {
    await selectorRegistry.revokeAll(key, {
      replacement: `✅ Bot chosen: *${bot.name}* for \`${key}\`.`,
    });
  } catch (e) {
    console.warn(chalk.yellow(`[DeployMgr] Selector cleanup failed: ${e.message}`));
  }

  // A pending WhatsApp waiter (if any) must be released so the old flow does
  // not keep re-sending its menu after the choice was made elsewhere.
  const pending = _pendingSelections.get(key);
  if (pending) {
    clearTimeout(pending.timer);
    clearInterval(pending.reminder);
    _pendingSelections.delete(key);
    pending.resolve(bot.id);
    // The pairing socket owner performs the launch in that case.
    return { ok: true, bot, handedOff: true, record: written.record };
  }

  const { sessionDir, launcher, nexus, tracker } = _resolveContext(key);
  if (!launcher || typeof launcher.launch !== 'function') {
    return { ok: false, error: 'Launcher unavailable on this instance.' };
  }

  if (!fs.existsSync(sessionDir)) {
    return { ok: false, error: `No WhatsApp session found for ${key}. Pair the number first.` };
  }

  try {
    if (typeof opts.onProgress === 'function') {
      await opts.onProgress(bot);
    }

    // Tell the user on WhatsApp that their bot is coming up, then hand over.
    const jid = toJid(key);
    if (nexus) {
      try {
        const { reportQuickDeploy, sendReadyMessage } = require('./progressReporter');
        const msgKey = await reportQuickDeploy(nexus, jid, bot);
        await sendReadyMessage(nexus, jid, bot, key, msgKey);
      } catch (e) {
        console.warn(chalk.yellow(`[DeployMgr] Progress report failed: ${e.message}`));
      }
    } else {
      await _sleep(SPAWN_DELAY_MS);
    }

    // Record the handoff BEFORE the socket is closed. The 401 that WhatsApp
    // sends for the replaced connection arrives within a second or two, and the
    // pairing side must already know the bot owns this identity by then.
    ownership.handOffToBot(key, bot.id);
    if (tracker) { tracker.handoffToMais = true; tracker.handedOffAt = Date.now(); }
    if (nexus) {
      try { nexus.end(); } catch {}
      try { nexus.ws?.close(); } catch {}
      selectorRegistry.detachSocket(key);
      // Give Baileys time to flush the final auth-key updates and fully release
      // the websocket before the selected child opens the same session.
      await _sleep(6000);
    }

    const envOverrides = {
      ...(bot.env || {}),
      BOT_ENTRY: bot.entry || 'mias/index.js',
      BOT_ID: bot.id,
    };
    if (bot.cwd) envOverrides.BOT_CWD = bot.cwd;

    // ALWAYS launch under the canonical "<digits>@s.whatsapp.net" key. The old
    // code used the raw caller value in one path and this form in another, so
    // the launcher's `running` map held two entries for the same number and
    // spawned a SECOND bot process — duplicate/《double》replies and session
    // fights ("connection replaced") that ended in a silent bot.
    await launcher.launch(`${key}@s.whatsapp.net`, sessionDir, envOverrides);
    store.markDeployed(key, true);
    console.log(chalk.green.bold(`🎉 ${bot.name} active for ${key}`));
    return { ok: true, bot, record: written.record };
  } catch (e) {
    console.error(chalk.red(`[DeployMgr] Launch failed for ${key}: ${e.message}`));
    return { ok: false, bot, error: e.message };
  }
}


/**
 * Submit a choice from Telegram / admin panel.
 * Thin wrapper that keeps the lock semantics in one place.
 */
async function submitSelection(numberOrJid, botId, opts = {}) {
  return deployBotForNumber(numberOrJid, botId, opts);
}

// ── Core deployment flow (called by pair.js on `connection: open`) ───────────
/**
 * IMPORTANT BEHAVIOUR CHANGE
 * --------------------------
 * The WhatsApp selection menu is now BEST EFFORT ONLY. Immediately after a new
 * device is linked, WhatsApp has not finished syncing that device's encryption
 * keys, so the very first self-message frequently renders as
 *   "Waiting for this message. This may take a while."
 * and is impossible to tap. Blocking deployment on it meant nothing deployed.
 *
 * The number is instead marked as AWAITING SELECTION and the user picks their
 * bot from Telegram with /number (or an admin picks it in the web panel).
 * If the WhatsApp menu does happen to arrive and gets tapped, that still works.
 *
 * @param {object} nexus        Baileys pairing socket
 * @param {string} numberOrJid  Bare number (pair.js) or full JID
 * @param {object} tracker      rentbotTracker entry
 * @param {string} sessionDir   Absolute session path
 * @param {object} launcher     mais_launcher module
 */
async function startDeploymentFlow(nexus, numberOrJid, tracker, sessionDir, launcher) {
  const bots    = scanBots();
  const userKey = jidKey(numberOrJid);
  const jid     = toJid(numberOrJid);

  if (!userKey || !jid) {
    console.error(chalk.red(`[DeployMgr] Bad recipient "${numberOrJid}" — aborting`));
    return null;
  }

  rememberContext(userKey, { sessionDir, launcher, nexus, tracker });
  selectorRegistry.attachSocket(userKey, nexus);

  const { sendBotSelectionMenu } = require('./botSelector');
  const { reportQuickDeploy, sendReadyMessage } = require('./progressReporter');


  // ── 1. Already locked to a bot? Re-deploy it, never ask again. ────────────
  const locked = store.getSelection(userKey);
  if (locked?.botId) {
    const bot = getBotById(locked.botId);
    if (bot) {
      console.log(chalk.cyan(`[DeployMgr] ${userKey} is locked to ${bot.name} — deploying without a menu`));
      try {
        await nexus.sendMessage(jid, {
          text:
            `🔒 *${bot.name}* is already your bot.\n\n` +
            `Starting it up now. To switch bots you must unpair this number and pair again.`,
        });
      } catch {}
      const res = await deployBotForNumber(userKey, bot.id, { source: 'auto-relaunch' , force: true });
      return res.ok ? bot : null;
    }
  }

  // ── 2. Mark awaiting + tell every surface ────────────────────────────────
  store.markPending(userKey, { sessionDir, source: 'pairing' });
  console.log(chalk.cyan(`[DeployMgr] ${userKey} paired — awaiting bot selection (Telegram /number)`));

  try {
    const notifier = require('../notify');
    if (typeof notifier.sendSelectionRequired === 'function') {
      await notifier.sendSelectionRequired(userKey, bots);
      store.markNotified(userKey);
    }
  } catch (e) {
    console.warn(chalk.yellow(`[DeployMgr] Telegram notify failed: ${e.message}`));
  }

  // ── 3. Best-effort WhatsApp menu — never blocks, never required ──────────
  const selectionPromise = _waitForSelection(userKey, async () => {
    // If the choice arrived via Telegram/web while we were waiting, stop the
    // reminder loop but do NOT call cancelSelection — that resolves with null
    // which sends a spurious "No bot chosen yet" message even though the bot
    // was already chosen. Instead let the pending waiter be cleaned up by the
    // deployBotForNumber path (which calls pending.resolve(bot.id) directly).
    if (store.getSelection(userKey)) {
      const e = _pendingSelections.get(userKey);
      if (e) { clearInterval(e.reminder); }
      return;
    }
    console.log(chalk.gray(`[DeployMgr] Re-sending menu to ${jid}`));
    await sendBotSelectionMenu(nexus, jid, bots).catch(() => {});
  });

  sendBotSelectionMenu(nexus, jid, bots).catch(e => {
    console.warn(chalk.yellow(`[DeployMgr] WhatsApp menu unavailable (${e.message}) — Telegram /number still works`));
  });

  const selectedId = await selectionPromise;

  // ── 4. Nobody tapped the WhatsApp menu ───────────────────────────────────
  if (!selectedId) {
    // The choice may have arrived through Telegram while we waited; if it did,
    // deployBotForNumber already launched the bot.
    const now = store.getSelection(userKey);
    if (now?.botId) {
      console.log(chalk.green(`[DeployMgr] ${userKey} chose ${now.botName} elsewhere`));
      return getBotById(now.botId);
    }
    console.log(chalk.yellow(`[DeployMgr] ${userKey} has not chosen a bot yet — still pending`));
    try {
      await nexus.sendMessage(jid, {
        text:
          `⌛ *No bot chosen yet*\n\n` +
          `Open Telegram and send *\/number* to pick your bot.\n` +
          `Nothing is deployed until you choose.`,
      });
    } catch {}
    return null;
  }

  // ── 5. WhatsApp menu worked ──────────────────────────────────────────────
  const chosen = getBotById(selectedId);
  if (!chosen) {
    console.error(chalk.red(`[DeployMgr] Unknown bot id "${selectedId}" — not deploying`));
    return null;
  }

  // A Telegram/admin choice resolves the same pending waiter after it has
  // already persisted and locked the selection. Do not treat that expected
  // handoff as a conflicting second choice or return before launcher.launch().
  const existingSelection = store.getSelection(userKey);
  let written;
  if (existingSelection?.botId === chosen.id) {
    written = { ok: true, record: existingSelection, handedOff: true };
  } else {
    written = _writeSelection(userKey, chosen.id, { source: 'whatsapp' });
  }
  if (!written.ok) {
    try { await nexus.sendMessage(jid, { text: `🔒 ${written.error}` }); } catch {}
    return null;
  }

  console.log(chalk.green(`[DeployMgr] ${userKey} chose: ${chosen.name} (${chosen.id})`));

  // ── 5a. Delete the selector EVERYWHERE, immediately ──────────────────────
  try {
    await selectorRegistry.revokeAll(userKey, {
      sock: nexus,
      replacement: `✅ Bot chosen: *${chosen.name}* for \`${userKey}\`.`,
    });
  } catch (e) {
    console.warn(chalk.yellow(`[DeployMgr] Selector cleanup failed: ${e.message}`));
  }

  // ── 5b. 3-second spawn: confirm, count down, announce, launch ────────────
  let progressKey = null;
  try {
    progressKey = await reportQuickDeploy(nexus, jid, chosen);
  } catch (e) {
    console.warn(chalk.yellow(`[DeployMgr] Progress report failed: ${e.message}`));
  }

  try {
    // The "connected / ready to use" card must go out on the pairing socket,
    // because the socket is closed a moment later for the handoff.
    await sendReadyMessage(nexus, jid, chosen, userKey, progressKey);
  } catch (e) {
    console.warn(chalk.yellow(`[DeployMgr] Ready message failed: ${e.message}`));
  }

  try {
    console.log(chalk.cyan(`[DeployMgr] Handing ${jid} over to ${chosen.name}…`));
    ownership.handOffToBot(userKey, chosen.id);
    if (tracker) { tracker.handoffToMais = true; tracker.handedOffAt = Date.now(); }
    try { nexus.end(); } catch {}
    try { nexus.ws?.close(); } catch {}
    selectorRegistry.detachSocket(userKey);

    // Starting the child in the same tick as closing the pairing socket makes
    // both sockets briefly use one Signal session. That causes "closed session"
    // decrypt errors and can get the newly selected bot replaced immediately.
    await _sleep(6000);

    const envOverrides = {
      ...(chosen.env || {}),
      BOT_ENTRY: chosen.entry || 'mias/index.js',
      BOT_ID: chosen.id,
    };
    if (chosen.cwd) envOverrides.BOT_CWD = chosen.cwd;

    // Canonical launcher key — see the note in deployBotForNumber(). Using the
    // raw `numberOrJid` here was spawning a duplicate process for numbers that
    // had already been launched from Telegram/web.
    await launcher.launch(`${userKey}@s.whatsapp.net`, sessionDir, envOverrides);
    store.markDeployed(userKey, true);
    console.log(chalk.green.bold(`🎉 ${chosen.name} active for ${jid}`));
    return chosen;
  } catch (e) {
    console.error(chalk.red(`[DeployMgr] Launch failed for ${jid}: ${e.message}`));
    return null;
  }
}


module.exports = {
  scanBots,
  clearBotCache,
  getBotById,
  getStoredSelection,
  getSelectionRecord,
  handleIncomingMessage,
  isAwaitingSelection,
  cancelSelection,
  startDeploymentFlow,
  // new, surface-agnostic API
  store,
  submitSelection,
  deployBotForNumber,
  rememberContext,
};
