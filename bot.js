require('dotenv').config();
require('./setting/config');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const chalk = require('chalk');
const os = require('os');
const QRCode = require('qrcode');
const { httpClient: axios } = require('./mias/lib/engineAccess.cjs');
const { getBotToken } = (() => {
  try { return require('./nexstore_modules/token'); } catch {}
  try { return require('./nexstore/token'); } catch {}
  return { getBotToken: () => "" };
})();
const { autoLoadPairs } = require('./autoload');
const BOT_TOKEN = getBotToken();

// Initialize bot — guard against missing token to prevent EFATAL spam
//
// FIX (Telegram pairing stuck for minutes, then errors):
//   The previous version called `process.exit(0)` whenever TELEGRAM_BOT_TOKEN
//   was missing. Because bot.js is loaded as a sibling of the WhatsApp
//   process (`server.js` `require()`s it during start), that exit took down
//   the *entire* pairing server with it. The web UI then hung for the full
//   OS socket timeout while waiting for `/api/pair/*` routes that no longer
//   existed, finally surfacing a generic 504 / WebSocket error.
//
//   The fix is: stay alive when the token is missing. We only emit a
//   warning, populate `global._telegramBotState` for the admin panel, and
//   return without spawning a poller. The HTTP server (and WhatsApp
//   pairing flow) keep running exactly as before.
if (!BOT_TOKEN || BOT_TOKEN.trim() === '') {
  console.warn(chalk.yellow('⚠️  TELEGRAM_BOT_TOKEN not set — Telegram pair-bot is OFFLINE.'));
  console.warn(chalk.yellow('    Set TELEGRAM_BOT_TOKEN in .env to enable the Telegram pair-bot.'));
  console.warn(chalk.yellow('    WhatsApp bot continues normally.'));
  global._telegramBotState = {
    configured: false,
    polling:    false,
    lastError:  null,
    startedAt:  Date.now(),
  };
  // Do NOT exit — exit would tear down the parent process and prevent the
  // web pairing page from responding. Just stand down.
  return;
}

global._telegramBotState = {
  configured: true,
  polling: false,
  lastError: null,
  startedAt: Date.now(),
};
// ── SINGLE-POLLER GUARD (fixes Telegram 409 Conflict) ────────────────────────
// Telegram allows exactly ONE getUpdates poller per bot token. A 409
// "terminated by other getUpdates request" happened because:
//   1. /api/admin/settings/bot-token did `require('./bot')` again after busting
//      the cache, spawning a SECOND poller while the first kept running, and
//   2. on Railway redeploys the old container polls until it is reaped.
// We keep one poller per process on a global, stop any previous one before
// starting a new one, and drop webhooks + pending updates on startup.
if (global._miasTelegramBot) {
  try { global._miasTelegramBot.stopPolling({ cancel: true }); } catch {}
  console.warn(chalk.yellow('⚠️  [Telegram] Stopped previous poller before restart (prevents 409).'));
  global._miasTelegramBot = null;
}

const bot = new TelegramBot(BOT_TOKEN, {
  polling: { interval: 1000, autoStart: false, params: { timeout: 10 } },
});
global._miasTelegramBot = bot;

function redactSecrets(value = '') {
  let text = String(value);
  if (BOT_TOKEN) text = text.split(BOT_TOKEN).join('<TELEGRAM_BOT_TOKEN>');
  return text.replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot<TELEGRAM_BOT_TOKEN>');
}

function safeErrorMessage(err) {
  const raw = err?.response?.body?.description || err?.message || err?.code || String(err || 'Unknown error');
  return redactSecrets(raw);
}

function logSafeError(label, err) {
  console.error(label, safeErrorMessage(err));
}

// A webhook and getUpdates are mutually exclusive; drop_pending_updates also
// clears the backlog the dead container left behind.
(async () => {
  try { await bot.deleteWebHook({ drop_pending_updates: true }); } catch {}
  try {
    await bot.startPolling();
    global._telegramBotState.polling = true;
    global._telegramBotState.lastError = null;
    console.log(chalk.green('✅ [Telegram] Polling started.'));
  } catch (e) {
    global._telegramBotState.polling = false;
    global._telegramBotState.lastError = safeErrorMessage(e);
    logSafeError(chalk.red('[Telegram] Could not start polling:'), e);
  }
})();

// Stop cleanly on shutdown so a redeploy releases the token immediately.
let _tgClosing = false;
const _tgShutdown = () => {
  if (_tgClosing) return;
  _tgClosing = true;
  try { bot.stopPolling({ cancel: true }); } catch {}
};
process.once('SIGTERM', _tgShutdown);
process.once('SIGINT',  _tgShutdown);

// Suppress poll errors — stop on 401 (invalid token), ignore EFATAL blips
let _tgPollWarnedOnce = false;
let _tg409Count = 0;
bot.on('polling_error', (err) => {
  if (_tgClosing) return;

  // Network blip — retry silently
  if (err.code === 'EFATAL' || (err.message && err.message.includes('EFATAL'))) return;

  const msg = safeErrorMessage(err);
  if (global._telegramBotState) global._telegramBotState.lastError = msg;

  // 409 Conflict — another poller holds the token (usually the old Railway
  // container during a rolling redeploy). Back off and let it die, then
  // reclaim the token instead of hammering Telegram in a tight loop.
  if (msg.includes('409') || msg.includes('terminated by other getUpdates')) {
    _tg409Count++;
    if (_tg409Count === 1) {
      console.warn(chalk.yellow('⚠️  [Telegram] 409 Conflict — another instance is polling this token.'));
      console.warn(chalk.yellow('    Backing off 15s, then reclaiming (normal during a redeploy).'));
    }
    if (_tg409Count > 20) {
      console.error(chalk.red('❌ [Telegram] Still conflicting after 20 tries — stopping poller.'));
      console.error(chalk.red('    Make sure only ONE deployment/instance uses this bot token.'));
      try { bot.stopPolling(); } catch {}
      if (global._telegramBotState) global._telegramBotState.polling = false;
      return;
    }
    try { bot.stopPolling({ cancel: true }); } catch {}
    setTimeout(async () => {
      if (_tgClosing) return;
      try { await bot.deleteWebHook({ drop_pending_updates: true }); } catch {}
      try { await bot.startPolling(); _tg409Count = 0; console.log(chalk.green('✅ [Telegram] Token reclaimed, polling resumed.')); } catch {}
    }, 15000);
    return;
  }

  // 401 Unauthorized — token is invalid or revoked; stop spam-polling immediately
  const is401 = (err.response && err.response.statusCode === 401)
             || (err.code === 'ETELEGRAM' && msg.includes('401'));
  if (is401) {
    if (!_tgPollWarnedOnce) {
      _tgPollWarnedOnce = true;
      console.warn(chalk.yellow('⚠️  [Telegram] Token invalid (401) — Telegram bot OFFLINE.'));
      console.warn(chalk.yellow('    Fix: update TELEGRAM_BOT_TOKEN in Railway Variables.'));
      console.warn(chalk.yellow('    Web pairing still works fine without Telegram.'));
      try { bot.stopPolling(); } catch {}
      if (global._telegramBotState) global._telegramBotState.polling = false;
    }
    return;
  }

  // Other errors — log once per message to avoid flooding
  logSafeError(chalk.red('[Telegram] polling error:'), err);
});

// File paths
const adminFilePath = path.join(__dirname, 'nexstore', 'admin.json');
const userFilePath = path.join(__dirname, 'nexstore', 'users.json');
const userStatsPath = path.join(__dirname, 'nexstore', 'user_stats.json');
const welcomeSettingsPath = path.join(__dirname, 'nexstore', 'welcome_settings.json');
const goodbyeSettingsPath = path.join(__dirname, 'nexstore', 'goodbye_settings.json');
const groupVerifySettingsPath = path.join(__dirname, 'nexstore', 'group_verify_settings.json');
const groupWarningsPath = path.join(__dirname, 'nexstore', 'group_warnings.json');

// Data storage
let adminIDs = [];
let userIDs = new Set();
let userStats = {};
let welcomeSettings = {};
let goodbyeSettings = {};
let groupVerifySettings = {};
let groupWarnings = {};

// Command cooldowns
const cooldowns = new Map();

// ========================
// MAIS MDX BRANDING (env-overridable)
// ========================
const BRAND_NAME = process.env.BOT_NAME || 'MAIS MDX';
const ZUKO = {
    title: `『 ${BRAND_NAME} 』`,
    divider: '─━─━─━─━─━─━─━─━─━─',
    footer: `⚡ Powered by ${BRAND_NAME}`,
    line: '┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓',
    lineEnd: '┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛',
    titleLine: `┃      ✨ 『 ${BRAND_NAME} 』 ✨      ┃`
};

