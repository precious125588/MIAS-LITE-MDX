'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

function makeGetRequest(urlStr, timeoutMs = 2500) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlStr);
    } catch (e) {
      return reject(new Error(`Invalid URL: ${urlStr}`));
    }

    const client = url.protocol === 'https:' ? https : http;
    const req = client.get(url, { timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode === 200) {
            resolve(parsed);
          } else {
            reject(new Error(parsed.error || `HTTP ${res.statusCode}`));
          }
        } catch (e) {
          reject(new Error(`HTTP ${res.statusCode} (non-JSON response)`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timed out'));
    });
  });
}

async function fetchSessionCreds(sessionId, serverUrl) {
  const cleanBase = String(serverUrl || '').trim().replace(/\/+$/, '');
  if (!cleanBase) return null;

  const idCandidates = [sessionId];
  const stripped = sessionId.replace(/^(?:JUST[-_ ]?X|MIAS[-_ ]?LITE)[~_ -]/i, '');
  if (stripped && stripped !== sessionId) {
    idCandidates.push(stripped);
  }

  for (const id of idCandidates) {
    const endpoints = [
      `${cleanBase}/session/${encodeURIComponent(id)}`,
      `${cleanBase}/api/session/${encodeURIComponent(id)}`
    ];

    for (const urlStr of endpoints) {
      try {
        const parsed = await makeGetRequest(urlStr, 2500);
        if (parsed && (parsed.ok || parsed.creds) && parsed.creds) {
          return parsed;
        }
      } catch {}
    }
  }
  return null;
}

function resolveCandidateServerUrls(embeddedUrl) {
  const candidates = [];
  const add = (raw) => {
    if (!raw) return;
    let trimmed = String(raw).trim();
    if (!trimmed) return;
    if (!/^https?:\/\//i.test(trimmed)) {
      trimmed = `https://${trimmed}`;
    }
    try {
      const parsed = new URL(trimmed);
      const normalized = `${parsed.protocol}//${parsed.host}`;
      if (!candidates.includes(normalized)) {
        candidates.push(normalized);
      }
    } catch {}
  };

  // 1. Embedded URL from session ID (e.g. JUST_X~https://mysession.com~token)
  if (embeddedUrl) add(embeddedUrl);

  // 2. Explicit environment variables
  add(process.env.SESSION_SERVER_URL);
  add(process.env.SESSION_SERVICE_URL);
  add(process.env.SESSION_URL);
  add(process.env.RAILWAY_SESSION_URL);

  // 3. Railway platform automatic variables
  if (process.env.RAILWAY_STATIC_URL) add(process.env.RAILWAY_STATIC_URL);
  if (process.env.RAILWAY_PUBLIC_DOMAIN) add(process.env.RAILWAY_PUBLIC_DOMAIN);

  // 4. Railway private networking (multi-service internal DNS across common service names and ports)
  const internalHosts = [
    'mias-lite-mdx-session.railway.internal',
    'session.railway.internal',
    'session-service.railway.internal',
    'pairing.railway.internal',
    'pair.railway.internal',
    'session-generator.railway.internal',
    'generator.railway.internal'
  ];
  const commonPorts = ['3000', '8080', '80'];
  for (const host of internalHosts) {
    for (const p of commonPorts) {
      add(`http://${host}:${p}`);
    }
  }

  // 5. Localhost fallbacks (single-container or local dev)
  add('http://localhost:3000');
  add('http://localhost:8080');
  add('http://127.0.0.1:3000');
  add('http://127.0.0.1:8080');

  return candidates;
}

async function bootstrapSessionFromEnv() {
  const rawSessionId = String(process.env.SESSION_ID || '').trim();
  if (!rawSessionId) return null;

  console.log(`[JUST-X bootstrap] Detected SESSION_ID: ${rawSessionId.slice(0, 15)}...`);

  let credsObj = null;
  let phone = '';

  // 1. Check if it's a self-contained base64-encoded creds payload (prefixed or raw)
  const stripped = rawSessionId.replace(/^(?:JUST[-_ ]?X|MIAS[-_ ]?LITE)[~_ -]/i, '');
  try {
    const decoded = Buffer.from(stripped, 'base64').toString('utf8');
    const parsed = JSON.parse(decoded);
    if (parsed && (parsed.noiseKey || parsed.me || parsed.registrationId)) {
      credsObj = parsed;
      phone = parsed.me?.id ? String(parsed.me.id).split(':')[0].replace(/[^0-9]/g, '') : '';
      console.log(`[JUST-X bootstrap] Successfully decoded self-contained base64 credentials!`);
    }
  } catch {}

  // 2. If not raw base64, check for embedded server URL or resolve from candidate session servers
  if (!credsObj) {
    let lookupId = rawSessionId;
    let embeddedUrl = null;

    // Pattern: JUST_X~https://my-session.up.railway.app~TOKEN
    const embeddedMatch = rawSessionId.match(/^(?:JUST[-_ ]?X|MIAS[-_ ]?LITE)[~_ -](https?:\/\/[^~_ -]+)[~_ -](.+)$/i);
    if (embeddedMatch) {
      embeddedUrl = embeddedMatch[1];
      lookupId = embeddedMatch[2];
      console.log(`[JUST-X bootstrap] Detected embedded session server URL: ${embeddedUrl}`);
    }

    const candidates = resolveCandidateServerUrls(embeddedUrl);
    console.log(`[JUST-X bootstrap] Resolving session automatically across ${candidates.length} candidate servers...`);

    for (const serverUrl of candidates) {
      try {
        const result = await fetchSessionCreds(lookupId, serverUrl);
        if (result && result.creds) {
          credsObj = result.creds;
          phone = result.phoneNumber || '';
          console.log(`[JUST-X bootstrap] Successfully retrieved credentials from ${serverUrl}!`);
          break;
        }
      } catch (err) {
        // Continue to next candidate
      }
    }

    if (!credsObj && candidates.length > 0) {
      console.warn(`[JUST-X bootstrap] Automatic resolution could not contact an active session service at: ${candidates.join(', ')}`);
      console.warn(`[JUST-X bootstrap] If your session generator is hosted on another Railway service or public domain, set SESSION_SERVER_URL=https://your-service.up.railway.app or use a self-contained base64 session ID.`);
    }
  }

  if (!credsObj) {
    console.error(`[JUST-X bootstrap] Could not parse or retrieve valid credentials from SESSION_ID.`);
    return null;
  }

  const rawJid = credsObj.me?.id || (phone ? `${phone}@s.whatsapp.net` : 'bot@s.whatsapp.net');
  const digits = String(rawJid).split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
  const canonicalJid = digits ? `${digits}@s.whatsapp.net` : rawJid;
  const pushNameCandidate = (credsObj.me?.name || credsObj.me?.verifiedName || credsObj.me?.notify || '').trim();
  const sessionUserName = (pushNameCandidate && !/^\d+$/.test(pushNameCandidate))
    ? pushNameCandidate
    : (phone || digits || 'User').trim();

  console.log(`[JUST-X bootstrap] Session authenticated for ${canonicalJid}!`);
  console.log(`BOT LIVE for ${sessionUserName}`);
  return { canonicalJid, digits, credsObj, sessionUserName, pushName: pushNameCandidate || null };
}

module.exports = { bootstrapSessionFromEnv, fetchSessionCreds, resolveCandidateServerUrls };
