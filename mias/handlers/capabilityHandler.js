/**
 * MIAS — Capability Detection Layer  v1
 *
 * Never assume WhatsApp supports every interactive feature.
 * This module auto-detects what is available and provides safe fallback flags.
 *
 * Detected capabilities:
 *   nativeFlow      - Native button flow messages (GKTW / Baileys proto)
 *   singleSelect    - Single-select list messages
 *   carousel        - Multi-card carousel messages
 *   heroCards       - Image/video header hero cards
 *   buttons         - Quick-reply buttons
 *   lists           - List-selector messages
 *   polls           - Poll messages
 *   externalAdReply - Link-preview cards
 *   contextInfo     - ContextInfo injection
 *   albums          - Multi-media album messages
 *   mediaGroups     - Media group messages
 *   richPreview     - Rich link preview
 *   editMessage     - Edit a sent message
 *   pinMessage      - Pin messages in chats
 *   newsletter      - Channel / newsletter support
 *
 * Usage:
 *   import { getCapabilities, can } from "./capabilityHandler.js";
 *
 *   const caps = await getCapabilities(sock);
 *   if (caps.nativeFlow) {
 *     // send interactive buttons
 *   } else {
 *     // send plain text fallback
 *   }
 *
 *   // Shorthand:
 *   if (await can(sock, "polls")) { ... }
 *
 * Architecture:  Commands → Handlers → capabilityHandler → gktwAdapter
 */

import { isGktwAvailable, getBaileys } from "./gktwAdapter.js";

// ─── Cache ────────────────────────────────────────────────────────────────────
// Capabilities rarely change at runtime — cache for 5 min.
const CACHE_TTL_MS = 5 * 60 * 1000;
let _cache = null;
let _cacheTs = 0;

// ─── Internal detectors ───────────────────────────────────────────────────────

async function _detectNativeFlow() {
  // Available when GKTW is installed, or when Baileys proto is accessible
  try {
    if (await isGktwAvailable()) return true;
    const B = await getBaileys();
    return !!(B?.proto?.Message?.InteractiveMessage?.NativeFlowMessage);
  } catch {
    return false;
  }
}

async function _detectPolls() {
  try {
    const B = await getBaileys();
    // Polls are supported if sock.sendMessage accepts poll content
    // We check Baileys version as a proxy
    return !!(B?.proto?.Message?.PollCreationMessage);
  } catch {
    return true; // assume true — Baileys has had polls for a long time
  }
}

async function _detectEditMessage() {
  try {
    const B = await getBaileys();
    return !!(B?.proto?.Message?.ProtocolMessage);
  } catch {
    return false;
  }
}

async function _detectNewsletter() {
  try {
    const B = await getBaileys();
    if (typeof B?.isJidNewsletter === "function") return true;
  } catch {}
  return false;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Build and return the full capabilities map.
 * Results are cached for CACHE_TTL_MS to avoid repeated async probes.
 *
 * @param {object} [sock]  - Active Baileys socket (optional, used for future live checks)
 * @returns {Promise<Capabilities>}
 *
 * @typedef {object} Capabilities
 * @property {boolean} nativeFlow
 * @property {boolean} singleSelect
 * @property {boolean} carousel
 * @property {boolean} heroCards
 * @property {boolean} buttons
 * @property {boolean} lists
 * @property {boolean} polls
 * @property {boolean} externalAdReply
 * @property {boolean} contextInfo
 * @property {boolean} albums
 * @property {boolean} mediaGroups
 * @property {boolean} richPreview
 * @property {boolean} editMessage
 * @property {boolean} pinMessage
 * @property {boolean} newsletter
 * @property {boolean} gktw       - Whether GKTW is active
 * @property {number}  detectedAt - Unix timestamp of detection
 */
export async function getCapabilities(sock) {
  const now = Date.now();
  if (_cache && (now - _cacheTs) < CACHE_TTL_MS) return _cache;

  const [nativeFlow, polls, editMessage, newsletter, gktw] = await Promise.all([
    _detectNativeFlow(),
    _detectPolls(),
    _detectEditMessage(),
    _detectNewsletter(),
    isGktwAvailable(),
  ]);

  _cache = {
    nativeFlow,
    singleSelect:    nativeFlow,        // list messages use same proto as NF
    carousel:        nativeFlow && gktw, // carousel requires GKTW for full support
    heroCards:       nativeFlow,
    buttons:         nativeFlow,
    lists:           nativeFlow,
    polls,
    externalAdReply: true,              // works on all versions via contextInfo
    contextInfo:     true,              // always supported
    albums:          true,              // sequential sendMessage always works
    mediaGroups:     true,              // sequential sendMessage always works
    richPreview:     true,              // link preview is standard
    editMessage,
    pinMessage:      false,             // not yet in public Baileys API
    newsletter,
    gktw,
    detectedAt: now,
  };
  _cacheTs = now;
  return _cache;
}

/**
 * Check a single capability by name.
 * Convenience shorthand for getCapabilities().
 *
 * @param {object} sock
 * @param {string} feature  - Capability key (e.g. "nativeFlow", "polls")
 * @returns {Promise<boolean>}
 */
export async function can(sock, feature) {
  const caps = await getCapabilities(sock);
  return caps[feature] === true;
}

/**
 * Invalidate the capabilities cache (e.g. after a reconnect or GKTW install).
 */
export function invalidateCapabilityCache() {
  _cache = null;
  _cacheTs = 0;
}

/**
 * Return a human-readable summary of detected capabilities.
 * Useful for bot info / status commands.
 *
 * @param {object} [sock]
 * @returns {Promise<string>}
 */
export async function capabilitySummary(sock) {
  const caps = await getCapabilities(sock);
  const lines = [
    `GKTW         : ${caps.gktw           ? "Active"   : "Inactive (Baileys fallback)"}`,
    `Native Flow  : ${caps.nativeFlow      ? "Yes"      : "No"}`,
    `Buttons      : ${caps.buttons         ? "Yes"      : "No"}`,
    `Lists        : ${caps.lists           ? "Yes"      : "No"}`,
    `Carousel     : ${caps.carousel        ? "Yes"      : "No"}`,
    `Hero Cards   : ${caps.heroCards       ? "Yes"      : "No"}`,
    `Polls        : ${caps.polls           ? "Yes"      : "No"}`,
    `ExternalAd   : ${caps.externalAdReply ? "Yes"      : "No"}`,
    `Edit Message : ${caps.editMessage     ? "Yes"      : "No"}`,
    `Newsletter   : ${caps.newsletter      ? "Yes"      : "No"}`,
  ];
  return lines.join("\n");
}
