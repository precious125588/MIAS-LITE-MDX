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
    const req = client.get(url, { timeout: 10000 }, (res) => {
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

  console.log(`[session-bootstrap] Detected SESSION_ID environment variable...`);

  let credsObj = null;
  let phone = '';

  if (rawSessionId.startsWith('MIAS_LITE_~') || rawSessionId.startsWith('MIAS_')) {
    const serverUrl = process.env.SESSION_SERVER_URL || 'http://localhost:3000';
    console.log(`[session-bootstrap] Resolving short session ID from ${serverUrl}...`);
    try {
      const result = await fetchSessionCreds(rawSessionId, serverUrl);
      credsObj = result.creds;
      phone = result.phoneNumber || '';
    } catch (err) {
      console.error(`[session-bootstrap] Failed to fetch session from server:`, err.message);
      return null;
    }
  } else {
    // Try base64
    try {
      const decoded = Buffer.from(rawSessionId, 'base64').toString('utf8');
      credsObj = JSON.parse(decoded);
    } catch {
      try {
        credsObj = JSON.parse(rawSessionId);
      } catch {}
    }
  }

  if (!credsObj) {
    console.error(`[session-bootstrap] Invalid or unparseable SESSION_ID.`);
    return null;
  }

  const rawJid = credsObj.me?.id || (phone ? `${phone}@s.whatsapp.net` : 'bot@s.whatsapp.net');
  const digits = String(rawJid).split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
  const canonicalJid = digits ? `${digits}@s.whatsapp.net` : rawJid;

  console.log(`[session-bootstrap] Successfully extracted credentials for ${canonicalJid}!`);
  return { canonicalJid, digits, credsObj };
}

module.exports = { bootstrapSessionFromEnv, fetchSessionCreds };
