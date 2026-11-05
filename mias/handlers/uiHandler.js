import { forwardPremiumMenu } from "../lib/premiumMenus.js";
/**
 * MIAS — UI Manager  v1
 *
 * Complete user interface layer. Commands call UI methods — they never
 * manually build menus, navigation buttons, or category selectors.
 *
 * Public API:
 *   UI.openHome(sock, jid, msg, opts)
 *   UI.openCategory(sock, jid, msg, categoryId, opts)
 *   UI.openCommandList(sock, jid, msg, categoryId, opts)
 *   UI.openWizard(sock, jid, msg, commandName, opts)
 *   UI.goHome(sock, jid, msg, opts)           — alias for openHome
 *   UI.goBack(sock, jid, msg, opts)           — back to category selector
 *   UI.refresh(sock, jid, msg, opts)          — reload current screen
 *   UI.close(sock, jid, msg, opts)            — dismiss / close session
 *   UI.showHeroBanner(sock, jid, msg, opts)   — hero image banner
 *   UI.showProfileCard(sock, jid, msg, opts)  — bot profile card
 *   UI.showCommandHelp(sock, jid, msg, cmd, opts) — help for one command
 *   UI.showError(sock, jid, msg, text, opts)  — formatted error screen
 *   UI.showSuccess(sock, jid, msg, text, opts)— formatted success screen
 *   UI.showLoading(sock, jid, msg, opts)      — typing indicator + loading msg
 *
 * All methods fall back gracefully when interactive messages are unavailable.
 *
 * Architecture:  Commands → UI Manager → Handlers → Baileys Adapter → WhatsApp
 */

import { MENU_CATEGORIES, getCategoryById, findCommand, getTotalCommandCount } from "./menuConfig.js";
import { sendButtons, sendList, sendHeroCard } from "./interactiveHandler.js";
import { sendText, sendReply }                 from "./messageHandler.js";
import { sendImage }                           from "./mediaHandler.js";
import { sendBotVCard }                        from "./contactHandler.js";
import { formatUptime }                        from "./utilityHandler.js";
import { startWizardSession, COMMAND_INPUTS }  from "./wizardHandler.js";
import { getCapabilities }                     from "./capabilityHandler.js";
import { isGktwAvailable }                     from "./gktwAdapter.js";
import { getBaileysVersion }                   from "./baileysHandler.js";
import { reactProcessing }                     from "./reactionHandler.js";

// ─── Config resolvers ─────────────────────────────────────────────────────────

function _cfg(key, fallback) {
  try {
    if (globalThis.__MIAS_CONFIG__?.[key]) return globalThis.__MIAS_CONFIG__[key];
    if (globalThis.__GET_SETTING__) {
      const v = globalThis.__GET_SETTING__(key);
      if (v !== undefined && v !== null) return v;
    }
  } catch {}
  return fallback;
}

function _prefix()   { return _cfg("prefix", _cfg("PREFIX", ".")); }
function _botName()  {
  try {
    const sock = globalThis.__MIAS_SOCK__;
    if (sock?.user?.name) return sock.user.name;
  } catch {}
  return _cfg("BOT_NAME", _cfg("botName", "MIAS BOT"));
}
function _owner()    { return _cfg("OWNER", _cfg("owner", "MIAS Owner")); }
function _version()  { return _cfg("VERSION", _cfg("version", "5.3.1")); }
function _mode()     {
  try {
    const v = globalThis.__GET_SETTING__ ? globalThis.__GET_SETTING__("publicMode") : null;
    if (v === true) return "Public";
    if (v === false) return "Private";
  } catch {}
  return "Unknown";
}
function _cmdCount() {
  if (typeof globalThis.__MIAS_CMD_COUNT__ === "number") return globalThis.__MIAS_CMD_COUNT__;
  if (globalThis.__MIAS_COMMANDS__) return globalThis.__MIAS_COMMANDS__.size || getTotalCommandCount();
  return getTotalCommandCount();
}

// ─── Layout helpers ───────────────────────────────────────────────────────────

const LINE = "─".repeat(32);

function _homeText(opts = {}) {
  const now  = new Date();
  const date = now.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  const time = now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const uptime = typeof formatUptime === "function"
    ? formatUptime(process.uptime?.() || 0)
    : "—";

  return [
    `*${_botName()}*`,
    LINE,
    `User     : ${opts.userName || "Guest"}`,
    `Owner    : ${_owner()}`,
    `Prefix   : ${_prefix()}`,
    `Version  : ${_version()}`,
    `Mode     : ${_mode()}`,
    LINE,
    `Commands : ${_cmdCount()}`,
    `Uptime   : ${uptime}`,
    `Date     : ${date}`,
    `Time     : ${time}`,
    LINE,
    `Select a category below.`,
  ].join("\n");
}

function _categoryRows() {
  return MENU_CATEGORIES.map(cat => ({
    id:          cat.id,
    title:       cat.label,
    description: `${cat.cmds.length} command${cat.cmds.length !== 1 ? "s" : ""}`,
  }));
}

