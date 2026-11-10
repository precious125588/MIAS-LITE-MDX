import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function fetchBuffer(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const arrayBuf = await res.arrayBuffer();
    return Buffer.from(arrayBuf);
  } catch (_) {
    return null;
  }
}

export function installOwnerCommand(ctx = {}) {
  const { cmd, react, sendReply, CONFIG, getBotPic } = ctx;
  if (typeof cmd !== 'function') return false;

  const BOT_NAME = 'MIAS LITE MDX';
  if (CONFIG) CONFIG.BOT_NAME = BOT_NAME;
  if (globalThis.CONFIG) globalThis.CONFIG.BOT_NAME = BOT_NAME;
  if (global) {
    global.BOT_NAME = BOT_NAME;
    global.botName = BOT_NAME;
    global.botname = BOT_NAME;
  }
  process.env.BOT_NAME = BOT_NAME;

  cmd(['owner', 'creator', 'dev', 'developer', 'botcreator'], {
    desc: 'Show bot owner & developer info',
    category: 'INFO',
    ownerOnly: false
  }, async (sock, msg, args) => {
    const jid = (msg && msg.key && msg.key.remoteJid) || '';
    if (!jid) return;

    // React with royal crown emoji
    try {
      if (typeof react === 'function') {
        await react(sock, msg, '👑');
      } else if (sock && typeof sock.sendMessage === 'function') {
        await sock.sendMessage(jid, { react: { text: '👑', key: msg.key } });
      }
    } catch (_) {}

    // 1. Resolve Owner Number & JID
    const cfg = CONFIG || globalThis.CONFIG || {};
    const rawNum = cfg.OWNER_NUMBER || process.env.OWNER_NUMBER || process.env.OWNER || (global && global.ownernumber) || '';
    let cleanNum = String(rawNum).replace(/[^0-9]/g, '');

    if (!cleanNum && cfg.OWNER_JID) {
      cleanNum = String(cfg.OWNER_JID).split('@')[0].replace(/[^0-9]/g, '');
    }
    if (!cleanNum && global && Array.isArray(global.owner) && global.owner[0]) {
      cleanNum = String(global.owner[0]).replace(/[^0-9]/g, '');
    }
    if (!cleanNum && sock && sock.user && sock.user.id) {
      cleanNum = String(sock.user.id).split(':')[0].split('@')[0].replace(/[^0-9]/g, '');
    }
    if (!cleanNum) cleanNum = '234';
    const oj = cleanNum + '@s.whatsapp.net';

    // 2. Resolve Owner Name
    let ownerName = '';
    try {
      const ownerJsonPath = path.join(__dirname, '..', 'owner.json');
      if (fs.existsSync(ownerJsonPath)) {
        const data = JSON.parse(fs.readFileSync(ownerJsonPath, 'utf8'));
        if (data && typeof data.ownerName === 'string' && data.ownerName.trim()) {
          ownerName = data.ownerName.trim();
        }
      }
    } catch (_) {}

    if (!ownerName && sock && typeof sock.getName === 'function') {
      try {
        const n = await sock.getName(oj);
        if (n && typeof n === 'string' && !/^(?:undefined|null|Bot Owner)$/i.test(n.trim())) {
          ownerName = n.trim();
        }
      } catch (_) {}
    }

    if (!ownerName && cfg.OWNER_NAME && !/^(?:undefined|null|Bot Owner)$/i.test(cfg.OWNER_NAME)) {
      ownerName = String(cfg.OWNER_NAME).trim();
    }
    if (!ownerName && process.env.OWNER_NAME && !/^(?:undefined|null|Bot Owner)$/i.test(process.env.OWNER_NAME)) {
      ownerName = String(process.env.OWNER_NAME).trim();
    }
    if (!ownerName && global && global.OWNER_NAME) {
      ownerName = String(global.OWNER_NAME).trim();
    }
    if (!ownerName) ownerName = '𖤐JINX𖤐';

    // 3. Resolve Owner Bio
    let bio = '';
    try {
      if (sock && typeof sock.fetchStatus === 'function') {
        const statusRes = await sock.fetchStatus(oj);
        if (statusRes && statusRes.status && typeof statusRes.status === 'string' && statusRes.status.trim()) {
          bio = statusRes.status.trim();
        }
      }
    } catch (_) {}

    if (!bio) {
      try {
        if (sock && typeof sock.getStatus === 'function') {
          const statusRes2 = await sock.getStatus(oj);
          if (statusRes2 && statusRes2.status && typeof statusRes2.status === 'string' && statusRes2.status.trim()) {
            bio = statusRes2.status.trim();
          }
        }
      } catch (_) {}
    }

    if (!bio) {
      try {
        const ownerJsonPath = path.join(__dirname, '..', 'owner.json');
        if (fs.existsSync(ownerJsonPath)) {
          const data = JSON.parse(fs.readFileSync(ownerJsonPath, 'utf8'));
          if (data && typeof data.bio === 'string' && data.bio.trim()) {
            bio = data.bio.trim();
          } else if (data && typeof data.status === 'string' && data.status.trim()) {
            bio = data.status.trim();
          }
        }
      } catch (_) {}
    }

    if (!bio && process.env.OWNER_BIO) {
      bio = String(process.env.OWNER_BIO).trim();
    }
    if (!bio) {
      bio = 'Building the future with code & creativity.';
    }

    // 4. Resolve Owner DP
    let dpBuffer = null;
    try {
      let dpUrl = null;
      if (sock && typeof sock.profilePictureUrl === 'function') {
        dpUrl = await sock.profilePictureUrl(oj, 'image').catch(() => null);
        if (!dpUrl) {
          dpUrl = await sock.profilePictureUrl(oj).catch(() => null);
        }
      }
      if (dpUrl) {
        dpBuffer = await fetchBuffer(dpUrl);
      }
    } catch (_) {}

    if (!dpBuffer) {
      try {
        if (typeof getBotPic === 'function') {
          dpBuffer = await getBotPic().catch(() => null);
        }
      } catch (_) {}
    }
    if (!dpBuffer && (cfg.BOT_PIC || (global && global.thumbnail))) {
      try {
        const fbUrl = cfg.BOT_PIC || global.thumbnail;
        dpBuffer = await fetchBuffer(fbUrl);
      } catch (_) {}
    }

    // 5. Build Compact 5-Item List
    const caption = [
      '╭───────────────◆',
      '│   👑 *OWNER PROFILE*',
      '╰───────────────◆',
      '',
      '┌───────────────',
      `├  1️⃣ ɴᴀᴍᴇ : *${ownerName}*`,
      `├  2️⃣ ᴄᴏɴᴛᴀᴄᴛ : *wa.me/${cleanNum}*`,
      `├  3️⃣ ʙɪᴏ : *${bio}*`,
      '├  4️⃣ ʙᴏᴛ : *MIAS LITE MDX*',
      '├  5️⃣ ꜱᴛᴀᴛᴜꜱ : *Active & Available*',
      '└───────────────',
      '',
      '> Powered by MIAS LITE MDX'
    ].join('\n');

    // 6. Build vCard
    const vcard = 'BEGIN:VCARD\n'
      + 'VERSION:3.0\n'
      + `FN:${ownerName}\n`
      + 'ORG:MIAS LITE MDX;\n'
      + `NOTE:${bio}\n`
      + `TEL;type=CELL;type=VOICE;waid=${cleanNum}:+${cleanNum}\n`
      + 'END:VCARD';

    // 7. Send media and contact
    let sentMedia = false;
    if (dpBuffer && Buffer.isBuffer(dpBuffer) && dpBuffer.length > 0) {
      try {
        await sock.sendMessage(jid, {
          image: dpBuffer,
          caption
        }, { quoted: msg });
        sentMedia = true;
      } catch (_) {}
    }

    if (!sentMedia) {
      try {
        if (typeof sendReply === 'function') {
          await sendReply(sock, msg, caption);
        } else {
          await sock.sendMessage(jid, { text: caption }, { quoted: msg });
        }
      } catch (sendErr) {
        try {
          await sock.sendMessage(jid, { text: caption }, { quoted: msg });
        } catch (_) {}
      }
    }

    try {
      await sock.sendMessage(jid, {
        contacts: {
          displayName: `${ownerName} — Owner`,
          contacts: [{ vcard }]
        }
      }, { quoted: msg });
    } catch (_) {}
  });

  return true;
}
