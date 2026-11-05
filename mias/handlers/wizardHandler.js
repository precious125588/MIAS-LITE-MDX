/**
 * MIAS — Wizard Handler  v2
 *
 * Manages per-user command wizard sessions for Button Mode.
 * When a user selects a command that needs input, a wizard session
 * is started. The next message from that user is treated as input
 * for the chosen command and auto-executed.
 *
 * Features:
 *   - Per-user session isolation
 *   - Configurable timeout (default 90s)
 *   - Cancel keywords
 *   - Input type validation (text / media)
 *   - Resume after reconnect (in-memory, best-effort)
 *   - Automatic session cleanup on timeout or completion
 *
 * Only active when Button Mode is ON. Text Mode is untouched.
 *
 * Architecture:  Button Mode → Wizard → Command Dispatch
 */

// ─── Session store ─────────────────────────────────────────────────────────────
// Keyed by effective sender JID
// { command, prompt, type, startedAt, expiresAt, timeoutRef, attempts }
const _sessions = new Map();

const DEFAULT_TIMEOUT_MS  = 90_000;  // 90 seconds
const MAX_ATTEMPTS        = 3;       // max invalid input attempts before auto-cancel
const CANCEL_KEYWORDS     = new Set(["cancel", "stop", "exit", "quit", "close", "back", "0"]);

// ─── Command input registry ────────────────────────────────────────────────────
// null  = execute immediately (no input required)
// { prompt, type } = wizard required