// Social/links — override via env if you want.
// IMPORTANT: every URL must be a valid http(s) link. Telegram rejects
// inline-keyboard URL buttons with empty urls as "Text buttons are unallowed".
const FALLBACK_LINK = process.env.FALLBACK_LINK || 'https://t.me/telegram';
const _link = (v) => (v && /^https?:\/\//i.test(v) ? v : FALLBACK_LINK);
const SOCIAL_LINKS = {
    whatsapp:  _link(process.env.WHATSAPP_LINK),
    channel1:  _link(process.env.TG_CHANNEL_1),
    channel2:  _link(process.env.TG_CHANNEL_2 || process.env.TG_CHANNEL_1),
    channel3:  _link(process.env.TG_CHANNEL_3 || process.env.TG_CHANNEL_1),
    channel4:  _link(process.env.TG_CHANNEL_4 || process.env.TG_CHANNEL_1),
    group1:    _link(process.env.TG_GROUP_1   || process.env.TG_CHANNEL_1),
    developer: _link(process.env.DEVELOPER_LINK)
};

// Local Mias bot picture — shown on /start and other commands
const MIAS_PIC = require('path').join(__dirname, 'mias', 'assets', 'botpic1.jpg');
const IMAGES = {
    banner: process.env.BANNER_URL || MIAS_PIC,
    logo:   process.env.LOGO_URL   || MIAS_PIC,
    success: MIAS_PIC,
    error:   MIAS_PIC,
    bot:     MIAS_PIC
};

// ── VERIFICATION: exactly 2 required groups/channels ──────────────────────────
// Helper: turn a t.me link or @username into a proper chatId for getChatMember
const _toChatId = (raw = '') => {
    raw = raw.trim();
    const m = raw.match(/t\.me\/(?:joinchat\/)?([A-Za-z0-9_+\-]+)/i);
    if (m) return `@${m[1]}`;
    if (/^-?\d+$/.test(raw)) return Number(raw);
    if (!raw.startsWith('@') && raw.length) return `@${raw}`;
    return raw;
};
// Helper: turn @username or raw name into a full https://t.me link
const _toInviteLink = (raw = '') => {
    raw = raw.trim();
    if (/^https?:\/\//i.test(raw)) return raw;
    const name = raw.replace(/^@/, '');
    return name ? `https://t.me/${name}` : FALLBACK_LINK;
};

// REQUIRED_CHANNELS — up to 2 entries (groups or channels) from env
// Set as comma-separated @usernames or t.me links, e.g.:
//   REQUIRED_CHANNELS=@MyChannel,@MyGroup2
// Only Telegram links/usernames are valid verification targets (WhatsApp links are silently ignored)
const _isTelegramTarget = (raw = '') => {
    raw = String(raw).trim();
    if (!raw) return false;
    if (/chat\.whatsapp\.com|wa\.me/i.test(raw)) return false;        // ignore WA invites
    if (/^https?:\/\//i.test(raw)) return /t\.me\//i.test(raw);
    return true; // bare @username or numeric id
};

// Collect required groups: REQUIRED_CHANNELS first, then TG_GROUP_1 / TG_GROUP_2 as fallback.
const _rawRequired = [
    ...(process.env.REQUIRED_CHANNELS || '').split(','),
    process.env.TG_GROUP_1, process.env.TG_GROUP_2
].map(s => (s || '').trim()).filter(_isTelegramTarget);
// de-dupe
const _seenReq = new Set();
const REQUIRED_CHANNELS = _rawRequired.filter(r => {
    const k = r.toLowerCase(); if (_seenReq.has(k)) return false; _seenReq.add(k); return true;
}).slice(0, 2).map((raw, idx) => ({
    chatId:  _toChatId(raw),
    link:    _toInviteLink(raw),
    name:    `GROUP ${idx + 1}`
}));

// Legacy single REQUIRED_GROUP — only honored if it's a Telegram link
const REQUIRED_GROUP_RAW = (process.env.REQUIRED_GROUP || '').trim();
const REQUIRED_GROUP     = _isTelegramTarget(REQUIRED_GROUP_RAW) ? _toChatId(REQUIRED_GROUP_RAW) : null;
const REQUIRED_GROUP_LINK = REQUIRED_GROUP ? _toInviteLink(REQUIRED_GROUP_RAW) : null;


// ========================
// UTILITY FUNCTIONS
// ========================
const exists = async (filePath) => {
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function runtime(seconds) {
    seconds = Number(seconds);
    const d = Math.floor(seconds / (3600 * 24));
    const h = Math.floor((seconds % (3600 * 24)) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const parts = [];
    if (d > 0) parts.push(`${d}d`);
    if (h > 0) parts.push(`${h}h`);
    if (m > 0) parts.push(`${m}m`);
    if (s > 0 || parts.length === 0) parts.push(`${s}s`);
    return parts.join(' ');
}

// ========================
// LOAD DATA FUNCTIONS
// ========================
const loadAdminIDs = async () => {
    const envAdmins = (process.env.ADMIN_IDS || '')
        .split(',').map(s => s.trim()).filter(Boolean);

    if (envAdmins.length) {
        adminIDs = [...new Set(envAdmins)];
        await fs.writeFile(adminFilePath, JSON.stringify(adminIDs, null, 2));
        console.log(chalk.green('✓ Loaded admin IDs from ADMIN_IDS'));
    } else if (!(await exists(adminFilePath))) {
        adminIDs = [];
        await fs.writeFile(adminFilePath, JSON.stringify(adminIDs, null, 2));
        console.log(chalk.green('✓ Created empty admin.json'));
    } else {
        try {
            const raw = await fs.readFile(adminFilePath, 'utf8');
            const fileAdmins = JSON.parse(raw);
            adminIDs = Array.isArray(fileAdmins)
                ? [...new Set(fileAdmins.map(id => String(id).trim()).filter(Boolean))]
                : [];
        } catch (err) {
            logSafeError(chalk.red('✗ Error loading admin.json:'), err);
            adminIDs = [];
        }
    }
    console.log(chalk.cyan(`📥 Loaded ${adminIDs.length} admin(s)`));
};


const loadUserIDs = async () => {
    if (await exists(userFilePath)) {
        try {
            const raw = await fs.readFile(userFilePath, 'utf8');
            const users = JSON.parse(raw);
            userIDs = new Set(users);
            console.log(chalk.cyan(`📥 Loaded ${userIDs.size} user(s)`));
        } catch (err) {
            logSafeError(chalk.red('✗ Error loading users.json:'), err);
            userIDs = new Set();
        }
    }
};

const saveUserIDs = async () => {
    try {
        await fs.writeFile(userFilePath, JSON.stringify([...userIDs], null, 2));
    } catch (err) {
        logSafeError(chalk.red('✗ Error saving users.json:'), err);
    }
};

const loadUserStats = async () => {
    if (await exists(userStatsPath)) {
        try {
            const raw = await fs.readFile(userStatsPath, 'utf8');
            userStats = JSON.parse(raw);
        } catch (err) {
            userStats = {};
        }
    }
};

const saveUserStats = async () => {
    try {
        await fs.writeFile(userStatsPath, JSON.stringify(userStats, null, 2));
    } catch (err) {
        logSafeError('Error saving user stats:', err);
    }
};

const loadWelcomeSettings = async () => {
    if (await exists(welcomeSettingsPath)) {
        try {
            const raw = await fs.readFile(welcomeSettingsPath, 'utf8');
            welcomeSettings = JSON.parse(raw);
        } catch (err) {
            welcomeSettings = {};
        }
    }
};

const saveWelcomeSettings = async () => {
    try {
        await fs.writeFile(welcomeSettingsPath, JSON.stringify(welcomeSettings, null, 2));
    } catch (err) {
        logSafeError('Error saving welcome settings:', err);
    }
};

const loadGoodbyeSettings = async () => {
    if (await exists(goodbyeSettingsPath)) {
        try {
            const raw = await fs.readFile(goodbyeSettingsPath, 'utf8');
            goodbyeSettings = JSON.parse(raw);
        } catch (err) {
            goodbyeSettings = {};
        }
    }
};

const saveGoodbyeSettings = async () => {
    try {
        await fs.writeFile(goodbyeSettingsPath, JSON.stringify(goodbyeSettings, null, 2));
    } catch (err) {
        logSafeError('Error saving goodbye settings:', err);
    }
};

const loadGroupVerifySettings = async () => {
    if (await exists(groupVerifySettingsPath)) {
        try {
            const raw = await fs.readFile(groupVerifySettingsPath, 'utf8');
            groupVerifySettings = JSON.parse(raw);
        } catch (err) {
            groupVerifySettings = {};
        }
    }
};

const saveGroupVerifySettings = async () => {
    try {
        await fs.writeFile(groupVerifySettingsPath, JSON.stringify(groupVerifySettings, null, 2));
    } catch (err) {
        logSafeError('Error saving group verify settings:', err);
    }
};

const loadGroupWarnings = async () => {
    if (await exists(groupWarningsPath)) {
        try {
            groupWarnings = JSON.parse(await fs.readFile(groupWarningsPath, 'utf8'));
        } catch {
            groupWarnings = {};
        }
    }
};

const saveGroupWarnings = async () => {
    try {
        await fs.writeFile(groupWarningsPath, JSON.stringify(groupWarnings, null, 2));
    } catch (err) {
        logSafeError('Error saving group warnings:', err);
    }
};

const escapeMarkdown = (value = '') => String(value).replace(/[_*`\[]/g, '\\$&');

const sendSafePhoto = async (chatId, photo, options = {}) => {
    try {
        return await bot.sendPhoto(chatId, photo, options);
    } catch (err) {
        console.warn('[Telegram] sendPhoto fallback:', safeErrorMessage(err));
        const text = options.caption || 'Done';
        return bot.sendMessage(chatId, text, {
            parse_mode: options.parse_mode,
            reply_markup: options.reply_markup
        }).catch(sendErr => logSafeError('[Telegram] sendMessage fallback failed:', sendErr));
    }
};

const editSafeMessageText = async (text, options = {}) => {
    try {
        return await bot.editMessageText(text, options);
    } catch (err) {
        console.warn('[Telegram] editMessageText fallback:', safeErrorMessage(err));
        if (!options.chat_id) return null;
        return bot.sendMessage(options.chat_id, text, {
            parse_mode: options.parse_mode,
            reply_markup: options.reply_markup,
        }).catch(sendErr => logSafeError('[Telegram] sendMessage fallback failed:', sendErr));
    }
};

const editSafeMessageMedia = async (media, options = {}) => {
    try {
        return await bot.editMessageMedia(media, options);
    } catch (err) {
        console.warn('[Telegram] editMessageMedia fallback:', safeErrorMessage(err));
        if (!options.chat_id) return null;
        if (media?.type === 'photo' && media?.media) {
            return sendSafePhoto(options.chat_id, media.media, {
                caption: media.caption || '',
                parse_mode: media.parse_mode,
                reply_markup: options.reply_markup,
            });
        }
        return bot.sendMessage(options.chat_id, media?.caption || 'Done', {
            parse_mode: media?.parse_mode,
            reply_markup: options.reply_markup,
        }).catch(sendErr => logSafeError('[Telegram] sendMessage fallback failed:', sendErr));
    }
};

const isGroupAdmin = async (chatId, userId) => {
    try {
        const member = await bot.getChatMember(chatId, userId);
        return ['administrator', 'creator'].includes(member.status);
    } catch {
        return false;
    }
};

const isPrivilegedUser = async (chatId, userId) => {
    if (adminIDs.includes(userId.toString())) return true;
    if (String(chatId).startsWith('-')) return isGroupAdmin(chatId, userId);
    return false;
};

const getChatCount = async (chatId) => {
    if (typeof bot.getChatMemberCount === 'function') return bot.getChatMemberCount(chatId);
    if (typeof bot.getChatMembersCount === 'function') return bot.getChatMembersCount(chatId);
    return 'many';
};

const waitForPairingCode = async (pairingFile, requestedNumber, timeoutMs = 30000) => {
    const cleanNumber = requestedNumber.replace(/[^0-9]/g, '');
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        if (await exists(pairingFile)) {
            try {
                const pairData = JSON.parse(await fs.readFile(pairingFile, 'utf8'));
                const savedNumber = String(pairData.number || '').replace(/[^0-9]/g, '');
                if (pairData.code && savedNumber === cleanNumber) return pairData;
            } catch {}
        }
        await sleep(1000);
    }
    throw new Error('Pairing code timeout. Please try again.');
};

const normalizePhoneNumber = (value = '') => value.replace(/[^0-9]/g, '');

const extractTelegramUserNumber = (msg) => {
    const direct = normalizePhoneNumber(
        msg?.contact?.phone_number
        || msg?.from?.phone_number
        || msg?.chat?.phone_number
        || ''
    );
    return direct || null;
};

const resolvePairTarget = (msg, rawInput = '') => {
    const cleanInput = normalizePhoneNumber(rawInput);
    const ownNumber = extractTelegramUserNumber(msg);

    if (cleanInput) return cleanInput;
    if (ownNumber) return ownNumber;

    throw new Error('No phone number detected. Use /pair 234XXXXXXXXX or send your Telegram contact first.');
};

const getTargetUserId = (msg, text = '') => {
    if (msg.reply_to_message?.from?.id) return msg.reply_to_message.from.id;
    const match = String(text).match(/(\d{5,})/);
    return match ? Number(match[1]) : null;
};

const groupAdminOnly = async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    if (!String(chatId).startsWith('-')) {
        await sendSafePhoto(chatId, IMAGES.error, { caption: `👥 *GROUP ONLY*`, parse_mode: 'Markdown' });
        return false;
    }
    if (!(await isPrivilegedUser(chatId, userId))) {
        await sendSafePhoto(chatId, IMAGES.error, { caption: `🔒 *GROUP ADMIN ONLY*`, parse_mode: 'Markdown' });
        return false;
    }
    return true;
};

// ========================
// USER TRACKING
// ========================
const trackUser = async (userId) => {
    const userIdStr = userId.toString();
    if (!userIDs.has(userIdStr)) {
        userIDs.add(userIdStr);
        await saveUserIDs();
        console.log(chalk.green(`✓ New user: ${userIdStr}`));
    }
};

const updateUserStats = async (userId, command) => {
    if (!userStats[userId]) {
        userStats[userId] = { totalCommands: 0, lastSeen: Date.now(), commands: {} };
    }
    userStats[userId].totalCommands++;
    userStats[userId].lastSeen = Date.now();
    userStats[userId].commands[command] = (userStats[userId].commands[command] || 0) + 1;
    await saveUserStats();
};

// ========================
// MEMBERSHIP CHECK
// ========================
const checkMembership = async (userId) => {
    try {
        // No requirements configured → everyone passes
        if (!REQUIRED_GROUP && REQUIRED_CHANNELS.length === 0) {
            return { hasJoinedAll: true, missing: [] };
        }

        const validStatuses = ['member', 'administrator', 'creator'];

        // Check each required channel/group using its chatId (@username or numeric ID)
        const channelResults = await Promise.all(
            REQUIRED_CHANNELS.map(async (ch) => {
                try {
                    const res = await bot.getChatMember(ch.chatId, userId);
                    return { ch, passed: validStatuses.includes(res?.status) };
                } catch {
                    return { ch, passed: false };
                }
            })
        );

        // Check optional REQUIRED_GROUP
        let groupPassed = true;
        if (REQUIRED_GROUP) {
            try {
                const res = await bot.getChatMember(REQUIRED_GROUP, userId);
                groupPassed = validStatuses.includes(res?.status);
            } catch {
                groupPassed = false;
            }
        }

        const missingChannels = channelResults.filter(r => !r.passed).map(r => r.ch);
        const missingGroup    = (!groupPassed && REQUIRED_GROUP) ? [{
            chatId: REQUIRED_GROUP,
            link:   REQUIRED_GROUP_LINK || FALLBACK_LINK,
            name:   'REQUIRED GROUP'
        }] : [];

        const missing = [...missingChannels, ...missingGroup];
        return {
            hasJoinedAll: missing.length === 0,
            missing,
            hasJoinedGroup:       groupPassed,
            hasJoinedAllChannels: missingChannels.length === 0,
            missingChannels
        };
    } catch (error) {
        console.error(chalk.red('Membership check error:'), error.message);
        return {
            hasJoinedAll: false,
            missing: REQUIRED_CHANNELS,
            hasJoinedGroup: false,
            hasJoinedAllChannels: false,
            missingChannels: REQUIRED_CHANNELS
        };
    }
};

// ========================
// SEND JOIN REQUIREMENT
// ========================
// Build join keyboard from a list of missing groups/channels (or all if none passed)
const buildJoinKeyboard = (missing) => {
    const items = (missing && missing.length) ? missing : [
        ...REQUIRED_CHANNELS,
        ...(REQUIRED_GROUP ? [{ chatId: REQUIRED_GROUP, link: REQUIRED_GROUP_LINK || FALLBACK_LINK, name: 'REQUIRED GROUP' }] : [])
    ];
    const keyboard = items.map((ch, i) => [{
        text: `👥 JOIN ${ch.name || `GROUP ${i + 1}`}`,
        url: ch.link
    }]);
    keyboard.push([{ text: '✅ I JOINED — VERIFY ME', callback_data: 'check_membership' }]);
    return keyboard;
};

const sendJoinRequirement = async (chatId, missing) => {
    const allRequired = [
        ...REQUIRED_CHANNELS,
        ...(REQUIRED_GROUP ? [{ name: 'REQUIRED GROUP' }] : [])
    ];
    const itemLines = allRequired.length
        ? allRequired.map((ch, i) => `┃  ➤ 👥 ${ch.name || `GROUP ${i + 1}`}`).join('\n')
        : '┃  ➤ Configure REQUIRED_CHANNELS in .env';

    const caption = `
${ZUKO.line}
${ZUKO.titleLine}
┃  ${ZUKO.divider}
┃  ❌ *ACCESS DENIED* ❌
┃  ${ZUKO.divider}
┃  *2-Step Verification Required*
┃  ${ZUKO.divider}
┃  📌 *Join these groups to continue:*
${itemLines}
┃  ${ZUKO.divider}
┃  1️⃣ Click JOIN buttons below
┃  2️⃣ Click ✅ VERIFY when done
┃  ${ZUKO.divider}
┃  ${ZUKO.footer}
${ZUKO.lineEnd}`;

    return sendSafePhoto(chatId, IMAGES.banner, {
        caption,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: buildJoinKeyboard(missing) }
    });
};

// ========================
// MIDDLEWARE
// ========================
const withCooldown = (command, seconds = 3) => {
    return (handler) => {
        return async (msg, match) => {
            const userId = msg.from.id;
            const key = `${userId}_${command}`;
            const now = Date.now();
            const cooldown = cooldowns.get(key);
            
            if (cooldown && now - cooldown < seconds * 1000) {
                const remaining = Math.ceil((seconds * 1000 - (now - cooldown)) / 1000);
                return bot.sendMessage(msg.chat.id, `⏰ Please wait ${remaining} seconds before using /${command} again.`);
            }
            
            cooldowns.set(key, now);
            return handler(msg, match);
        };
    };
};

const requireMembership = (handler) => {
    return async (msg, match) => {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        const command = msg.text?.split(' ')[0]?.replace('/', '') || 'unknown';

        await trackUser(userId);
        await updateUserStats(userId, command);

        // Skip membership check for admins
        if (adminIDs.includes(userId.toString())) {
            return handler(msg, match);
        }

        const membership = await checkMembership(userId);

        if (!membership.hasJoinedAll) {
            return sendJoinRequirement(chatId, membership.missing);
        }

        return handler(msg, match);
    };
};

// ========================
// COMMAND HANDLERS
// ========================

// Start command
bot.onText(/\/start/, requireMembership(async (msg) => {
    const chatId = msg.chat.id;
    const firstName = msg.from.first_name;
    
    const caption = `
${ZUKO.line}
┃  ✨ *『 MAIS MDX 』* ✨
┃  ${ZUKO.divider}
┃  🎭 *Hey ${firstName}*
┃  ${ZUKO.divider}
┃
┃  📱 *COMMANDS*
┃  ${ZUKO.divider}
┃  ➤ /pair <number> - Connect WhatsApp
┃  ➤ /delpair <number> - Remove device
┃  ➤ /listpair confirm - List devices
┃  ➤ /number - View paired numbers
┃  ➤ /ping - Check latency
┃  ➤ /runtime - Bot uptime
┃  ➤ /profile - Your profile
┃  ➤ /leaderboard - Top users
┃  ➤ /welcome - Welcome settings
┃  ➤ /goodbye - Goodbye settings
┃  ➤ /help - Get support
┃  ➤ /report <msg> - Report issue
┃
┃  ${ZUKO.divider}
┃  ${ZUKO.footer}
${ZUKO.lineEnd}`;

    const keyboard = {
        reply_markup: {
            inline_keyboard: [
                [{ text: '✨ MAIN CHANNEL', url: SOCIAL_LINKS.channel1 }],
                [{ text: '👥 JOIN GROUP', url: SOCIAL_LINKS.group1 }],
                [{ text: '❓ HELP', callback_data: 'help_msg' }]
            ]
        }
    };
    
    await bot.sendPhoto(chatId, IMAGES.logo, { caption, ...keyboard, parse_mode: 'Markdown' });
}));

// Help command (no membership required)
bot.onText(/\/help/, async (msg) => {
    const chatId = msg.chat.id;
    
    const caption = `
${ZUKO.line}
┃  ❓ *MAIS MDX HELP* ❓
┃  ${ZUKO.divider}
┃
┃  📌 *COMMANDS*
┃  ${ZUKO.divider}
┃  ➤ /pair <number> - Pair WhatsApp device
┃  ➤ /delpair <number> - Remove paired device
┃  ➤ /listpair confirm - List devices (admin)
┃  ➤ /number - Choose the bot for a paired number
┃  ➤ /ping - Check bot latency
┃  ➤ /profile - View your profile
┃  ➤ /leaderboard - Top command users
┃  ➤ /runtime - Bot uptime
┃  ➤ /welcome - Welcome settings
┃  ➤ /goodbye - Goodbye settings
┃  ➤ /report <msg> - Report issue
┃
┃  ${ZUKO.divider}
┃  ${ZUKO.footer}
${ZUKO.lineEnd}`;

    const keyboard = {
        reply_markup: {
            inline_keyboard: [
                [{ text: '✨ CH 1', url: SOCIAL_LINKS.channel1 }],
                [{ text: '👥 GROUP', url: SOCIAL_LINKS.group1 }],
                [{ text: '🚀 START', callback_data: 'start_bot' }]
            ]
        }
    };
    
    await bot.sendPhoto(chatId, IMAGES.banner, { caption, ...keyboard, parse_mode: 'Markdown' });
});

// Ping command
bot.onText(/\/ping/, requireMembership(withCooldown('ping', 5)(async (msg) => {
    const chatId = msg.chat.id;
    const start = Date.now();
    
    const sentMsg = await bot.sendPhoto(chatId, IMAGES.bot, {
        caption: `🏓 *Pinging...*`,
        parse_mode: 'Markdown'
    });
    
    const latency = Date.now() - start;
    const apiLatency = sentMsg.date - msg.date;
    
    let pingEmoji = latency < 100 ? '🟢' : latency < 200 ? '🟡' : latency < 500 ? '🟠' : '🔴';
    let pingStatus = latency < 100 ? 'Excellent' : latency < 200 ? 'Good' : latency < 500 ? 'Slow' : 'Very Slow';
    
    const caption = `
${ZUKO.line}
┃      🏓 *PONG!* 🏓           
┃  ${ZUKO.divider}
┃  ${pingEmoji} *Latency:* ${latency}ms
┃  📡 *API:* ${apiLatency}ms
┃  🎯 *Status:* ${pingStatus}
┃  ${ZUKO.divider}
┃  ⚡ MAIS MDX ONLINE ⚡      
${ZUKO.lineEnd}`;
    
    await editSafeMessageMedia({
        type: 'photo',
        media: IMAGES.success,
        caption: caption,
        parse_mode: 'Markdown'
    }, {
        chat_id: chatId,
        message_id: sentMsg.message_id
    });
})));

// Runtime command
bot.onText(/\/runtime/, requireMembership(async (msg) => {
    const chatId = msg.chat.id;
    const uptime = runtime(process.uptime());
    const memory = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2);

    const caption = `
${ZUKO.line}
┃  ⏰ *BOT RUNTIME*
┃  ${ZUKO.divider}
┃  🚀 *Status:* Online
┃  ⏱️ *Uptime:* ${uptime}
┃  💾 *Memory:* ${memory} MB
┃  👥 *Users:* ${userIDs.size}
┃  ${ZUKO.divider}
┃  ${ZUKO.footer}
${ZUKO.lineEnd}`;

    await bot.sendPhoto(chatId, IMAGES.bot, { caption, parse_mode: 'Markdown' });
}));

// Profile command
bot.onText(/\/profile/, requireMembership(async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const firstName = escapeMarkdown(msg.from.first_name || 'User');
    const username = msg.from.username ? `@${escapeMarkdown(msg.from.username)}` : 'No username';
    
    const userStat = userStats[userId] || { totalCommands: 0, lastSeen: Date.now(), commands: {} };
    const lastSeen = new Date(userStat.lastSeen).toLocaleString();
    const commandCount = Object.keys(userStat.commands || {}).length;
    const mostUsed = Object.entries(userStat.commands || {}).sort((a,b) => b[1] - a[1])[0];
    
    const caption = `
${ZUKO.line}
┃  👤 *USER PROFILE*
┃  ${ZUKO.divider}
┃  🎭 *Name:* ${firstName}
┃  🆔 *ID:* ${userId}
┃  📝 *Username:* ${username}
┃  ${ZUKO.divider}
┃  📊 *STATS*
┃  ┃─ Commands: ${userStat.totalCommands}
┃  ┃─ Unique: ${commandCount}
┃  ┃─ Most Used: ${mostUsed ? mostUsed[0] : 'None'}
┃  ┃─ Last Active: ${lastSeen}
┃  ${ZUKO.divider}
┃  ${ZUKO.footer}
${ZUKO.lineEnd}`;
    
    await sendSafePhoto(chatId, IMAGES.bot, { caption, parse_mode: 'Markdown' });
}));

// Leaderboard command
bot.onText(/\/leaderboard/, requireMembership(async (msg) => {
    const chatId = msg.chat.id;
    
    const topUsers = Object.entries(userStats)
        .sort((a, b) => b[1].totalCommands - a[1].totalCommands)
        .slice(0, 10);
    
    if (topUsers.length === 0) {
        return bot.sendPhoto(chatId, IMAGES.error, {
            caption: `📊 *No user data yet*\n\nBe the first to use commands!`,
            parse_mode: 'Markdown'
        });
    }
    
    let leaderboardText = `
${ZUKO.line}
┃  🏆 *LEADERBOARD* 🏆
┃  ${ZUKO.divider}
`;
    
    const medals = ['🥇', '🥈', '🥉'];
    
    for (let i = 0; i < topUsers.length; i++) {
        const [userId, stats] = topUsers[i];
        const medal = i < 3 ? medals[i] : '📌';
        const name = userId.slice(-6);
        leaderboardText += `┃  ${medal} *${i+1}.* \`${name}\` - ${stats.totalCommands} cmds\n`;
    }
    
    leaderboardText += `
┃  ${ZUKO.divider}
┃  ${ZUKO.footer}
${ZUKO.lineEnd}`;
    
    await bot.sendPhoto(chatId, IMAGES.banner, { caption: leaderboardText, parse_mode: 'Markdown' });
}));

// Stats command (admin only)
bot.onText(/\/stats/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    
    if (!adminIDs.includes(userId)) {
        return bot.sendPhoto(chatId, IMAGES.error, {
            caption: `🔒 *ADMIN ONLY*`,
            parse_mode: 'Markdown'
        });
    }
    
    const totalUsers = userIDs.size;
    const totalCommands = Object.values(userStats).reduce((sum, u) => sum + (u.totalCommands || 0), 0);
    const uptime = runtime(process.uptime());
    const memory = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2);
    
    const statsText = `
${ZUKO.line}
┃  📊 *BOT STATS*
┃  ${ZUKO.divider}
┃  👥 Users: ${totalUsers}
┃  🎯 Commands: ${totalCommands}
┃  ⏱️ Uptime: ${uptime}
┃  💾 Memory: ${memory} MB
┃  👑 Admins: ${adminIDs.length}
┃  ${ZUKO.divider}
┃  ${ZUKO.footer}
${ZUKO.lineEnd}`;
    
    await bot.sendPhoto(chatId, IMAGES.banner, { caption: statsText, parse_mode: 'Markdown' });
});

// Welcome command
bot.onText(/\/welcome$/, requireMembership(async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    
    if (!adminIDs.includes(userId)) {
        return bot.sendPhoto(chatId, IMAGES.error, {
            caption: `🔒 *ADMIN ONLY*`,
            parse_mode: 'Markdown'
        });
    }
    
    const caption = `
${ZUKO.line}
┃  👋 *WELCOME SETTINGS*
┃  ${ZUKO.divider}
┃  Usage:
┃  /welcome on - Enable welcome
┃  /welcome off - Disable welcome
┃  /welcome set <message> - Custom
┃
┃  Variables: {name}, {group}, {count}
┃
┃  Example: /welcome set Welcome {name}! 🎉
${ZUKO.lineEnd}`;
    
    await bot.sendPhoto(chatId, IMAGES.banner, { caption, parse_mode: 'Markdown' });
}));

