/**
 * Levanter's bot() rules, ported from its decoded source (lib/events.js addCommand
 * and lib/handle.js command matching). Copyright (c) lyfe00011, MIT License
 * (see LICENSE-LEVANTER.txt).
 */

// Levanter's `on:` event types (lib/events.js).
export const EVENT_TYPES = ["photo", "image", "text", "sticker", "message", "event", "reaction.message"];

// Levanter's command name rule: `ao` in lib/events.js.
const NAME_RULE = /(\W*)([A-Za-z0-9_ğüşiö ç]*)/;

export function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The command name of a pattern: "kik ?(.*)" -> "kik". */
export function nameFromPattern(pattern) {
  const m = String(pattern || "").match(NAME_RULE);
  return m ? m[2].trim() : "";
}

/**
 * Normalises a bot() call with Levanter's defaults. Note `fromMe` defaults to
 * true, so a plugin is owner-only unless it says `fromMe: false`.
 */
export function normalizeBotOptions(opts, handler) {
  if (typeof handler !== "function") {
    throw new Error("bot(): the second argument must be a handler function.");
  }
  const u = opts && typeof opts === "object" ? opts : {};
  const pattern = u.pattern ? String(u.pattern) : "";
  const on = u.on ? String(u.on) : "";
  if (!pattern && !on) {
    throw new Error("bot(): a pattern is required (or an on: event type).");
  }
  if (!pattern && !EVENT_TYPES.includes(on)) {
    throw new Error(`bot(): unknown on: "${on}". Use one of ${EVENT_TYPES.join(", ")}.`);
  }
  return {
    name: pattern ? nameFromPattern(pattern) : String(u.type || ""),
    pattern: pattern || null,
    on: !pattern ? on : null,
    fromMe: u.fromMe ?? true,
    onlyGroup: u.onlyGroup ?? false,
    desc: u.desc ?? "",
    dontAddCommandList: u.dontAddCommandList ?? false,
    type: u.type ? String(u.type) : pattern ? "misc" : undefined,
    event_action: u.event_action ?? "",
    handler,
  };
}

/** Levanter's compiled command regex: ^[prefix](pattern| pattern), flags "is". */
export function buildPatternRegex(prefix, pattern) {
  const head = prefix ? `^(?:${escapeRegExp(prefix)})` : "^";
  return new RegExp(`${head}(${pattern}| ${pattern})`, "is");
}

/** The `match` argument Levanter passes to a command handler (lib/handle.js). */
export function pickMatchArg(m) {
  if (!m) return "";
  const v = m.length > 6
    ? (m[3] === undefined ? m[4] : m[3])
    : (m[2] === undefined ? m[3] : m[2]);
  return v || "";
}

/** Maps a Levanter `type` to a MIAS menu category. */
export function categoryFor(type) {
  const t = String(type || "").trim().toLowerCase();
  if (t === "group") return "GROUP";
  if (t === "plugin") return "CREATOR";
  return "PLUGINS";
}

/** Does an `on:` handler fire for this message content? */
export function matchesEvent(on, content) {
  const c = content || {};
  switch (on) {
    case "photo":
    case "image": return !!c.imageMessage;
    case "text": return !!(c.conversation || c.extendedTextMessage);
    case "sticker": return !!c.stickerMessage;
    case "message": return Object.keys(c).length > 0;
    // Levanter's levanter.on("reaction.message"): a reaction was added or removed.
    case "reaction.message": return !!c.reactionMessage;
    default: return false;
  }
}
