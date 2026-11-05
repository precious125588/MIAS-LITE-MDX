// mias/features/cuzCustomization.js
// Complete persistent .cuz customization system for MIA'S MDX

"use strict";


const customizationOptions = [
  { id: "prefix", label: "Prefix", type: "text", default: "." },
  { id: "botName", label: "Bot Name", type: "text", default: "MIA'S MDX" },
  { id: "botOwner", label: "Bot Owner", type: "text", default: "𝑷𝑹𝑬𝑪𝑰𝑶𝑼𝑺 x" },
  { id: "footer", label: "Footer", type: "text", default: "Powered by 𝑷𝑹𝑬𝑪𝑰𝑶𝑼𝑺 x" },
  { id: "emoji", label: "Emoji", type: "emoji", default: "🌀" },
  { id: "statusEmoji", label: "Status Reaction Emoji / Random Pool", type: "statusEmoji", default: "💔" },
  { id: "welcomeText", label: "Welcome Text", type: "text", default: "Welcome @user to @group!" },
  { id: "goodbyeText", label: "Goodbye Text", type: "text", default: "Goodbye @user from @group!" },
  { id: "menuHeader", label: "Menu Header", type: "text", default: "╭━━〔 MIA'S MDX 〕━━╮" },
  { id: "menuFooter", label: "Menu Footer", type: "text", default: "╰━━━━━━━━━━━━━━━━━━╯" },
  { id: "menuEmoji", label: "Menu Emoji", type: "emoji", default: "❖" },
  { id: "botProfile", label: "Bot Profile", type: "text", default: "https://files.catbox.moe/05rqy6.png" },
  { id: "packName", label: "Pack Name", type: "text", default: "MIA'S MDX" },
  { id: "authorName", label: "Author Name", type: "text", default: "𝑷𝑹𝑬𝑪𝑰𝑶𝑼𝑺 x" },
  { id: "timeFormat", label: "Time Format", type: "timeFormat", default: "12h" },
  { id: "dateFormat", label: "Date Format", type: "dateFormat", default: "DD/MM/YYYY" },
  { id: "reset", label: "Reset", type: "reset", default: null },
  { id: "viewStatusExclude", label: "Status View Exclude", type: "numberList", default: [] },
  { id: "viewStatusOnly", label: "Status View Only", type: "numberList", default: [] },
  { id: "reactStatusExclude", label: "Status React Exclude", type: "numberList", default: [] },
  { id: "reactStatusOnly", label: "Status React Only", type: "numberList", default: [] }
];

