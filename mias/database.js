/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║           MIAS MDX — Database / Persistence Layer           ║
 * ║           Saves application state to JSON / Neon             ║
 * ║           Owner: 𝑷𝑹𝑬𝑪𝑰𝑶𝑼𝑺 x                              ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

import fs from "fs";
import { createHash } from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "node:module";
import {
  applyMigrations,
  assertReadOnlyConnection,
  canonicalJson,
  compareAndSwapBotState,
  createNeonPool,
  derivePersistenceScope,
  readBotState,
  safeDbErrorCode,
  seedBotState,
} from "./neonPersistence.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const LEGACY_DB_DIR = path.join(__dirname, "database");
const {
  assertRailwayConnection,
  createRailwayPool,
  resolveStateDatabase,
} = require("./lib/railwayPersistence.cjs");
const { isJsonOnly } = require("./lib/storageMode.cjs");

function detectVolumeRoot() {
  const configured = String(process.env.RAILWAY_VOLUME_MOUNT_PATH || "").trim();
  if (configured) {
    const candidate = path.resolve(configured);
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {}
  }

  // Keep the Railway mount detection in sync with the session-path resolver.
  try {
    const sessionPaths = require("../sessionPaths.js");
    if (sessionPaths?.isVolumeMounted?.()) return sessionPaths.nexstoreRoot();
  } catch {}
  return null;
}

/**
 * Resolve the database beside an explicitly isolated bot session when the
 * launcher supplied AUTH_DIR. Direct starts have no AUTH_DIR until index.js
 * finishes evaluating, so detect the mounted Railway volume here as well.
 */
export function resolveDatabaseDir() {
  const authDir = String(process.env.AUTH_DIR || "").trim();
  if (authDir) return path.join(path.resolve(authDir), "database");

  const volumeRoot = detectVolumeRoot();
  if (volumeRoot) return path.join(volumeRoot, "database");
  return LEGACY_DB_DIR;
}

const DB_DIR = resolveDatabaseDir();

// Ensure database directory exists
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

/**
 * One-time, non-destructive migration from the old code-directory database.
 * Existing volume data always wins; only missing JSON files are copied.
 */
export function migrateLegacyDatabase(sourceDir = LEGACY_DB_DIR, targetDir = DB_DIR) {
  const source = path.resolve(sourceDir);
  const target = path.resolve(targetDir);
  if (source === target) return 0;

  let copied = 0;
  let entries;
  try {
    entries = fs.readdirSync(source, { withFileTypes: true });
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.error("[DB] Could not inspect legacy database:", error.message);
    }
    return 0;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".json")) continue;
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    try {
      fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
      copied++;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        console.error(`[DB] Could not migrate ${entry.name}:`, error.message);
      }
    }
  }
  return copied;
}

const migratedLegacyFiles = migrateLegacyDatabase();
if (migratedLegacyFiles) {
  console.log(`[DB] Migrated ${migratedLegacyFiles} legacy JSON file(s) to persistent storage.`);
}

export const DB_FILES = {
  economy:      path.join(DB_DIR, "economy.json"),
  settings:     path.join(DB_DIR, "settings.json"),
  bans:         path.join(DB_DIR, "bans.json"),
  warns:        path.join(DB_DIR, "warns.json"),
  sudo:         path.join(DB_DIR, "sudo.json"),
  sudoVip:      path.join(DB_DIR, "sudo_vip.json"),
  badwords:     path.join(DB_DIR, "badwords.json"),
  inventory:    path.join(DB_DIR, "inventory.json"),
  relationships:path.join(DB_DIR, "relationships.json"),
  factions:     path.join(DB_DIR, "factions.json"),
  userfaction:  path.join(DB_DIR, "userfaction.json"),
  crypto:       path.join(DB_DIR, "crypto.json"),
  grouprules:   path.join(DB_DIR, "grouprules.json"),
};

