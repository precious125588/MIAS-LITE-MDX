'use strict';

/**
 * .checkalias <command>
 * Shows the canonical name of a command, every alias that points to it,
 * and whether it is currently disabled. Read-only: nothing is changed.
 */

function normalizeCommandName(raw) {
  return String(raw || '')
    .trim()
    .replace(/^[./!#]+/, '')
    .split(/\s+/)[0]
    .toLowerCase();
}

function buildAliasReport(input, commands, aliases, opts = {}) {
  const name = normalizeCommandName(input);
  if (!name) {
    return '🔎 *Check alias*\n\nUsage: .checkalias <command>\nExample: .checkalias ping';
  }

  const entry = commands && typeof commands.get === 'function' ? commands.get(name) : undefined;
  const aliasTarget = aliases && typeof aliases.get === 'function' ? aliases.get(name) : undefined;
  if (!entry && !aliasTarget) {
    return `❌ No command named *.${name}* was found.`;
  }

  const canonical = String(entry?.canonical || aliasTarget || name).toLowerCase();
  const found = new Set();
  if (aliases && typeof aliases.forEach === 'function') {
    aliases.forEach((target, alias) => {
      if (String(target).toLowerCase() === canonical && alias !== canonical) found.add(String(alias).toLowerCase());
    });
  }
  if (commands && typeof commands.forEach === 'function') {
    commands.forEach((cmdEntry, cmdName) => {
      const key = String(cmdName).toLowerCase();
      if (key !== canonical && String(cmdEntry?.canonical || '').toLowerCase() === canonical) found.add(key);
    });
  }
  const list = [...found].sort();

  const lines = ['🔎 *Check alias*', '', `Command: *.${canonical}*`];
  lines.push(`Aliases: ${list.length ? list.map(a => `.${a}`).join(', ') : 'None'}`);
  if (name !== canonical) lines.push(`\n*.${name}* is an alias of *.${canonical}*.`);
  if (typeof opts.isDisabled === 'function' && opts.isDisabled(canonical)) {
    lines.push('\n⚠️ This command is currently disabled.');
  }
  return lines.join('\n');
}

module.exports = { normalizeCommandName, buildAliasReport };