bot.onText(/\/welcome (on|off|set .+)/, requireMembership(async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    const action = match[1];
    
    if (!adminIDs.includes(userId)) {
        return bot.sendPhoto(chatId, IMAGES.error, {
            caption: `🔒 *ADMIN ONLY*`,
            parse_mode: 'Markdown'
        });
    }
    
    await loadWelcomeSettings();
    
    if (!welcomeSettings[chatId]) welcomeSettings[chatId] = { enabled: false, message: '' };
    
    if (action === 'on') {
        welcomeSettings[chatId].enabled = true;
        await saveWelcomeSettings();
        await bot.sendPhoto(chatId, IMAGES.success, {
            caption: `✅ *WELCOME ENABLED*`,
            parse_mode: 'Markdown'
        });
    } else if (action === 'off') {
        welcomeSettings[chatId].enabled = false;
        await saveWelcomeSettings();
        await bot.sendPhoto(chatId, IMAGES.success, {
            caption: `❌ *WELCOME DISABLED*`,
            parse_mode: 'Markdown'
        });
    } else if (action.startsWith('set')) {
        const customMsg = action.replace('set ', '');
        welcomeSettings[chatId].message = customMsg;
        welcomeSettings[chatId].enabled = true;
        await saveWelcomeSettings();
        await bot.sendPhoto(chatId, IMAGES.success, {
            caption: `✅ *CUSTOM WELCOME SET*\n\n"${customMsg}"`,
            parse_mode: 'Markdown'
        });
    }
}));

