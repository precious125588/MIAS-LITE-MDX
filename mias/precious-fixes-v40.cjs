'use strict';

/**
 * ═══════════════════════════════════════════════════════════════════════
 *  precious-fixes-v40.cjs — Leave & Delete Group Fix Pack
 * ═══════════════════════════════════════════════════════════════════════
 *  - Implements genuine .leave / .leavegc / .deletegc / .out / .left
 *  - Overwrites dummy description-only fallback in mias/index.js
 *  - Disbands group if bot has admin rights (revoking invite & purging members)
 *  - Bot leaves the group (groupLeave)
 *  - Immediately deletes group chat (chatModify delete)
 *  - Cleans up internal caches and sends confirmation DM to command issuer
 * ═══════════════════════════════════════════════════════════════════════
 */

const path = require('path');
const { handleLeaveCommand } = require('../lib/leaveCommand.cjs');

const TAG = '[v40]';
const log = (...a) => console.log(TAG, ...a);
const warn = (...a) => console.warn(TAG, ...a);

const LEAVE_COMMAND_NAMES = ['leave', 'leavegc', 'deletegc', 'out', 'left'];

function installV40(ctx) {
  const P = ctx || globalThis.__PRECIOUS__ || {};
  const commands = P.commands || globalThis.__MIAS_COMMANDS__ || new Map();
  const aliases = P.aliases || globalThis.__MIAS_ALIASES__ || new Map();

  const deps = {
    sendReply: P.sendReply,
    react: P.react,
    CONFIG: P.CONFIG || globalThis.CONFIG,
    isOwner: P.isOwner,
    isSudo: P.isSudo,
    isGroup: P.isGroup,
    isGroupAdmin: P.isGroupAdmin,
    getSender: P.getSender,
  };

  const handler = async (sock, msg, args) => {
    return handleLeaveCommand(sock, msg, args, deps);
  };

  const entry = {
    desc: 'Leave and delete the group immediately',
    category: 'GROUP',
    ownerOnly: true,
    handler,
    __v40leave: true,
  };

  function bindCommands() {
    let installed = 0;
    if (commands && typeof commands.set === 'function') {
      for (const name of LEAVE_COMMAND_NAMES) {
        commands.set(name, entry);
        installed++;
      }
    }

    if (aliases && typeof aliases.set === 'function') {
      for (const name of LEAVE_COMMAND_NAMES.slice(1)) {
        aliases.set(name, 'leave');
      }
    }

    if (typeof P.cmd === 'function') {
      try {
        P.cmd(
          LEAVE_COMMAND_NAMES,
          { desc: 'Leave and delete the group immediately', category: 'GROUP', ownerOnly: true },
          handler
        );
      } catch (_) {}
    }

    return installed;
  }

  const count = bindCommands();
  log(`Installed leave & delete group command for ${count} names (${LEAVE_COMMAND_NAMES.join(', ')})`);

  // Retry assertion timers for late startup
  for (const ms of [1500, 5000, 15000, 30000]) {
    try {
      const t = setTimeout(() => {
        try { bindCommands(); } catch (_) {}
      }, ms);
      if (t && t.unref) t.unref();
    } catch (_) {}
  }

  return {
    v40: true,
    installed: LEAVE_COMMAND_NAMES,
    count,
  };
}

module.exports = installV40;
module.exports.install = installV40;
module.exports.apply = installV40;
module.exports.LEAVE_COMMAND_NAMES = LEAVE_COMMAND_NAMES;
