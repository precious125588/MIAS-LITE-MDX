'use strict';

/** Resolve the leading bare token only in explicit no-prefix mode. */
function parseBareCommand(text, isKnownCommand) {
  const raw = String(text || '').trim();
  const name = (raw.split(/\s+/)[0] || '').toLowerCase();
  if (!name || typeof isKnownCommand !== 'function' || !isKnownCommand(name)) {
    return { isCommand: false, prefix: null, raw: '', name: '' };
  }
  return { isCommand: true, prefix: '', raw, name };
}

module.exports = { parseBareCommand };