// Goodbye command
bot.onText(/\/goodbye$/, requireMembership(async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    
    if (!adminIDs.includes(userId)) {
        return bot.sendPhoto(chatId, IMAGES.error, {
            caption: `🔒 *ADMIN ONLY*`,
            parse_mode: 'Markdown'
        });
    }
    
    const caption = `
${ZUKO.line}
┃  👋 *GOODBYE SETTINGS*
┃  ${ZUKO.divider}
┃  Usage:
┃  /goodbye on - Enable goodbye
┃  /goodbye off - Disable goodbye
┃  /goodbye set <message> - Custom
┃
┃  Variables: {name}, {group}, {count}
┃
┃  Example: /goodbye set Goodbye {name}! 😢
${ZUKO.lineEnd}`;
    
    await bot.sendPhoto(chatId, IMAGES.banner, { caption, parse_mode: 'Markdown' });
}));

bot.onText(/\/goodbye (on|off|set .+)/, requireMembership(async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    const action = match[1];
    
    if (!adminIDs.includes(userId)) {
        return bot.sendPhoto(chatId, IMAGES.error, {
            caption: `🔒 *ADMIN ONLY*`,
            parse_mode: 'Markdown'
        });
    }
    
    await loadGoodbyeSettings();
    
    if (!goodbyeSettings[chatId]) goodbyeSettings[chatId] = { enabled: false, message: '' };
    
    if (action === 'on') {
        goodbyeSettings[chatId].enabled = true;
        await saveGoodbyeSettings();
        await bot.sendPhoto(chatId, IMAGES.success, {
            caption: `✅ *GOODBYE ENABLED*`,
            parse_mode: 'Markdown'
        });
    } else if (action === 'off') {
        goodbyeSettings[chatId].enabled = false;
        await saveGoodbyeSettings();
        await bot.sendPhoto(chatId, IMAGES.success, {
            caption: `❌ *GOODBYE DISABLED*`,
            parse_mode: 'Markdown'
        });
    } else if (action.startsWith('set')) {
        const customMsg = action.replace('set ', '');
        goodbyeSettings[chatId].message = customMsg;
        goodbyeSettings[chatId].enabled = true;
        await saveGoodbyeSettings();
        await bot.sendPhoto(chatId, IMAGES.success, {
            caption: `✅ *CUSTOM GOODBYE SET*\n\n"${customMsg}"`,
            parse_mode: 'Markdown'
        });
    }
}));