// ── Serialization helpers for Map ────────────────────────────
function mapToObj(map) {
  const obj = {};
  for (const [k, v] of map) {
    if (v instanceof Map) obj[k] = { __isMap: true, data: mapToObj(v) };
    else if (v instanceof Set) obj[k] = { __isSet: true, data: [...v] };
    else obj[k] = v;
  }
  return obj;
}

function objToMap(obj) {
  const map = new Map();
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === "object" && v.__isMap) map.set(k, objToMap(v.data));
    else if (v && typeof v === "object" && v.__isSet) map.set(k, new Set(v.data));
    else map.set(k, v);
  }
  return map;
}

function setToArr(set) { return [...set]; }
function arrToSet(arr) { return new Set(arr); }

// ── Write only when the content changed ─────────────────────
// Every save used to rewrite all stores, even when nothing changed. We keep
// a digest of what this process last wrote per file and skip identical writes.
// The bytes on disk are the same as before; there is just less I/O and CPU.
const _lastWriteDigest = new Map();

// ── Keep the database folder available for writes ───────────
// DB_DIR is created once at import time. A session restore, reset, or cleanup
// can remove it while the bot is still running, and every later save then
// failed with ENOENT. If the session folder (the parent of DB_DIR) still
// exists, recreate DB_DIR. If the whole session folder is gone, the session
// was removed on purpose, so skip writes instead of recreating a folder for it.
let _databaseDirGoneWarned = false;
function ensureDatabaseDir() {
  if (fs.existsSync(DB_DIR)) {
    _databaseDirGoneWarned = false;
    return true;
  }
  const sessionDir = path.dirname(DB_DIR);
  if (!fs.existsSync(sessionDir)) {
    if (!_databaseDirGoneWarned) {
      _databaseDirGoneWarned = true;
      console.warn(`[DB] Session folder is gone (${sessionDir}); skipping database writes.`);
    }
    return false;
  }
  fs.mkdirSync(DB_DIR, { recursive: true });
  console.warn(`[DB] Database folder was missing; recreated ${DB_DIR}.`);
  return true;
}

function writeIfChanged(filePath, data) {
  if (!ensureDatabaseDir()) return false;
  const digest = createHash("sha1").update(data).digest("hex");
  if (_lastWriteDigest.get(filePath) === digest && fs.existsSync(filePath)) return true;
  fs.writeFileSync(filePath, data, "utf8");
  _lastWriteDigest.set(filePath, digest);
  return true;
}

// ── Save a Map to a JSON file ───────────────────────────────
function saveMap(filePath, map) {
  try {
    const data = JSON.stringify(mapToObj(map));
    writeIfChanged(filePath, data);
  } catch (e) {
    console.error(`[DB] Failed to save ${path.basename(filePath)}:`, e.message);
  }
}

// ── Load a Map from a JSON file ─────────────────────────────
function loadMap(filePath, { strict = false } = {}) {
  try {
    if (!fs.existsSync(filePath)) return new Map();
    const raw = fs.readFileSync(filePath, "utf8");
    if (!raw.trim()) {
      if (strict) throw new Error("LEGACY_JSON_INVALID");
      return new Map();
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      if (strict) throw new Error("LEGACY_JSON_INVALID");
      return new Map();
    }
    return objToMap(parsed);
  } catch (e) {
    if (strict) {
      const error = new Error("LEGACY_JSON_INVALID");
      error.code = "LEGACY_JSON_INVALID";
      throw error;
    }
    console.error(`[DB] Failed to load ${path.basename(filePath)}:`, e.message);
    return new Map();
  }
}

// ── Save a Set to a JSON file ───────────────────────────────
function saveSet(filePath, set) {
  try {
    writeIfChanged(filePath, JSON.stringify(setToArr(set)));
  } catch (e) {
    console.error(`[DB] Failed to save ${path.basename(filePath)}:`, e.message);
  }
}