export const COMMAND_INPUTS = {
  // ── Downloads ──────────────────────────────────────────────────────────────
  play:         { prompt: "Enter the song name or YouTube URL:", type: "text" },
  song:         { prompt: "Enter the song name to search:", type: "text" },
  video:        { prompt: "Enter the YouTube URL or search term:", type: "text" },
  ytmp3:        { prompt: "Send the YouTube URL to download as audio:", type: "text" },
  ytmp4:        { prompt: "Send the YouTube URL to download as video:", type: "text" },
  spotify:      { prompt: "Enter the Spotify URL or song name:", type: "text" },
  facebook:     { prompt: "Send the Facebook video URL:", type: "text" },
  instagram:    { prompt: "Send the Instagram post or reel URL:", type: "text" },
  tiktok:       { prompt: "Send the TikTok URL:", type: "text" },
  pinterest:    { prompt: "Enter a Pinterest search query:", type: "text" },
  mediafire:    { prompt: "Send the MediaFire file URL:", type: "text" },
  apk:          { prompt: "Enter the app name to search:", type: "text" },
  twitter:      { prompt: "Send the Twitter/X post URL:", type: "text" },
  xdownload:    { prompt: "Send the X (Twitter) post URL:", type: "text" },
  soundcloud:   { prompt: "Enter the SoundCloud URL or song name:", type: "text" },
  // ── AI ─────────────────────────────────────────────────────────────────────
  ai:           { prompt: "Enter your message for the AI assistant:", type: "text" },
  gpt:          { prompt: "Enter your question for GPT:", type: "text" },
  gpt4:         { prompt: "Enter your question for GPT-4:", type: "text" },
  gpt4o:        { prompt: "Enter your question for GPT-4o:", type: "text" },
  mistral:      { prompt: "Enter your question for Mistral:", type: "text" },
  deepseek:     { prompt: "Enter your question for DeepSeek:", type: "text" },
  gemini:       { prompt: "Enter your message for Gemini:", type: "text" },
  imagine:      { prompt: "Describe the image you want to generate:", type: "text" },
  flux:         { prompt: "Describe the image you want to generate with Flux:", type: "text" },
  tts:          { prompt: "Enter the text to convert to speech:", type: "text" },
  // ── Search ─────────────────────────────────────────────────────────────────
  google:       { prompt: "Enter your Google search query:", type: "text" },
  youtube:      { prompt: "Enter the YouTube search query:", type: "text" },
  wiki:         { prompt: "Enter the Wikipedia topic to look up:", type: "text" },
  wikipedia:    { prompt: "Enter the Wikipedia topic to search:", type: "text" },
  weather:      { prompt: "Enter the city name for weather info:", type: "text" },
  news:         { prompt: "Enter a news topic or keyword:", type: "text" },
  // ── Media ──────────────────────────────────────────────────────────────────
  sticker:      { prompt: "Send or reply to an image/video to convert to sticker.", type: "media" },
  toimg:        { prompt: "Reply to a sticker to convert it to an image.", type: "media" },
  toanim:       { prompt: "Reply to a sticker to convert it to animated GIF.", type: "media" },
  togif:        { prompt: "Reply to a video to convert it to GIF.", type: "media" },
  ttp:          { prompt: "Enter the text to convert to a sticker:", type: "text" },
  attp:         { prompt: "Enter the text for an animated sticker:", type: "text" },
  remini:       { prompt: "Reply to or send a photo to enhance with Remini AI.", type: "media" },
  enhance:      { prompt: "Reply to or send a photo to enhance.", type: "media" },
  ocr:          { prompt: "Reply to or send an image to extract text from.", type: "media" },
  // ── Tools ──────────────────────────────────────────────────────────────────
  translate:    { prompt: "Format: <language> | <text>  (e.g. french | Hello world)", type: "text" },
  shorten:      { prompt: "Enter the URL to shorten:", type: "text" },
  qr:           { prompt: "Enter the text or URL to encode as QR:", type: "text" },
  base64:       { prompt: "Enter the text to encode as Base64:", type: "text" },
  decode:       { prompt: "Enter the Base64 string to decode:", type: "text" },
  calc:         { prompt: "Enter the math expression to calculate:", type: "text" },
  currency:     { prompt: "Format: <amount> <from> to <to>  (e.g. 100 USD to NGN)", type: "text" },
  tts:          { prompt: "Enter the text to convert to speech:", type: "text" },
  font:         { prompt: "Enter the text to stylize:", type: "text" },
  carbon:       { prompt: "Send or reply to the code you want to screenshot:", type: "text" },
  // ── Groups ─────────────────────────────────────────────────────────────────
  kick:         { prompt: "Reply to the member's message or tag them to kick:", type: "text" },
  promote:      { prompt: "Reply to or tag the member to promote to admin:", type: "text" },
  demote:       { prompt: "Reply to or tag the member to demote:", type: "text" },
  setdesc:      { prompt: "Enter the new group description:", type: "text" },
  setname:      { prompt: "Enter the new group name:", type: "text" },
  hidetag:      { prompt: "Enter the message to send while tagging all members:", type: "text" },
  // ── WhatsApp Tools ─────────────────────────────────────────────────────────
  profile:      { prompt: "Enter the phone number or tag the user:", type: "text" },
  bio:          { prompt: "Enter the phone number or tag the user:", type: "text" },
  pp:           { prompt: "Enter the phone number or tag the user:", type: "text" },
  status:       { prompt: "Enter the phone number or tag the user:", type: "text" },
  gst:          { prompt: "Reply to or send the media/text for the status:", type: "media" },
  check:        { prompt: "Enter the phone number to check (with country code):", type: "text" },
  jid:          { prompt: "Enter the phone number to get its JID:", type: "text" },
  // ── Account ────────────────────────────────────────────────────────────────
  buy:          { prompt: "Enter the premium plan you want to purchase:", type: "text" },
  // ── Owner ──────────────────────────────────────────────────────────────────
  broadcast:    { prompt: "Enter the message to broadcast to all chats:", type: "text" },
  block:        { prompt: "Enter the number or tag the user to block:", type: "text" },
  unblock:      { prompt: "Enter the number or tag the user to unblock:", type: "text" },
  ban:          { prompt: "Enter the number or tag the user to ban:", type: "text" },
  unban:        { prompt: "Enter the number or tag the user to unban:", type: "text" },
  setprefix:    { prompt: "Enter the new command prefix:", type: "text" },
  mode:         { prompt: "Enter 'public' or 'private':", type: "text" },
  addcmd:       { prompt: "Send the command code (name | category | desc\\n<code>):", type: "text" },
  getcmd:       { prompt: "Enter the command name to view its source:", type: "text" },
  delcmd:       { prompt: "Enter the command name to delete:", type: "text" },
  // ── Games ──────────────────────────────────────────────────────────────────
  tictactoe:    { prompt: "Tag the opponent you want to play Tic-Tac-Toe with:", type: "text" },
  "8ball":      { prompt: "Ask the magic 8-ball your question:", type: "text" },
};

// ─── Internal cleanup ─────────────────────────────────────────────────────────