// Group verify and moderation commands
bot.onText(/^\/(verifygc|gcverify)(?:@\w+)?(?:\s+(on|off|status))?$/i, requireMembership(async (msg, match) => {
    const chatId = msg.chat.id;
    if (!(await groupAdminOnly(msg))) return;
    const action = (match[2] || 'status').toLowerCase();
    await loadGroupVerifySettings();
    if (!groupVerifySettings[chatId]) groupVerifySettings[chatId] = { enabled: false };

    if (action === 'on') groupVerifySettings[chatId].enabled = true;
    if (action === 'off') groupVerifySettings[chatId].enabled = false;
    await saveGroupVerifySettings();

    return sendSafePhoto(chatId, IMAGES.success, {
        caption: `${action === 'status' ? 'ℹ️' : '✅'} *GROUP VERIFY ${groupVerifySettings[chatId].enabled ? 'ON' : 'OFF'}*\n\nNew members ${groupVerifySettings[chatId].enabled ? 'must tap VERIFY before chatting.' : 'can chat normally.'}`,
        parse_mode: 'Markdown'
    });
}));

bot.onText(/^\/(kick|ban|unban|mute|unmute|warn|resetwarn)(?:@\w+)?(?:\s+(.+))?$/i, requireMembership(async (msg, match) => {
    const chatId = msg.chat.id;
    if (!(await groupAdminOnly(msg))) return;
    const action = match[1].toLowerCase();
    const targetUserId = getTargetUserId(msg, match[2] || '');
    if (!targetUserId) {
        return sendSafePhoto(chatId, IMAGES.error, {
            caption: `⚠️ *SELECT USER*\n\nReply to a user or add their numeric Telegram ID.`,
            parse_mode: 'Markdown'
        });
    }

    const warnKey = `${chatId}_${targetUserId}`;
    await loadGroupWarnings();

    try {
        if (action === 'kick') {
            await bot.banChatMember(chatId, targetUserId);
            await bot.unbanChatMember(chatId, targetUserId);
        } else if (action === 'ban') {
            await bot.banChatMember(chatId, targetUserId);
        } else if (action === 'unban') {
            await bot.unbanChatMember(chatId, targetUserId);
        } else if (action === 'mute') {
            await bot.restrictChatMember(chatId, targetUserId, { permissions: { can_send_messages: false } });
        } else if (action === 'unmute') {
            await bot.restrictChatMember(chatId, targetUserId, { permissions: { can_send_messages: true, can_send_audios: true, can_send_documents: true, can_send_photos: true, can_send_videos: true, can_send_video_notes: true, can_send_voice_notes: true, can_send_polls: true, can_send_other_messages: true, can_add_web_page_previews: true } });
        } else if (action === 'warn') {
            groupWarnings[warnKey] = (groupWarnings[warnKey] || 0) + 1;
            await saveGroupWarnings();
            if (groupWarnings[warnKey] >= 3) {
                await bot.banChatMember(chatId, targetUserId);
                await bot.unbanChatMember(chatId, targetUserId);
                delete groupWarnings[warnKey];
                await saveGroupWarnings();
                return sendSafePhoto(chatId, IMAGES.success, { caption: `⚠️ *WARN LIMIT REACHED*\n\nUser kicked after 3 warnings.`, parse_mode: 'Markdown' });
            }
            return sendSafePhoto(chatId, IMAGES.success, { caption: `⚠️ *WARNED*\n\nWarnings: ${groupWarnings[warnKey]}/3`, parse_mode: 'Markdown' });
        } else if (action === 'resetwarn') {
            delete groupWarnings[warnKey];
            await saveGroupWarnings();
        }

        return sendSafePhoto(chatId, IMAGES.success, {
            caption: `✅ *${action.toUpperCase()} DONE*\n\nUser ID: ${targetUserId}`,
            parse_mode: 'Markdown'
        });
    } catch (err) {
        return sendSafePhoto(chatId, IMAGES.error, {
            caption: `❌ *${action.toUpperCase()} FAILED*\n\n${err.message || 'Make sure the bot is group admin.'}`,
            parse_mode: 'Markdown'
        });
    }
}));

// Pair command
// The first Telegram message is deliberately only a choice. Starting a QR
// handshake before the user chooses a method made it impossible to request a
// pairing code and also allowed duplicate taps to clear a live handshake.
const telegramPairInFlight = new Map();

const pairMethodKeyboard = (number, userId) => ({
    inline_keyboard: [[
        { text: '📷 QR CODE', callback_data: `pairmethod|${number}|${userId}|qr` },
        { text: '🔢 PAIRING CODE', callback_data: `pairmethod|${number}|${userId}|code` }
    ]]
});

const sendPairMethodChoice = (msg, number) => sendSafePhoto(msg.chat.id, IMAGES.bot, {
    caption: `📱 *Choose how to pair* \`${number}\`\n\nSelect one method below. A fresh pairing session will start only after you choose.`,
    parse_mode: 'Markdown',
    reply_markup: pairMethodKeyboard(number, msg.from.id)
});

const telegramBotIsRunning = (number) => {
    try {
        const launcher = require('./mais_launcher');
        return launcher.list().some((entry) =>
            String(entry.number).replace(/[^0-9]/g, '') === String(number).replace(/[^0-9]/g, '') &&
            entry.alive !== false
        );
    } catch {
        return false;
    }
};

async function runTelegramPair(msg, senderNumber, mode) {
    const chatId = msg.chat.id;
    const jid = `${senderNumber}@s.whatsapp.net`;
    const flowKey = `${chatId}:${senderNumber}`;
    if (telegramPairInFlight.has(flowKey)) {
        return sendSafePhoto(chatId, IMAGES.bot, {
            caption: `⏳ *Pairing is already in progress* for \`${senderNumber}\`.\n\nPlease use the existing ${mode === 'qr' ? 'QR code' : 'pairing code'} or wait for it to finish.`,
            parse_mode: 'Markdown'
        });
    }

    telegramPairInFlight.set(flowKey, mode);
    try {
        const pairModule = require('./pair.js');
        const startpairing = typeof pairModule === 'function' ? pairModule : pairModule.startpairing;
        const waitForPairingResult = pairModule.waitForPairingResult;
        const hasPairedSession = pairModule.hasPairedSession;
        const isSessionLive = pairModule.isSessionLive;
        const isPairingActive = pairModule.isPairingActive;
        const getPairingMode = pairModule.getPairingMode;
        const unpairSession = pairModule.unpairSession || pairModule.forceCleanupSession;
        if (typeof startpairing !== 'function' || typeof waitForPairingResult !== 'function') {
            throw new Error('Pairing module is not loaded correctly');
        }
        if (typeof isPairingActive === 'function' && isPairingActive(jid)) {
            const activeMode = typeof getPairingMode === 'function' ? getPairingMode(jid) : null;
            if (activeMode && activeMode !== mode) {
                return sendSafePhoto(chatId, IMAGES.bot, {
                    caption: `⏳ *A ${activeMode === 'qr' ? 'QR' : 'pairing-code'} session is already active* for \`${senderNumber}\`.\n\nUse the existing method or wait for it to expire before switching methods.`,
                    parse_mode: 'Markdown'
                });
            }
            // Reuse the live socket below. This avoids opening a second
            // connection while still allowing a fresh Telegram tap to receive
            // the code/QR that is already being generated.
        }

        // A handoff-owned session is no longer tracked by pair.js, so
        // isSessionLive() alone is not enough. Never delete auth for a bot
        // process that is already running.
        if (typeof hasPairedSession === 'function' && hasPairedSession(jid)) {
            const live = typeof isSessionLive === 'function' ? isSessionLive(jid) : false;
            if (live || telegramBotIsRunning(senderNumber)) {
                return sendSafePhoto(chatId, IMAGES.success, {
                    caption: `✅ *ALREADY PAIRED*\n\n📱 Number: ${senderNumber}`,
                    parse_mode: 'Markdown'
                });
            }
            if (typeof unpairSession === 'function') {
                try { await Promise.resolve(unpairSession(jid)); }
                catch (error) { return bot.sendMessage(chatId, `Session reset did not finish: ${error.message}`); }
            }
        }

        try {
            require('./deploy/botSelectionStore').setOwner(senderNumber, {
                id: msg.from.id,
                username: msg.from.username || null,
                first_name: msg.from.first_name || null,
                firstName: msg.from.first_name || null,
                chatId,
            });
        } catch (e) {
            console.warn('[bot] Could not record pair owner:', e.message);
        }

        await sendSafePhoto(chatId, IMAGES.bot, {
            caption: `⏳ *Starting ${mode === 'qr' ? 'QR' : 'pairing-code'} pairing* for \`${senderNumber}\`...`,
            parse_mode: 'Markdown'
        });
        await startpairing(jid, { mode });
        const result = await waitForPairingResult(jid, 120000, mode);

        if (mode === 'qr') {
            if (!result?.qr) throw new Error('QR code was not generated. Please try again.');
            const qrImage = await QRCode.toBuffer(result.qr, {
                type: 'png', width: 640, margin: 2, errorCorrectionLevel: 'M'
            });
            return sendSafePhoto(chatId, qrImage, {
                caption: `📷 *SCAN TO PAIR*\n\n📱 Number: ${senderNumber}\n\nOpen WhatsApp → Settings → Linked Devices → Link a Device → scan this QR code.\n\n⚠️ This QR expires shortly. If it expires, choose QR again from /pair.`,
                parse_mode: 'Markdown'
            });
        }

        if (!result?.code) throw new Error('Pairing code was not generated. Please try again.');
        return sendSafePhoto(chatId, IMAGES.success, {
            caption: `🔢 *PAIRING CODE READY*\n\n📱 Number: ${senderNumber}\n\n\`${result.code}\`\n\nOpen WhatsApp → Linked Devices → Link a Device → Link with phone number instead, then enter this code.\n\n⚠️ The code expires shortly. Do not share it with anyone else.`,
            parse_mode: 'Markdown'
        });
    } catch (error) {
        logSafeError(chalk.red('Pair error:'), error);
        return sendSafePhoto(chatId, IMAGES.error, {
            caption: `❌ *PAIRING FAILED*\n\n${safeErrorMessage(error) || 'Please try again'}`,
            parse_mode: 'Markdown'
        });
    } finally {
        telegramPairInFlight.delete(flowKey);
    }
}

