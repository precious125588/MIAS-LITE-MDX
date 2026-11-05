/**
 * MIAS — Plugin System
 *
 * Auto-discovers and loads command modules.
 * Supports enabling/disabling plugins without editing multiple files.
 *
 * Architecture: PluginSystem → mias/plugins/**\/*.js → CommandRegistry → Command handlers
 */

import { readdirSync, existsSync } from "fs";
import { join, extname, basename } from "path";
import { fileURLToPath } from "url";
import { emit, EVENTS } from "./EventBus.js";
import { createRequire as _createRequire } from "module";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PLUGINS_DIR = join(__dirname, "..", "plugins");
const CONFIG_DIR  = join(__dirname, "..", "..", "setting");

// ─── State ────────────────────────────────────────────────────────────────────

const _registry   = new Map();   // name → { module, meta, enabled }
const _disabled   = new Set();   // plugin names explicitly disabled

// ─── Config loading ───────────────────────────────────────────────────────────

function _loadDisabledList() {
  try {
    const { createRequire } = await_require();
    if (!createRequire) return;
    const r = createRequire(import.meta.url);
    const cfg = r("../../setting/setting.json");
    const list = cfg?.disabledPlugins || cfg?.disabled_plugins || [];
    list.forEach(name => _disabled.add(String(name)));
  } catch {}
}

// FIXED: `await` in a non-async function is a SyntaxError — see PermissionService.js.
function await_require() {
  try { return { createRequire: _createRequire }; }
  catch { return {}; }
}

// ─── Discovery ────────────────────────────────────────────────────────────────

/**
 * Scan the plugins directory and import all .js modules.
 * Each module should export:
 *   - commands: Array<{ name, aliases?, handler, desc, category }>
 *   - name?: string (plugin name, defaults to filename)
 *   - enabled?: boolean (defaults to true)
 *
 * @returns {Promise<number>} Number of plugins loaded
 */
export async function loadPlugins() {
  _loadDisabledList();

  if (!existsSync(PLUGINS_DIR)) {
    // Plugins directory doesn't exist yet — that's OK
    return 0;
  }

  let loaded = 0;
  const files = _scanDir(PLUGINS_DIR);

  for (const file of files) {
    const name = basename(file, extname(file));
    if (_disabled.has(name)) continue;
    try {
      const module = await import(file);
      const pluginName = module.name || name;
      const commands   = module.commands || module.default?.commands || [];
      const enabled    = module.enabled !== false && !_disabled.has(pluginName);

      _registry.set(pluginName, {
        name: pluginName,
        file,
        commands,
        enabled,
        meta: {
          description: module.description || "",
          version:     module.version     || "1.0",
          author:      module.author      || "",
        },
      });
      loaded++;
    } catch (err) {
      console.error(`[PluginSystem] Failed to load plugin "${name}":`, err?.message);
    }
  }

  await emit(EVENTS.STARTUP, { plugins: loaded });
  return loaded;
}

function _scanDir(dir) {
  const files = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) files.push(..._scanDir(full));
      else if (entry.isFile() && entry.name.endsWith(".js")) files.push(full);
    }
  } catch {}
  return files;
}

// ─── Registry access ──────────────────────────────────────────────────────────

/**
 * Get all loaded plugin names.
 * @returns {string[]}
 */
export function listPlugins() {
  return [..._registry.keys()];
}

/**
 * Get all registered commands across all enabled plugins.
 * @returns {Array}
 */
export function getAllCommands() {
  const commands = [];
  for (const plugin of _registry.values()) {
    if (!plugin.enabled) continue;
    for (const cmd of plugin.commands) {
      commands.push({ ...cmd, plugin: plugin.name });
    }
  }
  return commands;
}

/**
 * Find a command handler by name.
 * @param {string} name
 * @returns {Function|null}
 */
export function findCommand(name) {
  const clean = String(name).toLowerCase();
  for (const plugin of _registry.values()) {
    if (!plugin.enabled) continue;
    for (const cmd of plugin.commands) {
      if (
        cmd.name?.toLowerCase() === clean ||
        cmd.aliases?.some(a => a.toLowerCase() === clean)
      ) {
        return cmd.handler || null;
      }
    }
  }
  return null;
}

/**
 * Enable a plugin.
 * @param {string} name
 */
export function enablePlugin(name) {
  const plugin = _registry.get(name);
  if (plugin) { plugin.enabled = true; _disabled.delete(name); }
}

/**
 * Disable a plugin (commands stop responding).
 * @param {string} name
 */
export function disablePlugin(name) {
  const plugin = _registry.get(name);
  if (plugin) { plugin.enabled = false; _disabled.add(name); }
}

/**
 * Get plugin info.
 * @param {string} name
 * @returns {object|null}
 */
export function getPlugin(name) {
  return _registry.get(name) ?? null;
}

/**
 * Get the total count of loaded commands.
 * @returns {number}
 */
export function getCommandCount() {
  let count = 0;
  for (const p of _registry.values()) {
    if (p.enabled) count += p.commands.length;
  }
  return count;
}

export default { loadPlugins, listPlugins, getAllCommands, findCommand, enablePlugin, disablePlugin, getPlugin, getCommandCount };
