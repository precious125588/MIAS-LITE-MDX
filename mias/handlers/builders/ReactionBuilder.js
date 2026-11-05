/**
 * MIAS — ReactionBuilder
 *
 * Fluent builder for sending emoji reactions to WhatsApp messages.
 * Wraps reactionHandler with a composable API that supports
 * sequenced reactions, named reactions, and auto-wrap patterns.
 *
 *   Usage:
 *     // Named reaction
 *     await new ReactionBuilder(sock, msg).success().send();
 *     await new ReactionBuilder(sock, msg).fail().send();
 *
 *     // Custom emoji
 *     await new ReactionBuilder(sock, msg).emoji("🤖").send();
 *
 *     // Sequence: 🌀 → ✅ with 1s delay
 *     await new ReactionBuilder(sock, msg).processing().then().success().sendSequence();
 *
 *     // Wrap an operation
 *     await ReactionBuilder.wrap(sock, msg, async () => { ... });
 */

export const EMOJIS = {
  PROCESSING: "🌀",
  WAITING:    "⌛",
  SUCCESS:    "✅",
  FAIL:       "❌",
  ERROR:      "⚠️",
  LOADING:    "⏳",
  DOWNLOAD:   "⬇️",
  UPLOAD:     "⬆️",
  FIRE:       "🔥",
  LIKE:       "👍",
  LOVE:       "❤️",
  DONE:       "🎉",
  BOT:        "🤖",
  SEARCH:     "🔍",
};

export class ReactionBuilder {
  constructor(sock, msg) {
    this._sock     = sock;
    this._msg      = msg;
    this._emoji    = null;
    this._sequence = [];
    this._delayMs  = 1000;
  }

  /** React with a custom emoji */
  emoji(e)       { this._emoji = String(e || ""); return this; }

  /** React with 🌀 */
  processing()   { this._emoji = EMOJIS.PROCESSING; return this; }

  /** React with ⌛ */
  waiting()      { this._emoji = EMOJIS.WAITING; return this; }

  /** React with ✅ */
  success()      { this._emoji = EMOJIS.SUCCESS; return this; }

  /** React with ❌ */
  fail()         { this._emoji = EMOJIS.FAIL; return this; }

  /** React with ⚠️ */
  error()        { this._emoji = EMOJIS.ERROR; return this; }

  /** React with ⏳ */
  loading()      { this._emoji = EMOJIS.LOADING; return this; }

  /** React with ⬇️ */
  download()     { this._emoji = EMOJIS.DOWNLOAD; return this; }

  /** React with 🔥 */
  fire()         { this._emoji = EMOJIS.FIRE; return this; }

  /** React with 👍 */
  like()         { this._emoji = EMOJIS.LIKE; return this; }

  /** React with ❤️ */
  love()         { this._emoji = EMOJIS.LOVE; return this; }

  /** React with 🎉 */
  done()         { this._emoji = EMOJIS.DONE; return this; }

  /** React with 🤖 */
  bot()          { this._emoji = EMOJIS.BOT; return this; }

  /** Set delay between sequence reactions (ms) */
  delay(ms)      { this._delayMs = ms || 1000; return this; }

  /**
   * Add the current emoji to the sequence, then start building the next step.
   * Allows chaining: .processing().then().success().sendSequence()
   */
  then() {
    if (this._emoji) this._sequence.push(this._emoji);
    this._emoji = null;
    return this;
  }

  /** Clear reaction (empty emoji) */
  clear()        { this._emoji = ""; return this; }

  /**
   * Send the current reaction.
   * @returns {Promise<object|null>}
   */
  async send() {
    if (this._emoji === null) return null;
    try {
      if (!this._sock || !this._msg?.key) return null;
      return await this._sock.sendMessage(this._msg.key.remoteJid, {
        react: { text: String(this._emoji), key: this._msg.key },
      });
    } catch {
      return null;
    }
  }

  /**
   * Send all sequence reactions with delays.
   * @returns {Promise<void>}
   */
  async sendSequence() {
    // Flush current emoji into sequence
    if (this._emoji !== null) this._sequence.push(this._emoji);

    for (let i = 0; i < this._sequence.length; i++) {
      try {
        if (!this._sock || !this._msg?.key) continue;
        await this._sock.sendMessage(this._msg.key.remoteJid, {
          react: { text: String(this._sequence[i]), key: this._msg.key },
        });
      } catch {}
      if (i < this._sequence.length - 1 && this._delayMs > 0) {
        await new Promise(r => setTimeout(r, this._delayMs));
      }
    }
  }

  /**
   * Wrap an async operation with processing→success/fail reactions.
   * @param {object}   sock
   * @param {object}   msg
   * @param {Function} fn
   * @param {object}   [opts]
   * @param {string}   [opts.start="🌀"]
   * @param {string}   [opts.success="✅"]
   * @param {string}   [opts.fail="❌"]
   * @param {boolean}  [opts.rethrow=true]
   * @returns {Promise<any>}
   */
  static async wrap(sock, msg, fn, opts = {}) {
    const startE   = opts.start   ?? EMOJIS.PROCESSING;
    const successE = opts.success ?? EMOJIS.SUCCESS;
    const failE    = opts.fail    ?? EMOJIS.FAIL;
    const rethrow  = opts.rethrow !== false;

    const react = async (e) => {
      try {
        if (sock && msg?.key) {
          await sock.sendMessage(msg.key.remoteJid, {
            react: { text: String(e), key: msg.key },
          });
        }
      } catch {}
    };

    await react(startE);
    try {
      const result = await fn();
      await react(successE);
      return result;
    } catch (err) {
      await react(failE);
      if (rethrow) throw err;
      return null;
    }
  }
}

/**
 * Factory shorthand.
 * @param {object} sock
 * @param {object} msg
 * @returns {ReactionBuilder}
 */
export function reaction(sock, msg) {
  return new ReactionBuilder(sock, msg);
}

export default ReactionBuilder;
