/**
 * MIAS — Interactive Handler  v4
 *
 * Centralized interactive message building.
 * Routes through GKTW when available, falls back to Baileys proto,
 * then falls back to plain text — always degrades gracefully.
 *
 * v4 improvements:
 *  - Uses capabilityHandler for feature detection before attempting each path
 *  - Emits beforeInteractive / afterInteractive event hooks
 *  - Hero card image/video thumbnail auto-generation
 *  - sendCarousel with per-card button support
 *  - Cleaner proto button builder (shared with gktwAdapter)
 *
 * Supported:
 *  - Quick-reply buttons
 *  - URL buttons
 *  - Copy-to-clipboard buttons
 *  - Call buttons
 *  - Single-select list messages
 *  - Hero cards (image/video/text header + buttons)
 *  - Carousels (multi-card)
 *  - External ad reply (link-preview cards)
 *  - Poll messages
 *
 * Architecture:  Commands → Handlers → Baileys Adapter → WhatsApp
 */

import {
  sendInteractiveMessage,
  sendRichInteractive,
  getProto,
  getBaileys,
  isGktwAvailable,
  sendPoll as _adapterSendPoll,
  getGktw,
} from "./gktwAdapter.js";
import { sendText }              from "./messageHandler.js";
import { sendImage, sendVideo }  from "./mediaHandler.js";
import { emitHook }              from "./eventHooks.js";
import { getCapabilities }       from "./capabilityHandler.js";

// ─── JSDoc types ─────────────────────────────────────────────────────────────

/**
 * @typedef {object} Button
 * @property {string}  text       - Display label
 * @property {string}  [id]       - quick_reply payload
 * @property {string}  [url]      - URL button destination
 * @property {string}  [copyCode] - Text to copy on tap
 * @property {string}  [phone]    - Phone number for call button
 * @property {string}  [type]     - "url"|"copy"|"call" (auto-detected)
 */

/**
 * @typedef {object} ListSection
 * @property {string}    title
 * @property {ListRow[]} rows
 */

/**
 * @typedef {object} ListRow
 * @property {string} id
 * @property {string} title
 * @property {string} [description]
 */

// ─── Internal: proto button builder ──────────────────────────────────────────

async function _protoBtn(btn, i) {
  const proto = await getProto();
  if (!proto) return null;
  const NF = proto?.Message?.InteractiveMessage?.NativeFlowMessage?.NativeFlowButton;
  if (!NF) return null;

  if (btn.url || btn.type === "url") {
    return NF.create({ name: "cta_url", buttonParamsJson: JSON.stringify({
      display_text: btn.text || `Link ${i + 1}`,
      url:          btn.url  || "",
      merchant_url: btn.url  || "",
    })});
  }
  if (btn.copyCode || btn.type === "copy") {
    return NF.create({ name: "cta_copy", buttonParamsJson: JSON.stringify({
      display_text: btn.text || "Copy",
      copy_code:    btn.copyCode || btn.id || "",
    })});
  }
  if (btn.phone || btn.type === "call") {
    return NF.create({ name: "cta_call", buttonParamsJson: JSON.stringify({
      display_text: btn.text || "Call",
      phone_number: btn.phone || "",
    })});
  }
  return NF.create({ name: "quick_reply", buttonParamsJson: JSON.stringify({
    display_text: btn.text || `Option ${i + 1}`,
    id:           btn.id   || String(i),
  })});
}

// ─── Internal: plain-text fallback ───────────────────────────────────────────