// Canonical status values live in the bot-wide guard record, not a disconnected
// branding-only __cuz object. Keep the legacy option numbers stable (Reset = 17).
const STATUS_KEYS = ["statusEmoji", "statusEmojiPool", "viewStatusExclude", "viewStatusOnly", "reactStatusExclude", "reactStatusOnly"];
const emojiAliases = {
  fire: "🔥", heart: "❤️", red_heart: "❤️", love: "❤️", blue_heart: "💙",
  green_heart: "💚", yellow_heart: "💛", purple_heart: "💜", black_heart: "🖤",
  white_heart: "🤍", broken_heart: "💔", laugh: "😂", joy: "😂", laughing: "😂",
  smile: "😄", smiley: "😃", grin: "😁", grinning: "😀", cry: "😢", sob: "😭",
  thumbs_up: "👍", thumbsup: "👍", like: "👍", thumbs_down: "👎", thumbsdown: "👎",
  clap: "👏", eyes: "👀", star: "⭐", sparkles: "✨", heart_eyes: "😍",
  sunglasses: "😎", cool: "😎", pray: "🙏", folded_hands: "🙏", skull: "💀",
  hundred: "💯", "100": "💯", rocket: "🚀", party: "🎉", tada: "🎉",
  cyclone: "🌀", check: "✅", check_mark_button: "✅", crown: "👑"
};
let emojiNames;
function emojiNameKey(value) {
  return String(value).toLowerCase().replace(/^:|:$/g, "").replace(/[ -]+/g, "_");
}
function emojiByName(value) {
  const name = emojiNameKey(value);
  if (emojiAliases[name]) return emojiAliases[name];
  if (!emojiNames) {
    emojiNames = new Map();
    try {
      const EmojiDb = require("emoji-db");
      const db = new EmojiDb({ useDefaultDb: true, ignoreUnqualified: true });
      for (const entry of Object.values(db.dbData || {})) {
        if (entry.title && entry.emoji) emojiNames.set(emojiNameKey(entry.title), entry.emoji);
      }
    } catch {} // Common names and literal emoji also work without the optional DB.
  }
  return emojiNames.get(name) || "";
}
function parseStatusEmoji(input) {
  let text = String(input || "").trim().replace(/^random(?:\s*[:=]\s*|\s+)/i, "");
  if (!text) return { valid: false, error: "Supply an emoji/name, or a comma-separated random pool (fire, heart, 😂)." };
  const parts = text.includes(",") ? text.split(",").map(v => v.trim()) : [text];
  // Also accept space-separated names or emoji, without splitting ZWJ sequences.
  if (parts.length === 1 && !emojiByName(text)) parts.splice(0, 1, ...text.split(/\s+/));
  if (parts.some(v => !v) || parts.length > 50) return { valid: false, error: "Use 1–50 emoji or names; no empty pool entries." };
  const pool = [];
  for (const part of parts) {
    const literal = emojiByName(part) || part;
    const segments = [...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(literal)].map(v => v.segment);
    for (let emoji of segments) {
      // Node 22's Unicode emoji sequences reject lone flags and malformed ZWJ
      // values. Qualify text-style symbols (e.g. ❤) before saving for WhatsApp.
      if (!/^\p{RGI_Emoji}$/v.test(emoji) && /^\p{RGI_Emoji}$/v.test(emoji + "\uFE0F")) emoji += "\uFE0F";
      if (!/^\p{RGI_Emoji}$/v.test(emoji)) {
        return { valid: false, error: `Unknown emoji/name: ${part}. Try fire, heart, joy, :thumbsup:, or a literal emoji.` };
      }
      if (!pool.includes(emoji)) pool.push(emoji);
    }
  }
  if (!pool.length || pool.length > 50) return { valid: false, error: "Use 1–50 valid emoji." };
  return { valid: true, value: pool, pool };
}
function updateStatusNumbers(previous, input) {
  const text = String(input || "").trim();
  if (/^(?:clear|reset|all)$/i.test(text)) return { valid: true, value: [] };
  if (/^(?:list|show)$/i.test(text)) return { valid: true, value: [...(Array.isArray(previous) ? previous : [])], readOnly: true };
  const match = text.match(/^(?:(add|remove|delete|set)\s+)?(.+)$/i);
  if (!match) return { valid: false, error: "Use add <number>, remove <number>, set <numbers>, list, or clear." };
  const mode = (match[1] || "add").toLowerCase();
  const parts = match[2].split(/[,;\n]+/).map(v => v.trim());
  const numbers = [];
  for (const raw of parts) {
    // Reject LIDs/group IDs and malformed input; never turn arbitrary text into a number.
    if (!/^\+?[\d\s().-]+(?:@s\.whatsapp\.net)?$/.test(raw)) return { valid: false, error: `Invalid phone number: ${raw}. Use international numbers including country code.` };
    const number = raw.split("@")[0].replace(/\D/g, "");
    if (!/^[1-9]\d{6,14}$/.test(number)) return { valid: false, error: "Numbers must contain 7–15 digits including country code, with no leading zero." };
    numbers.push(number);
  }
  const existing = Array.isArray(previous) ? previous : [];
  return { valid: true, value: mode === "remove" || mode === "delete"
    ? existing.filter(v => !numbers.includes(v))
    : [...new Set([...(mode === "set" ? [] : existing), ...numbers])] };
}
function statusAuthorAllowed(settings, kind, number) {
  const excludeValue = settings?.[kind === "view" ? "viewStatusExclude" : "reactStatusExclude"];
  const onlyValue = settings?.[kind === "view" ? "viewStatusOnly" : "reactStatusOnly"];
  const exclude = Array.isArray(excludeValue) ? excludeValue : [];
  const only = Array.isArray(onlyValue) ? onlyValue : [];
  const normalize = v => String(v || "").split("@")[0].split(":")[0].replace(/\D/g, "");
  const n = normalize(number);
  // Fail closed for unresolved LIDs whenever a phone-number filter is active.
  if (!n) return !exclude.length && !only.length;
  return !exclude.some(v => normalize(v) === n) && (!only.length || only.some(v => normalize(v) === n));
}
function canEditStatus(sock, msg, P) {
  if (msg?.key?.fromMe) return true;
  const sender = typeof P.getSender === "function" ? P.getSender(msg) : (msg?.key?.participant || msg?.participant || msg?.key?.remoteJid);
  if (typeof P.isOwner === "function" && P.isOwner(sender)) return true;
  if (typeof P.isSudo === "function" && P.isSudo(sender)) return true;
  const bare = value => String(value || "").replace(/:\d+@/, "@");
  return !!sock?.user?.id && bare(sender) === bare(sock.user.id);
}
function applyStatusCustomization(settings, key, input) {
  if (key === "statusEmoji" || key === "statusEmojiPool") {
    const parsed = parseStatusEmoji(input);
    if (!parsed.valid) return parsed;
    settings.statusEmoji = parsed.pool[0];
    settings.statusEmojiPool = parsed.pool;
    return { valid: true, value: parsed.pool.join(", ") };
  }
  const parsed = updateStatusNumbers(settings[key], input);
  if (parsed.valid && !parsed.readOnly) settings[key] = parsed.value;
  return { ...parsed, value: parsed.valid ? parsed.value.join(", ") || "None (all contacts allowed)" : parsed.value };
}

