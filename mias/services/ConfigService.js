/**
 * MIAS — Config Service
 *
 * Centralized configuration management.
 * Commands read config from here — never from env, setting.json, or globals directly.
 *
 * Architecture: Commands → ConfigService → Settings.js / env / defaults
 */

// ─── Default values ───────────────────────────────────────────────────────────

const DEFAULTS = {
  BOT_NAME:      "MIAS BOT",
  PREFIX:        ".",
  OWNER:         "MIAS Owner",
  VERSION:       "5.3.1",
  THEME:         "default",
  PUBLIC_MODE:   false,
  MAX_FILE_SIZE: 50 * 1024 * 1024, // 50 MB
  STICKER_PACK:  "MIAS",
  STICKER_AUTHOR:"MIAS Bot",
  LANGUAGE:      "en",
  TIMEZONE:      "UTC",
  LOG_LEVEL:     process.env.LOG_LEVEL || "info",
  AI_PROVIDER:   "auto",
  MEDIA_QUALITY: "high",
  THUMBNAIL_W:   300,
  THUMBNAIL_H:   150,
  CACHE_TTL:     300,
  COOLDOWN:      3,
  DAILY_LIMIT:   0,  // 0 = unlimited
};

// ─── Config cache ─────────────────────────────────────────────────────────────

let _cache = null;

function _getMiasConfig() {
  return globalThis.__MIAS_CONFIG__ || {};
}

function _getSetting(key) {
  try { return globalThis.__GET_SETTING__?.(key); } catch { return undefined; }
}

function _build() {
  if (_cache) return _cache;
  const miasConfig = _getMiasConfig();
  const env = process.env;

  _cache = {
    BOT_NAME:      miasConfig.BOT_NAME      || env.BOT_NAME       || DEFAULTS.BOT_NAME,
    PREFIX:        miasConfig.PREFIX        || env.PREFIX          || _getSetting("prefix") || DEFAULTS.PREFIX,
    OWNER:         miasConfig.OWNER         || env.BOT_OWNER       || _getSetting("owner")  || DEFAULTS.OWNER,
    OWNER_JID:     miasConfig.OWNER_JID     || env.OWNER_JID       || _getSetting("owner_jid") || [],
    VERSION:       miasConfig.VERSION       || DEFAULTS.VERSION,
    THEME:         miasConfig.THEME         || env.BOT_THEME       || DEFAULTS.THEME,
    PUBLIC_MODE:   miasConfig.PUBLIC_MODE   ?? (_getSetting("publicMode") ?? DEFAULTS.PUBLIC_MODE),
    MAX_FILE_SIZE: Number(env.MAX_FILE_SIZE || DEFAULTS.MAX_FILE_SIZE),
    STICKER_PACK:  env.STICKER_PACK_NAME    || DEFAULTS.STICKER_PACK,
    STICKER_AUTHOR:env.STICKER_AUTHOR       || DEFAULTS.STICKER_AUTHOR,
    LANGUAGE:      miasConfig.LANGUAGE      || env.LANGUAGE         || DEFAULTS.LANGUAGE,
    TIMEZONE:      miasConfig.TIMEZONE      || env.TZ               || DEFAULTS.TIMEZONE,
    LOG_LEVEL:     DEFAULTS.LOG_LEVEL,
    AI_PROVIDER:   miasConfig.AI_PROVIDER   || env.AI_PROVIDER      || DEFAULTS.AI_PROVIDER,
    MEDIA_QUALITY: miasConfig.MEDIA_QUALITY || DEFAULTS.MEDIA_QUALITY,
    THUMBNAIL_W:   Number(env.THUMB_W  || DEFAULTS.THUMBNAIL_W),
    THUMBNAIL_H:   Number(env.THUMB_H  || DEFAULTS.THUMBNAIL_H),
    CACHE_TTL:     Number(env.CACHE_TTL || DEFAULTS.CACHE_TTL),
    COOLDOWN:      Number(env.DEFAULT_COOLDOWN || DEFAULTS.COOLDOWN),
    DAILY_LIMIT:   Number(env.DAILY_LIMIT || DEFAULTS.DAILY_LIMIT),
    // Feature flags
    FEATURES: {
      REACTIONS:    env.FEAT_REACTIONS    !== "0",
      THUMBNAILS:   env.FEAT_THUMBNAILS   !== "0",
      AUTO_OPTIMIZE:env.FEAT_OPTIMIZE     !== "0",
      AUTO_DOWNLOAD:env.FEAT_AUTO_DL      !== "0",
      METRICS:      env.FEAT_METRICS      !== "0",
      CACHE:        env.FEAT_CACHE        !== "0",
      QUEUE:        env.FEAT_QUEUE        !== "0",
    },
    // API endpoints
    APIS: {
      PRIMARY:   env.API_PRIMARY   || miasConfig.API_PRIMARY,
      SECONDARY: env.API_SECONDARY || miasConfig.API_SECONDARY,
      ZERO_API:  env.ZERO_API_KEY  || "",
      PREXZY:    env.PREXZY_KEY    || "",
    },
  };
  return _cache;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Get all config values.
 * @returns {object}
 */
export function getAll() { return _build(); }

/**
 * Get a specific config value.
 * @param {string} key
 * @param {any}    [fallback]
 * @returns {any}
 */
export function get(key, fallback) {
  const cfg = _build();
  return cfg[key] !== undefined ? cfg[key] : fallback;
}

/**
 * Bust the config cache (call after settings change).
 */
export function invalidate() { _cache = null; }

/**
 * Set a config value in memory (runtime-only, not persisted).
 * @param {string} key
 * @param {any}    value
 */
export function set(key, value) {
  const cfg = _build();
  cfg[key] = value;
}

/** Convenience getters */
export const prefix      = () => get("PREFIX",    DEFAULTS.PREFIX);
export const botName     = () => get("BOT_NAME",  DEFAULTS.BOT_NAME);
export const owner       = () => get("OWNER",     DEFAULTS.OWNER);
export const ownerJid    = () => [].concat(get("OWNER_JID", []));
export const version     = () => get("VERSION",   DEFAULTS.VERSION);
export const isPublic    = () => !!get("PUBLIC_MODE", false);
export const features    = () => get("FEATURES",  DEFAULTS);
export const apiConfig   = () => get("APIS",      {});
export const timezone    = () => get("TIMEZONE",  DEFAULTS.TIMEZONE);
export const language    = () => get("LANGUAGE",  DEFAULTS.LANGUAGE);

export default { getAll, get, set, invalidate, prefix, botName, owner, ownerJid, version, isPublic, features, apiConfig, timezone, language };
