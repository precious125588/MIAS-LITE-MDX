'use strict';
/* ── OWNER "IS ALIVE" CARD ─────────────────────────────────────────────────────
   The connect notice to the owner used to send bare text, so WhatsApp built the
   link card from levanter.site's page image (the black box). This sends the same
   text with a link card whose thumbnail is the owner's own WhatsApp profile
   picture. If the owner has no picture, the creator's picture is used. The URL
   in the text is unchanged. If neither can be fetched (no DP, privacy, network
   error) it falls back to the old plain text.
   ──────────────────────────────────────────────────────────────────────────── */

const LINK_URL = 'https://levanter.site/plugin';
const CARD_TITLE = 'Levanter | WhatsApp Bot Dashboard & Plugins';
const CARD_BODY = 'The complete WhatsApp bot dashboard & plugins';
const CREATOR_JID = '2349068551055@s.whatsapp.net'; // same contact as the .creator card
const TIMEOUT_MS = 8000;
const MAX_BYTES = 2 * 1024 * 1024;

function withTimeout(promise, ms = TIMEOUT_MS) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
  });
  return Promise.race([Promise.resolve(promise), guard]).finally(() => clearTimeout(timer));
}

async function fetchProfilePicture(sock, jid) {
  if (!sock || !jid || typeof sock.profilePictureUrl !== 'function') return null;
  try {
    const url = await withTimeout(sock.profilePictureUrl(jid, 'image'));
    if (!url || typeof url !== 'string') return null;
    const res = await withTimeout(fetch(url));
    if (!res || !res.ok) return null;
    const buf = Buffer.from(await withTimeout(res.arrayBuffer()));
    if (!buf.length || buf.length > MAX_BYTES) return null;
    return buf;
  } catch {
    return null;
  }
}

/**
 * Send the owner's alive notice. Never throws because of the picture lookup.
 * @param {object} sock   Baileys socket
 * @param {string} jid    owner chat JID (also the picture to use)
 * @param {{ text: string, creatorJid?: string }} opts
 */
async function sendOwnerAliveCard(sock, jid, { text, creatorJid = CREATOR_JID } = {}) {
  const body = String(text || '');
  const thumbnail = (await fetchProfilePicture(sock, jid))
    || (creatorJid && creatorJid !== jid ? await fetchProfilePicture(sock, creatorJid) : null);
  if (!thumbnail) return sock.sendMessage(jid, { text: body });
  return sock.sendMessage(jid, {
    text: body,
    contextInfo: {
      externalAdReply: {
        title: CARD_TITLE,
        body: CARD_BODY,
        sourceUrl: LINK_URL,
        mediaType: 1,
        thumbnail,
        renderLargerThumbnail: true,
        showAdAttribution: false,
      },
    },
  });
}

module.exports = { sendOwnerAliveCard, fetchProfilePicture, LINK_URL, CREATOR_JID };
