/**
 * MIAS — Baileys Handler (Universal API / Main Abstraction Layer)  v4
 *
 * ════════════════════════════════════════════════════════════════
 *  Architecture:
 *
 *  Commands
 *       ↓
 *  MIAS Handlers  ← (this file is the single import point)
 *       ↓
 *  Baileys Adapter  (baileysHandler.js routes to gktwAdapter.js)
 *       ↓
 *  GKTW Helper  (auto-detected, falls back to Baileys if absent)
 *       ↓
 *  WhatsApp
 * ════════════════════════════════════════════════════════════════
 *
 * ONLY import from this file. Never import Baileys or GKTW directly in commands.
 * Every handler function lives in a sibling file; this module re-exports them
 * all under one roof so commands only need one import:
 *
 *   import * as MIAS from "../handlers/baileysHandler.js";
 *
 * v4 additions:
 *  - Re-exports: uiHandler, menuConfig, eventHooks, capabilityHandler
 *  - Re-exports: gktwVersion, adapterDiagnostics, generateContextInfo,
 *                generateExternalAdReply, capabilitySummary
 *  - Re-exports: wizardSessionCount, listWizardSessions, resumeWizardSession
 *
 * ─── Universal API surface ───────────────────────────────────────────────────
 *  sendText()        sendReply()        sendPoll()         sendMention()
 *  sendLong()        sendWithTyping()   sendTyping()       sendRead()
 *  editText()        sendRaw()
 *  sendImage()       sendVideo()        sendAudio()        sendVoiceNote()
 *  sendSticker()     sendGif()          sendDocument()     sendAlbum()
 *  sendMediaFromUrl() prepareThumbnail() guessMime()
 *  prepareContextInfo() prepareExternalAdReply()
 *  sendButtons()     sendInteractive()  sendList()
 *  sendCarousel()    sendNativeFlow()   sendHeroCard()     sendUrlButtons()
 *  sendCode()        sendCodeMulti()    sendMenu()
 *  sendReaction()    reactCustom()      clearReaction()
 *  reactProcessing() reactWaiting()     reactSuccess()     reactFail()
 *  reactError()      reactLoading()     reactDownload()    reactFire()
 *  reactLike()       reactSet()         reactSequence()    withReactions()
 *  sendContact()     sendContacts()     sendBotVCard()     buildVCard()
 *  sendLocation()    sendPollMessage()
 *  postTextStatus()  postImageStatus()  postVideoStatus()  postAudioStatus()
 *  postStickerStatus() postDocumentStatus() getStatusAudience()
 *  forwardMessage()  forwardSilent()    broadcastForward() resendMessage()
 *  uploadMedia()     uploadToCatbox()   downloadMedia()    downloadQuotedMedia()
 *  downloadViewOnce() downloadFromUrl() fetchBuffer()      cleanupTemp()
 *  getMessageType()  hasMedia()
 *  deleteMessage()   editMessage()      getPresence()      isOnWhatsApp()
 *  getProfilePicture() getBaileysVersion() isGktwAvailable()
 *  getGroupMetadata() normalizeJid()    getEffectiveSender() resolveJid()
 *  extractText()     extractBody()      getMentions()      getQuoted()
 *  getContentType()  isGroupJid()       isBroadcastJid()   isNewsletterJid()
 *  isUserJid()       isBotMessage()     phoneFromJid()     toUserJid()
 *  sleep()           withRetry()        formatUptime()     formatBytes()
 *  setPresence()     withTyping()       markRead()
 *  REACTIONS         REACTION_SETS
 *  ── New in v4 ────────────────────────────────────────────────────────────────
 *  UI                (UI Manager — openHome, openCategory, openWizard, etc.)
 *  onHook()          offHook()          emitHook()         withCommandHooks()
 *  getCapabilities() can()              capabilitySummary() invalidateCapabilityCache()
 *  MENU_CATEGORIES   getCategoryById()  findCommand()      getTotalCommandCount()
 *  gktwVersion()     adapterDiagnostics() generateContextInfo() generateExternalAdReply()
 *  getEngineRegistry() getEngine() engineStatus()
 *  startWizardSession() clearWizardSession() hasWizardSession() getWizardSession()
 *  resumeWizardSession() listWizardSessions() wizardSessionCount()
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ── Re-export all sibling handlers ────────────────────────────────────────────
export * from "./reactionHandler.js";
export * from "./messageHandler.js";
export * from "./mediaHandler.js";
export * from "./interactiveHandler.js";
export * from "./uploadHandler.js";
export * from "./downloadHandler.js";
export * from "./contactHandler.js";
export * from "./statusHandler.js";
export * from "./forwardHandler.js";
export * from "./menuHandler.js";
export * from "./codeHandler.js";
export * from "./utilityHandler.js";

// ── New v4 layers ──────────────────────────────────────────────────────────────
export * from "./uiHandler.js";
export * from "./eventHooks.js";
export * from "./capabilityHandler.js";
export * from "./menuConfig.js";
export * from "./wizardHandler.js";

// ── Adapter exports ────────────────────────────────────────────────────────────
export {
  isGktwAvailable,
  gktwVersion,
  gktwModule,
  baileysModule,
  adapterDiagnostics,
  generateContextInfo,
  generateExternalAdReply,
  sendRichInteractive,
} from "./gktwAdapter.js";

// ── Builder exports (fluent message builders) ──────────────────────────────────
// All builders compose into ONE sendMessage() call — no split sends.
export {
  MIASMessageBuilder,
  build,
  MenuBuilder,
  menu,
  InteractiveBuilder,
  interactive,
  MediaBuilder,
  media,
  ContextBuilder,
  context,
  ExternalAdReplyBuilder,
  adReply,
  VCardBuilder,
  vcard,
  ReactionBuilder,
  reaction,
  EMOJIS,
  ThumbnailBuilder,
  thumbnail,
} from "./builders/index.js";

// ── Shared engine registry ────────────────────────────────────────────────────
import engineRegistryModule from "../lib/engineRegistry.cjs";

const {
  getEngine: _getEngine,
  getEngineRegistry: _getEngineRegistry,
  initializeEngineRegistry: _initializeEngineRegistry,
} = engineRegistryModule;

export function initializeEngineRegistry(adapters = {}) {
  return _initializeEngineRegistry({ adapters });
}

export function getEngineRegistry() {
  return _getEngineRegistry();
}

export function getEngine(name) {
  return _getEngine(name);
}

export function engineStatus() {
  return getEngineRegistry().diagnostics();
}

// ─── Core adapter utilities ───────────────────────────────────────────────────

import {
  getBaileys,
  fetchLatestBaileysVersion as _fetchVersion,
  isGktwAvailable as _isGktwAvailable,
  getGroupMetadata as _getGroupMetadata,
  groupFetchAllParticipating as _groupFetchAll,
  sendPoll as _sendPollDirect,
} from "./gktwAdapter.js";

/**
 * Get the currently installed Baileys version string.
 * @returns {Promise<{version: number[], isLatest: boolean}>}
 */
