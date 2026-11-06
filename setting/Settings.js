const fs = require('fs');
const path = require('path');

// Prefer the per-session persistent volume used by the launcher. Keep the
// historical project-relative file as a fallback for local development.
const SETTINGS_PATH = process.env.AUTH_DIR
  ? path.join(path.resolve(process.env.AUTH_DIR), 'database', 'legacy-settings.json')
  : path.join(__dirname, '..', 'setting.json');
const LEGACY_PATHS = [...new Set([
  path.resolve(process.cwd(), 'setting.json'),
  path.join(__dirname, 'setting.json'),
  path.join(__dirname, '..', 'setting.json'),
].filter(file => file !== SETTINGS_PATH))];

let settings = {};
function readSettings(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8') || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

try {
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  settings = readSettings(SETTINGS_PATH) || {};
  if (!fs.existsSync(SETTINGS_PATH)) {
    // One-time, non-destructive migration from older relative locations.
    for (const legacyPath of LEGACY_PATHS) {
      const legacy = readSettings(legacyPath);
      if (legacy) { settings = legacy; break; }
    }
    saveSettings();
  }
} catch (e) {
  console.error('Failed to load settings.json', e);
  settings = {};
}

function saveSettings() {
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  const tempPath = `${SETTINGS_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(settings, null, 2), 'utf8');
  fs.renameSync(tempPath, SETTINGS_PATH);
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

module.exports = { getSetting, setSetting };
