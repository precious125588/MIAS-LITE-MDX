/**
 * MIAS — VCardBuilder
 *
 * Fluent builder for WhatsApp vCard contact messages.
 * Supports single contacts, multiple contacts, and bot self-contact.
 *
 *   Usage:
 *     // Single contact
 *     await new VCardBuilder(sock, jid)
 *       .name("Precious")
 *       .phone("2348012345678")
 *       .org("JINX Bot")
 *       .withPic(true)
 *       .quoted(msg)
 *       .send();
 *
 *     // Bot self-contact
 *     await VCardBuilder.bot(sock, jid, { quoted: msg }).send();
 */

import { buildVCard, fetchProfilePic } from "../contactHandler.js";

export class VCardBuilder {
  constructor(sock, jid) {
    this._sock        = sock;
    this._jid         = jid;
    this._displayName = "";
    this._phone       = "";
    this._org         = null;
    this._title       = null;
    this._email       = null;
    this._url         = null;
    this._note        = null;
    this._withPic     = false;
    this._quoted      = null;
    this._contacts    = [];   // for multi-contact
  }

  /** Display name */
  name(text)    { this._displayName = String(text || ""); return this; }

  /** Phone number (digits + country code) */
  phone(num)    { this._phone = String(num || "").replace(/\D/g, ""); return this; }

  /** Organization / company */
  org(text)     { this._org = String(text || ""); return this; }

  /** Title / job */
  title(text)   { this._title = String(text || ""); return this; }

  /** Email address */
  email(addr)   { this._email = String(addr || ""); return this; }

  /** URL */
  url(u)        { this._url = String(u || ""); return this; }

  /** Note field */
  note(text)    { this._note = String(text || ""); return this; }

  /**
   * Whether to fetch and embed the WhatsApp profile picture.
   * @param {boolean} bool
   */
  withPic(bool) { this._withPic = bool !== false; return this; }

  /** Quoted message */
  quoted(msg)   { this._quoted = msg || null; return this; }

  /**
   * Add an extra contact to a multi-contact message.
   * @param {object} contact - { displayName, phone, org, ... }
   */
  addContact(contact) {
    this._contacts.push(contact);
    return this;
  }

  /**
   * Send the vCard message.
   * @returns {Promise<object|null>}
   */
  async send() {
    try {
      const sendOpts = {};
      if (this._quoted) sendOpts.quoted = this._quoted;

      // Multi-contact
      if (this._contacts.length > 0) {
        const all = [
          ...(this._phone ? [{ displayName: this._displayName, phone: this._phone }] : []),
          ...this._contacts,
        ];
        const vcards = all.map(c => ({ vcard: buildVCard(c) }));
        return await this._sock.sendMessage(this._jid, {
          contacts: { displayName: `${all.length} Contacts`, contacts: vcards },
        }, sendOpts);
      }

      // Single contact
      let picBuffer = null;
      if (this._withPic && this._phone) {
        const targetJid = `${this._phone}@s.whatsapp.net`;
        picBuffer = await fetchProfilePic(this._sock, targetJid).catch(() => null);
      }

      const vcard = buildVCard({
        displayName: this._displayName || this._phone || "Contact",
        phone:       this._phone,
        org:         this._org,
        title:       this._title,
        email:       this._email,
        url:         this._url,
        note:        this._note,
        picBuffer,
      });

      return await this._sock.sendMessage(this._jid, {
        contacts: {
          displayName: this._displayName || this._phone || "Contact",
          contacts: [{ vcard }],
        },
      }, sendOpts);
    } catch (err) {
      console.error("[VCardBuilder.send] Error:", err?.message);
      return null;
    }
  }

  /**
   * Create a VCardBuilder pre-configured for the bot's own contact card.
   * @param {object} sock
   * @param {string} jid
   * @param {object} [opts]
   * @param {string} [opts.displayName]
   * @param {string} [opts.org]
   * @param {string} [opts.note]
   * @param {object} [opts.quoted]
   * @param {boolean}[opts.withPic]
   * @returns {VCardBuilder}
   */
  static bot(sock, jid, opts = {}) {
    const botJid   = sock.user?.id || "";
    const botName  = opts.displayName || sock.user?.name || "Bot";
    const botPhone = botJid.split("@")[0].split(":")[0];

    const builder = new VCardBuilder(sock, jid)
      .name(botName)
      .phone(botPhone)
      .withPic(opts.withPic !== false);

    if (opts.org)    builder.org(opts.org);
    if (opts.note)   builder.note(opts.note);
    if (opts.quoted) builder.quoted(opts.quoted);

    return builder;
  }
}

/**
 * Factory shorthand.
 * @param {object} sock
 * @param {string} jid
 * @returns {VCardBuilder}
 */
export function vcard(sock, jid) {
  return new VCardBuilder(sock, jid);
}

export default VCardBuilder;
