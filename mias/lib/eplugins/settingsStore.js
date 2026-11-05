/**
 * Levanter's plugin settings helpers: setVar/getVars, setData/getData/delData,
 * setFilter/getFilter/deleteFilter and setAmenu/getAmenu/delAmenu (Levanter lib/index.js
 * and lib/db). Copyright (c) lyfe00011, MIT License (see LICENSE-LEVANTER.txt).
 *
 * The behaviour below follows Levanter's decoded source:
 *   - lib/vars.js     setVar normalises values (b6), getVars hides SECRET_ keys (unless raw)
 *   - lib/db/data.js  setData stores JSON; getData parses it and returns false when a key is missing
 *   - lib/db/filter.js  getFilter returns a list (empty when none)
 *   - lib/db/amenu.js   names are words (\b\w+\b), unknown names are dropped, errors only when none are valid
 *
 * Storage: one JSON file (eplugin-settings.json next to the plugin table), written
 * atomically. Keys are per session, as in Levanter.
 */
import fs from "node:fs";
import path from "node:path";

const EMPTY = () => ({ vars: {}, data: {}, filters: {}, amenu: {} });

function readFile(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return { ...EMPTY(), ...(parsed && typeof parsed === "object" ? parsed : {}) };
  } catch (error) {
    if (error?.code === "ENOENT") return EMPTY();
    throw error;
  }
}