const pendingSessions = new Map(); // key: chatId:userId -> session
const SESSION_TTL = 5 * 60 * 1000; // 5 minutes

function cleanOldSessions() {
  const now = Date.now();
  for (const [k, v] of pendingSessions.entries()) {
    if (now - v.createdAt > SESSION_TTL) {
      pendingSessions.delete(k);
    }
  }
}
setInterval(cleanOldSessions, 60000).unref();

function getScopeKey(jid, isGroup) {
  return isGroup ? jid : "global_cuz";
}

function getCustomization(jid, isGroup, getSettingsFn) {
  try {
    const key = getScopeKey(jid, isGroup);
    const setObj = getSettingsFn ? getSettingsFn(key) : null;
    const cuz = (setObj && setObj.__cuz) ? setObj.__cuz : {};
    const res = {};
    for (const opt of customizationOptions) {
      if (opt.id === "reset") continue;
      res[opt.id] = STATUS_KEYS.includes(opt.id) && setObj?.[opt.id] !== undefined
        ? setObj[opt.id] : ((cuz[opt.id] !== undefined && cuz[opt.id] !== null) ? cuz[opt.id] : opt.default);
    }
    return res;
  } catch (e) {
    const res = {};
    for (const opt of customizationOptions) {
      if (opt.id !== "reset") res[opt.id] = opt.default;
    }
    return res;
  }
}

function setCustomization(jid, isGroup, key, val, getSettingsFn, saveNowFn) {
  try {
    const scope = STATUS_KEYS.includes(key) ? jid : getScopeKey(jid, isGroup);
    const setObj = getSettingsFn ? getSettingsFn(scope) : null;
    if (setObj && STATUS_KEYS.includes(key)) {
      const result = applyStatusCustomization(setObj, key, Array.isArray(val) ? val.join(",") : val);
      if (!result.valid) return false;
      if (typeof saveNowFn === "function") saveNowFn();
      return true;
    }
    if (setObj) {
      if (!setObj.__cuz) setObj.__cuz = {};
      setObj.__cuz[key] = val;
      if (typeof saveNowFn === "function") saveNowFn();
      return true;
    }
  } catch (e) {
    console.error("[CUZ setCustomization]", e);
  }
  return false;
}

function resetCustomization(jid, isGroup, getSettingsFn, saveNowFn) {
  try {
    const scope = getScopeKey(jid, isGroup);
    const setObj = getSettingsFn ? getSettingsFn(scope) : null;
    if (setObj) {
      setObj.__cuz = {};
      if (typeof saveNowFn === "function") saveNowFn();
      return true;
    }
  } catch (e) {
    console.error("[CUZ resetCustomization]", e);
  }
  return false;
}

function validateCustomizationValue(opt, val) {
  if (opt.type === "statusEmoji") return parseStatusEmoji(val);
  if (opt.type === "numberList") return updateStatusNumbers([], val);
  const s = String(val || "").trim();
  if (opt.type === "reset") return { valid: true };

  if (opt.type === "emoji") {
    if (!s) return { valid: false, error: "Emoji cannot be empty." };
    if (s.length > 8) return { valid: false, error: "Please provide a valid single emoji symbol." };
    return { valid: true, value: s };
  }

  if (opt.type === "timeFormat") {
    const lower = s.toLowerCase();
    if (lower === "12h" || lower === "24h") return { valid: true, value: lower };
    return { valid: false, error: "Accepted time formats: 12h or 24h" };
  }

  if (opt.type === "dateFormat") {
    const upper = s.toUpperCase();
    if (["DD/MM/YYYY", "MM/DD/YYYY", "YYYY-MM-DD", "DD-MM-YYYY"].includes(upper)) {
      return { valid: true, value: upper };
    }
    return { valid: false, error: "Accepted date formats: DD/MM/YYYY, MM/DD/YYYY, YYYY-MM-DD" };
  }

  if (opt.type === "text") {
    if (!s) return { valid: false, error: "Text value cannot be empty." };
    if (opt.id === "prefix") {
      if (s.length > 5) return { valid: false, error: "Prefix should be 1-3 characters (e.g. ., !, #)." };
    }
    return { valid: true, value: s };
  }

  return { valid: true, value: s };
}

