/**
 * MIAS — Contact Handler  v2
 *
 * Centralized vCard / contact sending abstraction.
 * Includes bot self-contact card with embedded profile picture.
 *
 * Architecture:  Commands → Handlers → Baileys Adapter → WhatsApp
 */

import { fetchBuffer } from "./uploadHandler.js";

// ─── vCard builder ─────────────────────────────────────────────────────────────

/**
 * Build a vCard 3.0 string for a single contact.
 * Optionally embeds a JPEG profile picture as base64.
 *
 * @param {object}  contact
 * @param {string}  contact.displayName
 * @param {string}  contact.phone           - Digits only, with country code
 * @param {string}  [contact.org]
 * @param {string}  [contact.title]
 * @param {string}  [contact.email]
 * @param {string}  [contact.url]
 * @param {string}  [contact.note]
 * @param {Buffer}  [contact.picBuffer]     - JPEG buffer to embed as PHOTO
 * @returns {string}
 */
export function buildVCard(contact) {
  const { displayName, phone, org, title, email, url, note, picBuffer } = contact;
  const name = displayName || phone || "Unknown";
  const cleanPhone = String(phone || "").replace(/\D/g, "");

  const lines = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `FN:${name}`,
    `N:${name};;;`,
    `TEL;type=CELL;type=VOICE;waid=${cleanPhone}:+${cleanPhone}`,
  ];

  if (org)   lines.push(`ORG:${org}`);
  if (title) lines.push(`TITLE:${title}`);
  if (email) lines.push(`EMAIL:${email}`);
  if (url)   lines.push(`URL:${url}`);
  if (note)  lines.push(`NOTE:${note}`);

  // Embed profile picture if provided
  if (picBuffer && Buffer.isBuffer(picBuffer) && picBuffer.length > 0) {
    const b64 = picBuffer.toString("base64");
    lines.push(`PHOTO;ENCODING=BASE64;TYPE=JPEG:${b64}`);
  }

  lines.push("END:VCARD");
  return lines.join("\r\n");
}

// ─── Profile picture helper ────────────────────────────────────────────────────

/**
 * Fetch a WhatsApp profile picture as a Buffer.
 * Returns null if unavailable or request fails.
 *
 * @param {object} sock
 * @param {string} jid
 * @returns {Promise<Buffer|null>}
 */
export async function fetchProfilePic(sock, jid) {
  try {
    const url = await sock.profilePictureUrl(jid, "image");
    if (!url) return null;
    return await fetchBuffer(url);
  } catch {
    return null;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Send a single contact card.
 *
 * @param {object} sock
 * @param {string} jid
 * @param {object} contact
 * @param {object} [opts]
 * @param {object} [opts.quoted]
 * @param {boolean}[opts.withPic]  - Fetch and embed WhatsApp profile pic (default false)
 */
export async function sendContact(sock, jid, contact, opts = {}) {
  try {
    let picBuffer = null;
    if (opts.withPic && contact.phone) {
      const targetJid = `${String(contact.phone).replace(/\D/g, "")}@s.whatsapp.net`;
      picBuffer = await fetchProfilePic(sock, targetJid);
    }

    const vcard = buildVCard({ ...contact, picBuffer });
    const content = {
      contacts: {
        displayName: contact.displayName || contact.phone || "Contact",
        contacts: [{ vcard }],
      },
    };

    const sendOpts = {};
    if (opts.quoted) sendOpts.quoted = opts.quoted;
    return await sock.sendMessage(jid, content, sendOpts);
  } catch (err) {
    console.error("[sendContact] Error:", err?.message);
    return null;
  }
}

/**
 * Send multiple contacts in one message.
 *
 * @param {object}   sock
 * @param {string}   jid
 * @param {object[]} contacts
 * @param {object}   [opts]
 * @param {string}   [opts.displayName]
 * @param {object}   [opts.quoted]
 */
export async function sendContacts(sock, jid, contacts, opts = {}) {
  try {
    if (!contacts?.length) return null;
    const vcards = contacts.map(c => ({ vcard: buildVCard(c) }));
    const content = {
      contacts: {
        displayName: opts.displayName || `${contacts.length} Contacts`,
        contacts: vcards,
      },
    };
    const sendOpts = {};
    if (opts.quoted) sendOpts.quoted = opts.quoted;
    return await sock.sendMessage(jid, content, sendOpts);
  } catch (err) {
    console.error("[sendContacts] Error:", err?.message);
    return null;
  }
}

/**
 * Send the bot's own contact card with its profile picture embedded.
 * This is the primary "bot identity" card — used in menus and on command.
 *
 * @param {object} sock
 * @param {string} jid
 * @param {object} [opts]
 * @param {string} [opts.displayName]  - Override bot name
 * @param {string} [opts.org]          - Organization / description line
 * @param {string} [opts.title]        - Bot title
 * @param {string} [opts.note]         - Note field
 * @param {string} [opts.url]          - URL field
 * @param {boolean}[opts.withPic]      - Embed profile picture (default true)
 * @param {object} [opts.quoted]
 */
export async function sendBotVCard(sock, jid, opts = {}) {
  try {
    const botJid   = sock.user?.id || "";
    const botName  = opts.displayName || sock.user?.name || "Bot";
    const botPhone = botJid.split("@")[0].split(":")[0];
    const withPic  = opts.withPic !== false;

    let picBuffer = null;
    if (withPic && botJid) {
      picBuffer = await fetchProfilePic(sock, botJid);
    }

    const vcard = buildVCard({
      displayName: botName,
      phone: botPhone,
      org: opts.org || null,
      title: opts.title || null,
      note: opts.note || null,
      url: opts.url || null,
      picBuffer,
    });

    const sendOpts = {};
    if (opts.quoted) sendOpts.quoted = opts.quoted;

    return await sock.sendMessage(jid, {
      contacts: {
        displayName: botName,
        contacts: [{ vcard }],
      },
    }, sendOpts);
  } catch (err) {
    console.error("[sendBotVCard] Error:", err?.message);
    return null;
  }
}

/**
 * Parse a vCard string into a plain contact object.
 * @param {string} vcard
 * @returns {object}
 */
export function parseVCard(vcard) {
  const result = {};
  for (const line of (vcard || "").split(/\r?\n/)) {
    if (line.startsWith("FN:"))     result.displayName = line.slice(3);
    if (line.startsWith("TEL")) {
      const match = line.match(/(?:waid=(\d+)|:(\+?\d+))/);
      result.phone = match?.[1] || match?.[2]?.replace(/\D/g, "") || "";
    }
    if (line.startsWith("ORG:"))    result.org   = line.slice(4);
    if (line.startsWith("TITLE:"))  result.title = line.slice(6);
    if (line.startsWith("EMAIL:"))  result.email = line.slice(6);
    if (line.startsWith("URL:"))    result.url   = line.slice(4);
    if (line.startsWith("NOTE:"))   result.note  = line.slice(5);
  }
  return result;
}
