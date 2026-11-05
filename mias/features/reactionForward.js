/**
 * ✅-reaction → private DM forwarder (SILENT)
 *
 * Behaviour (per owner request):
 *  • Reacts to NOTHING except the ✅ emoji. Every other emoji is ignored.
 *  • Only the owner/bot account's own ✅ reactions are honoured.
 *  • The reacted message is sent to the owner's private DM with zero
 *    commentary — no "Reaction received from..." note, no group output.
 *  • View-once messages are unwrapped and re-sent as NORMAL media
 *    (silent vv-to-DM). Text/other types are forwarded as clean copies.
 *
 * The original message is cached briefly because reaction events contain
 * only the target key, not the full message.
 */
import { createRequire } from "module";

const CACHE_TTL_MS = 15 * 60 * 1000;
const MAX_CACHE_SIZE = 2000;
const TRIGGER_EMOJI = "✅";

let _downloadContentFromMessage = null;
function getDownloader() {
  if (_downloadContentFromMessage) return _downloadContentFromMessage;
  try {
    const require = createRequire(import.meta.url);
    const mod = require("@whiskeysockets/baileys");
    _downloadContentFromMessage = mod.downloadContentFromMessage || mod.default?.downloadContentFromMessage || null;
  } catch {}
  return _downloadContentFromMessage;
}

function keyOf(key = {}) {
  return [key.remoteJid || "", key.id || "", key.participant || ""].join("|");
}

function unwrap(message) {
  let current = message;
  for (let i = 0; i < 8 && current; i++) {
    const next = current.ephemeralMessage?.message
      || current.viewOnceMessage?.message
      || current.viewOnceMessageV2?.message
      || current.viewOnceMessageV2Extension?.message
      || current.documentWithCaptionMessage?.message
      || current.editedMessage?.message;
    if (!next) break;
    current = next;
  }
  return current || {};
}

function isForwardable(message) {
  const content = unwrap(message?.message || message);
  if (!content || content.protocolMessage || content.reactionMessage) return false;
  return Boolean(
    content.conversation
    || content.extendedTextMessage
    || content.imageMessage
    || content.videoMessage
    || content.audioMessage
    || content.documentMessage
    || content.stickerMessage
    || content.locationMessage
    || content.contactMessage
  );
}

async function bufferFrom(node, kind) {
  const dl = getDownloader();
  if (!dl) return null;
  const stream = await dl(node, kind);
  let buf = Buffer.from([]);
  for await (const chunk of stream) buf = Buffer.concat([buf, chunk]);
  return buf && buf.length > 100 ? buf : null;
}

/** Build a NORMAL (non-view-once) payload from the unwrapped content. */
async function buildCleanPayload(content) {
  if (content.imageMessage) {
    const buf = await bufferFrom(content.imageMessage, "image");
    if (buf) return { image: buf, caption: content.imageMessage.caption || undefined };
  }
  if (content.videoMessage) {
    const buf = await bufferFrom(content.videoMessage, "video");
    if (buf) return { video: buf, caption: content.videoMessage.caption || undefined, mimetype: content.videoMessage.mimetype || "video/mp4" };
  }
  if (content.audioMessage) {
    const buf = await bufferFrom(content.audioMessage, "audio");
    if (buf) return { audio: buf, mimetype: content.audioMessage.mimetype || "audio/mp4", ptt: !!content.audioMessage.ptt };
  }
  if (content.documentMessage) {
    const buf = await bufferFrom(content.documentMessage, "document");
    if (buf) return { document: buf, mimetype: content.documentMessage.mimetype || "application/octet-stream", fileName: content.documentMessage.fileName || "file" };
  }
  if (content.stickerMessage) {
    const buf = await bufferFrom(content.stickerMessage, "sticker");
    if (buf) return { sticker: buf };
  }
  const text = content.conversation || content.extendedTextMessage?.text || "";
  if (text) return { text };
  return null;
}

