'use strict';

/**
 * ═══════════════════════════════════════════════════════════════════════
 *  precious-fixes-v39.cjs — Media Enhancement Fix Pack (.4k & .hd)
 * ═══════════════════════════════════════════════════════════════════════
 *  - Renames HD to 4K (.4k, bare 4k, uhd, 4kvideo) with 4K Lanczos & transcode
 *  - Powers HD cmd (.hd, bare hd, tthd) with TikTok 1.3 Full HD 1080p pipeline
 *  - Full support for image, video, TikTok link, video link & image link
 *  - 🌀 while processing, ✅ on success, ❌ with clear error on failure
 *  - Complete removal of .remux command
 *  - Fixes image reply handling so replying with hd/4k never stalls or drops
 * ═══════════════════════════════════════════════════════════════════════
 */

const { installMediaEnhance } = require('./features/mediaEnhance.cjs');

module.exports = function installV39(ctx) {
  const P = ctx || globalThis.__PRECIOUS__ || {};
  const commands = P.commands || globalThis.__MIAS_COMMANDS__ || new Map();
  const aliases = P.aliases || globalThis.__MIAS_ALIASES__ || new Map();

  // 1. Delete remux command and alias
  commands.delete('remux');
  if (typeof aliases?.delete === 'function') {
    aliases.delete('remux');
  }

  // 2. Install media enhance (.4k, .hd and all aliases)
  installMediaEnhance({
    commands,
    aliases,
    cmd: P.cmd,
    sendReply: P.sendReply,
    react: P.react,
    CONFIG: P.CONFIG,
    downloadContentFromMessage: P.downloadContentFromMessage,
  });

  return { v39: true, installed: ['4k', 'hd'], removed: ['remux'] };
};

module.exports.install = module.exports;
