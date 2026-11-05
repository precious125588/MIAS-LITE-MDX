/**
 * MIAS — Reaction Handler  v2
 *
 * Centralized emoji-reaction abstraction.
 * Commands must never send reactions directly through Baileys.
 *
 * Architecture:  Commands → Handlers → Baileys Adapter → WhatsApp
 */

// ─── Standard reaction emojis ─────────────────────────────────────────────────
export const REACTIONS = {
  PROCESSING: "🌀",
  WAITING:    "⌛",
  SUCCESS:    "✅",
  FAIL:       "❌",
  ERROR:      "⚠️",
  LOADING:    "⏳",
  DONE:       "🎉",
  LIKE:       "👍",
  DISLIKE:    "👎",
  LOVE:       "❤️",
  FIRE:       "🔥",
  INFO:       "ℹ️",
  WARN:       "⚠️",
  STOP:       "🛑",
  BOT:        "🤖",
  SEARCH:     "🔍",
  DOWNLOAD:   "⬇️",
  UPLOAD:     "⬆️",
  MUSIC:      "🎵",
  VIDEO:      "🎬",
  IMAGE:      "🖼️",
  COOL:       "😎",
  CLAP:       "👏",
  EYES:       "👀",
};

/**
 * Common reaction sequences for reuse across commands.
 */
export const REACTION_SETS = {
  /** Processing → Success */
  PROCESS_OK:   [REACTIONS.PROCESSING, REACTIONS.SUCCESS],
  /** Processing → Fail */
  PROCESS_FAIL: [REACTIONS.PROCESSING, REACTIONS.FAIL],
  /** Loading → Done */
  LOAD_DONE:    [REACTIONS.LOADING, REACTIONS.DONE],
  /** Download flow */
  DOWNLOAD:     [REACTIONS.DOWNLOAD, REACTIONS.SUCCESS],
};

// ─── Internal helper ──────────────────────────────────────────────────────────

async function _react(sock, msg, emoji) {
  try {
    if (!sock || !msg?.key) return null;
    return await sock.sendMessage(msg.key.remoteJid, {
      react: { text: String(emoji), key: msg.key },
    });
  } catch {
    return null;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Send a reaction emoji to a message.
 *
 * @param {object} sock
 * @param {object} msg   - WAMessage object
 * @param {string} emoji - Any emoji string
 * @returns {Promise<object|null>}
 */
export async function sendReaction(sock, msg, emoji) {
  return _react(sock, msg, emoji);
}

/**
 * Alias for sendReaction — explicit name for custom emoji reactions.
 * @param {object} sock
 * @param {object} msg
 * @param {string} emoji
 */
export async function reactCustom(sock, msg, emoji) {
  return _react(sock, msg, emoji);
}

/**
 * Remove (clear) a reaction from a message.
 * @param {object} sock
 * @param {object} msg
 */
export async function clearReaction(sock, msg) {
  return _react(sock, msg, "");
}

/** React with 🌀 (processing / in-progress) */
export async function reactProcessing(sock, msg) {
  return _react(sock, msg, REACTIONS.PROCESSING);
}

/** React with ⌛ (waiting / queued) */
export async function reactWaiting(sock, msg) {
  return _react(sock, msg, REACTIONS.WAITING);
}

/** React with ✅ (success) */
export async function reactSuccess(sock, msg) {
  return _react(sock, msg, REACTIONS.SUCCESS);
}

/** React with ❌ (failure) */
export async function reactFail(sock, msg) {
  return _react(sock, msg, REACTIONS.FAIL);
}

/** React with ⚠️ (error / warning) */
export async function reactError(sock, msg) {
  return _react(sock, msg, REACTIONS.ERROR);
}

/** React with ⏳ (loading) */
export async function reactLoading(sock, msg) {
  return _react(sock, msg, REACTIONS.LOADING);
}

/** React with ⬇️ (downloading) */
export async function reactDownload(sock, msg) {
  return _react(sock, msg, REACTIONS.DOWNLOAD);
}

/** React with 🔥 (fire / hype) */
export async function reactFire(sock, msg) {
  return _react(sock, msg, REACTIONS.FIRE);
}

/** React with 👍 (like / approval) */
export async function reactLike(sock, msg) {
  return _react(sock, msg, REACTIONS.LIKE);
}

/**
 * Wrap an async operation with automatic reactions.
 *  - Reacts with 🌀 before running.
 *  - Reacts with ✅ on success.
 *  - Reacts with ❌ on failure.
 *  - Optionally re-throws on failure.
 *
 * @param {object}   sock
 * @param {object}   msg
 * @param {Function} fn           - Async function to execute
 * @param {object}   [opts]
 * @param {string}   [opts.startEmoji]   - Override start emoji (default 🌀)
 * @param {string}   [opts.successEmoji] - Override success emoji (default ✅)
 * @param {string}   [opts.failEmoji]    - Override fail emoji (default ❌)
 * @param {boolean}  [opts.rethrow=true] - Whether to re-throw errors
 * @returns {Promise<any>}
 */
export async function withReactions(sock, msg, fn, opts = {}) {
  const startEmoji   = opts.startEmoji   ?? REACTIONS.PROCESSING;
  const successEmoji = opts.successEmoji ?? REACTIONS.SUCCESS;
  const failEmoji    = opts.failEmoji    ?? REACTIONS.FAIL;
  const rethrow      = opts.rethrow      !== false;

  await _react(sock, msg, startEmoji);

  try {
    const result = await fn();
    await _react(sock, msg, successEmoji);
    return result;
  } catch (err) {
    await _react(sock, msg, failEmoji);
    if (rethrow) throw err;
    return null;
  }
}

/**
 * React with a custom sequence of emojis, with delays between each.
 *
 * @param {object}   sock
 * @param {object}   msg
 * @param {string[]} emojis   - Sequence of emojis to react in order
 * @param {number}   [delayMs=1000]
 * @returns {Promise<void>}
 */
export async function reactSequence(sock, msg, emojis, delayMs = 1000) {
  for (const emoji of emojis) {
    await _react(sock, msg, emoji);
    if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
  }
}

/**
 * React with a predefined REACTION_SET sequence.
 * e.g. await reactSet(sock, msg, "PROCESS_OK")
 *
 * @param {object} sock
 * @param {object} msg
 * @param {keyof typeof REACTION_SETS} setName
 * @param {number} [delayMs=1000]
 */
export async function reactSet(sock, msg, setName, delayMs = 1000) {
  const emojis = REACTION_SETS[setName];
  if (!emojis) return;
  return reactSequence(sock, msg, emojis, delayMs);
}
