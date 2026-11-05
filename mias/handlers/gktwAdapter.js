/**
 * MIAS — GKTW Adapter Layer  v4
 *
 * ════════════════════════════════════════════════════════════════
 *  Architecture:
 *
 *  Commands → Handlers → Baileys Adapter → GKTW Helper → WhatsApp
 *
 *  Single integration point for @itsreimau/gktw.
 *  - Auto-detects @itsreimau/gktw if installed.
 *  - Falls back to raw @whiskeysockets/baileys for every feature.
 *  - Handlers never care which layer is active.
 *
 *  @itsreimau/gktw is optional — adapter falls back gracefully.
 *  When it becomes available: cd mias && npm install @itsreimau/gktw
 *  Zero code changes needed — adapter auto-routes everything.
 * ════════════════════════════════════════════════════════════════
 *
 * ONLY Handlers/Adapters may import this file.
 * Commands must NEVER import this directly.
 *
 * v4 Changes:
 *  - Broader GKTW function detection (sendHeroCard, sendCarousel, sendList)
 *  - gktwVersion() — expose installed GKTW version string
 *  - generateContextInfo() — build contextInfo helper
 *  - generateExternalAdReply() — build externalAdReply helper
 *  - Improved sendInteractiveMessage fallback chain
 *  - Safer lazy-load with detailed error capture
 */

// ─── Lazy singletons ──────────────────────────────────────────────────────────
let _baileys      = null;
let _gktw         = null;
let _gktwAvailable = null; // null = unchecked, true/false = final result
let _gktwLoadErr  = null;  // stores the load error for diagnostics

// ─── Internal loader helpers ──────────────────────────────────────────────────

export async function getBaileys() {
  if (!_baileys) {
    _baileys = await import("@whiskeysockets/baileys");
  }
  return _baileys;
}

// Candidate helper package names, in priority order.
// NOTE: "@itsreimau/gktw" does NOT exist on npm (404) and github.com/itsreimau/gktw
// is 404 too, so it can never resolve — it is kept only so a future release
// under that name would light up automatically. Set GKTW_PACKAGE=<name> to point
// the adapter at any drop-in helper. Nothing here is required: every feature has
// a raw Baileys fallback below.
export const GKTW_CANDIDATES = [
  process.env.GKTW_PACKAGE,
  // Local drop-in shim at <repo>/cox (wired as "cox": "file:../cox" in
  // mias/package.json). It is gktw-compatible and always installable, so it
  // is preferred over the 404 upstream packages below.
  "cox",
  "@itsreimau/gktw",
  "@mengkodingan/ckptw",
].filter(Boolean);

let _gktwPkgName = null;

const GKTW_FNS = [
  "sendInteractive", "sendHeroCard", "sendCarousel",
  "sendList", "createInteractiveMessage",
];

async function getGktw() {
  if (_gktwAvailable === null) {
    _gktwAvailable = false;
    for (const name of GKTW_CANDIDATES) {
      try {
        const mod = await import(/* @vite-ignore */ name);
        const api = mod?.default || mod;
        const hasAny = GKTW_FNS.some(
          fn => typeof api?.[fn] === "function" || typeof mod?.[fn] === "function",
        );
        if (hasAny) {
          _gktw = mod;
          _gktwPkgName = name;
          _gktwAvailable = true;
          break;
        }
        _gktwLoadErr = new Error(`${name} loaded but exposes no expected helper functions`);
      } catch (err) {
        _gktwLoadErr = err;
      }
    }
    if (!_gktwAvailable) _gktw = null;
  }
  return _gktw;
}

/** Name of the helper package that actually loaded, or null. */
export function gktwPackageName() { return _gktwPkgName; }

// ─── Public: capability detection ─────────────────────────────────────────────

/** Returns true if @itsreimau/gktw is installed, loaded, and functional. */
export async function isGktwAvailable() {
  await getGktw();
  return _gktwAvailable === true;
}

/** Returns the raw GKTW module, or null if unavailable. */
export async function gktwModule() {
  return getGktw();
}

/** Returns the raw Baileys module. Always available. */
export async function baileysModule() {
  return getBaileys();
}