bot.onText(/^\/pair(?:@\w+)?\s*$/, requireMembership(async (msg) => {
    try {
        const senderNumber = resolvePairTarget(msg);
        return sendPairMethodChoice(msg, senderNumber);
    } catch (error) {
        return sendSafePhoto(msg.chat.id, IMAGES.error, {
            caption: `⚠️ *SELF-PAIR*\n\n${error.message || 'Use /pair 234XXXXXXXXX'}`,
            parse_mode: 'Markdown'
        });
    }
}));

bot.onText(/^\/pair(?:@\w+)?\s+(.+)/, requireMembership(withCooldown('pair', 10)(async (msg, match) => {
    const rawNumber = match[1].trim();
    try {
        const senderNumber = resolvePairTarget(msg, rawNumber);
        if (!senderNumber || /[a-z]/i.test(rawNumber) || !/^\d{7,15}$/.test(senderNumber) || senderNumber.startsWith('0')) {
            return sendSafePhoto(msg.chat.id, IMAGES.error, {
                caption: `⚠️ *INVALID NUMBER*\n\nUse: /pair 234XXXXXXXXX`,
                parse_mode: 'Markdown'
            });
        }
        return sendPairMethodChoice(msg, senderNumber);
    } catch (error) {
        return sendSafePhoto(msg.chat.id, IMAGES.error, {
            caption: `❌ *FAILED*\n\n${safeErrorMessage(error) || 'Please try again'}`,
            parse_mode: 'Markdown'
        });
    }
})));

// Delpair command
bot.onText(/^\/delpair(?:@\w+)?\s*$/, requireMembership(async (msg) => {
    return sendSafePhoto(msg.chat.id, IMAGES.error, {
        caption: `⚠️ *MISSING NUMBER*\n\nUse: /delpair 234XXXXXXXXX`,
        parse_mode: 'Markdown'
    });
}));

bot.onText(/^\/delpair(?:@\w+)?\s+(.+)/, requireMembership(async (msg, match) => {
    const chatId = msg.chat.id;
    const number = match[1].trim();
    const senderNumber = number.replace(/[^0-9]/g, '');

    try {
        if (!senderNumber || /[a-z]/i.test(number) || !/^\d{7,15}$/.test(senderNumber)) {
            return bot.sendPhoto(chatId, IMAGES.error, {
                caption: `⚠️ *INVALID NUMBER*\n\nUse: /delpair 234XXXXXXXXX`,
                parse_mode: 'Markdown'
            });
        }

        const jidSuffix = `${senderNumber}@s.whatsapp.net`;
        const pairingPath = path.join(__dirname, 'nexstore', 'pairing');

        if (!(await exists(pairingPath))) {
            return bot.sendPhoto(chatId, IMAGES.error, {
                caption: `❌ *No session found*`,
                parse_mode: 'Markdown'
            });
        }

        const entries = await fs.readdir(pairingPath, { withFileTypes: true });
        const matched = entries.find(entry => entry.isDirectory() && entry.name === jidSuffix);

        if (!matched) {
            return bot.sendPhoto(chatId, IMAGES.error, {
                caption: `❌ *Not found*\n\n${senderNumber} is not paired.`,
                parse_mode: 'Markdown'
            });
        }

        const targetPath = path.join(pairingPath, matched.name);
        try {
            const pairModule = require('./pair.js');
            if (typeof pairModule.unpairSession === 'function') await pairModule.unpairSession(jidSuffix);
            else await fs.rm(targetPath, { recursive: true, force: true });
        } catch (error) {
            return bot.sendPhoto(chatId, IMAGES.error, {
                caption: `❌ Session reset did not finish: ${error.message}. Session kept; retry shortly.`
            });
        }
        try { require('./deploy/botSelectionStore').clearSelection(senderNumber); } catch {}

        bot.sendPhoto(chatId, IMAGES.success, {
            caption: `✅ *DELETED*\n\n📱 Number: ${senderNumber}`,
            parse_mode: 'Markdown'
        });
        
        console.log(chalk.green(`🗑️ Deleted: ${number}`));
    } catch (err) {
        logSafeError(chalk.red('Delpair error:'), err);
        sendSafePhoto(chatId, IMAGES.error, {
            caption: `❌ *Failed*\n\n${safeErrorMessage(err)}`,
            parse_mode: 'Markdown'
        });
    }
}));

// Listpair command (admin only)
bot.onText(/^\/listpair(?:@\w+)?\s*$/i, async (msg) => {
    return sendSafePhoto(msg.chat.id, IMAGES.error, {
        caption: `⚠️ *CONFIRM REQUIRED*\n\nUse: /listpair confirm`,
        parse_mode: 'Markdown'
    });
});

bot.onText(/^\/listpair(?:@\w+)?\s+confirm$/i, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();

    if (!adminIDs.includes(userId)) {
        return bot.sendPhoto(chatId, IMAGES.error, {
            caption: `🔒 *ADMIN ONLY*`,
            parse_mode: 'Markdown'
        });
    }

    try {
        const pairingPath = path.join(__dirname, 'nexstore', 'pairing');
        
        if (!(await exists(pairingPath))) {
            return bot.sendPhoto(chatId, IMAGES.error, {
                caption: `❌ *No devices found*`,
                parse_mode: 'Markdown'
            });
        }

        const entries = await fs.readdir(pairingPath, { withFileTypes: true });
        const pairedDevices = entries
            .filter(entry => entry.isDirectory() && entry.name !== 'pairing.json' && entry.name.endsWith('@s.whatsapp.net'))
            .map(entry => entry.name);

        if (pairedDevices.length === 0) {
            return bot.sendPhoto(chatId, IMAGES.error, {
                caption: `❌ *No devices found*`,
                parse_mode: 'Markdown'
            });
        }

        const deviceList = pairedDevices.map((device, index) => {
            const phoneNumber = device.split('@')[0];
            return `${index + 1}. ${phoneNumber}`;
        }).join('\n');

        bot.sendPhoto(chatId, IMAGES.success, {
            caption: `📱 *PAIRED DEVICES*\n\n📊 Total: ${pairedDevices.length}\n\n${deviceList}\n\n${ZUKO.footer}`,
            parse_mode: 'Markdown'
        });
    } catch (err) {
        logSafeError(chalk.red('Listpair error:'), err);
        sendSafePhoto(chatId, IMAGES.error, {
            caption: `❌ *Error*`,
            parse_mode: 'Markdown'
        });
    }
});

// Getbot command - direct users to the WA pairing instructions
bot.onText(/^\/getbot(?:@\w+)?$/, async (msg) => {
    const chatId = msg.chat.id;
    const firstName = escapeMarkdown(msg.from?.first_name || 'User');
    const tgChannel = process.env.TG_CHANNEL_1 || SOCIAL_LINKS.channel1;
    const tgGroup   = process.env.TG_GROUP_1   || SOCIAL_LINKS.group1;

    const caption = `
${ZUKO.line}
┃  🤖 *GET YOUR FREE BOT* 🤖
┃  ${ZUKO.divider}
┃  Hey ${firstName}! Here's how to get your own
┃  free WhatsApp bot powered by MAIS MDX:
┃  ${ZUKO.divider}
┃  📋 *Steps:*
┃  1️⃣ Use /pair <your_number> here
┃  2️⃣ Open WhatsApp → Linked Devices
┃  3️⃣ Tap "Link a Device" → enter the code
┃  4️⃣ Your bot is live instantly! 🚀
┃  ${ZUKO.divider}
┃  ⚡ *300+ commands available:*
┃  • AI chat & image generation
┃  • Media downloads (YT, Spotify, TikTok)
┃  • Group moderation tools
┃  • Games, fun, sticker packs & more
┃  ${ZUKO.divider}
┃  💬 Need help? Join our support group!
┃  ${ZUKO.footer}
${ZUKO.lineEnd}`;

    const keyboard = {
        reply_markup: {
            inline_keyboard: [
                [{ text: '🔗 Pair Now', callback_data: 'help_msg' }],
                [{ text: '✨ Channel', url: tgChannel }, { text: '👥 Support', url: tgGroup }]
            ]
        }
    };

    await sendSafePhoto(chatId, IMAGES.bot, { caption, ...keyboard, parse_mode: 'Markdown' });
});

// Report command
bot.onText(/^\/report(?:@\w+)?\s+(.+)/, requireMembership(async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const username = msg.from.username ? `@${escapeMarkdown(msg.from.username)}` : 'No username';
    const firstName = escapeMarkdown(msg.from.first_name || 'User');
    const reportMessage = escapeMarkdown(match[1].trim());

    if (!reportMessage) {
        return sendSafePhoto(chatId, IMAGES.error, {
            caption: `⚠️ *MISSING MESSAGE*\n\nUse: /report your message here`,
            parse_mode: 'Markdown'
        });
    }

    const reportText = `
${ZUKO.line}
┃  📢 *NEW REPORT*
┃  ${ZUKO.divider}
┃  👤 ${firstName}
┃  🆔 ${userId}
┃  📝 ${username}
┃  ${ZUKO.divider}
┃  💬 ${reportMessage}
${ZUKO.lineEnd}`;

    let sentCount = 0;
    for (const adminId of adminIDs) {
        try {
            await bot.sendPhoto(adminId, IMAGES.banner, {
                caption: reportText,
                parse_mode: 'Markdown'
            });
            sentCount++;
        } catch (e) {
            console.error(`Failed to send to ${adminId}:`, e.message);
        }
    }

    bot.sendPhoto(chatId, IMAGES.success, {
        caption: sentCount > 0 ? `✅ *REPORT SENT*` : `⚠️ *REPORT SAVED*\n\nNo admin chat was reachable.`,
        parse_mode: 'Markdown'
    });
}));

bot.onText(/^\/report(?:@\w+)?\s*$/, requireMembership(async (msg) => {
    return sendSafePhoto(msg.chat.id, IMAGES.error, {
        caption: `⚠️ *MISSING MESSAGE*\n\nUse: /report your message here`,
        parse_mode: 'Markdown'
    });
}));

// Group member events: welcome, goodbye, and verify gate
bot.on('new_chat_members', async (msg) => {
    const chatId = msg.chat.id;
    await loadWelcomeSettings();
    await loadGroupVerifySettings();

    for (const member of msg.new_chat_members || []) {
        const name = escapeMarkdown(member.first_name || 'User');
        const group = escapeMarkdown(msg.chat.title || 'Group');
        const count = await getChatCount(chatId).catch(() => 'many');

        if (groupVerifySettings[chatId]?.enabled && !member.is_bot) {
            try {
                await bot.restrictChatMember(chatId, member.id, { permissions: { can_send_messages: false } });
            } catch (err) {
                console.error('Verify restrict error:', err.message);
            }
            await bot.sendMessage(chatId, `👋 Welcome ${name}! Tap VERIFY to unlock chatting.`, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [[{ text: '✅ VERIFY', callback_data: `gc_verify:${member.id}` }]] }
            });
        }

        if (welcomeSettings[chatId]?.enabled) {
            const custom = welcomeSettings[chatId].message || 'Welcome {name} to {group}! Members: {count}';
            const text = custom.replaceAll('{name}', name).replaceAll('{group}', group).replaceAll('{count}', String(count));
            await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' }).catch(() => {});
        }
    }
});