export async function getBaileysVersion() {
  try {
    return await _fetchVersion();
  } catch {
    return { version: [2, 3000, 0], isLatest: false };
  }
}

/**
 * Fetch group metadata.
 * @param {object} sock
 * @param {string} jid
 */
export async function getGroupMetadata(sock, jid) {
  return _getGroupMetadata(sock, jid);
}

/**
 * Fetch all groups the bot is participating in.
 * @param {object} sock
 */
export async function groupFetchAllParticipating(sock) {
  return _groupFetchAll(sock);
}

/**
 * Delete a sent message.
 * @param {object} sock
 * @param {string} jid
 * @param {object} key  - Message key { id, fromMe, remoteJid }
 */
export async function deleteMessage(sock, jid, key) {
  try {
    return await sock.sendMessage(jid, { delete: key });
  } catch (err) {
    console.error("[deleteMessage] Error:", err?.message);
    return null;
  }
}

/**
 * Edit a sent text message.
 * @param {object} sock
 * @param {string} jid
 * @param {object} key
 * @param {string} newText
 */
export async function editMessage(sock, jid, key, newText) {
  try {
    return await sock.sendMessage(jid, { text: String(newText), edit: key });
  } catch (err) {
    console.error("[editMessage] Error:", err?.message);
    return null;
  }
}

/**
 * Alias for editMessage — same signature, clearer name.
 */
export const editText = editMessage;

/**
 * Get a contact's presence (online/offline/typing).
 * @param {object} sock
 * @param {string} jid
 */
export async function getPresence(sock, jid) {
  try {
    if (typeof sock.presenceSubscribe === "function") {
      await sock.presenceSubscribe(jid);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Check if a phone number is registered on WhatsApp.
 * @param {object} sock
 * @param {string} jid
 * @returns {Promise<boolean>}
 */
export async function isOnWhatsApp(sock, jid) {
  try {
    const result = await sock.onWhatsApp(jid);
    return !!(Array.isArray(result) ? result[0]?.exists : result?.exists);
  } catch {
    return false;
  }
}

/**
 * Get a contact's profile picture URL.
 * Returns null when unavailable.
 * @param {object} sock
 * @param {string} jid
 * @returns {Promise<string|null>}
 */
export async function getProfilePicture(sock, jid) {
  try {
    return await sock.profilePictureUrl(jid, "image");
  } catch {
    return null;
  }
}

/**
 * Prepare a contextInfo with externalAdReply (link-preview card).
 * Re-exported from mediaHandler for backward compat.
 * @param {object} opts
 * @returns {object}
 */
export function prepareContextInfo(opts = {}) {
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

/**
 * Build an externalAdReply contextInfo block.
 * Alias for prepareContextInfo.
 * @param {object} opts
 * @returns {object}
 */
export const prepareExternalAdReply = prepareContextInfo;

/**
 * Send a location message.
 * @param {object} sock
 * @param {string} jid
 * @param {number} latitude
 * @param {number} longitude
 * @param {object} [opts]
 * @param {string} [opts.name]
 * @param {string} [opts.address]
 * @param {object} [opts.quoted]
 */
export async function sendLocation(sock, jid, latitude, longitude, opts = {}) {
  try {
    const content = {
      location: {
        degreesLatitude:  latitude,
        degreesLongitude: longitude,
        name:    opts.name    || "",
        address: opts.address || "",
      },
    };
    const sendOpts = {};
    if (opts.quoted) sendOpts.quoted = opts.quoted;
    return await sock.sendMessage(jid, content, sendOpts);
  } catch (err) {
    console.error("[sendLocation] Error:", err?.message);
    return null;
  }
}

/**
 * Send an interactive poll.
 * Falls back to a numbered text list if polls are unsupported.
 * @param {object}   sock
 * @param {string}   jid
 * @param {string}   question
 * @param {string[]} options
 * @param {object}   [opts]
 * @param {number}   [opts.selectableCount=1]
 * @param {object}   [opts.quoted]
 */
export async function sendPollMessage(sock, jid, question, options, opts = {}) {
  try {
    return await _sendPollDirect(sock, jid, question, options, opts);
  } catch {
    const { sendText } = await import("./messageHandler.js");
    const lines = (options || []).map((o, i) => `[${i + 1}] ${o}`).join("\n");
    const text  = `*${question}*\n\n${lines}`;
    const sendOpts = {};
    if (opts.quoted) sendOpts.quoted = opts.quoted;
    return sock.sendMessage(jid, { text }, sendOpts);
  }
}
