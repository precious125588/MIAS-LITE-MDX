// notify.js
const fs = require('fs');
const TelegramBot = require('node-telegram-bot-api');
const { getBotToken } = (() => {
  try { return require('./nexstore_modules/token'); } catch {}
  try { return require('./nexstore/token'); } catch {}
  return { getBotToken: () => "" };
})();

const adminFilePath = (() => {
  try {
    const p = require("path").join(require("./nexstore_modules/sessionPaths").nexstoreRoot(), "admin.json");
    if (fs.existsSync(p)) return p;
  } catch {}
  if (fs.existsSync("./nexstore/admin.json")) return "./nexstore/admin.json";
  return "./nexstore_modules/admin.json";
})();
const TELEGRAM_SEND_TIMEOUT_MS = 10000;

function withTimeout(promise, ms = TELEGRAM_SEND_TIMEOUT_MS) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('Telegram request timed out')), ms))
    ]);
}

async function sendNotification(message, parseMode = 'Markdown') {
    const envAdmins = (process.env.ADMIN_IDS || '')
        .split(',')
        .map(id => id.trim())
        .filter(Boolean);
    let adminIDs = envAdmins.length ? envAdmins : [];

    try {
        if (!envAdmins.length && fs.existsSync(adminFilePath)) {
            const fileAdmins = JSON.parse(fs.readFileSync(adminFilePath, 'utf8'));
            if (Array.isArray(fileAdmins)) {
                adminIDs = fileAdmins.map(id => String(id).trim()).filter(Boolean);
            }
        }
    } catch (e) {
        console.error('Error loading admin IDs:', e && e.message ? e.message : String(e));
    }

    if (adminIDs.length === 0) {
        console.warn('No Telegram admin IDs configured; skipping notification.');
        return;
    }

    try {
        const botToken = getBotToken();
        if (!botToken) {
            console.warn('Telegram token is not configured; notification skipped.');
            return;
        }
        const bot = new TelegramBot(botToken, { polling: false });
        for (const adminId of adminIDs) {
            try {
                await withTimeout(bot.sendMessage(adminId, message, { parse_mode: parseMode }));
                console.log(`✓ Notification sent to admin: ${adminId}`);
            } catch (err) {
                console.error(`Failed to send to admin ${adminId}:`, err.message);
            }
        }
    } catch (err) {
        console.error('Failed to send notification:', err.message);
    }
}

async function sendUserConnected(userNumber) {
    const BOT_NM = process.env.BOT_NAME || 'MAIS MDX';
    const date = new Date().toLocaleString('en-GB', { timeZone: 'Africa/Lagos' });

    const message =
`╔══════════════════════════════╗
║   ✅ *USER CONNECTED* ✅
╠══════════════════════════════╣
║ 📱 *Number:*  \`${userNumber}\`
║ 🕐 *Time:*    ${date}
║ 🟢 *Status:*  Online & Ready
║ 🤖 *Bot:*     ${BOT_NM}
╠══════════════════════════════╣
║   📌 *QUICK COMMANDS*
╠══════════════════════════════╣
║ 🎨 *AI / FUN*
║  .ai  .gpt  .roast  .poem
║  .storyai  .triviaai  .codeai
║  .txt2img  .compliment
╠══════════════════════════════╣
║ 📥 *DOWNLOADERS*
║  .tiktok  .ig  .yt  .twitter
║  .fb  .snap  .reddit  .spotify
║  .pin  .threads  .mediafire
╠══════════════════════════════╣
║ 🔍 *SEARCH & TOOLS*
║  .movies  .anime  .apk
║  .wiki  .weather  .tts
║  .translate  .adult
╠══════════════════════════════╣
║ 🛡️ *GROUP ADMIN*
║  .kick  .ban  .promote  .demote
║  .mute  .unmute  .tagall
║  .antilink  .antispam  .warn
║  .kickall  .close  .open
╠══════════════════════════════╣
║ ⚙️ *SETTINGS*
║  .autobio  .autoview  .autoreact
║  .autotyping  .setpp  .gst
╠══════════════════════════════╣
║ ℹ️  Send *.menu* in WhatsApp
║     for full command list
╠══════════════════════════════╣
║ ⚡ Powered by ${BOT_NM}
╚══════════════════════════════╝`;

    await sendNotification(message);
}

async function sendUserDisconnected(userNumber, reason = 'Unknown', options = {}) {
    const BOT_NM = process.env.BOT_NAME || 'MAIS MDX';
    const date = new Date().toLocaleString('en-GB', { timeZone: 'Africa/Lagos' });
    const reconnecting = options.reconnecting !== false;
    const actionLine = reconnecting
        ? '║ 🔄 Bot will attempt to reconnect'
        : '║ 🧹 Session cleared — pair again';

    const message =
`╔══════════════════════════════╗
║   ❌ *USER DISCONNECTED* ❌
╠══════════════════════════════╣
║ 📱 *Number:*  \`${userNumber}\`
║ 🕐 *Time:*    ${date}
║ 🔴 *Status:*  Offline
║ 📝 *Reason:*  ${reason}
║ 🤖 *Bot:*     ${BOT_NM}
╠══════════════════════════════╣
${actionLine}
║ ⚡ Powered by ${BOT_NM}
╚══════════════════════════════╝`;

    await sendNotification(message);
}

