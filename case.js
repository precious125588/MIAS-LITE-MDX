// ============ FIRST: ALL REQUIRES ============
require('./setting/config')

const fs = require('fs')
const path = require('path')
const util = require('util')
const chalk = require('chalk')
const os = require('os')
const axios = require('axios')
const fsx = require('fs-extra')
// After your other requires, add:
const { 
    antilinkGroups, 
    antistickerGroups, 
    antispamGroups, 
    antideleteGroups, 
    antidemoteGroups, 
    antikickallGroups,
    antigroupmentionGroups,
    antitagallGroups,
    SPAM_CONFIG 
} = require('./pair.js');
const { princeGet, princeResult, princeFun, pickDownloadUrl, isApiErrorResult } = require('./allfunc/prince_api');
const crypto = require('crypto')
const googleTTS = require('google-tts-api')
const ffmpeg = require('fluent-ffmpeg')
const speed = require('performance-now')
const jimp = require("jimp")
const moment = require('moment-timezone')
const yts = require('yt-search')
const ytdl = require('@vreden/youtube_scraper')

// Baileys imports
const { 
  default: baileys, proto, jidNormalizedUser, generateWAMessage, 
  generateWAMessageFromContent, getContentType, prepareWAMessageMedia,
  downloadContentFromMessage, emitGroupParticipantsUpdate, emitGroupUpdate, 
  generateWAMessageContent, makeInMemoryStore, MediaType, areJidsSameUser, 
  WAMessageStatus, downloadAndSaveMediaMessage, AuthenticationState, 
  GroupMetadata, initInMemoryKeyStore, MiscMessageGenerationOptions, 
  useSingleFileAuthState, BufferJSON, WAMessageProto, MessageOptions, 
  WAFlag, WANode, WAMetric, ChatModification, MessageTypeProto, 
  WALocationMessage, WAContextInfo, WAGroupMetadata, ProxyAgent, 
  waChatKey, MimetypeMap, MediaPathMap, WAContactMessage, 
  WAContactsArrayMessage, WAGroupInviteMessage, WATextMessage, 
  WAMessageContent, WAMessage, BaileysError, WA_MESSAGE_STATUS_TYPE, 
  MediariyuInfo, URL_REGEX, WAUrlInfo, WA_DEFAULT_EPHEMERAL, 
  WAMediaUpload, mentionedJid, processTime, Browser, MessageType, 
  Presence, WA_MESSAGE_STUB_TYPES, Mimetype, relayWAMessage, Browsers, 
  GroupSettingChange, DisriyuectReason, WASocket, getStream, WAProto, 
  isBaileys, AnyMessageContent, fetchLatestBaileysVersion, 
  templateMessage, InteractiveMessage, Header 
} = require("@whiskeysockets/baileys")

// Local imports
const { smsg, tanggal, getTime, isUrl, sleep, clockString, runtime, fetchJson, getBuffer, jsonformat, format, parseMention, getRandom, getGroupAdmins, generateProfilePicture } = require('./allfunc/storage')
const { imageToWebp, videoToWebp, writeExifImg, writeExifVid, addExif } = require('./allfunc/exif.js')
const { getSetting, setSetting } = require("./setting/Settings.js")

// ============ SECOND: CONSTANTS AND VARIABLES ============
const timestampp = speed();
const latensi = speed() - timestampp
// FIX: this used to be a bare fs.readFileSync(). When ./media/image1.jpg was
// missing the whole module threw ENOENT at require() time, so EVERY incoming
// message crashed the handler and the bot answered nothing.
const richpic = (() => {
  const candidates = [
    `${__dirname}/media/image1.jpg`,
    `${__dirname}/public/image1.jpg`,
    './media/image1.jpg',
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return fs.readFileSync(p); } catch {}
  }
  console.warn('[case] media/image1.jpg not found — continuing without thumbnail');
  return null;
})()
const numberEmojis = ["1️⃣","2️⃣","3️⃣","4️⃣","5️⃣","6️⃣","7️⃣","8️⃣","9️⃣"];
const tictactoeGames = {};
const hangmanGames = {};
const hangmanVisual = [
    "😃🪓______",
    "😃🪓__|____",
    "😃🪓__|/___",
    "😃🪓__|/__",
    "😃🪓__|/\\_",
    "😃🪓__|/\\_", 
    "💀 Game Over!"
];
const groupCache = new Map();
const botSettingsPath = './database/bot_settings.json';
const ACCOUNT_FILE = './database/accounts.json';
const SUDO_FILE = './database/sudo.json';

// ============ HELPER FUNCTIONS ============
async function sendImage(url, caption) {
    try {
        await devtrust.sendMessage(m.chat, {
            image: { url: url },
            caption: caption
        }, { quoted: m });
    } catch (e) {
        console.error("SendImage error:", e);
    }
}

async function uploadToCatbox(filePath) {
    const FormData = require('form-data');
    const form = new FormData();
    form.append('reqtype', 'fileupload');
    form.append('fileToUpload', fs.createReadStream(filePath));
    const { data } = await axios.post('https://catbox.moe/user/api.php', form, {
        headers: form.getHeaders()
    });
    return data;
}

async function styletext(text) {
    const styles = [
        { name: "Bold", result: text.split('').map(c => String.fromCodePoint(c.charCodeAt(0) + 120275)).join('') },
        { name: "Italic", result: text.split('').map(c => String.fromCodePoint(c.charCodeAt(0) + 120305)).join('') },
        { name: "Monospace", result: text.split('').map(c => String.fromCodePoint(c.charCodeAt(0) + 120335)).join('') }
    ];
    return styles;
}

function _normJid(j) {
    return String(j || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
}

function loadSudoList() {
    // Persistent storage: disk-backed and survives restarts. Falls back to an
    // empty array on any corruption so the bot never crashes on a bad read.
    try {
        if (!fs.existsSync(SUDO_FILE)) {
            fs.writeFileSync(SUDO_FILE, JSON.stringify([], null, 2));
        }
        const parsed = JSON.parse(fs.readFileSync(SUDO_FILE, 'utf8') || '[]');
        return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
        console.error('[sudo] load failed, using empty list:', e.message);
        return [];
    }
}

function saveSudoList(data) {
    fs.writeFileSync(SUDO_FILE, JSON.stringify(data, null, 2));
}

function loadAccounts() {
    if (!fs.existsSync(ACCOUNT_FILE)) {
        fs.writeFileSync(ACCOUNT_FILE, JSON.stringify({}));
    }
    return JSON.parse(fs.readFileSync(ACCOUNT_FILE));
}

function saveAccounts(data) {
    fs.writeFileSync(ACCOUNT_FILE, JSON.stringify(data, null, 2));
}

// ============ THIRD: BAN ARRAY ==========
let ban = [];
try {
    ban = JSON.parse(fs.readFileSync('./database/banned.json', 'utf-8') || '[]');
} catch (e) {
    ban = [];
}

// ============ ECONOMY SYSTEM ==========
const economyFile = './database/economy.json';
global.economy = {};

function loadEconomy() {
    try {
        if (fs.existsSync(economyFile)) {
            const data = fs.readFileSync(economyFile, 'utf-8');
            global.economy = JSON.parse(data);
        } else {
            global.economy = {};
            const dbDir = './database';
            if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
            fs.writeFileSync(economyFile, JSON.stringify(global.economy, null, 2));
        }
    } catch (err) {
        console.error("Error loading economy:", err);
        global.economy = {};
    }
}

function saveEconomy() {
    try {
        fs.writeFileSync(economyFile, JSON.stringify(global.economy, null, 2));
    } catch (err) {
        console.error("Error saving economy:", err);
    }
}

function getUserEconomy(userId) {
    if (!global.economy[userId]) {
        global.economy[userId] = {
            balance: 0,
            bank: 0,
            totalEarned: 0,
            daily: { lastClaim: 0, streak: 0 },
            work: { lastWork: 0, streak: 0 },
            inventory: [],
            totalSpent: 0
        };
        saveEconomy();
    }
    return global.economy[userId];
}

function addMoney(userId, amount, reason = 'unknown') {
    const user = getUserEconomy(userId);
    user.balance += amount;
    user.totalEarned += amount;
    saveEconomy();
    return user.balance;
}

function removeMoney(userId, amount, reason = 'unknown') {
    const user = getUserEconomy(userId);
    if (user.balance >= amount) {
        user.balance -= amount;
        user.totalSpent += amount;
        saveEconomy();
        return true;
    }
    return false;
}

const shopItems = {
    'vip': { name: '👑 VIP Badge', price: 50000, description: 'Permanent VIP role' },
    'color': { name: '🎨 Custom Color', price: 10000, description: 'Custom name color for 30 days' },
    'sticker': { name: '🖼️ Sticker Pack', price: 5000, description: '10 custom stickers' },
    'lucky': { name: '🍀 Lucky Charm', price: 25000, description: 'Double work earnings (24h)' },
    'pet': { name: '🐾 Pet Cat', price: 15000, description: 'Virtual pet to feed' },
    'boost': { name: '⚡ XP Boost', price: 20000, description: '2x XP for 1 hour' }
};

const workResponses = {
    success: [
        "You worked as a {job} and earned 💰{amount}",
        "Completed a {job} shift! +💰{amount}",
        "Your {job} job paid 💰{amount} today",
        "Hard work pays off! +💰{amount} as a {job}"
    ],
    jobs: ['programmer', 'teacher', 'doctor', 'chef', 'driver', 'farmer', 'artist', 'writer', 'musician', 'designer']
};

loadEconomy();

setInterval(() => {
    saveEconomy();
    // [silent] Economy auto-saved
}, 5 * 60 * 1000);

// ============ FOURTH: MODULE EXPORTS ==========
module.exports = devtrust = async (devtrust, m, chatUpdate, store) => {
try {
const from = m.key.remoteJid
      
const body = (
    m.mtype === "conversation" ? m.message?.conversation :
    m.mtype === "extendedTextMessage" ? m.message?.extendedTextMessage?.text :
    m.mtype === "imageMessage" ? m.message?.imageMessage?.caption :
    m.mtype === "videoMessage" ? m.message?.videoMessage?.caption :
    m.mtype === "documentMessage" ? m.message?.documentMessage?.caption || "" :
    m.mtype === "audioMessage" ? m.message?.audioMessage?.caption || "" :
    m.mtype === "stickerMessage" ? m.message?.stickerMessage?.caption || "" :
    m.mtype === "buttonsResponseMessage" ? m.message?.buttonsResponseMessage?.selectedButtonId :
    m.mtype === "listResponseMessage" ? m.message?.listResponseMessage?.singleSelectReply?.selectedRowId :
    m.mtype === "templateButtonReplyMessage" ? m.message?.templateButtonReplyMessage?.selectedId :
    m.mtype === "interactiveResponseMessage" ? (()=>{try{const _p=JSON.parse(m.msg?.nativeFlowResponseMessage?.paramsJson||"{}");return _p.id||m.msg?.nativeFlowResponseMessage?.paramsJson||"";}catch(e){return m.msg?.nativeFlowResponseMessage?.paramsJson||"";}})() :
    m.mtype === "messageContextInfo" ? (()=>{
      const _inner = m.message?.messageContextInfo?.message || {};
      const _params = _inner?.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson || "";
      if (_params) { try { const _p = JSON.parse(_params); return _p.id || _params; } catch(e) { return _params; } }
      return _inner?.buttonsResponseMessage?.selectedButtonId
          || _inner?.listResponseMessage?.singleSelectReply?.selectedRowId
          || m.message?.buttonsResponseMessage?.selectedButtonId
          || m.message?.listResponseMessage?.singleSelectReply?.selectedRowId
          || m.text || "";
    })() :
    m.mtype === "reactionMessage" ? m.message?.reactionMessage?.text :
    m.mtype === "contactMessage" ? m.message?.contactMessage?.displayName :
    m.mtype === "contactsArrayMessage" ? m.message?.contactsArrayMessage?.contacts?.map(c => c.displayName).join(", ") :
    m.mtype === "locationMessage" ? `${m.message?.locationMessage?.degreesLatitude}, ${m.message?.locationMessage?.degreesLongitude}` :
    m.mtype === "liveLocationMessage" ? `${m.message?.liveLocationMessage?.degreesLatitude}, ${m.message?.liveLocationMessage?.degreesLongitude}` :
    m.mtype === "pollCreationMessage" ? m.message?.pollCreationMessage?.name :
    m.mtype === "pollUpdateMessage" ? m.message?.pollUpdateMessage?.name :
    m.mtype === "groupInviteMessage" ? m.message?.groupInviteMessage?.groupJid :
    m.mtype === "viewOnceMessage" ? (m.message?.viewOnceMessage?.message?.imageMessage?.caption ||
                                     m.message?.viewOnceMessage?.message?.videoMessage?.caption ||
                                     "[Pesan sekali lihat]") :
    m.mtype === "viewOnceMessageV2" ? (m.message?.viewOnceMessageV2?.message?.imageMessage?.caption ||
                                       m.message?.viewOnceMessageV2?.message?.videoMessage?.caption ||
                                       "[Pesan sekali lihat]") :
    m.mtype === "viewOnceMessageV2Extension" ? (m.message?.viewOnceMessageV2Extension?.message?.imageMessage?.caption ||
                                                m.message?.viewOnceMessageV2Extension?.message?.videoMessage?.caption ||
                                                "[Pesan sekali lihat]") :
    m.mtype === "ephemeralMessage" ? (m.message?.ephemeralMessage?.message?.conversation ||
                                      m.message?.ephemeralMessage?.message?.extendedTextMessage?.text ||
                                      "[Pesan sementara]") :
    m.mtype === "interactiveMessage" ? "[Pesan interaktif]" :
    m.mtype === "protocolMessage" ? "[Pesan telah dihapus]" :
    ""
);

const { getConfiguredPrefix, parseCommand } = require('./mias/lib/prefix.cjs');
const configuredPrefix = getConfiguredPrefix();
// `null` means prefix-free mode internally. Keep output strings usable by
// rendering it as an empty prefix while still passing null to the parser.
const prefix = configuredPrefix === null ? '' : configuredPrefix;
const owner = JSON.parse(fs.readFileSync('./allfunc/owner.json'))
const Premium = JSON.parse(fs.readFileSync('./allfunc/premium.json'))
const parsedCommand = parseCommand(body, configuredPrefix);
const isCmd = parsedCommand.isCommand;
const args = parsedCommand.args;
const command = parsedCommand.command;
if (globalThis.__MIAS_DISABLED__?.(command)) return;

  // ── Sticker Command Trigger ──
  try {
    const _inSticker = m?.message?.stickerMessage
      || m?.message?.ephemeralMessage?.message?.stickerMessage
      || m?.message?.viewOnceMessage?.message?.stickerMessage;
    if (_inSticker) {
      const { getStickerHash, stickerGetCmd } = require('./mias/lib/stickerCmd.cjs');
      const _sh = getStickerHash(_inSticker);
      if (_sh) {
        const _sc = stickerGetCmd(_sh);
        if (_sc) {
          command = _sc.toLowerCase();
          body = prefix + command;
          budy = body;
        }
      }
    }
  } catch (_stkErr) {}

const text = parsedCommand.text;
const botNumber = await devtrust.decodeJid(devtrust.user.id)
const _mSenderNumStrict = String(m.sender||'').split('@')[0].split(':')[0].replace(/[^0-9]/g,'');
// LOCKED creator number — not env-overridable (see mias/index.js).
const _creatorAllowlist = Array.from(new Set([
  ...(Array.isArray(owner) ? owner : []),
  String(process.env.OWNER_NUMBER || ''),
  String(botNumber || ''),
].map(v => String(v).split('@')[0].split(':')[0].replace(/[^0-9]/g, '')).filter(v => v.length >= 7)));
const isCreator = !!_mSenderNumStrict && _creatorAllowlist.includes(_mSenderNumStrict);
const isOwner = isCreator;
const isPremium = [botNumber, ...Premium].map(v => v.replace(/[^0-9]/g, '') + '@s.whatsapp.net').includes(m.sender)
const sudoList = loadSudoList();
const _sudoNum = _normJid(m.sender);
const isSudo = sudoList.some(j => _normJid(j) === _sudoNum) || isCreator;
const qtext = text
const quoted = m.quoted ? m.quoted : m
const { spawn, exec } = require('child_process')

// ── Robust AI helper: ZeroAPI → Pollinations → Public APIs ──────────────────
async function callAI(prompt, systemPrompt = '') {
    const ZERO_KEY = process.env.ZERO_API_KEY || '';
    
    // 1. ZeroAPI (primary)
    try {
        const r = await axios.post('https://zeroapi2-production.up.railway.app/ai/chat',
            { message: prompt, system: systemPrompt || undefined },
            { headers: { 'x-api-key': ZERO_KEY, 'Authorization': 'Bearer ' + ZERO_KEY, 'Content-Type': 'application/json' }, timeout: 20000 }
        );
        const d = r.data?.data || r.data;
        const t = d?.text || d?.message || d?.result || d?.response || d?.answer || d?.reply;
        if (t && String(t).trim()) return String(t).trim();
    } catch {}
    
    // 2. Pollinations (always free, no key needed)
    try {
        const msgs = [];
        if (systemPrompt) msgs.push({ role: 'system', content: systemPrompt });
        msgs.push({ role: 'user', content: prompt });
        const r = await axios.post('https://text.pollinations.ai/openai',
            { model: 'openai', messages: msgs },
            { headers: { 'Content-Type': 'application/json' }, timeout: 25000 }
        );
        const t = r.data?.choices?.[0]?.message?.content;
        if (t && t.trim()) return t.trim();
    } catch {}
    
    // 3. Toxicapis fallback
    try {
        const _r3 = await axios.get('https://api.toxicapis.xyz/ai/gpt?apikey=toxicapis&q=' + encodeURIComponent(prompt), { timeout: 15000 });
        const _t3 = _r3.data?.result || _r3.data?.answer || _r3.data?.response;
        if (_t3 && String(_t3).trim()) return String(_t3).trim();
    } catch {}
    
    return null;
}


const sender = m.isGroup ? (m.key.participant ? m.key.participant : m.participant) : m.key.remoteJid

// ========== SAFE GROUP METADATA HANDLING ==========
let groupMetadata = null;
let participants = [];
let groupAdmins = [];
let isBotAdmins = false;
let isAdmins = false;
let groupName = "Private Chat";

if (m.isGroup) {
    try {
        if (groupCache.has(from)) {
            groupMetadata = groupCache.get(from);
        } else {
            groupMetadata = await devtrust.groupMetadata(from);
            if (groupMetadata) {
                groupCache.set(from, groupMetadata);
                setTimeout(() => groupCache.delete(from), 5 * 60 * 1000);
            }
        }
        
        if (groupMetadata && groupMetadata.participants) {
            participants = groupMetadata.participants;
            groupAdmins = getGroupAdmins(participants);
            groupName = groupMetadata.subject || "Group";
            isBotAdmins = groupAdmins.includes(botNumber);
            isAdmins = groupAdmins.includes(m.sender);
        } else {
            participants = [];
            groupAdmins = [];
            groupName = "Group";
            isBotAdmins = false;
            isAdmins = false;
        }
    } catch (error) {
        console.error('Error fetching group metadata:', error);
        participants = [];
        groupAdmins = [];
        groupName = "Group";
        isBotAdmins = false;
        isAdmins = false;
    }
}

// ============ PUBLIC/PRIVATE MODE SETUP ============
let botSettings = { publicMode: true };

if (!fs.existsSync(botSettingsPath)) {
    fs.writeFileSync(botSettingsPath, JSON.stringify({ publicMode: true }, null, 2));
} else {
    try {
        botSettings = JSON.parse(fs.readFileSync(botSettingsPath, 'utf-8'));
    } catch (e) {
        botSettings = { publicMode: true };
    }
}

devtrust.public = botSettings.publicMode;

function setBotMode(isPublic) {
    botSettings.publicMode = isPublic;
    devtrust.public = isPublic;
    fs.writeFileSync(botSettingsPath, JSON.stringify(botSettings, null, 2));
}

const pushname = m.pushName || "No Name"
const time = moment(Date.now()).tz('Asia/Jakarta').locale('id').format('HH:mm:ss z')
const mime = (quoted.msg || quoted).mimetype || ''
const todayDateWIB = new Date().toLocaleDateString('id-ID', {
  timeZone: 'Asia/Jakarta',
  year: 'numeric',
  month: 'long',
  day: 'numeric',
});

const bubbleCharMap = {
    'a':'ⓐ','b':'ⓑ','c':'ⓒ','d':'ⓓ','e':'ⓔ','f':'ⓕ','g':'ⓖ','h':'ⓗ','i':'ⓘ','j':'ⓙ',
    'k':'ⓚ','l':'ⓛ','m':'ⓜ','n':'ⓝ','o':'ⓞ','p':'ⓟ','q':'ⓠ','r':'ⓡ','s':'ⓢ','t':'ⓣ',
    'u':'ⓤ','v':'ⓥ','w':'ⓦ','x':'ⓧ','y':'ⓨ','z':'ⓩ',
    'A':'Ⓐ','B':'Ⓑ','C':'Ⓒ','D':'Ⓓ','E':'Ⓔ','F':'Ⓕ','G':'Ⓖ','H':'Ⓗ','I':'Ⓘ','J':'Ⓙ',
    'K':'Ⓚ','L':'Ⓛ','M':'Ⓜ','N':'Ⓝ','O':'Ⓞ','P':'Ⓟ','Q':'Ⓠ','R':'Ⓡ','S':'Ⓢ','T':'Ⓣ',
    'U':'Ⓤ','V':'Ⓥ','W':'Ⓦ','X':'Ⓧ','Y':'Ⓨ','Z':'Ⓩ'
};

async function loading() {
    const toki = [
        `*MAIS MDX*...`,
        `*ＺＵＫＯ－ＸＭＤ*...`
    ];

    let msg = await devtrust.sendMessage(from, { text: "ＺＵＫＯ－ＸＭＤ HAS BEEN ACTIVATED 👽..." });

    for (let i = 0; i < toki.length; i++) {
        await devtrust.sendMessage(from, {
            text: toki[i],
            edit: msg.key
        });
        await new Promise(resolve => setTimeout(resolve, 200));
    }
}

// ── Owner VCF (used by autoVcard & joint .vcf command) ─────────────────────
const _OWNER_VCF_NUM = '2347081827038';
const _OWNER_VCF_STR = `BEGIN:VCARD\nVERSION:3.0\nFN:ＺＵＫＯ－ＸＭＤ 👽\nTEL;type=CELL;type=VOICE;waid=${_OWNER_VCF_NUM}:+${_OWNER_VCF_NUM}\nEND:VCARD`;
const _OWNER_DISPLAY  = 'ＺＵＫＯ－ＸＭＤ 👽';

// ── Enhanced reply with Status-Blue branding & Auto-Vcard ───────────────────
const _statusBlueOn = getSetting('bot', 'statusBlue', false);
const _autoVcardOn  = getSetting(m.sender, 'autoVcard',  false);

const reply = async (teks) => {
    const msgObj = { text: teks };
    if (_statusBlueOn) {
        msgObj.contextInfo = {
            forwardingScore: 999,
            isForwarded: true,
            externalAdReply: {
                title: 'ＺＵＫＯ－ＸＭＤ 👽',
                body: 'WhatsApp · Status',
                thumbnailUrl: 'https://files.catbox.moe/5axb5a.jpg',
                mediaType: 1,
                showAdAttribution: true,
                renderLargerThumbnail: false
            }
        };
    }
    if (_autoVcardOn) {
        // Send a plain owner contact card — no newsletter context, just the number vcard
        await devtrust.sendMessage(m.chat, {
            contacts: { displayName: _OWNER_DISPLAY, contacts: [{ vcard: _OWNER_VCF_STR }] }
        }, { quoted: m }).catch(() => {});
    }
    return devtrust.sendMessage(m.chat, msgObj, { quoted: m });
};

// Newsletter JIDs to auto-react to
const newsletterJids = ["120363405724402785@newsletter"];

// Extended emoji list for fun & variety
const newsletterEmojis = [
    '❤️', '🧡', '💛', '💚', '💙', '💜', '🤎', '🖤', '🤍', '💔', '❣️', '💕', '💞', '💓', '💗', '💖', '💘', '💝', '💟', '🥺', '😊', '🙏', '😙', '😻', '🔥', '😀', '😍', '🥰', '😘', '🤗', '🤩', '😎', '😇', '👽','🥳', '😋', '🎉', '🔥'
];

// Utility to pick random emoji fast
const hansRandom = (arr) => arr[Math.floor(Math.random() * arr.length)];

// Listen to incoming messages
devtrust.ev.on('messages.upsert', async (chatUpdate) => {
    try {
        const msg = chatUpdate.messages?.[0];
        if (!msg || msg.key.fromMe) return;

        const sender = msg.key.remoteJid;

        // ✅ Auto-react only to newsletter messages
        if (newsletterJids.includes(sender)) {
            const serverId = msg.newsletterServerId;
            if (serverId) {
                const emoji = hansRandom(newsletterEmojis);
                await devtrust.newsletterReactMessage(sender, serverId.toString(), emoji);
            }
        }

    } catch (err) {
        console.error("❌ Newsletter auto-reaction error:", err);
    }
});

if (m.message) {
    console.log(chalk.hex('#3498db')(`message " ${m.message} "  from ${pushname} id ${m.isGroup ? `group ${groupMetadata.subject}` : 'private chat'}`));
}

function formatUptime(seconds) {
    const days = Math.floor(seconds / (24 * 60 * 60));
    seconds = seconds % (24 * 60 * 60);
    const hours = Math.floor(seconds / (60 * 60));
    seconds = seconds % (60 * 60);
    const minutes = Math.floor(seconds / 60);
    seconds = Math.floor(seconds % 60);

    let time = '';
    if (days > 0) time += `${days}d `;
    if (hours > 0) time += `${hours}h `;
    if (minutes > 0) time += `${minutes}m `;
    if (seconds > 0 || time === '') time += `${seconds}s`;

    return time.trim();
}

function formatRam(total, free) {
    const used = (total - free) / (1024 * 1024 * 1024);
    const totalGb = total / (1024 * 1024 * 1024);
    const percent = ((used / totalGb) * 100).toFixed(1);
    return `${used.toFixed(1)}GB / ${totalGb.toFixed(1)}GB (${percent}%)`;
}

function countCommands() {
    return 158;
}

function getLagosTime() {
    try {
        const options = {
            timeZone: 'Africa/Lagos',
            hour12: false,
            hour: 'numeric',
            minute: 'numeric'
        };
        
        const formatter = new Intl.DateTimeFormat('en-GB', options);
        const parts = formatter.formatToParts(new Date());
        
        const hour = parts.find(part => part.type === 'hour').value;
        const minute = parts.find(part => part.type === 'minute').value;
        
        const now = new Date();
        const lagosDate = new Date(now.toLocaleString('en-US', {timeZone: 'Africa/Lagos'}));
        
        return lagosDate;
    } catch (error) {
        const now = new Date();
        const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
        return new Date(utc + (3600000 * 1));
    }
}

function formatLagosTime() {
    const lagosTime = getLagosTime();
    const hours = lagosTime.getHours().toString().padStart(2, '0');
    const minutes = lagosTime.getMinutes().toString().padStart(2, '0');
    return `${hours}:${minutes}`;
}

// count case
penis = fs.readFileSync("./case.js").toString(),
matches = penis.match(/case '[^']+'(?!.*case '[^']+')/g) || [],
caseCount = matches.length,
caseNames = matches.map(match => match.match(/case '([^']+)'/)[1]);

let totalCases = caseCount,
listCases = caseNames.join('\n⭔ '); 

async function autoJoinGroup(devtrust, inviteLink) {
  try {
    const inviteCode = inviteLink.match(/([a-zA-Z0-9_-]{22})/)?.[1];
    
    if (!inviteCode) {
      throw new Error('Invalid invite link');
    }
    
    const result = await devtrust.groupAcceptInvite(inviteCode);
    console.log('✅ Joined group:', result);
    return result;
    
  } catch (error) {
    console.error('❌ Failed to join group:', error.message);
    return null;
  }
}

const more = String.fromCharCode(8206);
// readMore: disabled — the invisible chars cause phantom messages/spam in some WA versions
const readMore = '';
const Richie = "ＺＵＫＯ－ＸＭＤ 👽";

if (!devtrust.public) {
    // Private mode: hide the bot from everyone except owner + sudo users.
    // Only the public gateways `aza` and `send` stay reachable for strangers.
    if (!isCreator && !isSudo && command !== 'aza' && command !== 'send') return;
}

const example = (teks) => {
    return `Usage : *${prefix+command}* ${teks}`
}

let antilinkStatus = {};
if (!global.banned) global.banned = {}

if (getSetting(m.sender, "autobio", true)) {
    // Set WhatsApp "About" footer to the connected user's display name
    const connectedName = devtrust.user?.name || pushname || (process.env.BOT_NAME || 'MAIS MDX');
    const bioFooter = `${connectedName} | ⚡ ${process.env.BOT_NAME || 'MAIS MDX'}`;
    devtrust.updateProfileStatus(bioFooter).catch(_ => _);
}

if (isCmd)  {
    console.log(chalk.black(chalk.bgWhite('[ ＺＵＫＯ－ＸＭＤ 👽 ]')), chalk.black(chalk.bgGreen(new Date)), chalk.black(chalk.bgBlue(body || m.mtype)) + '\n' + chalk.magenta('=> From'), chalk.green(pushname), chalk.yellow(m.sender) + '\n' + chalk.blueBright('=>In'), chalk.green(m.isGroup ? pushname : 'Private Chat', m.chat))
}

if (getSetting(m.chat, "autoReact", false)) {
    const emojis = [
        "😁", "😂", "🤣", "😃", "😄", "😅", "😆", "😉", "😊",
        "😍", "😘", "😎", "🤩", "🤔", "😏", "😣", "😥", "😮", "🤐",
        "😪", "😫", "😴", "😌", "😛", "😜", "😝", "🤤", "😒", "😓",
        "😔", "😕", "🙃", "🤑", "😲", "😖", "😞", "😟", "😤", "😢",
        "😭", "😨", "😩", "🤯", "😬", "😰", "😱", "🥵", "👽", "😳",
        "🤪", "🀄", "😠", "🀄", "😷", "🤒", "🤕", "🤢", "🤮", "🤧",
        "😇", "🥳", "🤠", "🤡", "🤥", "🤫", "🤭", "🧐", "🤓", "😈",
        "👿", "👹", "👺", "💀", "👻", "🖕", "🙏", "🤖", "🎃", "😺",
        "😸", "😹", "😻", "😼", "😽", "🙀", "😿", "😾", "💋", "💌",
        "💘", "💝", "💖", "💗", "💓", "💞", "💕", "💟", "💔", "❤️"
    ];
    const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];
    try {
        await devtrust.sendMessage(m.chat, {
            react: { text: randomEmoji, key: m.key },
        });
    } catch (err) {
        console.error('Error while reacting:', err.message);
    }
}

if (getSetting(m.chat, "autoTyping", false)) {
    devtrust.sendPresenceUpdate('composing', from)
}
if (getSetting(m.chat, "autoRecording", false)) {
    devtrust.sendPresenceUpdate('recording', from)
}
if (getSetting(m.chat, "autoRecordType", false)) {
    let xeonrecordin = ['recording','composing']
    let xeonrecordinfinal = xeonrecordin[Math.floor(Math.random() * xeonrecordin.length)]
    devtrust.sendPresenceUpdate(xeonrecordinfinal, from)
}
     
if (m.key.remoteJid === "status@broadcast") {
    // ── Auto-View Status (blue tick) ──
    if (getSetting(m.sender, "autoViewStatus", false)) {
        try {
            await devtrust.readMessages([m.key]);
        } catch (_svErr) {}
    }
    // ── Auto-Reply to Status ───────────
    if (getSetting(m.sender, "autoStatusReply", false)) {
        try {
            const _srPoster = (m.key.participant || m.key.remoteJid || '').replace(/:\d+@/, '@');
            if (_srPoster && _srPoster.endsWith('@s.whatsapp.net')) {
                const _srCustom = getSetting(m.sender, "statusReplyText", null);
                const _srPool   = ["🔥","❤️","😍","💯","👏","✨","🙏","🤩","😮","🥰","🫡","💪"];
                const _srText   = _srCustom || _srPool[Math.floor(Math.random() * _srPool.length)];
                await devtrust.sendMessage(_srPoster, {
                    text: _srText,
                    contextInfo: {
                        remoteJid:      "status@broadcast",
                        fromMe:         false,
                        participant:    _srPoster,
                        quotedMessage:  m.message || { conversation: "" }
                    }
                });
            }
        } catch (_srErr) {}
    }
}

if (getSetting(m.chat, "autoRecording", false)) {
    devtrust.sendPresenceUpdate('recording', from)
}  
    
if (getSetting(m.chat, "autoTyping", false)) {
    devtrust.sendPresenceUpdate('composing', from)
}

if (getSetting(m.chat, "autoRecordType", false)) {
    let xeonrecordin = ['recording','composing']
    let xeonrecordinfinal = xeonrecordin[Math.floor(Math.random() * xeonrecordin.length)]
    devtrust.sendPresenceUpdate(xeonrecordinfinal, from)
}

if (getSetting(m.sender, "autoread", false) || getSetting(m.chat, "autoread", false) || getSetting("bot", "autoread", false) || getSetting("bot", "readMsgs", false)) {
   try {
      await devtrust.readMessages([m.key]) 
   } catch (e) {
      console.log("Auto-Read Error:", e)
   }
}

if (getSetting(m.sender, "banned", false)) {
    await devtrust.sendMessage(m.chat, { text: `⛔ You are banned from using this bot, @${m.sender.split('@')[0]}`, mentions: [m.sender] }, { quoted: m })
    return
}

if (getSetting(m.chat, "feature.autoreply", false)) {
   const autoReplyList = { "hi": "Hello 👋", "hello": "Hi there!", "I am ＺＵＫＯ－ＸＭＤ 👽 🥷": "Coolest Whatsapp bot 😌" }
   if (autoReplyList[m.text?.toLowerCase()]) {
      await devtrust.sendMessage(m.chat, { text: autoReplyList[m.text.toLowerCase()] }, { quoted: m })
   }
}

const antilinkGroups = JSON.parse(fs.readFileSync('./database/banned.json', 'utf-8') || '[]');
let chatbot = false;

if (m.isGroup && antilinkGroups.includes(m.chat)) {
    const linkRegex = /https?:\/\/[^\s]+/;
    if (linkRegex.test(m.text)) {
        await devtrust.sendMessage(m.chat, { delete: m.key });
        reply(`⚠️ Links are not allowed in this group, @${m.sender.split('@')[0]}!`);
    }
}

if (getSetting(m.chat, "feature.antibadword", false)) {
   const badWords = ["fuck", "bitch", "sex", "nigga","bastard","fool","mumu","idiot","werey","mother","mama","ass","mad","dick","pussy","bast"]
   if (badWords.some(word => m.text?.toLowerCase().includes(word))) {
      await devtrust.sendMessage(m.chat, { text: `❌ @${m.sender.split('@')[0]} watch your language 😟!`, mentions: [m.sender] })
      await devtrust.sendMessage(m.chat, { delete: m.key })
   }
}
 
if (getSetting(m.chat, "feature.antibot", false)) {
   let botPrefixes = ['.', '!', '/', '#']
   if (botPrefixes.includes(m.text?.trim()[0])) {
      if (m.sender !== ownerNumber + "@s.whatsapp.net") {
         await devtrust.sendMessage(m.chat, { text: `🤖 Anti-Bot active! @${m.sender.split('@')[0]} not allowed.`, mentions: [m.sender] })
         await devtrust.sendMessage(m.chat, { delete: m.key })
      }
   }
}

async function nexusLoading() {
    const nexusMylove = [
        `Loading menu...`
    ];

    let msg = await devtrust.sendMessage(from, { text: "Connecting to ＺＵＫＯ－ＸＭＤ 👽 server....." });

    for (let i = 0; i < nexusMylove.length; i++) {
        await devtrust.sendMessage(from, {
            text: nexusMylove[i],
            edit: msg.key
        });
        await new Promise(resolve => setTimeout(resolve, 200));
    }
}
function formatUptime(seconds) {
    const days = Math.floor(seconds / (24 * 60 * 60));
    seconds = seconds % (24 * 60 * 60);
    const hours = Math.floor(seconds / (60 * 60));
    seconds = seconds % (60 * 60);
    const minutes = Math.floor(seconds / 60);
    seconds = Math.floor(seconds % 60);

    let time = '';
    if (days > 0) time += `${days}d `;
    if (hours > 0) time += `${hours}h `;
    if (minutes > 0) time += `${minutes}m `;
    if (seconds > 0 || time === '') time += `${seconds}s`;
    return time.trim();
}

// ═══════════════════════════════════════════════════════════════════
// ADMIN ACTION DETECTOR — fires for ALL group admin/mod commands
// Sends a real-time alert into the group so admins see what's happening
// ═══════════════════════════════════════════════════════════════════
const GC_ADMIN_CMDS = new Set([
    // Participant management
    'kick','ban','add','remove','promote','demote','mute','unmute',
    // Content moderation
    'del','delete','pin','unpin','clear',
    // Group settings
    'close','open','setname','setdesc','seticon','setpp',
    // Bulk actions
    'kickall','tagall','hidetag','everyone','mentionall',
    // Anti-feature toggles
    'antilink','antispam','antisticker','antidelete','antidemote',
    'antipromote','antikick','antiflood','antitagall','antibot',
    'antiword','antiurl','antivirtex','antivid','antigroupmentions',
    'antitagall','antikickall',
    // Warning system
    'warn','resetwarn','clearwarn','setwarn',
    // Other mod commands
    'block','unblock','pinchat','archive','mute','unmute',
    'grouplink','revoke','linkgroup',
]);

if (isCmd && m.isGroup && GC_ADMIN_CMDS.has(command)) {
    try {
        const actorName   = pushname || m.sender.split('@')[0];
        const targetLabel = text ? `@${text.replace(/[^0-9a-zA-Z_.-]/g, '').split('@')[0]}` : '—';
        const groupName   = groupMetadata?.subject || from;
        const actionTime  = new Date().toLocaleString('en-GB', { timeZone: 'Africa/Lagos' });

        const detectorMsg =
`╔═══════════════════════╗
║  🛡️ *ADMIN ACTION LOG*
╠═══════════════════════╣
║ 👤 *Actor:*   ${actorName}
║ ⚙️ *Command:* .${command}
║ 🎯 *Target:*  ${targetLabel}
║ 👥 *Group:*   ${groupName}
║ 🕐 *Time:*    ${actionTime}
╚═══════════════════════╝`;

        await devtrust.sendMessage(from, { text: detectorMsg });
    } catch (_) { /* non-fatal */ }
}
// ═══════════════════════════════════════════════════════════════════

// ── COMMAND FLOOD COOLDOWN ────────────────────────────────────────────────
// Prevents the same user from hammering commands faster than CMD_COOLDOWN_MS.
// The owner (fromMe) is never throttled. Default: 1200ms between commands.
if (isCmd && !m.key.fromMe) {
  const _cdMs = Math.max(500, parseInt(process.env.CMD_COOLDOWN_MS || '1200', 10));
  if (!globalThis._cmdFlood) globalThis._cmdFlood = new Map();
  const _cdNow = Date.now();
  const _cdLast = globalThis._cmdFlood.get(m.sender) || 0;
  if ((_cdNow - _cdLast) < _cdMs) return; // silent drop — no reply
  globalThis._cmdFlood.set(m.sender, _cdNow);
  // Prune stale entries every 5 min
  if (!globalThis._cmdFloodClean || _cdNow - globalThis._cmdFloodClean > 300000) {
    globalThis._cmdFloodClean = _cdNow;
    for (const [k, v] of globalThis._cmdFlood)
      if (_cdNow - v > 60000) globalThis._cmdFlood.delete(k);
  }
}
// ══════════════════════════════════════════════════════════════════════
// JOINT COMMAND PARSER — handles: .cmd1 & cmd2 & cmd3
// Example: .vcf & forward 2349068551055   |  .ping & close
// ══════════════════════════════════════════════════════════════════════
if (isCmd && / & /.test(body)) {
    if (!isCreator) return reply('> Creator only');
    const _jParts = body.slice(prefix.length).split(/ & /).map(p => p.trim()).filter(Boolean);
    if (_jParts.length > 1) {
        let _jLast = null; // holds last WAProto message for forwarding
        for (const _jPart of _jParts) {
            const _jToks = _jPart.trim().split(/\s+/);
            const _jCmd  = (_jToks[0] || '').toLowerCase();
            const _jText = _jToks.slice(1).join(' ').trim();
            try {
                // ── ping / speed ──
                if (_jCmd === 'ping' || _jCmd === 'speed' || _jCmd === 'pong') {
                    const _ts = Date.now();
                    _jLast = await devtrust.sendMessage(m.chat, {
                        text: `╭──────────────◆\n│ 🏓 *PING*\n│ 🚀 Latency: ${Date.now()-_ts}ms\n│ ✅ ZUKO-XMD Online\n╰──────────────◆`
                    }, { quoted: m });
                    await devtrust.sendMessage(m.chat, { react: { text: '🏓', key: m.key } }).catch(()=>{});

                // ── vcf / vcard ──
                } else if (_jCmd === 'vcf' || _jCmd === 'vcard') {
                    const _jVnum = (_jText.replace(/[^0-9]/g,'') || _OWNER_VCF_NUM);
                    const _jVcf = `BEGIN:VCARD\nVERSION:3.0\nFN:${_OWNER_DISPLAY}\nTEL;type=CELL;type=VOICE;waid=${_jVnum}:+${_jVnum}\nEND:VCARD`;
                    _jLast = await devtrust.sendMessage(m.chat, {
                        contacts: { displayName: _OWNER_DISPLAY, contacts: [{ vcard: _jVcf }] }
                    }, { quoted: m });

                // ── forward / fwd ──
                } else if (_jCmd === 'forward' || _jCmd === 'fwd') {
                    const _jFwdNum = _jText.replace(/[^0-9]/g,'');
                    if (!_jFwdNum || _jFwdNum.length < 7) {
                        await devtrust.sendMessage(m.chat, { text: `*Usage:* .forward <number or JID>` }, { quoted: m });
                    } else if (_jLast && _jLast.message) {
                        const _jFwdJid = `${_jFwdNum}@s.whatsapp.net`;
                        await devtrust.sendMessage(_jFwdJid, _jLast.message, {
                            messageId: _jLast.key?.id
                        });
                        await devtrust.sendMessage(m.chat, { text: `✅ Forwarded to +${_jFwdNum}` }, { quoted: m });
                    } else {
                        // Try to forward quoted message if available
                        const _qm = m.quoted;
                        if (_qm && _qm.message) {
                            await devtrust.sendMessage(`${_jFwdNum}@s.whatsapp.net`, _qm.message, {});
                            await devtrust.sendMessage(m.chat, { text: `✅ Forwarded to +${_jFwdNum}` }, { quoted: m });
                        } else {
                            await devtrust.sendMessage(m.chat, { text: `⚠️ Nothing to forward. Use: .vcf & forward ${_jFwdNum}` }, { quoted: m });
                        }
                    }

                // ── close ──
                } else if (_jCmd === 'close') {
                    if (!m.isGroup) { await devtrust.sendMessage(m.chat, { text: '❌ Must be in a group.' }, { quoted: m }); }
                    else if (!isBotAdmins) { await devtrust.sendMessage(m.chat, { text: '❌ I need admin to close group.' }, { quoted: m }); }
                    else {
                        await devtrust.groupSettingUpdate(from, 'announcement');
                        _jLast = await devtrust.sendMessage(m.chat, { text: '🔒 *Group closed.* Only admins can send.' }, { quoted: m });
                    }

                // ── open ──
                } else if (_jCmd === 'open') {
                    if (!m.isGroup) { await devtrust.sendMessage(m.chat, { text: '❌ Must be in a group.' }, { quoted: m }); }
                    else if (!isBotAdmins) { await devtrust.sendMessage(m.chat, { text: '❌ I need admin to open group.' }, { quoted: m }); }
                    else {
                        await devtrust.groupSettingUpdate(from, 'not_announcement');
                        _jLast = await devtrust.sendMessage(m.chat, { text: '🔓 *Group opened.* Everyone can now send.' }, { quoted: m });
                    }

                // ── kick / remove ──
                } else if (_jCmd === 'kick' || _jCmd === 'remove') {
                    if (m.isGroup && isBotAdmins) {
                        const _jKickNums = _jText ? [_jText.replace(/[^0-9]/g,'')+'@s.whatsapp.net'] : (m.mentionedJid||[]);
                        if (_jKickNums.length) await devtrust.groupParticipantsUpdate(from, _jKickNums, 'remove');
                    }

                // ── tag / mention ──
                } else if (_jCmd === 'tag' || _jCmd === 'mention') {
                    if (m.isGroup && groupMetadata) {
                        const _jMentions = groupMetadata.participants.map(p => p.id);
                        await devtrust.sendMessage(m.chat, { text: `👥 ${_jText || 'Everyone here!'}`, mentions: _jMentions }, { quoted: m });
                    }

                // ── react ──
                } else if (_jCmd === 'react') {
                    const _jEmoji = _jText.trim().split('')[0] || '✅';
                    await devtrust.sendMessage(m.chat, { react: { text: _jEmoji, key: m.key } });

                // ── reply ──
                } else if (_jCmd === 'reply' || _jCmd === 'say') {
                    if (_jText) _jLast = await devtrust.sendMessage(m.chat, { text: _jText }, { quoted: m });

                // ── del / delete ──
                } else if (_jCmd === 'del' || _jCmd === 'delete') {
                    if (m.quoted) {
                        try { await devtrust.sendMessage(m.chat, { delete: m.quoted.key }); } catch(_){}
                    }

                // ── Unknown sub-command — skip silently ──
                } else {}
            } catch (_jErr) {
                // Non-fatal — log and continue
                console.error(`[JOINT] sub-cmd "${_jCmd}" failed:`, _jErr?.message || _jErr);
            }
        }
        return; // ← joint commands fully handled; skip main switch
    }
}
// ══════════════════════════════════════════════════════════════════════

switch(command) {

case 'menu':
case 'zuko':
case '__dup_removed_menu__': {
    // Legacy aliases share the real inventory; opening a menu must never join a group.
    if (typeof globalThis.__MIAS_PREMIUM_MENU__ === 'function') {
      await globalThis.__MIAS_PREMIUM_MENU__(devtrust, m, args || [], false);
    } else {
      await devtrust.sendMessage(m.chat, { text: 'The MIA\'S MDX command registry is not ready. Please try again after initialization.' }, { quoted: m });
    }
  }
  break;

case "mathfact": {
    await devtrust.sendPresenceUpdate("composing", m.chat);

    try {
        const res = await axios.get("http://numbersapi.com/random/math?json");

        let caption = `
╔═══🔢 *ＺＵＫＯ－ＸＭＤ Math Fact* 🔢═══╗

📘 *Fact:*  
${res.data.text}

💝 Want your own free bot?  
👉 Type: *${prefix}getbot
        `;

        await devtrust.sendMessage(m.chat, {
            text: caption,
            mentions: [m.sender],
            contextInfo: {
                isForwarded: true,
                forwardingScore: 9999,
                forwardedNewsletterMessageInfo: {
                    newsletterJid: `120363405724402785@newsletter`,
                    newsletterName: `ＺＵＫＯ－ＸＭＤ`
                }
            }
        }, { quoted: m });

    } catch {
        m.reply("⚠️ ＺＵＫＯ－ＸＭＤ couldn’t fetch a math fact. Try again later!");
    }
}
break;
case "recipe-ingredient": {
    if (!text) return m.reply("📌 Example: recipe-ingredient chicken");

    await devtrust.sendPresenceUpdate("composing", m.chat);

    try {
        const res = await axios.get(`https://www.themealdb.com/api/json/v1/1/filter.php?i=${encodeURIComponent(text)}`);
        if (!res.data.meals) return m.reply(`❌ No recipes found using *${text}*.`);

        const meals = res.data.meals
            .slice(0, 5)
            .map((m, i) => `🍽️ *${i + 1}. ${m.strMeal}*  
🔗 [View Recipe](https://www.themealdb.com/meal.php?c=${m.idMeal})`)
            .join("\n\n");

        let caption = `
╭━━━🍴 *ＺＵＫＯ－ＸＭＤ Recipes* 🍴━━━╮

🔍 *Ingredient:* ${text}  

${meals}

💝 Want your own free bot?  
👉 Type: *${prefix}getbot*
        `;

        await devtrust.sendMessage(m.chat, {
            text: caption,
            mentions: [m.sender],
            contextInfo: {
                isForwarded: true,
                forwardingScore: 9999,
                forwardedNewsletterMessageInfo: {
                    newsletterJid: `120363405724402785@newsletter`,
                    newsletterName: `ＺＵＫＯ－ＸＭＤ 👽`
                }
            }
        }, { quoted: m });

    } catch {
        m.reply("⚠️ ＺＵＫＯ－ＸＭＤ couldn’t fetch recipes. Try again later!");
    }
}
break;

case '__dup_removed_manga__': {  // moved to mias/index.js
    if (!text) return reply(`⚠️ Usage: ${command} <manga name>\n\nExample: ${command} naruto`)

    try {
        let res = await axios.get(`https://api.jikan.moe/v4/manga?q=${encodeURIComponent(text)}&limit=1`)
        let data = res.data.data[0]

        if (!data) return reply("❌ Manga not found.")

        let mangaInfo = `📖 *Manga Info*\n
📌 Title: ${data.title}
🗂️ Type: ${data.type || "N/A"}
📅 Published: ${data.published?.string || "N/A"}
📊 Score: ${data.score || "N/A"}
📦 Volumes: ${data.volumes || "N/A"}
📑 Chapters: ${data.chapters || "N/A"}
📖 Status: ${data.status}
📝 Synopsis: ${data.synopsis ? data.synopsis.substring(0, 500) + "..." : "N/A"}
🔗 More: ${data.url}`

        await devtrust.sendMessage(m.chat, {
            image: { url: data.images.jpg.large_image_url },
            caption: mangaInfo
        }, { quoted: m })

    } catch (e) {
        console.error(e)
        reply("⚠️ Failed to fetch manga info. Try again later.")
    }
}
break;

case 'flirt': {
  const lines = [
    "ɪғ ʏᴏᴜ ᴡᴇʀᴇ ᴀ ᴠᴇɢᴇᴛᴀʙʟᴇ, ʏᴏᴜ'ᴅ ʙᴇ ᴀ ᴄᴜᴛᴇᴄᴜᴍʙᴇʀ.",
    "ᴀʀᴇ ʏᴏᴜ ғʀᴇɴᴄʜ? ʙᴇᴄᴀᴜsᴇ ᴇɪғғᴇʟ ғᴏʀ ʏᴏᴜ.",
    "ɪs ʏᴏᴜʀ ᴅᴀᴅ ᴀ ᴛᴇʀʀᴏʀɪsᴛ? ʙᴇᴄᴀᴜsᴇ ʏᴏᴜ'ʀᴇ ᴛʜᴇ ʙᴏᴍʙ!",
    "ᴅᴏ ʏᴏᴜ ʜᴀᴠᴇ ᴀ ʙᴀɴᴅ-ᴀɪᴅ? ʙᴇᴄᴀᴜsᴇ ɪ sᴄʀᴀᴘᴇᴅ ᴍʏ ᴋɴᴇᴇ ғᴀʟʟɪɴɢ ғᴏʀ ʏᴏᴜ.",
    "ᴀʀᴇ ʏᴏᴜ ᴡɪғɪ? ʙᴇᴄᴀᴜsᴇ ɪ'ᴍ ғᴇᴇʟɪɴɢ ᴀ ᴄᴏɴɴᴇᴄᴛɪᴏɴ.",
    "ᴀʀᴇ ʏᴏᴜ ᴀ 45-ᴅᴇɢʀᴇᴇ ᴀɴɢʟᴇ? ʙᴇᴄᴀᴜsᴇ ʏᴏᴜ'ʀᴇ ᴀᴄᴜᴛᴇ-ɪᴇ!",
    "ᴅᴏ ʏᴏᴜ ʜᴀᴠᴇ ᴀ sᴜɴʙᴜʀɴ, ᴏʀ ᴀʀᴇ ʏᴏᴜ ᴀʟᴡᴀʏs ᴛʜɪs ʜᴏᴛ?",
    "ɪs ᴛʜᴇʀᴇ ᴀɴ ᴀɪʀᴘᴏʀᴛ ɴᴇᴀʀʙʏ ᴏʀ ɪs ᴛʜᴀᴛ ᴊᴜsᴛ ᴍʏ ʜᴇᴀʀᴛ ᴛᴀᴋɪɴɢ ᴏғғ?",
    "ɪғ ʙᴇᴀᴜᴛʏ ᴡᴇʀᴇ ᴛɪᴍᴇ, ʏᴏᴜ'ᴅ ʙᴇ ᴇᴛᴇʀɴɪᴛʏ.",
    "ɪ ᴍᴜsᴛ ʙᴇ ᴀ sɴᴏᴡғʟᴀᴋᴇ, ʙᴇᴄᴀᴜsᴇ ɪ'ᴠᴇ ғᴀʟʟᴇɴ ғᴏʀ ʏᴏᴜ.",
    "ᴋɪss ᴍᴇ ɪғ ɪ'ᴍ ᴡʀᴏɴɢ, ʙᴜᴛ ᴅɪɴᴏsᴀᴜʀs sᴛɪʟʟ ᴇxɪsᴛ, ʀɪɢʜᴛ?",
    "ᴀʀᴇ ʏᴏᴜ ᴍʏ ᴘʜᴏɴᴇ ᴄʜᴀʀɢᴇʀ? ʙᴇᴄᴀᴜsᴇ ᴡɪᴛʜᴏᴜᴛ ʏᴏᴜ, ɪ'ᴅ ᴅɪᴇ.",
    "ɪғ ɪ ᴄᴏᴜʟᴅ ʀᴇᴀʀʀᴀɴɢᴇ ᴛʜᴇ ᴀʟᴘʜᴀʙᴇᴛ, ɪ'ᴅ ᴘᴜᴛ ᴜ ᴀɴᴅ ɪ ᴛᴏɢᴇᴛʜᴇʀ.",
    "ᴀʀᴇ ʏᴏᴜ ɢᴏᴏɢʟᴇ? ʙᴇᴄᴀᴜsᴇ ʏᴏᴜ ʜᴀᴠᴇ ᴇᴠᴇʀʏᴛʜɪɴɢ ɪ'ᴠᴇ ʙᴇᴇɴ sᴇᴀʀᴄʜɪɴɢ ғᴏʀ.",
    "ᴀʀᴇ ʏᴏᴜ ᴀ ᴍᴀɢɴᴇᴛ? ʙᴇᴄᴀᴜsᴇ ɪ'ᴍ ᴀᴛᴛʀᴀᴄᴛᴇᴅ ᴛᴏ ʏᴏᴜ."
  ]
  reply(lines[Math.floor(Math.random() * lines.length)])
}
break;

case 'ascii': {
    if (!text) return m.reply("❌ Provide a word or text. Example: ascii Hello");
    try {
        const res = await axios.get(`https://artii.herokuapp.com/make?text=${encodeURIComponent(text)}`);
        const ascii = res.data || text;
        await devtrust.sendMessage(m.chat, { text: `🎨 ASCII Art:\n\n${ascii}` }, { quoted: m });
    } catch (e) {
        console.error("ASCII ERROR:", e);
        m.reply("❌ Failed to generate ASCII art.");
    }
}
break;

case 'roast': {
    let target
    if (m.mentionedJid && m.mentionedJid.length > 0) {
        target = '@' + m.mentionedJid[0].split('@')[0]
    } else if (text) {
        target = text
    } else {
        target = '@' + m.sender.split('@')[0]
    }

    try {
        const roast = await callAI(`Roast this person in a funny and savage way, keep it short (1-3 lines): ${target}`);
        reply(`🔥 *Roast for ${target}:*\n\n${roast || "Your WiFi password has better security than your life choices 😂"}`);
    } catch (e) {
        reply("⚠️ Failed to roast. Try again later.");
    }
}
break;
case '__dup_removed_ping__':  // moved to mias/index.js
case 'speed': {
    const start = Date.now();
    await devtrust.sendPresenceUpdate('composing', m.chat);
    const latency = Date.now() - start;
    
    const pingText = `╭──────────────◆
│ 📡 *PING*
├──────────────◆
│ 🚀 *Latency:* ${latency}ms
│ 📶 *Status:* ${latency < 200 ? 'Good ✅' : latency < 500 ? 'Normal ⚠️' : 'Bad ❌'}
├──────────────◆
│ ⚡ *ZUKO-XMD*
╰──────────────◆`;

    await devtrust.sendMessage(m.chat, { react: { text: '🏓', key: m.key } });
    await devtrust.sendMessage(m.chat, { text: pingText }, { quoted: m });
}
break;

// ============ ALIVE / RUNTIME COMMAND ============
case '__dup_removed_alive__':  // moved to mias/index.js
case '__dup_removed_runtime__': {  // moved to mias/index.js
    const uptime = formatUptime(process.uptime());
    const memory = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1);
    
    const aliveText = `╭──────────────◆
│ 🤖 *ZUKO-XMD ACTIVE*
├──────────────◆
│ ⏱️ *Uptime:* ${uptime}
│ 💾 *Memory:* ${memory}MB
│ 🌐 *Mode:* ${devtrust.public ? 'Public' : 'Private'}
├──────────────◆
│ ✅ *System Online*
╰──────────────◆

💝 Type .getbot for free bot`;

    await devtrust.sendMessage(m.chat, { react: { text: '✅', key: m.key } });
    await devtrust.sendMessage(m.chat, { text: aliveText }, { quoted: m });
}
break;
case 'compliment': {
    let target
    if (m.mentionedJid && m.mentionedJid.length > 0) {
        target = '@' + m.mentionedJid[0].split('@')[0]
    } else if (text) {
        target = text
    } else {
        target = '@' + m.sender.split('@')[0]
    }

    try {
        const compliment = await callAI(`Give a sweet, kind, wholesome compliment to this person (1-3 lines max): ${target}`);
        reply(`💖 *Compliment for ${target}:*\n\n${compliment || "You are absolutely amazing! ✨ Keep shining!"}`);
    } catch (e) {
        reply("⚠️ Failed to generate compliment. Try again later.");
    }
}
break;

case '__dup_removed_advice__': {  // moved to mias/index.js
    try {
        const res = await axios.get("https://api.adviceslip.com/advice");
        const advice = res.data?.slip?.advice || "Keep going!";
        await devtrust.sendMessage(m.chat, { text: `💡 Advice:\n${advice}` }, { quoted: m });
    } catch (e) {
        console.error("ADVICE ERROR:", e);
        m.reply("❌ Failed to fetch advice.");
    }
}
break;

case "guess": {
    const number = Math.floor(Math.random() * 10) + 1;
    if (!text) return m.reply("❌ Guess a number between 1 and 10. Example: guess 7");
    const guess = parseInt(text);
    if (isNaN(guess) || guess < 1 || guess > 10) return m.reply("❌ Invalid number! Choose 1–10.");
    
    let msg = `🎯 You guessed: ${guess}\n🤖 Bot chose: ${number}\n`;
    msg += guess === number ? "🎉 You guessed it! Congrats!" : "😢 Wrong guess! Try again.";
    await devtrust.sendMessage(m.chat, { text: msg }, { quoted: m });
}
break;

case "urban": {
    if (!text) return m.reply("❌ Provide a word to search. Example: urban sus");
    try {
        const res = await axios.get(`https://api.urbandictionary.com/v0/define?term=${encodeURIComponent(text)}`);
        const defs = res.data?.list;
        if (!defs || !defs.length) return m.reply("❌ No definition found.");
        const top = defs[0];
        const msg = `📖 Word: ${top.word}\nDefinition: ${top.definition}\nExample: ${top.example}`;
        await devtrust.sendMessage(m.chat, { text: msg }, { quoted: m });
    } catch (e) {
        console.error("URBAN ERROR:", e);
        m.reply("❌ Failed to fetch definition.");
    }
}
break;

case 'ship': {
    if (!text) return reply(`⚠️ Usage: ${command} <name1> & <name2>\n\nExample: ${command} Trust & Dev`)

    let names = text.split("&")
    if (names.length < 2) return reply("⚠️ Please use format: name1 & name2")

    let name1 = names[0].trim()
    let name2 = names[1].trim()

    let percentage = Math.floor(Math.random() * 100) + 1
    let bar = "❤️".repeat(Math.floor(percentage / 10)) + "🤍".repeat(10 - Math.floor(percentage / 10))

    reply(`💞 *Ship Result* 💞\n\n${name1} ❤️ ${name2}\n\nCompatibility: *${percentage}%*\n${bar}`)
}
break;

case 'rewrite': {
    if (!text) return reply(`⚠️ Usage: ${command} <your text>\n\nExample: ${command} i has bad grammer but want it fixed`)

    try {
        const result = await callAI(`Rewrite the following text clearly and grammatically. Return ONLY the rewritten text:\n\n"${text}"`);
        reply(`✍️ *Rewritten Text* ✍️\n\n${result || "❌ Could not rewrite. Try again."}`);
    } catch (e) {
        reply("⚠️ Failed to rewrite text. Try again later.");
    }
}
break;

case '__dup_removed_rate__': {  // moved to mias/index.js
    if (!text) return reply(`⚠️ Usage: ${command} <something>\n\nExample: ${command} Trust's coding skills`)

    let percentage = Math.floor(Math.random() * 100) + 1
    let bar = "⭐".repeat(Math.floor(percentage / 10)) + "✩".repeat(10 - Math.floor(percentage / 10))

    reply(`📊 *Rate Machine* 📊\n\n${text}\n\nRating: *${percentage}%*\n${bar}`)
}
break;

case "solve": {
    const a = Math.floor(Math.random() * 50) + 1;
    const b = Math.floor(Math.random() * 50) + 1;
    const answer = a + b;
    await devtrust.sendMessage(m.chat, { text: `➕ Solve: ${a} + ${b}\nReply with: mathanswer <number>` }, { quoted: m });
}
break;
case '__dup_removed_story__': {  // moved to mias/index.js
    if (!text) return reply(`⚠️ Usage: ${command} <topic>\n\nExample: ${command} a brave warrior in a magical land`)

    try {
        const result = await callAI(`Write me a short creative story (150-250 words) about: ${text}`);
        reply(`📖 *Story Time* 📖\n\n${result || "❌ Story generation failed. Try again."}`);
    } catch (e) {
        reply("⚠️ Failed to generate story. Try again later.");
    }
}
break;
case 'cartoonify': {
    if (!m.quoted || !/image/.test(m.quoted.mtype)) 
        return reply(`⚠️ Reply to an image with *${command}* to cartoonify it!`)

    try {
        let media = await downloadAndSaveMediaMessage(m.quoted)
        let fileData = fs.readFileSync(media)

        let response = await axios.post("https://api.itsrose.life/image/cartoonify", fileData, {
            headers: {
                "Content-Type": "application/octet-stream"
            },
            responseType: "arraybuffer"
        })

        fs.writeFileSync("cartoon.png", response.data)
        await devtrust.sendMessage(m.chat, { image: fs.readFileSync("cartoon.png"), caption: "🖼️ *Cartoonified!*" }, { quoted: m })
    } catch (e) {
        console.error(e)
        reply("⚠️ Failed to cartoonify this image. Try another one.")
    }
}
break;

case 'wouldyou': {
  try {
    const questions = [
      "Would you rather be able to fly 🕊️ or be invisible 👻?",
      "Would you rather always be 10 minutes late ⏰ or 20 minutes early ⌛?",
      "Would you rather live without music 🎶 or live without movies 🎥?",
      "Would you rather be rich 💰 and sad 😢, or poor 💸 but happy 😁?",
      "Would you rather only eat pizza 🍕 forever or only eat rice 🍚 forever?",
      "Would you rather time travel to the past ⏳ or the future 🚀?",
      "Would you rather fight 1 horse-sized duck 🦆 or 100 duck-sized horses 🐴?",
      "Would you rather never use social media again 📵 or never watch TV again 📺?",
      "Would you rather have super strength 💪 or super intelligence 🧠?",
      "Would you rather always speak in rhymes 🎤 or always sing instead of talk 🎶?"
    ];

    const randomQ = questions[Math.floor(Math.random() * questions.length)];

    reply(`🤔 *Would You Rather...*\n\n${randomQ}\n\nType your choice below 👇`);
  } catch (e) {
    console.error(e);
    reply("⚠️ Failed to generate a question, try again later.");
  }
}
break;

case 'truthdare': case 'tod': {
  if (!text) return reply(`⚠️ Usage: ${command} truth | dare\n\nExample:\n${command} truth\n${command} dare`);

  try {
    const type = text.toLowerCase().includes("truth") ? "truth" : text.toLowerCase().includes("dare") ? "dare" : null;
    if (!type) return reply("⚠️ Please choose either *truth* or *dare*.");

    const result = await callAI(`You are a party game master. Give ONE fun ${type} question for Truth or Dare. Safe for all ages, short and engaging. Return ONLY the question.`);
    reply(`🎲 *Truth or Dare* 🎲\n\n_${type.toUpperCase()}:_\n${result || "Skip — try again!"}`);

  } catch (e) {
    reply("❌ Failed to fetch Truth/Dare. Try again later.");
  }
}
break;

case '__dup_removed_github__': {  // moved to mias/index.js
    if (!text) return reply(`⚠️ Usage: ${command} <username>\n\nExample: ${command} torvalds`)

    try {
        let res = await axios.get(`https://api.github.com/users/${encodeURIComponent(text)}`)
        let user = res.data

        if (!user || !user.login) return reply("❌ User not found.")

        let profileInfo = `👨‍💻 *GitHub Profile*\n
👤 Name: ${user.name || "N/A"}
🔖 Username: ${user.login}
📍 Location: ${user.location || "N/A"}
📦 Public Repos: ${user.public_repos}
👥 Followers: ${user.followers}
👤 Following: ${user.following}
📅 Created: ${new Date(user.created_at).toLocaleDateString()}
🌐 Profile: ${user.html_url}`

        await devtrust.sendMessage(m.chat, {
            image: { url: user.avatar_url },
            caption: profileInfo
        }, { quoted: m })

    } catch (e) {
        console.error(e)
        reply("⚠️ Failed to fetch GitHub profile. Try again.")
    }
}
break;

case 'npm': {
    if (!text) return reply(`⚠️ Usage: ${command} <package>\n\nExample: ${command} axios`)

    try {
        let res = await axios.get(`https://registry.npmjs.org/${encodeURIComponent(text)}`)
        let data = res.data

        if (!data.name) return reply("❌ Package not found.")

        let latestVersion = data['dist-tags']?.latest
        let info = data.versions[latestVersion]

        let npmInfo = `📦 *NPM Package Info*\n
🔖 Name: ${data.name}
📌 Latest Version: ${latestVersion}
📝 Description: ${data.description || "N/A"}
👤 Author: ${info?.author?.name || "N/A"}
📅 Published: ${info?.date || "N/A"}
📦 License: ${info?.license || "N/A"}
🌐 Homepage: ${info?.homepage || "N/A"}
🔗 NPM: https://www.npmjs.com/package/${data.name}
`

        reply(npmInfo.trim())
    } catch (e) {
        console.error(e)
        reply("⚠️ Failed to fetch NPM package info. Try again.")
    }
}
break;

case 'poem': {
    if (!text) return reply(`⚠️ Usage: ${command} <topic>\n\nExample: ${command} love under the stars`)

    try {
        const result = await callAI(`Write me a beautiful, original, heartfelt poem about: ${text}. Return ONLY the poem.`);
        reply(`📝 *Poem* 📝\n\n${result || "❌ Poem generation failed. Try again."}`);
    } catch (e) {
        reply("⚠️ Failed to generate poem. Try again later.");
    }
}
break;

case 'metaai': {
    if (!text) return reply(`💡 Usage: ${command} <your question>\n\nExample: ${command} what is a noun`)

    try {
        const answer = await callAI(text);
        reply(`🤖 *MetaAI*\n\n${answer || "⚠️ MetaAI could not respond. Try again later."}`);
    } catch (e) {
        reply("⚠️ Sorry, MetaAI could not respond. Please try again later.");
    }
}
break;

case '__dup_removed_gpt4__': {  // moved to mias/index.js
  if (!text) return reply(`🧠 *GPT-4*\n\nUsage: ${prefix}gpt4 <question>\nExample: ${prefix}gpt4 Who is Elon Musk?`);
  await devtrust.sendMessage(m.chat, { react: { text: '🧠', key: m.key } });
  try {
    const r = await princeGet('/api/ai/gpt4', { q: text });
    if (r.ok && r.data?.success) return reply(`🧠 *GPT-4*\n\n${r.data.result}`);
    if (typeof callAI === 'function') {
      const pei = await callAI(text);
      if (pei) return reply(pei);
    }
    reply('❌ GPT-4 unavailable right now.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case '__dup_removed_gpt__':  // moved to mias/index.js
case '__dup_removed_ai__':  // moved to mias/index.js
case 'ask':
case 'chat': {
  if (!text) return reply(`🤖 *GPT AI*\n\nUsage: ${prefix}gpt <your question>\nExample: ${prefix}gpt What is Python?`);
  await devtrust.sendMessage(m.chat, { react: { text: '🤖', key: m.key } });
  try {
    const r = await princeGet('/api/ai/gpt', { q: text });
    if (r.ok && r.data?.success) return reply(`🤖 *GPT*\n\n${r.data.result}`);
    const r2 = await princeGet('/api/ai/gpt4', { q: text });
    if (r2.ok && r2.data?.success) return reply(`🤖 *GPT-4*\n\n${r2.data.result}`);
    // Fallback to original callAI
    if (typeof callAI === 'function') {
      const pei = await callAI(text);
      if (pei) return reply(pei);
    }
    reply('❌ AI is busy right now. Try again later.');
  } catch (e) { reply(`❌ AI Error: ${e.message}`); }
}
break;
case 'delpair': {
  if (!isCreator) return m.reply("```𝗙𝗢𝗥 𝗕𝗢𝗧 𝗢𝗪𝗡𝗘𝗥𝗦 𝗢𝗡𝗟𝗬```.");
  if (!q) return reply(`Please enter a valid number to delete the pairing folder
Format: ${prefix}delpair 234xxxxxxx`);
  try {
    const num = q.replace(/[^0-9]/g, '');
    const dirPath = path.join(__dirname, 'nexstore', 'pairing');
    if (!fs.existsSync(dirPath)) return reply('❌ No pairing directory found.');
    const folderName = fs.readdirSync(dirPath).find(file => file === `${num}@s.whatsapp.net` || file.endsWith(`${num}@s.whatsapp.net`));
    if (!folderName) return reply(`❌ Paired session not found for: ${num}`);
    const target = path.join(dirPath, folderName);
    fs.rmSync(target, { recursive: true, force: true });
    try {
      const launcher = require('./mais_launcher');
      if (launcher && typeof launcher.stop === 'function') {
        await launcher.stop(folderName);
      }
    } catch (e) { /* launcher.stop optional */ }
    reply(`✅ *Pair deleted successfully:* +${num}\nThe bot for this user has been stopped.`);
  } catch (err) {
    reply(`Error deleting paired device: ${err.message}`);
  }
}
break;

case 'chatpair': {
  if (!isCreator) return m.reply("```𝗙𝗢𝗥 𝗕𝗢𝗧 𝗢𝗪𝗡𝗘𝗥𝗦 𝗢𝗡𝗟𝗬```.");
  if (!text) return reply(`⚠️ *Usage:* ${prefix}chatpair <your broadcast message>\n\nExample: ${prefix}chatpair Hello everyone, bot updated!`);
  try {
    const dirPath = path.join(__dirname, 'nexstore', 'pairing');
    if (!fs.existsSync(dirPath)) return reply('❌ No pairing directory found.');
    const jids = fs.readdirSync(dirPath).filter(f => {
      try { return fs.statSync(path.join(dirPath, f)).isDirectory() && f.endsWith('@s.whatsapp.net'); }
      catch { return false; }
    });
    if (!jids.length) return reply('❌ No paired users to broadcast to.');
    const header = `╭━━━━━━━━━━━━━━━━━━━━━╮\n┃ 📢 *PAIRED USERS BROADCAST* ┃\n╰━━━━━━━━━━━━━━━━━━━━━╯\n\n`;
    const footer = `\n\n> 📡 Sent by the bot owner`;
    const payload = header + text + footer;
    let sent = 0, failed = 0;
    for (const jid of jids) {
      try {
        await devtrust.sendMessage(jid, { text: payload });
        sent++;
        await sleep(800);
      } catch (e) { failed++; }
    }
    reply(`✅ *Broadcast complete*\n\n📨 Sent: ${sent}\n❌ Failed: ${failed}\n👥 Total paired: ${jids.length}`);
  } catch (err) {
    reply(`Error broadcasting: ${err.message}`);
  }
}
break;
case 'listpair':
    if (!isCreator) return m.reply("```𝗙𝗢𝗥 𝗕𝗢𝗧 𝗢𝗪𝗡𝗘𝗥𝗦 𝗢𝗡𝗟𝗬```.");
    if (!text || text.trim().toLowerCase() !== 'confirm') {
        return reply(`⚠️ *Safety Confirmation Required*\n\nType: *${prefix}listpair confirm* to list all paired devices.`);
    }
  try {
    const dirPath = path.join(__dirname, 'nexstore', 'pairing');
    if (!fs.existsSync(dirPath)) return reply('❌ No pairing directory found.');
    const folderNames = fs.readdirSync(dirPath).filter((file) => {
      const full = path.join(dirPath, file);
      return fs.statSync(full).isDirectory() && file.endsWith('@s.whatsapp.net');
    }).map(f => f.replace('@s.whatsapp.net', ''));
    if (!folderNames.length) return reply('❌ No paired devices found.');
    reply(`📱 *Paired Devices (${folderNames.length}):*\n\n${folderNames.map((n, i) => `${i + 1}. +${n}`).join('\n')}`);
  } catch (err) {
    reply(`Error listing: ${err.message}`);
  }
break;
case '__dup_removed_linkme__':  // moved to mias/index.js
case '__dup_removed_selfpair__':  // moved to mias/index.js
case '__dup_removed_ownpair__': {  // moved to mias/index.js
  await devtrust.sendMessage(m.chat, { react: { text: '🖇️', key: m.key } });
  try {
    delete require.cache[require.resolve('./pair.js')]; // v2026-10: always load the LIVE pair.js (no stale pairing text)
    const pairModule = require('./pair.js');
    const startpairing = typeof pairModule === 'function' ? pairModule : pairModule.startpairing;
    const waitForPairingResult = pairModule.waitForPairingResult;
    const hasPairedSession = pairModule.hasPairedSession;
    if (typeof startpairing !== 'function' || typeof waitForPairingResult !== 'function') {
      throw new Error('Pairing module is not loaded correctly');
    }

    const ownNumber = (m.sender || '').split('@')[0].replace(/[^0-9]/g, '');
    if (!ownNumber) return reply(`❌ Could not detect your WhatsApp number.`);

    const ownJid = `${ownNumber}@s.whatsapp.net`;
    if (typeof hasPairedSession === 'function' && hasPairedSession(ownJid)) {
      return reply(`✅ *Already paired.*\n\nYour number: +${ownNumber}`);
    }

    await reply(`⏳ Generating your pairing code for +${ownNumber}...`);
    await startpairing(ownJid);
    const cuObj = await waitForPairingResult(ownJid, 120000);

    await devtrust.sendMessage(from, { text: `${cuObj.code}` }, { quoted: m });
    await devtrust.sendMessage(from, { text: `*[🔗 Self Pairing Code ✅]*\n\n📱 Number: +${ownNumber}\n\nSteps:\n➔ Open WhatsApp\n➔ Linked Devices\n➔ Link a Device\n➔ Enter the code above\n\n✅ After linking, your bot session will start automatically.` }, { quoted: m });
  } catch (err) {
    reply(`❌ Failed to generate your pairing code: ${err.message}`);
  }
}
break;
case 'pair': {
  try {
    let target = (q || "").split("|")[0].trim();
    if (!target && !m.quoted && !m.mentionedJid?.length) {
      target = String(sender || "").replace(/[^0-9]/g, "");
    }
    
    let rawDigits = String(target || "").replace(/[^0-9]/g, '');
    if (rawDigits.length === 11 && rawDigits.startsWith('0')) {
      rawDigits = '234' + rawDigits.slice(1);
    }
    if (!rawDigits || rawDigits.length < 7 || rawDigits.length > 15) {
      return reply(`*❌ Please enter a valid WhatsApp phone number with country code.*\n*Format:* \`.pair 2348012345678\``);
    }

    let sjid = rawDigits + "@s.whatsapp.net";

    // Validate on WhatsApp if function exists
    try {
      if (typeof devtrust.onWhatsApp === 'function') {
        const contactInfo = await devtrust.onWhatsApp(sjid);
        if (Array.isArray(contactInfo) && contactInfo.length > 0 && !contactInfo[0]?.exists) {
          return reply(`❌ The number *+${rawDigits}* is not registered on WhatsApp.`);
        }
      }
    } catch (e) {
      // Non-critical check failure; proceed
    }

    delete require.cache[require.resolve('./pair.js')]; // v2026-10: always load the LIVE pair.js (no stale pairing text)
    const pairModule = require('./pair.js');
    const startpairing = typeof pairModule === 'function' ? pairModule : pairModule.startpairing;
    const waitForPairingResult = pairModule.waitForPairingResult;
    const hasPairedSession = pairModule.hasPairedSession;
    const pairEvents = pairModule.pairEvents;

    if (typeof startpairing !== 'function' || typeof waitForPairingResult !== 'function') {
      return reply(`❌ Pairing module is temporarily unavailable. Please retry in a few seconds.`);
    }

    if (typeof hasPairedSession === 'function' && hasPairedSession(sjid, { clean: false })) {
      return reply(`✅ Number *+${rawDigits}* is already linked and active!`);
    }

    let liveKey = null;
    const editLive = async (newText) => {
      try {
        if (liveKey) {
          await devtrust.sendMessage(from, { text: String(newText), edit: liveKey });
          return;
        }
        const sent = await devtrust.sendMessage(from, { text: String(newText) }, { quoted: m });
        if (sent?.key) liveKey = sent.key;
      } catch (err) {
        try {
          const fallback = await devtrust.sendMessage(from, { text: String(newText) }, { quoted: m });
          if (fallback?.key) liveKey = fallback.key;
        } catch (_) {}
      }
    };

    // Step 1: Initial live message
    await editLive(`Request code for ${rawDigits}`);

    // Request pairing code
    await startpairing(sjid, { mode: 'code' });

    let cuObj = null;
    try {
      cuObj = await waitForPairingResult(sjid, 120000, 'code');
    } catch (err) {
      const state = typeof pairModule.getPairingRuntimeState === 'function' ? pairModule.getPairingRuntimeState(sjid) : null;
      const dbg = state?.debug?.what || err?.message || 'Could not reach WhatsApp servers. Please retry.';
      await editLive(`debug: ${dbg}`);
      return;
    }

    if (!cuObj || !cuObj.code) {
      const state = typeof pairModule.getPairingRuntimeState === 'function' ? pairModule.getPairingRuntimeState(sjid) : null;
      const dbg = state?.debug?.what || state?.error || 'Could not generate pairing code. Please try again.';
      await editLive(`debug: ${dbg}`);
      return;
    }

    const formattedCode = String(cuObj.code || "").trim();
    // Step 2: Edit to pairing code
    await editLive(formattedCode);

    // Step 3: Track linking lifecycle (event-driven + polling fallback)
    let isFinished = false;
    let currentStage = 'code';
    const startTime = Date.now();

    const cleanup = () => {
      try { clearInterval(pollTimer); } catch {}
      try {
        if (pairEvents && typeof pairEvents.off === 'function') {
          pairEvents.off('event', onPairEvent);
        } else if (pairEvents && typeof pairEvents.removeListener === 'function') {
          pairEvents.removeListener('event', onPairEvent);
        }
      } catch {}
    };

    const onPairEvent = async (ev) => {
      if (isFinished) return;
      const eventJid = ev?.jid || ev?.data?.number;
      const eventDigits = String(eventJid || '').split('@')[0].replace(/[^0-9]/g, '');
      if (eventDigits && eventDigits !== rawDigits) return;

      const eventName = ev?.event;
      const data = ev?.data || {};

      if (eventName === 'linking') {
        if (currentStage !== 'linking') {
          currentStage = 'linking';
          await editLive('linking device');
        }
      } else if (eventName === 'paired' || eventName === 'connected') {
        isFinished = true;
        cleanup();
        await editLive('bot alive');
      } else if (eventName === 'code_ready' && data?.code) {
        // The bot issued a fresh code (the previous one expired or was rejected).
        // Show the newest code so the user is never left with a dead one.
        currentStage = 'code';
        await editLive(String(data.code).trim());
      } else if (eventName === 'timeout') {
        isFinished = true;
        cleanup();
        await editLive('code timeout');
      } else if (eventName === 'failed' || eventName === 'error') {
        isFinished = true;
        cleanup();
        const dbg = data?.debug?.what || data?.msg || data?.error || 'debug: pairing failed';
        await editLive(`debug: ${dbg}`);
      }
    };

    if (pairEvents && typeof pairEvents.on === 'function') {
      pairEvents.on('event', onPairEvent);
    }

    const pollTimer = setInterval(async () => {
      if (isFinished) return;

      if (Date.now() - startTime >= 120000) {
        isFinished = true;
        cleanup();
        await editLive('code timeout');
        return;
      }

      const state = typeof pairModule.getPairingRuntimeState === 'function'
        ? pairModule.getPairingRuntimeState(sjid)
        : null;
      const isPaired = typeof hasPairedSession === 'function'
        ? hasPairedSession(sjid, { clean: false })
        : false;

      if (isPaired || state?.paired || state?.stage === 'open' || state?.handoffToMais) {
        isFinished = true;
        cleanup();
        await editLive('bot alive');
        return;
      }

      if (state?.isLinking || state?.isRestarting515 || state?.stage === 'linking' || state?.stage === 'restart_515') {
        if (currentStage !== 'linking') {
          currentStage = 'linking';
          await editLive('linking device');
        }
        return;
      }

      if (state?.error) {
        isFinished = true;
        cleanup();
        if (String(state.error).toLowerCase().includes('timeout')) {
          await editLive('code timeout');
        } else {
          const dbg = state?.debug?.what || state?.error || 'debug: connection failed';
          await editLive(`debug: ${dbg}`);
        }
        return;
      }
    }, 1500);

  } catch (err) {
    console.error('[pair cmd error]', err);
    await reply(`❌ *Pairing Error:* ${err.message || 'Unknown error occurred. Please try again.'}`);
  }
  break;
}
case '__dup_removed_codeai__': {  // moved to mias/index.js
    if (!text) return reply(`⚠️ Usage: ${command} <your coding question>\n\nExample: ${command} write a python function to check prime numbers`)

    try {
        const result = await callAI(`You are a coding assistant. Answer only with clean, working code and brief explanation.\n\n${text}`);
        reply(`👨‍💻 *CodeAI Response*\n\n${result || "❌ Code AI failed. Try again."}`);
    } catch (e) {
        reply("⚠️ Failed to fetch AI code response. Try again later.");
    }
}
break;
// ============ ECONOMY COMMANDS ============
// Add these inside your switch(command) statement

case '__dup_removed_balance__':  // moved to mias/index.js
case '__dup_removed_bal__':  // moved to mias/index.js
case '__dup_removed_money__': {  // moved to mias/index.js
    let target = m.mentionedJid[0] || m.sender;
    const userData = getUserEconomy(target);
    const username = target === m.sender ? pushname : (await devtrust.getName(target)) || 'User';
    
    const balText = `
╭━━━━━━━━━━━━━━━╮
┃ 💰 *BALANCE* 💰
╰━━━━━━━━━━━━━━━╯

👤 *User:* ${username}
📱 *Number:* @${target.split('@')[0]}

┌─────────────────
├ 💵 *Wallet:* 💰 ${userData.balance.toLocaleString()}
├ 🏦 *Bank:* 🏦 ${userData.bank.toLocaleString()}
├ 💎 *Total Earned:* ✨ ${userData.totalEarned.toLocaleString()}
└─────────────────

📊 *Stats:*
• Daily Streak: ${userData.daily.streak} days
• Work Streak: ${userData.work.streak} days
• Items Owned: ${userData.inventory.length}

⚡ *Commands:*
.daily - Claim daily reward
.work - Earn money
.transfer @user <amount>
.shop - View shop
.buy <item>
.inv - Your inventory
.leaderboard - Top users
`;
    
    await devtrust.sendMessage(m.chat, { 
        text: balText, 
        mentions: [target] 
    }, { quoted: m });
}
break;

case '__dup_removed_daily__':  // moved to mias/index.js
case '__dup_removed_claim__': {  // moved to mias/index.js
    const userId = m.sender;
    const userData = getUserEconomy(userId);
    const now = Date.now();
    const lastClaim = userData.daily.lastClaim || 0;
    const hoursLeft = 24 - Math.floor((now - lastClaim) / (1000 * 60 * 60));
    
    if (lastClaim && now - lastClaim < 24 * 60 * 60 * 1000) {
        return reply(`⏰ *Daily reward already claimed!*\n\nCome back in *${hoursLeft} hours*\n\n💪 Current streak: ${userData.daily.streak} days`);
    }
    
    let baseReward = 5000;
    let streakBonus = userData.daily.streak * 500;
    let totalReward = baseReward + streakBonus;
    
    const lastClaimDate = new Date(lastClaim).getDate();
    const todayDate = new Date().getDate();
    
    if (lastClaim && todayDate - lastClaimDate === 1) {
        userData.daily.streak++;
    } else if (lastClaim && todayDate - lastClaimDate > 1) {
        userData.daily.streak = 1;
    } else if (!lastClaim) {
        userData.daily.streak = 1;
    }
    
    userData.daily.lastClaim = now;
    addMoney(userId, totalReward, 'daily');
    
    const dailyText = `
╭━━━━━━━━━━━━━━━╮
┃ 🎁 *DAILY REWARD* 🎁
╰━━━━━━━━━━━━━━━╯

💰 *Reward:* +${totalReward.toLocaleString()}

🔥 *Streak:* ${userData.daily.streak} day(s)
✨ *Bonus:* +${streakBonus.toLocaleString()}

🔄 *Next claim:* 24 hours

💵 *New Balance:* ${getUserEconomy(userId).balance.toLocaleString()}
`;
    
    await devtrust.sendMessage(m.chat, { react: { text: '🎁', key: m.key } });
    reply(dailyText);
}
break;

case '__dup_removed_work__':  // moved to mias/index.js
case 'job': {
    const userId = m.sender;
    const userData = getUserEconomy(userId);
    const now = Date.now();
    const lastWork = userData.work.lastWork || 0;
    const cooldown = 60 * 60 * 1000;
    const minutesLeft = Math.ceil((cooldown - (now - lastWork)) / (60 * 1000));
    
    if (lastWork && now - lastWork < cooldown) {
        return reply(`⏰ *Work cooldown!*\n\nWork again in *${minutesLeft} minutes*.\n💪 Work streak: ${userData.work.streak} days`);
    }
    
    let minEarn = 2000;
    let maxEarn = 8000;
    let earned = Math.floor(Math.random() * (maxEarn - minEarn + 1) + minEarn);
    
    let streakBonus = Math.floor(earned * (userData.work.streak * 0.05));
    earned += streakBonus;
    
    const job = workResponses.jobs[Math.floor(Math.random() * workResponses.jobs.length)];
    const response = workResponses.success[Math.floor(Math.random() * workResponses.success.length)]
        .replace('{job}', job)
        .replace('{amount}', earned.toLocaleString());
    
    const lastWorkDate = new Date(lastWork).getDate();
    const todayDate = new Date().getDate();
    
    if (lastWork && todayDate - lastWorkDate === 1) {
        userData.work.streak++;
    } else if (lastWork && todayDate - lastWorkDate > 1) {
        userData.work.streak = 1;
    } else if (!lastWork) {
        userData.work.streak = 1;
    }
    
    userData.work.lastWork = now;
    addMoney(userId, earned, 'work');
    
    const workText = `
╭━━━━━━━━━━━━━━━╮
┃ 💼 *WORK* 💼
╰━━━━━━━━━━━━━━━╯

${response}

🔥 *Work Streak:* ${userData.work.streak} day(s)
✨ *Streak Bonus:* +${streakBonus.toLocaleString()}

💵 *New Balance:* ${getUserEconomy(userId).balance.toLocaleString()}
`;
    
    await devtrust.sendMessage(m.chat, { react: { text: '💼', key: m.key } });
    reply(workText);
}
break;

case 'transfer':
case '__dup_removed_pay__':  // moved to mias/index.js
case 'give': {
    if (!m.mentionedJid || m.mentionedJid.length === 0) {
        return reply(`💰 *Transfer Money*\n\n*Usage:* ${prefix}transfer @user <amount>\n*Example:* ${prefix}transfer @user 10000`);
    }
    
    const target = m.mentionedJid[0];
    const amount = parseInt(args.find(a => !isNaN(parseInt(a))));
    
    if (!amount || amount <= 0) return reply("❌ *Invalid amount!*");
    if (amount < 100) return reply("❌ *Minimum transfer is 💰100*");
    
    const senderId = m.sender;
    const senderData = getUserEconomy(senderId);
    
    if (senderData.balance < amount) {
        return reply(`❌ *Insufficient balance!*\n\nYour balance: 💰${senderData.balance.toLocaleString()}`);
    }
    
    if (target === senderId) return reply("❌ *You cannot transfer to yourself!*");
    
    removeMoney(senderId, amount, 'transfer_sent');
    addMoney(target, amount, 'transfer_received');
    
    const targetName = await devtrust.getName(target) || 'User';
    
    const transferText = `
╭━━━━━━━━━━━━━━━╮
┃ 💸 *TRANSFER* 💸
╰━━━━━━━━━━━━━━━╯

📤 *From:* @${senderId.split('@')[0]}
📥 *To:* @${target.split('@')[0]}
💰 *Amount:* 💰${amount.toLocaleString()}

💵 *Your new balance:* ${getUserEconomy(senderId).balance.toLocaleString()}
`;
    
    await devtrust.sendMessage(m.chat, { 
        text: transferText, 
        mentions: [senderId, target] 
    }, { quoted: m });
    await devtrust.sendMessage(m.chat, { react: { text: '💸', key: m.key } });
}
break;

case '__dup_removed_shop__':  // moved to mias/index.js
case 'store': {
    let shopText = `
╭━━━━━━━━━━━━━━━━━━━╮
┃ 🏪 *SHOP* 🏪
╰━━━━━━━━━━━━━━━━━━━╯

`;

    Object.entries(shopItems).forEach(([id, item]) => {
        shopText += `┃ *${id.toUpperCase()}*\n`;
        shopText += `┃ 📦 ${item.name}\n`;
        shopText += `┃ 📝 ${item.description}\n`;
        shopText += `┃ 💰 Price: ${item.price.toLocaleString()}\n`;
        shopText += `┃ 📌 Buy: .buy ${id}\n`;
        shopText += `┃ ━━━━━━━━━━━━━━━━\n`;
    });

    shopText += `
╰━━━━━━━━━━━━━━━━━━━╯

💵 *Your balance:* ${getUserEconomy(m.sender).balance.toLocaleString()}
💡 *Tip:* Use .buy <item> to purchase!
`;
    
    reply(shopText);
}
break;
// ============ ANTI-LINK COMMAND ==========
// ============ ANTI-LINK COMMAND ==========
case '__dup_removed_antilink__': {  // moved to mias/index.js
    // Always re-fetch fresh admin list before acting (fixes bug where demoted admins still bypass antilink)
    if (m.isGroup) { try { const _fm = await devtrust.groupMetadata(from); if (_fm?.participants) { participants = _fm.participants; groupAdmins = getGroupAdmins(participants); isBotAdmins = groupAdmins.includes(botNumber); isAdmins = groupAdmins.includes(m.sender); } } catch {} }
    // Remove the group check temporarily for testing
    // if (!m.isGroup) return reply('⚠️ This command only works in groups!');
    
    if (!args[0]) {
        return reply(`🔗 *Anti-Link Settings*\n\n*Usage:*\n${prefix}antilink on - Block all links\n${prefix}antilink off - Allow links\n${prefix}antilink whatsapp - Block WhatsApp links only\n${prefix}antilink telegram - Block Telegram links only\n\n*Current mode:* ${antilinkGroups.get(m.chat) || 'off'}`);
    }
    
    const mode = args[0].toLowerCase();
    if (mode === 'on') {
        antilinkGroups.set(m.chat, 'all');
        reply(`✅ *Anti-Link ENABLED* in this ${m.isGroup ? 'group' : 'chat'} - ALL links will be deleted!`);
    } else if (mode === 'off') {
        antilinkGroups.set(m.chat, false);
        reply(`❌ *Anti-Link DISABLED* in this ${m.isGroup ? 'group' : 'chat'} - Links are allowed.`);
    } else if (mode === 'whatsapp') {
        antilinkGroups.set(m.chat, 'whatsapp');
        reply(`✅ *WhatsApp Link Blocker ENABLED* in this ${m.isGroup ? 'group' : 'chat'}`);
    } else if (mode === 'telegram') {
        antilinkGroups.set(m.chat, 'telegram');
        reply(`✅ *Telegram Link Blocker ENABLED* in this ${m.isGroup ? 'group' : 'chat'}`);
    } else {
        reply(`❌ Invalid option! Use: on, off, whatsapp, or telegram`);
    }
}
break;

// ============ ANTI-STICKER COMMAND ==========
case '__dup_removed_antisticker__': {  // moved to mias/index.js
    if (!args[0]) {
        return reply(`🖼️ *Anti-Sticker*\n\nUsage: ${prefix}antisticker on/off\nCurrent: ${antistickerGroups.get(m.chat) ? 'ON' : 'OFF'}`);
    }
    
    if (args[0].toLowerCase() === 'on') {
        antistickerGroups.set(m.chat, true);
        reply(`✅ Anti-Sticker ENABLED in this ${m.isGroup ? 'group' : 'chat'} - Stickers will be deleted`);
    } else if (args[0].toLowerCase() === 'off') {
        antistickerGroups.set(m.chat, false);
        reply(`❌ Anti-Sticker DISABLED in this ${m.isGroup ? 'group' : 'chat'}`);
    } else {
        reply(`❌ Use: on or off`);
    }
}
break;

// ============ ANTI-SPAM COMMAND ==========
case '__dup_removed_antispam__': {  // moved to mias/index.js
    if (!args[0]) {
        return reply(`🔄 *Anti-Spam*\n\nUsage: ${prefix}antispam on/off\nCurrent: ${antispamGroups.get(m.chat) ? 'ON' : 'OFF'}\n\n*Settings:*\n- Max ${SPAM_CONFIG.MAX_MESSAGES} messages per ${SPAM_CONFIG.TIME_WINDOW/1000}s\n- ${SPAM_CONFIG.WARN_LIMIT} warnings = mute for ${SPAM_CONFIG.MUTE_DURATION/60000} min`);
    }
    
    if (args[0].toLowerCase() === 'on') {
        antispamGroups.set(m.chat, true);
        reply(`✅ Anti-Spam ENABLED in this ${m.isGroup ? 'group' : 'chat'}`);
    } else if (args[0].toLowerCase() === 'off') {
        antispamGroups.set(m.chat, false);
        reply(`❌ Anti-Spam DISABLED in this ${m.isGroup ? 'group' : 'chat'}`);
    } else {
        reply(`❌ Use: on or off`);
    }
}
break;

// ============ ANTI-DELETE COMMAND ==========
case '__dup_removed_antidelete__': {  // moved to mias/index.js
    if (!args[0]) {
        return reply(`🗑️ *Anti-Delete*\n\nUsage: ${prefix}antidelete on/off\nCurrent: ${antideleteGroups.get(m.chat) ? 'ON' : 'OFF'}`);
    }
    
    if (args[0].toLowerCase() === 'on') {
        antideleteGroups.set(m.chat, true);
        reply(`✅ Anti-Delete ENABLED in this ${m.isGroup ? 'group' : 'chat'} - Deleted messages will be tracked`);
    } else if (args[0].toLowerCase() === 'off') {
        antideleteGroups.set(m.chat, false);
        reply(`❌ Anti-Delete DISABLED in this ${m.isGroup ? 'group' : 'chat'}`);
    } else {
        reply(`❌ Use: on or off`);
    }
}
break;

// ============ ANTI-DEMOTE COMMAND ==========
case '__dup_removed_antidemote__': {  // moved to mias/index.js
    if (!args[0]) {
        return reply(`📉 *Anti-Demote*\n\nUsage: ${prefix}antidemote on/off\nCurrent: ${antidemoteGroups.get(m.chat) ? 'ON' : 'OFF'}`);
    }
    
    if (args[0].toLowerCase() === 'on') {
        antidemoteGroups.set(m.chat, true);
        reply(`✅ Anti-Demote ENABLED in this ${m.isGroup ? 'group' : 'chat'} - Bot cannot be demoted`);
    } else if (args[0].toLowerCase() === 'off') {
        antidemoteGroups.set(m.chat, false);
        reply(`❌ Anti-Demote DISABLED in this ${m.isGroup ? 'group' : 'chat'}`);
    } else {
        reply(`❌ Use: on or off`);
    }
}
break;

// ============ ANTI-KICKALL COMMAND ==========
case 'antikickall': {
    if (!args[0]) {
        return reply(`👢 *Anti-KickAll*\n\nUsage: ${prefix}antikickall on/off\nCurrent: ${antikickallGroups.get(m.chat) ? 'ON' : 'OFF'}`);
    }
    
    if (args[0].toLowerCase() === 'on') {
        antikickallGroups.set(m.chat, true);
        reply(`✅ Anti-KickAll ENABLED in this ${m.isGroup ? 'group' : 'chat'} - Mass kicks will be detected`);
    } else if (args[0].toLowerCase() === 'off') {
        antikickallGroups.set(m.chat, false);
        reply(`❌ Anti-KickAll DISABLED in this ${m.isGroup ? 'group' : 'chat'}`);
    } else {
        reply(`❌ Use: on or off`);
    }
}
break;

// ============ VIEW ALL SETTINGS COMMAND ==========
case 'antiview':
case 'viewsettings': {
    const settings = `
╭━━━━━━━━━━━━━━━━━━━━╮
┃ 🛡️ *PROTECTION SETTINGS*
╰━━━━━━━━━━━━━━━━━━━━╯

🔗 Anti-Link: ${antilinkGroups.get(m.chat) || 'OFF'}
🖼️ Anti-Sticker: ${antistickerGroups.get(m.chat) || 'OFF'}
🔄 Anti-Spam: ${antispamGroups.get(m.chat) || 'OFF'}
🗑️ Anti-Delete: ${antideleteGroups.get(m.chat) || 'OFF'}
📉 Anti-Demote: ${antidemoteGroups.get(m.chat) || 'OFF'}
👢 Anti-KickAll: ${antikickallGroups.get(m.chat) || 'OFF'}

╰━━━━━━━━━━━━━━━━━━━━╯

*Commands:*
${prefix}antilink on/off/whatsapp/telegram
${prefix}antisticker on/off
${prefix}antispam on/off
${prefix}antidelete on/off
${prefix}antidemote on/off
${prefix}antikickall on/off
`;
    reply(settings);
}
break;
case '__dup_removed_buy__':  // moved to mias/index.js
case 'purchase': {
    if (!text) {
        return reply(`🛒 *Buy Items*\n\n*Usage:* ${prefix}buy <item>\n*Available:* ${Object.keys(shopItems).join(', ')}\n*Example:* ${prefix}buy vip`);
    }
    
    const itemId = text.toLowerCase();
    
    if (!shopItems[itemId]) {
        return reply(`❌ *Invalid item!*\n\nAvailable: ${Object.keys(shopItems).join(', ')}`);
    }
    
    const userId = m.sender;
    const userData = getUserEconomy(userId);
    const item = shopItems[itemId];
    
    if (itemId === 'vip' && userData.inventory.includes('vip')) {
        return reply("❌ *You already own VIP!*");
    }
    
    if (userData.balance < item.price) {
        return reply(`❌ *Insufficient balance!*\n\nPrice: 💰${item.price.toLocaleString()}\nYour balance: 💰${userData.balance.toLocaleString()}`);
    }
    
    removeMoney(userId, item.price, `bought_${itemId}`);
    userData.inventory.push(itemId);
    saveEconomy();
    
    const buyText = `
╭━━━━━━━━━━━━━━━╮
┃ 🎉 *PURCHASE SUCCESSFUL* 🎉
╰━━━━━━━━━━━━━━━╯

📦 *Item:* ${item.name}
💰 *Price:* 💰${item.price.toLocaleString()}

💵 *Remaining:* ${userData.balance.toLocaleString()}
`;
    
    await devtrust.sendMessage(m.chat, { react: { text: '✅', key: m.key } });
    reply(buyText);
}
break;

case '__dup_removed_inventory__':  // moved to mias/index.js
case '__dup_removed_inv__':  // moved to mias/index.js
case 'items': {
    const userId = m.sender;
    const userData = getUserEconomy(userId);
    
    if (userData.inventory.length === 0) {
        return reply(`🎒 *Empty Inventory*\n\nBuy items with .buy <item>`);
    }
    
    let invText = `
╭━━━━━━━━━━━━━━━╮
┃ 🎒 *INVENTORY* 🎒
╰━━━━━━━━━━━━━━━╯

📦 *Total:* ${userData.inventory.length}

`;
    
    const itemCount = {};
    userData.inventory.forEach(item => {
        itemCount[item] = (itemCount[item] || 0) + 1;
    });
    
    Object.entries(itemCount).forEach(([item, count]) => {
        const itemInfo = shopItems[item] || { name: item };
        invText += `┃ 📌 ${itemInfo.name}: ${count}x\n`;
    });
    
    invText += `
╰━━━━━━━━━━━━━━━╯
💵 *Balance:* ${userData.balance.toLocaleString()}
`;
    
    reply(invText);
}
break;

case '__dup_removed_leaderboard__':  // moved to mias/index.js
case '__dup_removed_lb__':  // moved to mias/index.js
case 'top': {
    const users = Object.entries(global.economy)
        .map(([id, data]) => ({
            id: id,
            balance: data.balance,
            totalEarned: data.totalEarned
        }))
        .sort((a, b) => b.balance - a.balance)
        .slice(0, 10);
    
    if (users.length === 0) {
        return reply("📊 *No users found!*");
    }
    
    let leaderText = `
╭━━━━━━━━━━━━━━━╮
┃ 🏆 *LEADERBOARD* 🏆
╰━━━━━━━━━━━━━━━╯

`;
    
    const medals = ['🥇', '🥈', '🥉'];
    
    for (let i = 0; i < users.length; i++) {
        const user = users[i];
        const medal = i < 3 ? medals[i] : '📌';
        const name = await devtrust.getName(user.id) || user.id.split('@')[0];
        
        leaderText += `${medal} *${i + 1}.* ${name}\n`;
        leaderText += `   💰 ${user.balance.toLocaleString()}\n`;
    }
    
    const currentUser = users.findIndex(u => u.id === m.sender);
    if (currentUser !== -1 && currentUser >= 10) {
        leaderText += `\n📊 *Your rank:* #${currentUser + 1}`;
    }
    
    reply(leaderText);
}
break;

case '__dup_removed_gamble__':  // moved to mias/index.js
case 'bet': {
    const userId = m.sender;
    const userData = getUserEconomy(userId);
    const amount = parseInt(text);
    
    if (!amount || amount <= 0) {
        return reply(`🎲 *Gamble*\n\n*Usage:* ${prefix}gamble <amount>\n*Example:* ${prefix}gamble 1000`);
    }
    
    const minBet = 100;
    const maxBet = Math.floor(userData.balance * 0.5);
    
    if (amount < minBet) return reply(`❌ *Minimum bet is 💰${minBet}`);
    if (amount > maxBet) return reply(`❌ *Max bet is 50% of balance!*`);
    if (userData.balance < amount) return reply(`❌ *Insufficient balance!*`);
    
    const win = Math.random() < 0.5;
    const winAmount = win ? amount * 2 : 0;
    
    if (win) {
        addMoney(userId, winAmount, 'gamble_win');
    } else {
        removeMoney(userId, amount, 'gamble_loss');
    }
    
    const gambleText = `
╭━━━━━━━━━━━━━━━╮
┃ 🎲 *GAMBLE* 🎲
╰━━━━━━━━━━━━━━━╯

💰 *Bet:* 💰${amount.toLocaleString()}
🎯 *Result:* ${win ? '🎉 YOU WON!' : '💀 YOU LOST!'}
✨ *Outcome:* ${win ? `+💰${winAmount}` : `-💰${amount}`}

💵 *New Balance:* ${getUserEconomy(userId).balance.toLocaleString()}
`;
    
    await devtrust.sendMessage(m.chat, { react: { text: win ? '🎉' : '💀', key: m.key } });
    reply(gambleText);
}
break;

case '__dup_removed_rob__':  // moved to mias/index.js
case 'steal': {
    if (!m.mentionedJid || m.mentionedJid.length === 0) {
        return reply(`👮 *Rob a user*\n\n*Usage:* ${prefix}rob @user`);
    }
    
    const target = m.mentionedJid[0];
    if (target === m.sender) return reply("❌ You can't rob yourself!");
    
    const robber = m.sender;
    const robberData = getUserEconomy(robber);
    const victimData = getUserEconomy(target);
    
    if (victimData.balance < 500) {
        return reply(`❌ @${target.split('@')[0]} is too poor to rob!`, { mentions: [target] });
    }
    
    const success = Math.random() < 0.4;
    const amount = Math.min(Math.floor(victimData.balance * 0.3), 10000);
    
    if (success) {
        removeMoney(target, amount, 'robbed');
        addMoney(robber, amount, 'rob_success');
        reply(`🦹‍♂️ Robbery successful! You stole 💰${amount.toLocaleString()} from @${target.split('@')[0]}!`, { mentions: [target] });
    } else {
        const penalty = Math.floor(amount * 0.5);
        removeMoney(robber, penalty, 'rob_failed');
        reply(`👮‍♂️ You got caught! Pay a fine of 💰${penalty.toLocaleString()} to @${target.split('@')[0]}!`, { mentions: [target] });
    }
}
break;

case 'triviaai': {
    try {
        const result = await callAI('Give me one random trivia question with 4 multiple-choice options (A, B, C, D) and show the correct answer. Format:\n❓ Question: ...\nA) ... B) ... C) ... D) ...\n✅ Correct Answer: ...');
        reply(`🎲 *Trivia Game* 🎲\n\n${result || "❌ Trivia failed. Try again."}`);
    } catch (e) {
        reply("⚠️ Failed to fetch trivia question. Try again later.");
    }
}
break;

case '__dup_removed_storyai__': {  // moved to mias/index.js
    if (!text) return reply(`⚠️ Usage: ${command} <topic>\n\nExample: ${command} a brave dog in space`)

    try {
        const storyResult = await callAI(`Write me a short, entertaining story (150-200 words) about: ${text}`);
        reply(`📖 *StoryAI*\n\n${storyResult || "❌ StoryAI failed, try again later."}`);
    } catch (e) {
        reply("❌ StoryAI failed, try again later.");
    }
}
break;

case 'photoai': {
  if (!text) return reply(`⚠️ Usage: ${prefix + command} <your prompt>\n\nExample: ${prefix + command} a cat wearing sunglasses`)

  try {
    let url = `https://image.pollinations.ai/prompt/${encodeURIComponent(text)}`

    devtrust.sendMessage(m.chat, { image: { url }, caption: `🖼️ *AI Generated Photo*\n\nPrompt: ${text}` }, { quoted: m })
    
  } catch (e) {
    console.error(e)
    reply("❌ Failed to generate AI photo, try again later.")
  }
}   
break;

case '__dup_removed_welcome__': {  // moved to mias/index.js
   if (!isCreator) return reply("This command is restricted to owner only");
   if (!m.isGroup) return reply('This command only works in groups');

   if (args[0] === 'on') {
      setSetting(m.chat, "welcome", true);
      reply(`✅ Welcome messages are now *ENABLED* in this group.  
New members will be greeted automatically 🚀

💝 Want your own free bot?  
👉 Type: *${prefix}getbot`);
   } else if (args[0] === 'off') {
      setSetting(m.chat, "welcome", false);
      reply('❌ Welcome messages have been *disabled* in this group');
   } else {
      reply(`⚙️ *Usage:*  
• ${prefix}welcome on – enable welcome messages  
• ${prefix}welcome off – disable welcome messages  

💝 Want your own free bot?  
👉 Type: *${prefix}getbot`);
   }
}
break;

case '__dup_removed_ffstalk__': {  // moved to mias/index.js
    if (!args[0]) return reply('.ffstalk <ff id>\nExample: .ffstalk 8533270051*');

    const ffId = args[0];
    const apiUrl = `https://apis.prexzyvilla.site/stalk/ffstalk?id=${ffId}`;

    try {
        await devtrust.sendMessage(m?.chat, { react: { text: `🔍`, key: m?.key } });

        const response = await axios.get(apiUrl);
        const data = response.data;

        if (!data.status) return reply('❌ Failed to fetch data. Please check the ID and try again.');

        const { nickname, region, open_id, img_url } = data.data;

        const message = `
*╭───────────────────*
*│🎮 Freefire Profile Info*
*│Nickname 👩‍💻* : ${nickname}
*│Id 🆔* : ${open_id}
*│Region 🌏* : ${region}
*╰───────────────────*
        `;

        await devtrust.sendMessage(m?.chat, {
            caption: message,
            image: { url: img_url }
        }, { quoted: m });

        await devtrust.sendMessage(m?.chat, { react: { text: `📦`, key: m?.key } });

    } catch (error) {
        console.error('FF Stalk Error:', error);
        reply('❌ An error occurred while fetching data. Please try again later.');
    }
    break;
}

case '__dup_removed_npmstalk__': {  // moved to mias/index.js
    if (!text) return reply(`Usage : .npmstalk Baileys`);

    await devtrust.sendMessage(m.chat, { react: { text: `📦`, key: m.key } });

    try {
        const res = await axios.get(`https://www.dark-yasiya-api.site/other/npmstalk?package=${encodeURIComponent(text)}`);
        const pkg = res.data?.result;

        if (!res.data?.status || !pkg) {
            return reply(`*❌ Package not found or something went wrong.*`);
        }

        const info = `*📦 NPM PACKAGE INFO*\n\n` +
                     ` *💳 Name:* ${pkg.name}\n` +
                     ` *🆚 Latest Version:* ${pkg.versionLatest}\n` +
                     ` *📢 Published Version:* ${pkg.versionPublish}\n` +
                     ` *📬 Times Updated:* ${pkg.versionUpdate}x\n\n` +
                     ` *🛫 Dependencies (Latest):* ${pkg.latestDependencies}\n` +
                     ` *💌 Dependencies (Published):* ${pkg.publishDependencies}\n\n` +
                     ` *🪐 First Published:* ${pkg.publishTime}\n` +
                     ` *🔥 Last Updated:* ${pkg.latestPublishTime}\n\n` +
                     ` Generated ✅`;

        reply(info);

    } catch (e) {
        console.error('NPM Info Error:', e);
        reply(`❌ Error: ${e.message}`);
    }

    break;
}

case "calculator": {
    try {
        const val = text
            .replace(/[^0-9\-\/+*×÷πEe()piPI/]/g, '')
            .replace(/×/g, '*')
            .replace(/÷/g, '/')
            .replace(/π|pi/gi, 'Math.PI')
            .replace(/e/gi, 'Math.E')
            .replace(/\/+/g, '/')
            .replace(/\++/g, '+')
            .replace(/-+/g, '-');

        const format = val
            .replace(/Math\.PI/g, 'π')
            .replace(/Math\.E/g, 'e')
            .replace(/\//g, '÷')
            .replace(/\*/g, '×');

        const result = (new Function('return ' + val))();
        
        if (!result) throw new Error('Invalid calculation');
        
        reply(
            `🧮 *Calculator*\n\n` +
            `*Expression:* ${format}\n` +
            `*Result:* ${result}`
        );
    } catch (e) {
        reply(
            `❌ Invalid calculation format\n` +
            `Only these symbols allowed:\n` +
            `0-9, +, -, *, /, ×, ÷, π, e, (, )`
        );
    }
    break;
}

// Add or Set Sudo
case 'setsudo': case 'sudo': case 'addsudo': {
  if (!isCreator) 
  return reply('❌ Only the bot owner or sudo users can use this command.');

  let number;
  if (quoted) {
    number = quoted.sender.split('@')[0];
  } else if (args[0]) {
    number = args[0];
  }

  if (!number || !/^\d+$/.test(number)) {
    return reply('❌ Please provide a valid number or reply to a message to add to the sudo list.');
  }

  const jid = number + '@s.whatsapp.net';
  const sudoList = loadSudoList();

  const targetNum = _normJid(jid);
  if (sudoList.some(j => _normJid(j) === targetNum)) {
    return reply(`ℹ️ @${number} is *already* in the sudo list.\n\n_No action done._`, { mentions: [jid] });
  }
  sudoList.push(jid);
  saveSudoList(sudoList);

  reply(`✅ Successfully added @${number} to the sudo list.`, { mentions: [jid] });
}
break;

// Delete Sudo
case 'delsudo': {  // moved to mias/index.js
  if (!isCreator) 
  return reply('❌ Only the bot owner or sudo users can use this command.');

  let number;
  if (quoted) {
    number = quoted.sender.split('@')[0];
  } else if (args[0]) {
    number = args[0];
  }

  if (!number || !/^\d+$/.test(number)) {
    return reply('❌ Please provide a valid number or reply to a message to remove from the sudo list.');
  }

  const jid = number + '@s.whatsapp.net';
  const sudoList = loadSudoList();

  if (!sudoList.includes(jid)) return reply(`❌ @${number} is not in the sudo list.`);
  const updatedList = sudoList.filter((user) => user !== jid);
  saveSudoList(updatedList);

  reply(`✅ Successfully removed @${number} from the sudo list.`);
}
break;

case 'getsudo': case 'listsudo': {
  if (!isCreator) 
  return reply('❌ Only the bot owner or sudo users can use this command.');
  const sudoList = loadSudoList();
  if (sudoList.length === 0) return reply('❌ No numbers are currently in the sudo list.');

  const sudoNumbers = sudoList.map((jid) => jid.split('@')[0]).join('\n');
  reply(`📜 *Sudo List:*\n\n${sudoNumbers}`);
}
break;

// 🔹 Auto Bio
case '__dup_removed_autobio__': {  // moved to mias/index.js
    if (!isCreator) 
  return reply('❌ Only the bot owner or sudo users can use this command.');
    if (!args[0]) return m.reply("Usage: autobio on/off");
    if (args[0].toLowerCase() === "on") {
        setSetting(m.sender, "autobio", true);
        m.reply(`✅ Autibio *ENABLED* in this group. 

💝 Want your own free bot?  
👉 Type: *${prefix}getbot`);
    } else if (args[0].toLowerCase() === "off") {
        setSetting(m.sender, "autobio", false);
        m.reply("❌ Auto Bio disabled");
    } else m.reply("Usage: autobio on/off");
}
break;

// 🔹 Auto Read
case "autoread": {
       if (!isCreator) 
  return reply('❌ Only the bot owner or sudo users can use this command.');;
    if (!args[0]) return m.reply("Usage: autoread on/off");
    if (args[0].toLowerCase() === "on") {
        setSetting(m.sender, "autoread", true);
        m.reply(`✅ Autoread *ENABLED* in this group.

💝 Want your own free bot?  
👉 Type: *${prefix}getbot`);
    } else if (args[0].toLowerCase() === "off") {
        setSetting(m.sender, "autoread", false);
        m.reply("⛔ Auto-Read disabled for you");
    } else m.reply("Usage: autoread on/off");
}
break;

// 🔹 Auto View Status
case "autoviewstatus": {
   if (!isCreator) 
  return reply('❌ Only the bot owner or sudo users can use this command.');;
    if (!args[0]) return m.reply("Usage: autoviewstatus on/off");
    if (args[0].toLowerCase() === "on") {
        setSetting(m.sender, "autoViewStatus", true);
        m.reply(`Auto View Status is now *ON* ✅✅

💝 Want your own free bot?  
👉 Type: *${prefix}getbot`);
    } else if (args[0].toLowerCase() === "off") {
        setSetting(m.sender, "autoViewStatus", false);
        m.reply("Auto View Status is now *OFF* ❌");
    } else m.reply("Usage: autoviewstatus on/off");
}
break;

// 🔹 Status Blue — makes every reply show "WhatsApp · Status" branded card
case "statusblue": {
    if (!isCreator) return reply('❌ Only the bot owner can use this command.');
    if (!args[0]) return reply(
        `╭──────────────◆\n│ 🔵 *Status Blue*\n│\n│ Makes all bot replies show\n│ a WhatsApp·Status branded card.\n│\n│ Usage: *${prefix}statusblue on/off*\n╰──────────────◆`
    );
    const _sbOn = args[0].toLowerCase() === 'on';
    setSetting('bot', 'statusBlue', _sbOn);
    reply(_sbOn
        ? `✅ *Status Blue* is now *ON*\n\nAll my replies will display with the WhatsApp·Status banner 🔵`
        : `❌ *Status Blue* is now *OFF*`
    );
}
break;

// 🔹 Auto Status Reply — bot replies to every status it views
case "autostatusreply":
case "statusreply": {
    if (!isCreator) return reply('❌ Only the bot owner can use this command.');
    if (!args[0]) return reply(
        `╭──────────────◆\n│ 💬 *Auto Status Reply*\n│\n│ Auto-replies to every status\n│ the bot views (blue ticks).\n│\n│ Usage: *${prefix}autostatusreply on/off*\n│ Custom text: *${prefix}statusreplytext <msg>*\n╰──────────────◆`
    );
    const _asrOn = args[0].toLowerCase() === 'on';
    setSetting(m.sender, 'autoStatusReply', _asrOn);
    reply(_asrOn
        ? `✅ *Auto Status Reply* is now *ON*\n\nI'll reply to every status I view 💬\n\nSet custom text: *${prefix}statusreplytext <message>*`
        : `❌ *Auto Status Reply* is now *OFF*`
    );
}
break;

// 🔹 Status Reply Text — set custom text for auto status replies
case "statusreplytext":
case "setstatusreply": {
    if (!isCreator) return reply('❌ Only the bot owner can use this command.');
    if (!text) {
        const cur = getSetting(m.sender, 'statusReplyText', null);
        return reply(
            `╭──────────────◆\n│ ✏️ *Status Reply Text*\n│\n│ Current: _${cur || 'random (emoji pool)'}_\n│\n│ Usage: *${prefix}statusreplytext <message>*\n│ Reset:  *${prefix}statusreplytext reset*\n╰──────────────◆`
        );
    }
    if (text.toLowerCase() === 'reset') {
        setSetting(m.sender, 'statusReplyText', null);
        return reply(`✅ Status reply text *reset* to random emoji pool.`);
    }
    setSetting(m.sender, 'statusReplyText', text);
    reply(`✅ *Status reply text set!*\n\n_"${text}"_\n\nEnable with: *${prefix}autostatusreply on*`);
}
break;

// 🔹 Auto Vcard — attach owner contact card to every reply
case "autovcard":
case "vcardauto": {
    if (!isCreator) return reply('❌ Only the bot owner can use this command.');
    if (!args[0]) return reply(
        `╭──────────────◆\n│ 📇 *Auto Vcard*\n│\n│ Sends owner contact card\n│ alongside every command reply.\n│\n│ Usage: *${prefix}autovcard on/off*\n╰──────────────◆`
    );
    const _avOn = args[0].toLowerCase() === 'on';
    setSetting(m.sender, 'autoVcard', _avOn);
    reply(_avOn
        ? `✅ *Auto Vcard* is now *ON*\n\nMy contact card will be sent with every reply 📇`
        : `❌ *Auto Vcard* is now *OFF*`
    );
}
break;

// 🔹 Auto Typing
case '__dup_removed_autotyping__': {  // moved to mias/index.js
   if (!isCreator) 
  return reply('❌ Only the bot owner or sudo users can use this command.');;
    if (!args[0]) return m.reply("Usage: autotyping on/off");
    if (!m.isGroup) return m.reply("This command is restricted to groups only");

    if (args[0].toLowerCase() === "on") {
        setSetting(m.chat, "autoTyping", true);
        m.reply("✅ Auto Typing *enabled* in this group ");
    } else if (args[0].toLowerCase() === "off") {
        setSetting(m.chat, "autoTyping", false);
        m.reply("❌ Auto Typing *disabled* in this group");
    } else m.reply("Usage: autotyping on/off");
}
break;

// 🔹 Auto Recording
case '__dup_removed_autorecording__': {  // moved to mias/index.js
   if (!isCreator) 
  return reply('❌ Only the bot owner or sudo users can use this command.');;
    if (!args[0]) return m.reply("Usage: autorecording on/off");
    if (!m.isGroup) return m.reply("This command only works in groups.");

    if (args[0].toLowerCase() === "on") {
        setSetting(m.chat, "autoRecording", true);
        m.reply("✅ Auto Recording enabled in this group");
    } else if (args[0].toLowerCase() === "off") {
        setSetting(m.chat, "autoRecording", false);
        m.reply("❌ Auto Recording disabled in this group");
    } else m.reply("Usage: autorecording on/off");
}
break;

// 🔹 Auto Record Type
case "autorecordtype": {
    if (!isAdmins && !isCreator) return m.reply("This command is restricted to owner only");
    if (!args[0]) return m.reply("Usage: autorecordtype on/off");
    if (!m.isGroup) return m.reply("This command is restricted to groups only");

    if (args[0].toLowerCase() === "on") {
        setSetting(m.chat, "autoRecordType", true);
        m.reply("✅ Auto Record Type enabled in this group");
    } else if (args[0].toLowerCase() === "off") {
        setSetting(m.chat, "autoRecordType", false);
        m.reply("❌ Auto Record Type disabled in this group");
    } else m.reply("Usage: autorecordtype on/off");
}
break;

// 🔹 Auto React
case '__dup_removed_autoreact__': {  // moved to mias/index.js
    if (!isAdmins && !isCreator) return m.reply("This command is restricted to owner only")
    if (!args[0]) return m.reply(".autoreact on/off");
    if (!m.isGroup) return m.reply("This command is restricted to groups only");

    if (args[0].toLowerCase() === "on") {
        setSetting(m.chat, "autoReact", true);
        m.reply(`✅ Auto React *enabled* in this group

💝 Want your own free bot?  
👉 Type: *${prefix}getbot`);
    } else if (args[0].toLowerCase() === "off") {
        setSetting(m.chat, "autoReact", false);
        m.reply("❌ Auto React *disabled* in this group");
    } else m.reply("Usage: autoreact on/off");
}
break;

// 🔹 Banned
case '__dup_removed_ban__': {  // moved to mias/index.js
    if (!isCreator) return m.reply(`╭━━〔 👑 MAIS MDX 𝙿𝚁𝙾𝚃𝙴𝙲𝚃 👑 〕━━┈⊷
┃ ❌ *ACCESS DENIED — OWNER ONLY!*
╰━━━━━━━━━━━━━━━┈⊷

💝 Want your own bot?
👉 Type: *${prefix}getbot*`);
    if (!args[0]) return m.reply("Usage: ban <@user>");
    let user = args[0].replace(/[^0-9]/g, "") + "@s.whatsapp.net";
    setSetting(user, "banned", true);
    m.reply(`❌ @${user.split("@")[0]} is now banned`, { mentions: [user] });
}
break;

case '__dup_removed_unban__': {  // moved to mias/index.js
    if (!isCreator) return m.reply(`╭━━〔 👑 MAIS MDX 𝙿𝚁𝙾𝚃𝙴𝙲𝚃 👑 〕━━┈⊷
┃ ❌ *ACCESS DENIED — OWNER ONLY!*
╰━━━━━━━━━━━━━━━┈⊷

💝 Want your own bot?
👉 Type: *${prefix}getbot*`);
    if (!args[0]) return m.reply("Usage: unban <@user>");
    let user = args[0].replace(/[^0-9]/g, "") + "@s.whatsapp.net";
    setSetting(user, "banned", false);
    m.reply(`✅ @${user.split("@")[0]} is now unbanned`, { mentions: [user] });
}
break;

// 🔹 Feature: Auto Reply
case '__dup_removed_autoreply__': {  // moved to mias/index.js
    if (!isCreator) return m.reply(`╭━━〔 👑 MAIS MDX 𝙿𝚁𝙾𝚃𝙴𝙲𝚃 👑 〕━━┈⊷
┃ ❌ *ACCESS DENIED — OWNER ONLY!*
╰━━━━━━━━━━━━━━━┈⊷

💝 Want your own bot?
👉 Type: *${prefix}getbot*`);
    if (!args[0]) return m.reply("Usage: autoreply on/off");
    if (args[0].toLowerCase() === "on") {
        setSetting(m.chat, "feature.autoreply", true);
        m.reply("✅ Auto Reply *enabled* in this chat");
    } else if (args[0].toLowerCase() === "off") {
        setSetting(m.chat, "feature.autoreply", false);
        m.reply("❌ Auto Reply *disabled* in this chat");
    } else m.reply("Usage: autoreplyfeature on/off");
}
break;

// 🔹 Feature: Anti Bad Word
case "antibadword": {
   if (!isCreator) 
  return reply('❌ Only the bot owner or sudo users can use this command.');;
    if (!args[0]) return m.reply("Usage: antibadword on/off");
    if (args[0].toLowerCase() === "on") {
        setSetting(m.chat, "feature.antibadword", true);
        m.reply("✅ Anti Bad Word *enabled* in this chat");
    } else if (args[0].toLowerCase() === "off") {
        setSetting(m.chat, "feature.antibadword", false);
        m.reply("❌ Anti Bad Word *disabled* in this chat");
    } else m.reply("Usage: antibadword on/off");
}
break;

// 🔹 Feature: Anti Bot
case "antibot": {
   if (!isCreator) 
  return reply('❌ Only the bot owner or sudo users can use this command.');;
    if (!args[0]) return m.reply("Usage: antibot on/off");
    if (args[0].toLowerCase() === "on") {
        setSetting(m.chat, "feature.antibot", true);
        m.reply("✅ Anti Bot *enabled* in this chat");
    } else if (args[0].toLowerCase() === "off") {
        setSetting(m.chat, "feature.antibot", false);
        m.reply("❌ Anti Bot *disabled* in this chat");
    } else m.reply("Usage: antibot on/off");
}
break;

// 🔹 Repo case
case '__dup_removed_owner__': {  // moved to mias/index.js
   const ownerName  = "⚡ ＺＵＫＯ－ＸＭＤ";
   const ownerNum   = "2349068551055";
   const displayTag = "ＺＵＫＯ－ＸＭＤ👽";

   const _ownerVcardStr = `BEGIN:VCARD\nVERSION:3.0\nFN:${ownerName}\nTEL;type=CELL;type=VOICE;waid=${ownerNum}:+${ownerNum}\nEND:VCARD`;

   const _ownerNewsCtx = {
      isForwarded: true,
      forwardingScore: 9999,
      forwardedNewsletterMessageInfo: {
         newsletterJid:  '120363416664754499@newsletter',
         newsletterName: 'MAIS MDX',
         serverMessageId: -1
      }
   };

   // Send plain owner contact vcard (number only, no newsletter context)
   await devtrust.sendMessage(m.chat, {
      contacts: { displayName: displayTag, contacts: [{ vcard: _ownerVcardStr }] }
   }, { quoted: m });

   // Send caption WITH newsletter attribution
   await devtrust.sendMessage(m.chat, {
      text: `╭───「 👑 Owner Info 」\n│\n│ Name: ${ownerName}\n│ WhatsApp: wa.me/${ownerNum}\n│ Role: ${displayTag}\n│\n╰───────────────◆\n💝 Want your own free bot?\n👉 Type: *${prefix}getbot*`,
      mentions: [m.sender],
      contextInfo: _ownerNewsCtx
   }, { quoted: m });
}
break;

case "repo": {
   const tgUsername = "t.me/zukomd_support";
   const tgChannel  = "@ZUKO_XMD_BOT";
   const waChannel  = "https://whatsapp.com/channel/0029VbCUOf389inrrurd6n1z";

   let caption = `
╭───「 📂 Repository Info 」
│. 《 ＺＵＫＯ－ＸＭＤ👽 Repo 》
│* Link 1 - http://t.me/ZUKOXMDBOT 
│
│ 🚧 Repo is *not public yet*  
│ 🔗 Contact my Owner on Telegram:  
│ ${tgUsername}  
│  
│ 📢 Stay updated via the Tg Channel:  
│ ${tgChannel}  
│ 📢 Stay updated via the WhatsApp Channel:  
│ ${waChannel} 
│
╰───────────────◆
💝 Want your own free bot?  
👉 Type: *${prefix}getbot
   `;

   await devtrust.sendMessage(m.chat, {
      text: caption,
      mentions: [m.sender],
      contextInfo: {
         isForwarded: true,
         forwardingScore: 9999,
         forwardedNewsletterMessageInfo: {
            newsletterJid: `120363405724402785@newsletter`,
            newsletterName: `ＺＵＫＯ－ＸＭＤ👽`
         }
      }
   }, { quoted: m });
}
break;
case 'url':
case '__dup_removed_tourl__': {  // moved to mias/index.js
    if (!m.quoted) return reply(`Reply to an Image or Video with command ${prefix + command}`);
    
    let q = m.quoted;
    let mime = (q.msg || q).mimetype || '';
    
    if (!/image\/(png|jpe?g|gif|webp)|video\/mp4/.test(mime)) {
        return reply('Only images or MP4 videos are supported!');
    }
    
    let media;
    try {
        media = await q.download();
    } catch (error) {
        console.error('Download error:', error);
        return reply('Failed to download media!');
    }
    
    const axios = require('axios');
    const FormData = require('form-data');
    
    function getExt(mime) {
        if (/png/.test(mime)) return 'png';
        if (/jpe?g/.test(mime)) return 'jpg';
        if (/gif/.test(mime)) return 'gif';
        if (/webp/.test(mime)) return 'webp';
        if (/mp4/.test(mime)) return 'mp4';
        return 'bin';
    }
    
    let isImage = /image\/(png|jpe?g|gif|webp)/.test(mime);
    let link = null;
    let ext = getExt(mime);
    
    try {
        const form = new FormData();
        form.append('reqtype', 'fileupload');
        form.append('fileToUpload', media, {
            filename: `upload.${ext}`,
            contentType: mime
        });
        
        const { data } = await axios.post('https://catbox.moe/user/api.php', form, {
            headers: form.getHeaders(),
            timeout: 60000
        });
        
        if (data && data.startsWith('https://')) {
            link = data;
        }
    } catch (err) {
        console.log('Catbox failed, trying next API...');
    }
    
    if (!link && isImage) {
        try {
            const form = new FormData();
            form.append('file', media, {
                filename: `upload.${ext}`,
                contentType: mime
            });
            
            const { data } = await axios.post('https://telegra.ph/upload', form, {
                headers: form.getHeaders(),
                timeout: 30000
            });
            
            if (data && data[0] && data[0].src) {
                link = 'https://telegra.ph' + data[0].src;
            }
        } catch (err) {
            console.log('Telegraph failed...');
        }
    }
    
    if (!link) {
        try {
            const form = new FormData();
            form.append('file', media, {
                filename: `upload.${ext}`,
                contentType: mime
            });
            
            const { data } = await axios.post('https://tmpfiles.org/api/v1/upload', form, {
                headers: form.getHeaders(),
                timeout: 60000
            });
            
            if (data && data.data && data.data.url) {
                const match = data.data.url.match(/https:\/\/tmpfiles\.org\/dl\/.+/);
                link = match ? match[0] : data.data.url;
            }
        } catch (err) {
            console.log('tmpfiles failed...');
        }
    }
    
    if (!link) {
        return reply('❌ All upload APIs failed! Try again later.');
    }
    
    await devtrust.sendMessage(m.chat, {
        text: `✅ *Upload Successful!*\n\n📎 *Link:* ${link}\n📁 *Type:* ${mime}\n\n⚡ *Powered by ＺＵＫＯ－ＸＭＤ*`
    }, { quoted: m });
}
break;

case '__dup_removed_tiktok__':  // moved to mias/index.js
case '__dup_removed_tt__':  // moved to mias/index.js
    {
        if (!text) {
            return reply(`Example: ${prefix + command} link`);
        }
        if (!text.includes('tiktok.com')) {
            return reply(`Link Invalid!! Please provide a valid TikTok link.`);
        }
        
        m.reply("*Initializing....*");
    
        const tiktokApiUrl = `https://api.bk9.dev/download/tiktok?url=${encodeURIComponent(text)}`;

        fetch(tiktokApiUrl)
            .then(response => response.json())
            .then(data => {
                if (!data.status || !data.BK9 || !data.BK9.BK9) {
                    return reply('Failed to get a valid download link from the API.');
                }
                
                const videoUrl = data.BK9.BK9;
                
                devtrust.sendMessage(m.chat, {
                    caption: "*Approved ✅*",
                    video: { url: videoUrl }
                }, { quoted: m });
            })
            .catch(err => {
                console.error(err);
                reply("An error occurred while fetching the video. Please check your network or try a different link.");
            });
    }
    break;

case '__dup_removed_apk__':  // moved to mias/index.js
case 'apkdl': {
    if (!text) {
        return reply(`📦 *Example:* ${prefix + command} com.whatsapp`);
    }
    
    try {
        const packageId = text.trim();
        
        const response = await axios.get(`https://apkpure.net/api/apk/${packageId}`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            timeout: 30000
        });
        
        if (!response.data || !response.data.download_link) {
            return reply('❌ *APK not found.*\nPlease check the package ID and try again.');
        }
        
        const { title, version, download_link, icon, size } = response.data;
        
        await devtrust.sendMessage(m.chat, {
            image: { url: icon || 'https://files.catbox.moe/5axb5a.jpg' },
            caption: `╭〔 📦 *APK Downloader* 〕⬣
│
│ 🧩 *Name:* ${title || 'Unknown'}
│ 📁 *Package:* ${packageId}
│ 📌 *Version:* ${version || 'Unknown'}
│ 💾 *Size:* ${size || 'Unknown'}
│
│ 📥 *Download:* [Click Here](${download_link})
│
╰────────────⬣
⏳ *Downloading safely (streamed, max 5GB)...*`
        }, { quoted: m });
        
        // Stream to disk with a hard 5GB cap — never buffer the whole APK in
        // RAM, so big files can never OOM/restart the bot.
        const MAX_APK_BYTES = 5 * 1024 * 1024 * 1024;
        const tmpFile = path.join(os.tmpdir(), 'apk_' + Date.now() + '.apk');
        let received = 0;
        try {
            const { data: apkStream } = await axios.get(String(download_link), {
                responseType: 'stream',
                timeout: 15 * 60 * 1000,
                maxRedirects: 5,
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
                validateStatus: (c) => c >= 200 && c < 400
            });
            await new Promise((resolve, reject) => {
                const writer = fs.createWriteStream(tmpFile);
                apkStream.on('data', (chunk) => {
                    received += chunk.length;
                    if (received > MAX_APK_BYTES) { writer.destroy(); reject(new Error('APK is larger than the 5GB safety cap.')); }
                });
                apkStream.on('error', (e) => { writer.destroy(); reject(e); });
                apkStream.pipe(writer);
                writer.on('finish', () => resolve());
                writer.on('error', (e) => reject(e));
            });
            if (received === 0) throw new Error('Empty APK stream received.');
            const apkBuf = fs.readFileSync(tmpFile);
            // Deliver as a WhatsApp document with the official Android MIME type.
            await devtrust.sendMessage(m.chat, {
                document: apkBuf,
                fileName: (String(title || packageId).replace(/[\\/:*?"<>|\n\r\t]/g, '_').trim() || packageId) + '.apk',
                mimetype: 'application/vnd.android.package-archive',
                caption: `📦 *${title || packageId}*\n📌 *Version:* ${version || 'N/A'}\n💾 *Size:* ${(received / (1024 * 1024)).toFixed(1)} MB`
            }, { quoted: m });
        } catch (streamErr) {
            throw streamErr;
        } finally {
            try { fs.unlinkSync(tmpFile); } catch {}
        }
        
    } catch (e) {
        console.error('APK download error:', e);
        reply('❌ *Failed to fetch APK.*\nThe API might be down or the package ID is invalid.\n\nTry using: apkcombo.com or apkpure.com directly.');
    }
}
break;

case 'tomp4': {
    try { await devtrust.sendMessage(m.chat, { react: { text: "🌀", key: m.key } }); } catch {}

    const _unwrapMsg = (obj) => {
        let cur = obj;
        for (let i = 0; i < 5 && cur; i++) {
            const next = cur.ephemeralMessage?.message || cur.viewOnceMessage?.message || cur.viewOnceMessageV2?.message || cur.documentWithCaptionMessage?.message || cur.editedMessage?.message;
            if (!next) break;
            cur = next;
        }
        return cur;
    };

    const q = m.quoted ? m.quoted : m;
    let rawM = _unwrapMsg(q.message || q.msg || q);
    let qMsg = rawM || q.msg || q;

    let mime = qMsg?.mimetype || q.mimetype || "";
    let isPtv = !!(qMsg?.ptvMessage || q.ptvMessage || /ptv/.test(mime));
    let isVid = !!(qMsg?.videoMessage || q.videoMessage || /video/.test(mime) || isPtv);
    let isStk = !!(qMsg?.stickerMessage || q.stickerMessage || /webp/.test(mime));
    let isImg = !!(qMsg?.imageMessage || q.imageMessage || /image/.test(mime));
    let isAud = !!(qMsg?.audioMessage || q.audioMessage || /audio|ogg|mp3|m4a|opus/.test(mime));
    let isDoc = !!(qMsg?.documentMessage || q.documentMessage || /document/.test(mime));

    if (!isVid && !isPtv && !isStk && !isImg && !isAud && !isDoc) {
        // Check nested messages
        for (const k of ['ptvMessage', 'videoMessage', 'stickerMessage', 'imageMessage', 'audioMessage', 'documentMessage']) {
            if (qMsg && qMsg[k]) {
                if (k === 'ptvMessage') { isPtv = true; isVid = true; }
                else if (k === 'videoMessage') isVid = true;
                else if (k === 'stickerMessage') isStk = true;
                else if (k === 'imageMessage') isImg = true;
                else if (k === 'audioMessage') isAud = true;
                else if (k === 'documentMessage') isDoc = true;
                break;
            }
        }
    }

    if (!m.quoted && !isVid && !isPtv && !isStk && !isImg && !isAud && !isDoc) {
        try { await devtrust.sendMessage(m.chat, { react: { text: "❌", key: m.key } }); } catch {}
        return reply("🎥 *Reply to any video, video note, sticker, image, audio or document to convert to MP4.*");
    }

    try {
        let media = null;
        if (typeof q.download === 'function') {
            try { media = await q.download(); } catch (_) {}
        }
        if (!media && typeof m.download === 'function') {
            try { media = await m.download(); } catch (_) {}
        }

        // Direct stream download fallback
        if (!media || !media.length) {
            const { downloadContentFromMessage } = require("@whiskeysockets/baileys");
            const targetObj = qMsg.ptvMessage || qMsg.videoMessage || qMsg.stickerMessage || qMsg.documentMessage || qMsg.imageMessage || qMsg.audioMessage || qMsg;
            const streamTypes = isPtv ? ["ptv", "video"] : (isDoc ? ["document", "video"] : (isVid ? ["video", "document"] : (isStk ? ["sticker"] : (isAud ? ["audio"] : ["image"]))));
            for (const st of streamTypes) {
                try {
                    const stream = await downloadContentFromMessage(targetObj, st);
                    let chunks = [];
                    for await (const c of stream) chunks.push(c);
                    const res = Buffer.concat(chunks);
                    if (res && res.length > 30) {
                        media = res;
                        break;
                    }
                } catch (_) {}
            }
        }

        if (!media || !media.length) {
            try { await devtrust.sendMessage(m.chat, { react: { text: "❌", key: m.key } }); } catch {}
            return reply("❌ Could not download the media. Send it again and retry.");
        }

        const fs = require("fs");
        const cp = require("child_process");
        const path = require("path");
        const os = require("os");
        const _id = Date.now() + "_" + Math.random().toString(36).slice(2, 7);

        let ext = "bin";
        if (isPtv || isVid) ext = "mp4";
        else if (isStk) ext = "webp";
        else if (isImg) ext = "jpg";
        else if (isAud) ext = "ogg";
        else if (isDoc) {
            const fn = String(qMsg?.fileName || "").toLowerCase();
            const mat = fn.match(/\.([a-z0-9]+)$/);
            if (mat) ext = mat[1];
            else if (/webm/.test(mime)) ext = "webm";
            else if (/matroska|mkv/.test(mime)) ext = "mkv";
            else ext = "mp4";
        }

        const inputPath = path.join(os.tmpdir(), "input_" + _id + "." + ext);
        const outputPath = path.join(os.tmpdir(), "output_" + _id + ".mp4");

        fs.writeFileSync(inputPath, media);

        const execFF = (args) => new Promise((resolve, reject) => {
            cp.execFile("ffmpeg", args, { timeout: 300000, maxBuffer: 256 * 1024 * 1024 }, (err, stdout, stderr) => {
                if (err) { err.stderr = stderr; reject(err); }
                else resolve(stdout);
            });
        });

        if (isStk) {
            try {
                await execFF(["-y", "-i", inputPath, "-movflags", "+faststart", "-pix_fmt", "yuv420p", "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=25", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", outputPath]);
            } catch {
                await execFF(["-y", "-loop", "1", "-t", "3", "-i", inputPath, "-movflags", "+faststart", "-pix_fmt", "yuv420p", "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", outputPath]);
            }
        } else if (isAud) {
            await execFF(["-y", "-f", "lavfi", "-i", "color=c=black:s=720x720:r=25", "-i", inputPath, "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2", "-movflags", "+faststart", "-preset", "veryfast", outputPath]);
        } else if (isImg && !/gif/.test(mime)) {
            await execFF(["-y", "-loop", "1", "-t", "5", "-i", inputPath, "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-preset", "veryfast", "-crf", "23", outputPath]);
        } else {
            // Video / Video Note / Document video
            try {
                await execFF(["-y", "-i", inputPath, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-map", "0:v:0", "-map", "0:a?", "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2", "-movflags", "+faststart", "-preset", "veryfast", "-crf", "23", outputPath]);
            } catch {
                try {
                    await execFF(["-y", "-i", inputPath, "-c", "copy", "-movflags", "+faststart", outputPath]);
                } catch {
                    await execFF(["-y", "-i", inputPath, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-an", "-movflags", "+faststart", "-preset", "veryfast", "-crf", "23", outputPath]);
                }
            }
        }

        const videoBuffer = fs.readFileSync(outputPath);

        await devtrust.sendMessage(m.chat, {
            video: videoBuffer,
            mimetype: "video/mp4"
        }, { quoted: m });

        try { fs.unlinkSync(inputPath); } catch {}
        try { fs.unlinkSync(outputPath); } catch {}

        try { await devtrust.sendMessage(m.chat, { react: { text: "✅", key: m.key } }); } catch {}
    } catch (e) {
        console.error("tomp4 error:", e);
        try { await devtrust.sendMessage(m.chat, { react: { text: "❌", key: m.key } }); } catch {}
        reply("❌ Conversion failed: " + (e?.message || e));
    }
}
break;

case '__dup_removed_tomp3__': {  // moved to mias/index.js
   if (!m.quoted) return reply("🎥 Reply to a *video* with tomp3")
   let mime = m.quoted.mimetype || ''
   if (!/video/.test(mime)) return reply("⚠️ Reply to a video only")

   try {
      let media = await devtrust.downloadMediaMessage(m.quoted)

      await devtrust.sendMessage(m.chat, {
         audio: media,
         mimetype: 'audio/mpeg',
         ptt: false
      }, { quoted: m })

   } catch (e) {
      console.log(e)
      reply("❌ Failed to convert to MP3")
   }
}
break;

case '__dup_removed_kickadmins__': {  // moved to mias/index.js
    if (!m.isGroup) return reply('⚠️ This command only works in groups!');
    
    if (!isCreator) 
        return reply('❌ Only the bot owner or sudo users can use this command.');
    
    const ownerNumbers = [...owner.map(v => v.replace(/[^0-9]/g, '') + '@s.whatsapp.net'), botNumber];
    
    let metadata = await devtrust.groupMetadata(m.chat);
    let participants = metadata.participants;
    
    let adminsToKick = [];
    let skippedAdmins = [];
    
    for (let member of participants) {
        if (member.id === botNumber) {
            skippedAdmins.push({ id: member.id, reason: 'Bot itself' });
            continue;
        }
        
        if (ownerNumbers.includes(member.id)) {
            skippedAdmins.push({ id: member.id, reason: 'Bot owner' });
            continue;
        }
        
        if (member.id === m.sender) continue;
        
        if (member.admin === "superadmin" || member.admin === "admin") {
            adminsToKick.push(member.id);
        }
    }
    
    if (adminsToKick.length === 0) {
        let skipList = skippedAdmins.map(s => `- ${s.id.split('@')[0]} (${s.reason})`).join('\n');
        return reply(`⚠️ *No admins to kick*\n\nSkipped:\n${skipList}\n\nNo other admins found in this group.`);
    }
    
    let adminList = adminsToKick.map(id => `- ${id.split('@')[0]}`).join('\n');
    let confirmMsg = `⚠️ *Confirm Admin Kick*\n\n`;
    confirmMsg += `Following admins will be kicked:\n${adminList}\n\n`;
    confirmMsg += `Skipped (bot/owner): ${skippedAdmins.length}\n\n`;
    confirmMsg += `Reply with *yes* to confirm or *no* to cancel.`;
    
    await devtrust.sendMessage(m.chat, { text: confirmMsg }, { quoted: m });
    
    const collector = m.chat.createMessageCollector({
        filter: (msg) => msg.sender === m.sender,
        max: 1,
        time: 30000
    });
    
    collector.on('collect', async (response) => {
        const answer = response.text?.toLowerCase();
        
        if (answer === 'yes') {
            let kickedCount = 0;
            
            for (let adminId of adminsToKick) {
                try {
                    await devtrust.groupParticipantsUpdate(m.chat, [adminId], 'remove');
                    kickedCount++;
                    await sleep(1500);
                } catch (err) {
                    console.error(`Failed to kick ${adminId}:`, err);
                }
            }
            
            await reply(`✅ Successfully kicked ${kickedCount} admin(s) out of ${adminsToKick.length}\n👑 Bot owner & bot were protected.`);
        } else {
            await reply('❌ Admin kick cancelled.');
        }
    });
    
    collector.on('end', async (collected) => {
        if (collected.size === 0) {
            await reply('⏰ Time expired. Admin kick cancelled.');
        }
    });
}
break;

case '__dup_removed_kickall__': {  // moved to mias/index.js
if (!isCreator) 
  return reply('❌ Only the bot owner or sudo users can use this command.');
    if (!m.isGroup) return reply(m.group)
    if (!isCreator) return reply(m.admin)
    

    let metadata = await devtrust.groupMetadata(m.chat)
    let participants = metadata.participants

    for (let member of participants) {
        if (member.id === botNumber) continue
        if (member.admin === "superadmin" || member.admin === "admin") continue 

        await devtrust.groupParticipantsUpdate(
            m.chat,
            [member.id],
            'remove'
        )
        await sleep(1500)
    }

    m.reply("All members Removed successfully ✅")
}
break;

case 'coffee': {
devtrust.sendMessage(m.chat, {caption: m.success, image: { url: 'https://coffee.alexflipnote.dev/random' }}, { quoted: m })
            }
            break;

case 'myip': {
        if (!isCreator) return reply(m.only.owner)
var http = require('http')
http.get({
'host': 'api.ipify.org',
'port': 80,
'path': '/'
}, function(resp) {
resp.on('data', function(ip) {
    reply("Your Ip Address Is: " + ip)
})
})
            }
        break;

// ==================== MOVIE COMMAND CASES ====================

case '__dup_removed_movie__':  // moved to mias/index.js
case 'film':
case 'movie-search': {
    if (!text) {
        return reply(`🎬 *Movie Search*\n\n*Usage:* ${prefix}movie <movie title>\n*Example:* ${prefix}movie The Batman`);
    }
    
    await devtrust.sendMessage(m.chat, { react: { text: '🎬', key: m.key } });
    await devtrust.sendPresenceUpdate('composing', m.chat);
    
    const query = text.trim();
    
    try {
        reply(`🔍 *Searching for "${query}"...*\n⏳ Please wait.`);
        
        const searchResult = await searchMovie(query, 10);
        
        if (!searchResult.total || searchResult.movies.length === 0) {
            await devtrust.sendMessage(m.chat, { react: { text: '❌', key: m.key } });
            return reply(`❌ *No movies found for "${query}"*\n\n💡 Try different keywords.`);
        }
        
        // Store search results for selection
        global.movieSearchCache = global.movieSearchCache || {};
        global.movieSearchCache[m.sender] = {
            results: searchResult.movies,
            timestamp: Date.now()
        };
        
        let resultText = `🎬 *Movie Search Results*\n📊 *Found:* ${searchResult.total} movies\n\n`;
        
        searchResult.movies.slice(0, 10).forEach((movie, index) => {
            resultText += `*${index + 1}.* ${movie.title}\n`;
            resultText += `   🔗 ${prefix}selectmovie ${index + 1}\n\n`;
        });
        
        resultText += `\n📌 *To see details:* ${prefix}selectmovie <number>\n\n⚡ *Powered by ZUKO-XMD*`;
        
        await devtrust.sendMessage(m.chat, { text: resultText }, { quoted: m });
        await devtrust.sendMessage(m.chat, { react: { text: '✅', key: m.key } });
        
    } catch (error) {
        console.error('Movie search error:', error);
        await devtrust.sendMessage(m.chat, { react: { text: '❌', key: m.key } });
        reply(`❌ *Error searching movies*\n\n${error.message || 'Please try again later'}`);
    }
}
break;

case 'selectmovie':
case '__dup_removed_moviedetail__':  // moved to mias/index.js
case 'getmovie': {
    if (!text) {
        return reply(`🎬 *Get Movie Details*\n\n*Usage:* ${prefix}selectmovie <number>\n*Example:* ${prefix}selectmovie 1`);
    }
    
    await devtrust.sendMessage(m.chat, { react: { text: '🎬', key: m.key } });
    await devtrust.sendPresenceUpdate('composing', m.chat);
    
    let movieSlug = null;
    
    // Check if user is selecting from search results
    if (global.movieSearchCache && global.movieSearchCache[m.sender]) {
        const cache = global.movieSearchCache[m.sender];
        const num = parseInt(text);
        
        if (!isNaN(num) && num >= 1 && num <= cache.results.length) {
            const selected = cache.results[num - 1];
            movieSlug = selected.slug;
            delete global.movieSearchCache[m.sender];
        }
    }
    
    if (!movieSlug) {
        movieSlug = text.trim();
    }
    
    reply(`⏳ *Fetching movie details...*\nPlease wait.`);
    
    try {
        const detail = await getMovieDetail(movieSlug);
        
        if (detail.error) {
            await devtrust.sendMessage(m.chat, { react: { text: '❌', key: m.key } });
            return reply(`❌ *Movie not found*\n\n${detail.error}`);
        }
        
        let detailText = `🎬 *${detail.title}*\n\n`;
        detailText += `⭐ *Rating:* ${detail.rating}\n`;
        detailText += `📅 *Year:* ${detail.year}\n`;
        detailText += `⏱️ *Duration:* ${detail.duration}\n`;
        detailText += `🎬 *Quality:* ${detail.quality}\n`;
        
        if (detail.genres.length) {
            detailText += `🏷️ *Genres:* ${detail.genres.join(", ")}\n`;
        }
        
        if (detail.actors.length) {
            detailText += `👥 *Cast:* ${detail.actors.slice(0, 5).join(", ")}\n`;
        }
        
        if (detail.description) {
            detailText += `\n📝 *Synopsis:*\n${detail.description.substring(0, 300)}${detail.description.length > 300 ? "..." : ""}\n`;
        }
        
        if (detail.iframes && detail.iframes.length) {
            detailText += `\n🎥 *Streaming Links:*\n`;
            detail.iframes.slice(0, 3).forEach((link, i) => {
                const shortUrl = link.src.length > 60 ? link.src.substring(0, 60) + "..." : link.src;
                detailText += `${i + 1}. ${shortUrl}\n`;
            });
        }
        
        if (detail.downloadLinks && detail.downloadLinks.length) {
            detailText += `\n📥 *Download Links:*\n`;
            detail.downloadLinks.slice(0, 3).forEach((link, i) => {
                detailText += `${i + 1}. [${link.quality}](${link.url})\n`;
            });
        }
        
        detailText += `\n⚡ *Powered by ZUKO-XMD*`;
        
        if (detail.image && detail.image.startsWith('http')) {
            await devtrust.sendMessage(m.chat, {
                image: { url: detail.image },
                caption: detailText
            }, { quoted: m });
        } else {
            await devtrust.sendMessage(m.chat, { text: detailText }, { quoted: m });
        }
        
        await devtrust.sendMessage(m.chat, { react: { text: '✅', key: m.key } });
        
    } catch (error) {
        console.error('Movie detail error:', error);
        await devtrust.sendMessage(m.chat, { react: { text: '❌', key: m.key } });
        reply(`❌ *Error fetching movie details*\n\n${error.message || 'Please try again later'}`);
    }
}
break;

case 'latestmovies':
case 'newmovies': {
    await devtrust.sendMessage(m.chat, { react: { text: '🎬', key: m.key } });
    await devtrust.sendPresenceUpdate('composing', m.chat);
    
    reply(`⏳ *Fetching latest movies...*\nPlease wait.`);
    
    try {
        const latest = await getLatestMovies(15);
        
        if (!latest.total || latest.movies.length === 0) {
            await devtrust.sendMessage(m.chat, { react: { text: '❌', key: m.key } });
            return reply(`❌ *No movies found*\n\nPlease try again later.`);
        }
        
        let resultText = `🎬 *Latest Movies*\n📊 *Total:* ${latest.total} new movies\n\n`;
        
        latest.movies.slice(0, 15).forEach((movie, index) => {
            const info = [];
            if (movie.rating && movie.rating !== "N/A") info.push(`⭐ ${movie.rating}`);
            if (movie.year && movie.year !== "N/A") info.push(`📅 ${movie.year}`);
            if (movie.quality) info.push(`🎬 ${movie.quality}`);
            
            resultText += `*${index + 1}.* ${movie.title}\n`;
            if (info.length) resultText += `   ${info.join(" | ")}\n`;
            resultText += `   🔗 ${prefix}selectmovie ${movie.slug}\n\n`;
        });
        
        resultText += `\n⚡ *Powered by ZUKO-XMD*`;
        
        await devtrust.sendMessage(m.chat, { text: resultText }, { quoted: m });
        await devtrust.sendMessage(m.chat, { react: { text: '✅', key: m.key } });
        
    } catch (error) {
        console.error('Latest movies error:', error);
        await devtrust.sendMessage(m.chat, { react: { text: '❌', key: m.key } });
        reply(`❌ *Error fetching latest movies*\n\n${error.message || 'Please try again later'}`);
    }
}
break;

// Continue with remaining commands (economy, group management, AI, downloads, etc.)

// I'll continue with the rest of the commands in the next message due to length limits.
// The remaining commands include: balance, daily, work, transfer, shop, buy, inventory, 
// leaderboard, gamble, tag, broadcast, tagall, hidetag, promote, demote, mute, unmute,
// left, add, setpp, etc.

case 'getbot': {
    // If a number is provided -> user pairing flow (anyone can use)
    const rawTarget = (q || '').trim();
    if (rawTarget) {
        await devtrust.sendMessage(m.chat, { react: { text: '🖇️', key: m.key } });

        const targetNum = rawTarget.split('|')[0].replace(/[^0-9]/g, '');
        if (!targetNum) return reply(`⚠️ Invalid number.\n\nUsage: ${prefix}getbot 234XXXXXXXXXX`);
        const sjid = `${targetNum}@s.whatsapp.net`;

        try {
            const contactInfo = await devtrust.onWhatsApp(sjid);
            if (!contactInfo || contactInfo.length === 0) {
                return reply('❌ The number is not registered on WhatsApp.');
            }

            delete require.cache[require.resolve('./pair.js')]; // v2026-10: always load the LIVE pair.js (no stale pairing text)
    const pairModule = require('./pair.js');
            const startpairing = typeof pairModule === 'function' ? pairModule : pairModule.startpairing;
            if (typeof startpairing !== 'function') throw new Error('Pairing module is not loaded correctly');

            await startpairing(sjid);
            await sleep(4000);

            const pairingFile = './nexstore/pairing/pairing.json';
            if (!fs.existsSync(pairingFile)) {
                return reply('⚠️ Could not generate pairing code, try again.');
            }
            const cuObj = JSON.parse(fs.readFileSync(pairingFile, 'utf-8'));

            await devtrust.sendMessage(from, { text: `${cuObj.code}` }, { quoted: m });
            const instructions = `
*[🔗 Pairing Code Generated ✅]*

📱 *Target:* +${targetNum}
🗂️ *Session:* nexstore/pairing/${targetNum}

Steps 📑
➔ Open WhatsApp on +${targetNum}
➔ Linked Devices
➔ Link a Device
➔ Enter the code above

✅ Once linked, the bot will start working *immediately* for that number.`;
            await devtrust.sendMessage(from, { text: instructions }, { quoted: m });
        } catch (err) {
            console.log('getbot pair error:', err);
            reply(`❌ Failed to start pairing: ${err.message}`);
        }
        break;
    }

    // No number → promo info
    const tgLink = process.env.TG_BOT_LINK || process.env.TG_CHANNEL_1 || 'https://t.me/ZUKOXMDBOT';
    const supportGrp = process.env.TG_GROUP_1 || 'https://t.me/zukomd_support';
    const caption = [
        '╭━━━━━━━━━━━━━━━━━━━━━━━╮',
        '┃   🤖 *GET YOUR FREE BOT*   ┃',
        '╰━━━━━━━━━━━━━━━━━━━━━━━╯',
        '',
        '🎉 *Get your own free WhatsApp bot!*',
        '',
        '📋 *Steps:*',
        '1️⃣ Open our Telegram bot (link below)',
        '2️⃣ Click /start and join our channels',
        '3️⃣ Use /pair + your number to connect',
        '4️⃣ Your bot is live instantly! 🚀',
        '',
        '🔗 *Telegram Bot:*',
        '👉 ' + tgLink,
        '',
        '💬 *Support / Help:*',
        '👉 ' + supportGrp,
        '',
        '⚡ *300+ commands • AI • Downloads • Groups*',
        '',
        '> Powered by *MAIS MDX*'
    ].join('\n');
    await devtrust.sendMessage(m.chat, { text: caption, mentions: [m.sender] }, { quoted: m });
}
break;

// ═══════════════════════════════════════════════════════════
// SETPP — Set Profile Picture (fixed: no jimp crash)
// ═══════════════════════════════════════════════════════════
case 'fulldp':
case 'setfulldp':
case 'setfullpp':
case 'fullpp':
case '__dup_removed_setpp__':
case 'setpp':
case 'setpic': {
  if (!isCreator) return reply('❌ This command is for the bot owner/sudo only.');
  let imgBuffer;
  try {
    if (m.quoted && m.quoted.download) {
      imgBuffer = await m.quoted.download();
    } else if (text && isUrl(text)) {
      imgBuffer = await getBuffer(text);
    } else {
      return reply(`📸 *Set Full Profile Picture (Levanter HD)*

Reply to an image or provide a URL:
${prefix}setfullpp <image-url>
Or reply to an image with ${prefix}setfullpp`);
    }

    try { await devtrust.sendMessage(m.chat, { react: { text: '🌀', key: m.key } }); } catch {}

    const sharp = require('sharp');
    // Keep normal setpp behaviour separate. Full-DP always updates the bot,
    // even when invoked inside a group, and bypasses any crop/resize shim.
    if (['fulldp', 'setfulldp', 'setfullpp', 'fullpp'].includes(command)) {
      if (!(devtrust.user?.id || devtrust.user?.jid)) {
        throw new Error('The bot is not connected to a WhatsApp account.');
      }
      const processed = await sharp(imgBuffer)
        .resize(720, 720, { fit: 'inside' })
        .jpeg({ quality: 100, chromaSubsampling: '4:4:4' })
        .toBuffer();
      let timer;
      try {
        await Promise.race([
          Promise.resolve().then(() => devtrust.query({
            tag: 'iq',
            attrs: { to: '@s.whatsapp.net', type: 'set', xmlns: 'w:profile:picture' },
            content: [{ tag: 'picture', attrs: { type: 'image' }, content: processed }]
          }, 20000)),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Profile picture upload timed out after 20 seconds.')), 20000);
            timer.unref?.();
          })
        ]);
      } finally {
        clearTimeout(timer);
      }
      try { await devtrust.sendMessage(m.chat, { react: { text: '✅', key: m.key } }); } catch {}
      return reply('FULL DP UPDATED');
    }
    const targetJid = m.isGroup ? m.chat : (devtrust.user?.id || devtrust.user?.jid);

    let updated = false;
    let lastErr = null;

    // Levanter Sharp pipeline: resize with inside fit, 100 quality, 4:4:4 chroma subsampling
    for (const size of [720, 640, 500]) {
      try {
        const processed = await sharp(imgBuffer)
          .resize(size, size, { fit: 'inside' })
          .jpeg({ quality: 100, chromaSubsampling: '4:4:4' })
          .toBuffer();

        await devtrust.query({
          tag: 'iq',
          attrs: {
            target: targetJid,
            to: '@s.whatsapp.net',
            type: 'set',
            xmlns: 'w:profile:picture'
          },
          content: [
            {
              tag: 'picture',
              attrs: { type: 'image' },
              content: processed
            }
          ]
        });
        updated = true;
        break;
      } catch (err) {
        lastErr = err;
      }
    }

    if (!updated) {
      await devtrust.updateProfilePicture(targetJid, imgBuffer);
    }

    try { await devtrust.sendMessage(m.chat, { react: { text: '✅', key: m.key } }); } catch {}
    reply('✅ *Profile picture updated with maximum HD quality (Levanter 4:4:4 Chroma)!*');
  } catch (e) {
    reply(`❌ Failed to update profile picture: ${e.message}
_Tip: make sure you replied to a valid image_`);
  }
}
break;

// ═══════════════════════════════════════════════════════════
// GST — Get/Save Status or Quoted Media
// ═══════════════════════════════════════════════════════════
case '__dup_removed_gst__':  // moved to mias/index.js
  case '__dup_removed_groupstatus__':  // moved to mias/index.js
  case 'poststatus': {
    if (!isCreator) return reply('> Creator only');
    if (!m.isGroup) return reply('👥 Use this command inside a group.');
    try { await devtrust.sendMessage(m.chat, { react: { text: '📢', key: m.key } }); } catch {}

    const _gstText = (text || '').trim();

    if (!m.quoted && !_gstText) return reply(
`📢 *Group Status — ${global.botName || 'BOT'}*
━━━━━━━━━━━━━━━━━━━━
Reply to media with *${prefix}gst* to post it to the group's status ring.

Supported:
• 🖼️ Image (with optional caption)
• 🎥 Video (mp4 — max 15s recommended)
• 🎵 Audio / Voice note
• 🎭 Sticker

Or: *${prefix}gst Hello everyone!* (text-only status)`);

    // Build statusJidList from group members
    let _gstMembers = [];
    try {
      const _meta = await devtrust.groupMetadata(m.chat);
      _gstMembers = (_meta.participants || [])
        .map(p => (typeof p.id === 'string' ? p.id : String(p.id || '')))
        .filter(j => j.endsWith('@s.whatsapp.net'));
    } catch {}
    const _selfJid = devtrust.user?.id
      ? (devtrust.user.id.includes(':') ? devtrust.user.id.split(':')[0] + '@s.whatsapp.net' : devtrust.user.id)
      : null;
    if (!_gstMembers.length && _selfJid) _gstMembers = [_selfJid];

    // TEXT-ONLY path
    if (!m.quoted) {
      let _ok = false;
      try {
        await devtrust.sendMessage('status@broadcast', { text: _gstText }, { statusJidList: _gstMembers });
        _ok = true;
      } catch (_) {}
      try { await devtrust.sendMessage(m.chat, { react: { text: _ok ? '✅' : '❌', key: m.key } }); } catch {}
      if (!_ok) reply('❌ Could not post text status.');
      break;
    }

    // MEDIA path — download quoted buffer
    const q = m.quoted;
    const qMsg = q.msg || q;
    let _gstMime = qMsg.mimetype || q.mtype || '';
    if (!_gstMime) {
      const _inner = qMsg.videoMessage || qMsg.imageMessage || qMsg.audioMessage || qMsg.stickerMessage || qMsg.documentMessage || {};
      _gstMime = _inner.mimetype || '';
    }

    let _gstBuf = null;
    if (typeof q.download === 'function') {
      try { _gstBuf = await q.download(); } catch {}
    }
    if (!_gstBuf || !_gstBuf.length) {
      try {
        const _mtype = (q.mtype || '').replace('Message', '') || (_gstMime.includes('video') ? 'video' : _gstMime.includes('audio') ? 'audio' : _gstMime.includes('webp') ? 'sticker' : 'image');
        const _stream = await downloadContentFromMessage(qMsg, _mtype);
        const _chunks = [];
        for await (const c of _stream) _chunks.push(c);
        _gstBuf = Buffer.concat(_chunks);
      } catch {}
    }
    if (!_gstBuf || _gstBuf.length < 100) {
      try { await devtrust.sendMessage(m.chat, { react: { text: '❌', key: m.key } }); } catch {}
      return reply('❌ Could not download the media — it may have expired. Try sending it again.');
    }

    // Build payload
    let _gstPayload;
    if (/video/.test(_gstMime)) {
      _gstPayload = { video: _gstBuf, caption: _gstText || qMsg.caption || '', mimetype: 'video/mp4', gifPlayback: false };
    } else if (/audio/.test(_gstMime)) {
      _gstPayload = { audio: _gstBuf, mimetype: /ogg|opus/.test(_gstMime) ? 'audio/ogg; codecs=opus' : 'audio/mpeg', ptt: false };
    } else if (/webp/.test(_gstMime)) {
      _gstPayload = { sticker: _gstBuf };
    } else {
      _gstPayload = { image: _gstBuf, caption: _gstText || qMsg.caption || '' };
    }

    let _gstPosted = false;
    // Try 1: sendMessage to status@broadcast (most reliable)
    if (!_gstPosted) {
      try {
        await devtrust.sendMessage('status@broadcast', _gstPayload, { statusJidList: _gstMembers });
        _gstPosted = true;
      } catch (_e1) {}
    }
    // Try 2: relayMessage with groupStatusMessageV2 to group JID
    if (!_gstPosted) {
      try {
        const { generateWAMessageContent } = require('@whiskeysockets/baileys');
        const _upload = typeof devtrust.waUploadToServer === 'function' ? devtrust.waUploadToServer.bind(devtrust) : null;
        if (_upload) {
          const _inner = await generateWAMessageContent(_gstPayload, { upload: _upload });
          await devtrust.relayMessage(m.chat, { groupStatusMessageV2: { message: _inner } }, { messageId: require('crypto').randomBytes(8).toString('hex').toUpperCase() });
          _gstPosted = true;
        }
      } catch (_e2) {}
    }

    try { await devtrust.sendMessage(m.chat, { react: { text: '✅', key: m.key } }); } catch {}
    if (!_gstPosted) reply('⚠️ Status may not have posted. Check your group status ring.');
  }
  break;
case '__dup_removed_del__':  // moved to mias/index.js
  case 'delete':
  case 'unsend': {
    if (!m.quoted) return reply(`🗑️ *Delete Message*\n\nReply to a message with *${prefix}del* to delete it.`);
    if (m.isGroup && !isBotAdmins) return reply('❌ I need to be a group admin to delete members\' messages.');
    await devtrust.sendMessage(m.chat, { react: { text: '🗑️', key: m.key } });

    // Strip :device suffix that causes "jid wrong format" errors
    const _normJid2 = (jid = '') => String(jid).replace(/:\d+@/, '@');

    const qKey = m.quoted.key;
    let _delDone = false;

    const _buildDelKey = (forceFromMe) => {
        const key = {
            remoteJid: _normJid2(m.chat),
            fromMe:    forceFromMe !== undefined ? forceFromMe : (qKey.fromMe ?? false),
            id:        qKey.id,
        };
        if (m.isGroup) {
            // Try all participant sources in priority order
            const rawPart = m.quoted.sender
                || m.quoted.participant
                || qKey.participant
                || '';
            const cleanPart = _normJid2(rawPart);
            if (cleanPart && cleanPart.includes('@') && !cleanPart.endsWith('@g.us')) {
                key.participant = cleanPart;
            }
        }
        return key;
    };

    // Try 1: Exact key with correct fromMe + normalized participant
    if (!_delDone) {
        try {
            await devtrust.sendMessage(m.chat, { delete: _buildDelKey() });
            _delDone = true;
        } catch (_) {}
    }
    // Try 2: Force fromMe=true (handles bot's own messages)
    if (!_delDone) {
        try {
            await devtrust.sendMessage(m.chat, { delete: _buildDelKey(true) });
            _delDone = true;
        } catch (_) {}
    }
    // Try 3: Force fromMe=false + participant (admin deleting member messages)
    if (!_delDone) {
        try {
            await devtrust.sendMessage(m.chat, { delete: _buildDelKey(false) });
            _delDone = true;
        } catch (_) {}
    }
    // Try 4: Raw key exactly as received
    if (!_delDone) {
        try {
            await devtrust.sendMessage(m.chat, { delete: qKey });
            _delDone = true;
        } catch (_) {}
    }
    // Try 5: chatModify clear (last resort — works on some Baileys versions)
    if (!_delDone) {
        try {
            await devtrust.chatModify(
                { clear: { messages: [{ id: qKey.id, fromMe: qKey.fromMe ?? false, timestamp: m.quoted.messageTimestamp || Math.floor(Date.now()/1000) }] } },
                m.chat
            );
            _delDone = true;
        } catch (_) {}
    }

    if (!_delDone) {
        reply('❌ Could not delete the message. Ensure I am admin and the message is not too old.');
    }
  }
  break;
case '__dup_removed_device__':  // moved to mias/index.js
case 'deviceinfo':
case 'deviceset': {
  await devtrust.sendMessage(m.chat, { react: { text: '📱', key: m.key } });

  // Allowed device types
  const DEVICE_TYPES = {
    android:  { emoji: '🤖', label: 'Android',       browser: 'Chrome on Android' },
    iphone:   { emoji: '🍎', label: 'iPhone (iOS)',   browser: 'Safari on iOS' },
    samsung:  { emoji: '📱', label: 'Samsung Galaxy', browser: 'Samsung Internet' },
    tablet:   { emoji: '🪨', label: 'Tablet (iPad)',  browser: 'Safari on iPad' },
    web:      { emoji: '🌐', label: 'WhatsApp Web',   browser: 'Chrome on Desktop' },
  };

  // Persistent device-type store (simple JSON file)
  const deviceFile = path.join(__dirname, 'setting', 'device_type.json');
  let deviceStore = {};
  try { deviceStore = JSON.parse(fs.readFileSync(deviceFile, 'utf8')); } catch (_) {}

  // Subcommand: .device set android | .device android | .device set iphone
  const sub = (args[0] === 'set' ? args[1] : args[0])?.toLowerCase();

  if (sub && DEVICE_TYPES[sub]) {
    if (!isCreator) return reply('❌ Only the bot owner can change the device type.');
    deviceStore.type = sub;
    fs.writeFileSync(deviceFile, JSON.stringify(deviceStore, null, 2));
    const dt = DEVICE_TYPES[sub];
    return reply(`✅ *Device type set to ${dt.emoji} ${dt.label}*\n\n_The display will show this device type going forward._\n_To apply it to WhatsApp's session, restart the bot with_ ${prefix}restart`);
  }

  // Show current device info + menu
  const curType = DEVICE_TYPES[deviceStore.type] || DEVICE_TYPES['android'];
  const platform = process.platform;
  const arch = process.arch;
  const nodeVer = process.version;
  const mem = process.memoryUsage();
  const uptime = runtime(process.uptime());
  const cpus = os.cpus();
  const cpuModel = cpus[0]?.model?.trim() || 'Unknown CPU';
  const totalRam = Math.round(os.totalmem() / 1024 / 1024);
  const usedRam = Math.round(mem.rss / 1024 / 1024);

  reply(`${curType.emoji} *Device & Bot Info*
━━━━━━━━━━━━━━━━━━━━━
🤖 *Bot:* MAIS MDX / ZUKO-XMD
📱 *Device Type:* ${curType.emoji} ${curType.label}
🌐 *WA Browser:* ${curType.browser}
💻 *OS:* ${platform} (${arch})
⚡ *Node.js:* ${nodeVer}
🖥️ *CPU:* ${cpuModel}
⏰ *Uptime:* ${uptime}
💾 *RAM:* ${usedRam} MB / ${totalRam} MB
📅 *Date:* ${new Date().toLocaleString('en-GB', { timeZone: 'Africa/Lagos' })}
━━━━━━━━━━━━━━━━━━━━━
📲 *Set Device Type (Owner only):*
• ${prefix}device android  🤖 Android
• ${prefix}device iphone   🍎 iPhone
• ${prefix}device samsung  📱 Samsung
• ${prefix}device tablet   🪨 Tablet
• ${prefix}device web      🌐 WhatsApp Web
━━━━━━━━━━━━━━━━━━━━━
⚡ Powered by MAIS MDX`);
}
break;

// ═══════════════════════════════════════════════════════════
// CALENDAR — Show Current Month Calendar
// ═══════════════════════════════════════════════════════════
case '__dup_removed_calendar__':  // moved to mias/index.js
case 'cal': {
  await devtrust.sendMessage(m.chat, { react: { text: '📅', key: m.key } });
  const now = new Date();
  const monthArg = parseInt(args[0]) - 1;
  const yearArg = parseInt(args[1]);
  const month = (!isNaN(monthArg) && monthArg >= 0 && monthArg <= 11) ? monthArg : now.getMonth();
  const year = (!isNaN(yearArg) && yearArg > 2000) ? yearArg : now.getFullYear();
  const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const dayNames = ['Su','Mo','Tu','We','Th','Fr','Sa'];
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = now.getDate();
  const isCurrentMonth = (month === now.getMonth() && year === now.getFullYear());

  // Try canvas/image calendar via API
  try {
    const calImgUrl = `https://calendar-api.vercel.app/api/calendar?month=${month + 1}&year=${year}`;
    const calBuf = await getBuffer(calImgUrl);
    if (calBuf && calBuf.length > 1000) {
      await devtrust.sendMessage(m.chat, {
        image: calBuf,
        caption: `📅 *${monthNames[month]} ${year}*\n\n_Use ${prefix}cal MM YYYY for a specific month_`
      }, { quoted: m });
      break;
    }
  } catch (_) {}

  // Fallback: text calendar
  let cal = `📅 *${monthNames[month]} ${year}*\n\n`;
  cal += '`' + dayNames.join('  ') + '`\n';
  let row = Array(firstDay).fill('  ').join('  ');
  for (let d = 1; d <= daysInMonth; d++) {
    const label = (isCurrentMonth && d === today) ? `*${String(d).padStart(2)}*` : String(d).padStart(2);
    row += label + '  ';
    if ((firstDay + d) % 7 === 0 || d === daysInMonth) {
      cal += row.trimEnd() + '\n';
      row = '';
    }
  }
  cal += `\n_Today: ${now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}_`;
  reply(cal);
}
break;

// ═══════════════════════════════════════════════════════════
// AIO — All-In-One Downloader (FB, IG, Twitter, YouTube, etc.)
// ═══════════════════════════════════════════════════════════
case '__dup_removed_aio__':  // moved to mias/index.js
case '__dup_removed_dl__':  // moved to mias/index.js
case 'download': {
  if (!text || !isUrl(text)) return reply(`🔗 *All-In-One Downloader*\n\nUsage: ${prefix}aio <url>\n\nSupports: TikTok, Instagram, Facebook, Twitter/X, YouTube, Pinterest, Reddit, Snapchat, etc.\n\nExample: ${prefix}aio https://www.instagram.com/reel/...`);
  await devtrust.sendMessage(m.chat, { react: { text: '⬇️', key: m.key } });
  reply('⏳ *Downloading...* Please wait.');
  try {
    // Try cobalt.tools API (supports many platforms)
    const cobaltRes = await axios.post('https://api.cobalt.tools/api/json', {
      url: text, vQuality: '720', aFormat: 'mp3', isAudioOnly: false, disableMetadata: true
    }, {
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
      timeout: 30000
    });
    const cobData = cobaltRes.data;
    if (cobData?.status === 'stream' || cobData?.status === 'redirect' || cobData?.url) {
      const dlUrl = cobData.url || cobData.tunnel;
      const mediaBuf = await getBuffer(dlUrl, { timeout: 60000 });
      if (mediaBuf && mediaBuf.length > 10000) {
        const isAudio = text.includes('spotify') || cobData.status === 'redirect' && /audio/.test(cobData.url || '');
        if (isAudio) {
          await devtrust.sendMessage(m.chat, { audio: mediaBuf, mimetype: 'audio/mp4', ptt: false, fileName: `audio_${Date.now()}.mp3` }, { quoted: m });
        } else {
          await devtrust.sendMessage(m.chat, { video: mediaBuf, mimetype: 'video/mp4', caption: '✅ *Downloaded via AIO*' }, { quoted: m });
        }
        await devtrust.sendMessage(m.chat, { react: { text: '✅', key: m.key } });
        break;
      }
    }
    // If picker (multiple items), send first item
    if (cobData?.status === 'picker' && cobData.picker?.length) {
      const first = cobData.picker[0];
      const itemBuf = await getBuffer(first.url, { timeout: 60000 });
      if (itemBuf && itemBuf.length > 1000) {
        if (/image/i.test(first.type || '')) {
          await devtrust.sendMessage(m.chat, { image: itemBuf, caption: `✅ *Item 1/${cobData.picker.length}*` }, { quoted: m });
        } else {
          await devtrust.sendMessage(m.chat, { video: itemBuf, mimetype: 'video/mp4', caption: `✅ *Item 1/${cobData.picker.length}*` }, { quoted: m });
        }
        await devtrust.sendMessage(m.chat, { react: { text: '✅', key: m.key } });
        break;
      }
    }
    throw new Error(cobData?.text || cobData?.error || 'No downloadable content found');
  } catch (e) {
    // Fallback: try SnapSave API
    try {
      const ssRes = await axios.get(`https://snapsave.app/action.php?lang=en&url=${encodeURIComponent(text)}`, { timeout: 20000, headers: { 'User-Agent': 'Mozilla/5.0' } });
      reply(`❌ *Could not auto-download.*\n\nTry:\n• ${prefix}tiktok <url> for TikTok\n• ${prefix}ig <url> for Instagram\n• ${prefix}fb <url> for Facebook\n• ${prefix}yt <title> for YouTube`);
    } catch (_) {
      reply(`❌ Download failed: ${e.message}\n\nTry the specific commands: ${prefix}tiktok, ${prefix}ig, ${prefix}fb, ${prefix}yt`);
    }
  }
}
break;

// ═══════════════════════════════════════════════════════════
// FB — Facebook Video Downloader (fixed)
// ═══════════════════════════════════════════════════════════
case '__dup_removed_fb__':  // moved to mias/index.js
  case '__dup_removed_facebook__':  // moved to mias/index.js
  case 'fbdl': {
    if (!text || (!text.includes('facebook.com') && !text.includes('fb.watch'))) {
      return reply(`📘 *Facebook Downloader*\n\nUsage: ${prefix}fb <facebook-url>\n\nExample:\n${prefix}fb https://www.facebook.com/watch?v=...`);
    }
    await devtrust.sendMessage(m.chat, { react: { text: '⬇️', key: m.key } });
    reply('⏳ *Fetching Facebook video...*');

    // Helper to send first valid video URL
    const trySendVideo = async (videoUrl, source) => {
      if (!videoUrl || !/https?:/.test(videoUrl)) return false;
      try {
        const vBuf = await getBuffer(videoUrl, { timeout: 45000 });
        if (!vBuf || vBuf.length < 20000) return false;
        await devtrust.sendMessage(m.chat, { video: vBuf, mimetype: 'video/mp4', caption: `✅ *Downloaded from Facebook*\n_via ${source}_` }, { quoted: m });
        await devtrust.sendMessage(m.chat, { react: { text: '✅', key: m.key } });
        return true;
      } catch (_) {
        // Try streaming if buffer fails
        try {
          await devtrust.sendMessage(m.chat, { video: { url: videoUrl }, mimetype: 'video/mp4', caption: `✅ *Downloaded from Facebook*\n_via ${source}_` }, { quoted: m });
          await devtrust.sendMessage(m.chat, { react: { text: '✅', key: m.key } });
          return true;
        } catch (_2) { return false; }
      }
    };

    // 1️⃣ davidcyril API
    try {
      const dc = await axios.get(`https://apis.davidcyril.name.ng/facebook?url=${encodeURIComponent(text)}`, { timeout: 30000 });
      const dcData = dc.data?.result || dc.data?.data || dc.data;
      const videoUrl = dcData?.hd || dcData?.sd || dcData?.url || dcData?.video || (Array.isArray(dcData?.videos) ? dcData.videos[0]?.url : null);
      if (videoUrl && await trySendVideo(videoUrl, 'davidcyril')) break;
    } catch (_) {}

    // 2️⃣ prexzyvilla API
    try {
      const fbRes = await axios.get(`https://apis.prexzyvilla.site/download/facebook?url=${encodeURIComponent(text)}`, { timeout: 30000 });
      const fbData = fbRes.data?.result || fbRes.data?.data || fbRes.data;
      const videoUrl = fbData?.hd || fbData?.sd || fbData?.url || fbData?.video;
      if (videoUrl && await trySendVideo(videoUrl, 'prexzyvilla')) break;
    } catch (_) {}

    // 3️⃣ Cobalt API v2 (updated endpoint)
    try {
      const cobaltRes = await axios.post('https://api.cobalt.tools/', { url: text, videoQuality: '720', filenameStyle: 'basic' },
        { headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' }, timeout: 30000 });
      const dlUrl = cobaltRes.data?.url || cobaltRes.data?.tunnel;
      if (dlUrl && await trySendVideo(dlUrl, 'cobalt')) break;
    } catch (_) {}

    reply(`❌ *Facebook download failed.*\n\nThe video may be private or the link is invalid.\n_Try: ${prefix}aio <url> as an alternative._`);
  }
  break;
case '__dup_removed_ig__':  // moved to mias/index.js
case '__dup_removed_instagram__':  // moved to mias/index.js
case '__dup_removed_igdl__': {  // moved to mias/index.js
  if (!text || !text.includes('instagram.com')) {
    return reply(`📸 *Instagram Downloader*\n\nUsage: ${prefix}ig <instagram-url>\n\nSupports: Posts, Reels, Stories\n\nExample:\n${prefix}ig https://www.instagram.com/reel/...`);
  }
  await devtrust.sendMessage(m.chat, { react: { text: '⬇️', key: m.key } });
  reply('⏳ *Fetching Instagram content...*');
  try {
    const igRes = await axios.get(`https://apis.prexzyvilla.site/download/instagram?url=${encodeURIComponent(text)}`, { timeout: 30000 });
    const igData = igRes.data?.result || igRes.data?.data || igRes.data;
    const videoUrl = igData?.url || igData?.video || (Array.isArray(igData) ? igData[0]?.url : null);
    const imageUrl = igData?.image || igData?.thumbnail;
    if (videoUrl && /http/.test(videoUrl)) {
      await devtrust.sendMessage(m.chat, { video: { url: videoUrl }, mimetype: 'video/mp4', caption: '✅ *Downloaded from Instagram*' }, { quoted: m });
      await devtrust.sendMessage(m.chat, { react: { text: '✅', key: m.key } });
      break;
    }
    if (imageUrl) {
      await devtrust.sendMessage(m.chat, { image: { url: imageUrl }, caption: '✅ *Downloaded from Instagram*' }, { quoted: m });
      await devtrust.sendMessage(m.chat, { react: { text: '✅', key: m.key } });
      break;
    }
    throw new Error('No downloadable media found');
  } catch (e) {
    // Fallback via cobalt
    try {
      const cobaltRes = await axios.post('https://api.cobalt.tools/api/json', { url: text, vQuality: '720' }, { headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' }, timeout: 30000 });
      const dlUrl = cobaltRes.data?.url;
      if (dlUrl) {
        await devtrust.sendMessage(m.chat, { video: { url: dlUrl }, mimetype: 'video/mp4', caption: '✅ *Downloaded from Instagram*' }, { quoted: m });
        break;
      }
    } catch (_) {}
    reply(`❌ *Instagram download failed.*\n\nThe post may be private.\n${e.message}`);
  }
}
break;

// ═══════════════════════════════════════════════════════════
// YT — YouTube Downloader (fixed video + audio)
// ═══════════════════════════════════════════════════════════
case '__dup_removed_yt__':  // moved to mias/index.js
case 'youtube':
case '__dup_removed_ytmp4__': {  // moved to mias/index.js
  if (!text) return reply(`🎥 *YouTube Downloader*\n\nUsage: ${prefix}yt <youtube-url or title>\n\nExamples:\n${prefix}yt https://youtu.be/...\n${prefix}yt shape of you ed sheeran`);
  await devtrust.sendMessage(m.chat, { react: { text: '🎥', key: m.key } });
  reply('⏳ *Searching YouTube...*');
  try {
    let videoUrl = text;
    // If not a URL, search for it
    if (!isUrl(text)) {
      const searchResults = await yts(text);
      const first = searchResults?.videos?.[0];
      if (!first) return reply('❌ No YouTube results found for: ' + text);
      videoUrl = first.url;
      reply(`🎵 *Found:* ${first.title}\n⏱️ *Duration:* ${first.timestamp}\n👁️ *Views:* ${first.views?.toLocaleString() || 'N/A'}\n\n⬇️ *Downloading...*`);
    }
    // Download via ytdl scraper
    const ytData = await ytdl.mp4(videoUrl);
    const dlUrl = ytData?.url || ytData?.download;
    if (dlUrl) {
      await devtrust.sendMessage(m.chat, {
        video: { url: dlUrl },
        mimetype: 'video/mp4',
        caption: `✅ *YouTube Video*\n${ytData?.title || ''}`
      }, { quoted: m });
      await devtrust.sendMessage(m.chat, { react: { text: '✅', key: m.key } });
      break;
    }
    throw new Error('Download URL not found');
  } catch (e) {
    reply(`❌ *YouTube download failed.*\n\nFor audio only, try: ${prefix}ytmp3 <query>\n${e.message}`);
  }
}
break;

// ═══════════════════════════════════════════════════════════
// YTMP3 — YouTube Audio Downloader (fixed)
// ═══════════════════════════════════════════════════════════
case 'ytmp3':
case 'ytaudio': {
  if (!text) return reply(`🎵 *YouTube Audio*\n\nUsage: ${prefix}ytmp3 <youtube-url or title>\nExample: ${prefix}ytmp3 shape of you`);
  await devtrust.sendMessage(m.chat, { react: { text: '🎵', key: m.key } });
  reply('⏳ *Fetching audio...*');
  try {
    let videoUrl = text;
    if (!isUrl(text)) {
      const searchResults = await yts(text);
      const first = searchResults?.videos?.[0];
      if (!first) return reply('❌ No YouTube results found.');
      videoUrl = first.url;
    }
    const ytData = await ytdl.mp3(videoUrl);
    const dlUrl = ytData?.url || ytData?.download;
    if (dlUrl) {
      await devtrust.sendMessage(m.chat, {
        audio: { url: dlUrl },
        mimetype: 'audio/mp4',
        ptt: false,
        fileName: `${ytData?.title || 'audio'}.mp3`
      }, { quoted: m });
      await devtrust.sendMessage(m.chat, { react: { text: '✅', key: m.key } });
      break;
    }
    throw new Error('Audio URL not found');
  } catch (e) {
    reply(`❌ *YouTube audio failed.*\n${e.message}`);
  }
}
break;

// ═══════════════════════════════════════════════════════════
// SPOTIFY — Spotify Track Downloader (fixed audio corruption)
// ═══════════════════════════════════════════════════════════
case '__dup_removed_spotify__':  // moved to mias/index.js
  case '__dup_removed_spot__':  // moved to mias/index.js
  case 'spdl': {
    if (!text) return reply(`🎵 *Spotify Downloader*\n\nUsage: ${prefix}spotify <song name or Spotify URL>\n\nExamples:\n${prefix}spotify Shape of You\n${prefix}spotify https://open.spotify.com/track/...`);
    await devtrust.sendMessage(m.chat, { react: { text: '🎵', key: m.key } });
    reply('⏳ *Searching Spotify...*');
    try {
      let title = text, artist = '';
      if (text.includes('spotify.com/track/')) {
        const trackId = text.match(/track\/([a-zA-Z0-9]+)/)?.[1];
        if (trackId) {
          try {
            const infoRes = await axios.get(`https://apis.davidcyril.name.ng/spotify/track?id=${trackId}`, { timeout: 15000 });
            const d = infoRes.data?.result || infoRes.data?.data || infoRes.data;
            title = d?.name || d?.title || title;
            artist = d?.artists?.[0]?.name || d?.artist || '';
          } catch (_) {
            try {
              const r2 = await axios.get(`https://apis.prexzyvilla.site/music/spotify?id=${trackId}`, { timeout: 15000 });
              const d2 = r2.data?.result || r2.data;
              title = d2?.name || title;
              artist = d2?.artists?.[0]?.name || '';
            } catch (_2) {}
          }
        }
      }
      const searchQuery = artist ? `${title} ${artist}` : title;

      // 1️⃣ davidcyril direct Spotify download
      let audioBuf = null, songTitle = title;
      try {
        const dcUrl = text.includes('spotify.com') ? text : null;
        if (dcUrl) {
          const dcR = await axios.get(`https://apis.davidcyril.name.ng/download/spotify?url=${encodeURIComponent(dcUrl)}`, { timeout: 40000 });
          const dcData = dcR.data?.result || dcR.data?.data || dcR.data;
          const dcAudio = dcData?.url || dcData?.audio || dcData?.download;
          songTitle = dcData?.title || dcData?.name || title;
          if (dcAudio) {
            audioBuf = await getBuffer(dcAudio, { timeout: 60000 });
            if (audioBuf && audioBuf.length < 50000) audioBuf = null;
          }
        }
      } catch (_) {}

      // 2️⃣ YouTube search + ytdl
      if (!audioBuf) {
        const searchResults = await yts(searchQuery);
        const found = searchResults?.videos?.[0];
        if (!found) return reply(`❌ Could not find "${searchQuery}" on YouTube.`);
        songTitle = found.title || title;
        reply(`🎵 *Found:* ${found.title}\n⏱️ *Duration:* ${found.timestamp}\n\n⬇️ *Downloading...*`);
        // Try ytdl mp3
        try {
          const ytData = await ytdl.mp3(found.url);
          const audioUrl = ytData?.url || ytData?.download;
          if (audioUrl) {
            audioBuf = await getBuffer(audioUrl, { responseType: 'arraybuffer', timeout: 60000 });
            if (audioBuf && audioBuf.length < 50000) audioBuf = null;
          }
        } catch (_) {}
        // 3️⃣ prexzyvilla ytmp3 fallback
        if (!audioBuf) {
          try {
            const pR = await axios.get(`https://apis.prexzyvilla.site/download/ytmp3?url=${encodeURIComponent(found.url)}`, { timeout: 40000 });
            const pData = pR.data?.result || pR.data?.data || pR.data;
            const pUrl = pData?.url || pData?.audio || pData?.download;
            if (pUrl) {
              audioBuf = await getBuffer(pUrl, { timeout: 60000 });
              if (audioBuf && audioBuf.length < 50000) audioBuf = null;
            }
          } catch (_) {}
        }
      }

      if (!audioBuf || audioBuf.length < 50000) throw new Error('All audio sources failed or returned corrupt data');
      await devtrust.sendMessage(m.chat, {
        audio: audioBuf,
        mimetype: 'audio/mpeg',
        ptt: false,
        fileName: `${songTitle.replace(/[^a-zA-Z0-9 ]/g, '')}.mp3`
      }, { quoted: m });
      await devtrust.sendMessage(m.chat, { react: { text: '✅', key: m.key } });
    } catch (e) {
      reply(`❌ *Spotify download failed.*\n${e.message}`);
    }
  }
  break;
case '__dup_removed_adult__':  // moved to mias/index.js
  case 'r18':
  case 'nsfw': {
    if (m.isGroup) return reply('❌ *Adult content is only available in private chats.*\n\nSend this command in DM.');
    const adultCat = args[0]?.toLowerCase() || 'random';
    await devtrust.sendMessage(m.chat, { react: { text: '🔞', key: m.key } });
    try {
      // waifu.pics NSFW images (reliable, always images)
      const nsfwTypes = ['waifu','neko','trap','blowjob'];
      const nsfwType = nsfwTypes[Math.floor(Math.random() * nsfwTypes.length)];
      try {
        const waifuRes = await axios.get(`https://api.waifu.pics/nsfw/${nsfwType}`, { timeout: 15000 });
        const imgUrl = waifuRes.data?.url;
        if (imgUrl) {
          const imgBuf = await getBuffer(imgUrl, { timeout: 25000 });
          if (imgBuf && imgBuf.length > 5000) {
            await devtrust.sendMessage(m.chat, { image: imgBuf, caption: `🔞 *Adult Content*\n_Category: ${nsfwType}_` }, { quoted: m });
            break;
          }
        }
      } catch (_) {}

      // Rule34 — images only, skip webm/mp4 (they don't play reliably on WA)
      const safeCategories = ['hentai','anime','cartoon','ecchi','milf','ass','boobs','nude','blowjob'];
      const catQuery = safeCategories.includes(adultCat) ? adultCat : safeCategories[Math.floor(Math.random() * safeCategories.length)];
      const r34Res = await axios.get(`https://rule34.xxx/index.php?page=dapi&s=post&q=index&json=1&tags=${encodeURIComponent(catQuery)}+-webm+-video&limit=30`, { timeout: 15000 });
      const posts = r34Res.data;
      if (Array.isArray(posts) && posts.length) {
        // Pick random from first 15 results
        const imagePosts = posts.filter(p => /\.(jpg|jpeg|png|gif)$/i.test(p.file_url || p.jpeg_url || ''));
        const post = imagePosts[Math.floor(Math.random() * Math.min(imagePosts.length, 15))] || posts[0];
        const postUrl = post.file_url || post.jpeg_url || post.sample_url;
        if (postUrl && /\.(jpg|jpeg|png|gif)$/i.test(postUrl)) {
          const imgBuf = await getBuffer(postUrl, { timeout: 30000, headers: { 'Referer': 'https://rule34.xxx/' } });
          if (imgBuf && imgBuf.length > 5000) {
            await devtrust.sendMessage(m.chat, { image: imgBuf, caption: `🔞 *Adult Content*\n_Category: ${catQuery} | Rule34_` }, { quoted: m });
            break;
          }
        }
      }
      reply('❌ Could not fetch adult content right now. Try again later.');
    } catch (e) {
      reply(`❌ Adult content fetch failed: ${e.message}`);
    }
  }
  break;
case '__dup_removed_rule34__': {  // moved to mias/index.js
  if (m.isGroup) return reply('❌ *Adult content is only available in private chats.*');
  const r34Tag = args.join('+') || 'anime';
  await devtrust.sendMessage(m.chat, { react: { text: '🔞', key: m.key } });
  try {
    const r34Res = await axios.get(`https://rule34.xxx/index.php?page=dapi&s=post&q=index&json=1&tags=${encodeURIComponent(r34Tag)}&limit=30`, { timeout: 15000 });
    const r34Posts = r34Res.data;
    if (!Array.isArray(r34Posts) || !r34Posts.length) return reply(`❌ No results for tag: _${r34Tag}_`);
    const r34Post = r34Posts[Math.floor(Math.random() * Math.min(r34Posts.length, 20))];
    const r34Url = r34Post.file_url || r34Post.jpeg_url;
    if (!r34Url) return reply('❌ No media URL found.');
    if (/\.(mp4|webm)$/i.test(r34Url)) {
      await devtrust.sendMessage(m.chat, { video: { url: r34Url }, mimetype: 'video/mp4', caption: `🔞 *Rule34*\nTag: _${r34Tag}_\nScore: ${r34Post.score || 'N/A'}` }, { quoted: m });
    } else {
      await devtrust.sendMessage(m.chat, { image: { url: r34Url }, caption: `🔞 *Rule34*\nTag: _${r34Tag}_\nScore: ${r34Post.score || 'N/A'}` }, { quoted: m });
    }
  } catch (e) {
    reply(`❌ Rule34 failed: ${e.message}`);
  }
}
break;

case '__dup_removed_neko__':  // moved to mias/index.js
case 'nekopara': {
  await devtrust.sendMessage(m.chat, { react: { text: '😺', key: m.key } });
  try {
    const r = await princeGet('/api/anime/neko');
    if (r.ok && r.data?.success && r.data.result) {
      const imgUrl = typeof r.data.result === 'string' ? r.data.result : r.data.result?.url;
      if (imgUrl) {
        const buf = await getBuffer(imgUrl, { timeout: 20000 });
        return await devtrust.sendMessage(m.chat, { image: buf, caption: '😺 *Neko*' }, { quoted: m });
      }
    }
    // Fallback
    const nekoRes = await axios.get('https://api.waifu.pics/sfw/neko', { timeout: 10000 });
    const nekoUrl = nekoRes.data?.url;
    if (nekoUrl) {
      const nBuf = await getBuffer(nekoUrl, { timeout: 15000 });
      return await devtrust.sendMessage(m.chat, { image: nBuf, caption: '😺 *Neko*' }, { quoted: m });
    }
    reply('❌ Could not fetch neko image right now.');
  } catch (e) { reply(`❌ Neko failed: ${e.message}`); }
}
break;

// ═══════════════════════════════════════════════════════════
// BLOCK / UNBLOCK — with creator protection
// ═══════════════════════════════════════════════════════════
case '__dup_removed_block__':  // moved to mias/index.js
  case 'blockuser': {
    if (!isCreator) return reply('❌ Only the bot owner or sudo users can block contacts.');
    let targetJid;
    if (m.quoted) {
      targetJid = m.quoted.sender;
    } else if (m.mentionedJid && m.mentionedJid[0]) {
      targetJid = m.mentionedJid[0];
    } else if (text) {
      targetJid = text.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
    } else {
      return reply(`⛔ *Block User*\n\nUsage: ${prefix}block @tag\nOr reply to a message with ${prefix}block`);
    }
    // Strip device suffix (:0 :1 etc) — fixes "bad request" in newer Baileys
    try {
      const rawNum = (targetJid.split('@')[0] || '').split(':')[0].replace(/[^0-9]/g, '');
      if (!rawNum) return reply('❌ Could not resolve target number.');
      targetJid = rawNum + '@s.whatsapp.net';
      if (typeof jidNormalizedUser === 'function') targetJid = jidNormalizedUser(targetJid);
    } catch (_) {}
    const protectedNumbers = [botNumber, ...owner].map(v => v.replace(/[^0-9]/g, '') + '@s.whatsapp.net');
    if (protectedNumbers.includes(targetJid)) return reply('⚠️ You cannot block the bot creator/owner.');
    await devtrust.sendMessage(m.chat, { react: { text: '🚫', key: m.key } });
      // v15 FIX: onWhatsApp lookup + multi-variant + IQ fallback + local bot-block
      try {
        if (typeof devtrust.onWhatsApp === 'function') {
          const _waR = await devtrust.onWhatsApp(targetJid.split('@')[0]).catch(() => []);
          const _waH = (_waR || [])[0];
          if (_waH?.exists && _waH?.jid) targetJid = _waH.jid;
        }
      } catch (_) {}
      const _bVars = Array.from(new Set([
        targetJid,
        targetJid.replace('@s.whatsapp.net', '@lid'),
      ].filter(v => v && v.includes('@'))));
      let _bDone = false;
      for (const _bj of _bVars) {
        try { await devtrust.updateBlockStatus(_bj, 'block'); _bDone = true; break; }
        catch (e) { try { console.error('[block]', _bj, e?.message); } catch {} }
      }
      if (!_bDone && typeof devtrust.query === 'function') {
        for (const _bj of _bVars) {
          try {
            await devtrust.query({ tag: 'iq', attrs: { xmlns: 'blocklist', type: 'set', to: '@s.whatsapp.net' }, content: [{ tag: 'item', attrs: { action: 'block', jid: _bj } }] });
            _bDone = true; break;
          } catch (_) {}
        }
      }
      if (_bDone) {
        await devtrust.sendMessage(m.chat, { react: { text: '✅', key: m.key } });
        reply(`✅ *@${targetJid.split('@')[0]} has been blocked.*`, { mentions: [targetJid] });
      } else {
        if (!globalThis._localBlockList) globalThis._localBlockList = new Set();
        _bVars.forEach(v => globalThis._localBlockList.add(v));
        await devtrust.sendMessage(m.chat, { react: { text: '⚠️', key: m.key } });
        reply(
          `⚠️ *WhatsApp rejected the block* for @${targetJid.split('@')[0]}.\n\n` +
          `Business/bot/protected accounts cannot be device-blocked via API.\n` +
          `✅ *Bot-level block applied* — bot will ignore all messages from this contact.`,
          { mentions: [targetJid] }
        );
      }
    }
    break;
case '__dup_removed_unblock__':  // moved to mias/index.js
  case 'unblockuser': {
    if (!isCreator) return reply('❌ Only the bot owner or sudo users can unblock contacts.');
    let targetJid;
    if (m.quoted) {
      targetJid = m.quoted.sender;
    } else if (m.mentionedJid && m.mentionedJid[0]) {
      targetJid = m.mentionedJid[0];
    } else if (text) {
      targetJid = text.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
    } else {
      return reply(`✅ *Unblock User*\n\nUsage: ${prefix}unblock @tag\nOr reply to a message with ${prefix}unblock`);
    }
    // Strip device suffix (:0 :1 etc) — fixes "bad request" in newer Baileys
    try {
      const rawNum = (targetJid.split('@')[0] || '').split(':')[0].replace(/[^0-9]/g, '');
      if (!rawNum) return reply('❌ Could not resolve target number.');
      targetJid = rawNum + '@s.whatsapp.net';
      if (typeof jidNormalizedUser === 'function') targetJid = jidNormalizedUser(targetJid);
    } catch (_) {}
    await devtrust.sendMessage(m.chat, { react: { text: '🔓', key: m.key } });
      // v15 FIX: multi-variant + IQ fallback + remove from local block list
      const _ubVars = Array.from(new Set([
        targetJid,
        targetJid.replace('@s.whatsapp.net', '@lid'),
      ].filter(v => v && v.includes('@'))));
      let _ubDone = false;
      for (const _uj of _ubVars) {
        try { await devtrust.updateBlockStatus(_uj, 'unblock'); _ubDone = true; break; } catch {}
      }
      if (!_ubDone && typeof devtrust.query === 'function') {
        for (const _uj of _ubVars) {
          try {
            await devtrust.query({ tag: 'iq', attrs: { xmlns: 'blocklist', type: 'set', to: '@s.whatsapp.net' }, content: [{ tag: 'item', attrs: { action: 'unblock', jid: _uj } }] });
            _ubDone = true; break;
          } catch {}
        }
      }
      if (globalThis._localBlockList) _ubVars.forEach(v => globalThis._localBlockList.delete(v));
      if (_ubDone) {
        await devtrust.sendMessage(m.chat, { react: { text: '✅', key: m.key } });
        reply(`✅ *@${targetJid.split('@')[0]} has been unblocked.*`, { mentions: [targetJid] });
      } else {
        await devtrust.sendMessage(m.chat, { react: { text: '✅', key: m.key } });
        reply(
          `✅ *Bot-level block removed* for @${targetJid.split('@')[0]}.\n` +
          `_WA API unblock failed — also remove them from your phone's block list manually._`,
          { mentions: [targetJid] }
        );
      }
  }
  break;
case '__dup_removed_video__': {  // moved to mias/index.js
    if (!text || !isUrl(text)) return reply(`🎬 *Send Video*\n\nUsage: ${prefix}video <direct-video-url>\nExample: ${prefix}video https://example.com/video.mp4`);
    await devtrust.sendMessage(m.chat, { react: { text: '🎬', key: m.key } });
    reply('⏳ *Fetching video...*');
    try {
      // Download with content-type check
      const vidRes = await axios.get(text, { responseType: 'arraybuffer', timeout: 90000, maxContentLength: 60 * 1024 * 1024,
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'video/*,*/*' } });
      const contentType = vidRes.headers?.['content-type'] || '';
      const vidBuf = Buffer.from(vidRes.data);
      if (!vidBuf || vidBuf.length < 10000) throw new Error('Video too small or unavailable');
      // Determine correct mimetype
      let vidMime = 'video/mp4';
      if (/webm/.test(contentType)) vidMime = 'video/webm';
      else if (/mp4/.test(contentType)) vidMime = 'video/mp4';
      // WhatsApp plays mp4 best — force mp4 mimetype for sendMessage
      await devtrust.sendMessage(m.chat, {
        video: vidBuf,
        mimetype: 'video/mp4',
        caption: '✅ *Video ready*'
      }, { quoted: m });
      await devtrust.sendMessage(m.chat, { react: { text: '✅', key: m.key } });
    } catch (e) {
      // Streaming fallback via URL
      try {
        await devtrust.sendMessage(m.chat, { video: { url: text }, mimetype: 'video/mp4', caption: '✅ *Video ready*' }, { quoted: m });
        await devtrust.sendMessage(m.chat, { react: { text: '✅', key: m.key } });
      } catch (_) {
        reply(`❌ Video failed: ${e.message}\n_Only direct .mp4 URLs are supported._`);
      }
    }
  }
  break;
// ╔══════════════════════════════════════════════════════════════════╗
// ║          PRINCE API — ALL ENDPOINTS WIRED                      ║
// ║  Base: https://api.princetechn.com  Key: prince               ║
// ╚══════════════════════════════════════════════════════════════════╝

// ─────────────────────────── AI COMMANDS (gpt/ai/gpt4 handled above) ───────────────────────────


  // ═══════════════════════════════════════════════════════════
  // ARCHIVE / UNARCHIVE — chatModify with lastMessages fix
  // ═══════════════════════════════════════════════════════════
  case '__dup_removed_archive__': {  // moved to mias/index.js
    if (!isCreator) return reply('❌ Only the bot owner can archive chats.');
    const targetChat = m.quoted?.sender || text?.replace(/[^0-9]/g,'') + '@s.whatsapp.net' || m.chat;
    try {
      await devtrust.chatModify({ archive: true, lastMessages: [] }, targetChat);
      reply('✅ *Chat archived successfully.*');
    } catch (e) { reply(`❌ Archive failed: ${e.message}`); }
  }
  break;

  case '__dup_removed_unarchive__': {  // moved to mias/index.js
    if (!isCreator) return reply('❌ Only the bot owner can unarchive chats.');
    const targetChat2 = m.quoted?.sender || text?.replace(/[^0-9]/g,'') + '@s.whatsapp.net' || m.chat;
    try {
      await devtrust.chatModify({ archive: false, lastMessages: [] }, targetChat2);
      reply('✅ *Chat unarchived successfully.*');
    } catch (e) { reply(`❌ Unarchive failed: ${e.message}`); }
  }
  break;

  // ═══════════════════════════════════════════════════════════
  // PINCHAT / UNPINCHAT — pin or unpin a chat
  // ═══════════════════════════════════════════════════════════
  case 'pinchat': {
    if (!isCreator) return reply('❌ Only the bot owner can pin chats.');
    const pinTarget = text?.replace(/[^0-9]/g,'') ? text.replace(/[^0-9]/g,'') + '@s.whatsapp.net' : m.chat;
    try {
      const pinTs = Math.floor(Date.now() / 1000);
      await devtrust.chatModify({ pin: pinTs }, pinTarget);
      reply('📌 *Chat pinned successfully.*');
    } catch (e) { reply(`❌ Pin failed: ${e.message}`); }
  }
  break;

  case 'unpinchat': {
    if (!isCreator) return reply('❌ Only the bot owner can unpin chats.');
    const unpinTarget = text?.replace(/[^0-9]/g,'') ? text.replace(/[^0-9]/g,'') + '@s.whatsapp.net' : m.chat;
    try {
      await devtrust.chatModify({ pin: null }, unpinTarget);
      reply('📌 *Chat unpinned successfully.*');
    } catch (e) { reply(`❌ Unpin failed: ${e.message}`); }
  }
  break;

  case '__dup_removed_gpt4o__': {  // moved to mias/index.js
  if (!text) return reply(`🤖 *GPT-4o*\n\nUsage: ${prefix}gpt4o <question>`);
  await devtrust.sendMessage(m.chat, { react: { text: '✨', key: m.key } });
  try {
    const r = await princeGet('/api/ai/gpt4o', { q: text });
    if (r.ok && r.data?.success) return reply(`✨ *GPT-4o*\n\n${r.data.result}`);
    const r2 = await princeGet('/api/ai/gpt4o-mini', { q: text });
    if (r2.ok && r2.data?.success) return reply(`✨ *GPT-4o Mini*\n\n${r2.data.result}`);
    reply('❌ GPT-4o unavailable right now.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case '__dup_removed_mistral__': {  // moved to mias/index.js
  if (!text) return reply(`🌪️ *Mistral AI*\n\nUsage: ${prefix}mistral <question>`);
  await devtrust.sendMessage(m.chat, { react: { text: '🌪️', key: m.key } });
  try {
    const r = await princeGet('/api/ai/mistral', { q: text });
    if (r.ok && r.data?.success) return reply(`🌪️ *Mistral AI*\n\n${r.data.result}`);
    reply('❌ Mistral AI unavailable right now.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case '__dup_removed_deepseek__':  // moved to mias/index.js
case '__dup_removed_deepseekv3__': {  // moved to mias/index.js
  if (!text) return reply(`🔍 *DeepSeek V3*\n\nUsage: ${prefix}deepseek <question>`);
  await devtrust.sendMessage(m.chat, { react: { text: '🔍', key: m.key } });
  try {
    const r = await princeGet('/api/ai/deepseek-v3', { q: text });
    if (r.ok && r.data?.success) return reply(`🔍 *DeepSeek V3*\n\n${r.data.result}`);
    reply('❌ DeepSeek unavailable right now.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case '__dup_removed_deepseek-r1__':  // moved to mias/index.js
case '__dup_removed_deepseekr1__': {  // moved to mias/index.js
  if (!text) return reply(`🔬 *DeepSeek R1*\n\nUsage: ${prefix}deepseeK-r1 <question>`);
  await devtrust.sendMessage(m.chat, { react: { text: '🔬', key: m.key } });
  try {
    const r = await princeGet('/api/ai/deepseek-r1', { q: text });
    if (r.ok && r.data?.success) return reply(`🔬 *DeepSeek R1*\n\n${r.data.result}`);
    reply('❌ DeepSeek R1 unavailable right now.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case '__dup_removed_blackbox__': {  // moved to mias/index.js
  if (!text) return reply(`🖤 *Blackbox AI*\n\nUsage: ${prefix}blackbox <question>`);
  await devtrust.sendMessage(m.chat, { react: { text: '🖤', key: m.key } });
  try {
    const r = await princeGet('/api/ai/blackbox', { q: text });
    if (r.ok && r.data?.success) return reply(`🖤 *Blackbox AI*\n\n${r.data.result}`);
    reply('❌ Blackbox AI unavailable right now.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case '__dup_removed_gemini__': {  // moved to mias/index.js
  if (!text) return reply(`💎 *Gemini AI*\n\nUsage: ${prefix}gemini <question>`);
  await devtrust.sendMessage(m.chat, { react: { text: '💎', key: m.key } });
  try {
    const r = await princeGet('/api/ai/geminiai', { q: text });
    if (r.ok && r.data?.success) return reply(`💎 *Gemini AI*\n\n${r.data.result}`);
    const r2 = await princeGet('/api/ai/geminiaipro', { q: text });
    if (r2.ok && r2.data?.success) return reply(`💎 *Gemini Pro*\n\n${r2.data.result}`);
    reply('❌ Gemini AI unavailable right now.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case '__dup_removed_letmegpt__': {  // moved to mias/index.js
  if (!text) return reply(`🤔 *LetMeGPT*\n\nUsage: ${prefix}letmegpt <question>`);
  await devtrust.sendMessage(m.chat, { react: { text: '🤔', key: m.key } });
  try {
    const r = await princeGet('/api/ai/letmegpt', { q: text });
    if (r.ok && r.data?.success) return reply(`🤔 *LetMeGPT*\n\n${r.data.result}`);
    reply('❌ LetMeGPT unavailable right now.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case '__dup_removed_imagine__':  // moved to mias/index.js
case '__dup_removed_txt2img__':  // moved to mias/index.js
case '__dup_removed_texttoimage__': {  // moved to mias/index.js
  if (!text) return reply(`🎨 *AI Image Generator*\n\nUsage: ${prefix}imagine <description>\nExample: ${prefix}imagine a dragon flying over a city at night`);
  await devtrust.sendMessage(m.chat, { react: { text: '🎨', key: m.key } });
  reply('🎨 *Generating image...* Please wait (this may take up to 30s)');
  try {
    const r = await princeGet('/api/ai/text2img', { q: text });
    if (r.ok && r.data?.success && r.data.result) {
      const imgUrl = typeof r.data.result === 'string' ? r.data.result : r.data.result?.url || r.data.result?.image;
      if (imgUrl) {
        await devtrust.sendMessage(m.chat, { image: { url: imgUrl }, caption: `🎨 *AI Image*\n_Prompt: ${text.slice(0, 80)}_` }, { quoted: m });
        return;
      }
    }
    // Fallback: flux
    const r2 = await princeGet('/api/ai/fluximg', { q: text });
    if (r2.ok && r2.data?.success && r2.data.result) {
      const imgUrl2 = typeof r2.data.result === 'string' ? r2.data.result : r2.data.result?.url;
      if (imgUrl2) {
        await devtrust.sendMessage(m.chat, { image: { url: imgUrl2 }, caption: `🎨 *Flux AI Image*\n_Prompt: ${text.slice(0, 80)}_` }, { quoted: m });
        return;
      }
    }
    reply('❌ Image generation failed. Try again with a different prompt.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case '__dup_removed_flux__': {  // moved to mias/index.js
  if (!text) return reply(`⚡ *Flux AI Image*\n\nUsage: ${prefix}flux <description>`);
  await devtrust.sendMessage(m.chat, { react: { text: '⚡', key: m.key } });
  reply('⚡ *Generating with Flux...* Please wait');
  try {
    const r = await princeGet('/api/ai/fluximg', { q: text });
    if (r.ok && r.data?.success && r.data.result) {
      const imgUrl = typeof r.data.result === 'string' ? r.data.result : r.data.result?.url;
      if (imgUrl) return await devtrust.sendMessage(m.chat, { image: { url: imgUrl }, caption: `⚡ *Flux AI*\n_${text.slice(0, 80)}_` }, { quoted: m });
    }
    reply('❌ Flux failed. Try again later.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'sd':
case 'stablediffusion': {
  if (!text) return reply(`🖼️ *Stable Diffusion*\n\nUsage: ${prefix}sd <description>`);
  await devtrust.sendMessage(m.chat, { react: { text: '🖼️', key: m.key } });
  reply('🖼️ *Generating with SD...* Please wait');
  try {
    const r = await princeGet('/api/ai/sd', { q: text });
    if (r.ok && r.data?.success && r.data.result) {
      const imgUrl = typeof r.data.result === 'string' ? r.data.result : r.data.result?.url;
      if (imgUrl) return await devtrust.sendMessage(m.chat, { image: { url: imgUrl }, caption: `🖼️ *Stable Diffusion*\n_${text.slice(0, 80)}_` }, { quoted: m });
    }
    reply('❌ Stable Diffusion failed. Try again later.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case '__dup_removed_tts__':  // moved to mias/index.js
  case 'texttospeech':
  case 'speak': {
    if (!text) return reply(`🔊 *Text to Speech*\n\nUsage: ${prefix}tts <text>\nExample: ${prefix}tts Hello everyone welcome`);
    await devtrust.sendMessage(m.chat, { react: { text: '🔊', key: m.key } });
    const ttsText = text.slice(0, 250);
    let audioBuf = null;

    // 1️⃣ davidcyril TTS
    try {
      const dcR = await axios.get(`https://apis.davidcyril.name.ng/tts?text=${encodeURIComponent(ttsText)}&lang=en`, { timeout: 20000, responseType: 'arraybuffer' });
      if (dcR.data && dcR.data.byteLength > 3000) audioBuf = Buffer.from(dcR.data);
    } catch (_) {}

    // 2️⃣ StreamElements TTS (very reliable)
    if (!audioBuf) {
      try {
        const seUrl = `https://api.streamelements.com/kappa/v2/speech?voice=Brian&text=${encodeURIComponent(ttsText)}`;
        const seR = await axios.get(seUrl, { timeout: 20000, responseType: 'arraybuffer' });
        if (seR.data && seR.data.byteLength > 3000) audioBuf = Buffer.from(seR.data);
      } catch (_) {}
    }

    // 3️⃣ VoiceRSS TTS
    if (!audioBuf) {
      try {
        const vrR = await axios.get(`https://api.voicerss.org/?key=&hl=en-us&src=${encodeURIComponent(ttsText)}&c=MP3&f=16khz_16bit_stereo`, { timeout: 20000, responseType: 'arraybuffer' });
        if (vrR.data && vrR.data.byteLength > 3000) audioBuf = Buffer.from(vrR.data);
      } catch (_) {}
    }

    // 4️⃣ Prince API TTS
    if (!audioBuf) {
      try {
        const r = await princeGet('/api/ai/tts', { text: ttsText });
        const audioUrl = (typeof r.data?.result === 'string') ? r.data.result : r.data?.result?.url || r.data?.result?.audio;
        if (audioUrl) {
          audioBuf = await getBuffer(audioUrl, { timeout: 30000 });
          if (audioBuf && audioBuf.length < 3000) audioBuf = null;
        }
      } catch (_) {}
    }

    // 5️⃣ Google TTS (last resort — mp3 redirect)
    if (!audioBuf) {
      try {
        const gttsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(ttsText.slice(0,200))}&tl=en&client=tw-ob`;
        audioBuf = await getBuffer(gttsUrl, { timeout: 20000, headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (audioBuf && audioBuf.length < 3000) audioBuf = null;
      } catch (_) {}
    }

    if (!audioBuf || audioBuf.length < 3000) return reply('❌ TTS failed — all sources unavailable. Try again later.');
    try {
      await devtrust.sendMessage(m.chat, { audio: audioBuf, mimetype: 'audio/mpeg', ptt: false, fileName: 'tts.mp3' }, { quoted: m });
      await devtrust.sendMessage(m.chat, { react: { text: '✅', key: m.key } });
    } catch (e) { reply(`❌ TTS send error: ${e.message}`); }
  }
  break;
// ─────────────────────────── FUN COMMANDS ───────────────────────────

case '__dup_removed_advice__': {  // moved to mias/index.js
  await devtrust.sendMessage(m.chat, { react: { text: '💡', key: m.key } });
  try {
    const res = await princeFun('advice');
    reply(`💡 *Advice of the Day*\n\n${res || '❌ Could not fetch advice right now.'}`);
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'flirt':
case 'flirtline': {
  await devtrust.sendMessage(m.chat, { react: { text: '😍', key: m.key } });
  try {
    const res = await princeFun('flirt');
    reply(`😍 *Flirt Line*\n\n_${res || '❌ Could not fetch flirt line.'}_`);
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case '__dup_removed_joke__':  // moved to mias/index.js
case 'jokes': {
  await devtrust.sendMessage(m.chat, { react: { text: '😂', key: m.key } });
  try {
    const r = await princeGet('/api/fun/jokes');
    if (r.ok && r.data?.success) {
      const res = r.data.result;
      if (res?.setup && res?.punchline) return reply(`😂 *Joke*\n\n${res.setup}\n\n_${res.punchline}_`);
      return reply(`😂 *Joke*\n\n${typeof res === 'string' ? res : JSON.stringify(res)}`);
    }
    reply('❌ Could not fetch a joke right now.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'love':
case 'lovemessage': {
  await devtrust.sendMessage(m.chat, { react: { text: '❤️', key: m.key } });
  try {
    const res = await princeFun('love');
    reply(`❤️ *Love Message*\n\n_${res || '❌ Could not fetch love message.'}_`);
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'motivation':
case 'motivate': {
  await devtrust.sendMessage(m.chat, { react: { text: '💪', key: m.key } });
  try {
    const res = await princeFun('motivation');
    reply(`💪 *Motivation*\n\n_${res || '❌ Could not fetch motivation.'}_`);
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'quote':
case 'quotes': {
  await devtrust.sendMessage(m.chat, { react: { text: '📜', key: m.key } });
  try {
    const res = await princeFun('quotes');
    reply(`📜 *Quote*\n\n_"${res || 'No quote available.'}"_`);
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case '__dup_removed_pickupline__':  // moved to mias/index.js
case '__dup_removed_pickup__': {  // moved to mias/index.js
  await devtrust.sendMessage(m.chat, { react: { text: '😘', key: m.key } });
  try {
    const res = await princeFun('pickupline');
    reply(`😘 *Pickup Line*\n\n_${res || 'No pickup line available.'}_`);
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case '__dup_removed_truth__': {  // moved to mias/index.js
  await devtrust.sendMessage(m.chat, { react: { text: '🎯', key: m.key } });
  try {
    const res = await princeFun('truth');
    reply(`🎯 *Truth Question*\n\n${res || 'No truth question available.'}`);
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case '__dup_removed_dare__':  // moved to mias/index.js
case 'dares': {
  await devtrust.sendMessage(m.chat, { react: { text: '🔥', key: m.key } });
  try {
    const res = await princeFun('dares');
    reply(`🔥 *Dare Challenge*\n\n${res || 'No dare available.'}`);
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'heartbreak': {
  await devtrust.sendMessage(m.chat, { react: { text: '💔', key: m.key } });
  try {
    const res = await princeFun('heartbreak');
    reply(`💔 *Heartbreak Quote*\n\n_${res || 'No heartbreak quote.'}_`);
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'shayari': {
  await devtrust.sendMessage(m.chat, { react: { text: '📝', key: m.key } });
  try {
    const res = await princeFun('shayari');
    reply(`📝 *Shayari*\n\n_${res || 'No shayari available.'}_`);
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'goodnight':
case 'gn': {
  await devtrust.sendMessage(m.chat, { react: { text: '🌙', key: m.key } });
  try {
    const res = await princeFun('goodnight');
    reply(`🌙 *Good Night*\n\n_${res || 'Good night! Sweet dreams. 🌟'}_`);
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'gratitude':
case 'thankful': {
  await devtrust.sendMessage(m.chat, { react: { text: '🙏', key: m.key } });
  try {
    const res = await princeFun('gratitude');
    reply(`🙏 *Gratitude*\n\n_${res || 'Be grateful for what you have.'}_`);
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'friendship':
case 'friendquote': {
  await devtrust.sendMessage(m.chat, { react: { text: '🤝', key: m.key } });
  try {
    const res = await princeFun('friendship');
    reply(`🤝 *Friendship Quote*\n\n_${res || 'A true friend is a treasure.'}_`);
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'newyear':
case 'happynewyear': {
  await devtrust.sendMessage(m.chat, { react: { text: '🎆', key: m.key } });
  try {
    const res = await princeFun('newyear');
    reply(`🎆 *New Year Message*\n\n_${res || 'Happy New Year! May this year bring joy!'}_`);
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'christmas':
case 'xmas': {
  await devtrust.sendMessage(m.chat, { react: { text: '🎄', key: m.key } });
  try {
    const res = await princeFun('christmas');
    reply(`🎄 *Christmas Message*\n\n_${res || 'Merry Christmas! 🎅'}_`);
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'halloween': {
  await devtrust.sendMessage(m.chat, { react: { text: '🎃', key: m.key } });
  try {
    const res = await princeFun('halloween');
    reply(`🎃 *Halloween*\n\n_${res || 'Boo! Happy Halloween! 👻'}_`);
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'valentine':
case 'valentines': {
  await devtrust.sendMessage(m.chat, { react: { text: '💝', key: m.key } });
  try {
    const res = await princeFun('valentines');
    reply(`💝 *Valentine's Day*\n\n_${res || 'Happy Valentine\'s Day! ❤️'}_`);
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'roseday': {
  await devtrust.sendMessage(m.chat, { react: { text: '🌹', key: m.key } });
  try {
    const res = await princeFun('roseday');
    reply(`🌹 *Rose Day*\n\n_${res || 'Happy Rose Day! 🌹'}_`);
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'mothersday':
case 'happymothersday': {
  await devtrust.sendMessage(m.chat, { react: { text: '👩', key: m.key } });
  try {
    const res = await princeFun('mothersday');
    reply(`👩 *Mother's Day*\n\n_${res || 'Happy Mother\'s Day! You are amazing! 💕'}_`);
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'fathersday':
case 'happyfathersday': {
  await devtrust.sendMessage(m.chat, { react: { text: '👨', key: m.key } });
  try {
    const res = await princeFun('fathersday');
    reply(`👨 *Father's Day*\n\n_${res || 'Happy Father\'s Day! 💪'}_`);
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'boyfriendsday': {
  await devtrust.sendMessage(m.chat, { react: { text: '💑', key: m.key } });
  try {
    const res = await princeFun('boyfriendsday');
    reply(`💑 *Boyfriend's Day*\n\n_${res || 'Happy Boyfriend\'s Day! 💙'}_`);
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'girlfriendsday': {
  await devtrust.sendMessage(m.chat, { react: { text: '💏', key: m.key } });
  try {
    const res = await princeFun('girlfriendsday');
    reply(`💏 *Girlfriend's Day*\n\n_${res || 'Happy Girlfriend\'s Day! 💗'}_`);
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'thankyou':
case 'thankyoumessage': {
  await devtrust.sendMessage(m.chat, { react: { text: '🙌', key: m.key } });
  try {
    const res = await princeFun('thankyou');
    reply(`🙌 *Thank You Message*\n\n_${res || 'Thank you so much! You are appreciated! 🌟'}_`);
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

// ─────────────────────────── DOWNLOAD COMMANDS (Prince API) ───────────────────────────

case '__dup_removed_tiktokv2__':  // moved to mias/index.js
case '__dup_removed_ttv2__': {  // moved to mias/index.js
  if (!text || !isUrl(text)) return reply(`🎵 *TikTok Downloader V2*\n\nUsage: ${prefix}tiktokv2 <url>`);
  await devtrust.sendMessage(m.chat, { react: { text: '🎵', key: m.key } });
  reply('⏳ Downloading TikTok (v2)...');
  try {
    const r = await princeGet('/api/download/tiktokdlv2', { url: text });
    if (r.ok && r.data?.success && r.data.result) {
      const res = r.data.result;
      const videoUrl = res?.video || res?.nowm || res?.url;
      const audioUrl = res?.audio || res?.music;
      if (videoUrl) {
        await devtrust.sendMessage(m.chat, { video: { url: videoUrl }, mimetype: 'video/mp4', caption: `🎵 *TikTok V2*\n${res?.title || ''}` }, { quoted: m });
        return await devtrust.sendMessage(m.chat, { react: { text: '✅', key: m.key } });
      }
      if (audioUrl) {
        return await devtrust.sendMessage(m.chat, { audio: { url: audioUrl }, mimetype: 'audio/mpeg', ptt: false }, { quoted: m });
      }
    }
    reply('❌ TikTok V2 download failed. Try ' + prefix + 'tiktok instead.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case '__dup_removed_tiktokv3__':  // moved to mias/index.js
case '__dup_removed_ttv3__': {  // moved to mias/index.js
  if (!text || !isUrl(text)) return reply(`🎵 *TikTok Downloader V3*\n\nUsage: ${prefix}tiktokv3 <url>`);
  await devtrust.sendMessage(m.chat, { react: { text: '🎵', key: m.key } });
  reply('⏳ Downloading TikTok (v3)...');
  try {
    const r = await princeGet('/api/download/tiktokdlv3', { url: text });
    if (r.ok && r.data?.success && r.data.result) {
      const res = r.data.result;
      const videoUrl = res?.video || res?.nowm || res?.url;
      if (videoUrl) {
        await devtrust.sendMessage(m.chat, { video: { url: videoUrl }, mimetype: 'video/mp4', caption: `🎵 *TikTok V3*` }, { quoted: m });
        return await devtrust.sendMessage(m.chat, { react: { text: '✅', key: m.key } });
      }
    }
    reply('❌ TikTok V3 failed. Try ' + prefix + 'tiktok instead.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case '__dup_removed_tiktokv4__':  // moved to mias/index.js
case '__dup_removed_ttv4__': {  // moved to mias/index.js
  if (!text || !isUrl(text)) return reply(`🎵 *TikTok Downloader V4*\n\nUsage: ${prefix}tiktokv4 <url>`);
  await devtrust.sendMessage(m.chat, { react: { text: '🎵', key: m.key } });
  reply('⏳ Downloading TikTok (v4)...');
  try {
    const r = await princeGet('/api/download/tiktokdlv4', { url: text });
    if (r.ok && r.data?.success && r.data.result) {
      const res = r.data.result;
      const videoUrl = res?.video || res?.nowm || res?.url;
      if (videoUrl) {
        await devtrust.sendMessage(m.chat, { video: { url: videoUrl }, mimetype: 'video/mp4', caption: `🎵 *TikTok V4*` }, { quoted: m });
        return await devtrust.sendMessage(m.chat, { react: { text: '✅', key: m.key } });
      }
    }
    reply('❌ TikTok V4 failed. Try ' + prefix + 'tiktok instead.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case '__dup_removed_fbv2__':  // moved to mias/index.js
case '__dup_removed_facebookv2__': {  // moved to mias/index.js
  if (!text || !isUrl(text)) return reply(`📘 *Facebook Downloader V2*\n\nUsage: ${prefix}fbv2 <facebook-video-url>`);
  await devtrust.sendMessage(m.chat, { react: { text: '📘', key: m.key } });
  reply('⏳ Downloading Facebook video (v2)...');
  try {
    const r = await princeGet('/api/download/facebookv2', { url: text });
    if (r.ok && r.data?.success && r.data.result) {
      const res = r.data.result;
      const videoUrl = pickDownloadUrl(res);
      if (videoUrl) {
        await devtrust.sendMessage(m.chat, { video: { url: videoUrl }, mimetype: 'video/mp4', caption: `📘 *Facebook Video V2*` }, { quoted: m });
        return await devtrust.sendMessage(m.chat, { react: { text: '✅', key: m.key } });
      }
    }
    reply('❌ Facebook V2 download failed. Try ' + prefix + 'fb instead.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case '__dup_removed_igstory__':  // moved to mias/index.js
case '__dup_removed_instastory__': {  // moved to mias/index.js
  if (!text) return reply(`📸 *Instagram Story Downloader*\n\nUsage: ${prefix}igstory <instagram-username>`);
  await devtrust.sendMessage(m.chat, { react: { text: '📸', key: m.key } });
  reply('⏳ Fetching Instagram stories...');
  try {
    const uname = text.replace(/https?:\/\/(www\.)?instagram\.com\//i, '').replace(/\//g, '').trim();
    const r = await princeGet('/api/download/igstory', { username: uname });
    if (r.ok && r.data?.success && r.data.result) {
      const stories = Array.isArray(r.data.result) ? r.data.result : [r.data.result];
      if (!stories.length) return reply('❌ No stories found for this user.');
      let sent = 0;
      for (const s of stories.slice(0, 5)) {
        const sUrl = s?.url || s?.media_url || s;
        if (typeof sUrl !== 'string') continue;
        try {
          if (/\.(mp4|mov|webm)/i.test(sUrl)) {
            await devtrust.sendMessage(m.chat, { video: { url: sUrl }, mimetype: 'video/mp4', caption: `📸 Story ${sent + 1}/${Math.min(stories.length, 5)}` }, { quoted: m });
          } else {
            await devtrust.sendMessage(m.chat, { image: { url: sUrl }, caption: `📸 Story ${sent + 1}/${Math.min(stories.length, 5)}` }, { quoted: m });
          }
          sent++;
        } catch (_) {}
      }
      if (sent === 0) return reply('❌ Could not download any stories.');
      return await devtrust.sendMessage(m.chat, { react: { text: '✅', key: m.key } });
    }
    reply('❌ Could not fetch Instagram stories. Account may be private.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'ighighlights':
case 'instahighlights': {
  if (!text) return reply(`⭐ *Instagram Highlights Downloader*\n\nUsage: ${prefix}ighighlights <instagram-highlight-url>`);
  await devtrust.sendMessage(m.chat, { react: { text: '⭐', key: m.key } });
  reply('⏳ Fetching Instagram highlights...');
  try {
    const r = await princeGet('/api/download/ighighlights', { url: text });
    if (r.ok && r.data?.success && r.data.result) {
      const items = Array.isArray(r.data.result) ? r.data.result : [r.data.result];
      let sent = 0;
      for (const s of items.slice(0, 5)) {
        const sUrl = s?.url || s?.media_url || s;
        if (typeof sUrl !== 'string') continue;
        try {
          if (/\.(mp4|mov|webm)/i.test(sUrl)) {
            await devtrust.sendMessage(m.chat, { video: { url: sUrl }, mimetype: 'video/mp4', caption: `⭐ Highlight ${sent + 1}` }, { quoted: m });
          } else {
            await devtrust.sendMessage(m.chat, { image: { url: sUrl }, caption: `⭐ Highlight ${sent + 1}` }, { quoted: m });
          }
          sent++;
        } catch (_) {}
      }
      if (sent === 0) return reply('❌ Could not fetch highlights.');
      return await devtrust.sendMessage(m.chat, { react: { text: '✅', key: m.key } });
    }
    reply('❌ Could not fetch Instagram highlights.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'twitter':
case 'tw':
case '__dup_removed_xdl__': {  // moved to mias/index.js
  if (!text || !isUrl(text)) return reply(`🐦 *Twitter/X Downloader*\n\nUsage: ${prefix}twitter <tweet-url>\nExample: ${prefix}twitter https://twitter.com/user/status/123`);
  await devtrust.sendMessage(m.chat, { react: { text: '🐦', key: m.key } });
  reply('⏳ Downloading Twitter/X video...');
  try {
    const r = await princeGet('/api/download/twitter', { url: text });
    if (r.ok && r.data?.success && r.data.result) {
      const res = r.data.result;
      if (isApiErrorResult(res)) reply(`⚠️ Provider error: ${res.error || res.Error}`);
      const videoUrl = pickDownloadUrl(res);
      if (videoUrl) {
        await devtrust.sendMessage(m.chat, { video: { url: videoUrl }, mimetype: 'video/mp4', caption: `🐦 *Twitter/X Video*\n${res?.title || res?.text || ''}`.slice(0, 200) }, { quoted: m });
        return await devtrust.sendMessage(m.chat, { react: { text: '✅', key: m.key } });
      }
    }
    // Try V2
    const r2 = await princeGet('/api/download/twitterv2', { url: text });
    if (r2.ok && r2.data?.success && r2.data.result) {
      const res2 = r2.data.result;
      const videoUrl2 = pickDownloadUrl(res2);
      if (videoUrl2) {
        await devtrust.sendMessage(m.chat, { video: { url: videoUrl2 }, mimetype: 'video/mp4', caption: `🐦 *Twitter/X Video*` }, { quoted: m });
        return await devtrust.sendMessage(m.chat, { react: { text: '✅', key: m.key } });
      }
    }
    reply('❌ Twitter/X download failed. The tweet may not contain a video.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'twitterv2': {
  if (!text || !isUrl(text)) return reply(`🐦 *Twitter/X V2*\n\nUsage: ${prefix}twitterv2 <tweet-url>`);
  await devtrust.sendMessage(m.chat, { react: { text: '🐦', key: m.key } });
  reply('⏳ Downloading Twitter V2...');
  try {
    const r = await princeGet('/api/download/twitterv2', { url: text });
    if (r.ok && r.data?.success && r.data.result) {
      const res = r.data.result;
      const videoUrl = pickDownloadUrl(res);
      if (videoUrl) {
        await devtrust.sendMessage(m.chat, { video: { url: videoUrl }, mimetype: 'video/mp4', caption: `🐦 *Twitter V2*` }, { quoted: m });
        return await devtrust.sendMessage(m.chat, { react: { text: '✅', key: m.key } });
      }
    }
    reply('❌ Twitter V2 download failed.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case '__dup_removed_pinterest__':  // moved to mias/index.js
case 'pin': {
  // Pass through to WhatsApp pin command unless an explicit Pinterest URL is provided
  if (!text || !isUrl(text) || (!text.includes("pin.it") && !text.includes("pinterest."))) break;
  await devtrust.sendMessage(m.chat, { react: { text: '📌', key: m.key } });
  reply('⏳ Downloading Pinterest media...');
  try {
    const r = await princeGet('/api/download/pinterestdl', { url: text });
    if (r.ok && r.data?.success && r.data.result) {
      const res = r.data.result;
      const mediaUrl = res?.video || res?.image || res?.url;
      if (mediaUrl) {
        if (/\.(mp4|mov|webm)/i.test(mediaUrl) || res?.video) {
          await devtrust.sendMessage(m.chat, { video: { url: mediaUrl }, mimetype: 'video/mp4', caption: `📌 *Pinterest Video*` }, { quoted: m });
        } else {
          await devtrust.sendMessage(m.chat, { image: { url: mediaUrl }, caption: `📌 *Pinterest Image*` }, { quoted: m });
        }
        return await devtrust.sendMessage(m.chat, { react: { text: '✅', key: m.key } });
      }
    }
    reply('❌ Pinterest download failed. Make sure the pin URL is valid.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case '__dup_removed_snack__':  // moved to mias/index.js
case '__dup_removed_snackvideo__': {  // moved to mias/index.js
  if (!text || !isUrl(text)) return reply(`🎬 *SnackVideo Downloader*\n\nUsage: ${prefix}snack <snackvideo-url>`);
  await devtrust.sendMessage(m.chat, { react: { text: '🎬', key: m.key } });
  reply('⏳ Downloading SnackVideo...');
  try {
    const r = await princeGet('/api/download/snackdl', { url: text });
    if (r.ok && r.data?.success && r.data.result) {
      const res = r.data.result;
      const videoUrl = res?.video || res?.url || res?.nowm;
      if (videoUrl) {
        await devtrust.sendMessage(m.chat, { video: { url: videoUrl }, mimetype: 'video/mp4', caption: `🎬 *SnackVideo*` }, { quoted: m });
        return await devtrust.sendMessage(m.chat, { react: { text: '✅', key: m.key } });
      }
    }
    reply('❌ SnackVideo download failed.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case '__dup_removed_spotifyv2__': {  // moved to mias/index.js
  if (!text || !isUrl(text)) return reply(`🎧 *Spotify Downloader V2*\n\nUsage: ${prefix}spotifyv2 <spotify-track-url>`);
  await devtrust.sendMessage(m.chat, { react: { text: '🎧', key: m.key } });
  reply('⏳ Downloading Spotify track (v2)...');
  try {
    const r = await princeGet('/api/download/spotifydlv2', { url: text });
    if (r.ok && r.data?.success && r.data.result) {
      const res = r.data.result;
      const audioUrl = pickDownloadUrl(res);
      const title = res?.title || res?.name || 'Spotify Track';
      if (audioUrl) {
        const buf = await getBuffer(audioUrl, { timeout: 45000 });
        await devtrust.sendMessage(m.chat, { audio: buf, mimetype: 'audio/mpeg', ptt: false, fileName: `${title}.mp3` }, { quoted: m });
        return await devtrust.sendMessage(m.chat, { react: { text: '✅', key: m.key } });
      }
    }
    reply('❌ Spotify V2 failed. Try ' + prefix + 'spotify instead.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'ytmp3':
case 'mp3':
case 'ytaudio': {
  if (!text) return reply(`🎵 *YouTube MP3 Downloader*\n\nUsage: ${prefix}mp3 <youtube-url or song name>\nExample: ${prefix}mp3 https://youtu.be/xxxxx`);
  await devtrust.sendMessage(m.chat, { react: { text: '🎵', key: m.key } });
  reply('⏳ Downloading YouTube audio...');
  try {
    const searchQ = text;
    // Try Prince mp3 downloader
    const r = await princeGet('/api/download/mp3', { url: isUrl(text) ? text : undefined, q: !isUrl(text) ? text : undefined });
    if (r.ok && r.data?.success && r.data.result) {
      const res = r.data.result;
      const audioUrl = pickDownloadUrl(res);
      const title = res?.title || 'YouTube Audio';
      if (audioUrl) {
        const buf = await getBuffer(audioUrl, { timeout: 60000 });
        await devtrust.sendMessage(m.chat, { audio: buf, mimetype: 'audio/mpeg', ptt: false, fileName: `${title}.mp3` }, { quoted: m });
        return await devtrust.sendMessage(m.chat, { react: { text: '✅', key: m.key } });
      }
    }
    // Fallback: dlmp3
    const r2 = await princeGet('/api/download/dlmp3', { url: isUrl(text) ? text : undefined, q: !isUrl(text) ? text : undefined });
    if (r2.ok && r2.data?.success && r2.data.result) {
      const res2 = r2.data.result;
      const audioUrl2 = res2?.url || res2?.audio || res2?.download;
      const title2 = res2?.title || 'YouTube Audio';
      if (audioUrl2) {
        const buf2 = await getBuffer(audioUrl2, { timeout: 60000 });
        return await devtrust.sendMessage(m.chat, { audio: buf2, mimetype: 'audio/mpeg', ptt: false, fileName: `${title2}.mp3` }, { quoted: m });
      }
    }
    // Fallback: Prince yta
    const r3 = await princeGet('/api/download/yta', { q: searchQ });
    if (r3.ok && r3.data?.success && r3.data.result) {
      const res3 = r3.data.result;
      const audioUrl3 = res3?.url || res3?.audio;
      if (audioUrl3) {
        const buf3 = await getBuffer(audioUrl3, { timeout: 60000 });
        return await devtrust.sendMessage(m.chat, { audio: buf3, mimetype: 'audio/mpeg', ptt: false, fileName: `audio.mp3` }, { quoted: m });
      }
    }
    reply('❌ YouTube MP3 download failed. Try a direct YouTube URL.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case '__dup_removed_ytmp4__':  // moved to mias/index.js
case 'mp4':
case '__dup_removed_ytvideo__': {  // moved to mias/index.js
  if (!text) return reply(`🎬 *YouTube MP4 Downloader*\n\nUsage: ${prefix}mp4 <youtube-url>\nExample: ${prefix}mp4 https://youtu.be/xxxxx`);
  await devtrust.sendMessage(m.chat, { react: { text: '🎬', key: m.key } });
  reply('⏳ Downloading YouTube video...');
  try {
    const r = await princeGet('/api/download/mp4', { url: isUrl(text) ? text : undefined, q: !isUrl(text) ? text : undefined });
    if (r.ok && r.data?.success && r.data.result) {
      const res = r.data.result;
      const videoUrl = res?.url || res?.video || res?.download;
      const title = res?.title || 'YouTube Video';
      if (videoUrl) {
        await devtrust.sendMessage(m.chat, { video: { url: videoUrl }, mimetype: 'video/mp4', caption: `🎬 *${title}*` }, { quoted: m });
        return await devtrust.sendMessage(m.chat, { react: { text: '✅', key: m.key } });
      }
    }
    // Fallback: dlmp4
    const r2 = await princeGet('/api/download/dlmp4', { url: isUrl(text) ? text : undefined, q: !isUrl(text) ? text : undefined });
    if (r2.ok && r2.data?.success && r2.data.result) {
      const res2 = r2.data.result;
      const videoUrl2 = res2?.url || res2?.video;
      if (videoUrl2) {
        return await devtrust.sendMessage(m.chat, { video: { url: videoUrl2 }, mimetype: 'video/mp4', caption: `🎬 *${res2?.title || 'YouTube Video'}*` }, { quoted: m });
      }
    }
    reply('❌ YouTube MP4 download failed. Try a direct YouTube URL.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case '__dup_removed_mediafire__':  // moved to mias/index.js
case 'mf': {
  if (!text || !isUrl(text)) return reply(`☁️ *MediaFire Downloader*\n\nUsage: ${prefix}mediafire <mediafire-url>`);
  await devtrust.sendMessage(m.chat, { react: { text: '☁️', key: m.key } });
  reply('⏳ Getting MediaFire direct link...');
  try {
    const r = await princeGet('/api/download/mediafire', { url: text });
    if (r.ok && r.data?.success && r.data.result) {
      const res = r.data.result;
      const dlUrl = pickDownloadUrl(res);
      const name = res?.filename || res?.name || 'file';
      if (dlUrl) {
        return reply(`☁️ *MediaFire Download Link*\n\n📄 *File:* ${name}\n📦 *Size:* ${res?.size || 'Unknown'}\n\n🔗 ${dlUrl}`);
      }
    }
    reply('❌ MediaFire download failed. Check the URL.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'gdrive':
case 'googledrive': {
  if (!text || !isUrl(text)) return reply(`💾 *Google Drive Downloader*\n\nUsage: ${prefix}gdrive <google-drive-link>`);
  await devtrust.sendMessage(m.chat, { react: { text: '💾', key: m.key } });
  reply('⏳ Getting Google Drive direct link...');
  try {
    const r = await princeGet('/api/download/gdrivedl', { url: text });
    if (r.ok && r.data?.success && r.data.result) {
      const res = r.data.result;
      const dlUrl = pickDownloadUrl(res);
      const name = res?.name || res?.filename || 'file';
      if (dlUrl) return reply(`💾 *Google Drive Link*\n\n📄 *File:* ${name}\n\n🔗 ${dlUrl}`);
    }
    reply('❌ Google Drive download failed. Make sure the file is publicly shared.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'gofile': {
  if (!text || !isUrl(text)) return reply(`📁 *GoFile Downloader*\n\nUsage: ${prefix}gofile <gofile-url>`);
  await devtrust.sendMessage(m.chat, { react: { text: '📁', key: m.key } });
  reply('⏳ Fetching GoFile...');
  try {
    const r = await princeGet('/api/download/gofile', { url: text });
    if (r.ok && r.data?.success && r.data.result) {
      const res = r.data.result;
      const dlUrl = res?.url || res?.download;
      if (dlUrl) return reply(`📁 *GoFile Download*\n\n🔗 ${dlUrl}`);
    }
    reply('❌ GoFile download failed.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'pastebin': {
  if (!text || !isUrl(text)) return reply(`📋 *Pastebin Downloader*\n\nUsage: ${prefix}pastebin <pastebin-url>`);
  await devtrust.sendMessage(m.chat, { react: { text: '📋', key: m.key } });
  try {
    const r = await princeGet('/api/download/pastebin', { url: text });
    if (r.ok && r.data?.success && r.data.result) {
      const content = typeof r.data.result === 'string' ? r.data.result : JSON.stringify(r.data.result);
      return reply(`📋 *Pastebin Content*\n\n\`\`\`\n${content.slice(0, 3000)}\n\`\`\``);
    }
    reply('❌ Pastebin fetch failed.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'apkdl':
case 'apkdownload': {
  if (!text) return reply(`📦 *APK Downloader*\n\nUsage: ${prefix}apkdl <app name or package>\nExample: ${prefix}apkdl com.whatsapp`);
  await devtrust.sendMessage(m.chat, { react: { text: '📦', key: m.key } });
  reply('⏳ Searching APK...');
  try {
    const r = await princeGet('/api/download/apkdl', { AppName: text, q: text });
    if (r.ok && r.data?.success && r.data.result) {
      const res = r.data.result;
      const dlUrl = pickDownloadUrl(res);
      const name = res?.name || res?.title || text;
      const version = res?.version || 'N/A';
      const size = res?.size || 'N/A';
      if (dlUrl) {
        return reply(`📦 *APK Found*\n\n🏷️ *Name:* ${name}\n📱 *Version:* ${version}\n📦 *Size:* ${size}\n\n🔗 *Download:*\n${dlUrl}`);
      }
    }
    reply('❌ APK not found. Try a different app name or package ID.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'gitclone':
case 'clonegit': {
  if (!text || !isUrl(text)) return reply(`🐙 *Git Clone Downloader*\n\nUsage: ${prefix}gitclone <github-repo-url>\nExample: ${prefix}gitclone https://github.com/user/repo`);
  await devtrust.sendMessage(m.chat, { react: { text: '🐙', key: m.key } });
  reply('⏳ Getting Git clone link...');
  try {
    const r = await princeGet('/api/download/gitclone', { url: text });
    if (r.ok && r.data?.success && r.data.result) {
      const res = r.data.result;
      const dlUrl = res?.url || res?.download || res?.zip;
      const name = res?.name || 'repository';
      if (dlUrl) return reply(`🐙 *Git Clone Download*\n\n📁 *Repo:* ${name}\n\n🔗 ${dlUrl}`);
    }
    reply('❌ Git clone failed. Check the GitHub URL.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'xnxx':
case '__dup_removed_xnxxdl__': {  // moved to mias/index.js
  if (m.isGroup) return reply('❌ Adult commands are only available in private chats.');
  if (!text || !isUrl(text)) return reply(`🔞 *XNXX Downloader*\n\nUsage: ${prefix}xnxx <xnxx-url>`);
  await devtrust.sendMessage(m.chat, { react: { text: '🔞', key: m.key } });
  reply('⏳ Downloading XNXX...');
  try {
    const r = await princeGet('/api/download/xnxxdl', { url: text });
    if (r.ok && r.data?.success && r.data.result) {
      const res = r.data.result;
      const videoUrl = pickDownloadUrl(res) || res?.download;
      const title = res?.title || 'XNXX Video';
      if (videoUrl) {
        await devtrust.sendMessage(m.chat, { video: { url: videoUrl }, mimetype: 'video/mp4', caption: `🔞 ${title}` }, { quoted: m });
        return await devtrust.sendMessage(m.chat, { react: { text: '✅', key: m.key } });
      }
    }
    reply('❌ XNXX download failed.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'xvideos':
case 'xvideosdl': {
  if (m.isGroup) return reply('❌ Adult commands are only available in private chats.');
  if (!text || !isUrl(text)) return reply(`🔞 *XVideos Downloader*\n\nUsage: ${prefix}xvideos <xvideos-url>`);
  await devtrust.sendMessage(m.chat, { react: { text: '🔞', key: m.key } });
  reply('⏳ Downloading XVideos...');
  try {
    const r = await princeGet('/api/download/xvideosdl', { url: text });
    if (r.ok && r.data?.success && r.data.result) {
      const res = r.data.result;
      const videoUrl = pickDownloadUrl(res) || res?.download;
      const title = res?.title || 'XVideos Video';
      if (videoUrl) {
        await devtrust.sendMessage(m.chat, { video: { url: videoUrl }, mimetype: 'video/mp4', caption: `🔞 ${title}` }, { quoted: m });
        return await devtrust.sendMessage(m.chat, { react: { text: '✅', key: m.key } });
      }
    }
    reply('❌ XVideos download failed.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'yta':
case 'ytalt': {
  if (!text) return reply(`🎵 *YouTube Audio (Alt)*\n\nUsage: ${prefix}yta <song name or url>`);
  await devtrust.sendMessage(m.chat, { react: { text: '🎵', key: m.key } });
  reply('⏳ Getting YouTube audio (alt)...');
  try {
    const r = await princeGet('/api/download/yta', { q: text, url: isUrl(text) ? text : undefined });
    if (r.ok && r.data?.success && r.data.result) {
      const res = r.data.result;
      const audioUrl = res?.url || res?.audio;
      if (audioUrl) {
        const buf = await getBuffer(audioUrl, { timeout: 60000 });
        return await devtrust.sendMessage(m.chat, { audio: buf, mimetype: 'audio/mpeg', ptt: false, fileName: 'audio.mp3' }, { quoted: m });
      }
    }
    reply('❌ YTA alt download failed.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

// ─────────────────────────── TOOLS COMMANDS ───────────────────────────

case '__dup_removed_qr__':  // moved to mias/index.js
case 'createqr':
case 'genqr': {
  if (!text) return reply(`🔲 *QR Code Generator*\n\nUsage: ${prefix}qr <text or url>\nExample: ${prefix}qr https://google.com`);
  await devtrust.sendMessage(m.chat, { react: { text: '🔲', key: m.key } });
  try {
    const r = await princeGet('/api/tools/createqr', { text });
    if (r.ok && r.data?.success && r.data.result) {
      const qrUrl = typeof r.data.result === 'string' ? r.data.result : r.data.result?.url || r.data.result?.image;
      if (qrUrl) {
        const buf = await getBuffer(qrUrl, { timeout: 20000 });
        return await devtrust.sendMessage(m.chat, { image: buf, caption: `🔲 *QR Code*\n_Text: ${text.slice(0, 60)}_` }, { quoted: m });
      }
    }
    // Fallback: public QR API
    const fallbackQr = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(text)}`;
    const fallbackBuf = await getBuffer(fallbackQr, { timeout: 20000 });
    await devtrust.sendMessage(m.chat, { image: fallbackBuf, caption: `🔲 *QR Code*\n_${text.slice(0, 80)}_` }, { quoted: m });
  } catch (e) { reply(`❌ QR Error: ${e.message}`); }
}
break;

case 'readqr':
case 'scanqr': {
  const qrMsg = m.quoted || m;
  const qrType = Object.keys(qrMsg.message || {})[0];
  if (!qrMsg.message || !['imageMessage', 'viewOnceMessageV2'].includes(qrType)) {
    return reply(`📷 *QR Code Reader*\n\nReply to an image containing a QR code with ${prefix}readqr`);
  }
  await devtrust.sendMessage(m.chat, { react: { text: '📷', key: m.key } });
  try {
    const stream = await downloadContentFromMessage(qrMsg.message[qrType], qrType === 'imageMessage' ? 'image' : 'image');
    let chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const imgBuf = Buffer.concat(chunks);
    const base64Img = imgBuf.toString('base64');
    const r = await princeGet('/api/tools/readqr', { url: `data:image/jpeg;base64,${base64Img}` });
    if (r.ok && r.data?.success && r.data.result) {
      return reply(`📷 *QR Code Result*\n\n${r.data.result?.text || r.data.result}`);
    }
    reply('❌ Could not read QR code from image.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case '__dup_removed_removebg__':  // moved to mias/index.js
case '__dup_removed_bgremove__': {  // moved to mias/index.js
  const rmMsg = m.quoted || m;
  const rmType = Object.keys(rmMsg.message || {})[0];
  if (!m.quoted || !['imageMessage', 'viewOnceMessageV2'].includes(rmType)) {
    return reply(`✂️ *Remove Background*\n\nReply to an image with ${prefix}removebg to remove its background.`);
  }
  await devtrust.sendMessage(m.chat, { react: { text: '✂️', key: m.key } });
  reply('⏳ Removing background...');
  try {
    const stream = await downloadContentFromMessage(rmMsg.message[rmType], 'image');
    let chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const imgBuf = Buffer.concat(chunks);
    // Upload to catbox for URL
    const FormData = require('form-data');
    const form = new FormData();
    form.append('reqtype', 'fileupload');
    form.append('fileToUpload', imgBuf, { filename: 'image.jpg', contentType: 'image/jpeg' });
    const uploadRes = await axios.post('https://catbox.moe/user/api.php', form, { headers: form.getHeaders(), timeout: 30000 });
    const imgUrl = uploadRes.data?.trim();
    if (!imgUrl || !imgUrl.startsWith('http')) throw new Error('Upload failed');
    const r = await princeGet('/api/tools/removebg', { url: imgUrl });
    if (r.ok && r.data?.success && r.data.result) {
      const resultUrl = typeof r.data.result === 'string' ? r.data.result : r.data.result?.url || r.data.result?.image;
      if (resultUrl && resultUrl.startsWith('http')) {
        const resultBuf = await getBuffer(resultUrl, { timeout: 30000 });
        return await devtrust.sendMessage(m.chat, { image: resultBuf, caption: '✂️ *Background Removed*' }, { quoted: m });
      }
    }
    reply('❌ Background removal failed. Please try with a clearer image.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'remini':
case '__dup_removed_enhance__':  // moved to mias/index.js
case 'aienhance': {
  const reMsg = m.quoted || m;
  const reType = Object.keys(reMsg.message || {})[0];
  if (!m.quoted || !['imageMessage', 'viewOnceMessageV2'].includes(reType)) {
    return reply(`✨ *Remini AI Photo Enhancer*\n\nReply to a photo with ${prefix}remini to enhance it using AI.`);
  }
  await devtrust.sendMessage(m.chat, { react: { text: '✨', key: m.key } });
  reply('⏳ Enhancing photo with AI...');
  try {
    const stream = await downloadContentFromMessage(reMsg.message[reType], 'image');
    let chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const imgBuf = Buffer.concat(chunks);
    const FormData = require('form-data');
    const form = new FormData();
    form.append('reqtype', 'fileupload');
    form.append('fileToUpload', imgBuf, { filename: 'image.jpg', contentType: 'image/jpeg' });
    const uploadRes = await axios.post('https://catbox.moe/user/api.php', form, { headers: form.getHeaders(), timeout: 30000 });
    const imgUrl = uploadRes.data?.trim();
    if (!imgUrl || !imgUrl.startsWith('http')) throw new Error('Upload failed');
    const r = await princeGet('/api/tools/remini', { url: imgUrl });
    if (r.ok && r.data?.success && r.data.result) {
      const resultUrl = typeof r.data.result === 'string' ? r.data.result : r.data.result?.url || r.data.result?.image;
      if (resultUrl && resultUrl.startsWith('http')) {
        const resultBuf = await getBuffer(resultUrl, { timeout: 30000 });
        return await devtrust.sendMessage(m.chat, { image: resultBuf, caption: '✨ *Photo Enhanced with Remini AI*' }, { quoted: m });
      }
    }
    reply('❌ Remini enhancement failed. Please try with a different photo.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case '__dup_removed_fancy__':  // moved to mias/index.js
case 'fancytext':
case 'stylish': {
  if (!text) return reply(`🅰️ *Fancy Text Generator*\n\nUsage: ${prefix}fancy <text>\nExample: ${prefix}fancy Hello World`);
  await devtrust.sendMessage(m.chat, { react: { text: '🅰️', key: m.key } });
  try {
    const r = await princeGet('/api/tools/fancy', { text });
    if (r.ok && r.data?.success && (r.data.result || r.data.results)) {
      const items = r.data.results || (Array.isArray(r.data.result) ? r.data.result : [{ name: 'Fancy', result: r.data.result }]);
      let msg = `🅰️ *Fancy Text for: ${text}*\n\n`;
      for (const item of items.slice(0, 12)) {
        msg += `*${item.name}:* ${item.result}\n`;
      }
      return reply(msg.trim());
    }
    reply('❌ Fancy text generation failed.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'fancyv2':
case 'stylishv2': {
  if (!text) return reply(`🅰️ *Fancy Text V2*\n\nUsage: ${prefix}fancyv2 <text>`);
  await devtrust.sendMessage(m.chat, { react: { text: '🅰️', key: m.key } });
  try {
    const r = await princeGet('/api/tools/fancyv2', { text });
    if (r.ok && r.data?.success && (r.data.result || r.data.results)) {
      const items = r.data.results || (Array.isArray(r.data.result) ? r.data.result : [{ name: 'Fancy V2', result: r.data.result }]);
      let msg = `🅰️ *Fancy V2 for: ${text}*\n\n`;
      for (const item of items.slice(0, 12)) {
        msg += `*${item.name}:* ${item.result}\n`;
      }
      return reply(msg.trim());
    }
    reply('❌ Fancy V2 failed.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case '__dup_removed_define__':  // moved to mias/index.js
case 'dictionary':
case 'meaning': {
  if (!text) return reply(`📖 *Dictionary*\n\nUsage: ${prefix}define <word>\nExample: ${prefix}define serendipity`);
  await devtrust.sendMessage(m.chat, { react: { text: '📖', key: m.key } });
  try {
    const r = await princeGet('/api/tools/define', { term: text.split(' ')[0], word: text.split(' ')[0] });
    if (r.ok && r.data?.success && r.data.result) {
      const res = r.data.result;
      const definition = typeof res === 'string' ? res
        : res?.definition || res?.meaning || res?.definitions?.[0]?.definition || JSON.stringify(res).slice(0, 400);
      return reply(`📖 *${text.split(' ')[0].toUpperCase()}*\n\n${definition}`);
    }
    // Fallback: free dictionary API
    const dictRes = await axios.get(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(text.split(' ')[0])}`, { timeout: 10000 });
    const entry = dictRes.data?.[0];
    if (entry) {
      const meanings = entry.meanings?.map(m => `*${m.partOfSpeech}:* ${m.definitions[0]?.definition}`).join('\n') || 'No definition found';
      return reply(`📖 *${entry.word.toUpperCase()}*\n\n${meanings}`);
    }
    reply('❌ Word not found in dictionary.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'encrypt': {
  if (!text) return reply(`🔐 *Text Encryptor*\n\nUsage: ${prefix}encrypt <text>\nExample: ${prefix}encrypt Hello World`);
  await devtrust.sendMessage(m.chat, { react: { text: '🔐', key: m.key } });
  try {
    const r = await princeGet('/api/tools/encrypt', { text });
    if (r.ok && r.data?.success && r.data.result) {
      const res = r.data.result;
      let msg = `🔐 *Encrypted Text*\n\n`;
      if (typeof res === 'object') {
        for (const [k, v] of Object.entries(res)) msg += `*${k}:* \`${v}\`\n`;
      } else {
        msg += `\`${res}\``;
      }
      return reply(msg.trim());
    }
    reply('❌ Encryption failed.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'encryptv2': {
  if (!text) return reply(`🔐 *Encryptor V2*\n\nUsage: ${prefix}encryptv2 <text>`);
  await devtrust.sendMessage(m.chat, { react: { text: '🔐', key: m.key } });
  try {
    const r = await princeGet('/api/tools/encryptv2', { text });
    if (r.ok && r.data?.success && r.data.result) {
      const res = r.data.result;
      let msg = `🔐 *Encrypted V2*\n\n`;
      if (typeof res === 'object') {
        for (const [k, v] of Object.entries(res)) msg += `*${k}:* \`${v}\`\n`;
      } else { msg += `\`${res}\``; }
      return reply(msg.trim());
    }
    reply('❌ Encryption V2 failed.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'encryptv3': {
  if (!text) return reply(`🔐 *Encryptor V3*\n\nUsage: ${prefix}encryptv3 <text>`);
  await devtrust.sendMessage(m.chat, { react: { text: '🔐', key: m.key } });
  try {
    const r = await princeGet('/api/tools/encryptv3', { text });
    if (r.ok && r.data?.success && r.data.result) {
      const res = r.data.result;
      let msg = `🔐 *Encrypted V3*\n\n`;
      if (typeof res === 'object') {
        for (const [k, v] of Object.entries(res)) msg += `*${k}:* \`${v}\`\n`;
      } else { msg += `\`${res}\``; }
      return reply(msg.trim());
    }
    reply('❌ Encryption V3 failed.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'ebase':
case 'base64encode': {
  if (!text) return reply(`📦 *Base64 Encode*\n\nUsage: ${prefix}ebase <text>`);
  await devtrust.sendMessage(m.chat, { react: { text: '📦', key: m.key } });
  try {
    const r = await princeGet('/api/tools/ebase', { text });
    if (r.ok && r.data?.success && r.data.result) {
      return reply(`📦 *Base64 Encoded*\n\n\`${r.data.result}\``);
    }
    // Fallback local
    reply(`📦 *Base64 Encoded*\n\n\`${Buffer.from(text).toString('base64')}\``);
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'dbase':
case 'base64decode': {
  if (!text) return reply(`📦 *Base64 Decode*\n\nUsage: ${prefix}dbase <base64-text>`);
  await devtrust.sendMessage(m.chat, { react: { text: '📦', key: m.key } });
  try {
    const r = await princeGet('/api/tools/dbase', { text });
    if (r.ok && r.data?.success && r.data.result) {
      return reply(`📦 *Base64 Decoded*\n\n${r.data.result}`);
    }
    // Fallback local
    reply(`📦 *Base64 Decoded*\n\n${Buffer.from(text, 'base64').toString('utf8')}`);
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'ebinary':
case 'binaryencode': {
  if (!text) return reply(`💻 *Binary Encode*\n\nUsage: ${prefix}ebinary <text>`);
  await devtrust.sendMessage(m.chat, { react: { text: '💻', key: m.key } });
  try {
    const r = await princeGet('/api/tools/ebinary', { text });
    if (r.ok && r.data?.success && r.data.result) {
      return reply(`💻 *Binary*\n\n\`${r.data.result}\``);
    }
    // Fallback local
    const binary = text.split('').map(c => c.charCodeAt(0).toString(2).padStart(8, '0')).join(' ');
    reply(`💻 *Binary Encoded*\n\n\`${binary}\``);
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'dbinary':
case 'binarydecode': {
  if (!text) return reply(`💻 *Binary Decode*\n\nUsage: ${prefix}dbinary <binary text>`);
  await devtrust.sendMessage(m.chat, { react: { text: '💻', key: m.key } });
  try {
    const r = await princeGet('/api/tools/dbinary', { text });
    if (r.ok && r.data?.success && r.data.result) {
      return reply(`💻 *Decoded*\n\n${r.data.result}`);
    }
    // Fallback local
    const decoded = text.split(' ').map(b => String.fromCharCode(parseInt(b, 2))).join('');
    reply(`💻 *Binary Decoded*\n\n${decoded}`);
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'dns':
case 'dnscheck': {
  if (!text) return reply(`🌐 *DNS Checker*\n\nUsage: ${prefix}dns <domain>\nExample: ${prefix}dns google.com`);
  await devtrust.sendMessage(m.chat, { react: { text: '🌐', key: m.key } });
  try {
    const domain = text.replace(/https?:\/\//i, '').split('/')[0];
    const r = await princeGet('/api/tools/dns-check', { domain });
    if (r.ok && r.data?.success && r.data.result) {
      const res = r.data.result;
      let msg = `🌐 *DNS Records for ${domain}*\n\n`;
      if (typeof res === 'object') {
        for (const [k, v] of Object.entries(res)) {
          msg += `*${k}:* ${Array.isArray(v) ? v.join(', ') : v}\n`;
        }
      } else { msg += String(res); }
      return reply(msg.trim());
    }
    reply('❌ DNS lookup failed. Check the domain name.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'servercheck':
case 'checkserver':
case 'pingserver': {
  if (!text) return reply(`🖥️ *Server Checker*\n\nUsage: ${prefix}servercheck <url or ip>\nExample: ${prefix}servercheck google.com`);
  await devtrust.sendMessage(m.chat, { react: { text: '🖥️', key: m.key } });
  try {
    const r = await princeGet('/api/tools/server-check', { url: text, ip: text });
    if (r.ok && r.data?.success && r.data.result) {
      const res = r.data.result;
      let msg = `🖥️ *Server Check: ${text}*\n\n`;
      if (typeof res === 'object') {
        for (const [k, v] of Object.entries(res)) msg += `*${k}:* ${v}\n`;
      } else { msg += String(res); }
      return reply(msg.trim());
    }
    reply('❌ Server check failed.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'httpheaders':
case 'http-headers': {
  if (!text || !isUrl(text)) return reply(`🔍 *HTTP Headers Checker*\n\nUsage: ${prefix}httpheaders <url>\nExample: ${prefix}httpheaders https://google.com`);
  await devtrust.sendMessage(m.chat, { react: { text: '🔍', key: m.key } });
  try {
    const r = await princeGet('/api/tools/http-headers', { url: text });
    if (r.ok && r.data?.success && r.data.result) {
      const res = r.data.result;
      let msg = `🔍 *HTTP Headers*\n_${text}_\n\n`;
      if (typeof res === 'object') {
        for (const [k, v] of Object.entries(res).slice(0, 15)) msg += `*${k}:* ${v}\n`;
      } else { msg += String(res); }
      return reply(msg.trim());
    }
    reply('❌ HTTP header check failed.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'ss':
case 'ssweb':
case 'screenshot':
case 'webss': {
  let targetUrl = String(text || "").trim();
  if (!targetUrl) return reply(`📸 *Website Screenshot*\n\nUsage: ${prefix}ss <url>\nExample: ${prefix}ss google.com\nExample: ${prefix}ss https://github.com`);
  if (!/^https?:\/\//i.test(targetUrl)) {
    targetUrl = "https://" + targetUrl;
  }
  await devtrust.sendMessage(m.chat, { react: { text: '📸', key: m.key } });
  reply('⏳ Taking screenshot of ' + targetUrl + '...');
  try {
    let buf = null;
    // 1. WordPress mshots (fast, reliable, free full-render JPEG)
    try {
      const wpUrl = `https://s0.wp.com/mshots/v1/${encodeURIComponent(targetUrl)}?w=1280&h=720`;
      const res = await (typeof fetch === 'function' ? fetch(wpUrl, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" } }) : null);
      if (res && res.ok) {
        const arr = await res.arrayBuffer();
        if (arr.byteLength > 2000) buf = Buffer.from(arr);
      }
      if (!buf && typeof getBuffer === 'function') {
        const b = await getBuffer(wpUrl, { timeout: 15000 });
        if (b && b.length > 2000) buf = b;
      }
    } catch (e) {
      console.warn('[ss] wp mshots failed:', e.message);
    }

    // 2. Microlink
    if (!buf) {
      try {
        const microUrl = `https://api.microlink.io?url=${encodeURIComponent(targetUrl)}&screenshot=true&meta=false`;
        const res = await (typeof fetch === 'function' ? fetch(microUrl) : null);
        if (res && res.ok) {
          const d = await res.json();
          const imgUrl = d?.data?.screenshot?.url;
          if (imgUrl) {
            const imgRes = await fetch(imgUrl);
            if (imgRes.ok) buf = Buffer.from(await imgRes.arrayBuffer());
          }
        }
      } catch (e) {
        console.warn('[ss] microlink failed:', e.message);
      }
    }

    // 3. Thum.io
    if (!buf) {
      try {
        const thumUrl = `https://image.thum.io/get/width/1280/crop/720/${encodeURIComponent(targetUrl)}`;
        const res = await (typeof fetch === 'function' ? fetch(thumUrl) : null);
        if (res && res.ok) {
          const arr = await res.arrayBuffer();
          if (arr.byteLength > 2000) buf = Buffer.from(arr);
        }
      } catch (e) {
        console.warn('[ss] thum.io failed:', e.message);
      }
    }

    if (buf && buf.length > 1000) {
      return await devtrust.sendMessage(m.chat, { image: buf, caption: `📸 *Website Screenshot*\n🌐 _${targetUrl}_` }, { quoted: m });
    } else {
      return reply(`❌ Could not capture screenshot for: ${targetUrl}. Please ensure the website is accessible.`);
    }
  } catch (e) {
    reply(`❌ Screenshot failed: ${e.message}`);
  }
}
break;

case 'ssphone':
case 'phonescreenshot': {
  if (!text || !isUrl(text)) return reply(`📱 *Phone View Screenshot*\n\nUsage: ${prefix}ssphone <url>`);
  await devtrust.sendMessage(m.chat, { react: { text: '📱', key: m.key } });
  reply('⏳ Taking phone screenshot...');
  try {
    const r = await princeGet('/api/tools/ssphone', { url: text });
    if (r.ok && r.data?.success && r.data.result) {
      const imgUrl = typeof r.data.result === 'string' ? r.data.result : r.data.result?.url;
      if (imgUrl) {
        const buf = await getBuffer(imgUrl, { timeout: 30000 });
        return await devtrust.sendMessage(m.chat, { image: buf, caption: `📱 *Phone View: ${text}*` }, { quoted: m });
      }
    }
    reply('❌ Phone screenshot failed.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'sstab':
case 'tabscreenshot': {
  if (!text || !isUrl(text)) return reply(`🪨 *Tablet View Screenshot*\n\nUsage: ${prefix}sstab <url>`);
  await devtrust.sendMessage(m.chat, { react: { text: '🪨', key: m.key } });
  reply('⏳ Taking tablet screenshot...');
  try {
    const r = await princeGet('/api/tools/sstab', { url: text });
    if (r.ok && r.data?.success && r.data.result) {
      const imgUrl = typeof r.data.result === 'string' ? r.data.result : r.data.result?.url;
      if (imgUrl) {
        const buf = await getBuffer(imgUrl, { timeout: 30000 });
        return await devtrust.sendMessage(m.chat, { image: buf, caption: `🪨 *Tablet View: ${text}*` }, { quoted: m });
      }
    }
    reply('❌ Tablet screenshot failed.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'sspc':
case 'pcscreenshot': {
  if (!text || !isUrl(text)) return reply(`🖥️ *PC View Screenshot*\n\nUsage: ${prefix}sspc <url>`);
  await devtrust.sendMessage(m.chat, { react: { text: '🖥️', key: m.key } });
  reply('⏳ Taking PC screenshot...');
  try {
    const r = await princeGet('/api/tools/sspc', { url: text });
    if (r.ok && r.data?.success && r.data.result) {
      const imgUrl = typeof r.data.result === 'string' ? r.data.result : r.data.result?.url;
      if (imgUrl) {
        const buf = await getBuffer(imgUrl, { timeout: 30000 });
        return await devtrust.sendMessage(m.chat, { image: buf, caption: `🖥️ *PC View: ${text}*` }, { quoted: m });
      }
    }
    reply('❌ PC screenshot failed.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'topdf':
case 'html2pdf': {
  if (!text || !isUrl(text)) return reply(`📄 *Convert to PDF*\n\nUsage: ${prefix}topdf <url>\nExample: ${prefix}topdf https://example.com`);
  await devtrust.sendMessage(m.chat, { react: { text: '📄', key: m.key } });
  reply('⏳ Converting to PDF...');
  try {
    const r = await princeGet('/api/tools/topdf', { url: text });
    if (r.ok && r.data?.success && r.data.result) {
      const pdfUrl = typeof r.data.result === 'string' ? r.data.result : r.data.result?.url;
      if (pdfUrl) {
        const buf = await getBuffer(pdfUrl, { timeout: 60000 });
        return await devtrust.sendMessage(m.chat, {
          document: buf, mimetype: 'application/pdf', fileName: `webpage_${Date.now()}.pdf`,
          caption: `📄 *PDF Converted*\n_${text}_`
        }, { quoted: m });
      }
    }
    reply('❌ PDF conversion failed.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'proxy':
case 'getproxy': {
  await devtrust.sendMessage(m.chat, { react: { text: '🔒', key: m.key } });
  try {
    const r = await princeGet('/api/tools/proxy');
    if (r.ok && r.data?.success && r.data.result) {
      const proxies = Array.isArray(r.data.result) ? r.data.result.slice(0, 10) : [r.data.result];
      let msg = `🔒 *Fresh Proxies*\n\n`;
      for (const p of proxies) {
        msg += `• \`${typeof p === 'string' ? p : (p?.ip + ':' + p?.port || JSON.stringify(p))}\`\n`;
      }
      return reply(msg.trim());
    }
    reply('❌ No proxies available right now.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

// ─────────────────────────── SEARCH COMMANDS ───────────────────────────

case 'weather':
case 'cuaca': {
  if (!text) return reply(`⛅ *Weather Search*\n\nUsage: ${prefix}weather <city>\nExample: ${prefix}weather Lagos`);
  await devtrust.sendMessage(m.chat, { react: { text: '⛅', key: m.key } });
  try {
    const r = await princeGet('/api/search/weather', { q: text, city: text, location: text });
    if (r.ok && r.data?.success && r.data.result) {
      const res = r.data.result;
      const city = res?.city || res?.location || text;
      const temp = res?.temperature || res?.temp || 'N/A';
      const condition = res?.condition || res?.description || res?.weather || 'N/A';
      const humidity = res?.humidity || 'N/A';
      const wind = res?.wind || res?.windSpeed || 'N/A';
      const feels = res?.feelsLike || res?.feels_like || 'N/A';
      return reply(`⛅ *Weather: ${city}*\n\n🌡️ *Temperature:* ${temp}\n🌤️ *Condition:* ${condition}\n💧 *Humidity:* ${humidity}\n💨 *Wind:* ${wind}\n🤔 *Feels Like:* ${feels}`);
    }
    // Fallback: wttr.in
    const wttrRes = await axios.get(`https://wttr.in/${encodeURIComponent(text)}?format=j1`, { timeout: 10000 });
    const cur = wttrRes.data?.current_condition?.[0];
    if (cur) {
      return reply(`⛅ *Weather: ${text}*\n\n🌡️ *Temperature:* ${cur.temp_C}°C / ${cur.temp_F}°F\n🌤️ *Condition:* ${cur.weatherDesc?.[0]?.value || 'N/A'}\n💧 *Humidity:* ${cur.humidity}%\n💨 *Wind:* ${cur.windspeedKmph} km/h`);
    }
    reply('❌ Could not fetch weather. Try a different city name.');
  } catch (e) { reply(`❌ Weather Error: ${e.message}`); }
}
break;

case '__dup_removed_lyrics__': {  // moved to mias/index.js
  if (!text) return reply(`🎵 *Lyrics Finder*\n\nUsage: ${prefix}lyrics <song name>\nExample: ${prefix}lyrics Shape of You`);
  await devtrust.sendMessage(m.chat, { react: { text: '🎵', key: m.key } });
  reply('⏳ Searching lyrics...');
  try {
    const r = await princeGet('/api/search/lyrics', { song: text, q: text });
    if (r.ok && r.data?.success && r.data.result) {
      const res = r.data.result;
      const title = res?.title || res?.name || text;
      const artist = res?.artist || res?.singer || '';
      const lyricsText = res?.lyrics || res?.lyric || (typeof res === 'string' ? res : '');
      if (lyricsText) {
        return reply(`🎵 *${title}*${artist ? ` — ${artist}` : ''}\n\n${lyricsText.slice(0, 3000)}`);
      }
    }
    // Try lyricsv2
    const r2 = await princeGet('/api/search/lyricsv2', { q: text, song: text });
    if (r2.ok && r2.data?.success && r2.data.result) {
      const res2 = r2.data.result;
      const lyrics2 = res2?.lyrics || res2?.lyric || (typeof res2 === 'string' ? res2 : '');
      if (lyrics2) return reply(`🎵 *${res2?.title || text}*\n\n${lyrics2.slice(0, 3000)}`);
    }
    reply('❌ Lyrics not found. Try a different song name.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case '__dup_removed_wallpaper__':  // moved to mias/index.js
case 'wp': {
  if (!text) return reply(`🖼️ *Wallpaper Search*\n\nUsage: ${prefix}wallpaper <query>\nExample: ${prefix}wallpaper nature sunset`);
  await devtrust.sendMessage(m.chat, { react: { text: '🖼️', key: m.key } });
  reply('⏳ Searching wallpapers...');
  try {
    const r = await princeGet('/api/search/wallpaper', { q: text, query: text });
    if (r.ok && r.data?.success && r.data.result) {
      const results = Array.isArray(r.data.result) ? r.data.result : [r.data.result];
      const picked = results[Math.floor(Math.random() * Math.min(results.length, 5))];
      const imgUrl = picked?.url || picked?.image || picked?.src || (typeof picked === 'string' ? picked : null);
      if (imgUrl) {
        const buf = await getBuffer(imgUrl, { timeout: 30000 });
        return await devtrust.sendMessage(m.chat, { image: buf, caption: `🖼️ *Wallpaper: ${text}*` }, { quoted: m });
      }
    }
    // Fallback: unsplash
    const r2 = await princeGet('/api/search/unsplash', { q: text });
    if (r2.ok && r2.data?.success && r2.data.result) {
      const items = Array.isArray(r2.data.result) ? r2.data.result : [r2.data.result];
      const img = items[0];
      const imgUrl2 = img?.url || img?.urls?.regular || img?.urls?.full || (typeof img === 'string' ? img : null);
      if (imgUrl2) {
        const buf2 = await getBuffer(imgUrl2, { timeout: 30000 });
        return await devtrust.sendMessage(m.chat, { image: buf2, caption: `🖼️ *Wallpaper: ${text}*\n_via Unsplash_` }, { quoted: m });
      }
    }
    reply('❌ No wallpapers found for: ' + text);
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'unsplash':
case 'unsplashimage': {
  if (!text) return reply(`📷 *Unsplash Image Search*\n\nUsage: ${prefix}unsplash <query>\nExample: ${prefix}unsplash ocean`);
  await devtrust.sendMessage(m.chat, { react: { text: '📷', key: m.key } });
  try {
    const r = await princeGet('/api/search/unsplash', { q: text });
    if (r.ok && r.data?.success && r.data.result) {
      const items = Array.isArray(r.data.result) ? r.data.result : [r.data.result];
      const img = items[Math.floor(Math.random() * Math.min(items.length, 5))];
      const imgUrl = img?.url || img?.urls?.regular || img?.urls?.full || (typeof img === 'string' ? img : null);
      if (imgUrl) {
        const buf = await getBuffer(imgUrl, { timeout: 30000 });
        const author = img?.author || img?.user?.name || '';
        return await devtrust.sendMessage(m.chat, { image: buf, caption: `📷 *Unsplash: ${text}*${author ? `\n📸 By: ${author}` : ''}` }, { quoted: m });
      }
    }
    reply('❌ No Unsplash images found.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'googleimage':
case 'gimage': {
  if (!text) return reply(`🔍 *Google Image Search*\n\nUsage: ${prefix}googleimage <query>\nExample: ${prefix}googleimage cute cats`);
  await devtrust.sendMessage(m.chat, { react: { text: '🔍', key: m.key } });
  try {
    const r = await princeGet('/api/search/googleimage', { q: text });
    if (r.ok && r.data?.success && r.data.result) {
      const results = Array.isArray(r.data.result) ? r.data.result : [r.data.result];
      const img = results[0];
      const imgUrl = img?.url || img?.image || (typeof img === 'string' ? img : null);
      if (imgUrl) {
        const buf = await getBuffer(imgUrl, { timeout: 30000 });
        return await devtrust.sendMessage(m.chat, { image: buf, caption: `🔍 *Google Image: ${text}*` }, { quoted: m });
      }
    }
    reply('❌ No Google images found.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'chord':
case 'guitarchord': {
  if (!text) return reply(`🎸 *Guitar Chord*\n\nUsage: ${prefix}chord <chord name>\nExample: ${prefix}chord Am`);
  await devtrust.sendMessage(m.chat, { react: { text: '🎸', key: m.key } });
  try {
    const r = await princeGet('/api/search/chord', { q: text, chord: text });
    if (r.ok && r.data?.success && r.data.result) {
      const res = r.data.result;
      const imgUrl = res?.image || res?.url || (typeof res === 'string' ? res : null);
      if (imgUrl && imgUrl.startsWith('http')) {
        const buf = await getBuffer(imgUrl, { timeout: 20000 });
        return await devtrust.sendMessage(m.chat, { image: buf, caption: `🎸 *Guitar Chord: ${text}*` }, { quoted: m });
      }
      return reply(`🎸 *Chord: ${text}*\n\n${typeof res === 'string' ? res : JSON.stringify(res)}`);
    }
    reply('❌ Chord not found.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'spotifysearch':
case 'searchspotify': {
  if (!text) return reply(`🎧 *Spotify Search*\n\nUsage: ${prefix}spotifysearch <song name>\nExample: ${prefix}spotifysearch Blinding Lights`);
  await devtrust.sendMessage(m.chat, { react: { text: '🎧', key: m.key } });
  try {
    const r = await princeGet('/api/search/spotifysearch', { q: text });
    if (r.ok && r.data?.success && r.data.result) {
      const results = Array.isArray(r.data.result) ? r.data.result : [r.data.result];
      let msg = `🎧 *Spotify Search: ${text}*\n\n`;
      for (const item of results.slice(0, 5)) {
        const title = item?.name || item?.title || 'Unknown';
        const artist = item?.artists?.[0]?.name || item?.artist || '';
        const url = item?.external_urls?.spotify || item?.url || '';
        const duration = item?.duration_ms ? Math.round(item.duration_ms / 1000) + 's' : '';
        msg += `🎵 *${title}*${artist ? ` — ${artist}` : ''}${duration ? ` (${duration})` : ''}\n${url}\n\n`;
      }
      return reply(msg.trim());
    }
    reply('❌ Spotify search failed.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'tiktoksearch':
case 'searchtiktok': {
  if (!text) return reply(`🎵 *TikTok Search*\n\nUsage: ${prefix}tiktoksearch <keyword>\nExample: ${prefix}tiktoksearch funny cats`);
  await devtrust.sendMessage(m.chat, { react: { text: '🎵', key: m.key } });
  try {
    const r = await princeGet('/api/search/tiktoksearch', { q: text });
    if (r.ok && r.data?.success && r.data.result) {
      const results = Array.isArray(r.data.result) ? r.data.result : [r.data.result];
      let msg = `🎵 *TikTok Search: ${text}*\n\n`;
      for (const item of results.slice(0, 5)) {
        const title = item?.desc || item?.title || 'TikTok Video';
        const author = item?.author?.nickname || item?.author || '';
        const url = item?.url || item?.video_url || item?.play || '';
        const likes = item?.stats?.diggCount || item?.likes || '';
        msg += `🎬 *${title.slice(0, 60)}*${author ? `\n👤 @${author}` : ''}${likes ? `\n❤️ ${likes}` : ''}${url ? `\n🔗 ${url}` : ''}\n\n`;
      }
      return reply(msg.trim());
    }
    reply('❌ TikTok search failed.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case '__dup_removed_yts__':  // moved to mias/index.js
case '__dup_removed_ytsearch__':  // moved to mias/index.js
case 'youtubesearch': {
  if (!text) return reply(`▶️ *YouTube Search*\n\nUsage: ${prefix}yts <query>\nExample: ${prefix}yts Wizkid Essence`);
  await devtrust.sendMessage(m.chat, { react: { text: '▶️', key: m.key } });
  try {
    const r = await princeGet('/api/search/yts', { q: text });
    if (r.ok && r.data?.success && r.data.result) {
      const results = Array.isArray(r.data.result) ? r.data.result : [r.data.result];
      let msg = `▶️ *YouTube Search: ${text}*\n\n`;
      for (const item of results.slice(0, 5)) {
        const title = item?.title || 'YouTube Video';
        const channel = item?.channel?.name || item?.author || '';
        const duration = item?.duration?.timestamp || item?.duration || '';
        const views = item?.views || item?.viewCount || '';
        const url = item?.url || `https://youtu.be/${item?.videoId || item?.id}`;
        msg += `🎬 *${title}*${channel ? `\n📺 ${channel}` : ''}${duration ? ` | ⏱️ ${duration}` : ''}${views ? ` | 👁️ ${views}` : ''}\n🔗 ${url}\n\n`;
      }
      return reply(msg.trim());
    }
    reply('❌ YouTube search failed.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'playstoresearch':
case 'playstore': {
  if (!text) return reply(`🏪 *Play Store Search*\n\nUsage: ${prefix}playstore <app name>\nExample: ${prefix}playstore WhatsApp`);
  await devtrust.sendMessage(m.chat, { react: { text: '🏪', key: m.key } });
  try {
    const r = await princeGet('/api/search/playstore', { q: text });
    if (r.ok && r.data?.success && r.data.result) {
      const results = Array.isArray(r.data.result) ? r.data.result : [r.data.result];
      let msg = `🏪 *Play Store: ${text}*\n\n`;
      for (const item of results.slice(0, 5)) {
        const name = item?.title || item?.name || 'App';
        const developer = item?.developer || item?.devName || '';
        const rating = item?.score || item?.rating || '';
        const installs = item?.installs || '';
        const url = item?.url || item?.link || '';
        msg += `📱 *${name}*${developer ? `\n👤 ${developer}` : ''}${rating ? ` | ⭐ ${rating}` : ''}${installs ? ` | 📦 ${installs}` : ''}${url ? `\n🔗 ${url}` : ''}\n\n`;
      }
      return reply(msg.trim());
    }
    reply('❌ Play Store search failed.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'apkmirror':
case 'apkmirr': {
  if (!text) return reply(`📱 *APKMirror Search*\n\nUsage: ${prefix}apkmirror <app name>\nExample: ${prefix}apkmirror Instagram`);
  await devtrust.sendMessage(m.chat, { react: { text: '📱', key: m.key } });
  try {
    const r = await princeGet('/api/search/apkmirror', { q: text });
    if (r.ok && r.data?.success && r.data.result) {
      const results = Array.isArray(r.data.result) ? r.data.result : [r.data.result];
      let msg = `📱 *APKMirror: ${text}*\n\n`;
      for (const item of results.slice(0, 5)) {
        const name = item?.name || item?.title || 'App';
        const version = item?.version || '';
        const url = item?.url || item?.link || '';
        msg += `📦 *${name}*${version ? ` v${version}` : ''}${url ? `\n🔗 ${url}` : ''}\n\n`;
      }
      return reply(msg.trim());
    }
    reply('❌ APKMirror search failed.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'happymod': {
  if (!text) return reply(`🎮 *HappyMod Search*\n\nUsage: ${prefix}happymod <game/app name>\nExample: ${prefix}happymod PUBG`);
  await devtrust.sendMessage(m.chat, { react: { text: '🎮', key: m.key } });
  try {
    const r = await princeGet('/api/search/happymod', { q: text });
    if (r.ok && r.data?.success && r.data.result) {
      const results = Array.isArray(r.data.result) ? r.data.result : [r.data.result];
      let msg = `🎮 *HappyMod: ${text}*\n\n`;
      for (const item of results.slice(0, 5)) {
        const name = item?.name || item?.title || 'Game/App';
        const version = item?.version || '';
        const size = item?.size || '';
        const url = item?.url || item?.link || '';
        msg += `🎯 *${name}*${version ? ` v${version}` : ''}${size ? ` | 📦 ${size}` : ''}${url ? `\n🔗 ${url}` : ''}\n\n`;
      }
      return reply(msg.trim());
    }
    reply('❌ HappyMod search failed.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'npmsearch':
case 'searchnpm': {
  if (!text) return reply(`📦 *NPM Search*\n\nUsage: ${prefix}npmsearch <package name>\nExample: ${prefix}npmsearch express`);
  await devtrust.sendMessage(m.chat, { react: { text: '📦', key: m.key } });
  try {
    const r = await princeGet('/api/search/npmsearch', { q: text });
    if (r.ok && r.data?.success && r.data.result) {
      const results = Array.isArray(r.data.result) ? r.data.result : [r.data.result];
      let msg = `📦 *NPM Search: ${text}*\n\n`;
      for (const item of results.slice(0, 5)) {
        const name = item?.name || 'package';
        const desc = item?.description || '';
        const version = item?.version || '';
        const downloads = item?.downloads || '';
        msg += `📦 *${name}*${version ? ` v${version}` : ''}\n${desc ? `📝 ${desc.slice(0, 80)}\n` : ''}${downloads ? `⬇️ ${downloads} downloads\n` : ''}🔗 https://npmjs.com/package/${name}\n\n`;
      }
      return reply(msg.trim());
    }
    reply('❌ NPM search failed.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'wattpad':
case 'searchstory': {
  if (!text) return reply(`📚 *Wattpad Search*\n\nUsage: ${prefix}wattpad <story title>\nExample: ${prefix}wattpad After`);
  await devtrust.sendMessage(m.chat, { react: { text: '📚', key: m.key } });
  try {
    const r = await princeGet('/api/search/wattpad', { q: text });
    if (r.ok && r.data?.success && r.data.result) {
      const results = Array.isArray(r.data.result) ? r.data.result : [r.data.result];
      let msg = `📚 *Wattpad: ${text}*\n\n`;
      for (const item of results.slice(0, 5)) {
        const title = item?.title || item?.name || 'Story';
        const author = item?.user?.name || item?.author || '';
        const url = item?.url || '';
        const reads = item?.reads || '';
        msg += `📖 *${title}*${author ? `\n✍️ ${author}` : ''}${reads ? ` | 👁️ ${reads} reads` : ''}${url ? `\n🔗 ${url}` : ''}\n\n`;
      }
      return reply(msg.trim());
    }
    reply('❌ Wattpad search failed.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'wikimedia':
case '__dup_removed_wiki__': {  // moved to mias/index.js
  if (!text) return reply(`📚 *Wikimedia Search*\n\nUsage: ${prefix}wiki <topic>\nExample: ${prefix}wiki Nigeria`);
  await devtrust.sendMessage(m.chat, { react: { text: '📚', key: m.key } });
  try {
    const r = await princeGet('/api/search/wikimedia', { q: text });
    if (r.ok && r.data?.success && r.data.result) {
      const res = r.data.result;
      const title = res?.title || text;
      const extract = res?.extract || (typeof res === 'string' ? res : JSON.stringify(res));
      return reply(`📚 *${title}*\n\n${extract.slice(0, 2000)}\n\n_Source: Wikipedia_`);
    }
    // Fallback: Wikipedia API
    const wikiRes = await axios.get(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(text)}`, { timeout: 10000 });
    const wikiData = wikiRes.data;
    if (wikiData?.extract) return reply(`📚 *${wikiData.title}*\n\n${wikiData.extract}\n\n🔗 ${wikiData.content_urls?.desktop?.page || ''}`);
    reply('❌ Wikimedia search failed.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'stickersearch':
case 'searchsticker': {
  if (!text) return reply(`🔖 *Sticker Search*\n\nUsage: ${prefix}stickersearch <keyword>\nExample: ${prefix}stickersearch happy`);
  await devtrust.sendMessage(m.chat, { react: { text: '🔖', key: m.key } });
  try {
    const r = await princeGet('/api/search/stickersearch', { q: text });
    if (r.ok && r.data?.success && r.data.result) {
      const results = Array.isArray(r.data.result) ? r.data.result : [r.data.result];
      const sticker = results[Math.floor(Math.random() * Math.min(results.length, 5))];
      const stickerUrl = sticker?.url || sticker?.image || (typeof sticker === 'string' ? sticker : null);
      if (stickerUrl) {
        const buf = await getBuffer(stickerUrl, { timeout: 20000 });
        return await devtrust.sendMessage(m.chat, { sticker: buf }, { quoted: m });
      }
    }
    reply('❌ No stickers found for: ' + text);
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case '__dup_removed_xnxxsearch__':  // moved to mias/index.js
case 'searchxnxx': {
  if (m.isGroup) return reply('❌ Adult search is only available in private chats.');
  if (!text) return reply(`🔞 *XNXX Search*\n\nUsage: ${prefix}xnxxsearch <keyword>`);
  await devtrust.sendMessage(m.chat, { react: { text: '🔞', key: m.key } });
  try {
    const r = await princeGet('/api/search/xnxxsearch', { q: text });
    if (r.ok && r.data?.success && r.data.result) {
      const results = Array.isArray(r.data.result) ? r.data.result : [r.data.result];
      let msg = `🔞 *XNXX Search: ${text}*\n\n`;
      for (const item of results.slice(0, 5)) {
        const title = item?.title || 'Video';
        const url = item?.url || item?.link || '';
        const duration = item?.duration || '';
        const views = item?.views || '';
        msg += `🎬 *${title.slice(0, 60)}*${duration ? ` | ⏱️ ${duration}` : ''}${views ? ` | 👁️ ${views}` : ''}${url ? `\n🔗 ${url}` : ''}\n\n`;
      }
      return reply(msg.trim());
    }
    reply('❌ XNXX search failed.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case '__dup_removed_xvideossearch__':  // moved to mias/index.js
case 'searchxvideos': {
  if (m.isGroup) return reply('❌ Adult search is only available in private chats.');
  if (!text) return reply(`🔞 *XVideos Search*\n\nUsage: ${prefix}xvideossearch <keyword>`);
  await devtrust.sendMessage(m.chat, { react: { text: '🔞', key: m.key } });
  try {
    const r = await princeGet('/api/search/xvideossearch', { q: text });
    if (r.ok && r.data?.success && r.data.result) {
      const results = Array.isArray(r.data.result) ? r.data.result : [r.data.result];
      let msg = `🔞 *XVideos Search: ${text}*\n\n`;
      for (const item of results.slice(0, 5)) {
        const title = item?.title || 'Video';
        const url = item?.url || item?.link || '';
        const duration = item?.duration || '';
        msg += `🎬 *${title.slice(0, 60)}*${duration ? ` | ⏱️ ${duration}` : ''}${url ? `\n🔗 ${url}` : ''}\n\n`;
      }
      return reply(msg.trim());
    }
    reply('❌ XVideos search failed.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

// ─────────────────────────── STALK COMMANDS ───────────────────────────

case 'gitstalk':
case '__dup_removed_githubstalk__':  // moved to mias/index.js
case 'gitprofile': {
  if (!text) return reply(`🐙 *GitHub Profile Stalk*\n\nUsage: ${prefix}gitstalk <username>\nExample: ${prefix}gitstalk torvalds`);
  await devtrust.sendMessage(m.chat, { react: { text: '🐙', key: m.key } });
  try {
    const username = text.replace(/https?:\/\/(www\.)?github\.com\//i, '').split('/')[0].trim();
    const r = await princeGet('/api/stalk/gitstalk', { username });
    if (r.ok && r.data?.success && r.data.result) {
      const res = r.data.result;
      const name = res.name || res.login || username;
      const bio = res.bio || 'No bio';
      const location = res.location || 'N/A';
      const company = res.company || 'N/A';
      const repos = res.public_repos ?? 'N/A';
      const followers = res.followers ?? 'N/A';
      const following = res.following ?? 'N/A';
      const url = res.html_url || `https://github.com/${username}`;
      const avatar = res.avatar_url;
      const msg = `🐙 *GitHub: ${name}*\n\n👤 *Username:* @${res.login || username}\n📝 *Bio:* ${bio}\n📍 *Location:* ${location}\n🏢 *Company:* ${company}\n📁 *Repos:* ${repos}\n👥 *Followers:* ${followers} | *Following:* ${following}\n🔗 ${url}`;
      if (avatar) {
        const avatarBuf = await getBuffer(avatar, { timeout: 15000 });
        return await devtrust.sendMessage(m.chat, { image: avatarBuf, caption: msg }, { quoted: m });
      }
      return reply(msg);
    }
    reply('❌ GitHub user not found.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case '__dup_removed_igstalk__':  // moved to mias/index.js
case 'instastalk':
case 'igprofile': {
  if (!text) return reply(`📸 *Instagram Profile Stalk*\n\nUsage: ${prefix}igstalk <username>\nExample: ${prefix}igstalk instagram`);
  await devtrust.sendMessage(m.chat, { react: { text: '📸', key: m.key } });
  try {
    const username = text.replace(/https?:\/\/(www\.)?instagram\.com\//i, '').replace(/\//g, '').trim();
    const r = await princeGet('/api/stalk/igstalk', { username });
    if (r.ok && r.data?.success && r.data.result) {
      const res = r.data.result;
      if (res.status === 'error') return reply(`❌ Could not stalk @${username}. Account may be private.`);
      const name = res.full_name || res.username || username;
      const bio = res.biography || 'No bio';
      const followers = res.edge_followed_by?.count ?? res.followers ?? 'N/A';
      const following = res.edge_follow?.count ?? res.following ?? 'N/A';
      const posts = res.edge_owner_to_timeline_media?.count ?? res.posts ?? 'N/A';
      const isPrivate = res.is_private ? 'Yes 🔒' : 'No 🔓';
      const isVerified = res.is_verified ? 'Yes ✅' : 'No';
      const avatar = res.profile_pic_url_hd || res.profile_pic_url;
      const msg = `📸 *Instagram: ${name}*\n\n👤 *Username:* @${res.username || username}\n📝 *Bio:* ${bio}\n👥 *Followers:* ${followers}\n👤 *Following:* ${following}\n📷 *Posts:* ${posts}\n🔒 *Private:* ${isPrivate}\n✅ *Verified:* ${isVerified}`;
      if (avatar) {
        try {
          const avatarBuf = await getBuffer(avatar, { timeout: 15000 });
          return await devtrust.sendMessage(m.chat, { image: avatarBuf, caption: msg }, { quoted: m });
        } catch (_) {}
      }
      return reply(msg);
    }
    reply('❌ Instagram profile not found or private.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'ipstalk':
case '__dup_removed_iplookup__':  // moved to mias/index.js
case '__dup_removed_ipinfo__': {  // moved to mias/index.js
  if (!text) return reply(`🌍 *IP Stalk / Lookup*\n\nUsage: ${prefix}ipstalk <ip address>\nExample: ${prefix}ipstalk 8.8.8.8`);
  await devtrust.sendMessage(m.chat, { react: { text: '🌍', key: m.key } });
  try {
    const r = await princeGet('/api/stalk/ipstalk', { ip: text, address: text });
    if (r.ok && r.data?.success && r.data.result) {
      const res = r.data.result;
      let msg = `🌍 *IP Lookup: ${text}*\n\n`;
      const fields = {
        '🌐 IP': res.ip || text,
        '🏳️ Country': res.country || res.country_name || 'N/A',
        '🏙️ City': res.city || 'N/A',
        '📍 Region': res.region || 'N/A',
        '🏢 ISP': res.isp || res.org || 'N/A',
        '⏰ Timezone': res.timezone || 'N/A',
        '📡 Latitude': res.lat || res.latitude || 'N/A',
        '📡 Longitude': res.lon || res.longitude || 'N/A',
        '🔒 Proxy': res.proxy ? 'Yes' : 'No',
        '🏠 Hosting': res.hosting ? 'Yes' : 'No',
      };
      for (const [k, v] of Object.entries(fields)) msg += `${k}: ${v}\n`;
      return reply(msg.trim());
    }
    // Fallback: ip-api.com
    const ipRes = await axios.get(`http://ip-api.com/json/${text}`, { timeout: 10000 });
    const ipData = ipRes.data;
    if (ipData?.status === 'success') {
      return reply(`🌍 *IP Lookup: ${text}*\n\n🌐 IP: ${ipData.query}\n🏳️ Country: ${ipData.country}\n🏙️ City: ${ipData.city}\n📍 Region: ${ipData.regionName}\n🏢 ISP: ${ipData.isp}\n⏰ Timezone: ${ipData.timezone}\n📡 Lat/Lon: ${ipData.lat}, ${ipData.lon}`);
    }
    reply('❌ IP lookup failed. Check the IP address.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case '__dup_removed_npmstalk__':  // moved to mias/index.js
case 'npmpackage': {
  if (!text) return reply(`📦 *NPM Package Stalk*\n\nUsage: ${prefix}npmstalk <package name>\nExample: ${prefix}npmstalk express`);
  await devtrust.sendMessage(m.chat, { react: { text: '📦', key: m.key } });
  try {
    const r = await princeGet('/api/stalk/npmstalk', { q: text, package: text });
    if (r.ok && r.data?.success && r.data.result) {
      const res = r.data.result;
      const name = res.name || text;
      const desc = res.description || 'No description';
      const version = res['dist-tags']?.latest || res.version || 'N/A';
      const author = res.author?.name || res.author || 'N/A';
      const license = res.license || 'N/A';
      const homepage = res.homepage || `https://npmjs.com/package/${name}`;
      return reply(`📦 *NPM: ${name}*\n\n📝 *Desc:* ${desc.slice(0, 200)}\n🏷️ *Version:* ${version}\n✍️ *Author:* ${author}\n⚖️ *License:* ${license}\n🔗 ${homepage}`);
    }
    // Fallback: npm registry API
    const npmRes = await axios.get(`https://registry.npmjs.org/${text}`, { timeout: 10000 });
    const npmData = npmRes.data;
    if (npmData?.name) {
      const latest = npmData['dist-tags']?.latest;
      return reply(`📦 *NPM: ${npmData.name}*\n\n📝 ${npmData.description || 'No description'}\n🏷️ v${latest || 'N/A'}\n⚖️ ${npmData.license || 'N/A'}\n🔗 https://npmjs.com/package/${npmData.name}`);
    }
    reply('❌ NPM package not found.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'tiktokstalk':
case 'tiktoklookup': {
  if (!text) return reply(`🎵 *TikTok Profile Stalk*\n\nUsage: ${prefix}tiktokstalk <username>\nExample: ${prefix}tiktokstalk charlidamelio`);
  await devtrust.sendMessage(m.chat, { react: { text: '🎵', key: m.key } });
  try {
    const username = text.replace('@', '').trim();
    const r = await princeGet('/api/stalk/tiktokstalk', { username });
    if (r.ok && r.data?.success && r.data.result) {
      const res = r.data.result;
      const name = res.nickname || res.unique_id || username;
      const bio = res.signature || 'No bio';
      const followers = res.follower_count ?? 'N/A';
      const following = res.following_count ?? 'N/A';
      const videos = res.video_count ?? 'N/A';
      const likes = res.total_favorited ?? res.heart_count ?? 'N/A';
      const avatar = res.avatar_larger || res.avatar_thumb;
      const msg = `🎵 *TikTok: ${name}*\n\n👤 *Username:* @${res.unique_id || username}\n📝 *Bio:* ${bio}\n👥 *Followers:* ${followers}\n👤 *Following:* ${following}\n🎬 *Videos:* ${videos}\n❤️ *Likes:* ${likes}`;
      if (avatar) {
        try {
          const avatarBuf = await getBuffer(avatar, { timeout: 15000 });
          return await devtrust.sendMessage(m.chat, { image: avatarBuf, caption: msg }, { quoted: m });
        } catch (_) {}
      }
      return reply(msg);
    }
    reply('❌ TikTok user not found.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'wachannel':
case 'channelinfo': {
  if (!text) return reply(`📢 *WhatsApp Channel Info*\n\nUsage: ${prefix}wachannel <channel-link>\nExample: ${prefix}wachannel https://whatsapp.com/channel/xxx`);
  await devtrust.sendMessage(m.chat, { react: { text: '📢', key: m.key } });
  try {
    const r = await princeGet('/api/stalk/wachannel', { url: text, link: text });
    if (r.ok && r.data?.success && r.data.result) {
      const res = r.data.result;
      const name = res.name || res.title || 'Unknown Channel';
      const desc = res.description || 'No description';
      const subscribers = res.subscribers || res.followers || 'N/A';
      return reply(`📢 *WA Channel: ${name}*\n\n📝 ${desc}\n👥 *Subscribers:* ${subscribers}`);
    }
    reply('❌ Could not fetch WhatsApp channel info.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

// ─────────────────────────── ANIME COMMANDS ───────────────────────────

case '__dup_removed_waifu__':  // moved to mias/index.js
case 'animegirl': {
  await devtrust.sendMessage(m.chat, { react: { text: '🌸', key: m.key } });
  try {
    let waifuUrl = null;
    let waifuCaption = '🌸 *Waifu*';

    // Source 1: nekos.best (most reliable, returns high-quality anime images)
    if (!waifuUrl) {
      try {
        const r1 = await axios.get('https://nekos.best/api/v2/waifu', { timeout: 12000 });
        const result1 = r1.data?.results?.[0];
        if (result1?.url) { waifuUrl = result1.url; waifuCaption = `🌸 *Waifu* — _${result1?.anime_name || 'Anime Girl'}_`; }
      } catch (_) {}
    }

    // Source 2: waifu.im
    if (!waifuUrl) {
      try {
        const r2 = await axios.get('https://api.waifu.im/search/?included_tags=waifu', { timeout: 10000 });
        if (r2.data?.images?.[0]?.url) { waifuUrl = r2.data.images[0].url; }
      } catch (_) {}
    }

    // Source 3: waifu.pics
    if (!waifuUrl) {
      try {
        const r3 = await axios.get('https://api.waifu.pics/sfw/waifu', { timeout: 10000 });
        if (r3.data?.url) { waifuUrl = r3.data.url; }
      } catch (_) {}
    }

    // Source 4: prince API (original fallback)
    if (!waifuUrl) {
      try {
        const r4 = await princeGet('/api/anime/waifu');
        if (r4.ok && r4.data?.success && r4.data.result) {
          const imgUrl = typeof r4.data.result === 'string' ? r4.data.result : r4.data.result?.url || r4.data.result?.image;
          if (imgUrl) waifuUrl = imgUrl;
        }
      } catch (_) {}
    }

    if (waifuUrl) {
      // Use { url } directly — avoids getBuffer timeout/failures; Baileys streams it
      try {
        return await devtrust.sendMessage(m.chat, { image: { url: waifuUrl }, caption: waifuCaption }, { quoted: m });
      } catch (_sendErr) {
        // If Baileys can't stream it, download buffer as last resort
        try {
          const buf = await getBuffer(waifuUrl, { timeout: 30000 });
          return await devtrust.sendMessage(m.chat, { image: buf, caption: waifuCaption }, { quoted: m });
        } catch (_bufErr) {}
      }
    }
    reply('❌ Waifu image sources are all busy right now — try again in a moment!');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'ecchi': {
  if (m.isGroup) return reply('❌ NSFW content is only available in private chats.');
  await devtrust.sendMessage(m.chat, { react: { text: '🔞', key: m.key } });
  try {
    const r = await princeGet('/api/anime/ecchi');
    if (r.ok && r.data?.success && r.data.result) {
      const imgUrl = typeof r.data.result === 'string' ? r.data.result : r.data.result?.url;
      if (imgUrl) {
        const buf = await getBuffer(imgUrl, { timeout: 20000 });
        return await devtrust.sendMessage(m.chat, { image: buf, caption: '🔞 *Ecchi*' }, { quoted: m });
      }
    }
    reply('❌ Could not fetch ecchi image.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'ero': {
  if (m.isGroup) return reply('❌ NSFW content is only available in private chats.');
  await devtrust.sendMessage(m.chat, { react: { text: '🔞', key: m.key } });
  try {
    const r = await princeGet('/api/anime/ero');
    if (r.ok && r.data?.success && r.data.result) {
      const imgUrl = typeof r.data.result === 'string' ? r.data.result : r.data.result?.url;
      if (imgUrl) {
        const buf = await getBuffer(imgUrl, { timeout: 20000 });
        return await devtrust.sendMessage(m.chat, { image: buf, caption: '🔞 *Ero*' }, { quoted: m });
      }
    }
    reply('❌ Could not fetch ero image.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'hneko': {
  if (m.isGroup) return reply('❌ NSFW content is only available in private chats.');
  await devtrust.sendMessage(m.chat, { react: { text: '🔞', key: m.key } });
  try {
    const r = await princeGet('/api/anime/hneko');
    if (r.ok && r.data?.success && r.data.result) {
      const imgUrl = typeof r.data.result === 'string' ? r.data.result : r.data.result?.url;
      if (imgUrl) {
        const buf = await getBuffer(imgUrl, { timeout: 20000 });
        return await devtrust.sendMessage(m.chat, { image: buf, caption: '🔞 *H-Neko*' }, { quoted: m });
      }
    }
    reply('❌ Could not fetch hneko image.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'hwaifu': {
  if (m.isGroup) return reply('❌ NSFW content is only available in private chats.');
  await devtrust.sendMessage(m.chat, { react: { text: '🔞', key: m.key } });
  try {
    const r = await princeGet('/api/anime/hwaifu');
    if (r.ok && r.data?.success && r.data.result) {
      const imgUrl = typeof r.data.result === 'string' ? r.data.result : r.data.result?.url;
      if (imgUrl) {
        const buf = await getBuffer(imgUrl, { timeout: 20000 });
        return await devtrust.sendMessage(m.chat, { image: buf, caption: '🔞 *H-Waifu*' }, { quoted: m });
      }
    }
    reply('❌ Could not fetch hwaifu image.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'loli': {
  if (m.isGroup) return reply('❌ This content is only available in private chats.');
  await devtrust.sendMessage(m.chat, { react: { text: '🌸', key: m.key } });
  try {
    const r = await princeGet('/api/anime/loli');
    if (r.ok && r.data?.success && r.data.result) {
      const imgUrl = typeof r.data.result === 'string' ? r.data.result : r.data.result?.url;
      if (imgUrl) {
        const buf = await getBuffer(imgUrl, { timeout: 20000 });
        return await devtrust.sendMessage(m.chat, { image: buf, caption: '🌸 *Loli*' }, { quoted: m });
      }
    }
    reply('❌ Could not fetch loli image.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'maid':
case 'maidgirl': {
  await devtrust.sendMessage(m.chat, { react: { text: '👒', key: m.key } });
  try {
    const r = await princeGet('/api/anime/maid');
    if (r.ok && r.data?.success && r.data.result) {
      const imgUrl = typeof r.data.result === 'string' ? r.data.result : r.data.result?.url;
      if (imgUrl) {
        const buf = await getBuffer(imgUrl, { timeout: 20000 });
        return await devtrust.sendMessage(m.chat, { image: buf, caption: '👒 *Maid*' }, { quoted: m });
      }
    }
    reply('❌ Could not fetch maid image.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'megumin': {
  await devtrust.sendMessage(m.chat, { react: { text: '💥', key: m.key } });
  try {
    const r = await princeGet('/api/anime/megumin');
    if (r.ok && r.data?.success && r.data.result) {
      const imgUrl = typeof r.data.result === 'string' ? r.data.result : r.data.result?.url;
      if (imgUrl) {
        const buf = await getBuffer(imgUrl, { timeout: 20000 });
        return await devtrust.sendMessage(m.chat, { image: buf, caption: '💥 *Megumin*' }, { quoted: m });
      }
    }
    reply('❌ Could not fetch megumin image.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'milf': {
  if (m.isGroup) return reply('❌ NSFW content is only available in private chats.');
  await devtrust.sendMessage(m.chat, { react: { text: '🔞', key: m.key } });
  try {
    const r = await princeGet('/api/anime/milf');
    if (r.ok && r.data?.success && r.data.result) {
      const imgUrl = typeof r.data.result === 'string' ? r.data.result : r.data.result?.url;
      if (imgUrl) {
        const buf = await getBuffer(imgUrl, { timeout: 20000 });
        return await devtrust.sendMessage(m.chat, { image: buf, caption: '🔞 *MILF*' }, { quoted: m });
      }
    }
    reply('❌ Could not fetch image.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'awoo': {
  await devtrust.sendMessage(m.chat, { react: { text: '🐺', key: m.key } });
  try {
    const r = await princeGet('/api/anime/awoo');
    if (r.ok && r.data?.success && r.data.result) {
      const imgUrl = typeof r.data.result === 'string' ? r.data.result : r.data.result?.url;
      if (imgUrl) {
        const buf = await getBuffer(imgUrl, { timeout: 20000 });
        return await devtrust.sendMessage(m.chat, { image: buf, caption: '🐺 *Awoo!*' }, { quoted: m });
      }
    }
    reply('❌ Could not fetch awoo image.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'konachan': {
  await devtrust.sendMessage(m.chat, { react: { text: '🎨', key: m.key } });
  try {
    const r = await princeGet('/api/anime/konachan');
    if (r.ok && r.data?.success && r.data.result) {
      const imgUrl = typeof r.data.result === 'string' ? r.data.result : r.data.result?.url;
      if (imgUrl) {
        const buf = await getBuffer(imgUrl, { timeout: 20000 });
        return await devtrust.sendMessage(m.chat, { image: buf, caption: '🎨 *Konachan*' }, { quoted: m });
      }
    }
    reply('❌ Could not fetch konachan image.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case '__dup_removed_animequote__':  // moved to mias/index.js
case 'aquote': {
  await devtrust.sendMessage(m.chat, { react: { text: '📜', key: m.key } });
  try {
    const r = await princeGet('/api/anime/quotes');
    if (r.ok && r.data?.success && r.data.result) {
      const res = r.data.result;
      const quote = res?.quote || res?.text || (typeof res === 'string' ? res : JSON.stringify(res));
      const character = res?.character || res?.name || '';
      const anime = res?.anime || '';
      return reply(`📜 *Anime Quote*\n\n_"${quote}"_${character ? `\n\n— ${character}` : ''}${anime ? ` (${anime})` : ''}`);
    }
    reply('❌ Could not fetch anime quote.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case '__dup_removed_animechar__':  // moved to mias/index.js
case 'charquote': {
  await devtrust.sendMessage(m.chat, { react: { text: '🎭', key: m.key } });
  try {
    const r = await princeGet('/api/anime/char-quotes');
    if (r.ok && r.data?.success && r.data.result) {
      const res = r.data.result;
      const quote = res?.quote || res?.text || (typeof res === 'string' ? res : JSON.stringify(res));
      const character = res?.character || '';
      const anime = res?.anime || '';
      return reply(`🎭 *Character Quote*\n\n_"${quote}"_${character ? `\n\n— ${character}` : ''}${anime ? ` (${anime})` : ''}`);
    }
    reply('❌ Could not fetch character quote.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'showquote':
case 'animeshowquote': {
  await devtrust.sendMessage(m.chat, { react: { text: '📺', key: m.key } });
  try {
    const r = await princeGet('/api/anime/show-quotes');
    if (r.ok && r.data?.success && r.data.result) {
      const res = r.data.result;
      const quote = res?.quote || res?.text || (typeof res === 'string' ? res : JSON.stringify(res));
      const character = res?.character || '';
      const anime = res?.anime || '';
      return reply(`📺 *Anime Show Quote*\n\n_"${quote}"_${character ? `\n\n— ${character}` : ''}${anime ? ` (${anime})` : ''}`);
    }
    reply('❌ Could not fetch show quote.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'animeass':
case 'ass': {
  if (m.isGroup) return reply('❌ NSFW content is only available in private chats.');
  await devtrust.sendMessage(m.chat, { react: { text: '🔞', key: m.key } });
  try {
    const r = await princeGet('/api/anime/ass');
    if (r.ok && r.data?.success && r.data.result) {
      const imgUrl = typeof r.data.result === 'string' ? r.data.result : r.data.result?.url;
      if (imgUrl) {
        const buf = await getBuffer(imgUrl, { timeout: 20000 });
        return await devtrust.sendMessage(m.chat, { image: buf, caption: '🔞 *Anime*' }, { quoted: m });
      }
    }
    reply('❌ Could not fetch image.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'animerandom':
case 'randomanime': {
  await devtrust.sendMessage(m.chat, { react: { text: '🎲', key: m.key } });
  try {
    const r = await princeGet('/api/anime/random');
    if (r.ok && r.data?.success && r.data.result) {
      const imgUrl = typeof r.data.result === 'string' ? r.data.result : r.data.result?.url;
      if (imgUrl) {
        const buf = await getBuffer(imgUrl, { timeout: 20000 });
        return await devtrust.sendMessage(m.chat, { image: buf, caption: '🎲 *Random Anime*' }, { quoted: m });
      }
    }
    reply('❌ Could not fetch random anime image.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

// ─────────────────────────── FOOTBALL COMMANDS ───────────────────────────

case 'livescore':
case 'livefootball':
case 'scores': {
  await devtrust.sendMessage(m.chat, { react: { text: '⚽', key: m.key } });
  reply('⏳ Fetching live football scores...');
  try {
    const r = await princeGet('/api/football/livescore');
    if (r.ok && r.data?.success && r.data.result) {
      const res = r.data.result;
      const matches = res?.matches || res || [];
      if (!matches.length) return reply('⚽ No live matches right now.');
      const live = matches.filter(m => m.status === 'Live' || m.minute);
      const recent = matches.filter(m => m.status === 'Full Time').slice(0, 5);
      let msg = `⚽ *Live Football Scores*\n_${new Date().toLocaleString('en-GB', { timeZone: 'Africa/Lagos' })}_\n\n`;
      if (live.length) {
        msg += `🔴 *LIVE NOW (${live.length})*\n`;
        for (const m of live.slice(0, 8)) {
          msg += `${m.homeTeam} ${m.homeScore}-${m.awayScore} ${m.awayTeam} | ${m.minute}'\n`;
        }
        msg += '\n';
      }
      if (recent.length) {
        msg += `✅ *FULL TIME*\n`;
        for (const m of recent) {
          msg += `${m.homeTeam} ${m.homeScore}-${m.awayScore} ${m.awayTeam}\n`;
        }
      }
      if (!live.length && !recent.length) {
        const upcoming = matches.filter(m => m.status === 'Not Started').slice(0, 5);
        msg += `📅 *UPCOMING*\n`;
        for (const m of upcoming) {
          msg += `${m.homeTeam} vs ${m.awayTeam} | ${m.time}\n`;
        }
      }
      return reply(msg.trim());
    }
    reply('❌ Could not fetch live scores right now.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'predictions':
case 'footballprediction':
case 'sportpredictions': {
  await devtrust.sendMessage(m.chat, { react: { text: '🔮', key: m.key } });
  reply('⏳ Fetching predictions...');
  try {
    const r = await princeGet('/api/football/predictions');
    if (r.ok && r.data?.success && r.data.result) {
      const preds = Array.isArray(r.data.result) ? r.data.result.slice(0, 6) : [];
      if (!preds.length) return reply('❌ No predictions available right now.');
      let msg = `🔮 *Football Predictions Today*\n\n`;
      for (const p of preds) {
        const home = Math.round(p.predictions?.fulltime?.home || 0);
        const draw = Math.round(p.predictions?.fulltime?.draw || 0);
        const away = Math.round(p.predictions?.fulltime?.away || 0);
        const over = Math.round(p.predictions?.over_2_5?.yes || 0);
        const btts = Math.round(p.predictions?.bothTeamToScore?.yes || 0);
        msg += `⚽ *${p.match}*\n🏆 ${p.league}\n🏠 Home: ${home}% | 🤝 Draw: ${draw}% | ✈️ Away: ${away}%\n📊 O2.5: ${over}% | BTTS: ${btts}%\n\n`;
      }
      return reply(msg.trim());
    }
    reply('❌ Predictions not available right now.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'footynews':
case 'footballnews':
case 'sportnews': {
  await devtrust.sendMessage(m.chat, { react: { text: '📰', key: m.key } });
  try {
    const r = await princeGet('/api/football/news');
    if (r.ok && r.data?.success && r.data.result) {
      const items = r.data.result?.data?.items || r.data.result?.items || (Array.isArray(r.data.result) ? r.data.result : []);
      if (!items.length) return reply('❌ No football news right now.');
      let msg = `📰 *Football News*\n\n`;
      for (const item of items.slice(0, 5)) {
        const title = item.title || 'News';
        const summary = item.summary || '';
        msg += `🔵 *${title}*\n${summary.slice(0, 120)}\n\n`;
      }
      return reply(msg.trim());
    }
    reply('❌ Football news unavailable.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'eplstandings':
case 'premier':
case 'premierleague': {
  await devtrust.sendMessage(m.chat, { react: { text: '🏴󠁧󠁢󠁥󠁮󠁧󠁿', key: m.key } });
  try {
    const r = await princeGet('/api/football/epl/standings');
    if (r.ok && r.data?.success && r.data.result) {
      const teams = Array.isArray(r.data.result) ? r.data.result.slice(0, 10) : [];
      let msg = `🏴󠁧󠁢󠁥󠁮󠁧󠁿 *Premier League Standings*\n\n`;
      for (const t of teams) {
        const pos = t.position || t.rank || teams.indexOf(t) + 1;
        const name = t.team || t.name || 'Unknown';
        const pts = t.points || t.pts || 0;
        const p = t.played || t.mp || 0;
        msg += `${pos}. *${name}* — ${pts} pts (${p} played)\n`;
      }
      return reply(msg.trim());
    }
    reply('❌ EPL standings unavailable.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'eplscorers':
case 'topscorers': {
  await devtrust.sendMessage(m.chat, { react: { text: '⚽', key: m.key } });
  try {
    const r = await princeGet('/api/football/epl/scorers');
    if (r.ok && r.data?.success && r.data.result) {
      const scorers = Array.isArray(r.data.result) ? r.data.result.slice(0, 10) : [];
      let msg = `⚽ *EPL Top Scorers*\n\n`;
      for (const s of scorers) {
        const pos = scorers.indexOf(s) + 1;
        const name = s.player || s.name || 'Unknown';
        const team = s.team || s.club || '';
        const goals = s.goals || s.goal || 0;
        msg += `${pos}. *${name}* (${team}) — ${goals} goals\n`;
      }
      return reply(msg.trim());
    }
    reply('❌ EPL scorers unavailable.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'laliga':
case 'laligastandings': {
  await devtrust.sendMessage(m.chat, { react: { text: '🇪🇸', key: m.key } });
  try {
    const r = await princeGet('/api/football/laliga/standings');
    if (r.ok && r.data?.success && r.data.result) {
      const teams = Array.isArray(r.data.result) ? r.data.result.slice(0, 10) : [];
      let msg = `🇪🇸 *La Liga Standings*\n\n`;
      for (const t of teams) {
        const pos = t.position || teams.indexOf(t) + 1;
        const name = t.team || t.name || 'Unknown';
        const pts = t.points || t.pts || 0;
        const p = t.played || t.mp || 0;
        msg += `${pos}. *${name}* — ${pts} pts (${p}P)\n`;
      }
      return reply(msg.trim());
    }
    reply('❌ La Liga standings unavailable.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'bundesliga':
case 'bundesligastandings': {
  await devtrust.sendMessage(m.chat, { react: { text: '🇩🇪', key: m.key } });
  try {
    const r = await princeGet('/api/football/bundesliga/standings');
    if (r.ok && r.data?.success && r.data.result) {
      const teams = Array.isArray(r.data.result) ? r.data.result.slice(0, 10) : [];
      let msg = `🇩🇪 *Bundesliga Standings*\n\n`;
      for (const t of teams) {
        const pos = t.position || teams.indexOf(t) + 1;
        const name = t.team || t.name || 'Unknown';
        const pts = t.points || t.pts || 0;
        msg += `${pos}. *${name}* — ${pts} pts\n`;
      }
      return reply(msg.trim());
    }
    reply('❌ Bundesliga standings unavailable.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'seriea':
case 'serieastandings': {
  await devtrust.sendMessage(m.chat, { react: { text: '🇮🇹', key: m.key } });
  try {
    const r = await princeGet('/api/football/seriea/standings');
    if (r.ok && r.data?.success && r.data.result) {
      const teams = Array.isArray(r.data.result) ? r.data.result.slice(0, 10) : [];
      let msg = `🇮🇹 *Serie A Standings*\n\n`;
      for (const t of teams) {
        const pos = t.position || teams.indexOf(t) + 1;
        const name = t.team || t.name || 'Unknown';
        const pts = t.points || t.pts || 0;
        msg += `${pos}. *${name}* — ${pts} pts\n`;
      }
      return reply(msg.trim());
    }
    reply('❌ Serie A standings unavailable.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'ligue1':
case 'ligue1standings': {
  await devtrust.sendMessage(m.chat, { react: { text: '🇫🇷', key: m.key } });
  try {
    const r = await princeGet('/api/football/ligue1/standings');
    if (r.ok && r.data?.success && r.data.result) {
      const teams = Array.isArray(r.data.result) ? r.data.result.slice(0, 10) : [];
      let msg = `🇫🇷 *Ligue 1 Standings*\n\n`;
      for (const t of teams) {
        const pos = t.position || teams.indexOf(t) + 1;
        const name = t.team || t.name || 'Unknown';
        const pts = t.points || t.pts || 0;
        msg += `${pos}. *${name}* — ${pts} pts\n`;
      }
      return reply(msg.trim());
    }
    reply('❌ Ligue 1 standings unavailable.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'europastandings': {
  await devtrust.sendMessage(m.chat, { react: { text: '🏆', key: m.key } });
  try {
    const r = await princeGet('/api/football/europa/standings');
    if (r.ok && r.data?.success && r.data.result) {
      const teams = Array.isArray(r.data.result) ? r.data.result.slice(0, 10) : [];
      let msg = `🏆 *Europa League Standings*\n\n`;
      for (const t of teams) {
        const pos = t.position || teams.indexOf(t) + 1;
        const name = t.team || t.name || 'Unknown';
        const pts = t.points || t.pts || 0;
        msg += `${pos}. *${name}* — ${pts} pts\n`;
      }
      return reply(msg.trim());
    }
    reply('❌ Europa standings unavailable.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'fifastandings':
case 'fifaworld': {
  await devtrust.sendMessage(m.chat, { react: { text: '🌍', key: m.key } });
  try {
    const r = await princeGet('/api/football/fifa/standings');
    if (r.ok && r.data?.success && r.data.result) {
      const teams = Array.isArray(r.data.result) ? r.data.result.slice(0, 10) : [];
      let msg = `🌍 *FIFA World Rankings*\n\n`;
      for (const t of teams) {
        const pos = t.rank || t.position || teams.indexOf(t) + 1;
        const name = t.team || t.country || t.name || 'Unknown';
        const pts = t.points || t.pts || '';
        msg += `${pos}. *${name}*${pts ? ` — ${pts} pts` : ''}\n`;
      }
      return reply(msg.trim());
    }
    reply('❌ FIFA standings unavailable.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'playerinfo':
case 'playersearch': {
  if (!text) return reply(`⚽ *Player Search*\n\nUsage: ${prefix}playerinfo <player name>\nExample: ${prefix}playerinfo Mbappe`);
  await devtrust.sendMessage(m.chat, { react: { text: '⚽', key: m.key } });
  try {
    const r = await princeGet('/api/football/player-search', { q: text, name: text });
    if (r.ok && r.data?.success && r.data.result) {
      const results = Array.isArray(r.data.result) ? r.data.result : [r.data.result];
      const p = results[0];
      if (p) {
        let msg = `⚽ *Player: ${p.name || p.player || text}*\n\n`;
        for (const [k, v] of Object.entries(p).slice(0, 10)) {
          if (v && typeof v !== 'object') msg += `*${k}:* ${v}\n`;
        }
        return reply(msg.trim());
      }
    }
    reply(`❌ Player "${text}" not found.`);
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'teaminfo':
case 'teamsearch': {
  if (!text) return reply(`🏟️ *Team Search*\n\nUsage: ${prefix}teaminfo <team name>\nExample: ${prefix}teaminfo Manchester City`);
  await devtrust.sendMessage(m.chat, { react: { text: '🏟️', key: m.key } });
  try {
    const r = await princeGet('/api/football/team-search', { q: text, name: text });
    if (r.ok && r.data?.success && r.data.result) {
      const results = Array.isArray(r.data.result) ? r.data.result : [r.data.result];
      const t = results[0];
      if (t) {
        let msg = `🏟️ *Team: ${t.name || t.team || text}*\n\n`;
        for (const [k, v] of Object.entries(t).slice(0, 10)) {
          if (v && typeof v !== 'object') msg += `*${k}:* ${v}\n`;
        }
        return reply(msg.trim());
      }
    }
    reply(`❌ Team "${text}" not found.`);
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case '__dup_removed_basketball__':  // moved to mias/index.js
case '__dup_removed_nba__':  // moved to mias/index.js
case 'basketballlive': {
  await devtrust.sendMessage(m.chat, { react: { text: '🏀', key: m.key } });
  try {
    const r = await princeGet('/api/football/basketball-live');
    if (r.ok && r.data?.success && r.data.result) {
      const matches = Array.isArray(r.data.result) ? r.data.result : r.data.result?.matches || [];
      if (!matches.length) return reply('🏀 No live basketball matches right now.');
      let msg = `🏀 *Live Basketball Scores*\n\n`;
      for (const m of matches.slice(0, 8)) {
        msg += `${m.homeTeam} ${m.homeScore}-${m.awayScore} ${m.awayTeam} | ${m.status}\n`;
      }
      return reply(msg.trim());
    }
    reply('❌ Basketball scores unavailable.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'streamlinks':
case 'footballstream':
case 'streamfootball': {
  await devtrust.sendMessage(m.chat, { react: { text: '📺', key: m.key } });
  try {
    const r = await princeGet('/api/football/streaming');
    if (r.ok && r.data?.success && r.data.result) {
      const streams = Array.isArray(r.data.result) ? r.data.result : [r.data.result];
      let msg = `📺 *Football Streaming Links*\n\n`;
      for (const s of streams.slice(0, 8)) {
        const name = s.name || s.channel || s.title || 'Stream';
        const url = s.url || s.link || s.stream || '';
        msg += `📡 *${name}*${url ? `\n🔗 ${url}` : ''}\n\n`;
      }
      if (msg.trim() === '📺 *Football Streaming Links*') return reply('❌ No streaming links available right now.');
      return reply(msg.trim());
    }
    reply('❌ Streaming links unavailable.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'allstreams':
case 'allstreamlinks': {
  await devtrust.sendMessage(m.chat, { react: { text: '📺', key: m.key } });
  try {
    const r = await princeGet('/api/football/streaming/all');
    if (r.ok && r.data?.success && r.data.result) {
      const streams = Array.isArray(r.data.result) ? r.data.result : [r.data.result];
      let msg = `📺 *All Streaming Links*\n\n`;
      for (const s of streams.slice(0, 10)) {
        const name = s.name || s.channel || s.title || 'Stream';
        const url = s.url || s.link || s.stream || '';
        msg += `📡 *${name}*${url ? `\n🔗 ${url}` : ''}\n\n`;
      }
      return reply(msg.trim());
    }
    reply('❌ No stream links available.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'eplmatches':
case 'eplupcoming': {
  await devtrust.sendMessage(m.chat, { react: { text: '🏴󠁧󠁢󠁥󠁮󠁧󠁿', key: m.key } });
  try {
    const r = await princeGet(command === 'eplmatches' ? '/api/football/epl/matches' : '/api/football/epl/upcoming');
    if (r.ok && r.data?.success && r.data.result) {
      const matches = Array.isArray(r.data.result) ? r.data.result.slice(0, 8) : [];
      let msg = `🏴󠁧󠁢󠁥󠁮󠁧󠁿 *EPL ${command === 'eplmatches' ? 'Matches' : 'Upcoming'}*\n\n`;
      for (const m of matches) {
        const home = m.homeTeam || m.home || 'Home';
        const away = m.awayTeam || m.away || 'Away';
        const date = m.date || m.time || '';
        msg += `⚽ ${home} vs ${away}${date ? ` | ${date}` : ''}\n`;
      }
      return reply(msg.trim());
    }
    reply('❌ EPL match data unavailable.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'eurosstandings':
case 'euros': {
  await devtrust.sendMessage(m.chat, { react: { text: '🇪🇺', key: m.key } });
  try {
    const r = await princeGet('/api/football/euros/standings');
    if (r.ok && r.data?.success && r.data.result) {
      const teams = Array.isArray(r.data.result) ? r.data.result.slice(0, 10) : [];
      let msg = `🇪🇺 *Euros Standings*\n\n`;
      for (const t of teams) {
        const pos = t.position || teams.indexOf(t) + 1;
        const name = t.team || t.country || t.name || 'Unknown';
        const pts = t.points || t.pts || 0;
        msg += `${pos}. *${name}* — ${pts} pts\n`;
      }
      return reply(msg.trim());
    }
    reply('❌ Euros standings unavailable.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

// ─────────────────────────── NEWS COMMANDS ───────────────────────────

case '__dup_removed_news__':  // moved to mias/index.js
case 'latestnews': {
  await devtrust.sendMessage(m.chat, { react: { text: '📰', key: m.key } });
  reply('⏳ Fetching latest news...');
  try {
    const category = args[0]?.toLowerCase() || 'all';
    let endpoint = '/api/newsstreaming/all';
    const r = await princeGet(endpoint);
    if (r.ok && r.data?.success && r.data.result) {
      const items = r.data.result?.data?.items || r.data.result?.items || (Array.isArray(r.data.result) ? r.data.result : []);
      if (!items.length) return reply('❌ No news available right now.');
      let msg = `📰 *Latest News*\n_${new Date().toLocaleDateString('en-GB', { timeZone: 'Africa/Lagos' })}_\n\n`;
      for (const item of items.slice(0, 6)) {
        const title = item.title || 'News';
        const summary = item.summary || item.description || '';
        msg += `🔵 *${title}*\n${summary.slice(0, 150)}\n\n`;
      }
      return reply(msg.trim());
    }
    reply('❌ News feed unavailable right now.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'newschannels': {
  await devtrust.sendMessage(m.chat, { react: { text: '📡', key: m.key } });
  try {
    const r = await princeGet('/api/newsstreaming/channels');
    if (r.ok && r.data?.success && r.data.result) {
      const channels = Array.isArray(r.data.result) ? r.data.result : [r.data.result];
      let msg = `📡 *News Channels*\n\n`;
      for (const c of channels.slice(0, 10)) {
        const name = c.name || c.channel || (typeof c === 'string' ? c : JSON.stringify(c));
        const url = c.url || c.link || '';
        msg += `📺 *${name}*${url ? `\n🔗 ${url}` : ''}\n\n`;
      }
      return reply(msg.trim());
    }
    reply('❌ News channels unavailable.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

case 'newscountries': {
  await devtrust.sendMessage(m.chat, { react: { text: '🌍', key: m.key } });
  try {
    const r = await princeGet('/api/newsstreaming/countries');
    if (r.ok && r.data?.success && r.data.result) {
      const countries = Array.isArray(r.data.result) ? r.data.result : [r.data.result];
      let msg = `🌍 *News by Country*\n\n`;
      for (const c of countries.slice(0, 15)) {
        const name = c.name || c.country || (typeof c === 'string' ? c : JSON.stringify(c));
        msg += `• ${name}\n`;
      }
      return reply(msg.trim());
    }
    reply('❌ Countries list unavailable.');
  } catch (e) { reply(`❌ Error: ${e.message}`); }
}
break;

// ─────────────────────────── END PRINCE API COMMANDS ───────────────────────────

// ═══════════════════════════════════════════════════════════════════════════
// KEVDRA STABILITY ADDITIONS — Sticker SetCmd, Force Private, Settings 19.x
// Added for MIAS LITE MDX stability
// ═══════════════════════════════════════════════════════════════════════════

// ─── Sticker SetCmd System ─────────────────────────────────────────────────
case 'setcmd': {  // moved to mias/index.js
  if (!isCreator) return reply("🚫 Owner only command.");
  // Requires replying to a sticker
  const unwrapQuotedSticker = (q) => {
    let cur = q;
    for (let i = 0; i < 6 && cur; i++) {
      if (cur.stickerMessage) return cur.stickerMessage;
      cur = cur.ephemeralMessage?.message || cur.viewOnceMessage?.message || cur.viewOnceMessageV2?.message || cur.viewOnceMessageV2Extension?.message || cur.documentWithCaptionMessage?.message || cur.editedMessage?.message || null;
    }
    return cur?.stickerMessage || null;
  };
  const quotedRaw = m?.message?.extendedTextMessage?.contextInfo?.quotedMessage;
  const stickerMsg = unwrapQuotedSticker(quotedRaw);
  if (!stickerMsg) {
    return reply("⚠️ *Reply to a sticker* with this command.\n\nUsage: *.setcmd <command>*\nExample: *.setcmd menu*");
  }
  if (!text) {
    return reply("⚠️ Please provide a command name.\n\nUsage: *.setcmd <command>*");
  }
  try {
    const { getStickerHash, stickerSetCmd } = require('./mias/lib/stickerCmd.cjs');
    const hash = getStickerHash(stickerMsg);
    if (!hash) return reply("❌ Could not compute sticker hash. Try a different sticker.");
    const cmdName = text.trim().replace(/^\./, '');
    const ok = stickerSetCmd(hash, cmdName);
    if (ok) reply(`✅ *Sticker bound!*\n\nCommand: *.${cmdName}*\nSticker ID: ${hash.slice(0,12)}...\n\nSend that sticker anytime to trigger *.${cmdName}*`);
    else reply("❌ Failed to save sticker binding.");
  } catch (e) {
    reply(`❌ setcmd error: ${e.message}`);
  }
}
break;

case 'delcmd': {
  if (!isCreator) return reply("🚫 Owner only command.");
  const quotedRaw2 = m?.message?.extendedTextMessage?.contextInfo?.quotedMessage;
  const stickerMsg2 = (function(q) {
    let cur = q;
    for (let i = 0; i < 6 && cur; i++) {
      if (cur.stickerMessage) return cur.stickerMessage;
      cur = cur.ephemeralMessage?.message || cur.viewOnceMessage?.message || cur.viewOnceMessageV2?.message || cur.viewOnceMessageV2Extension?.message || cur.documentWithCaptionMessage?.message || null;
    }
    return cur?.stickerMessage || null;
  })(quotedRaw2);
  if (!stickerMsg2) {
    return reply("⚠️ *Reply to the sticker* whose command you want to remove.");
  }
  try {
    const { getStickerHash, stickerDelCmd } = require('./mias/lib/stickerCmd.cjs');
    const hash = getStickerHash(stickerMsg2);
    if (!hash) return reply("❌ Could not compute sticker hash.");
    const ok = stickerDelCmd(hash);
    if (ok) reply("✅ *Sticker command removed.*");
    else reply("⚠️ No command was bound to that sticker.");
  } catch (e) {
    reply(`❌ delcmd error: ${e.message}`);
  }
}
break;

case 'listcmd': {
  if (!isCreator) return reply("🚫 Owner only command.");
  try {
    const { stickerListCmds, stickerCmdCount } = require('./mias/lib/stickerCmd.cjs');
    const cmds = stickerListCmds();
    const count = stickerCmdCount();
    if (count === 0) {
      return reply("📋 *No sticker commands set yet.*\n\nUse *.setcmd <command>* (reply to sticker) to add one.");
    }
    const lines = Object.entries(cmds).map(([hash, cmd], i) => `${i+1}. ${hash.slice(0,10)}... → *.${cmd}*`);
    reply(`📋 *Sticker Commands (${count})*\n\n${lines.join('\n')}\n\nUse *.delcmd* (reply to sticker) to remove one.`);
  } catch (e) {
    reply(`❌ listcmd error: ${e.message}`);
  }
}
break;

// ─── Settings 19.x — Force Private Mode, Auto-Downloader, Status Forwarder ──
case '__dup_removed_settings__':  // moved to mias/index.js
case '.settings': {
  if (!isCreator) return reply("🚫 Owner only command.");
  if (!text) {
    const fp = getSetting('bot', 'setting_19_1_forcePrivate', false);
    const adl = getSetting('bot', 'setting_19_2_autoDownload', 'dm');
    const sfDest = getSetting('bot', 'setting_19_3_statusFwdDest', null);
    const sfOn = getSetting('bot', 'setting_19_3_statusFwdEnabled', false);
    return reply(`⚙️ *Bot Settings*

*28.1/28.2 Force Private Mode:* ${fp ? '✅ ON' : '❌ OFF'}
       Bot ignores group messages (DM only)

*29.x Auto-Downloader:* ${adl === 'global' ? '🌐 ALL chats' : adl === 'dm' ? '💬 DM only' : '❌ OFF'}
       Auto-downloads TikTok/YT/IG/FB/Twitter links

*30.x Status Forwarder:* ${sfOn ? '✅ ON' : '❌ OFF'}
       Destination: ${sfDest || 'not set'}

*Commands:*
${prefix}setting 28.1 (Force Private: ON)  ${prefix}setting 28.2 (OFF)
${prefix}setting 29.1/29.2/29.3 (Auto-Downloader off/dm/global)
${prefix}setting 30.1 (Status Fwd: ON)  ${prefix}setting 30.2 (OFF)
${prefix}listcmd  — list sticker commands
${prefix}setcmd   — bind sticker to command`);
  }

  const [setting_num, ...setting_rest] = text.split(' ');
  const setting_val = setting_rest.join(' ').toLowerCase().trim();

  if (setting_num === '19.1' || setting_num === '28.1' || setting_num === '28.2') {
    const fpOn = ['on','1','true','enable'].includes(setting_val);
    const fpOff = ['off','0','false','disable'].includes(setting_val);
    if (!fpOn && !fpOff) return reply("Usage: .setting 28.1 (ON) or .setting 28.2 (OFF)");
    setSetting('bot', 'setting_19_1_forcePrivate', fpOn);
    reply(`28 *Force Private Mode: ${fpOn ? '✅ ON' : '❌ OFF'}*\n${fpOn ? 'Bot will now only respond in DMs.' : 'Bot responds in both DMs and groups.'}`);
  } else if (setting_num === '19.2' || setting_num === '29.1' || setting_num === '29.2' || setting_num === '29.3') {
    const valid = ['off','dm','global'];
    const mode = setting_val;
    if (!valid.includes(mode)) return reply("Usage: .setting 29.1 (off) / 29.2 (dm) / 29.3 (global)");
    setSetting('bot', 'setting_19_2_autoDownload', mode);
    const label = mode === 'global' ? '🌐 ALL chats' : mode === 'dm' ? '💬 DM only' : '❌ OFF';
    reply(`29 *Auto-Downloader: ${label}*\nTikTok/YT/IG/FB/Twitter links will be auto-downloaded.`);
  } else if (setting_num === '19.3' || setting_num === '30.1' || setting_num === '30.2') {
    const sfOnCmd = ['on','1','true','enable'].includes(setting_val.split(' ')[0]);
    const sfOffCmd = ['off','0','false','disable'].includes(setting_val.split(' ')[0]);
    if (!sfOnCmd && !sfOffCmd) {
      // Maybe they're setting destination
      if (setting_val && setting_val.includes('@')) {
        setSetting('bot', 'setting_19_3_statusFwdDest', setting_val.trim());
        return reply(`19.3 Status forwarder destination set to: ${setting_val.trim()}`);
      }
      return reply("Usage: .setting 30.1 (ON) / .setting 30.2 (OFF)\nSet destination: .settings 19.3 <jid>@newsletter");
    }
    setSetting('bot', 'setting_19_3_statusFwdEnabled', sfOnCmd);
    reply(`30 *Status Forwarder: ${sfOnCmd ? '✅ ON' : '❌ OFF'}*`);
  } else {
    reply("⚠️ Unknown setting number. Use .setting 28.x / 29.x / 30.x from the main .setting menu");
  }
}
break;

// ─── Status Forwarder Destination shortcut ─────────────────────────────────
case '__dup_removed_sfwddest__':  // moved to mias/index.js
case '__dup_removed_setsfwddest__':  // moved to mias/index.js
case 'statusfwddest': {
  if (!isCreator) return reply('🚫 Owner only.');
  if (!text) {
    const cur = getSetting('bot', 'setting_19_3_statusFwdDest', null);
    return reply(`📢 *Status Forwarder Destination*\n\nCurrent: ${cur || '_not set_'}\n\nUsage:\n${prefix}sfwddest <jid>\n\nExamples:\n${prefix}sfwddest 2349012345678@s.whatsapp.net\n${prefix}sfwddest 120363xxxxxxx@newsletter\n\nThen enable with: ${prefix}setting 30.1 on`);
  }
  const jid = text.trim();
  if (!jid.includes('@')) return reply('❌ JID must include @ (e.g. 2349012345678@s.whatsapp.net or 12345@newsletter)');
  setSetting('bot', 'setting_19_3_statusFwdDest', jid);
  if (typeof globalThis.__STATUS_FWD_SET_DEST__ === 'function') {
    try { globalThis.__STATUS_FWD_SET_DEST__(jid); } catch (_) {}
  }
  reply(`✅ *Status forwarder destination set!*\n\n📢 ${jid}\n\nEnable/disable: ${prefix}setting 30.1 on | off`);
}
break;

// ─── Health Monitoring Commands (.health .sessions .diagnose .repair .cleanup)
case 'health': {
  if (!isCreator) return reply("🚫 Owner only.");
  try {
    const mem = process.memoryUsage();
    const heapPct = Math.round((mem.heapUsed / mem.heapTotal) * 100);
    const memStatus = heapPct < 70 ? '🟢 Healthy' : heapPct < 85 ? '🟡 Moderate' : '🔴 High';
    let sessionInfo = '🟡 Not checked';
    let reconnects = 0, badMacs = 0, lastCheck = 'never';
    try {
      const h = globalThis.__SESSION_HEALTH_SUMMARY__?.();
      if (h) { reconnects = h.reconnectCount; badMacs = h.badMacCount; lastCheck = h.lastCheck; const res = Object.values(h.results||{}); sessionInfo = res.length === 0 ? '🟡 Pending' : res.every(r=>r.ok) ? '🟢 Healthy' : '🔴 Issues found'; }
    } catch {}
    reply(`🏥 *MAIS MDX Health*\n\n🤖 Bot: 🟢 Running\n🔗 Sessions: ${sessionInfo}\n💾 Memory: ${memStatus} (${heapPct}%)\n   RSS: ${Math.round(mem.rss/1024/1024)}MB | Heap: ${Math.round(mem.heapUsed/1024/1024)}MB\n🔄 Reconnects: ${reconnects}\n⚠️ Bad MAC: ${badMacs}\n📅 Last check: ${lastCheck}\n⏰ Uptime: ${Math.floor(process.uptime()/60)} min`);
  } catch(e) { reply(`❌ health error: ${e.message}`); }
}
break;

case 'diagnose': {
  if (!isCreator) return reply("🚫 Owner only.");
  try {
    const mem = process.memoryUsage();
    const heapPct = Math.round((mem.heapUsed/mem.heapTotal)*100);
    const issues = [];
    if (heapPct > 85) issues.push(`🔴 Heap at ${heapPct}% — run .cleanup`);
    let h; try { h = globalThis.__SESSION_HEALTH_SUMMARY__?.(); } catch {}
    if (h?.badMacCount > 10) issues.push(`🔴 High Bad MAC: ${h.badMacCount} — run .repair`);
    if (h?.reconnectCount > 20) issues.push(`🟡 High reconnects: ${h.reconnectCount}`);
    let sessionDiag = '✅ No session issues';
    if (h) { const bad = Object.values(h.results||{}).filter(r=>!r.ok); if (bad.length) sessionDiag = bad.map(r => `⚠️ ${r.label}: ${r.warnings?.join(', ')}`).join('\n'); }
    reply(`🔍 *Diagnostic Report*\n\n💾 Heap: ${heapPct}%\n🔄 Reconnects: ${h?.reconnectCount||0}\n⚠️ Bad MACs: ${h?.badMacCount||0}\n\n*Sessions:*\n${sessionDiag}\n\n${issues.length ? '*Issues:*\n'+issues.join('\n') : '✅ All systems normal'}`);
  } catch(e) { reply(`❌ diagnose error: ${e.message}`); }
}
break;

case 'repair': {
  if (!isCreator) return reply("🚫 Owner only.");
  const actions = [];
  try {
    const hFn = globalThis.__RUN_SESSION_HEALTH_CHECK__;
    if (typeof hFn === 'function') { await hFn(); actions.push('✅ Session health check run'); }
    const cFn = globalThis.__RESOURCE_CLEANUP__;
    if (typeof cFn === 'function') { const r = cFn(true); actions.push(`✅ Cleanup: ${r?.totalRemoved||0} entries removed`); }
    const rFn = globalThis.__REBUILD_CACHES__;
    if (typeof rFn === 'function') { await rFn(); actions.push('✅ Caches rebuilt'); }
    if (typeof global.gc === 'function') { global.gc(); actions.push('✅ GC run'); }
  } catch(e) { actions.push(`⚠️ ${e.message}`); }
  reply(`🔧 *Repair Complete*\n\n${actions.join('\n')}`);
}
break;

case 'cleanup': {
  if (!isCreator) return reply("🚫 Owner only.");
  let removed = 0;
  const before = Math.round(process.memoryUsage().heapUsed/1024/1024);
  try { const cFn = globalThis.__RESOURCE_CLEANUP__; if (typeof cFn === 'function') { const r = cFn(true); removed = r?.totalRemoved||0; } } catch {}
  if (typeof global.gc === 'function') global.gc();
  const after = Math.round(process.memoryUsage().heapUsed/1024/1024);
  reply(`🧹 *Cleanup Done*\n\n🗑️ Entries removed: ${removed}\n💾 Memory: ${before}MB → ${after}MB\n✅ Active caches preserved`);
}
break;

// ─── __INJECT_CMD__ support for sticker-triggered commands ──────────────────
// (Do NOT add case for this — it's wired via globalThis)


default:
if (body.startsWith('<')) {
if (!isCreator) return;
function Return(sul) {
sat = JSON.stringify(sul, null, 2)
bang = util.format(sat)
if (sat == undefined) {
bang = util.format(sul)}
return m.reply(bang)}
try {
m.reply(util.format(eval(`(async () => { return ${body.slice(3)} })()`)))
} catch (e) {
m.reply(String(e))}}
if (body.startsWith('>')) {
if (!isCreator) return;
try {
let evaled = await eval(body.slice(2))
if (typeof evaled !== 'string') evaled = require('util').inspect(evaled)
await m.reply(evaled)
} catch (err) {
await m.reply(String(err))
}
}
if (body.startsWith('®')) {
if (!isCreator) return;
require("child_process").exec(body.slice(2), (err, stdout) => {
if (err) return m.reply(`${err}`)
if (stdout) return m.reply(stdout)
})
}
}
} catch (err) {
console.log(require("util").format(err));
}
}
let file = require.resolve(__filename)
require('fs').watchFile(file, () => {
require('fs').unwatchFile(file)
console.log('\x1b[0;32m'+__filename+' \x1b[1;32mupdated!\x1b[0m')
delete require.cache[file]
require(file)
})