function resolveCustomizationPlaceholders(text, ctx = {}) {
  if (!text) return "";
  let out = String(text);
  const rep = {
    "@user": ctx.user ? `@${String(ctx.user).split("@")[0].split(":")[0]}` : "@user",
    "@username": ctx.username || ctx.pushName || "@username",
    "@group": ctx.groupName || "@group",
    "@botname": ctx.botName || "MIA'S MDX",
    "@owner": ctx.ownerName || "𝑷𝑹𝑬𝑪𝑰𝑶𝑼𝑺 x",
    "@prefix": ctx.prefix || ".",
    "@date": ctx.date || new Date().toLocaleDateString(),
    "@time": ctx.time || new Date().toLocaleTimeString()
  };
  for (const [k, v] of Object.entries(rep)) {
    out = out.split(k).join(v);
  }
  return out;
}

function toDopeFont(str) {
  // Convert standard letters & numbers into aesthetic bold typography
  const normal = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const dope   = "𝐀𝐁𝐂𝐃𝐄𝐅𝐆𝐇𝐈𝐉𝐊𝐋𝐌𝐍𝐎𝐏𝐐𝐑𝐒𝐓𝐔𝐕𝐖𝐗𝐘𝐙𝐚𝐛𝐜𝐝𝐞𝐟𝐠𝐡𝐢𝐣𝐤𝐥𝐦𝐧𝐨𝐩𝐪𝐫𝐬𝐭𝐮𝐯𝐰𝐱𝐲𝐳𝟎𝟏𝟐𝟑𝟒𝟓𝟔𝟕𝟖𝟗";
  let res = "";
  for (const ch of str) {
    const idx = normal.indexOf(ch);
    res += idx !== -1 ? Array.from(dope)[idx] : ch;
  }
  return res;
}

function buildCustomizeMenuText(pendingValue) {
  let lines = [
    "╭━━〔 𝐂𝐔𝐒𝐓𝐎𝐌𝐈𝐙𝐄 〕━━╮",
    "┃",
    "┃ 𝟏. 𝐏𝐫𝐞𝐟𝐢𝐱",
    "┃ 𝟐. 𝐁𝐨𝐭 𝐍𝐚𝐦𝐞",
    "┃ 𝟑. 𝐁𝐨𝐭 𝐎𝐰𝐧𝐞𝐫",
    "┃ 𝟒. 𝐅𝐨𝐨𝐭𝐞𝐫",
    "┃ 𝟓. 𝐄𝐦𝐨𝐣𝐢",
    "┃ 𝟔. 𝐒𝐭𝐚𝐭𝐮𝐬 𝐄𝐦𝐨𝐣𝐢",
    "┃ 𝟕. 𝐖𝐞𝐥𝐜𝐨𝐦𝐞 𝐓𝐞𝐱𝐭",
    "┃ 𝟖. 𝐆𝐨𝐨𝐝𝐛𝐲𝐞 𝐓𝐞𝐱𝐭",
    "┃ 𝟗. 𝐌𝐞𝐧𝐮 𝐇𝐞𝐚𝐝𝐞𝐫",
    "┃ 𝟏𝟎. 𝐌𝐞𝐧𝐮 𝐅𝐨𝐨𝐭𝐞𝐫",
    "┃ 𝟏𝟏. 𝐌𝐞𝐧𝐮 𝐄𝐦𝐨𝐣𝐢",
    "┃ 𝟏𝟐. 𝐁𝐨𝐭 𝐏𝐫𝐨𝐟𝐢𝐥𝐞",
    "┃ 𝟏𝟑. 𝐏𝐚𝐜𝐤 𝐍𝐚𝐦𝐞",
    "┃ 𝟏𝟒. 𝐀𝐮𝐭𝐡𝐨𝐫 𝐍𝐚𝐦𝐞",
    "┃ 𝟏𝟓. 𝐓𝐢𝐦𝐞 𝐅𝐨𝐫𝐦𝐚𝐭",
    "┃ 𝟏𝟔. 𝐃𝐚𝐭𝐞 𝐅𝐨𝐫𝐦𝐚𝐭",
    "┃ 𝟏𝟕. 𝐑𝐞𝐬𝐞𝐭",
    "┃ 18. Status View Exclude",
    "┃ 19. Status View Only",
    "┃ 20. Status React Exclude",
    "┃ 21. Status React Only",
    "┃ Emoji: fire, heart, 😂 (random pool)",
    "┃ Lists: add/remove <number> | list | clear",
    "┃",
    "╰━━━━━━━━━━━━━━━━━━╯"
  ];
  if (pendingValue) {
    lines.push(
      "",
      "📝 *Value to apply:* *" + pendingValue + "*",
      "",
      "👉 " + toDopeFont("Reply with option number 1-21 to apply this value")
    );
  } else {
    lines.push(
      "",
      "✨ " + toDopeFont("Reply with option number to edit or reset")
    );
  }
  return lines.join("\n");
}


