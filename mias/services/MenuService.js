/**
 * MIAS — Menu Service
 *
 * Centralized menu rendering.
 * Commands call sendMenu() — never build menu payloads manually.
 *
 * Architecture: Commands → MenuService → MenuHandler → InteractiveHandler → WhatsApp
 */

import {
  sendMenu,
  sendCategoryMenu,
  sendCommandCount,
} from "../handlers/menuHandler.js";

import {
  MENU_CATEGORIES,
  getCategoryById,
  getTotalCommandCount,
  findCommand,
} from "../handlers/menuConfig.js";

// ─── Re-export core menu functions ────────────────────────────────────────────

export {
  sendMenu,
  sendCategoryMenu,
  sendCommandCount,
  MENU_CATEGORIES,
  getCategoryById,
  getTotalCommandCount,
  findCommand,
};

// ─── Semantic helpers ─────────────────────────────────────────────────────────

/**
 * Send the main bot menu.
 * @param {object} sock
 * @param {string} jid
 * @param {object} msg    - WAMessage (for context)
 * @param {object} [opts]
 * @param {object} [opts.quoted]
 */
export async function showMainMenu(sock, jid, msg, opts = {}) {
  return sendMenu(sock, jid, msg, opts);
}

/**
 * Send a category sub-menu.
 * @param {object} sock
 * @param {string} jid
 * @param {string} categoryId
 * @param {object} [opts]
 */
export async function showCategory(sock, jid, categoryId, opts = {}) {
  const cat = getCategoryById(categoryId);
  if (!cat) return null;
  return sendCategoryMenu(sock, jid, cat.id, cat.cmds, opts);
}

/**
 * Get all available categories.
 * @returns {Array}
 */
export function getCategories() {
  return MENU_CATEGORIES;
}

/**
 * Look up a command by name across all categories.
 * @param {string} name
 * @returns {object|null}
 */
export function lookupCommand(name) {
  return findCommand?.(name) ?? null;
}

export default {
  sendMenu,
  sendCategoryMenu,
  sendCommandCount,
  showMainMenu,
  showCategory,
  getCategories,
  lookupCommand,
  MENU_CATEGORIES,
  getCategoryById,
  getTotalCommandCount,
};
