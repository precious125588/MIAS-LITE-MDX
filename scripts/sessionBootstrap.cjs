'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

async function fetchSessionCreds(sessionId, serverUrl) {
  const urlStr = `${serverUrl.replace(/\/+$/, '')}/session/${encodeURIComponent(sessionId)}`;
  const url = new URL(urlStr);
  const client = url.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const req = client.get(url, { timeout: 12000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode === 200 && parsed.ok && parsed.creds) {
            resolve(parsed);
          } else {
            reject(new Error(parsed.error || `HTTP ${res.statusCode}`));
          }
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Session server request timed out'));
    });
  });
}

async function bootstrapSessionFromEnv() {
  const rawSessionId = String(process.env.SESSION_ID || '').trim();
  if (!rawSessionId) return null;

  console.log(`[JUST-X bootstrap] Detected SESSION_ID: ${rawSessionId.slice(0, 15)}...`);

  let credsObj = null;
  let phone = '';

  // 1. Check if it's a direct base64-encoded creds payload (prefixed with JUST_X~, JUST-X~ or raw)
  const stripped = rawSessionId.replace(/^(JUST[-_ ]?X|MIAS[-_ ]?LITE)[~_ -]/i, '');
  try {
    const decoded = Buffer.from(stripped, 'base64').toString('utf8');
    const parsed = JSON.parse(decoded);
    if (parsed && (parsed.noiseKey || parsed.me || parsed.registrationId)) {
      credsObj = parsed;
      phone = parsed.me?.id ? String(parsed.me.id).split(':')[0].replace(/[^0-9]/g, '') : '';
      console.log(`[JUST-X bootstrap] Successfully decoded self-contained base64 credentials!`);
    }
  } catch {}

  // 2. If not raw base64, check if it's a short session ID to fetch from server
  if (!credsObj) {
    const serverUrl = process.env.SESSION_SERVER_URL || 'http://localhost:3000';
    console.log(`[JUST-X bootstrap] Resolving session from ${serverUrl}...`);
    try {
      const result = await fetchSessionCreds(rawSessionId, serverUrl);
      credsObj = result.creds;
      phone = result.phoneNumber || '';
    } catch (err) {
      console.error(`[JUST-X bootstrap] Failed to fetch session from server:`, err.message);
      return null;
    }
  }

  if (!credsObj) {
    console.error(`[JUST-X bootstrap] Could not parse or retrieve valid credentials from SESSION_ID.`);
    return null;
  }

  const rawJid = credsObj.me?.id || (phone ? `${phone}@s.whatsapp.net` : 'bot@s.whatsapp.net');
  const digits = String(rawJid).split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
  const canonicalJid = digits ? `${digits}@s.whatsapp.net` : rawJid;

  console.log(`[JUST-X bootstrap] Session authenticated for ${canonicalJid}!`);
  return { canonicalJid, digits, credsObj };
}

module.exports = { bootstrapSessionFromEnv, fetchSessionCreds };