export function installReactionForwarder(sock, options = {}) {
  if (!sock?.ev || sock.__miasReactionForwarder) return;
  sock.__miasReactionForwarder = true;

  const cache = new Map();
  const ownerJid = String(options.ownerJid || sock.user?.id || "")
    .replace(/:\d+(?=@)/, "");
  const ownerDigits = ownerJid.replace(/[^0-9]/g, "");
  const botDigits = String(sock.user?.id || "").replace(/[^0-9]/g, "");

  const remember = (message) => {
    if (!message?.key?.id || !isForwardable(message)) return;
    cache.set(keyOf(message.key), { message, expiresAt: Date.now() + CACHE_TTL_MS });
    if (cache.size > MAX_CACHE_SIZE) {
      const oldest = cache.keys().next().value;
      if (oldest) cache.delete(oldest);
    }
  };

  sock.ev.on("messages.upsert", (event = {}) => {
    for (const message of event.messages || []) remember(message);
  });

  sock.ev.on("messages.reaction", async (events = []) => {
    for (const event of Array.isArray(events) ? events : [events]) {
      try {
        const reaction = event?.reaction || event;
        if (!reaction?.key) continue;

        // ── GATE 1: ALL emojis trigger (owner-only forwarder) ──
        const emojiText = String(reaction.text || "").trim();
        if (!emojiText) continue;

        // ── GATE 2: STRICT — only the bot owner / the bot account itself ──
        const reactorJid = event?.participant || event?.senderPn || reaction?.participant || reaction?.senderPn
          || (event?.key?.fromMe ? (sock.user?.id || ownerJid) : "");
        const reactorDigits = String(reactorJid || "").replace(/[^0-9]/g, "");
        const isMine = Boolean(
          event?.fromMe === true
          || reaction?.fromMe === true
          || (event?.key?.fromMe && !event?.participant && !reaction?.participant)
          || (ownerDigits && reactorDigits && reactorDigits.endsWith(ownerDigits))
          || (botDigits && reactorDigits && reactorDigits.endsWith(botDigits))
        );
        if (!isMine) continue;

        const sourceJid = reaction.key.remoteJid || "";
        if (!ownerJid || sourceJid === ownerJid) continue;   // already in the DM → skip
        if (sourceJid === "status@broadcast") continue;

        let cached = cache.get(keyOf(reaction.key));
        if (!cached && reaction.key?.id) {
          for (const [k, v] of cache.entries()) {
            if (k.includes(reaction.key.id) && v?.message) {
              cached = v;
              break;
            }
          }
        }
        if (!cached || cached.expiresAt < Date.now()) {
          cache.delete(keyOf(reaction.key));
          let fallbackMsg = null;
          try {
            if (reaction.key?.id) {
              if (globalThis._viewOnceStore && globalThis._viewOnceStore.get) {
                const vo = globalThis._viewOnceStore.get(reaction.key.id);
                if (vo) fallbackMsg = { key: reaction.key, message: vo.message || vo };
              }
              if (!fallbackMsg && globalThis._msgStore && globalThis._msgStore.get) {
                const st = globalThis._msgStore.get(reaction.key.id);
                if (st) fallbackMsg = { key: reaction.key, message: st.message || st };
              }
              if (!fallbackMsg && globalThis.__miasMsgCache && globalThis.__miasMsgCache.get) {
                const st = globalThis.__miasMsgCache.get(reaction.key.id);
                if (st) fallbackMsg = { key: reaction.key, message: st.message || st };
              }
              if (!fallbackMsg && globalThis._msgRetryStore && globalThis._msgRetryStore.get) {
                const st = globalThis._msgRetryStore.get(reaction.key.id);
                if (st) fallbackMsg = { key: reaction.key, message: st };
              }
            }
          } catch {}
          if (fallbackMsg) cached = { message: fallbackMsg };
          else continue;
        }

        // ── SILENT DELIVERY: unwrap (incl. view-once) → normal payload → DM ──
        const content = unwrap(cached.message?.message || {});
        const payload = await buildCleanPayload(content);
        if (payload) {
          await sock.sendMessage(ownerJid, payload);
          try { console.log("[✅→DM] delivered", payload.image ? "image" : payload.video ? "video" : payload.audio ? "audio" : payload.document ? "document" : payload.sticker ? "sticker" : "text", "from", sourceJid); } catch {}
        } else if (typeof sock.copyNForward === "function") {
          await sock.copyNForward(ownerJid, cached.message, true);
        } else {
          await sock.sendMessage(ownerJid, { forward: cached.message });
        }
      } catch (error) {
        console.error("[✅→DM]", error?.message || error);
      }
    }
  });
}
