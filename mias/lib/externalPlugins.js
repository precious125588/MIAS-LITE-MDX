/**
 * External plugins for MIAS MDX, ported from Levanter (MIT, Copyright (c) lyfe00011,
 * see eplugins/LICENSE-LEVANTER.txt):
 *   - plugins/plugins.js            the `plugin` and `remove` commands (run unchanged)
 *   - lib/index.js                  installPlugin / removePlugin
 *   - lib/client.js                 loadPlugins (built-in) and loadExternalPlugins (restore at boot)
 *   - lib/db/plugins.js             the Plugin table (see eplugins/pluginStore.js)
 *
 * Differences, on purpose:
 *   - plugin code is kept in the database as well as eplugins/, so it still loads
 *     after a redeploy when its gist cannot be reached;
 *   - a plugin cannot replace a built-in command (Levanter overwrites silently);
 *   - the `on:` event types run for incoming messages (Levanter's behaviour);
 *   - an owner-only `fromMe` handler never runs for other people, and a public one
 *     never runs for the bot's own messages, so there are no reply loops.
 *
 * Plugins run with the bot's privileges. Install only plugins you trust.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createPluginStore } from "./eplugins/pluginStore.js";
import { createSettingsStore } from "./eplugins/settingsStore.js";
import { createLibShim, LANG, installStringFormat, parseGistUrls } from "./eplugins/libShim.js";
import { buildPatternRegex, pickMatchArg, categoryFor, matchesEvent } from "./eplugins/dispatchRules.js";
import { createMessage, contentOf } from "./eplugins/messageApi.js";

/** Levanter's default session id. MIAS runs one bot per AUTH_DIR, so it is always "0". */
export const SESSION = "0";
export const MAX_PLUGIN_BYTES = 1024 * 1024;
const LIB_ID = /^(?:\.{1,2}\/)*lib(?:\/index(?:\.js|\.cjs)?)?\/?$/;
const SAFE_NAME = /^[A-Za-z0-9_-]{1,64}$/;
// Plugins whose argument is a group member's number. On a reply, the quoted member's number is used
// when the command gives none, so `.kik` and `.kik kick` act on the person replied to (Levanter's kik gist
// only reads the number it is typed).
const REPLY_TARGET_COMMANDS = new Set(["kik"]);

