'use strict';

/**
 * notify.js — Central Notification and Activity Logger for MIAS LITE MDX
 *
 * Handles WhatsApp session events, connection state logging, and live status
 * reporting without external bot dependencies.
 */

const chalk = require('chalk');

async function sendNotification(message) {
  const preview = String(message || '').replace(/\*/g, '').replace(/`/g, '').trim();
  console.log(chalk.cyan(`[Notification] ${preview.split('\n')[0] || ''}`));
}

async function sendUserConnected(userNumber) {
  const BOT_NM = process.env.BOT_NAME || 'MIAS LITE MDX';
  const time = new Date().toLocaleTimeString('en-GB', { timeZone: 'Africa/Lagos' });
  console.log(chalk.green(`\n╔══════════════════════════════════════════╗`));
  console.log(chalk.green(`║  ✅ [${BOT_NM}] SESSION CONNECTED        `));
  console.log(chalk.green(`║  📱 User:  +${userNumber}                `));
  console.log(chalk.green(`║  🕐 Time:  ${time} (Lagos)               `));
  console.log(chalk.green(`╚══════════════════════════════════════════╝\n`));
}

async function sendUserDisconnected(userNumber, reason = 'Unknown', options = {}) {
  const BOT_NM = process.env.BOT_NAME || 'MIAS LITE MDX';
  const reconnecting = options.reconnecting !== false;
  console.log(chalk.yellow(`\n[${BOT_NM}] ⚠️ User +${userNumber} disconnected: ${reason} (reconnecting: ${reconnecting})`));
}

async function sendBotStartMessage() {
  const BOT_NM = process.env.BOT_NAME || 'MIAS LITE MDX';
  console.log(chalk.bold.green(`🚀 [${BOT_NM}] Multi-Device Automation Ready.`));
}

async function sendSelectionRequired(userNumber, bots = []) {
  const number = String(userNumber).replace(/\D/g, '');
  if (!number) return;
  console.log(chalk.cyan(`[Session] Phone +${number} ready — default bot assigned: ${bots[0]?.name || 'MIAS MDX'}`));
}

module.exports = {
  sendNotification,
  sendSelectionRequired,
  sendUserConnected,
  sendUserDisconnected,
  sendBotStartMessage
};
