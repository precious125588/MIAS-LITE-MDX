/**
 * MIAS — Reaction Service
 *
 * Centralized reaction management.
 * Commands call these helpers only — never build reaction payloads manually.
 *
 * Architecture: Commands → ReactionService → ReactionHandler → Baileys → WhatsApp
 */

import {
  sendReaction,
  reactCustom,
  clearReaction,
  reactProcessing,
  reactWaiting,
  reactSuccess,
  reactFail,
  reactError,
  reactLoading,
  reactDownload,
  reactFire,
  reactLike,
  withReactions,
  reactSet,
  reactSequence,
  REACTIONS,
  REACTION_SETS,
} from "../handlers/reactionHandler.js";

// ─── Re-export all reaction helpers ───────────────────────────────────────────

export {
  sendReaction,
  reactCustom,
  clearReaction,
  reactProcessing,
  reactWaiting,
  reactSuccess,
  reactFail,
  reactError,
  reactLoading,
  reactDownload,
  reactFire,
  reactLike,
  withReactions,
  reactSet,
  reactSequence,
  REACTIONS,
  REACTION_SETS,
};

// ─── Semantic aliases (matching the spec) ────────────────────────────────────

/** React with ⏳ before an operation. */
export const reactLoading_ = reactLoading;

/** React with ✅ after success. */
export const reactSuccess_ = reactSuccess;

/** React with ❌ after failure. */
export const reactFail_ = reactFail;

/** React with ⚠️ for warnings. */
export const reactWarning = reactError;

/**
 * Wrap a command handler with automatic loading/success/fail reactions.
 * Clears the loading reaction automatically (no stuck ⏳).
 *
 * @param {object}   sock
 * @param {object}   msg
 * @param {Function} fn
 * @param {object}   [opts]
 * @param {string}   [opts.startEmoji]
 * @param {string}   [opts.successEmoji]
 * @param {string}   [opts.failEmoji]
 * @returns {Promise<any>}
 */
export async function withCommandReactions(sock, msg, fn, opts = {}) {
  return withReactions(sock, msg, fn, {
    startEmoji:   opts.startEmoji   ?? REACTIONS.PROCESSING,
    successEmoji: opts.successEmoji ?? REACTIONS.SUCCESS,
    failEmoji:    opts.failEmoji    ?? REACTIONS.FAIL,
    rethrow:      opts.rethrow      !== false,
  });
}

export default {
  sendReaction,
  reactCustom,
  clearReaction,
  reactProcessing,
  reactWaiting,
  reactSuccess,
  reactFail,
  reactError,
  reactWarning,
  reactLoading,
  reactDownload,
  reactFire,
  reactLike,
  withReactions,
  withCommandReactions,
  reactSet,
  reactSequence,
  REACTIONS,
  REACTION_SETS,
};