export function createExternalPluginSystem(host) {
  installStringFormat();
  const libDir = host.libDir;
  const eplugDir = host.pluginDir || path.join(libDir, "..", "eplugins");
  const builtinDir = path.join(libDir, "eplugins", "builtin");
  const log = host.log || console.log;
  const warn = host.warn || console.warn;
  const version = host.version || "MIAS MDX";
  const platform = host.platform || process.platform;
  const loaded = new Map();     // name -> entry
  const eventHandlers = [];     // { plugin, on, fromMe, handler }
  let restoreDone = false;

  const store = createPluginStore({ resolve: host.resolveStore });
  const settings = createSettingsStore({
    resolveFile: () => host.settingsFile || null,
    isCommand: (n) => host.commands.has(n) || host.aliases.has(n),
  });
  // Levanter writes saved variables into the process environment at boot (preparevars).
  try {
    for (const [k, v] of Object.entries(settings.allVars())) process.env[k] = v;
  } catch (error) {
    console.error("[eplugin] could not restore saved variables:", error.message);
  }
  const prefix = () => String(host.prefix?.() ?? ".");
  // Levanter's config values a plugin can read from its context (the config.js keys it uses).
  // Anything else a plugin needs is a saved variable (.setvar), merged in by buildCtx().
  const configDefaults = () => ({
    SUDO: process.env.SUDO || "",
    MAX_UPLOAD: process.env.MAX_UPLOAD || "230",
    STICKER_PACKNAME: process.env.STICKER_PACKNAME || "❤️,LyFE",
    ...(process.env.LANGUAG ? { LANGUAG: process.env.LANGUAG } : {}),
  });
  const pluginFile = (name, session = SESSION) => path.join(eplugDir, `${session}${name}.js`);

  /**
   * The command table as Levanter's `commands` list: one entry per command name (aliases skipped).
   * `visible` is the set .allmenu shows for this chat and caller; when given, only those names are listed.
   */
  function commandTable(visible = null) {
    const list = [];
    for (const [name, entry] of host.commands) {
      if (entry.isAlias) continue;
      // A disabled command is blocked at dispatch and hidden from menus, so it is not listed here either.
      if (entry.disabled === true || host.isDisabled?.(name)) continue;
      // Hidden from .allmenu (adult/NSFW categories, removed categories, hidden entries) means not listed here either.
      if (visible && !visible.has(name)) continue;
      list.push({
        name,
        pattern: `${name} ?(.*)`,
        desc: entry.desc || "",
        type: String(entry.category || "misc").toLowerCase(),
        fromMe: !!(entry.ownerOnly || entry.fromMe),
        onlyGroup: !!entry.onlyGroup,
        active: true,
        dontAddCommandList: !!(entry.hidden || entry.dontAddCommandList),
        ...(entry.eplugin ? { eplugin: entry.eplugin } : {}),
      });
    }
    return list;
  }

  /**
   * Levanter's third handler argument (lib/handle.js: `{ ...env, commands, PREFIX, ...AFK, pluginsCount }`),
   * built fresh for each call so it always lists the commands installed right now.
   */
  function savedVars() {
    try {
      return settings.allVars();
    } catch {
      return {}; // no settings file on this host: the config defaults still apply
    }
  }

  function buildCtx(visible = null) {
    return {
      ...configDefaults(),
      ...savedVars(),
      commands: commandTable(visible),
      PREFIX: prefix(),
      VERSION: version,
      pluginsCount: { count: loaded.size },
    };
  }

  function nameFromFile(filePath, session) {
    let base = path.basename(filePath, ".js");
    const s = String(session);
    if (base.startsWith(s) && base.length > s.length) base = base.slice(s.length);
    return base;
  }

  /** Runs a plugin file once and returns the bot() registrations it made. */
  function compile(source, filePath, session) {
    const regs = [];
    const lib = createLibShim({
      bot: (normalized) => regs.push(normalized),
      store,
      manager: api,
      httpGet: host.httpGet,
      session,
      settings,
      plugins: () => [...loaded.keys()],
      groupSubject: host.groupSubject,
      pushName: host.pushName,
      wcgFile: host.wcgFile,
    });
    const requireFn = (id) => {
      const mod = String(id || "");
      if (LIB_ID.test(mod)) return lib;
      // Levanter's config.js: the plugins read VERSION (and PREFIX) from it.
      if (/^(?:\.{1,2}\/)+config(?:\.js)?$/.test(mod)) return { VERSION: version, PREFIX: prefix() };
      // Levanter's lib/pm2.js restarts another bot instance. A MIAS bot is restarted by its host.
      if (/^(?:\.{1,2}\/)+lib\/pm2(?:\.js)?$/.test(mod)) {
        return {
          restartInstance: async () => {
            throw new Error("restarting a bot from a plugin is not supported on MIAS. Restart the bot from your hosting dashboard.");
          },
        };
      }
      if (mod.startsWith(".") || mod.startsWith("/")) {
        throw new Error(`the plugin requires the local file "${mod}". External plugins must be a single file.`);
      }
      try {
        return host.requireFn(mod);
      } catch (error) {
        if (error?.code === "MODULE_NOT_FOUND") throw new Error(`module "${mod}" is not installed on this bot.`);
        throw error;
      }
    };
    // Node's require.resolve and require.cache: plugins call them to check for, or reload, a module.
    requireFn.resolve = (id) => {
      try {
        requireFn(id);
      } catch {
        throw Object.assign(new Error(`Cannot find module '${id}'`), { code: "MODULE_NOT_FOUND" });
      }
      return String(id);
    };
    requireFn.cache = {};
    // importModuleDynamically lets a plugin use import() (Levanter's plugins run as normal modules).
    const wrapper = new vm.Script(
      `(function (exports, require, module, __filename, __dirname) {\n${source}\n})`,
      { filename: filePath, importModuleDynamically: (specifier) => import(specifier) },
    ).runInThisContext();
    const module = { exports: {} };
    wrapper.call(module.exports, module.exports, requireFn, module, filePath, libDir);
    return regs;
  }

  // The .cm Gist prefixes every command with ✗, so enabled commands look disabled. Only that marker is removed.
  const stripCmMarks = (t) => t.replace(/(│\s*)✗\s?/g, "$1");

  function reservedName(n) {
    return n.startsWith("dc") || n.startsWith("tts") || n.includes("disabled");
  }

  // Levanter's pattern names: the leading word of the pattern ("play ?(.*)" is "play").
  function renamePattern(pattern, token, newToken) {
    const m = String(pattern).match(/^(\W*)([A-Za-z0-9_]+)/);
    if (!m || m[2].toLowerCase() !== token) return pattern;
    return m[1] + newToken + String(pattern).slice(m[0].length);
  }

  /**
   * A command that already exists (another plugin, a built-in command, or an alias) is not replaced.
   * The plugin's command is installed under the first free name instead: play -> play1, play2, ...
   * Reinstalling the same plugin keeps its names. Returns the renames made.
   */
  function renameDuplicates(name, regs) {
    const taken = (n) => {
      if (host.isDisabled?.(n)) return true;
      const existing = host.commands.get(n);
      if (existing) return existing.eplugin !== name;
      return host.aliases.has(n);
    };
    const claimed = new Set(regs.filter((r) => r.pattern).map((r) => r.name.split(/\s+/)[0].toLowerCase()));
    const mapping = new Map();
    const renamed = [];
    for (const reg of regs) {
      if (!reg.pattern) continue;
      const first = reg.name.split(/\s+/)[0];
      const n = first.toLowerCase();
      if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(n) || reservedName(n)) continue; // conflicts() reports these
      if (!mapping.has(n)) {
        if (!taken(n)) continue;
        let i = 1;
        let cand = `${n}${i}`;
        while ((taken(cand) || claimed.has(cand) || reservedName(cand)) && i < 1000) {
          i += 1;
          cand = `${n}${i}`;
        }
        claimed.add(cand);
        mapping.set(n, cand);
        renamed.push({ from: n, to: cand });
      }
      const cand = mapping.get(n);
      reg.pattern = renamePattern(reg.pattern, n, cand);
      reg.name = cand + reg.name.slice(first.length);
    }
    return renamed;
  }

  function conflicts(name, regs) {
    const problems = [];
    for (const reg of regs) {
      if (!reg.pattern) continue;
      const n = reg.name.split(/\s+/)[0].toLowerCase();
      if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(n)) {
        problems.push(`"${reg.name}" is not a valid command name (letters, digits, - or _, starting with a letter)`);
        continue;
      }
      if (reservedName(n)) {
        problems.push(`.${n} uses a name MIAS reserves`);
        continue;
      }
      if (host.isDisabled?.(n)) {
        problems.push(`.${n} is disabled on this bot`);
        continue;
      }
      const existing = host.commands.get(n);
      if (existing && existing.eplugin !== name) {
        problems.push(`.${n} already exists${existing.eplugin ? ` (plugin ${existing.eplugin})` : " as a built-in command"}`);
      } else if (!existing && host.aliases.has(n)) {
        problems.push(`.${n} is already an alias of another command`);
      }
    }
    return problems;
  }

  async function reportError(sock, msg, cmdName, text, error) {
    const jid = msg?.key?.remoteJid || "";
    const baseText = error?.message || String(error);
    const errText = error?.reason ? `${baseText} (${error.reason})` : baseText;
    warn(`[eplugin] ❌ ${cmdName} failed: ${error?.stack || errText}`);
    const body = LANG.extra.error_message.format(version, text, errText, jid, cmdName, platform);
    await sock.sendMessage(jid, { text: body }, { quoted: msg }).catch(() => {});
  }

  /** Reacts to the command message through the bot's own reaction helper (it honours the cmdReact switch). */
  function reactTo(sock, msg, emoji) {
    try {
      if (typeof host.react === "function") return Promise.resolve(host.react(sock, msg, emoji)).catch(() => {});
      const key = { remoteJid: msg.key.remoteJid, fromMe: msg.key.fromMe ?? false, id: msg.key.id };
      if (msg.key.participant) key.participant = msg.key.participant;
      return sock.sendMessage(msg.key.remoteJid, { react: { text: emoji, key } }).catch(() => {});
    } catch {
      return Promise.resolve();
    }
  }

  /** The quoted member's phone number, as the plugin matches it. Falls back to the quoted JID's digits. */
  async function quotedMemberNumber(message, groupJid, target) {
    const digits = (j) => String(j || "").split("@")[0].split(":")[0].replace(/\D/g, "");
    try {
      const members = await message.groupMetadata(groupJid);
      const hit = members.find((p) => p.rawId === target || p.id === target);
      if (hit) return digits(hit.id);
    } catch { /* fall through to the quoted JID */ }
    return digits(target);
  }

  /** The names .allmenu shows for this chat and caller, so a plugin's command list matches it. Null when unknown. */
  async function menuNamesFor(sock, msg) {
    if (typeof host.menuCommandNames !== "function") return null;
    try {
      const names = await host.menuCommandNames(sock, msg);
      return names instanceof Set ? names : null;
    } catch {
      return null;
    }
  }

  function makeCommandRunner(cmdName, list) {
    return async (sock, msg) => {
      const jid = msg?.key?.remoteJid || "";
      const group = jid.endsWith("@g.us");
      const text = String(host.getBody?.(msg) ?? "");
      let chosen = null;
      let found = null;
      const prefixes = typeof host.prefixes === "function" ? host.prefixes() : [prefix()];
      outer: for (const reg of list) {
        if (reg.fromMe && !msg?.key?.fromMe) continue;
        for (const pfx of prefixes) {
          const m = text.match(buildPatternRegex(pfx, reg.pattern));
          if (m) { chosen = reg; found = m; break outer; }
        }
      }
      if (!chosen) return;
      // Hardened: a disabled command never runs, even from a plugin installed before it was disabled.
      if (host.isDisabled?.(chosen.name)) {
        await reactTo(sock, msg, "❌");
        await sock.sendMessage(jid, { text: `❌ .${chosen.name} is disabled on this bot.` }, { quoted: msg }).catch(() => {});
        return;
      }
      if (chosen.onlyGroup && !group) {
        await reactTo(sock, msg, "❌");
        await sock.sendMessage(jid, { text: LANG.extra.group_cmd }).catch(() => {});
        return;
      }
      const track = { failed: false };
      const message = createMessage({ sock, msg, session: SESSION, text, host: { httpGet: host.httpGet, getSender: host.getSender, baileys: host.baileys, isSudo: host.isSudo }, textFilter: chosen.name === "cm" ? stripCmMarks : null, track });
      let arg = pickMatchArg(found);
      if (REPLY_TARGET_COMMANDS.has(String(chosen.name).replace(/\d+$/, "")) && group && !/\d/.test(String(arg || ""))) {
        const quoted = message.reply_message?.jid;
        if (quoted) {
          arg = [await quotedMemberNumber(message, jid, quoted), arg].filter(Boolean).join(" ");
        } else if (/kick/i.test(String(arg || ""))) {
          // Without a reply or a number, "kick" alone would match every member. Refuse it here.
          await reactTo(sock, msg, "❌");
          await sock.sendMessage(jid, { text: "❌ Reply to the person, or give their number: .kik 2349012345678 kick" }, { quoted: msg }).catch(() => {});
          return;
        }
      }
      await reactTo(sock, msg, "🌀");
      try {
        const visible = await menuNamesFor(sock, msg);
        await chosen.handler(message, arg, buildCtx(visible));
        // A plugin can catch its own error and report it in a message, so the reaction also reads the failure marks.
        await reactTo(sock, msg, track.failed ? "❌" : "✅");
      } catch (error) {
        await reactTo(sock, msg, "❌");
        await reportError(sock, msg, cmdName, text, error);
      }
    };
  }

  function registerCommands(name, regs) {
    const byName = new Map();
    for (const reg of regs) {
      if (!reg.pattern) continue;
      const n = reg.name.split(/\s+/)[0].toLowerCase();
      if (!byName.has(n)) byName.set(n, []);
      byName.get(n).push(reg);
    }
    const commands = [];
    for (const [n, list] of byName) {
      const category = categoryFor(list[0].type);
      const ownerOnly = list.every((r) => r.fromMe);
      const hidden = list.every((r) => r.dontAddCommandList);
      const desc = list[0].desc || "External plugin command";
      host.cmd([n], { desc, category, ownerOnly, eplugin: name, pluginCommand: true }, makeCommandRunner(n, list));
      const entry = host.commands.get(n);
      if (!entry || entry.eplugin !== name) throw new Error(`.${n} could not be registered`);
      if (!hidden) host.addMenu?.(n, category);
      commands.push({ name: n, category, ownerOnly, hidden, desc, onlyGroup: list.every((r) => r.onlyGroup) });
    }
    return commands;
  }

  function registerEvents(name, regs) {
    const events = [];
    for (const reg of regs) {
      if (reg.pattern) continue;
      const entry = { plugin: name, on: reg.on, fromMe: reg.fromMe, handler: reg.handler };
      eventHandlers.push(entry);
      events.push(entry);
    }
    return events;
  }

  function unregister(name) {
    const removed = [];
    for (const [cmd, entry] of [...host.commands]) {
      if (entry?.eplugin !== name) continue;
      host.commands.delete(cmd);
      host.aliases.delete(cmd);
      host.removeMenu?.(cmd);
      removed.push(cmd);
    }
    for (let i = eventHandlers.length - 1; i >= 0; i--) {
      if (eventHandlers[i].plugin === name) eventHandlers.splice(i, 1);
    }
    loaded.delete(name);
    return removed;
  }

  /** Compiles, checks and registers one plugin. A failure leaves the previous version in place. */
  function loadSource({ name, file, source, session, announce, url }) {
    if (!SAFE_NAME.test(name)) throw new Error(LANG.plugins.plugin.invalid);
    if (Buffer.byteLength(source, "utf8") > MAX_PLUGIN_BYTES) {
      throw new Error(`the plugin is larger than ${MAX_PLUGIN_BYTES / 1024} KB.`);
    }
    let regs;
    try {
      regs = compile(source, file, session);
    } catch (error) {
      throw new Error(`the plugin failed to load: ${error?.message || error}`);
    }
    if (!regs.length) throw new Error("no bot(...) commands were found in this plugin.");
    for (const { from, to } of renameDuplicates(name, regs)) {
      log(`[eplugin] ⚠️ .${from} already exists, so this plugin's command is installed as .${to}`);
    }
    const problems = conflicts(name, regs);
    if (problems.length) throw new Error(problems.join("; "));
    unregister(name);
    let commands;
    let events;
    try {
      commands = registerCommands(name, regs);
      events = registerEvents(name, regs);
    } catch (error) {
      unregister(name);
      throw error;
    }
    const entry = { name, file, source, url: url || "", session, commands, events };
    loaded.set(name, entry);
    if (announce) {
      const cmdText = commands.map((c) => `.${c.name} [${c.category}${c.ownerOnly ? ", owner" : ""}${c.onlyGroup ? ", group" : ""}${c.hidden ? ", hidden" : ""}]`).join(", ");
      const evText = events.map((e) => `on:${e.on}`).join(", ");
      log(`[eplugin] ✅ New plugin system added: ${name} | commands: ${cmdText || "none"}${evText ? ` | events: ${evText}` : ""} | plugins loaded: ${loaded.size}`);
    }
    return entry;
  }

  /**
   * Levanter names a plugin after its pattern (".play" -> "play"), so two gists with the same first
   * word would share one name, file and table row, and the second would replace the first. The later
   * one gets the next free name instead: play1, play2, ... Reinstalling the same gist keeps its name.
   */
  async function uniquePluginName(base, url, session = SESSION) {
    let rows = [];
    try {
      rows = (await store.getPlugin(session)) || [];
    } catch {
      rows = [];
    }
    const ownedByAnother = (n) => {
      const row = rows.find((r) => r.name === n);
      if (row) return row.url !== url;
      return loaded.has(n) || fs.existsSync(pluginFile(n, session));
    };
    let name = base;
    for (let i = 1; ownedByAnother(name) && i < 1000; i += 1) name = `${base}${i}`;
    return name;
  }

  /** Levanter's installPlugin(path, session): loads a plugin file. */
  function installPlugin(filePath, session = SESSION) {
    const file = path.resolve(String(filePath));
    let source;
    try {
      source = fs.readFileSync(file, "utf8");
    } catch (error) {
      throw new Error(`cannot read the plugin file: ${error.message}`);
    }
    return loadSource({ name: nameFromFile(file, session), file, source, session, announce: true });
  }

  /** Levanter's removePlugin(name, session): unregisters the commands and deletes the file. */
  function removePlugin(name, session = SESSION) {
    const removed = unregister(name);
    const file = pluginFile(name, session);
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch (error) {
      warn(`[eplugin] could not delete ${file}: ${error.message}`);
    }
    if (removed.length) {
      log(`[eplugin] 🗑️ Plugin removed: ${name} | commands removed: ${removed.map((c) => `.${c}`).join(", ")}`);
    }
  }

  function sourceOf(name, session = SESSION) {
    try {
      return fs.readFileSync(pluginFile(name, session), "utf8");
    } catch {
      return "";
    }
  }

  const api = { installPlugin, removePlugin, sourceOf, uniquePluginName };

  /** The built-in Levanter plugins/ files, loaded at boot (no database needed). */
  function loadBuiltins() {
    return installPlugin(path.join(builtinDir, "plugins.js"), SESSION);
  }

  async function migrateLegacy() {
    const legacy = (host.legacyPlugins?.() || []).filter((p) => p?.name && p?.url);
    if (!legacy.length) return;
    for (const p of legacy) {
      const raw = parseGistUrls(p.url)[0] || p.url;
      await store.setPlugin(p.name, raw, SESSION, p.source || "");
    }
    host.clearLegacyPlugins?.();
    log(`[${SESSION}] moved ${legacy.length} plugin(s) from the old settings store into the plugin table.`);
  }

  /** Levanter's loadExternalPlugins: reloads every saved plugin from its URL. */
  async function restoreExternal() {
    if (restoreDone) return;
    restoreDone = true;
    await migrateLegacy();
    let rows = [];
    try {
      rows = (await store.getPlugin(SESSION)) || [];
    } catch (error) {
      warn(`[${SESSION}] could not read the plugin table: ${error.message}`);
      return;
    }
    log(`[${SESSION}] Installing external plugins... 📦`);
    fs.mkdirSync(eplugDir, { recursive: true });
    const restored = [];
    for (const row of rows) {
      const { name, url, source } = row;
      if (String(url).includes("mask-sir")) {
        await store.delPlugin(name, SESSION);
        continue;
      }
      const file = pluginFile(name);
      try {
        if (fs.existsSync(file)) fs.unlinkSync(file);
      } catch { /* the file is rewritten below */ }
      let body = null;
      try {
        const res = await host.httpGet(url, { timeout: 20000 });
        if (res.status === 200) body = res.data;
      } catch (error) {
        if (error?.response?.status === 404) {
          warn(LANG.extra.plugin_not_found.format(SESSION, name));
          await store.delPlugin(name, SESSION);
          continue;
        }
        if (source) {
          warn(`[${SESSION}] ${name}: the gist could not be reached (${error.message}); loading the saved copy.`);
          body = source;
        } else {
          warn(`[${SESSION}] skipping ${name} due to unexpected ${error.message}`);
          continue;
        }
      }
      if (typeof body !== "string") continue;
      try {
        fs.writeFileSync(file, body);
        const entry = loadSource({ name, file, source: body, session: SESSION, announce: false, url });
        await store.setPlugin(name, url, SESSION, body);
        log(LANG.extra.plugin_installed.format(SESSION, name));
        restored.push(entry);
      } catch (error) {
        warn(`${LANG.extra.plugin_install_error.format(SESSION, name)} (${error.message})`);
        try { fs.unlinkSync(file); } catch { /* nothing to remove */ }
        await store.delPlugin(name, SESSION);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    await new Promise((r) => setTimeout(r, 300));
    const summary = restored.map((e) => `${e.name} (${e.commands.map((c) => `.${c.name}`).join(", ") || "events"})`).join("; ");
    log(`[${SESSION}] External plugins installed! 🎒 | restored ${restored.length}/${rows.length}${summary ? `: ${summary}` : ""}`);
  }

  /** Runs `on:` plugins for an incoming message. Never throws. */
  async function runEventPlugins(sock, msg) {
    if (!eventHandlers.length || !msg?.message) return;
    const own = !!msg.key?.fromMe;
    const content = contentOf(msg.message);
    // A reaction event carries the emoji as its text; the chat is the reacted message's chat.
    const text = content?.reactionMessage ? String(content.reactionMessage.text ?? "") : String(host.getBody?.(msg) ?? "");
    for (const eh of [...eventHandlers]) {
      if (eh.fromMe !== own) continue;
      if (!matchesEvent(eh.on, content)) continue;
      const message = createMessage({ sock, msg, session: SESSION, text, host: { httpGet: host.httpGet, getSender: host.getSender, baileys: host.baileys, isSudo: host.isSudo } });
      try {
        await eh.handler(message, "", buildCtx());
      } catch (error) {
        await reportError(sock, msg, `on:${eh.on}`, text, error).catch(() => {});
      }
    }
  }

  return {
    SESSION,
    store,
    loadBuiltins,
    restoreExternal,
    runEventPlugins,
    hasEventPlugins: () => eventHandlers.length > 0,
    installPlugin,
    removePlugin,
    uniquePluginName,
    loadedPlugins: () => [...loaded.values()].map((e) => ({ name: e.name, commands: e.commands.map((c) => c.name), events: e.events.length })),
  };
}
