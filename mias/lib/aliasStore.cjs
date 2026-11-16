'use strict';

/**
 * .addalias <command> | <alias>
 * Gives an existing command one more name. The alias is saved to
 * nexstore/command_aliases.json and added back at boot, so it survives a restart.
 */

const fs = require('fs');
const path = require('path');

const ALIAS_RE = /^[a-z0-9][a-z0-9_-]{0,29}$/;
const COMMAND_RE = /^[a-z0-9][a-z0-9_-]*$/;

function cleanToken(raw) {
  return String(raw || '').trim().replace(/^[./!#]+/, '').toLowerCase();
}

// "ping | fast" or "ping|fast" -> { command: 'ping', alias: 'fast' }
function parseAddAliasInput(text) {
  const raw = String(text || '');
  if (!raw.includes('|')) return { error: 'usage' };
  const parts = raw.split('|');
  if (parts.length !== 2) return { error: 'usage' };
  const command = cleanToken(parts[0]);
  const alias = cleanToken(parts[1]);
  if (!command || !alias) return { error: 'usage' };
  if (!COMMAND_RE.test(command) || !ALIAS_RE.test(alias)) return { error: 'format' };
  return { command, alias };
}

// Checks a request against the live command map. Returns { ok, canonical } or { ok: false, reason }.
function checkAddAlias(commands, aliases, command, alias) {
  if (alias === command) return { ok: false, reason: 'Alias and command are the same.' };
  const entry = commands.get(command);
  if (!entry || typeof entry.handler !== 'function') return { ok: false, reason: `No command named *.${command}*.` };
  if (commands.has(alias) || aliases.has(alias)) return { ok: false, reason: `*.${alias}* is already used.` };
  const canonical = String(entry.canonical || command).toLowerCase();
  if (!commands.get(canonical)) return { ok: false, reason: `No command named *.${canonical}*.` };
  return { ok: true, canonical };
}

// Registers the alias so it runs exactly like the canonical command.
function attachAlias(commands, aliases, canonical, alias) {
  const target = commands.get(canonical);
  // Drop per-entry enable/disable flags: the live state is read from the canonical name.
  const { disabled, enabled, ...meta } = target;
  commands.set(alias, { ...meta, canonical, isAlias: true });
  aliases.set(alias, canonical);
}

function detachAlias(commands, aliases, alias) {
  commands.delete(alias);
  aliases.delete(alias);
}

function loadAliasStore(file) {
  try {
    if (!fs.existsSync(file)) return [];
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = Array.isArray(data && data.aliases) ? data.aliases : [];
    return list.filter(x => x && typeof x.alias === 'string' && typeof x.command === 'string');
  } catch (_) {
    return [];
  }
}

function saveAliasStore(file, list) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ aliases: list }, null, 2));
  fs.renameSync(tmp, file);
}

// Re-adds saved aliases after all commands are registered. Skips any that no longer fit.
function restoreAliases(commands, aliases, list, onSkip) {
  let restored = 0;
  for (const item of list) {
    const check = checkAddAlias(commands, aliases, item.command, item.alias);
    if (!check.ok) {
      if (typeof onSkip === 'function') onSkip(item.alias, check.reason);
      continue;
    }
    attachAlias(commands, aliases, check.canonical, item.alias);
    restored++;
  }
  return restored;
}

// Full add: check, attach, save. Rolls back the in-memory alias if saving fails.
function addAliasPersisted({ commands, aliases, file, command, alias }) {
  const check = checkAddAlias(commands, aliases, command, alias);
  if (!check.ok) return `❌ ${check.reason}`;
  attachAlias(commands, aliases, check.canonical, alias);
  const list = loadAliasStore(file).filter(x => x.alias !== alias);
  list.push({ alias, command: check.canonical, addedAt: new Date().toISOString() });
  try {
    saveAliasStore(file, list);
  } catch (e) {
    detachAlias(commands, aliases, alias);
    return `❌ Could not save *.${alias}*. It was not added. Try again.`;
  }
  return `✅ *.${alias}* is now an alias of *.${check.canonical}*. It stays after restart.`;
}

// Removes an alias added with .addalias. Built-in aliases are not in the saved list, so they cannot be removed here.
// Saves first and detaches only after the save works, so a failed save changes nothing.
function removeAliasPersisted({ commands, aliases, file, alias }) {
  const name = cleanToken(alias);
  if (!name) return '🔗 *Remove alias*\n\nUsage: .removealias <alias>\nExample: .removealias fast';
  const list = loadAliasStore(file);
  const saved = list.find(x => x.alias === name);
  if (!saved) {
    if (commands.has(name) || aliases.has(name)) return `❌ *.${name}* is a built-in name, not a saved alias. It can't be removed.`;
    return `❌ No saved alias named *.${name}*.`;
  }
  try {
    saveAliasStore(file, list.filter(x => x.alias !== name));
  } catch (e) {
    return `❌ Could not save the change. *.${name}* is still there. Try again.`;
  }
  detachAlias(commands, aliases, name);
  return `✅ Removed alias *.${name}* (was an alias of *.${saved.command}*).`;
}

module.exports = {
  ALIAS_RE, parseAddAliasInput, checkAddAlias, attachAlias, detachAlias,
  loadAliasStore, saveAliasStore, restoreAliases, addAliasPersisted, removeAliasPersisted,
};