function _clearTimer(session) {
  if (session?.timeoutRef) {
    clearTimeout(session.timeoutRef);
    session.timeoutRef = null;
  }
}

function _expireSession(jid, sock, jidForMsg) {
  const session = _sessions.get(jid);
  if (!session) return;
  _clearTimer(session);
  _sessions.delete(jid);
  // Notify user of expiry
  try {
    const prefix = globalThis.__MIAS_CONFIG__?.PREFIX
      || (globalThis.__GET_SETTING__ && globalThis.__GET_SETTING__("prefix"))
      || ".";
    const targetJid = jidForMsg || jid;
    const msg = { key: { remoteJid: targetJid, fromMe: false } };
    if (globalThis.__MIAS_SOCK__) {
      globalThis.__MIAS_SOCK__.sendMessage(targetJid, {
        text: `Your *${session.command}* session expired. Type *${prefix}menu* to try again.`,
      }).catch(() => {});
    }
  } catch {}
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Start a wizard session for a user.
 * If a session already exists, it is replaced.
 *
 * @param {string} effectiveJid   - Sender JID (in groups: participant JID)
 * @param {string} command        - Command name (e.g. "play")
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=90000]
 * @param {string} [opts.chatJid]         - Chat JID (for timeout notification)
 */
export function startWizardSession(effectiveJid, command, opts = {}) {
  // Clear any existing session
  clearWizardSession(effectiveJid);

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const chatJid   = opts.chatJid   || effectiveJid;

  const session = {
    command,
    startedAt:  Date.now(),
    expiresAt:  Date.now() + timeoutMs,
    attempts:   0,
    chatJid,
    timeoutRef: null,
  };

  session.timeoutRef = setTimeout(
    () => _expireSession(effectiveJid, null, chatJid),
    timeoutMs
  );

  _sessions.set(effectiveJid, session);
  return session;
}

/**
 * Check whether a user has an active wizard session.
 * @param {string} effectiveJid
 * @returns {boolean}
 */
export function hasWizardSession(effectiveJid) {
  const session = _sessions.get(effectiveJid);
  if (!session) return false;
  if (Date.now() > session.expiresAt) {
    clearWizardSession(effectiveJid);
    return false;
  }
  return true;
}

/**
 * Get the active wizard session object, or null.
 * @param {string} effectiveJid
 * @returns {object|null}
 */
export function getWizardSession(effectiveJid) {
  const session = _sessions.get(effectiveJid);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    clearWizardSession(effectiveJid);
    return null;
  }
  return session;
}

/**
 * Clear (cancel) the wizard session for a user.
 * @param {string} effectiveJid
 */
export function clearWizardSession(effectiveJid) {
  const session = _sessions.get(effectiveJid);
  if (session) {
    _clearTimer(session);
    _sessions.delete(effectiveJid);
  }
}

/**
 * Resume a wizard session (extend the timeout without resetting state).
 * Useful when the bot reconnects mid-session.
 *
 * @param {string} effectiveJid
 * @param {number} [extendMs=60000]
 */
export function resumeWizardSession(effectiveJid, extendMs = 60_000) {
  const session = _sessions.get(effectiveJid);
  if (!session) return false;
  _clearTimer(session);
  session.expiresAt = Date.now() + extendMs;
  session.timeoutRef = setTimeout(
    () => _expireSession(effectiveJid, null, session.chatJid),
    extendMs
  );
  return true;
}

/**
 * Get all active wizard sessions (for diagnostics / admin commands).
 * Returns an array of { jid, command, expiresAt, attempts }.
 * @returns {Array}
 */
export function listWizardSessions() {
  const now = Date.now();
  const out = [];
  for (const [jid, session] of _sessions.entries()) {
    if (now <= session.expiresAt) {
      out.push({
        jid,
        command:   session.command,
        expiresAt: session.expiresAt,
        attempts:  session.attempts,
      });
    }
  }
  return out;
}

/**
 * Count active wizard sessions.
 * @returns {number}
 */
export function wizardSessionCount() {
  const now = Date.now();
  let count = 0;
  for (const session of _sessions.values()) {
    if (now <= session.expiresAt) count++;
  }
  return count;
}

// ─── Input validation ──────────────────────────────────────────────────────────

/**
 * Validate user input against the session's expected type.
 * @param {string} input
 * @param {string} type  - "text" | "media"
 * @returns {{ valid: boolean, reason?: string }}
 */
