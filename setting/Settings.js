const fs = require('fs');
const path = require('path');

let nexstoreDir = null;
try {
  const sessionPaths = require('../sessionPaths.js');
  if (sessionPaths && typeof sessionPaths.nexstoreRoot === 'function') {
    nexstoreDir = sessionPaths.nexstoreRoot();
  }
} catch {}

const PRIMARY_VOL_SETTINGS = nexstoreDir ? path.join(nexstoreDir, 'settings.json') : null;
const AUTH_SETTINGS = process.env.AUTH_DIR
  ? path.join(path.resolve(process.env.AUTH_DIR), 'database', 'legacy-settings.json')
  : null;
const LOCAL_SETTINGS = path.join(__dirname, 'setting.json');
const ROOT_DB_SETTINGS = path.join(__dirname, '..', 'database', 'settings.json');

const CANDIDATE_PATHS = [
  PRIMARY_VOL_SETTINGS,
  AUTH_SETTINGS,
  LOCAL_SETTINGS,
  ROOT_DB_SETTINGS,
  path.join(process.cwd(), 'setting', 'setting.json'),
  path.join(process.cwd(), 'setting.json'),
  path.join(__dirname, '..', 'setting.json'),
].filter(Boolean);

let settings = {};

function readSettings(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const content = fs.readFileSync(file, 'utf8').trim();
    if (!content) return null;
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function loadMergedSettings() {
  const merged = {};
  // Read in reverse order so primary locations override older ones
  for (let i = CANDIDATE_PATHS.length - 1; i >= 0; i--) {
    const f = CANDIDATE_PATHS[i];
    const data = readSettings(f);
    if (data) {
      for (const [jid, val] of Object.entries(data)) {
        if (val && typeof val === 'object' && !Array.isArray(val)) {
          merged[jid] = { ...(merged[jid] || {}), ...val };
        } else if (val !== undefined) {
          merged[jid] = val;
        }
      }
    }
  }
  return merged;
}

try {
  settings = loadMergedSettings();
  console.log(`[settings] Loaded persistent settings for ${Object.keys(settings).length} chats.`);
} catch (e) {
  console.error('[settings] Failed to load settings:', e.message);
  settings = {};
}

function safeWriteJson(targetPath, obj) {
  try {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(obj, null, 2), 'utf8');
    fs.renameSync(tempPath, targetPath);
    return true;
  } catch (err) {
    console.warn(`[settings] Write failed for ${targetPath}:`, err.message);
    return false;
  }
}

function saveSettings() {
  const targets = new Set([
    PRIMARY_VOL_SETTINGS,
    AUTH_SETTINGS,
    LOCAL_SETTINGS,
    ROOT_DB_SETTINGS,
  ].filter(Boolean));

  for (const t of targets) {
    safeWriteJson(t, settings);
  }
}

function getSetting(jid, key, defaultValue = false) {
  if (!settings[jid]) return defaultValue;
  return settings[jid][key] !== undefined ? settings[jid][key] : defaultValue;
}

function setSetting(jid, key, value) {
  if (!settings[jid]) settings[jid] = {};
  settings[jid][key] = value;
  saveSettings();
}

module.exports = { getSetting, setSetting, readSettings, saveSettings };
