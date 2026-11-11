'use strict';

/**
 * ═══════════════════════════════════════════════════════════════════════
 *  precious-fixes-v41.cjs — View-Once Fix Pack (.vv & .vv2)
 * ═══════════════════════════════════════════════════════════════════════
 *  - Implements reliable .vv / .viewonce (reveals view-once in chat)
 *  - Implements reliable .vv2 (reveals view-once silently to user DM)
 *  - Drops clear, helpful error messages whenever the command reacts with ❌
 *  - Supports images, videos, audio/voice notes (PTT), PTV video notes, and docs
 *  - Unwraps all WhatsApp message envelopes (ephemeral, viewOnceV1/V2/V2Ext, etc.)
 * ═══════════════════════════════════════════════════════════════════════
 */

const { handleViewOnceCommand } = require('../lib/viewOnceCommand.cjs');

const TAG = '[v41]';
const log = (...a) => console.log(TAG, ...a);

const VV_COMMAND_NAMES = ['vv', 'viewonce'];
const VV2_COMMAND_NAMES = ['vv2', 'lol', 'wow', 'hehe', '😂', '🙂', 'omor', 'chai', '🥀'];

function installV41(ctx) {
  const P = ctx || globalThis.__PRECIOUS__ || {};
  const commands = P.commands || globalThis.__MIAS_COMMANDS__ || new Map();
  const aliases = P.aliases || globalThis.__MIAS_ALIASES__ || new Map();

  const deps = {
    sendReply: P.sendReply || globalThis.sendReply,
    react: P.react || globalThis.react,
    CONFIG: P.CONFIG || globalThis.CONFIG,
    isOwner: P.isOwner || globalThis.isOwner,
    isSudo: P.isSudo || globalThis.isSudo,
    isGroup: P.isGroup || globalThis.isGroup,
    getSender: P.getSender || globalThis.getSender,
    downloadContentFromMessage: P.downloadContentFromMessage || globalThis.downloadContentFromMessage,
  };

  const vvHandler = async (sock, msg, args) => {
    return handleViewOnceCommand(sock, msg, args, { cmdName: 'vv', sendToDm: false }, deps);
  };

  const vv2Handler = async (sock, msg, args) => {
    return handleViewOnceCommand(sock, msg, args, { cmdName: 'vv2', sendToDm: true }, deps);
  };

  const vvEntry = {
    desc: 'Reveal view-once message (reply to it)',
    category: 'TOOLS',
    handler: vvHandler,
    __v41vv: true,
  };

  const vv2Entry = {
    desc: 'Reveal view-once media silently to your DM (reply to it)',
    category: 'TOOLS',
    handler: vv2Handler,
    __v41vv2: true,
  };

  function bindCommands() {
    let installed = 0;
    if (commands && typeof commands.set === 'function') {
      for (const name of VV_COMMAND_NAMES) {
        commands.set(name, vvEntry);
        installed++;
      }
      for (const name of VV2_COMMAND_NAMES) {
        commands.set(name, vv2Entry);
        installed++;
      }
    }

    if (aliases && typeof aliases.set === 'function') {
      for (const name of VV_COMMAND_NAMES.slice(1)) {
        aliases.set(name, 'vv');
      }
      for (const name of VV2_COMMAND_NAMES.slice(1)) {
        aliases.set(name, 'vv2');
      }
    }

    if (typeof P.cmd === 'function') {
      try {
        P.cmd(
          VV_COMMAND_NAMES,
          { desc: 'Reveal view-once message (reply to it)', category: 'TOOLS' },
          vvHandler
        );
      } catch (_) {}
      try {
        P.cmd(
          VV2_COMMAND_NAMES,
          { desc: 'Reveal view-once media silently to your DM (reply to it)', category: 'TOOLS' },
          vv2Handler
        );
      } catch (_) {}
    }

    return installed;
  }

  const count = bindCommands();
  log(`Installed view-once commands for ${count} triggers (.vv, .viewonce, .vv2 and aliases)`);

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
    v41: true,
    installed: [...VV_COMMAND_NAMES, ...VV2_COMMAND_NAMES],
    count,
  };
}

module.exports = installV41;
module.exports.install = installV41;
module.exports.apply = installV41;
module.exports.VV_COMMAND_NAMES = VV_COMMAND_NAMES;
module.exports.VV2_COMMAND_NAMES = VV2_COMMAND_NAMES;
