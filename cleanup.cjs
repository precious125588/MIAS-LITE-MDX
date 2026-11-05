#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════
   cleanup.cjs — MAIS MDX Railway volume sweeper  (FIX: "volume always full")
   ──────────────────────────────────────────────────────────────────────────
   WHAT IT DOES (all offline, no installs needed):
     1. Deletes temp download dirs older than 6h from os.tmpdir()
        (apkdl-*, wavid-*, v21vid-*, v21aud-*, v21bin-*, ytmatev-*, ytmatea-*,
         tgstk-*, playtmp-*) — crashed downloads used to leave GBs behind.
     2. Deletes WhatsApp session backup folders older than 7 days from
        ./auth-* and ./sessions-* (dead pairings from crashed QR scans).
     3. Trims names.json (pushName cache) to the newest 2000 entries.
   RUNS AUTOMATICALLY: required at the top of server startup (see below) and
   then every 6 hours. Also safe to run manually: `node cleanup.cjs`
   ══════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_PREFIXES = ['apkdl-', 'wavid-', 'v21vid-', 'v21aud-', 'v21bin-', 'ytmatev-', 'ytmatea-', 'tgstk-', 'playtmp-'];
const TMP_MAX_AGE_MS = 6 * 60 * 60 * 1000;        // 6 hours
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const NAMES_MAX_ENTRIES = 2000;

function rmRf(p) { try { fs.rmSync(p, { recursive: true, force: true }); return true; } catch { return false; } }

function sweepTmp() {
  let freed = 0, removed = 0;
  const dir = os.tmpdir();
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { return { freed, removed }; }
  const now = Date.now();
  for (const name of entries) {
    if (!TMP_PREFIXES.some((p) => name.startsWith(p))) continue;
    const full = path.join(dir, name);
    try {
      const st = fs.statSync(full);
      if (now - st.mtimeMs > TMP_MAX_AGE_MS) {
        const size = st.size;
        if (rmRf(full)) { removed++; freed += size; }
      }
    } catch {}
  }
  return { freed, removed };
}

function sweepSessions(root) {
  let removed = 0;
  let entries = [];
  try { entries = fs.readdirSync(root); } catch { return removed; }
  const now = Date.now();
  for (const name of entries) {
    if (!/^(auth|sessions)[-_]/i.test(name)) continue;
    const full = path.join(root, name);
    try {
      const st = fs.statSync(full);
      if (!st.isDirectory()) continue;
      if (now - st.mtimeMs > SESSION_MAX_AGE_MS && rmRf(full)) removed++;
    } catch {}
  }
  return removed;
}

function trimNamesFile(root) {
  const file = path.join(root, 'mias', 'names.json');
  try {
    if (!fs.existsSync(file)) return false;
    const obj = JSON.parse(fs.readFileSync(file, 'utf8') || '{}');
    const keys = Object.keys(obj);
    if (keys.length <= NAMES_MAX_ENTRIES) return false;
    const trimmed = {};
    for (const k of keys.slice(-NAMES_MAX_ENTRIES)) trimmed[k] = obj[k];
    fs.writeFileSync(file, JSON.stringify(trimmed), 'utf8');
    return true;
  } catch { return false; }
}

function runOnce() {
  const root = __dirname;
  const tmp = sweepTmp();
  const sessions = sweepSessions(root);
  const names = trimNamesFile(root);
  const mb = (tmp.freed / (1024 * 1024)).toFixed(1);
  console.log(`[cleanup] tmp dirs removed: ${tmp.removed} (freed ~${mb} MB) | stale session folders removed: ${sessions} | names.json trimmed: ${names ? 'yes' : 'no'}`);
}

runOnce();
// Re-run every 6 hours, never block process exit.
const t = setInterval(runOnce, 6 * 60 * 60 * 1000);
t.unref?.();

module.exports = { runOnce };
