"use strict";

/** Resolve the leading bare token only in explicit no-prefix mode. */
function parseBareCommand(text, isKnownCommand) {
  const raw = String(text || "").trim();
  if (!raw) {
    return { isCommand: false, prefix: null, raw: "", name: "" };
  }
  // When in no-prefix mode (.setprefix none / null), using a prefix (. ! / # etc.) goes completely silent.
  // Any message starting with punctuation or a symbol is not a bare command.
  if (/^[^\p{L}\p{N}\s]/u.test(raw)) {
    return { isCommand: false, prefix: null, raw: "", name: "" };
  }
  const name = (raw.split(/\s+/)[0] || "").toLowerCase();
  if (!name || typeof isKnownCommand !== "function" || !isKnownCommand(name)) {
    return { isCommand: false, prefix: null, raw: "", name: "" };
  }
  return { isCommand: true, prefix: "", raw, name };
}

module.exports = { parseBareCommand };
