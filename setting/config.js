/**
 * ═══════════════════════════════════════════════════════════════════════
 *  MIAS LITE MDX — Master Configuration
 * ═══════════════════════════════════════════════════════════════════════
 *  Engineered with precision for multi-device stability & rapid deployment.
 *  Dynamic environment variable bindings with robust fallback defaults.
 * 
 *  @author 𝑷𝑹𝑬𝑪𝑰𝑶𝑼𝑺 x
 *  @version 2.0.0
 *  @license Licensed by 𝑷𝑹𝑬𝑪𝑰𝑶𝑼𝑺 x (MIT)
 * ═══════════════════════════════════════════════════════════════════════
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

// ── 1. Core Bot & Owner Identity ──────────────────────────────────────────
const rawOwnerNumber = (process.env.OWNER_NUMBER || process.env.OWNER || '').replace(/[^0-9]/g, '');
const ownerNumber = rawOwnerNumber || '234';
const ownerName = process.env.OWNER_NAME || process.env.BOT_ACTIVE_USER || '𖤐JINX𖤐';
const botName = process.env.BOT_NAME || 'MIAS LITE MDX';

global.BOT_NAME = botName;
global.botName = botName;
global.botname = botName;
global.bankowner = botName;
global.footer = botName;
global.author = botName;

global.OWNER_NAME = ownerName;
global.ownername = ownerName;
global.creatorName = ownerName;
global.ownernumber = ownerNumber;
global.owner = [ownerNumber];
global.DEVELOPER = [ownerNumber];
global.creator = (ownerNumber ? ownerNumber : '234') + '@s.whatsapp.net';

// ── 2. Branding & Media Assets ────────────────────────────────────────────
global.location = 'Nigeria';
global.themeemoji = '🥷';
global.thumbnail = 'https://i.ibb.co/hRxLvCWb/RD32333335343832373039383440732e77686174736170702e6e6574-499562.jpg';
global.gambar = global.thumbnail;
global.richpp = ' ';
global.packname = 'Sticker By ' + botName;
global.version = '2.0.0';

// ── 3. Command Prefixes & Navigation ──────────────────────────────────────
const configuredPrefix = (process.env.PREFIX || '.').trim();
global.xprefix = configuredPrefix;
global.prefa = ['', '!', '.', '#', '&'];

// ── 4. Social & Community Links ───────────────────────────────────────────
global.link = 'https://chat.whatsapp.com/Bnrx29Li2mZDS2LKxI9LYM';
global.wagc = global.link;

// ── 5. Automation & Event Triggers ────────────────────────────────────────
global.status = false;
global.hituet = 0;
global.autobio = true;
global.autoread = false;
global.autoviewstatus = true;
global.autoswview = true;
global.anti92 = true;

// ── 6. System & Permission Messages ───────────────────────────────────────
global.onlyowner = 'Only the bot owner can use this command 🥶🥷';
global.database = '*To exist in the database, contact the bot owner*';

global.mess = {
  wait: '⚡ *Processing your request...*',
  success: '✅ *Successfully acknowledged*',
  on: '🟢 *Activated*',
  off: '🔴 *Deactivated*',
  prem: '💎 *This feature is reserved for premium users only*',
  query: {
    text: '📑 *Please provide a valid text query*',
    link: '🔗 *Please provide a valid link*',
  },
  error: {
    fitur: '❌ *Status: Feature or command execution error*',
  },
  only: {
    group: '👥 *This command is available in groups only*',
    private: '💬 *This command is available in private chats only*',
    owner: '👑 *This command is restricted to the bot owner*',
    admin: '🛡️ *This command is restricted to group admins*',
    badmin: '⚠️ *Bot requires administrative privileges to execute this command*',
    premium: '💎 *Available for premium subscribers only*',
  },
};

module.exports = {
  ownerNumber,
  ownerName,
  botName,
  prefix: configuredPrefix,
};