async function getBotPicForCuz(sock, jid, getSettingsFn) {
  // 1. Check custom botProfile from cuz settings
  try {
    if (typeof getSettingsFn === "function") {
      const set = getSettingsFn(jid) || getSettingsFn("global_cuz");
      const customPic = set?.__cuz?.botProfile;
      if (customPic && typeof customPic === "string" && customPic.startsWith("http")) {
        let resp = null;
        try {
          const a = require("axios");
          resp = await a.get(customPic, { responseType: "arraybuffer", timeout: 10000 });
        } catch (_) {
          if (typeof fetch === "function") {
            const fRes = await fetch(customPic).catch(() => null);
            if (fRes?.ok) {
              const arr = await fRes.arrayBuffer();
              resp = { data: Buffer.from(arr) };
            }
          }
        }
        if (resp?.data && Buffer.isBuffer(resp.data) && resp.data.length > 500) {
          return resp.data;
        }
        return { url: customPic };
      }
    }
  } catch (_) {}

  // 2. Try live bot WhatsApp profile picture
  try {
    const me = sock?.user?.id;
    if (me && typeof sock.profilePictureUrl === "function") {
      const pUrl = await sock.profilePictureUrl(me, "image").catch(() => null)
                || await sock.profilePictureUrl(me, "preview").catch(() => null);
      if (pUrl) {
        let resp = null;
        try {
          const a = require("axios");
          resp = await a.get(pUrl, { responseType: "arraybuffer", timeout: 10000 });
        } catch (_) {
          if (typeof fetch === "function") {
            const fRes = await fetch(pUrl).catch(() => null);
            if (fRes?.ok) {
              const arr = await fRes.arrayBuffer();
              resp = { data: Buffer.from(arr) };
            }
          }
        }
        if (resp?.data && Buffer.isBuffer(resp.data) && resp.data.length > 500) {
          return resp.data;
        }
        return { url: pUrl };
      }
    }
  } catch (_) {}

  // 3. Fallback to global getBotPic if present
  try {
    if (typeof globalThis.getBotPic === "function") {
      const b = await globalThis.getBotPic();
      if (b) return b;
    }
  } catch (_) {}

  // 4. Default catbox avatar
  try {
    const defaultUrl = "https://files.catbox.moe/05rqy6.png";
    let resp = null;
    try {
      const a = require("axios");
      resp = await a.get(defaultUrl, { responseType: "arraybuffer", timeout: 10000 });
    } catch (_) {
      if (typeof fetch === "function") {
        const fRes = await fetch(defaultUrl).catch(() => null);
        if (fRes?.ok) {
          const arr = await fRes.arrayBuffer();
          resp = { data: Buffer.from(arr) };
        }
      }
    }
    if (resp?.data && Buffer.isBuffer(resp.data)) return resp.data;
    return { url: defaultUrl };
  } catch (_) {
    return { url: "https://files.catbox.moe/05rqy6.png" };
  }
}

