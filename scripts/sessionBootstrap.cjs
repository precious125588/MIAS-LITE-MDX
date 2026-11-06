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

function tryDecodeJsonPayload(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const str = raw.trim();
  if (str.startsWith('{') && str.endsWith('}')) {
    try {
      const p = JSON.parse(str);
      if (p && (p.noiseKey || p.me || p.creds || p.registrationId || p.signedIdentityKey)) {
        return p.creds || p;
      }
    } catch {}
  }
  return null;
}

function tryDecodeBase64String(candidate) {
  if (!candidate || typeof candidate !== 'string') return null;
  let clean = candidate.trim().replace(/^["']+|["']+$/g, '');
  if (!clean || clean.length < 20) return null;

  // Handle URL-safe base64
  clean = clean.replace(/-/g, '+').replace(/_/g, '/');
  // Pad if missing "="
  const pad = clean.length % 4;
  if (pad) {
    clean += '='.repeat(4 - pad);
  }

  try {
    const decoded = Buffer.from(clean, 'base64').toString('utf8');
    if (!decoded.includes('{')) return null;
    const parsed = JSON.parse(decoded);
    if (parsed && (parsed.noiseKey || parsed.me || parsed.creds || parsed.registrationId || parsed.signedIdentityKey)) {
      return parsed.creds || parsed;
    }
  } catch {}
  return null;
}

function extractCredsFromRawSessionId(rawSessionId) {
  if (!rawSessionId) return null;
  const raw = String(rawSessionId).trim();

  // 1. Direct JSON check
  const directJson = tryDecodeJsonPayload(raw);
  if (directJson) return directJson;

  // 2. Direct base64 decode
  const directB64 = tryDecodeBase64String(raw);
  if (directB64) return directB64;

  // 3. Candidates from splitting by delimiter (~, _, -, :)
  const candidates = [];
  if (raw.includes('~')) {
    candidates.push(raw.slice(raw.lastIndexOf('~') + 1));
    candidates.push(raw.slice(raw.indexOf('~') + 1));
  }
  if (raw.includes(':')) {
    candidates.push(raw.slice(raw.lastIndexOf(':') + 1));
    candidates.push(raw.slice(raw.indexOf(':') + 1));
  }

  // 4. Known prefixes (case-insensitive)
  const prefixes = [
    'JUST_X', 'JUST-X', 'JUSTX',
    'MIAS-LITE-MDX', 'MIAS_LITE_MDX', 'MIAS_MDX', 'MIAS-MDX',
    'MIAS-LITE', 'MIAS_LITE', 'MIASLITE', 'MIAS',
    'MAIS-LITE-MDX', 'MAIS_MDX', 'MAIS-LITE', 'MAIS',
    'SESSION'
  ];
  for (const p of prefixes) {
    if (raw.toUpperCase().startsWith(p)) {
      const stripped = raw.slice(p.length).replace(/^[~_\-:\s]+/, '');
      candidates.push(stripped);
    }
  }

  // 5. Generic regex: strip any prefix before the first separator [~_:]
  const genericMatch = raw.match(/^[A-Za-z0-9_-]+[~_:\s]+(.+)$/);
  if (genericMatch && genericMatch[1]) {
    candidates.push(genericMatch[1]);
  }

  for (const cand of candidates) {
    const jsonAttempt = tryDecodeJsonPayload(cand);
    if (jsonAttempt) return jsonAttempt;
    const b64Attempt = tryDecodeBase64String(cand);
    if (b64Attempt) return b64Attempt;
  }

  return null;
}

function resolveConfiguredOwnerName() {
  if (process.env.OWNER_NAME && !/^\d+$/.test(process.env.OWNER_NAME.trim())) {
    const clean = process.env.OWNER_NAME.trim();
    if (!/^(?:zuko|𝕫𝕦𝕜𝕠)$/i.test(clean)) return clean;
  }
  if (process.env.BOT_ACTIVE_USER && process.env.BOT_ACTIVE_USER !== 'User' && !/^\d+$/.test(process.env.BOT_ACTIVE_USER.trim())) {
    const clean = process.env.BOT_ACTIVE_USER.trim();
    if (!/^(?:zuko|𝕫𝕦𝕜𝕠)$/i.test(clean)) return clean;
  }
  return null;
}

async function fetchSessionCreds(sessionId, serverUrl) {
  const cleanBase = String(serverUrl || '').trim().replace(/\/+$/, '');
  if (!cleanBase) return null;

  const idCandidates = [sessionId];
  const stripped = sessionId.replace(/^(?:JUST[-_ ]?X|MIAS[-_ ]?(?:LITE[-_ ]?)?MDX|MIAS[-_ ]?LITE|MIAS|MAIS)[~_ -]/i, '');
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

  // 1. Embedded URL from session ID
  if (embeddedUrl) add(embeddedUrl);

  // 2. Explicit environment variables
  add(process.env.SESSION_SERVER_URL);
  add(process.env.SESSION_SERVICE_URL);
  add(process.env.SESSION_URL);
  add(process.env.RAILWAY_SESSION_URL);

  // 3. Railway platform automatic variables
  if (process.env.RAILWAY_STATIC_URL) add(process.env.RAILWAY_STATIC_URL);
  if (process.env.RAILWAY_PUBLIC_DOMAIN) add(process.env.RAILWAY_PUBLIC_DOMAIN);

  // 4. Railway private networking
  const internalHosts = [
    'mias-lite-mdx-session.railway.internal',
    'mias-session.railway.internal',
    'session.railway.internal',
    'session-service.railway.internal',
    'pairing.railway.internal',
    'pair.railway.internal',
    'session-generator.railway.internal',
    'generator.railway.internal',
    'web.railway.internal',
    'server.railway.internal',
    'app.railway.internal'
  ];
  const commonPorts = ['3000', '8080', '5000', '80'];
  for (const host of internalHosts) {
    for (const p of commonPorts) {
      add(`http://${host}:${p}`);
    }
  }

  // 5. Common public service hostnames
  add('https://mias-lite-mdx-session.up.railway.app');
  add('https://mias-session.up.railway.app');

  // 6. Localhost fallbacks
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

  // 1. Check if it is a self-contained base64 or JSON creds payload
  const decodedCreds = extractCredsFromRawSessionId(rawSessionId);
  if (decodedCreds) {
    credsObj = decodedCreds;
    phone = credsObj.me?.id ? String(credsObj.me.id).split(':')[0].replace(/[^0-9]/g, '') : '';
    console.log(`[JUST-X bootstrap] Successfully decoded self-contained base64 credentials!`);
  }

  // 2. If not decoded, check for embedded server URL or resolve from candidate session servers
  if (!credsObj) {
    let lookupId = rawSessionId;
    let embeddedUrl = null;

    // Pattern: [PREFIX~]https://my-session.up.railway.app~TOKEN
    const embeddedMatch = rawSessionId.match(/^(?:[A-Za-z0-9_-]+[~_ -])?(https?:\/\/[^~_ -]+)[~_ -](.+)$/i);
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
      console.warn(`[JUST-X bootstrap] Automatic resolution could not contact an active session service at: ${candidates.slice(0, 6).join(', ')}...`);
      console.warn(`[JUST-X bootstrap] If your session generator is hosted on another Railway service or public domain, set SESSION_SERVER_URL=https://your-service.up.railway.app or use a self-contained base64 session ID.`);
    }
  }

  if (!credsObj) {
    console.error(`[JUST-X bootstrap] Could not parse or retrieve valid credentials from SESSION_ID.`);
    return null;
  }

  // Ensure registered is true so Baileys / pair.js credsAreComplete treats it as ready
  if (credsObj.registered !== false) {
    credsObj.registered = true;
  }

  const rawJid = credsObj.me?.id || (phone ? `${phone}@s.whatsapp.net` : 'bot@s.whatsapp.net');
  const digits = String(rawJid).split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
  const canonicalJid = digits ? `${digits}@s.whatsapp.net` : rawJid;
  if (digits === "2349068551055" || (process.env.DISCARD_SESSIONS && process.env.DISCARD_SESSIONS.includes(digits))) {
    console.warn(`[session-bootstrap] Skipping discarded/unwanted session ${canonicalJid}`);
    return null;
  }
  const pushNameCandidate = (credsObj.me?.name || credsObj.me?.verifiedName || credsObj.me?.notify || '').trim();
  const configuredOwner = resolveConfiguredOwnerName();

  let sessionUserName = 'Owner';
  if (pushNameCandidate && !/^\d+$/.test(pushNameCandidate) && !/^(?:zuko|𝕫𝕦𝕜𝕠)$/i.test(pushNameCandidate)) {
    sessionUserName = pushNameCandidate;
  } else if (configuredOwner && !/^(?:zuko|𝕫𝕦𝕜𝕠)$/i.test(configuredOwner)) {
    sessionUserName = configuredOwner;
  } else if (digits) {
    sessionUserName = `+${digits}`;
  }

  console.log(`[JUST-X bootstrap] Session authenticated for ${canonicalJid}!`);
  console.log(`BOT LIVE for ${sessionUserName}`);
  return {
    canonicalJid,
    digits,
    credsObj,
    sessionUserName,
    pushName: (pushNameCandidate && !/^\d+$/.test(pushNameCandidate)) ? pushNameCandidate : configuredOwner || null
  };
}

module.exports = {
  bootstrapSessionFromEnv,
  fetchSessionCreds,
  resolveCandidateServerUrls,
  extractCredsFromRawSessionId
};