function _commandRows(cat) {
  const prefix = _prefix();
  return (cat.cmds || []).slice(0, 10).map(cmd => ({
    id:          `cmd_${cmd.name}`,
    title:       `${prefix}${cmd.name}`,
    description: cmd.desc || "",
  }));
}

// ─── Home screen ──────────────────────────────────────────────────────────────

/**
 * Open the bot home screen.
 * Sends bot vCard (with profile pic) then an interactive category list.
 *
 * @param {object} sock
 * @param {string} jid
 * @param {object} [msg]
 * @param {object} [opts]
 * @param {string} [opts.userName]  - Display name of the requester
 * @returns {Promise<void>}
 */
async function openHome(sock, jid, msg, opts = {}) {
  return forwardPremiumMenu(sock, jid, msg);
}

// ─── Category selector ────────────────────────────────────────────────────────

/**
 * Open the full category selector (a list of all categories).
 *
 * @param {object} sock
 * @param {string} jid
 * @param {object} [msg]
 * @param {object} [opts]
 * @returns {Promise<void>}
 */
async function openCategorySelector(sock, jid, msg, opts = {}) {
  return forwardPremiumMenu(sock, jid, msg);
}

// ─── Category command list ────────────────────────────────────────────────────

/**
 * Open the command list for a specific category.
 *
 * @param {object} sock
 * @param {string} jid
 * @param {object} [msg]
 * @param {string} categoryId  - e.g. "cat_ai"
 * @param {object} [opts]
 * @returns {Promise<void>}
 */
async function openCommandList(sock, jid, msg, categoryId, opts = {}) {
  return forwardPremiumMenu(sock, jid, msg, [categoryId]);
}

// ─── Wizard opener ────────────────────────────────────────────────────────────

/**
 * Start a wizard session for a command that needs user input.
 * Sends the wizard prompt and registers the session.
 *
 * @param {object} sock
 * @param {string} jid
 * @param {object} [msg]
 * @param {string} commandName
 * @param {object} [opts]
 * @param {string} [opts.effectiveJid]  - Sender JID in groups
 * @returns {Promise<void>}
 */
async function openWizard(sock, jid, msg, commandName, opts = {}) {
  const spec = COMMAND_INPUTS[commandName];
  if (!spec) {
    // No wizard needed — dispatch immediately
    try {
      if (typeof globalThis.__MIAS_DISPATCH_CMD__ === "function") {
        await globalThis.__MIAS_DISPATCH_CMD__(sock, msg, commandName, []);
      }
    } catch {}
    return;
  }

  const prefix      = _prefix();
  const effectiveJid = opts.effectiveJid || jid;
  const timeout     = opts.timeoutMs ?? 90_000;

  // Register session
  startWizardSession(effectiveJid, commandName, { timeoutMs: timeout });
  if (effectiveJid !== jid) startWizardSession(jid, commandName, { timeoutMs: timeout });

  const promptText = [
    `*${_botName()} — ${commandName.toUpperCase()}*`,
    LINE,
    spec.prompt,
    "",
    `_Reply with your input. Type *cancel* to exit._`,
    `_Session expires in ${Math.round(timeout / 1000)}s._`,
  ].join("\n");

  return sendText(sock, jid, promptText, { quoted: msg });
}

// ─── Command help card ────────────────────────────────────────────────────────

/**
 * Show a detailed help card for a single command.
 *
 * @param {object} sock
 * @param {string} jid
 * @param {object} [msg]
 * @param {string} commandName
 * @param {object} [opts]
 * @returns {Promise<void>}
 */
async function showCommandHelp(sock, jid, msg, commandName, opts = {}) {
  const cmd    = findCommand(commandName);
  const prefix = _prefix();
  const spec   = COMMAND_INPUTS[commandName];

  const lines = [
    `*${prefix}${commandName}*`,
    LINE,
    cmd ? `Category : ${cmd.categoryLabel}` : "",
    cmd ? `Desc     : ${cmd.desc}` : `No description available.`,
    spec ? `Input    : ${spec.prompt}` : `Input    : None required`,
    LINE,
    `Usage: ${prefix}${commandName}${spec ? " <input>" : ""}`,
  ].filter(s => s !== "");

  const caps = await getCapabilities(sock);
  if (caps.buttons) {
    try {
      return await sendButtons(sock, jid, lines.join("\n"), [
        { text: "Run", id: `cmd_${commandName}` },
        { text: "Back", id: "btn_back" },
      ], {
        footer: `${prefix}menu to return home`,
        quoted: msg,
      });
    } catch {}
  }

  return sendText(sock, jid, lines.join("\n"), { quoted: msg });
}

// ─── Status screens ───────────────────────────────────────────────────────────

/**
 * Show a formatted error screen.
 * @param {object} sock
 * @param {string} jid
 * @param {object} [msg]
 * @param {string} text   - Error message
 * @param {object} [opts]
 */
