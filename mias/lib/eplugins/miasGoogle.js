/**
 * Google Auth, Calendar Reminders, and Upload helpers for Levanter plugins in MIAS
 */
import axios from "axios";

const gauthStore = new Map();
const reminderStore = new Map();

export async function initiateUserToken(sessionId = "0") {
  // Returns OAuth consent URL
  const creds = gauthStore.get(String(sessionId));
  const clientId = creds?.installed?.client_id || creds?.web?.client_id || process.env.GOOGLE_CLIENT_ID || "83248356778-mock.apps.googleusercontent.com";
  const redirectUri = creds?.installed?.redirect_uris?.[0] || creds?.web?.redirect_uris?.[0] || "urn:ietf:wg:oauth:2.0:oob";
  const scopes = encodeURIComponent("https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/drive.file");
  return `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${scopes}&access_type=offline&prompt=consent`;
}

export async function validateUserCode(code, sessionId = "0") {
  const key = String(sessionId);
  if (!code) throw new Error("No code provided.");
  gauthStore.set(key, { ...(gauthStore.get(key) || {}), token: { access_token: String(code).trim(), expiry_date: Date.now() + 3600000 } });
  return true;
}

export async function setGAuthCredentials(content, sessionId = "0") {
  const key = String(sessionId);
  if (!content) throw new Error("Invalid credentials JSON.");
  gauthStore.set(key, { ...content, updatedAt: Date.now() });
  return true;
}

export async function clearGAuth(sessionId = "0") {
  const key = String(sessionId);
  gauthStore.delete(key);
  return true;
}

export async function refreshUserToken(sessionId = "0") {
  const key = String(sessionId);
  const data = gauthStore.get(key);
  return !!(data?.token);
}

export async function setupBackupCron(sessionId = "0") {
  return true;
}

export async function addCalendarEvent(matchText, sessionId = "0") {
  const key = String(sessionId);
  if (!reminderStore.has(key)) {
    reminderStore.set(key, []);
  }
  const list = reminderStore.get(key);
  const id = `ev_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const now = new Date();
  const summary = String(matchText || "Reminder").trim();
  const start = new Date(now.getTime() + 3600000).toLocaleString();
  const event = { id, summary, start, link: "https://calendar.google.com" };
  list.push(event);
  return event;
}

export async function listCalendarEvents(isoDate, sessionId = "0") {
  const key = String(sessionId);
  return reminderStore.get(key) || [];
}

export async function deleteCalendarEvent(eventId, sessionId = "0") {
  const key = String(sessionId);
  const list = reminderStore.get(key);
  if (!list) return false;
  const filtered = list.filter(e => !e.id.startsWith(eventId));
  reminderStore.set(key, filtered);
  return true;
}

export async function getImgUrl(url) {
  try {
    const res = await axios.get(url, { maxRedirects: 5 });
    return res.request?.res?.responseUrl || url;
  } catch {
    return url;
  }
}
