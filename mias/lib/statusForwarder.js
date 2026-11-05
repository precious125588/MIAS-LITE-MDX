/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║           STATUS → NEWSLETTER FORWARDER — MAIS MDX             ║
 * ║  Forwards creator status updates to a newsletter/channel.      ║
 * ║  Enable/disable toggle. Never affects normal operation.        ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, "..", "database", "status_forwarder.json");

let _config = loadConfig();

function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return { enabled: false, destination: null };
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8") || "{}");
  } catch { return { enabled: false, destination: null }; }
}

function saveConfig() {
  try {
    const dir = path.dirname(CONFIG_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(_config, null, 2));
  } catch (e) {
    console.error("[StatusForwarder] Failed to save config:", e.message);
  }
}

export function setDestination(jid) {
  _config.destination = jid;
  saveConfig();
}

export function setEnabled(val) {
  _config.enabled = !!val;
  saveConfig();
}

export function getConfig() {
  return { ..._config };
}

/**
 * Forward a status update to the configured destination.
 * Call from your messages.upsert / status event handler.
 * Never throws — failure is silently logged.
 */
export async function forwardStatus(sock, statusMsg) {
  if (!_config.enabled || !_config.destination) return;
  try {
    const msg     = statusMsg?.messages?.[0] || statusMsg;
    if (!msg?.message) return;
    const content = msg.message;
    const dest    = _config.destination;

    // Forward media or text
    const imgMsg  = content.imageMessage;
    const vidMsg  = content.videoMessage;
    const txtMsg  = content.conversation || content.extendedTextMessage?.text;

    if (imgMsg) {
      const mediaData = await sock.downloadMediaMessage(msg);
      await sock.sendMessage(dest, {
        image:   mediaData,
        caption: imgMsg.caption || "📸 Status Update",
        mimetype: imgMsg.mimetype || "image/jpeg",
      });
    } else if (vidMsg) {
      const mediaData = await sock.downloadMediaMessage(msg);
      await sock.sendMessage(dest, {
        video:   mediaData,
        caption: vidMsg.caption || "🎥 Status Update",
        mimetype: vidMsg.mimetype || "video/mp4",
      });
    } else if (txtMsg) {
      await sock.sendMessage(dest, { text: `📢 *Status Update:*\n\n${txtMsg}` });
    }
  } catch (e) {
    console.error("[StatusForwarder] Forward failed:", e.message);
    // Never re-throw — must not affect normal bot operation
  }
}
