'use strict';
/* ── OWNER "IS ALIVE" CARD ─────────────────────────────────────────────────────
   The connect notice to the owner used to send bare text, so WhatsApp built the
   link card from levanter.site's page image (the black box). This sends the same
   text with a link card whose thumbnail is the owner's own WhatsApp profile
   picture. The URL in the text is unchanged. If the picture cannot be fetched
   (no DP, privacy, network error) it falls back to the old plain text.
   ──────────────────────────────────────────────────────────────────────────── */

const LINK_URL = 'https://levanter.site/plugin';
const CARD_TITLE = 'Levanter | WhatsApp Bot Dashboard & Plugins';
const CARD_BODY = 'The complete WhatsApp bot dashboard & plugins';
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
 * @param {{ text: string }} opts
 */
async function sendOwnerAliveCard(sock, jid, { text } = {}) {
  const body = String(text || '');
  const thumbnail = await fetchProfilePicture(sock, jid);
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

module.exports = { sendOwnerAliveCard, fetchProfilePicture, LINK_URL };
