/**
 * The message object a Levanter plugin handler receives, after Levanter's
 * lib/class/Message.js (every method, same argument order and defaults).
 * Copyright (c) lyfe00011, MIT License (see LICENSE-LEVANTER.txt).
 * Methods call the Baileys socket directly. `host.baileys` supplies
 * generateWAMessageFromContent and proto from the bot's own Baileys import.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { matchesEvent } from "./dispatchRules.js";
import { LANG, sleep } from "./libShim.js";

// exact: lib/constant.js TEMP_DIR is "<bot root>/temp". MIAS's bot root is mias/ (same as libShim).
const REPLY_TEMP_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../temp");

/** Levanter's maximum file size in MB (its default; capped at 1998 in Message.js). */
export const MAX_FILE_MB = 230;

const normalizeJid = (id) => String(id || "").replace(/:\d+@/, "@");
const jidDigits = (jid) => String(jid || "").split("@")[0].split(":")[0].replace(/\D/g, "");
const isUserJid = (jid) => /@(s\.whatsapp\.net|lid)$/.test(String(jid || ""));

/** The most members one plugin call may remove. Levanter's gists can match every member, so this stops a mass removal. */
export const MAX_KICK_PER_CALL = 10;

/** A plugin message that reports a failure (❌, ⚠️, "Error ...", "I'm not admin"). The runner reacts ❌ for it. */
const FAILURE_TEXT = /^\s*[_*~]*\s*(?:❌|⚠️|🚫|error\b|failed\b|unable\b|couldn'?t\b|can'?t\b|cannot\b|i'?m not admin\b|i am not admin\b|no (?:matching|member|user|group member)\b)/i;

/** The phone-number JID of a group member (WhatsApp's phoneNumber field), or "" when it has none. */
const phoneJidOf = (p) => {
  const pn = p?.phoneNumber || p?.pn;
  if (!pn) return "";
  const s = String(pn);
  return s.includes("@") ? normalizeJid(s) : `${s.replace(/\D/g, "")}@s.whatsapp.net`;
};

// The media object inside a message wrapper (e.g. { documentMessage: {...} }), or undefined.
function mediaOf(content) {
  if (!content || typeof content !== "object") return undefined;
  return Object.values(content).find((v) => v && typeof v === "object" && typeof v.mimetype === "string");
}

export function contentOf(message) {
  if (!message) return null;
  if (message.ephemeralMessage) return contentOf(message.ephemeralMessage.message);
  if (message.viewOnceMessage) return contentOf(message.viewOnceMessage.message);
  if (message.viewOnceMessageV2) return contentOf(message.viewOnceMessageV2.message);
  return message;
}

function contextInfoOf(content) {
  if (!content) return null;
  for (const key of Object.keys(content)) {
    const ci = content[key]?.contextInfo;
    if (ci) return ci;
  }
  return null;
}

function textOfContent(content) {
  if (!content) return "";
  return content.conversation
    || content.extendedTextMessage?.text
    || content.imageMessage?.caption
    || content.videoMessage?.caption
    || content.documentMessage?.caption
    || "";
}

function typeOfContent(content) {
  return content ? Object.keys(content)[0] || "" : "";
}

/**
 * Levanter's ReplyMessage flags (lib/class/ReplyMessage.js, decoded): a plugin checks
 * `message.reply_message.image`, `.video`, `.audio`, `.sticker`, `.pdf` or `.txt` to decide
 * what was quoted. Same rules as Levanter: documents are classified by their mimetype.
 */
function replyFlagsOf(content, type, mimetype = "") {
  const msg = content?.[type] || {};
  const flags = { text: "", txt: false, image: false, video: false, audio: false, sticker: false, pdf: false, ptt: false };
  switch (type) {
    case "imageMessage":
      Object.assign(flags, { text: msg.caption || "", image: true, width: msg.width, height: msg.height });
      break;
    case "videoMessage":
      Object.assign(flags, { text: msg.caption || "", video: true, ptt: true, seconds: msg.seconds, width: msg.width, height: msg.height });
      break;
    case "stickerMessage":
      Object.assign(flags, { sticker: true, animated: msg.isAnimated });
      break;
    case "audioMessage":
      Object.assign(flags, { audio: true, ptt: msg.ptt, seconds: msg.seconds });
      break;
    case "documentMessage":
      Object.assign(flags, {
        text: msg.caption || "",
        image: /image/.test(mimetype) && !/image\/gif/.test(mimetype),
        video: /video/.test(mimetype) || /image\/gif/.test(mimetype),
        audio: /audio/.test(mimetype),
        pdf: /application\/pdf/.test(mimetype),
      });
      break;
    case "conversation":
      Object.assign(flags, { text: content.conversation || "", txt: true });
      break;
    case "extendedTextMessage":
      Object.assign(flags, { text: msg.text || "", txt: true });
      break;
    default:
      flags.text = textOfContent(content);
  }
  return flags;
}

/** Levanter copies a message through protobuf encode/decode before relaying it. */
function protoCopy(baileys, message) {
  const proto = baileys?.proto;
  if (!proto?.Message) return message;
  return proto.Message.decode(proto.Message.encode(message).finish());
}

/**
 * @param {object} args
 * @param {object} args.sock     Baileys socket
 * @param {object} args.msg      the WhatsApp message
 * @param {string} args.session  Levanter's session id
 * @param {string} args.text     the message text
 * @param {object} args.host     { httpGet, getSender, baileys }
 */
export function createMessage({ sock, msg, session, text, host = {}, textFilter = null, track = null }) {
  const jid = msg?.key?.remoteJid || "";
  // The runner reads track.failed to choose its reaction: a failed action or a failure message sets it,
  // even when the plugin catches the error itself.
  const note = () => { if (track) track.failed = true; };
  const group = jid.endsWith("@g.us");
  const content = contentOf(msg?.message);
  const ci = contextInfoOf(content);
  const quotedContent = contentOf(ci?.quotedMessage);
  const quoted = ci?.quotedMessage
    ? {
        key: { remoteJid: jid, fromMe: false, id: ci.stanzaId, participant: ci.participant },
        message: ci.quotedMessage,
      }
    : undefined;
  // Media type of the quoted message, unwrapped the same way Levanter reads it (see replyFlagsOf).
  const quotedType = typeOfContent(quotedContent);
  const quotedMimetype = mediaOf(quotedContent)?.mimetype || quotedContent?.[quotedType]?.mimetype || "";
  const quotedFlags = quoted ? replyFlagsOf(quotedContent, quotedType, quotedMimetype) : {};

  const call = async (name, ...args) => {
    if (typeof sock?.[name] !== "function") {
      note();
      throw new Error(`message.${name}() is not supported by this WhatsApp connection.`);
    }
    try {
      return await sock[name](...args);
    } catch (error) {
      note();
      throw error;
    }
  };
  const me = () => normalizeJid(sock?.user?.id);
  const httpGet = host.httpGet;
  const baileys = host.baileys;

  async function send(content, opts = {}, type = "text", target = jid) {
    const options = opts || {};
    let payload;
    if (type === "react") {
      payload = { react: { text: String(content), key: options.key || msg.key } };
    } else if (type === "delete") {
      payload = { delete: options.key || msg.key };
    } else if (type === "text") {
      payload = typeof content === "string" ? { text: content } : { ...content };
    } else if (["image", "video", "audio", "document", "sticker"].includes(type)) {
      payload = { [type]: content };
      if (options.caption !== undefined) payload.caption = options.caption;
      if (options.mimetype) payload.mimetype = options.mimetype;
      if (options.fileName) payload.fileName = options.fileName;
      if (options.ptt !== undefined) payload.ptt = options.ptt;
      if (options.gifPlayback) payload.gifPlayback = true;
      if (options.mentions) payload.mentions = options.mentions;
    } else {
      throw new Error(`message.send(): unknown type "${type}".`);
    }
    if (type === "text" && typeof textFilter === "function" && typeof payload.text === "string") {
      payload.text = textFilter(payload.text);
    }
    if (type === "text" && typeof payload.text === "string") {
      if (!payload.text.trim()) {
        note();
        throw new Error("the plugin tried to send an empty message.");
      }
      if (FAILURE_TEXT.test(payload.text)) note();
    }
    const sendOpts = options.quoted ? { quoted: options.quoted } : undefined;
    return sock.sendMessage(target, payload, sendOpts);
  }

  async function sendFromUrl(urls, opts = {}) {
    if (typeof httpGet !== "function") throw new Error("sendFromUrl: no HTTP client");
    const list = Array.isArray(urls) ? urls : [urls];
    for (const url of list) {
      const res = await httpGet(String(url), { responseType: "arraybuffer", timeout: 30000 });
      const buffer = Buffer.from(res.data);
      const mime = String(res.headers?.["content-type"] || "").split(";")[0].trim();
      const kind = mime.startsWith("image/") ? "image"
        : mime.startsWith("video/") ? "video"
        : mime.startsWith("audio/") ? "audio" : "document";
      const fileName = opts.fileName || String(url).split("/").pop()?.split("?")[0] || "file";
      const extra = kind === "audio" ? { mimetype: mime || "audio/mpeg", ptt: false }
        : kind === "video" ? { mimetype: mime || "video/mp4" }
        : kind === "document" ? { mimetype: mime || "application/octet-stream", fileName }
        : { mimetype: mime || undefined };
      await send(buffer, { ...opts, ...extra }, kind);
    }
  }

  /** Levanter's forSend: sends a URL, buffer or text, choosing the WhatsApp type from its MIME type. */
  async function forSend(source, opts = {}) {
    const options = { ...(opts || {}), quoted: msg };
    let buffer = null;
    let mimetype;
    let name;
    if (Buffer.isBuffer(source)) {
      buffer = source;
      name = "file";
    } else if (typeof source === "string" && /^https?:\/\//i.test(source)) {
      try {
        const res = await httpGet(source, { responseType: "arraybuffer", timeout: 30000 });
        buffer = Buffer.from(res.data);
        mimetype = String(res.headers?.["content-type"] || "").split(";")[0].trim() || undefined;
        name = String(source).split("/").pop()?.split("?")[0] || "file";
      } catch (error) {
        return send(error.message, options);
      }
    } else {
      return send(source, options);
    }
    const sizeMb = buffer.length / (1024 * 1024);
    if (sizeMb > MAX_FILE_MB) {
      return send(LANG.extra.file_size_error.format(`${sizeMb.toFixed(2)} MB`, source), options);
    }
    let kind = mimetype?.split("/")[0];
    if (sizeMb > 80) kind = "document";
    const sub = mimetype?.split("/")[1];
    if (sub === "webp") kind = "sticker";
    if (sub === "gif") kind = "gif";
    switch (kind) {
      case "sticker":
        return send(buffer, { ...options, mimetype, fileName: name }, "sticker");
      case "image":
      case "audio":
        return send(buffer, { ...options, fileName: name, mimetype }, kind);
      case "video":
        return send(buffer, { ...options, fileName: name, mimetype: "video/mp4" }, "video");
      case "gif":
        return send(buffer, { ...options, mimetype: "video/mp4", gifPlayback: true }, "video");
      default:
        return send(buffer, { ...options, mimetype, fileName: name }, "document");
    }
  }

  // Groups in LID mode list members by LID. Levanter's plugins match a member by the start of its
  // phone-number id (kik does `user.id.startsWith(number)`), so the phone JID becomes the id. The
  // original id is kept as rawId: removals use it, so WhatsApp receives the id it knows.
  const toMembers = (meta) => (Array.isArray(meta?.participants) ? meta.participants.map((p) => {
    const pn = phoneJidOf(p);
    const id = pn || p.id;
    return { ...p, id, rawId: p.id, ...(pn && pn !== p.id ? { lid: p.lid || p.id } : {}) };
  }) : []);

  async function groupMetadata(target = jid) {
    const meta = (await call("groupMetadata", target)) || {};
    const participants = toMembers(meta);
    for (const key of Object.keys(meta)) {
      if (key !== "participants") participants[key] = meta[key];
    }
    return participants;
  }

  async function Kick(users, target = jid) {
    const list = (Array.isArray(users) ? users : [users]).filter(Boolean);
    if (!list.length) {
      note();
      throw new Error("no group member matches that number.");
    }
    // Member data is read when the socket can give it. Without it, the ids are removed as given.
    let members = null;
    if (typeof sock?.groupMetadata === "function") {
      try { members = toMembers(await sock.groupMetadata(target)); } catch { members = null; }
      if (members && !members.length) members = null;
    }
    const same = (a, b) => !!a && !!b && jidDigits(a) === jidDigits(b);
    const removals = [];
    for (const user of list) {
      if (jidDigits(user) === jidDigits(me())) continue;
      let id = user;
      if (members) {
        const hit = members.find((p) => p.id === user || p.rawId === user || same(p.id, user) || same(p.phoneNumber, user));
        if (!hit) {
          note();
          throw new Error(`${jidDigits(user)} is not a member of this group.`);
        }
        id = hit.rawId || hit.id;
      }
      if (!removals.includes(id)) removals.push(id);
    }
    if (removals.length > MAX_KICK_PER_CALL) {
      note();
      throw new Error(`refused to remove ${removals.length} members in one command (the limit is ${MAX_KICK_PER_CALL}). Use .kickall for a bulk removal.`);
    }
    for (const id of removals) {
      await call("groupParticipantsUpdate", target, [id], "remove");
      await sleep(666 + Math.floor(1000 * Math.random()));
    }
  }

  const members = (action) => async (users, target = jid) => {
    const list = Array.isArray(users) ? users : [users];
    return call("groupParticipantsUpdate", target, list, action);
  };

  /** Levanter setStatus(quotedMessage, jids, 'contact' | 'list'). Returns the number of recipients. */
  async function setStatus(quotedMsg, jids, type = "contact") {
    const contacts = Object.keys(sock?.store?.contacts || {}).filter(isUserJid);
    const list = type === "contact" ? contacts : (Array.isArray(jids) ? jids : []).filter(isUserJid);
    const self = me();
    if (list.length === 0 || (list.length === 1 && list.includes(self))) {
      throw new Error(type !== "contact" ? LANG.extra.missing_jid : LANG.extra.no_contacts);
    }
    const inner = quotedMsg?.reply_message?.message?.message;
    if (!inner) throw new Error("setStatus: reply to the message you want to post as a status.");
    const built = baileys?.generateWAMessageFromContent
      ? baileys.generateWAMessageFromContent("status@broadcast", protoCopy(baileys, inner), { userJid: sock.user.id })
      : null;
    if (!built) throw new Error("setStatus is not available: the Baileys helpers were not provided.");
    await sock.relayMessage("status@broadcast", built.message, {
      messageId: built.key.id,
      additionalAttributes: {},
      statusJidList: [self, ...list],
    });
    return list.length;
  }

  /** Levanter groupStatus(quotedMessage, groupJid): posts a quoted message as a group status. */
  async function groupStatus(quotedMsg, target = jid) {
    const inner = quotedMsg?.reply_message?.message?.message;
    if (!inner) throw new Error("groupStatus: reply to the message you want to post.");
    if (!baileys?.generateWAMessageFromContent) throw new Error("groupStatus is not available: the Baileys helpers were not provided.");
    const secret = randomBytes(32);
    const built = baileys.generateWAMessageFromContent(target, {
      messageContextInfo: { messageSecret: secret },
      groupStatusMessageV2: {
        message: { ...protoCopy(baileys, inner), messageContextInfo: { messageSecret: secret } },
      },
    }, {});
    await sock.relayMessage(target, built.message, { messageId: built.key.id });
    return built;
  }

  /** Levanter newsletterReactMessage(channelInvite, serverId, reaction). */
  async function newsletterReactMessage(channelInvite, serverId, reaction) {
    const meta = await getChannelMetadata(channelInvite);
    const codes = meta?.thread_metadata?.settings?.reaction_codes?.value;
    if (codes === "NONE") throw new Error(LANG.extra.reaction_not_enabled);
    if (codes === "BASIC" && !["👍", "❤️", "😂", "😮", "😢", "🙏"].includes(reaction)) {
      throw new Error(LANG.extra.reaction_not_allowed);
    }
    return call("newsletterReactMessage", meta.id, serverId, reaction);
  }

  async function getChannelMetadata(invite) {
    return call("newsletterMetadata", "invite", invite);
  }

  const sender = host.getSender ? host.getSender(msg) : msg?.key?.participant || jid;
  const message = {
    id: String(session),
    jid,
    isGroup: group,
    sender,
    participant: msg?.key?.participant || (group ? undefined : jid),
    pushName: msg?.pushName,
    fromMe: !!msg?.key?.fromMe,
    // Levanter's `sudo`: the bot's own messages, the owner, and the SUDO numbers.
    sudo: !!msg?.key?.fromMe || !!(host.isSudo && host.isSudo(sender)),
    text: String(text ?? ""),
    type: typeOfContent(content),
    message: msg?.message ? { key: msg.key, message: msg.message } : quoted,
    data: msg,
    quoted,
    forwarded: !!ci?.isForwarded,
    messageTimestamp: msg?.messageTimestamp,
    mention: Array.isArray(ci?.mentionedJid) && ci.mentionedJid.length ? ci.mentionedJid : false,
    // Levanter returns a Message for the quoted content, or false.
    reply_message: quoted
      ? {
          // Levanter: id is the quoted message's own id (u.key.id).
          id: String(ci?.stanzaId || session),
          // Levanter: the quoted message's sender (the person a reply is about), and its key.
          jid: ci?.participant || jid,
          key: quoted.key,
          isGroup: group,
          type: quotedType,
          participant: ci?.participant,
          mimetype: quotedMimetype,
          ...quotedFlags,
          message: quoted,
          data: quoted,
          // Levanter's reply_message.downloadMediaMessage(): the quoted media as a Buffer.
          async downloadMediaMessage() {
            if (typeof baileys?.downloadMediaMessage !== "function") {
              throw new Error("downloadMediaMessage is not available: the Baileys helpers were not provided.");
            }
            return baileys.downloadMediaMessage(quoted, "buffer", {}, {
              reuploadRequest: (m) => sock.updateMediaMessage(m),
            });
          },
          // Levanter's reply_message.downloadAndSaveMediaMessage(name): saves the quoted media to
          // <bot>/temp/<name>.<ext> (ext from its mimetype) and resolves to that path.
          async downloadAndSaveMediaMessage(name = "file") {
            const reply = this;
            const buffer = await reply.downloadMediaMessage();
            const ext = String(reply.mimetype || "").split(";")[0].split("/")[1] || "bin";
            await fs.mkdir(REPLY_TEMP_DIR, { recursive: true });
            const file = path.join(REPLY_TEMP_DIR, `${name}.${ext}`);
            await fs.writeFile(file, buffer);
            return file;
          },
        }
      : false,
    client: new Proxy(sock || {}, {
      get(target, prop) {
        if (prop === "user" && target.user) return { ...target.user, jid: normalizeJid(target.user.id) };
        if (prop === "Kick") return (users, to) => Kick(users, to);
        const value = target[prop];
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
    send,
    sendFromUrl,
    forSend,
    groupMetadata,
    // Not in Levanter's Message class; a Gist calls it, so it is a plain alias of send().
    async sendMessage(content, opts = {}, type = "text", target = jid) {
      return send(content, opts, type, target);
    },
    async getGids() {
      return call("groupFetchAllParticipating");
    },
    Kick,
    Add: members("add"),
    Promote: members("promote"),
    Demote: members("demote"),
    async Block(target) { return call("updateBlockStatus", target, "block"); },
    async Unblock(target) { return call("updateBlockStatus", target, "unblock"); },
    async onWhatsapp(...numbers) { return call("onWhatsapp", ...numbers.flat()); },
    async fetchStatus(target) { return call("fetchStatus", target); },
    async profilePictureUrl(target, type = "image") { return call("profilePictureUrl", target, type); },
    async updateProfilePicture(target, buffer) { return call("updateProfilePicture", target, buffer); },
    async revokeInvite(target = jid) { return call("groupRevokeInvite", target); },
    async acceptInvite(code) { return call("groupAcceptInvite", code); },
    async infoInvite(code) { return call("groupGetInviteInfo", code); },
    async inviteCode(target = jid) { return call("groupInviteCode", target); },
    async leftFromGroup(target = jid) { return call("groupLeave", target); },
    async GroupSettingsChange(target, setting) { return call("groupSettingUpdate", target, setting); },
    setStatus,
    groupStatus,
    async groupRequestList(target = jid) { return call("groupRequestParticipantsList", target || jid); },
    async groupRequestAction(users, action, target = jid) {
      if (!users || !users.length) throw new Error("missing participants");
      for (const user of users) {
        await call("groupRequestParticipantsUpdate", target || jid, [user], action);
        await sleep(500);
      }
    },
    newsletterReactMessage,
    getChannelMetadata,
    async clearChat(target = jid) {
      return call("chatModify", {
        delete: true,
        lastMessages: [{ key: msg.key, messageTimestamp: msg.messageTimestamp }],
      }, target);
    },
  };
  return message;
}

export { matchesEvent };