function _validateInput(input, type) {
  if (type === "text") {
    if (!input || input.trim().length === 0) {
      return { valid: false, reason: "Input cannot be empty." };
    }
    if (input.length > 4000) {
      return { valid: false, reason: "Input is too long (max 4000 characters)." };
    }
    return { valid: true };
  }
  if (type === "media") {
    // For media commands the input is often a quoted message — we pass it through
    return { valid: true };
  }
  return { valid: true };
}

// ─── Main wizard interceptor ──────────────────────────────────────────────────

/**
 * Check if the incoming message is a wizard reply and process it.
 * Returns true if the message was consumed by the wizard (stop further processing).
 * Returns false if no active session was found (continue normal processing).
 *
 * @param {object} sock
 * @param {object} msg       - Full WAMessage
 * @param {object} [opts]
 * @param {string} [opts.prefix]
 * @returns {Promise<boolean>}
 */
export async function handleWizardInput(sock, msg, opts = {}) {
  const jid = msg?.key?.remoteJid;
  if (!jid) return false;

  // Effective sender JID
  const isGroup      = (jid || "").endsWith("@g.us");
  const effectiveJid = isGroup
    ? (msg.key?.participant || msg.participant || jid)
    : jid;

  // Look up sessions (check both keys)
  let session = getWizardSession(effectiveJid) || getWizardSession(jid);
  if (!session) return false;

  // Canonical key for this session
  const sessionKey = _sessions.has(effectiveJid) ? effectiveJid : jid;

  // Extract text body
  const raw = (
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption ||
    msg.message?.buttonsResponseMessage?.selectedButtonId ||
    msg.message?.listResponseMessage?.singleSelectReply?.selectedRowId ||
    msg.message?.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson ||
    ""
  ).trim();

  // Cancel keywords
  if (raw && CANCEL_KEYWORDS.has(raw.toLowerCase())) {
    clearWizardSession(effectiveJid);
    clearWizardSession(jid);
    const prefix = opts.prefix || globalThis.__MIAS_CONFIG__?.PREFIX || ".";
    try {
      await sock.sendMessage(jid,
        { text: `Session cancelled. Type *${prefix}menu* to return to the menu.` },
        { quoted: msg }
      );
    } catch {}
    return true;
  }

  // Input validation
  const spec = COMMAND_INPUTS[session.command];
  const inputType = spec?.type || "text";
  const { valid, reason } = _validateInput(raw, inputType);

  if (!valid) {
    session.attempts = (session.attempts || 0) + 1;
    if (session.attempts >= MAX_ATTEMPTS) {
      clearWizardSession(effectiveJid);
      clearWizardSession(jid);
      const prefix = opts.prefix || globalThis.__MIAS_CONFIG__?.PREFIX || ".";
      try {
        await sock.sendMessage(jid,
          { text: `Too many invalid attempts. Session cancelled.\nType *${prefix}menu* to try again.` },
          { quoted: msg }
        );
      } catch {}
      return true;
    }
    try {
      await sock.sendMessage(jid,
        { text: `${reason || "Invalid input."} (Attempt ${session.attempts}/${MAX_ATTEMPTS})\n\n${spec?.prompt || "Please try again."}` },
        { quoted: msg }
      );
    } catch {}
    return true;
  }

  // Consume session and dispatch the command
  const command = session.command;
  clearWizardSession(effectiveJid);
  clearWizardSession(jid);

  const args = raw ? raw.split(/\s+/).filter(Boolean) : [];

  try {
    if (typeof globalThis.__MIAS_DISPATCH_CMD__ === "function") {
      await globalThis.__MIAS_DISPATCH_CMD__(sock, msg, command, args);
      return true;
    }
    const cmds = globalThis.__MIAS_COMMANDS__;
    if (cmds) {
      const entry = cmds.get(command);
      if (entry?.handler) {
        await entry.handler(sock, msg, args);
        return true;
      }
    }
    // Last resort: notify user
    await sock.sendMessage(jid,
      { text: `Could not run *${command}*. Try typing it manually.` },
      { quoted: msg }
    );
  } catch (e) {
    try {
      await sock.sendMessage(jid,
        { text: `Error running *${command}*: ${e?.message || e}` },
        { quoted: msg }
      );
    } catch {}
  }

  return true;
}