async function showError(sock, jid, msg, text, opts = {}) {
  const body = [
    `*Error*`,
    LINE,
    String(text || "An unexpected error occurred."),
    LINE,
    `Type *${_prefix()}menu* to return to the menu.`,
  ].join("\n");
  return sendText(sock, jid, body, { quoted: msg });
}

/**
 * Show a formatted success screen.
 * @param {object} sock
 * @param {string} jid
 * @param {object} [msg]
 * @param {string} text
 * @param {object} [opts]
 */
async function showSuccess(sock, jid, msg, text, opts = {}) {
  const body = [
    `*Done*`,
    LINE,
    String(text || "Operation completed successfully."),
  ].join("\n");
  return sendText(sock, jid, body, { quoted: msg });
}

/**
 * Show a loading state (typing indicator + optional text).
 * @param {object} sock
 * @param {string} jid
 * @param {object} [msg]
 * @param {object} [opts]
 * @param {string} [opts.text]  - Loading message (default: "Processing...")
 */
async function showLoading(sock, jid, msg, opts = {}) {
  try {
    if (typeof sock.sendPresenceUpdate === "function") {
      await sock.sendPresenceUpdate("composing", jid);
    }
  } catch {}
  if (opts.text) {
    return sendText(sock, jid, opts.text, { quoted: msg });
  }
}

/**
 * Show a hero banner image (menu cover / branding image).
 * Falls back to plain text if image is unavailable.
 *
 * @param {object} sock
 * @param {string} jid
 * @param {object} [msg]
 * @param {object} [opts]
 * @param {string|Buffer} [opts.image] - Image URL or Buffer
 * @param {string} [opts.caption]
 */
async function showHeroBanner(sock, jid, msg, opts = {}) {
  const { createRequire } = await import("module");
  const require = createRequire(import.meta.url);
  const path = await import("path");
  const { fileURLToPath } = await import("url");
  const __dir = path.dirname(fileURLToPath(import.meta.url));
  const coverPath = path.resolve(__dir, "../assets/menu-cover.jpg");

  const caption = opts.caption || _botName();

  try {
    const fs = await import("fs/promises");
    let imgBuf = null;
    if (opts.image) {
      if (Buffer.isBuffer(opts.image)) {
        imgBuf = opts.image;
      } else if (typeof opts.image === "string" && (opts.image.startsWith("http://") || opts.image.startsWith("https://"))) {
        const { fetchBuffer } = await import("./uploadHandler.js");
        imgBuf = await fetchBuffer(opts.image).catch(() => null);
      }
    }
    if (!imgBuf) {
      imgBuf = await fs.readFile(coverPath).catch(() => null);
    }
    if (imgBuf) {
      return await sendImage(sock, jid, imgBuf, { caption, quoted: msg });
    }
  } catch {}

  return sendText(sock, jid, caption, { quoted: msg });
}

/**
 * Show the bot profile card (vCard with profile picture).
 * @param {object} sock
 * @param {string} jid
 * @param {object} [msg]
 * @param {object} [opts]
 */
async function showProfileCard(sock, jid, msg, opts = {}) {
  return sendBotVCard(sock, jid, { quoted: msg, withPic: true, ...opts });
}

// ─── Navigation aliases ───────────────────────────────────────────────────────

/** Alias for openHome */
const goHome = openHome;

/** Go back to the category selector */
const goBack = openCategorySelector;

/** Reload the home screen (alias for openHome) */
const refresh = openHome;

/**
 * Close / dismiss the current session.
 * Clears any active wizard session and sends a farewell message.
 *
 * @param {object} sock
 * @param {string} jid
 * @param {object} [msg]
 * @param {object} [opts]
 */
async function close(sock, jid, msg, opts = {}) {
  const prefix = _prefix();
  try {
    const { clearWizardSession } = await import("./wizardHandler.js");
    clearWizardSession(jid);
    const isGrp = (jid || "").endsWith("@g.us");
    const sJid  = isGrp ? (msg?.key?.participant || msg?.participant || jid) : jid;
    if (sJid !== jid) clearWizardSession(sJid);
  } catch {}
  return sendText(sock, jid,
    `Closed. Type *${prefix}menu* to return to the menu.`,
    { quoted: msg }
  );
}

// ─── Exported UI namespace ────────────────────────────────────────────────────

/**
 * The UI Manager singleton.
 * Import and use as:
 *   import { UI } from "./uiHandler.js";
 *   await UI.openHome(sock, jid, msg, { userName: "David" });
 */
export const UI = {
  openHome,
  openCategory:    openCommandList,
  openCommandList,
  openCategorySelector,
  openWizard,
  goHome,
  goBack,
  refresh,
  close,
  showHeroBanner,
  showProfileCard,
  showCommandHelp,
  showError,
  showSuccess,
  showLoading,
};

// Named exports for convenience
export {
  openHome,
  openCommandList,
  openCategorySelector,
  openWizard,
  goHome,
  goBack,
  refresh,
  close,
  showHeroBanner,
  showProfileCard,
  showCommandHelp,
  showError,
  showSuccess,
  showLoading,
};