function installCuzSystem(P) {
  const { commands, cmd, CONFIG, sendReply, getSettings, saveNow } = P;

  const handler = async (sock, msg, args) => {
    const jid = msg.key.remoteJid;
    const isGroup = jid.endsWith("@g.us");
    const sender = isGroup ? (msg.key.participant || msg.participant) : jid;
    const userId = String(sender).replace(/:[0-9]+@/, "@");
    const rawVal = args.join(" ").trim();

    // Bare command rejection: .cuz with no value is rejected immediately
    if (!rawVal) {
      return await sock.sendMessage(jid, {
        text: "❌ *Invalid command: empty value field!*\n\n*Usage:* \`.cuz <value>\`\n*Example:* \`.cuz Mia\'s MDX\`\n\n👉 Please specify the new value with the command first (e.g. *.cuz Mia\'s MDX*), then choose which option to apply it to from the menu card."
      }, { quoted: msg });
    }

    const named = rawVal.match(/^(statusEmoji|statusReactEmoji|statusViewExclude|viewStatusExclude|statusViewOnly|viewStatusOnly|statusExclude|statusReactExclude|reactStatusExclude|statusReactOnly|reactStatusOnly)\s+(.+)$/i);
    if (named) {
      const aliases = { statusemoji: "statusEmoji", statusreactemoji: "statusEmoji", statusviewexclude: "viewStatusExclude", viewstatusexclude: "viewStatusExclude", statusviewonly: "viewStatusOnly", viewstatusonly: "viewStatusOnly", statusexclude: "reactStatusExclude", statusreactexclude: "reactStatusExclude", reactstatusexclude: "reactStatusExclude", statusreactonly: "reactStatusOnly", reactstatusonly: "reactStatusOnly" };
      if (!canEditStatus(sock, msg, P)) return sock.sendMessage(jid, { text: "🚫 Owner/Sudo only." }, { quoted: msg });
      const status = getSettings(jid);
      const previous = Object.fromEntries(STATUS_KEYS.map(key => [key, status[key]]));
      const result = applyStatusCustomization(status, aliases[named[1].toLowerCase()], named[2]);
      if (result.valid && !result.readOnly) {
        try {
          if (typeof P.persistStatus === "function" && P.persistStatus() === false) throw Error("Settings storage is unavailable");
          if (typeof saveNow === "function") saveNow();
        } catch (error) {
          Object.assign(status, previous);
          return sock.sendMessage(jid, { text: `❌ Could not save: ${error.message}` }, { quoted: msg });
        }
      }
      return sock.sendMessage(jid, { text: result.valid ? `✅ *${named[1]}*: ${result.value}` : `❌ ${result.error}` }, { quoted: msg });
    }
    const menuText = buildCustomizeMenuText(rawVal);
    let sentMsg = null;
    let botPic = null;
    try {
      botPic = typeof P.getBotPic === "function" ? await P.getBotPic() : await getBotPicForCuz(sock, jid, getSettings);
    } catch (_) {}

    if (botPic) {
      try {
        sentMsg = await sock.sendMessage(jid, {
          image: botPic,
          caption: menuText
        }, { quoted: msg });
      } catch (eImg) {
        console.error("[CUZ IMAGE SEND ERROR]", eImg?.message || eImg);
      }
    }

    if (!sentMsg) {
      sentMsg = await sock.sendMessage(jid, { text: menuText }, { quoted: msg });
    }
    const menuMsgId = sentMsg?.key?.id;

    const sessionKey = `${jid}:${userId}`;
    const sessObj = {
      chatId: jid,
      userId: userId,
      menuMessageId: menuMsgId || null,
      pendingValue: rawVal,
      createdAt: Date.now()
    };
    pendingSessions.set(sessionKey, sessObj);

    // Auto-expire session after 2 minutes
    setTimeout(() => {
      const cur = pendingSessions.get(sessionKey);
      if (cur === sessObj) pendingSessions.delete(sessionKey);
    }, 2 * 60 * 1000).unref();
  };

  if (typeof cmd === "function") {
    cmd(["cuz", "customize"], {
      desc: "Customize bot presentation, branding, and text",
      category: "CUSTOMIZATION", ownerOnly: true
    }, handler);
  }
}

function unwrapAny(m) {
  let cur = m;
  for (let i = 0; i < 6 && cur && typeof cur === "object"; i++) {
    const nxt = cur.ephemeralMessage?.message
      || cur.viewOnceMessage?.message
      || cur.viewOnceMessageV2?.message
      || cur.viewOnceMessageV2Extension?.message
      || cur.documentWithCaptionMessage?.message
      || cur.editedMessage?.message
      || null;
    if (!nxt) break;
    cur = nxt;
  }
  return cur;
}