bot.on('left_chat_member', async (msg) => {
    const chatId = msg.chat.id;
    await loadGoodbyeSettings();
    if (!goodbyeSettings[chatId]?.enabled) return;
    const member = msg.left_chat_member || {};
    const name = escapeMarkdown(member.first_name || 'User');
    const group = escapeMarkdown(msg.chat.title || 'Group');
    const count = await getChatCount(chatId).catch(() => 'many');
    const custom = goodbyeSettings[chatId].message || 'Goodbye {name} from {group}. Members: {count}';
    const text = custom.replaceAll('{name}', name).replaceAll('{group}', group).replaceAll('{count}', String(count));
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' }).catch(() => {});
});

// ========================
// CALLBACK QUERY HANDLER
// ========================
// ========================
// BOT SELECTION (/number)
// ========================
const selStore = (() => { try { return require('./deploy/botSelectionStore'); } catch { return null; } })();
const deployMgr = (() => { try { return require('./deploy/deploymentManager'); } catch { return null; } })();
const selRegistry = (() => { try { return require('./deploy/selectorRegistry'); } catch { return null; } })();


const isAdminUser = (userId) => adminIDs.includes(String(userId));

function selectionKeyboard(number, bots) {
    return {
        inline_keyboard: bots.map(b => ([{
            text: b.name,
            callback_data: `bsel|${number}|${b.id}`,
        }])),
    };
}

/**
 * /number            -> your paired numbers + their bot status
 * /number 234XXXX    -> choose (or view) the bot for that number
 * Admins see every number, users only their own.
 */
bot.onText(/^\/number(?:@\w+)?(?:\s+(.+))?$/, requireMembership(async (msg, match) => {
    const chatId = msg.chat.id;
    return bot.sendMessage(chatId,
        'Every paired number runs MIAS MDX automatically. No bot selection is required.');
}));



bot.on('callback_query', async (callbackQuery) => {
    const msg = callbackQuery.message;
    const data = callbackQuery.data;
    const userId = callbackQuery.from.id;
    const chatId = msg.chat.id;
    
    await trackUser(userId);

    // ── Pairing method choice: pairmethod|<number>|<telegramUser>|<mode> ──
    if (data && data.startsWith('pairmethod|')) {
        const [, number, requestedBy, mode] = data.split('|');
        if (!/^\d{7,15}$/.test(String(number || '')) || !['qr', 'code'].includes(mode)) {
            return bot.answerCallbackQuery(callbackQuery.id, {
                text: 'This pairing button is invalid or expired.',
                show_alert: true
            });
        }
        if (String(requestedBy) !== String(userId)) {
            return bot.answerCallbackQuery(callbackQuery.id, {
                text: 'This pairing choice belongs to the person who requested it.',
                show_alert: true
            });
        }

        await bot.answerCallbackQuery(callbackQuery.id, {
            text: mode === 'qr' ? 'Starting QR pairing…' : 'Generating pairing code…'
        }).catch(() => {});

        // Re-check membership at the moment the handshake starts, not only
        // when /pair was sent. This also prevents a stale button being used
        // after access was revoked.
        const membership = await checkMembership(userId);
        if (!membership.hasJoinedAll && !adminIDs.includes(String(userId))) {
            return sendJoinRequirement(chatId, membership.missing);
        }

        return runTelegramPair({
            chat: msg.chat,
            from: callbackQuery.from,
        }, number, mode);
    }

    // ── Bot selection: bsel|<number>|<botId> ─────────────────────────────
    if (data && data.startsWith('bsel|')) {
        await bot.answerCallbackQuery(callbackQuery.id, { text: 'Bot selection has been removed.', show_alert: true });
        return;
        /*
        const [, number, botId] = data.split('|');

        if (!selStore || !deployMgr) {
            return bot.answerCallbackQuery(callbackQuery.id, { text: 'Selection unavailable.', show_alert: true });
        }

        const record = selStore.get(number);
        const admin = isAdminUser(userId);
        if (!admin && String(record?.telegram?.id || '') !== String(userId)) {
            return bot.answerCallbackQuery(callbackQuery.id, { text: 'This number is not yours.', show_alert: true });
        }

        if (record?.botId) {
            await bot.answerCallbackQuery(callbackQuery.id, { text: `Locked to ${record.botName}.`, show_alert: true });
            return bot.sendMessage(chatId,
                `🔒 \`${number}\` is already locked to *${record.botName}*.\nUnpair and pair again to change it.`,
                { parse_mode: 'Markdown' });
        }

        await bot.answerCallbackQuery(callbackQuery.id, { text: 'Deploying…' });

        // Remove the tapped selector straight away, then every other copy of
        // it (WhatsApp + other Telegram chats) via the deploy manager below.
        try { await bot.deleteMessage(chatId, msg.message_id); } catch {}
        try { await selRegistry?.revokeAll?.(number, { telegram: bot }); } catch {}

        const status = await bot.sendMessage(chatId, `⏳ Starting your bot for \`${number}\`… (3s)`, { parse_mode: 'Markdown' });


        try {
            const res = await deployMgr.submitSelection(number, botId, {
                source: 'telegram',
                chosenBy: { id: userId, username: callbackQuery.from.username || null },
            });

            if (!res.ok) {
            return editSafeMessageText(`⚠️ ${res.error}`, { chat_id: chatId, message_id: status.message_id });
            }

            return editSafeMessageText(
                `✅ *${res.bot.name}* is now the bot for \`${number}\`.\n\n` +
                `🔒 This choice is locked. Unpair and pair again to switch.`,
                { chat_id: chatId, message_id: status.message_id, parse_mode: 'Markdown' });
        } catch (err) {
            logSafeError('bsel error:', err);
            return editSafeMessageText(`❌ Deployment failed: ${safeErrorMessage(err)}`, { chat_id: chatId, message_id: status.message_id });
        }
        */
    }

    if (data && data.startsWith('gc_verify:')) {
        const targetUserId = Number(data.split(':')[1]);
        if (targetUserId !== userId) {
            return bot.answerCallbackQuery(callbackQuery.id, { text: 'This verify button is not for you.', show_alert: true });
        }

        try {
            await bot.restrictChatMember(chatId, userId, {
                permissions: { can_send_messages: true, can_send_audios: true, can_send_documents: true, can_send_photos: true, can_send_videos: true, can_send_video_notes: true, can_send_voice_notes: true, can_send_polls: true, can_send_other_messages: true, can_add_web_page_previews: true }
            });
            await bot.answerCallbackQuery(callbackQuery.id, { text: 'Verified!' });
            return bot.sendMessage(chatId, `✅ ${escapeMarkdown(callbackQuery.from.first_name || 'Member')} verified.`, { parse_mode: 'Markdown' });
        } catch (err) {
            console.error('GC verify error:', err.message);
            return bot.answerCallbackQuery(callbackQuery.id, { text: 'Verify failed. Ask admin to make bot admin.', show_alert: true });
        }
    }

    if (data === 'check_membership') {
        // Always answer callback immediately so Telegram doesn't time out
        await bot.answerCallbackQuery(callbackQuery.id, { text: '🔍 Checking membership...' }).catch(() => {});

        try {
            const membership = await checkMembership(userId);
            const firstName = escapeMarkdown(callbackQuery.from.first_name || 'User');

            if (membership.hasJoinedAll) {
                // ── VERIFIED ─ send a fresh message (never editMessageMedia which crashes on text msgs)
                const successCaption = `
${ZUKO.line}
${ZUKO.titleLine}
┃  ${ZUKO.divider}
┃  ✅ *VERIFIED — Welcome ${firstName}!*
┃  ${ZUKO.divider}
┃
┃  🚀 *You can now pair your WhatsApp!*
┃  ${ZUKO.divider}
┃  📱 *HOW TO PAIR:*
┃  ➤ Send: /pair 234XXXXXXXXXX
┃  ➤ (Replace with your full number)
┃  ➤ Enter the code shown in WhatsApp
┃  ${ZUKO.divider}
┃  📌 *OTHER COMMANDS*
┃  ➤ /delpair <number> — Remove device
┃  ➤ /listpair confirm — List devices
┃  ➤ /ping — Latency check
┃  ➤ /profile — Your profile
┃  ➤ /report <msg> — Report issue
┃
┃  ${ZUKO.divider}
┃  ${ZUKO.footer}
${ZUKO.lineEnd}`;

                await sendSafePhoto(chatId, IMAGES.success, {
                    caption: successCaption,
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '📱 PAIR WHATSAPP NOW', callback_data: 'show_pair_menu' }],
                            [{ text: '📜 MORE COMMANDS', callback_data: 'start_bot' }, { text: '❓ HELP', callback_data: 'help_msg' }],
                            [{ text: '🏓 PING', callback_data: 'ping_btn' }, { text: '👤 PROFILE', callback_data: 'profile_btn' }]
                        ]
                    }
                });

            } else {
                // ── STILL MISSING some groups ─ show ONLY the missing ones
                const missingLines = membership.missing
                    .map((ch, i) => `┃  ➤ 👥 ${ch.name || `GROUP ${i + 1}`}`)
                    .join('\n');

                const failCaption = `
${ZUKO.line}
${ZUKO.titleLine}
┃  ${ZUKO.divider}
┃  ❌ *NOT YET VERIFIED*
┃  ${ZUKO.divider}
┃  You still need to join:
┃  ${ZUKO.divider}
${missingLines}
┃  ${ZUKO.divider}
┃  👉 Join the group(s) above, then
┃     click *VERIFY* again.
┃  ${ZUKO.divider}
┃  ${ZUKO.footer}
${ZUKO.lineEnd}`;

                await sendSafePhoto(chatId, IMAGES.error, {
                    caption: failCaption,
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: buildJoinKeyboard(membership.missing) }
                });
            }
        } catch (error) {
            console.error(chalk.red('check_membership callback error:'), error.message);
            // Fallback — show join buttons so user is never stuck
            await sendSafePhoto(chatId, IMAGES.error, {
                caption: `❌ *Verification error.* Please try again.`,
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: buildJoinKeyboard([]) }
            }).catch(() => {});
        }
    } else if (data === 'start_bot') {
        await bot.answerCallbackQuery(callbackQuery.id);
        // ── ANTI-BYPASS: re-check membership before exposing the menu ─────────
        const _m = await checkMembership(userId).catch(() => ({ hasJoinedAll: false, missing: [] }));
        if (!_m.hasJoinedAll) { await sendJoinRequirement(chatId, _m.missing); return; }
        const caption = `
${ZUKO.line}
${ZUKO.titleLine}
┃  ${ZUKO.divider}
┃  🎭 *Hey ${callbackQuery.from.first_name}*
┃  ${ZUKO.divider}
┃
┃  📱 *COMMANDS*
┃  ${ZUKO.divider}
┃  ➤ /pair <number> - Connect WhatsApp
┃  ➤ /delpair <number> - Remove device
┃  ➤ /listpair confirm - List devices
┃  ➤ /ping - Check latency
┃  ➤ /profile - Your profile
┃  ➤ /leaderboard - Top users
┃  ➤ /welcome - Welcome settings
┃  ➤ /goodbye - Goodbye settings
┃  ➤ /report - Report issue
┃
┃  ${ZUKO.divider}
┃  ${ZUKO.footer}
${ZUKO.lineEnd}`;
     await bot.sendPhoto(chatId, IMAGES.logo, {
            caption: caption,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '✨ CH 1', url: SOCIAL_LINKS.channel1 }],
                    [{ text: '👥 GROUP', url: SOCIAL_LINKS.group1 }],
                    [{ text: '❓ HELP', callback_data: 'help_msg' }]
                ]
            }
        });
    } else if (data === 'help_msg') {
        await bot.answerCallbackQuery(callbackQuery.id);
        
        const caption = `
${ZUKO.line}
┃  ❓ *HELP*
┃  ${ZUKO.divider}
┃
┃  📌 *COMMANDS*
┃  ${ZUKO.divider}
┃  ➤ /pair <number> - Pair device
┃  ➤ /delpair <number> - Remove
┃  ➤ /listpair confirm - List devices
┃  ➤ /ping - Check latency
┃  ➤ /profile - Your profile
┃  ➤ /leaderboard - Top users
┃  ➤ /welcome - Welcome settings
┃  ➤ /goodbye - Goodbye settings
┃  ➤ /report - Report issue
┃
┃  ${ZUKO.divider}
┃  ${ZUKO.footer}
${ZUKO.lineEnd}`;

        await bot.sendPhoto(chatId, IMAGES.banner, {
            caption: caption,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🚀 START', callback_data: 'start_bot' }],
                    [{ text: '✨ CH 1', url: SOCIAL_LINKS.channel1 }],
                    [{ text: '👥 GROUP', url: SOCIAL_LINKS.group1 }]
                ]
            }
        });
    }
});