async function sendBotStartMessage() {
    const BOT_NM = process.env.BOT_NAME || 'MAIS MDX';
    const date = new Date().toLocaleString('en-GB', { timeZone: 'Africa/Lagos' });
    const uptime = process.uptime();
    const days    = Math.floor(uptime / 86400);
    const hours   = Math.floor((uptime % 86400) / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);

    const message =
`╔══════════════════════════════╗
║   🤖 *${BOT_NM} STARTED* 🤖
╠══════════════════════════════╣
║ 🕐 *Time:*    ${date}
║ ⏱️  *Uptime:*  ${days}d ${hours}h ${minutes}m
║ 🟢 *Status:*  Online & Ready
╠══════════════════════════════╣
║   📌 *SYSTEM INFO*
╠══════════════════════════════╣
║ 🔑 *Prefix:*  . (dot)
║ 📡 *Mode:*    Multi-User
║ 🔄 *Restart:* Auto (exit 75)
║ 🛡️ *Admin log:* ON for all GCs
╠══════════════════════════════╣
║   📌 *QUICK COMMANDS*
╠══════════════════════════════╣
║ .menu — Full command list
║ .pair — Pair WhatsApp
║ .ai   — AI chat
║ .tiktok .ig .yt — Download
║ .kick .ban .promote — GC admin
╠══════════════════════════════╣
║ ✨ *Ready to serve all users!*
║ ⚡ Powered by ${BOT_NM}
╚══════════════════════════════╝`;

    await sendNotification(message);
}


// ── Bot selection required (new pairing, no bot chosen yet) ──────────────────
// Sent to the Telegram user who paired the number (when known) and to admins.
// The inline keyboard is answered by the polling bot in bot.js.
async function sendSelectionRequired(userNumber, bots = []) {
    const number = String(userNumber).replace(/\D/g, '');
    if (!number) return;

    let store = null;
    try { store = require('./deploy/botSelectionStore'); } catch {}

    const keyboard = {
        inline_keyboard: (bots.length ? bots : [{ id: 'mias-mdx', name: 'MIAS MDX' }]).map(b => ([{
            text: `${b.name}${b.tagline ? ' — ' + b.tagline : ''}`,
            callback_data: `bsel|${number}|${b.id}`,
        }])),
    };

    const text =
`🤖 *CHOOSE YOUR BOT*

📱 Number: \`${number}\`
✅ WhatsApp linked successfully.

Nothing is deployed until you pick a bot below.
You can also send /number any time.

🔒 *Your choice is final* — to change bots you must unpair this number and pair it again.`;

    const targets = new Set();

    const owner = store?.getOwner?.(number);
    if (owner?.id) targets.add(String(owner.id));

    const envAdmins = (process.env.ADMIN_IDS || '').split(',').map(x => x.trim()).filter(Boolean);
    if (envAdmins.length) {
        envAdmins.forEach(a => targets.add(a));
    } else {
        try {
            if (fs.existsSync(adminFilePath)) {
                const fileAdmins = JSON.parse(fs.readFileSync(adminFilePath, 'utf8'));
                if (Array.isArray(fileAdmins)) fileAdmins.forEach(a => targets.add(String(a).trim()));
            }
        } catch {}
    }

    if (!targets.size) {
        console.warn('[notify] No Telegram target for bot selection of ' + number);
        return;
    }

    // Already chose a bot (e.g. tapped the WhatsApp menu a second earlier)?
    // Never post another selector — that is where the duplicates came from.
    if (store?.getSelection?.(number)?.botId) {
        console.log(`[notify] ${number} already locked to a bot — no Telegram selector sent.`);
        return;
    }

    let registry = null;
    try { registry = require('./deploy/selectorRegistry'); } catch {}

    // Reuse the already-polling bot when it exists so we do not open a second
    // Telegram client for a single send.
    const botToken = getBotToken();
    if (!botToken) {
        console.warn('Telegram token is not configured; selection notification skipped.');
        return;
    }
    const client = global._miasTelegramBot || new TelegramBot(botToken, { polling: false });

    for (const chatId of targets) {
        try {
            const sent = await client.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: keyboard });
            // Registered so it is deleted the moment the user chooses anywhere.
            if (sent?.message_id) registry?.registerTelegram?.(number, chatId, sent.message_id);
        } catch (err) {
            console.error(`[notify] Selection prompt failed for ${chatId}:`, err.message);
        }
    }
}


module.exports = {
    sendNotification,
    sendSelectionRequired,
    sendUserConnected,
    sendUserDisconnected,
    sendBotStartMessage
};