// ── Load a Set from a JSON file ─────────────────────────────
function loadSet(filePath, { strict = false } = {}) {
  try {
    if (!fs.existsSync(filePath)) return new Set();
    const raw = fs.readFileSync(filePath, "utf8");
    if (!raw.trim()) {
      if (strict) throw new Error("LEGACY_JSON_INVALID");
      return new Set();
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      if (strict) throw new Error("LEGACY_JSON_INVALID");
      return new Set();
    }
    return arrToSet(parsed);
  } catch (e) {
    if (strict) {
      const error = new Error("LEGACY_JSON_INVALID");
      error.code = "LEGACY_JSON_INVALID";
      throw error;
    }
    console.error(`[DB] Failed to load ${path.basename(filePath)}:`, e.message);
    return new Set();
  }
}

// ── Public API ──────────────────────────────────────────────

const STORE_KEYS = Object.keys(DB_FILES);
const SET_STORES = new Set(["sudo", "sudoVip"]);
let _persistenceMode = "json";
let _postgresPool = null;
let _postgresScope = null;
let _postgresRevision = null;
let _postgresSnapshot = null;
let _lastPersistedDigest = null;
let _writeBlocked = false;
let _saveQueue = Promise.resolve(true);

function loadAllDataFromDisk({ strict = false } = {}) {
  return {
    economy:       loadMap(DB_FILES.economy, { strict }),
    settings:      loadMap(DB_FILES.settings, { strict }),
    bans:          loadMap(DB_FILES.bans, { strict }),
    warns:         loadMap(DB_FILES.warns, { strict }),
    sudo:          loadSet(DB_FILES.sudo, { strict }),
    sudoVip:       loadSet(DB_FILES.sudoVip, { strict }),
    badwords:      loadMap(DB_FILES.badwords, { strict }),
    inventory:     loadMap(DB_FILES.inventory, { strict }),
    relationships: loadMap(DB_FILES.relationships, { strict }),
    factions:      loadMap(DB_FILES.factions, { strict }),
    userfaction:   loadMap(DB_FILES.userfaction, { strict }),
    crypto:        loadMap(DB_FILES.crypto, { strict }),
    grouprules:    loadMap(DB_FILES.grouprules, { strict }),
  };
}

function serializeStores(stores) {
  return Object.fromEntries(
    STORE_KEYS.map((key) => [
      key,
      SET_STORES.has(key) ? setToArr(stores[key]) : mapToObj(stores[key]),
    ]),
  );
}

function deserializeStores(snapshot) {
  const stores = {};
  for (const key of STORE_KEYS) {
    const value = snapshot?.[key];
    if (SET_STORES.has(key)) {
      if (!Array.isArray(value)) throw Object.assign(new Error(), { code: "DATABASE_STATE_INVALID" });
      stores[key] = arrToSet(value);
    } else {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw Object.assign(new Error(), { code: "DATABASE_STATE_INVALID" });
      }
      stores[key] = objToMap(value);
    }
  }
  return stores;
}

/**
 * Use Railway PostgreSQL when RAILWAY_DATABASE_URL is configured; otherwise
 * retain the existing Neon DATABASE_URL behavior. Schema changes are additive
 * and versioned, and legacy JSON files remain recovery data.
 */
