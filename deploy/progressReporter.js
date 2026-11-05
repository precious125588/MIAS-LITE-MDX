'use strict';
/**
 * MIAS Deployment Progress Reporter
 *
 * Sends ONE message and edits it live as the chosen bot boots.
 *
 * CHANGED: the deployment used to run a 1 → 100 counter across ~18 edits and
 * ~15 seconds before the bot was even launched. The requirement is now
 * "chosen bot spawns in 3 seconds", so `reportQuickDeploy()` finishes in
 * exactly SPAWN_WINDOW_MS and `sendReadyMessage()` posts the connection card.
 * `reportDeployProgress()` (the slow counter) is kept for compatibility.
 */

// chalk 4 is CJS, chalk 5 is ESM-with-default — tolerate both so a hoisted v5
// can never crash a deployment with "chalk.green is not a function".
const _chalk = require('chalk');
const chalk = typeof _chalk?.green === 'function' ? _chalk : (_chalk?.default || {
  green: s => s, yellow: s => s, red: s => s, cyan: s => s, gray: s => s,
});


const BAR_LENGTH      = 20;
const MAX_EDITS       = 18;    // slow mode only
const EDIT_GAP_MS     = 850;   // slow mode only
const SPAWN_WINDOW_MS = 3000;  // total time from choice -> bot ready
const QUICK_EDITS     = 3;     // 3 frames, one per second

function _bar(pct) {
  const filled = Math.max(0, Math.min(BAR_LENGTH, Math.round((pct / 100) * BAR_LENGTH)));
  return '█'.repeat(filled) + '░'.repeat(BAR_LENGTH - filled);
}

function _sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Edit `msgKey` if we have one, otherwise send a fresh message.
 * Never throws — progress reporting must not break a deployment.
 * @returns {Promise<object|null>} the key of the message now on screen
 */
async function _emit(sock, jid, text, msgKey) {
  try {
    if (msgKey) {
      await sock.sendMessage(jid, { text, edit: msgKey });
      return msgKey;
    }
    const sent = await sock.sendMessage(jid, { text });
    return sent?.key || null;
  } catch (e) {
    console.warn(chalk.yellow(`[ProgressReporter] emit failed: ${e.message}`));
    return msgKey || null;
  }
}

/**
 * 3-second deploy animation. Resolves once the window has elapsed so the
 * caller can spawn the bot immediately after.
 * @returns {Promise<object|null>} message key to keep editing
 */
async function reportQuickDeploy(sock, jid, bot = {}) {
  const botName = bot.name || 'Bot';
  const steps = (bot.deploySteps && bot.deploySteps.length)
    ? bot.deploySteps
    : ['Session verified', 'Modules loaded', 'Bringing bot online'];

  let msgKey = await _emit(
    sock, jid,
    `✅ You chose *${botName}*\n\n${_bar(0)}\n*0%*\n\n⚙️ _Spawning your bot…_`,
    null,
  );

  const gap = Math.max(250, Math.round(SPAWN_WINDOW_MS / QUICK_EDITS));
  for (let i = 1; i <= QUICK_EDITS; i++) {
    await _sleep(gap);
    const pct  = Math.round((i / QUICK_EDITS) * 100);
    const step = steps[Math.min(steps.length - 1, i - 1)];
    msgKey = await _emit(
      sock, jid,
      `✅ You chose *${botName}*\n\n${_bar(pct)}\n*${pct}%*\n\n⚙️ _${step}…_`,
      msgKey,
    );
  }
  return msgKey;
}

/**
 * The "you are connected, the bot is live" card. Sent right after the 3-second
 * window and just before the pairing socket is handed over to the bot process.
 */
async function sendReadyMessage(sock, jid, bot = {}, number = '', msgKey = null) {
  const botName = bot.name || 'Bot';
  const prefix  = process.env.PREFIX || '.';
  const statusBadge =
    bot.status === 'stable' ? '🟢 Stable' :
    bot.status === 'beta'   ? '🟡 Beta'   : '⚪ Experimental';

  const text =
    `╔══════════════════════════════╗\n` +
    `║   ✅ *CONNECTED & READY* ✅\n` +
    `╠══════════════════════════════╣\n` +
    `║ 🤖 *Bot:*     ${botName}\n` +
    `║ 📱 *Number:*  ${String(number || '').replace(/\D/g, '')}\n` +
    `║ 📦 *Version:* ${bot.version || 'latest'}\n` +
    `║ 🏷 *Status:*  ${statusBadge}\n` +
    `║ 🔑 *Prefix:*  ${prefix}\n` +
    `╚══════════════════════════════╝\n\n` +
    `Your bot is *live now*.\n` +
    `Send *${prefix}menu* to see everything it can do.\n\n` +
    `🔒 This number is locked to *${botName}*. Unpair and pair again to switch.\n` +
    `⚡ _Powered by MIAS Platform_`;

  await _emit(sock, jid, text, msgKey);
  console.log(chalk.green(`[ProgressReporter] ${botName} ready card sent to ${jid}`));
  return true;
}

/**
 * Legacy slow 1 → 100 counter, delivered in MAX_EDITS throttled updates.
 */
async function _reportCounter(sock, jid, bot) {
  const botName = bot.name || 'Bot';
  const steps   = (bot.deploySteps && bot.deploySteps.length)
    ? bot.deploySteps
    : ['Starting up', 'Loading modules', 'Connecting', 'Deployment complete'];

  let msgKey = null;
  try {
    const sent = await sock.sendMessage(jid, {
      text: `⚡ *Deploying ${botName}…*\n\n${_bar(0)}\n*0 / 100*\n\n_Starting up…_`,
    });
    msgKey = sent?.key || null;
  } catch (e) {
    console.warn(chalk.yellow(`[ProgressReporter] initial send failed: ${e.message}`));
  }

  const edits = Math.min(MAX_EDITS, 100);
  const done  = [];

  for (let i = 1; i <= edits; i++) {
    const count    = Math.round((i / edits) * 100);
    const stepIdx  = Math.min(steps.length - 1, Math.floor(((i - 1) / edits) * steps.length));
    const current  = steps[stepIdx];

    if (done[done.length - 1] !== current) done.push(current);

    const finished = done.slice(0, -1).map(s => `✅ ${s}`).join('\n');

    const text = [
      `⚡ *Deploying ${botName}…*`,
      '',
      _bar(count),
      `*${count} / 100*`,
      '',
      `⚙️ _${current}_`,
      finished ? `\n${finished}` : '',
    ].join('\n');

    await _emit(sock, jid, text, msgKey);
    await _sleep(EDIT_GAP_MS);
  }

  await sendReadyMessage(sock, jid, bot, '', msgKey);
  console.log(chalk.green(`[ProgressReporter] ${botName} deployment reported for ${jid}`));
  return msgKey;
}

/**
 * @param {object} sock Baileys socket
 * @param {string} jid  Full recipient JID
 * @param {object} bot  Chosen bot manifest
 */
async function reportDeployProgress(sock, jid, bot) {
  return _reportCounter(sock, jid, bot || {});
}

module.exports = { reportDeployProgress, reportQuickDeploy, sendReadyMessage, SPAWN_WINDOW_MS };