function writeFile(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

const bucket = (obj, session) => {
  const key = String(session ?? "0");
  if (!obj[key] || typeof obj[key] !== "object") obj[key] = {};
  return obj[key];
};

// Levanter lib/vars.js b6: undefined and "off" become "false", "on" becomes "true".
// SECRET_ keys are stored exactly as given (Levanter writes them to the environment raw).
export function normalizeVarValue(key, value) {
  if (String(key).startsWith("SECRET_")) return String(value);
  if (value === undefined || value === "off") return "false";
  if (value === "on") return "true";
  return String(value);
}

// Levanter lib/db/amenu.js: the names are the words in the input, lowercase, unique.
const amenuWords = (input) => [...new Set(String(input).toLowerCase().trim().match(/\b\w+\b/g) || [])];

// Levanter lib/db/amenu.js ac(): the same checks, in the same order.
function amenuInputError(input, chat, session) {
  if (!input || typeof input !== "string" || input.trim().length === 0) return "Command must be a non-empty string";
  if (!chat || typeof chat !== "string" || chat.trim().length === 0) return "Chat must be a non-empty string";
  if (!session || typeof session !== "string") return "Session must be a non-empty string";
  if (input.length > 5000) return "Command string too long (max 5000 characters)";
  return null;
}

/**
 * @param {object} opts
 * @param {() => string|null} opts.resolveFile   path of the JSON file; null when storage is unavailable
 * @param {(name: string) => boolean} opts.isCommand  true for a registered command or alias
 */
export function createSettingsStore({ resolveFile, isCommand = () => true }) {
  function file() {
    const f = resolveFile();
    if (!f) throw new Error("plugin settings storage is not available");
    return f;
  }
  function update(mutate) {
    const f = file();
    const state = readFile(f);
    const out = mutate(state);
    writeFile(f, state);
    return out;
  }
  const read = (mutate) => mutate(readFile(file()));

  // ---- vars (setVar / getVars) ----
  // Returns the normalised values, so the caller can set them in the process environment.
  function setVar(obj, session = "0") {
    if (!obj || typeof obj !== "object") throw new Error("setVar needs an object");
    return update((s) => {
      const b = bucket(s.vars, session);
      const out = {};
      for (const [k, v] of Object.entries(obj)) {
        out[k] = normalizeVarValue(k, v);
        b[k] = out[k];
      }
      return out;
    });
  }
  // Levanter getVars(session, raw): SECRET_ keys are left out unless raw is true.
  function getVars(session = "0", raw = false) {
    return read((s) => {
      const all = { ...(s.vars[String(session)] || {}) };
      if (raw) return all;
      return Object.fromEntries(Object.entries(all).filter(([k]) => !k.startsWith("SECRET_")));
    });
  }
  // Every stored variable, as a plain map. Used at boot to restore the process environment.
  function allVars() {
    return read((s) => {
      const out = {};
      for (const sess of Object.values(s.vars)) Object.assign(out, sess || {});
      return out;
    });
  }

  // ---- data (setData / getData / delData) ----
  function setData(key, value, session = "0") {
    return update((s) => {
      bucket(s.data, session)[String(key)] = JSON.stringify(value) ?? null;
      return true;
    });
  }
  // Levanter getData(key, session): parsed value, false when missing; no key returns every value.
  function getData(key, session = "0") {
    return read((s) => {
      const b = s.data[String(session)] || {};
      const parse = (raw) => {
        if (raw === null) return null;
        try { return JSON.parse(raw); } catch { return raw; }
      };
      if (key === undefined) {
        return Object.fromEntries(Object.entries(b).map(([k, raw]) => [k, parse(raw)]));
      }
      return Object.prototype.hasOwnProperty.call(b, String(key)) ? parse(b[String(key)]) : false;
    });
  }
  function delData(key, session = "0") {
    return update((s) => {
      const b = bucket(s.data, session);
      if (!Object.prototype.hasOwnProperty.call(b, String(key))) return false;
      delete b[String(key)];
      return true;
    });
  }

  // ---- filters (setFilter / getFilter / deleteFilter) ----
  const filterList = (s, type, session) => {
    const b = bucket(s.filters, session);
    if (!Array.isArray(b[type])) b[type] = [];
    return b[type];
  };
  function setFilter(type, pattern, text, isRegex = false, session = "0") {
    return update((s) => {
      const list = filterList(s, String(type), session);
      const row = { pattern: String(pattern), text: String(text ?? ""), regex: !!isRegex };
      const i = list.findIndex((f) => f.pattern === row.pattern);
      if (i >= 0) list[i] = row; else list.push(row);
      return row;
    });
  }
  // Levanter getFilter returns the rows, an empty list when there are none.
  function getFilter(type, session = "0") {
    return read((s) => {
      const list = (s.filters[String(session)] || {})[String(type)] || [];
      return list.map((f) => ({ ...f }));
    });
  }
  function deleteFilter(type, pattern, session = "0") {
    return update((s) => {
      const list = filterList(s, String(type), session);
      const i = list.findIndex((f) => f.pattern === String(pattern));
      if (i < 0) return false;
      list.splice(i, 1);
      return true;
    });
  }

  // ---- group menu (setAmenu / getAmenu / delAmenu) ----
  const menuRow = (s, chat, session) => {
    const b = bucket(s.amenu, session);
    return b[String(chat)];
  };
  // Levanter getAmenu: the stored commands that are still registered, or null when empty.
  function getAmenu(chat, session = "0") {
    if (!chat || !session) return null;
    return read((s) => {
      const list = (menuRow(s, chat, session) || []).filter((n) => isCommand(n));
      return list.length ? list : null;
    });
  }
  // Levanter setAmenu: unknown names are dropped; an error only when none are valid,
  // or when one of the valid names is already in the menu.
  function setAmenu(chat, input, session = "0") {
    const err = amenuInputError(input, chat, session);
    if (err) return { error: err };
    const words = amenuWords(input);
    const valid = words.filter((n) => isCommand(n));
    if (valid.length === 0) {
      return { error: "No valid commands provided", invalidCommands: words };
    }
    return update((s) => {
      const b = bucket(s.amenu, session);
      const existing = Array.isArray(b[String(chat)]) ? b[String(chat)] : null;
      if (!existing) {
        b[String(chat)] = [...valid];
        return [...valid];
      }
      const duplicates = valid.filter((n) => existing.includes(n));
      if (duplicates.length) return { error: "Commands already added", duplicates, existing: [...existing] };
      b[String(chat)] = [...existing, ...valid];
      return [...valid];
    });
  }
  // Levanter delAmenu: 'all' or 'clear' removes the menu; otherwise the names that were removed.
  function delAmenu(chat, input, session = "0") {
    const err = amenuInputError(input, chat, session);
    if (err) return { error: err };
    return update((s) => {
      const b = bucket(s.amenu, session);
      const existing = Array.isArray(b[String(chat)]) ? b[String(chat)] : null;
      if (!existing) return { error: "No menu found for this group" };
      const lowered = String(input).toLowerCase().trim();
      if (lowered === "all" || lowered === "clear") {
        delete b[String(chat)];
        return "all";
      }
      const wanted = new Set(amenuWords(input));
      const removed = existing.filter((n) => wanted.has(n));
      const remaining = existing.filter((n) => !wanted.has(n));
      if (removed.length === 0) {
        return { error: "Command not found", notFound: [...wanted], existing: [...existing] };
      }
      if (remaining.length === 0) delete b[String(chat)];
      else b[String(chat)] = remaining;
      return removed;
    });
  }

  return {
    setVar, getVars, allVars, setData, getData, delData,
    setFilter, getFilter, deleteFilter,
    getAmenu, setAmenu, delAmenu,
  };
}