export async function initializePersistence(options = {}) {
  const { connectionString, expectedDatabase, poolFactory } = options;
  if (isJsonOnly()) {
    _persistenceMode = "json";
    console.log("[DB] STORAGE_MODE=json: PostgreSQL is off; using JSON persistence.");
    return { mode: "json" };
  }
  const configuredRailwayUrl = String(process.env.RAILWAY_DATABASE_URL || "").trim();
  const databaseConfig = connectionString === undefined
    ? resolveStateDatabase()
    : (configuredRailwayUrl && String(connectionString || "").trim() === configuredRailwayUrl
      ? { connectionString: configuredRailwayUrl, provider: "railway", expectedDatabase: null }
      : {
          connectionString: String(connectionString || "").trim(),
          provider: "neon",
          expectedDatabase: expectedDatabase ?? process.env.NEON_EXPECTED_DATABASE ?? "neondb",
        });
  if (expectedDatabase !== undefined && databaseConfig.provider === "neon") {
    databaseConfig.expectedDatabase = expectedDatabase;
  }

  if (!String(databaseConfig.connectionString || "").trim()) {
    _persistenceMode = "json";
    console.log("[DB] No external PostgreSQL URL is configured; using existing JSON persistence.");
    return { mode: "json" };
  }

  let pool;
  try {
    pool = poolFactory
      ? poolFactory({ connectionString: databaseConfig.connectionString })
      : databaseConfig.provider === "railway"
        ? createRailwayPool({ connectionString: databaseConfig.connectionString })
        : createNeonPool({ connectionString: databaseConfig.connectionString });
    const probe = databaseConfig.provider === "railway"
      ? await assertRailwayConnection(pool)
      : await assertReadOnlyConnection(pool, { expectedDatabase: databaseConfig.expectedDatabase });
    const providerLabel = databaseConfig.provider === "railway" ? "Railway PostgreSQL" : "Neon";
    console.log(`${providerLabel} connection: SUCCESS (${probe.databaseName})`);
    await applyMigrations(pool);
    const scope = derivePersistenceScope();
    let state = await readBotState(pool, scope);

    if (!state) {
      const legacyStores = loadAllDataFromDisk({ strict: true });
      state = await seedBotState(pool, scope, serializeStores(legacyStores));
    } else {
      const hasEveryStore = STORE_KEYS.every((key) =>
        Object.prototype.hasOwnProperty.call(state.payload, key),
      );
      if (!hasEveryStore) {
        const legacySnapshot = serializeStores(loadAllDataFromDisk({ strict: true }));
        const merged = { ...state.payload };
        for (const key of STORE_KEYS) {
          if (!Object.prototype.hasOwnProperty.call(merged, key)) merged[key] = legacySnapshot[key];
        }
        const nextRevision = await compareAndSwapBotState(
          pool,
          scope,
          state.revision,
          merged,
        );
        if (nextRevision === null) {
          throw Object.assign(new Error(), { code: "DATABASE_STATE_CONFLICT" });
        }
        state = { payload: merged, revision: nextRevision };
      }
    }

    // Validate the whole snapshot before the application starts using it.
    deserializeStores(state.payload);
    _postgresPool = pool;
    _postgresScope = scope;
    _postgresRevision = state.revision;
    _postgresSnapshot = state.payload;
    _lastPersistedDigest = canonicalJson(state.payload);
    _writeBlocked = false;
    _persistenceMode = databaseConfig.provider;
    console.log(`[DB] ${providerLabel} persistence enabled for this isolated bot session.`);
    return { mode: databaseConfig.provider, databaseName: probe.databaseName };
  } catch (error) {
    try {
      await pool?.end();
    } catch {}
    _postgresPool = null;
    _postgresScope = null;
    _persistenceMode = "failed";
    const code = safeDbErrorCode(error);
    console.error(`[DB] PostgreSQL persistence initialization failed (${code}); refusing JSON fallback.`);
    throw Object.assign(new Error(`PostgreSQL persistence initialization failed (${code})`), { code });
  }
}

/**
 * Load all data stores from Neon when configured, otherwise from disk.
 * Returns an object with all loaded Maps and Sets.
 */
export function loadAllData() {
  if (_persistenceMode === "failed") {
    throw new Error("PostgreSQL persistence failed; refusing JSON fallback.");
  }
  const externalPostgres = _persistenceMode === "neon" || _persistenceMode === "railway";
  console.log(externalPostgres
    ? `📂 Loading database from ${_persistenceMode === "railway" ? "Railway PostgreSQL" : "Neon"}...`
    : "📂 Loading database from disk...");
  const data = externalPostgres
    ? deserializeStores(_postgresSnapshot)
    : loadAllDataFromDisk();
  const ecoCount = data.economy.size;
  const settCount = data.settings.size;
  console.log(`✅ Database loaded: ${ecoCount} economy records, ${settCount} settings records`);
  return data;
}