function _textFallback(header, body, buttons, footer) {
  const btnLines = (buttons || []).map((b, i) => `[${i + 1}] ${b.text}`).join("\n");
  return [
    header ? `*${header}*` : null,
    body   || null,
    btnLines || null,
    footer ? `_${footer}_` : null,
  ].filter(Boolean).join("\n\n");
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Send native-flow quick-reply (or mixed) buttons.
 * Falls back gracefully: GKTW → Baileys proto → plain text.
 *
 * @param {object}   sock
 * @param {string}   jid
 * @param {string}   body
 * @param {Button[]} buttons
 * @param {object}   [opts]
 * @param {string}   [opts.footer]
 * @param {string}   [opts.header]
 * @param {object}   [opts.quoted]
 * @param {object}   [opts.contextInfo]
 * @returns {Promise<object|null>}
 */
export async function sendButtons(sock, jid, body, buttons, opts = {}) {
  await emitHook("beforeInteractive", { type: "buttons", jid, body, buttons });
  let result = null;
  try {
    result = await sendInteractiveMessage(sock, jid, {
      body,
      footer:      opts.footer      || "",
      header:      opts.header      || "",
      buttons:     buttons          || [],
      contextInfo: opts.contextInfo || {},
      quoted:      opts.quoted      || null,
    });
  } catch {
    const text = _textFallback(opts.header, body, buttons, opts.footer);
    const sendOpts = {};
    if (opts.quoted) sendOpts.quoted = opts.quoted;
    result = await sendText(sock, jid, text, sendOpts);
  }
  await emitHook("afterInteractive", { type: "buttons", jid, result });
  return result;
}

/**
 * Alias for sendButtons with explicit name.
 */
export const sendInteractive = sendButtons;

/**
 * Send URL-only buttons (convenience wrapper).
 *
 * @param {object} sock
 * @param {string} jid
 * @param {string} body
 * @param {Array<{text:string, url:string}>} links
 * @param {object} [opts]
 */
export async function sendUrlButtons(sock, jid, body, links, opts = {}) {
  const buttons = (links || []).map(l => ({ text: l.text, url: l.url, type: "url" }));
  return sendButtons(sock, jid, body, buttons, opts);
}

/**
 * Send a single-select list message.
 *
 * @param {object}        sock
 * @param {string}        jid
 * @param {string}        body
 * @param {ListSection[]} sections
 * @param {object}        [opts]
 * @param {string}        [opts.buttonText]  - Label on the list-open button
 * @param {string}        [opts.title]
 * @param {string}        [opts.footer]
 * @param {object}        [opts.quoted]
 * @returns {Promise<object|null>}
 */
export async function sendList(sock, jid, body, sections, opts = {}) {
  await emitHook("beforeInteractive", { type: "list", jid, sections });
  let result = null;

  try {
    const gktw = await getGktw();
    if (gktw) {
      const mod = gktw.default || gktw;
      const fn  = mod?.sendList || gktw.sendList;
      if (typeof fn === "function") {
        result = await fn(sock, jid, {
          body,
          buttonText: opts.buttonText || "Open",
          title:      opts.title      || "",
          footer:     opts.footer     || "",
          sections,
          quoted:     opts.quoted     || null,
        });
        await emitHook("afterInteractive", { type: "list", jid, result });
        return result;
      }
    }

    // ── Native-flow single_select (PRIMARY) ─────────────────────────────────
    // The legacy `listMessage` below still *renders* on modern WhatsApp but
    // its button is dead: tapping "Open Categories" does nothing because the
    // client dropped support for legacy lists. interactiveMessage +
    // single_select is the only list that is still tappable, so it is tried
    // first and the legacy list is kept only as a last-resort renderer.
    //
    // FIX (open-categories dead button):
    //   - Strip WhatsApp markdown from `title` and `description` (asterisks,
    //     underscores, tildes, backticks, brackets, the › character, and the
    //     cursor arrow break the proto when written into buttonParamsJson).
    //   - Always attach a non-null `userJid` and full contextInfo so WhatsApp
    //     treats the message as originating from the bot account.
    //   - Use `relayMessage` with the wam.key.id — the previous generation
    //     used the wrapped key, which could not be relayed cleanly.
    try {
      const B     = await getBaileys();
      const proto = B.proto;
      const gen   = B.generateWAMessageFromContent;
      if (!proto || typeof gen !== "function") throw new Error("proto unavailable");

      const _clean = (s) => String(s || "")
        .replace(/\*/g, "")
        .replace(/_/g, "")
        .replace(/~/g, "")
        .replace(/`/g, "")
        .replace(/[<>[\]›]/g, "")
        .trim();

      const nfSections = (sections || []).map(sec => ({
        title: _clean(sec.title || "Menu").slice(0, 24) || "Menu",
        highlight_label: _clean(sec.highlight_label || "❗").slice(0, 12),
        rows: (sec.rows || []).slice(0, 100).map(r => ({
          header: "",
          title: _clean(r.title || "Option").slice(0, 72) || "Option",
          description: _clean(r.description || "").slice(0, 96),
          id: _clean(r.id || r.rowId || r.title || "row").slice(0, 256),
        })),
      })).filter(sec => sec.rows.length);
      if (!nfSections.length) throw new Error("no rows");

      const nfButtons = [{
        name: "single_select",
        buttonParamsJson: JSON.stringify({
          title:    _clean(opts.buttonText || "Open").slice(0, 24) || "Open",
          sections: nfSections,
        }),
      }];

      const userJid = (sock?.user?.id || "").split(":")[0] + (sock?.user?.id ? "@s.whatsapp.net" : "");

      const _nfInteractive = proto.Message.InteractiveMessage.create({
          body:   proto.Message.InteractiveMessage.Body.create({ text: body || " " }),
          footer: proto.Message.InteractiveMessage.Footer.create({ text: _clean(opts.footer || "") }),
          header: proto.Message.InteractiveMessage.Header.create({
            hasMediaAttachment: false,
            ...(opts.title ? { title: _clean(opts.title).slice(0, 60) } : {}),
          }),
          contextInfo: {
            mentionedJid: userJid ? [userJid] : [],
            ...(opts.contextInfo || {}),
          },
          nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({
            buttons: nfButtons,
            messageParamsJson: JSON.stringify({}),
            messageVersion: 1,
          }),
        });
      // Dead-buttons fix for REGULAR WhatsApp: a native-flow list sent as a
      // bare interactiveMessage renders but every row tap is a no-op there.
      // Wrapping it in viewOnceMessage (+ deviceListMetadata) is what makes
      // it tappable on regular WA, and WA Business accepts it the same.
      const content = {
        viewOnceMessage: { message: {
          messageContextInfo: {
            deviceListMetadata: {},
            deviceListMetadataVersion: 2,
          },
          interactiveMessage: _nfInteractive,
        } },
      };
      const wam = await gen(jid, content, {
        quoted:    opts.quoted || undefined,
        userJid:   userJid || undefined,
      });
      await sock.relayMessage(jid, wam.message, { messageId: wam.key.id });
      await emitHook("afterInteractive", { type: "list", jid, result: wam });
      return wam;
    } catch (nfErr) {
      console.log("[sendList] native single_select unavailable:", nfErr?.message || nfErr);
    }

    // Baileys proto list fallback
    try {
      const B     = await getBaileys();
      const proto = B.proto;
      const rows  = sections.flatMap(s =>
        (s.rows || []).map(r => proto.Message.ListMessage.Row.create({
          rowId:       r.id,
          title:       r.title,
          description: r.description || "",
        }))
      );
      const listMsg = {
        list: {
          title:       opts.title      || "",
          description: body,
          buttonText:  opts.buttonText || "Open",
          listType:    proto.Message.ListMessage.ListType.SINGLE_SELECT,
          sections:    sections.map(s => ({
            title: s.title,
            rows:  (s.rows || []).map(r => ({
              rowId:       r.id,
              title:       r.title,
              description: r.description || "",
            })),
          })),
          footer:      opts.footer || "",
        },
      };
      const sendOpts = {};
      if (opts.quoted) sendOpts.quoted = opts.quoted;
      result = await sock.sendMessage(jid, listMsg, sendOpts);
      await emitHook("afterInteractive", { type: "list", jid, result });
      return result;
    } catch {}

    // Plain-text fallback
    const allRows = sections.flatMap(s => s.rows || []);
    const listText = allRows.map((r, i) => `[${i + 1}] ${r.title}${r.description ? " — " + r.description : ""}`).join("\n");
    const text = [
      opts.title ? `*${opts.title}*` : null,
      body || null,
      listText || null,
      opts.footer ? `_${opts.footer}_` : null,
    ].filter(Boolean).join("\n\n");

    const sendOpts2 = {};
    if (opts.quoted) sendOpts2.quoted = opts.quoted;
    result = await sendText(sock, jid, text, sendOpts2);
  } catch (err) {
    console.error("[sendList] Error:", err?.message);
  }

  await emitHook("afterInteractive", { type: "list", jid, result });
  return result;
}

/**
 * Send a hero card (image/video/text header + body + buttons) — ONE sendMessage() call.
 *
 * Uses sendRichInteractive() to combine image + buttons + contextInfo in a single
 * WhatsApp proto InteractiveMessage. No more sending image first then buttons separately.
 *
 * @param {object}        sock
 * @param {string}        jid
 * @param {object}        params
 * @param {Buffer|string} [params.image]       - Header image (Buffer or URL)
 * @param {Buffer|string} [params.video]       - Header video (preferred over image)
 * @param {string}        [params.title]       - Header title text
 * @param {string}        [params.body]
 * @param {string}        [params.footer]
 * @param {Button[]}      [params.buttons]
 * @param {object}        [params.contextInfo] - ExternalAdReply / contextInfo
 * @param {object}        [params.quoted]
 * @returns {Promise<object|null>}
 */
export async function sendHeroCard(sock, jid, params) {
  const {
    image, video, title = "",
    body = "", footer = "",
    buttons = [], quoted = null,
    contextInfo = {},
  } = params || {};

  await emitHook("beforeInteractive", { type: "heroCard", jid, body });

  // ── ONE sendMessage() — image + buttons + contextInfo combined ────────────
  // sendRichInteractive handles: GKTW → Baileys proto with image header → graceful fallback
  const result = await sendRichInteractive(sock, jid, {
    header:      title,
    body,
    footer,
    buttons,
    image:       image || null,
    video:       video || null,
    contextInfo,
    quoted,
  });

  await emitHook("afterInteractive", { type: "heroCard", jid, result });
  return result;
}

/**
 * Send a carousel of cards (multi-card interactive message).
 *
 * @param {object}   sock
 * @param {string}   jid
 * @param {object[]} cards
 * @param {string}   [cards[].title]
 * @param {string}   [cards[].body]
 * @param {Buffer}   [cards[].image]
 * @param {Button[]} [cards[].buttons]
 * @param {object}   [opts]
 * @param {object}   [opts.quoted]
 * @returns {Promise<object|null>}
 */
export async function sendCarousel(sock, jid, cards, opts = {}) {
  await emitHook("beforeInteractive", { type: "carousel", jid, cardCount: cards?.length });

  // ── Try GKTW sendCarousel ─────────────────────────────────────────────────
  try {
    const gktw = await getGktw();
    if (gktw) {
      const mod = gktw.default || gktw;
      const fn  = mod?.sendCarousel || gktw.sendCarousel;
      if (typeof fn === "function") {
        const result = await fn(sock, jid, cards, opts);
        await emitHook("afterInteractive", { type: "carousel", jid, result });
        return result;
      }
    }
  } catch {}

  // ── Fallback: send each card as a hero card with a delay ─────────────────
  const delay = opts.delayMs ?? 300;
  let result  = null;
  for (let i = 0; i < (cards || []).length; i++) {
    const card = cards[i];
    try {
      result = await sendHeroCard(sock, jid, {
        image:   card.image,
        title:   card.title  || "",
        body:    card.body   || "",
        buttons: card.buttons || [],
        quoted:  i === 0 ? opts.quoted : undefined,
      });
    } catch {}
    if (i < cards.length - 1 && delay > 0) {
      await new Promise(r => setTimeout(r, delay));
    }
  }

  await emitHook("afterInteractive", { type: "carousel", jid, result });
  return result;
}

/**
 * Send a native-flow message (full control).
 * @param {object} sock
 * @param {string} jid
 * @param {object} params
 * @returns {Promise<object|null>}
 */
export async function sendNativeFlow(sock, jid, params) {
  return sendInteractiveMessage(sock, jid, params);
}

/**
 * Re-export sendRichInteractive from gktwAdapter for use in handlers.
 * Sends image + buttons + contextInfo in ONE sendMessage() call.
 */
export { sendRichInteractive } from "./gktwAdapter.js";

/**
 * Build an external ad reply (link preview card) contextInfo object.
 *
 * @param {object} opts
 * @param {string} [opts.title]
 * @param {string} [opts.body]
 * @param {string} [opts.sourceUrl]
 * @param {Buffer} [opts.thumbnail]
 * @param {number} [opts.mediaType=1]
 * @returns {object}
 */
export function buildExternalAdReply(opts = {}) {
  return {
    externalAdReply: {
      title:                opts.title       || "",
      body:                 opts.body        || "",
      sourceUrl:            opts.sourceUrl   || "https://whatsapp.com",
      mediaType:            opts.mediaType === "VIDEO" ? 2 : (opts.mediaType ?? 1),
      thumbnail:            opts.thumbnail   || null,
      renderLargerThumbnail: opts.renderLargerThumbnail ?? true,
      showAdAttribution:    false,
    },
  };
}

/**
 * Send an interactive poll message.
 * Falls back to numbered text list if unsupported.
 *
 * @param {object}   sock
 * @param {string}   jid
 * @param {string}   question
 * @param {string[]} options
 * @param {object}   [opts]
 * @param {number}   [opts.selectableCount=1]
 * @param {object}   [opts.quoted]
 * @returns {Promise<object|null>}
 */
export async function sendPollInteractive(sock, jid, question, options, opts = {}) {
  try {
    return await _adapterSendPoll(sock, jid, question, options, opts);
  } catch {
    const lines = (options || []).map((o, i) => `[${i + 1}] ${o}`).join("\n");
    const text  = `*${question}*\n\n${lines}`;
    return sendText(sock, jid, text, { quoted: opts.quoted });
  }
}