// ========================
// UNKNOWN COMMAND HANDLER
// ========================
bot.on('message', async (msg) => {
    if (msg.text && msg.text.startsWith('/')) {
        const command = msg.text.split(' ')[0];
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        
        const validCommands = [
            '/start', '/pair', '/delpair', '/listpair', '/number', '/ping', '/runtime',
            '/help', '/report', '/welcome', '/goodbye', '/stats', '/profile',
            '/leaderboard', '/verifygc', '/gcverify', '/kick', '/ban', '/unban',
            '/mute', '/unmute', '/warn', '/resetwarn'
        ];

        if (!validCommands.includes(command)) {
            await trackUser(userId);
            
            if (!adminIDs.includes(userId.toString())) {
                const membership = await checkMembership(userId);
                if (!membership.hasJoinedAll) {
                    return sendJoinRequirement(chatId);
                }
            }

            bot.sendPhoto(chatId, IMAGES.error, {
                caption: `❓ *Unknown command*\n\nType /help for commands.`,
                parse_mode: 'Markdown'
            });
        }
    }
});

// ========================
// INITIALIZATION
// ========================
(async () => {
    await loadAdminIDs();
    await loadUserIDs();
    await loadUserStats();
    await loadWelcomeSettings();
    await loadGoodbyeSettings();
    await loadGroupVerifySettings();
    await loadGroupWarnings();
    
    console.log(chalk.magenta(`
╔════════════════════════════════╗
║   ✨ MAIS MDX IS ONLINE ✨     ║
║   🤖 Status: Running           ║
║   👥 Users: ${userIDs.size}    ║
║   👑 Admins: ${adminIDs.length}║
╚════════════════════════════════╝
    `));
    
    console.log(chalk.green(`✓ Membership checking: ENABLED`));
    console.log(chalk.green(`✓ Welcome/Goodbye: ENABLED`));
    console.log(chalk.green(`✓ Group verify/moderation: ENABLED`));
    console.log(chalk.green(`✓ Report system: ENABLED`));
    console.log(chalk.green(`✓ All systems ready!\n`));
})();

// ════════════════════════════════════════════════════════════════════════════
// LOGOUT NOTIFICATION CONSUMER
// When a paired WhatsApp session is forcefully logged out (linked device
// removed from phone), mias/index.js drops a JSON file in
// nexstore/logout_notifications/. We poll here and notify the Telegram
// admin who paired that number.
// ════════════════════════════════════════════════════════════════════════════
(function _logoutNotificationConsumer() {
  const NOTIF_DIR = path.join(__dirname, 'nexstore', 'logout_notifications');
  try { fsSync.mkdirSync(NOTIF_DIR, { recursive: true }); } catch {}

  async function _processNotifFile(file) {
    const full = path.join(NOTIF_DIR, file);
    let payload;
    try { payload = JSON.parse(fsSync.readFileSync(full, 'utf8')); }
    catch { try { fsSync.unlinkSync(full); } catch {} return; }
    try { fsSync.unlinkSync(full); } catch {}

    const { number, name, reason } = payload || {};
    if (!number || number === 'unknown') return;

    // Notify all admins about the logout
    const targets = [...new Set([...adminIDs])];
    if (!targets.length) return;

    for (const chatId of targets) {
      try {
        const msgText =
`⚠️ *MAIS MDX — Bot Logged Out!*

📱 *Number:* +${number}${name ? '\n👤 *Name:* ' + name : ''}
💬 *Reason:* ${reason || 'Device removed from WhatsApp'}

🧹 The WhatsApp session was wiped automatically and will not be restarted.

Pair the number again via the web panel or Telegram /pair.`;

        await bot.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });
      } catch {}
    }
  }

  setInterval(() => {
    let files = [];
    try { files = fsSync.readdirSync(NOTIF_DIR).filter(f => f.endsWith('.json')); } catch {}
    for (const f of files) { _processNotifFile(f).catch(() => {}); }
  }, 5000);

  console.log(chalk.cyan('🔔 logout-notification consumer running'));
})();

// Shutdown handlers
process.once('SIGINT', () => {
    console.log(chalk.yellow('\n🛑 Shutting down...'));
    bot.stopPolling();
    process.exit(0);
});

process.once('SIGTERM', () => {
    console.log(chalk.yellow('\n🛑 Shutting down...'));
    bot.stopPolling();
    process.exit(0);
});

// ════════════════════════════════════════════════════════════════════════════
// v8: pair-request consumer
// Sub-bots (mias/index.js linkme/selfpair handler) drop a JSON file in
// nexstore/pair-requests/. We pick it up, run startpairing() locally, then
// write the resulting code to nexstore/pair-responses/<number>.json so the
// sub-bot can DM it back to the WhatsApp user.
// ════════════════════════════════════════════════════════════════════════════
(function _miasPairRequestConsumer() {
  const REQ_DIR = path.join(__dirname, 'nexstore', 'pair-requests');
  const RES_DIR = path.join(__dirname, 'nexstore', 'pair-responses');
  try { fsSync.mkdirSync(REQ_DIR, { recursive: true }); } catch {}
  try { fsSync.mkdirSync(RES_DIR, { recursive: true }); } catch {}

  const _inflight = new Set();

  async function _handleOne(file) {
    if (_inflight.has(file)) return;
    _inflight.add(file);
    const full = path.join(REQ_DIR, file);
    let payload;
    try { payload = JSON.parse(fsSync.readFileSync(full, 'utf8')); }
    catch (e) {
      try { fsSync.unlinkSync(full); } catch {}
      _inflight.delete(file); return;
    }
    // remove request immediately so we don't reprocess on restart
    try { fsSync.unlinkSync(full); } catch {}

    const num = String(payload?.number || '').replace(/[^0-9]/g, '');
    if (!num) { _inflight.delete(file); return; }
    const jid = payload?.jid || `${num}@s.whatsapp.net`;
    const resFile = path.join(RES_DIR, `${num}.json`);

    try {
      const pairModule = require('./pair.js');
      const startpairing = typeof pairModule === 'function' ? pairModule : pairModule.startpairing;
      const waitForPairingResult = pairModule.waitForPairingResult;
      const hasPairedSession = pairModule.hasPairedSession;
      if (typeof startpairing !== 'function') throw new Error('Pairing module not loaded');

      if (typeof hasPairedSession === 'function' && hasPairedSession(jid)) {
        fsSync.writeFileSync(resFile, JSON.stringify({
          error: 'already-paired', number: num, jid, ts: Date.now(),
        }));
        _inflight.delete(file); return;
      }

      await startpairing(jid);
      let result = null;
      if (typeof waitForPairingResult === 'function') {
        result = await waitForPairingResult(jid, 60000).catch(() => null);
      }
      const code = result?.code || result?.pairingCode || null;
      if (code) {
        fsSync.writeFileSync(resFile, JSON.stringify({ code, jid, number: num, ts: Date.now() }));
        console.log(chalk.green(`[pair-consumer] code delivered for +${num}: ${code}`));
      } else {
        fsSync.writeFileSync(resFile, JSON.stringify({ error: 'no-code-received', number: num, jid, ts: Date.now() }));
      }
    } catch (e) {
      try { fsSync.writeFileSync(resFile, JSON.stringify({ error: e.message || String(e), number: num, jid, ts: Date.now() })); } catch {}
      console.log(chalk.yellow(`[pair-consumer] failed for +${num}: ${e.message || e}`));
    } finally {
      _inflight.delete(file);
    }
  }

  setInterval(() => {
    let files = [];
    try { files = fsSync.readdirSync(REQ_DIR).filter(f => f.endsWith('.json')); } catch {}
    for (const f of files) _handleOne(f).catch(() => {});
  }, 2500);

  console.log(chalk.cyan('🪝 pair-request consumer running (nexstore/pair-requests → pair-responses)'));
})();