/**
 * Save all stores to Neon when configured, otherwise to the existing JSON files.
 * Call this periodically and on shutdown.
 */
export function saveAllData(stores) {
  if (_persistenceMode === "failed") {
    console.error("[DB] PostgreSQL persistence unavailable; refusing to write to JSON fallback.");
    return Promise.resolve(false);
  }

  if (_persistenceMode === "neon" || _persistenceMode === "railway") {
    if (_writeBlocked) return Promise.resolve(false);
    let snapshot;
    try {
      snapshot = serializeStores(stores);
    } catch (error) {
      console.error(`[DB] PostgreSQL snapshot serialization failed (${safeDbErrorCode(error)}).`);
      return Promise.resolve(false);
    }
    const digest = canonicalJson(snapshot);
    if (digest === _lastPersistedDigest) return Promise.resolve(true);

    const save = _saveQueue.then(async () => {
      if (digest === _lastPersistedDigest) return true;
      const revision = await compareAndSwapBotState(
        _postgresPool,
        _postgresScope,
        _postgresRevision,
        snapshot,
      );
      if (revision === null) {
        const remote = await readBotState(_postgresPool, _postgresScope);
        if (remote && canonicalJson(remote.payload) === digest) {
          _postgresRevision = remote.revision;
          _postgresSnapshot = remote.payload;
          _lastPersistedDigest = digest;
          return true;
        }
        _writeBlocked = true;
        console.error("[DB] PostgreSQL state changed concurrently; writes paused to prevent overwriting newer data.");
        return false;
      }
      _postgresRevision = revision;
      _postgresSnapshot = snapshot;
      _lastPersistedDigest = digest;
      return true;
    }).catch((error) => {
      console.error(`[DB] PostgreSQL save failed (${safeDbErrorCode(error)}); no JSON fallback was used.`);
      return false;
    });
    _saveQueue = save;
    return save;
  }

  saveMap(DB_FILES.economy,       stores.economy);
  saveMap(DB_FILES.settings,      stores.settings);
  saveMap(DB_FILES.bans,          stores.bans);
  saveMap(DB_FILES.warns,         stores.warns);
  saveSet(DB_FILES.sudo,          stores.sudo);
  saveSet(DB_FILES.sudoVip,       stores.sudoVip);
  saveMap(DB_FILES.badwords,      stores.badwords);
  saveMap(DB_FILES.inventory,     stores.inventory);
  saveMap(DB_FILES.relationships, stores.relationships);
  saveMap(DB_FILES.factions,      stores.factions);
  saveMap(DB_FILES.userfaction,   stores.userfaction);
  saveMap(DB_FILES.crypto,        stores.crypto);
  saveMap(DB_FILES.grouprules,    stores.grouprules);
  return Promise.resolve(true);
}

export async function flushPersistence() {
  return _saveQueue;
}

export async function closePersistence() {
  await flushPersistence();
  const pool = _postgresPool;
  _postgresPool = null;
  if (pool) await pool.end();
}

/**
 * Start auto-save interval (default: every 2 minutes).
 * Returns the interval ID so you can clear it.
 */
export function startAutoSave(stores, intervalMs = 120000) {
  console.log(`💾 Auto-save enabled (every ${intervalMs / 1000}s)`);
  const id = setInterval(() => {
    saveAllData(stores);
  }, intervalMs);

  // Also flush queued database writes on process shutdown.
  let shuttingDown = false;
  const graceful = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("💾 Saving data before exit...");
    await saveAllData(stores);
    await flushPersistence();
    await closePersistence();
    process.exit(0);
  };
  process.on("SIGINT", graceful);
  process.on("SIGTERM", graceful);

  return id;
}

export { DB_DIR };

/** Pool for the settings database, or null in JSON mode. Used by the external plugin table. */
export function getPersistencePool() {
  return _postgresPool;
}

/** JSON fallback for the external plugin table (used when no database is configured). */
export const EPLUGIN_JSON_FILE = path.join(DB_DIR, "eplugins.json");
