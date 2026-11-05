/** Registry-backed menu adapter. No separate command inventory. */
import { activeMenuCategories, normalizeMenuCategory } from '../lib/premiumMenus.js';

export function getMenuCategories(context = {}) {
  const commands = globalThis.__MIAS_COMMANDS__;
  if (!(commands instanceof Map)) return [];
  return activeMenuCategories(commands, globalThis.__MIAS_ALIASES__ || new Map(), globalThis.__MIAS_MENU_CATEGORIES__ || [], context)
    .map(cat => ({ id: 'cat_' + cat.name.toLowerCase(), name: cat.name, label: cat.name,
      cmds: cat.cmds.map(name => ({ name, desc: commands.get(name)?.desc || '', wizard: false })) }));
}
// Compatibility for existing array consumers; each read reflects the live Map.
export const MENU_CATEGORIES = new Proxy([], {
  get(_target, property) {
    const current = getMenuCategories();
    const value = Reflect.get(current, property);
    return typeof value === 'function' ? value.bind(current) : value;
  },
  set() { throw new TypeError('Menu definitions are derived from the command registry'); },
});
export function getCategoryById(id) {
  const oldIds = { cat_system: 'INFO', cat_dl: 'DOWNLOAD', cat_groups: 'GROUP' };
  const wanted = oldIds[id] || normalizeMenuCategory(id);
  return getMenuCategories().find(cat => cat.name === wanted) || null;
}
export function getCategoryByLabel(label) {
  const wanted = normalizeMenuCategory(label);
  return getMenuCategories().find(cat => cat.name === wanted) || null;
}
export function getAllCommands(context = {}) {
  return getMenuCategories(context).flatMap(cat => cat.cmds.map(command => ({ ...command, category: cat.id, categoryLabel: cat.label })));
}
export function findCommand(name) {
  return getAllCommands().find(command => command.name === String(name || '').toLowerCase()) || null;
}
export function getTotalCommandCount(context = {}) {
  return getAllCommands(context).length;
}