function collectAllText(m) {
  const texts = [];
  if (!m || typeof m !== "object") return texts;
  texts.push(
    m.conversation,
    m.extendedTextMessage?.text,
    m.imageMessage?.caption,
    m.videoMessage?.caption,
    m.documentMessage?.caption,
    m.interactiveMessage?.body?.text,
    m.interactiveMessage?.footer?.text,
    m.interactiveMessage?.header?.title,
    m.buttonsMessage?.contentText,
    m.buttonsMessage?.footer,
    m.listMessage?.description,
    m.listMessage?.title
  );
  for (const k of Object.keys(m)) {
    const v = m[k];
    if (v && typeof v === "object" && v.message) {
      texts.push(...collectAllText(v.message));
    }
  }
  return texts.filter(Boolean);
}

async function handleCuzReply(sock, msg, body, P) {
  try {
    const { getSettings, saveNow, CONFIG } = P;
    const jid = msg.key.remoteJid;
    const isGroup = String(jid || "").endsWith("@g.us");
    const sender = isGroup ? (msg.key.participant || msg.participant) : jid;
    const userId = String(sender || "").replace(/:[0-9]+@/, "@");
    const sessionKey = `${jid}:${userId}`;

    const unwrappedMsg = unwrapAny(msg?.message) || msg?.message || {};
    const rawCtx = unwrappedMsg?.extendedTextMessage?.contextInfo
      || unwrappedMsg?.imageMessage?.contextInfo
      || unwrappedMsg?.videoMessage?.contextInfo
      || unwrappedMsg?.documentMessage?.contextInfo
      || unwrappedMsg?.interactiveResponseMessage?.contextInfo
      || msg?.message?.extendedTextMessage?.contextInfo;

    const rawQ = unwrapAny(rawCtx?.quotedMessage);
    const qTexts = rawQ ? collectAllText(rawQ) : [];
    const quotedText = qTexts.join(" ");
    const quotedNorm = quotedText.normalize("NFKD");

    const isSettingsQuoted = /SETTINGS|CONFIG|Block Calls|Link Guard|Bad Word|Anti Delete|Auto React|Auto Block|Read Msgs|View Status|Tap to toggle|ENABLE|DISABLE/i.test(quotedText) || /SETTINGS|CONFIG|Block Calls|Link Guard|Bad Word|Anti Delete|Auto React|Auto Block|Read Msgs|View Status|Tap to toggle|ENABLE|DISABLE/i.test(quotedNorm);
    const isSudoQuoted = /SUDO|ACCESS CONTROL/i.test(quotedText) || /SUDO|ACCESS CONTROL/i.test(quotedNorm);

    // Cuz must never intercept replies quoting Settings or Sudo
    if (isSettingsQuoted || isSudoQuoted) {
      return false;
    }

    const cuzPattern = /(?:╭━━〔\s*𝐂𝐔𝐒𝐓𝐎𝐌𝐈𝐙𝐄\s*〕━━╮|ℹ️\s*\*?Customization Menu\*?|\bCUSTOMIZ|\bcuzCustomization\b|\b(?:Bot Name|Bot Owner|Pack Name|Author Name|Welcome Text|Goodbye Text|Menu Header|Menu Footer|Time Format|Date Format)\b|\bReset\b|\bPrefix\b|\bcuz\b)/i;
    const isCuzQuoted = (cuzPattern.test(quotedText) || cuzPattern.test(quotedNorm)) && !isSettingsQuoted && !isSudoQuoted;

    const rawInput = String(body || "").trim();
    const norm = rawInput.replace(/^[`*_~.#/!]+|[`*_~]+$/g, "").trim();
    const numMatch = norm.match(/^(?:cuz\s*)?(\d{1,2})$/i);

    const sess = pendingSessions.get(sessionKey);

    // Cuz must not hijack if user quoted an unrelated message
    const hasAnyNonCuzQuote = !!rawQ && !isCuzQuoted;
    if (hasAnyNonCuzQuote) {
      return false;
    }

    // v39 HARDEN: cuz only reacts when the reply QUOTES the actual cuz card OR there is an active pending session
    if (!isCuzQuoted && !sess && !rawInput.toLowerCase().startsWith("cuz ")) {
      return false;
    }

    // Numeric option reply (1 to 17)
    if (numMatch) {
      const num = parseInt(numMatch[1], 10);
      if (num < 1 || num > customizationOptions.length) {
        if (isCuzQuoted) {
          await sock.sendMessage(jid, { text: `❌ Invalid option *${num}*. Please reply with a number from *1 to ${customizationOptions.length}*.` }, { quoted: msg });
          return true;
        }
        return false;
      }

      const opt = customizationOptions[num - 1];

      // Option 17: Reset all
      if ((STATUS_KEYS.includes(opt.id) || opt.id === "reset") && !canEditStatus(sock, msg, P)) {
        await sock.sendMessage(jid, { text: "🚫 Owner/Sudo only." }, { quoted: msg });
        return true;
      }
      if (opt.id === "reset") {
        const status = getSettings(jid);
        const previous = Object.fromEntries(STATUS_KEYS.map(key => [key, status[key]]));
        status.statusEmoji = "💔";
        status.statusEmojiPool = [];
        for (const key of STATUS_KEYS.filter(key => key.endsWith("Exclude") || key.endsWith("Only"))) status[key] = [];
        if (typeof P.persistStatus === "function" && P.persistStatus() === false) {
          Object.assign(status, previous);
          await sock.sendMessage(jid, { text: "❌ Could not save status settings; no changes applied." }, { quoted: msg });
          return true;
        }
        resetCustomization(jid, isGroup, getSettings, saveNow);
        pendingSessions.delete(sessionKey);
        await sock.sendMessage(jid, { text: "✅ All customization settings have been reset to default values." }, { quoted: msg });
        return true;
      }

      // If user has a pre-supplied value from .cuz <value>
      if (sess && sess.pendingValue) {
        if (STATUS_KEYS.includes(opt.id)) {
          const status = getSettings(jid);
          const previous = Object.fromEntries(STATUS_KEYS.map(key => [key, status[key]]));
          const result = applyStatusCustomization(status, opt.id, sess.pendingValue);
          if (!result.valid) {
            await sock.sendMessage(jid, { text: `❌ ${result.error}` }, { quoted: msg });
            return true;
          }
          try {
            if (!result.readOnly) {
              if (typeof P.persistStatus === "function" && P.persistStatus() === false) throw Error("Settings storage is unavailable");
              if (typeof saveNow === "function") saveNow();
            }
          } catch (error) {
            Object.assign(status, previous);
            await sock.sendMessage(jid, { text: `❌ Could not save: ${error.message}` }, { quoted: msg });
            return true;
          }
          pendingSessions.delete(sessionKey);
          await sock.sendMessage(jid, { text: `✅ *${opt.label}*: ${result.value}` }, { quoted: msg });
          return true;
        }
        const validation = validateCustomizationValue(opt, sess.pendingValue);
        if (!validation.valid) {
          pendingSessions.delete(sessionKey);
          await sock.sendMessage(jid, { text: `❌ Invalid value "*${sess.pendingValue}*" for *${opt.label}*:\n${validation.error}` }, { quoted: msg });
          return true;
        }
        setCustomization(jid, isGroup, opt.id, validation.value, getSettings, saveNow);
        if (opt.id === "prefix" && CONFIG) CONFIG.PREFIX = validation.value;
        if (opt.id === "botName" && CONFIG) CONFIG.BOT_NAME = validation.value;
        pendingSessions.delete(sessionKey);
        await sock.sendMessage(jid, { text: `✅ *${opt.label}* changed to: *${validation.value}*` }, { quoted: msg });
        return true;
      }

      // User chose an option without providing a value: block waiting-value mode!
      if (isCuzQuoted || sess) {
        pendingSessions.delete(sessionKey);
        await sock.sendMessage(jid, {
          text: `❌ *Invalid command: empty value field!*\n\n*Usage:* \`.cuz <value>\`\n*Example:* \`.cuz Mia\'s MDX\`\n\nPlease supply the value with the command first, then select option *${num}* (*${opt.label}*). No raw message waiting mode is allowed.`
        }, { quoted: msg });
        return true;
      }

      return false;
    }

    // Non-numeric replies (like "Rest" or normal conversation quoting a message)
    // must NEVER trigger menu spam or hijack the conversation.
    if (!numMatch) {
      return false;
    }

    return false;
  } catch (err) {
    console.error("[cuzCustomization] handleCuzReply error:", err?.message || err);
    return false;
  }
}

module.exports = {
  STATUS_KEYS, parseStatusEmoji, updateStatusNumbers, statusAuthorAllowed, applyStatusCustomization,
  customizationOptions,
  getCustomization,
  setCustomization,
  resetCustomization,
  validateCustomizationValue,
  resolveCustomizationPlaceholders,
  buildCustomizeMenuText,
  installCuzSystem,
  handleCuzReply
};