/**
 * Returns the installed GKTW version string, or null if unavailable.
 * @returns {Promise<string|null>}
 */
export async function gktwVersion() {
  if (!(await isGktwAvailable())) return null;
  try {
    const mod = _gktw?.default || _gktw;
    if (mod?.version) return String(mod.version);
    // Try reading package.json
    const pkg = _gktwPkgName
      ? await import(/* @vite-ignore */ `${_gktwPkgName}/package.json`, { with: { type: "json" } }).catch(() => null)
      : null;
    return pkg?.default?.version || pkg?.version || "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Return diagnostics about adapter state.
 * @returns {object}
 */
export function adapterDiagnostics() {
  return {
    gktwAvailable: _gktwAvailable,
    gktwLoadError: _gktwLoadErr?.message || null,
    baileysLoaded: !!_baileys,
  };
}

// ─── Proto helper ─────────────────────────────────────────────────────────────

export async function getProto() {
  const B = await getBaileys();
  return B.proto;
}

// ─── JID helpers ──────────────────────────────────────────────────────────────

export async function jidNormalizedUser(jid) {
  const B = await getBaileys();
  return B.jidNormalizedUser ? B.jidNormalizedUser(jid) : jid;
}

/** Check if a JID is a newsletter / channel JID. */
export async function isJidNewsletter(jid) {
  try {
    const B = await getBaileys();
    if (typeof B.isJidNewsletter === "function") return B.isJidNewsletter(jid);
  } catch {}
  return String(jid || "").endsWith("@newsletter");
}

/** Check if a JID is a group JID. */
export function isJidGroup(jid) {
  return String(jid || "").endsWith("@g.us");
}

/** Check if a JID is a user JID. */
export function isJidUser(jid) {
  return String(jid || "").endsWith("@s.whatsapp.net");
}

// ─── Message generation helpers ───────────────────────────────────────────────

export async function generateWAMessageFromContent(jid, content, options) {
  const B = await getBaileys();
  return B.generateWAMessageFromContent(jid, content, options);
}

export async function generateWAMessage(jid, content, options) {
  const B = await getBaileys();
  return B.generateWAMessage(jid, content, options);
}

// ─── downloadContentFromMessage ───────────────────────────────────────────────

export async function downloadContentFromMessage(message, type) {
  const B = await getBaileys();
  return B.downloadContentFromMessage(message, type);
}

// ─── prepareWAMessageMedia ────────────────────────────────────────────────────

export async function prepareWAMessageMedia(content, options) {
  const B = await getBaileys();
  return B.prepareWAMessageMedia(content, options);
}

// ─── getContentType ───────────────────────────────────────────────────────────

export async function getContentType(message) {
  try {
    const B = await getBaileys();
    if (typeof B.getContentType === "function") return B.getContentType(message);
  } catch {}
  // Manual fallback
  const keys = Object.keys(message || {});
  return keys.find(k => !["senderKeyDistributionMessage", "messageContextInfo"].includes(k)) || null;
}

// ─── Group helpers ────────────────────────────────────────────────────────────

export async function getGroupMetadata(sock, jid) {
  try {
    if (typeof sock.groupMetadata === "function") return await sock.groupMetadata(jid);
    if (typeof sock.groupFetchAllParticipating === "function") {
      const all = await sock.groupFetchAllParticipating();
      return all?.[jid] || null;
    }
  } catch (err) {
    console.error("[getGroupMetadata] Error:", err?.message);
  }
  return null;
}

export async function groupFetchAllParticipating(sock) {
  try {
    if (typeof sock.groupFetchAllParticipating === "function") {
      return await sock.groupFetchAllParticipating();
    }
  } catch (err) {
    console.error("[groupFetchAllParticipating] Error:", err?.message);
  }
  return {};
}

// ─── Poll ─────────────────────────────────────────────────────────────────────

export async function sendPoll(sock, jid, question, options, opts = {}) {
  try {
    if (!question || !Array.isArray(options) || options.length < 2) {
      throw new Error("Poll requires a question and at least 2 options");
    }
    const pollOptions = options.slice(0, 12).map(o => String(o).trim()).filter(Boolean);
    const content = {
      poll: {
        name: String(question).trim(),
        values: pollOptions,
        selectableCount: opts.selectableCount ?? 1,
      },
    };
    const sendOpts = {};
    if (opts.quoted) sendOpts.quoted = opts.quoted;
    return await sock.sendMessage(jid, content, sendOpts);
  } catch (err) {
    console.error("[sendPoll] Error:", err?.message);
    return null;
  }
}

// ─── Smart send (GKTW-first, Baileys fallback) ────────────────────────────────

export async function smartSend(sock, jid, content, opts = {}) {
  try {
    const gktw = await getGktw();
    if (gktw) {
      const mod = gktw.default || gktw;
      const fn  = mod?.sendMessage || gktw.sendMessage;
      if (typeof fn === "function") {
        return await fn(sock, jid, content, opts);
      }
    }
    return await sock.sendMessage(jid, content, opts);
  } catch {
    try { return await sock.sendMessage(jid, content, opts); } catch (innerErr) {
      console.error("[smartSend] Error:", innerErr?.message);
      return null;
    }
  }
}

// ─── Context info builder ─────────────────────────────────────────────────────

/**
 * Build a contextInfo object for enriched messages.
 *
 * @param {object} opts
 * @param {string} [opts.title]
 * @param {string} [opts.body]
 * @param {string} [opts.sourceUrl]
 * @param {Buffer} [opts.thumbnail]
 * @param {number} [opts.mediaType=1]   - 1=image, 2=video
 * @param {boolean} [opts.renderLarger=true]
 * @returns {object}
 */
export function generateContextInfo(opts = {}) {
  const info = {};
  if (opts.title || opts.body || opts.sourceUrl || opts.thumbnail) {
    info.externalAdReply = {
      title:                opts.title       || "",
      body:                 opts.body        || "",
      sourceUrl:            opts.sourceUrl   || "https://whatsapp.com",
      mediaType:            opts.mediaType   ?? 1,
      thumbnail:            opts.thumbnail   || null,
      renderLargerThumbnail: opts.renderLarger !== false,
      showAdAttribution:    false,
    };
  }
  if (opts.forwardingScore !== undefined) {
    info.forwardingScore = opts.forwardingScore;
    info.isForwarded     = opts.forwardingScore > 0;
  }
  if (opts.mentionedJid?.length) {
    info.mentionedJid = opts.mentionedJid;
  }
  return info;
}

/**
 * Build an externalAdReply contextInfo block.
 * Alias with a cleaner name.
 */
export function generateExternalAdReply(opts = {}) {
  return {
    externalAdReply: {
      title:                opts.title       || "",
      body:                 opts.body        || "",
      sourceUrl:            opts.sourceUrl   || "https://whatsapp.com",
      mediaType:            opts.mediaType   ?? 1,
      thumbnail:            opts.thumbnail   || null,
      renderLargerThumbnail: opts.renderLarger !== false,
      showAdAttribution:    false,
    },
  };
}

// ─── Internal: resolve a media source to a Buffer ─────────────────────────────

async function _resolveMediaBuffer(src) {
  if (!src) return null;
  if (Buffer.isBuffer(src)) return src;
  if (typeof src === "string" && (src.startsWith("http://") || src.startsWith("https://"))) {
    try {
      const { fetchBuffer } = await import("./uploadHandler.js");
      return await fetchBuffer(src);
    } catch { return null; }
  }
  if (typeof src === "string") {
    try {
      const { readFile } = await import("fs/promises");
      return await readFile(src);
    } catch { return null; }
  }
  return null;
}

// ─── Internal: build NativeFlowButton array ────────────────────────────────────

async function _buildNativeButtons(NF, buttons) {
  return Promise.all((buttons || []).map(async (btn, i) => {
    if (btn.url || btn.type === "url") {
      return NF.create({ name: "cta_url", buttonParamsJson: JSON.stringify({
        display_text: btn.text || `Link ${i + 1}`,
        url:          btn.url  || "",
        merchant_url: btn.url  || "",
      })});
    }
    if (btn.copyCode || btn.type === "copy") {
      return NF.create({ name: "cta_copy", buttonParamsJson: JSON.stringify({
        display_text: btn.text    || "Copy",
        copy_code:    btn.copyCode || btn.id || "",
      })});
    }
    if (btn.phone || btn.type === "call") {
      return NF.create({ name: "cta_call", buttonParamsJson: JSON.stringify({
        display_text: btn.text  || "Call",
        phone_number: btn.phone || "",
      })});
    }
    return NF.create({ name: "quick_reply", buttonParamsJson: JSON.stringify({
      display_text: btn.text || `Option ${i + 1}`,
      id:           btn.id   || String(i),
    })});
  }));
}

// ─── Internal: plain-text fallback ────────────────────────────────────────────

function _textFallbackInteractive(header, body, buttons, footer) {
  const btnLines = (buttons || []).map((b, i) => `[${i + 1}] ${b.text}`).join("\n");
  return [
    header ? `*${header}*` : null,
    body   || null,
    btnLines || null,
    footer ? `_${footer}_` : null,
  ].filter(Boolean).join("\n\n");
}

// ─── Internal: native-flow relay with regular-WhatsApp compatibility ─────────
// WHY THIS EXISTS (dead buttons on normal WhatsApp):
//   WhatsApp Business renders a bare `interactiveMessage` fine, but REGULAR
//   WhatsApp only treats native-flow buttons/lists as tappable when the
//   interactive payload rides inside a `viewOnceMessage` wrapper carrying
//   `messageContextInfo.deviceListMetadata`. Sent unwrapped, the buttons
//   render but every tap is a no-op — the "dead button" symptom. We send the
//   viewOnce-wrapped form FIRST (works on both regular WA and WA Business)
//   and fall back to the bare form if a client/server rejects the wrapper.
//
//   BUTTON_MODE=direct can be used for an old client that rejects the wrapper.
//   It is deliberately opt-in: the previous auto strategy sent the bare form
//   first, which made Android 11 look successful while producing dead taps.
function _nativeFlowUserJid(sock) {
  const raw = String(sock?.user?.id || "");
  const number = raw.split("@")[0].split(":")[0].replace(/\D/g, "");
  return number ? `${number}@s.whatsapp.net` : "";
}

function _nativeFlowOrder() {
  const mode = String(process.env.BUTTON_MODE || "auto").toLowerCase();
  if (mode === "direct") return ["direct", "viewonce"];
  if (mode === "viewonce") return ["viewonce", "direct"];
  // v30: "auto" now sends the DIRECT payload first. The viewonce envelope
  // rendered only for the command sender, so other members of the group saw
  // nothing at all. viewonce stays as the fallback for clients that reject
  // the bare interactive payload.
  return ["direct", "viewonce"];
}

async function _relayNativeFlow(sock, jid, interactiveMsg, quoted) {
  const B       = await getBaileys();
  const proto   = B.proto;
  const userJid = _nativeFlowUserJid(sock);
  const genOpts = {};
  if (userJid) genOpts.userJid = userJid;
  if (quoted) genOpts.quoted = quoted;

  const _mci = { deviceListMetadata: {}, deviceListMetadataVersion: 2 };
  const variants = {
    viewonce: { viewOnceMessage: { message: { messageContextInfo: _mci, interactiveMessage: interactiveMsg } } },
    direct: { messageContextInfo: _mci, interactiveMessage: interactiveMsg },
  };
  let lastErr = null;
  for (const mode of _nativeFlowOrder()) {
    try {
      const content = variants[mode];
      const full = proto.Message.create(content);
      const gen  = await B.generateWAMessageFromContent(jid, full, genOpts);
      const result = await sock.relayMessage(jid, gen.message, { messageId: gen.key.id });
      console.log(`[native-flow] relayed ${mode} payload to ${jid}`);
      return result;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("native-flow relay failed");
}

// ─── Interactive message (native-flow) ────────────────────────────────────────

/**
 * Send an interactive/native-flow message (text headers only).
 * For image/video headers use sendRichInteractive() instead.
 * Routes: GKTW → Baileys proto → plain text fallback.
 */
export async function sendInteractiveMessage(sock, jid, params) {
  const {
    body        = "",
    footer      = "",
    header      = "",
    buttons     = [],
    contextInfo = {},
    quoted      = null,
  } = params;

  // ── GKTW path ──────────────────────────────────────────────────────────────
  const gktw = await getGktw();
  if (gktw) {
    const mod = gktw.default || gktw;
    const fn  = mod?.sendInteractive || gktw.sendInteractive;
    if (typeof fn === "function") {
      try {
        return await fn(sock, jid, { body, footer, header, buttons, contextInfo, quoted });
      } catch {
        // fall through to Baileys proto
      }
    }
  }

  // ── Baileys proto path ─────────────────────────────────────────────────────
  try {
    const B     = await getBaileys();
    const proto = B.proto;
    const NF    = proto?.Message?.InteractiveMessage?.NativeFlowMessage?.NativeFlowButton;
    if (!NF) throw new Error("NativeFlowButton proto not available");

    const builtButtons   = await _buildNativeButtons(NF, buttons);
    const hasContextInfo = contextInfo && Object.keys(contextInfo).length > 0;

    const interactiveMsg = proto.Message.InteractiveMessage.create({
      body:   proto.Message.InteractiveMessage.Body.create({ text: body }),
      footer: proto.Message.InteractiveMessage.Footer.create({ text: footer }),
      header: proto.Message.InteractiveMessage.Header.create({
        title:              header,
        hasMediaAttachment: false,
      }),
      nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({
        buttons: builtButtons,
        messageParamsJson: JSON.stringify({}),
        messageVersion: 1,
      }),
      ...(hasContextInfo ? { contextInfo: proto.ContextInfo.create(contextInfo) } : {}),
    });

    // viewOnce-wrapped relay so buttons are tappable on REGULAR WhatsApp too
    return await _relayNativeFlow(sock, jid, interactiveMsg, quoted);
  } catch {
    // ── Plain-text fallback ────────────────────────────────────────────────────
    const text = _textFallbackInteractive(header, body, buttons, footer);
    const sendOpts = {};
    if (quoted) sendOpts.quoted = quoted;
    return sock.sendMessage(jid, { text }, sendOpts);
  }
}

/**
 * Send a RICH interactive message — image/video header + buttons + contextInfo
 * + externalAdReply + footer — ALL in ONE sendMessage() call.
 *
 * This is the correct way to send image+buttons together.
 * Sending them as two separate messages is the anti-pattern this fixes.
 *
 * Route priority:
 *   1. GKTW (if available) — most feature-rich
 *   2. Baileys proto with prepareWAMessageMedia image header
 *   3. Image-as-caption + buttons (two sends as graceful fallback)
 *   4. Plain text (last resort)
 *
 * @param {object} sock
 * @param {string} jid
 * @param {object} params
 * @param {string}        [params.header]       - Header title text
 * @param {string}        [params.body]         - Body text
 * @param {string}        [params.footer]       - Footer text
 * @param {Array}         [params.buttons]      - Button array
 * @param {Array}         [params.sections]     - List sections (switches to list mode)
 * @param {string}        [params.buttonText]   - Label for list-open button
 * @param {string}        [params.listTitle]    - Title for list
 * @param {Buffer|string} [params.image]        - Image for header (Buffer or URL)
 * @param {Buffer|string} [params.video]        - Video for header
 * @param {object}        [params.contextInfo]  - Full contextInfo object (for adReply etc.)
 * @param {object}        [params.quoted]       - WAMessage to quote
 * @param {string}        [params.type]         - "buttons" | "list"
 * @returns {Promise<object|null>}
 */
export async function sendRichInteractive(sock, jid, params) {
  const {
    header      = "",
    body        = "",
    footer      = "",
    buttons     = [],
    sections    = null,
    buttonText  = "Open",
    listTitle   = "",
    image       = null,
    video       = null,
    contextInfo = {},
    quoted      = null,
    type        = "buttons",
  } = params;

  const isListMode    = type === "list" || (sections && sections.length > 0);
  const hasContextInfo = contextInfo && Object.keys(contextInfo).length > 0;

  // ── GKTW path ──────────────────────────────────────────────────────────────
  const gktw = await getGktw();
  if (gktw) {
    const mod = gktw.default || gktw;

    // List mode via GKTW
    if (isListMode) {
      const listFn = mod?.sendList || gktw.sendList;
      if (typeof listFn === "function") {
        try {
          return await listFn(sock, jid, {
            body,
            buttonText,
            title:    listTitle || header,
            footer,
            sections: sections || [],
            quoted,
          });
        } catch {}
      }
    }

    // Button mode via GKTW sendInteractive
    const fn = mod?.sendInteractive || gktw.sendInteractive;
    if (typeof fn === "function") {
      try {
        return await fn(sock, jid, {
          body, footer, header, buttons, contextInfo, quoted, image, video,
        });
      } catch {}
    }
  }

  // ── Baileys proto path ─────────────────────────────────────────────────────
  try {
    const B     = await getBaileys();
    const proto = B.proto;

    // ── List message via Baileys proto ─────────────────────────────────────
    if (isListMode && sections?.length) {
      // ── Native-flow single_select FIRST ─────────────────────────────────
      // Legacy `listMessage` still renders but its open-button is DEAD on
      // current WhatsApp. interactiveMessage + single_select, viewOnce-wrapped,
      // is the only list that stays tappable on BOTH regular WA and Business.
      try {
        const _cl = (s) => String(s || "").replace(/[*_~`<>[\]›]/g, "").trim();
        const nfSecs = sections.map(sec => ({
          title: _cl(sec.title || "Menu").slice(0, 24) || "Menu",
          rows: (sec.rows || []).slice(0, 100).map(r => ({
            title:       _cl(r.title || "Option").slice(0, 72) || "Option",
            description: _cl(r.description || "").slice(0, 96),
            id:          String(r.id || r.rowId || r.title || "row").slice(0, 256),
          })),
        })).filter(sec => sec.rows.length);
        if (!nfSecs.length) throw new Error("no rows");
        const nfIM = proto.Message.InteractiveMessage.create({
          body:   proto.Message.InteractiveMessage.Body.create({ text: body || " " }),
          footer: proto.Message.InteractiveMessage.Footer.create({ text: _cl(footer) }),
          header: proto.Message.InteractiveMessage.Header.create({
            hasMediaAttachment: false,
            ...((listTitle || header) ? { title: _cl(listTitle || header).slice(0, 60) } : {}),
          }),
          nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({
            buttons: [{ name: "single_select", buttonParamsJson: JSON.stringify({
              title: _cl(buttonText || "Open").slice(0, 24) || "Open", sections: nfSecs }) }],
            messageParamsJson: JSON.stringify({}),
            messageVersion: 1,
          }),
          ...(hasContextInfo ? { contextInfo: proto.ContextInfo.create(contextInfo) } : {}),
        });
        return await _relayNativeFlow(sock, jid, nfIM, quoted);
      } catch {}
      try {
        const rows = sections.flatMap(s =>
          (s.rows || []).map(r =>
            proto.Message.ListMessage.Row.create({
              rowId:       r.id,
              title:       r.title,
              description: r.description || "",
            })
          )
        );

        const listMsg = {
          list: {
            title:       listTitle || header,
            description: body,
            buttonText:  buttonText,
            listType:    proto.Message.ListMessage.ListType.SINGLE_SELECT,
            sections:    sections.map(s => ({
              title: s.title,
              rows:  (s.rows || []).map(r => ({
                rowId:       r.id,
                title:       r.title,
                description: r.description || "",
              })),
            })),
            footer: footer,
          },
        };
        if (hasContextInfo) listMsg.contextInfo = contextInfo;

        const sendOpts = {};
        if (quoted) sendOpts.quoted = quoted;
        return await sock.sendMessage(jid, listMsg, sendOpts);
      } catch {}
    }

    // ── Button message via Baileys proto + optional image/video header ─────
    const NF = proto?.Message?.InteractiveMessage?.NativeFlowMessage?.NativeFlowButton;
    if (!NF) throw new Error("NativeFlowButton proto not available");

    const builtButtons = await _buildNativeButtons(NF, buttons);

    // Build the header — with or without media
    let headerProto;
    const mediaSrc  = video || image;
    const isVideo   = !!video && !image;

    if (mediaSrc) {
      const mediaBuf = await _resolveMediaBuffer(mediaSrc);
      if (mediaBuf) {
        try {
          // Upload the media so WhatsApp can serve it
          const mediaPayload = isVideo
            ? { video:    mediaBuf, mimetype: "video/mp4" }
            : { image:    mediaBuf, mimetype: "image/jpeg" };

          const prepared = await B.prepareWAMessageMedia(mediaPayload, {
            upload: sock.waUploadToServer,
          });

          if (isVideo && prepared.videoMessage) {
            headerProto = proto.Message.InteractiveMessage.Header.create({
              title:              header,
              videoMessage:       proto.Message.VideoMessage.create(prepared.videoMessage),
              hasMediaAttachment: true,
            });
          } else if (!isVideo && prepared.imageMessage) {
            headerProto = proto.Message.InteractiveMessage.Header.create({
              title:              header,
              imageMessage:       proto.Message.ImageMessage.create(prepared.imageMessage),
              hasMediaAttachment: true,
            });
          }
        } catch {
          // Media upload failed — fall back to text header
        }
      }
    }

    if (!headerProto) {
      headerProto = proto.Message.InteractiveMessage.Header.create({
        title:              header,
        hasMediaAttachment: false,
      });
    }

    const interactiveMsg = proto.Message.InteractiveMessage.create({
      body:   proto.Message.InteractiveMessage.Body.create({ text: body }),
      footer: proto.Message.InteractiveMessage.Footer.create({ text: footer }),
      header: headerProto,
      nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({
        buttons: builtButtons,
        messageParamsJson: JSON.stringify({}),
        messageVersion: 1,
      }),
      ...(hasContextInfo ? { contextInfo: proto.ContextInfo.create(contextInfo) } : {}),
    });

    // viewOnce-wrapped relay so buttons are tappable on REGULAR WhatsApp too
    return await _relayNativeFlow(sock, jid, interactiveMsg, quoted);

  } catch {
    // ── Graceful degradation: image+caption then buttons (two sends) ──────
    if (image || video) {
      try {
        const mediaBuf = await _resolveMediaBuffer(image || video);
        if (mediaBuf) {
          const mediaContent = image
            ? { image: mediaBuf, caption: body || header, mimetype: "image/jpeg" }
            : { video: mediaBuf, caption: body || header, mimetype: "video/mp4"  };

          if (hasContextInfo) mediaContent.contextInfo = contextInfo;

          const mediaOpts = {};
          if (quoted) mediaOpts.quoted = quoted;
          await sock.sendMessage(jid, mediaContent, mediaOpts);

          // Now send buttons separately (best we can do in degraded mode)
          if (buttons.length) {
            const btnText = _textFallbackInteractive("", body, buttons, footer);
            await sock.sendMessage(jid, { text: btnText }, {});
          }
          return;
        }
      } catch {}
    }

    // ── Last resort: plain text ────────────────────────────────────────────
    const text = _textFallbackInteractive(header, body, buttons, footer);
    const sendOpts = {};
    if (quoted) sendOpts.quoted = quoted;
    return sock.sendMessage(jid, { text }, sendOpts);
  }
}

// ─── Baileys version ──────────────────────────────────────────────────────────

export async function fetchLatestBaileysVersion() {
  try {
    const B = await getBaileys();
    if (typeof B.fetchLatestBaileysVersion === "function") return B.fetchLatestBaileysVersion();
    if (typeof B.fetchLatestWaWebVersion === "function") return B.fetchLatestWaWebVersion();
  } catch {}
  return { version: [2, 3000, 1043857760], isLatest: false };
}

// ─── Store / socket helpers ───────────────────────────────────────────────────

export async function makeInMemoryStore(opts) {
  const B = await getBaileys();
  if (typeof B.makeInMemoryStore === "function") return B.makeInMemoryStore(opts);
  return null;
}

export async function useMultiFileAuthState(folder) {
  const B = await getBaileys();
  return B.useMultiFileAuthState(folder);
}

export async function makeWASocket(config) {
  const B = await getBaileys();
  return B.makeWASocket(config);
}

// ─── Export raw loaders for adapters that need them ──────────────────────────
export { getGktw };
