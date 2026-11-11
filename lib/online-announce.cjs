'use strict';
/* ── ONLINE ANNOUNCE ──────────────────────────────────────────────────────────
   Prints one clear line when the WhatsApp connection opens, and re-arms when it
   closes. It listens on the shared Node event emitter that Baileys uses for
   connection.update, so it works regardless of what the bot code logs.
   Loaded by crash-shield.cjs, which every bot process already requires.
   Writes straight to stdout so the console log filter cannot swallow it.
   ──────────────────────────────────────────────────────────────────────────── */

const EventEmitter = require('node:events');

const LABEL = 'MIAS LITE MDX';
let online = false;
let installed = false;

function handleUpdate(update) {
  if (!update || typeof update !== 'object') return;
  if (update.connection === 'open') {
    if (online) return;
    online = true;
    process.stdout.write('✅ ' + LABEL + ' is online (WhatsApp connected)\n');
  } else if (update.connection === 'close') {
    online = false;
  }
}

function install() {
  if (installed) return false;
  installed = true;
  const original = EventEmitter.prototype.emit;
  EventEmitter.prototype.emit = function onlineAwareEmit(event, ...args) {
    if (event === 'connection.update') {
      try { handleUpdate(args[0]); } catch (_) { /* never break the bot's own events */ }
    }
    return original.call(this, event, ...args);
  };
  return true;
}

module.exports = { install, handleUpdate, LABEL };
