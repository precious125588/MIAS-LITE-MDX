'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   precious-master-fix-boot.cjs  ·  v34 — THE MERGED MASTER FIX BOOT
   ──────────────────────────────────────────────────────────────────────────
   ⚠️  THIS IS THE ONLY FIX-BOOT FILE. Every other boot/patch/preflight/verify
   file has been MERGED INTO THIS ONE and deleted:

     MERGED IN (parent side):  fix_all.cjs, fix_session_401.cjs, PATCH-v25/27/
       29/30/31.cjs, precious-fix-pack.cjs  → their edits are BAKED INTO the
       version-controlled tree (this zip). Nothing is patched at runtime any
       more, so a fresh git clone can never boot unpatched.
       precious-session-boot.cjs      → sessionBootInline()  below
       precious-session-fix.cjs       → sessionFixVerify()   below (read-only;
                                        the rewrites are baked into the tree)
       precious-packs-preflight.cjs   → preflightInline()    below
       cleanup.cjs                    → still its own file, but now launched
                                        from bootParent() so EVERY entry point
                                        sweeps the volume, not just npm start
     MERGED IN (child side):   precious-all-packs-boot.cjs → installAll() below
       mias/fix_pack_child.cjs        → superseded, deleted
       fix_pack_runtime.cjs           → shield inlined in bootChild()
       precious-packs-verify.cjs      → scheduleVerify()     below

   ROOT CAUSES THIS v34 FIXES (why "fixes aren't applied" after pairing)
   -------------------------------------------------------------------
   1. SPLIT-BRAIN ENTRY POINTS — railway.toml/Procfile ran
      "node PATCH-v30.cjs && node PATCH-v31.cjs && node server.js", npm start
      ran another chain, start.sh ran a third. Now EVERY entry is simply
      "node server.js" and server.js calls bootParent() at the very top.
   2. RUNTIME PATCHING — the PATCH-vXX scripts rewrote files on every boot of
      a fresh clone. One of those injections (the "__V27_PACK_ENTRY__" block in
      precious-all-packs-boot.cjs) installed precious-fixes-v27 AT REQUIRE TIME
      — BEFORE v20/v21/v24 — so the later packs overwrote v27's handlers.
      v27's fixes silently "weren't applied". That block is gone; v27 now
      installs in its correct slot (after v24, before v28/v29) inside
      installAll() only.
   3. DOUBLE INSTALLS — mias/index.js also required v20 and v27 directly,
      bypassing the loader's marker registry, so handlers were wrapped twice
      and ordering races decided "which fix wins". The direct v27 bootstrap is
      removed; the direct v20 install now SETS the loader marker so installAll
      skips it.
   4. 0 PAIRED SESSIONS ON THE VOLUME — every WhatsApp-facing fix lives in the
      bot CHILD (mias/index.js), which only spawns once a number is paired AND
      the session folder sits on the /app/nexstore volume. With 0 usable
      sessions, no child spawns and NO command fix can load. bootParent now
      says this plainly in the log; after deploying this build, PAIR ONCE and
      the session persists on the volume (session deletes are quarantined,
      never wiped, and legacy session dirs are auto-migrated).

   Everything here is idempotent and marker-guarded: safe on every boot, and a
   single failing pack can NEVER take the bot down.
   ══════════════════════════════════════════════════════════════════════════ */

const fs   = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = __dirname;
const MIAS = path.join(ROOT, 'mias');
const MERGED_BUILD = 'v34-merged-2026-09-19';

const log  = (m) => { try { console.log('[MASTER-FIX] ' + m); } catch (_) {} };
const ok   = (m) => { try { console.log('[MASTER-FIX] ✅ ' + m); } catch (_) {} };
const warn = (m) => { try { console.log('[MASTER-FIX] ⚠️ ' + m); } catch (_) {} };
const bad  = (m) => { try { console.log('[MASTER-FIX] ❌ ' + m); } catch (_) {} };
const plog = (m) => { try { console.log('[packs] ' + m); } catch (_) {} };
const pok  = (m) => { try { console.log('[packs] ✅ ' + m); } catch (_) {} };
const pbad = (m) => { try { console.log('[packs] ❌ ' + m); } catch (_) {} };
const pskip= (m) => { try { console.log('[packs] ⏭  ' + m); } catch (_) {} };

/* ── shared per-process install registry ─────────────────────────────────── */
function marker() {
  if (!globalThis.__PRECIOUS_INSTALLED__) globalThis.__PRECIOUS_INSTALLED__ = Object.create(null);
  return globalThis.__PRECIOUS_INSTALLED__;
}
function isInstalled(key) { return !!marker()[key]; }
function markInstalled(key, value) { marker()[key] = value || true; }
function safeJson(x) { try { return JSON.stringify(x); } catch (_) { return String(x); } }

/* ── multiRequire: load a pack from its own folder, mias/, or root ───────── */
function multiRequire(rel) {
  const abs = path.resolve(ROOT, rel);
  const attempts = [];
  try {
    if (fs.existsSync(abs)) {
      const scoped = Module.createRequire(abs);
      attempts.push({ from: 'self:' + path.relative(ROOT, path.dirname(abs)), fn: () => scoped(abs) });
    }
  } catch (_) {}
  try {
    const miasReq = Module.createRequire(path.join(MIAS, 'noop.js'));
    attempts.push({ from: 'mias', fn: () => miasReq(abs) });
  } catch (_) {}
  attempts.push({ from: 'root', fn: () => require(rel) });

  let lastErr = null;
  for (const a of attempts) {
    try { return { mod: a.fn(), from: a.from, err: null }; }
    catch (e) { lastErr = e; }
  }
  try {
    const extra = [path.join(ROOT, 'node_modules'), path.join(MIAS, 'node_modules')]
      .filter((d) => { try { return fs.existsSync(d); } catch (_) { return false; } });
    if (extra.length) {
      const sep = process.platform === 'win32' ? ';' : ':';
      const cur = process.env.NODE_PATH ? process.env.NODE_PATH.split(sep) : [];
      process.env.NODE_PATH = Array.from(new Set(extra.concat(cur))).join(sep);
      Module._initPaths();
      if (fs.existsSync(abs)) {
        const scoped = Module.createRequire(abs);
        return { mod: scoped(abs), from: 'self+NODE_PATH', err: null };
      }
    }
  } catch (e) { lastErr = e; }
  return { mod: null, from: null, err: lastErr };
}

/* Call whatever install shape a pack exposes (fn / .install / .apply). */
function runPack(loaded, ctx, label, key) {
  if (isInstalled(key)) { pskip(label + ' — already installed earlier this process (skipped)'); return true; }
  if (!loaded || !loaded.mod) {
    pbad(label + ' — ' + (loaded && loaded.err ? loaded.err.message : 'module missing'));
    return false;
  }
  const mod = loaded.mod;
  try {
    if (typeof mod === 'function')         { mod(ctx);                   markInstalled(key);      pok(label + ' — installed (function) [' + loaded.from + ']'); return true; }
    if (typeof mod.install === 'function') { const r = mod.install(ctx); markInstalled(key, r || true); pok(label + ' — installed (.install) [' + loaded.from + ']' + (r ? ' → ' + safeJson(r) : '')); return true; }
    if (typeof mod.apply === 'function')   { const r = mod.apply(ctx);   markInstalled(key, r || true); pok(label + ' — applied (.apply) [' + loaded.from + ']' + (r ? ' → ' + safeJson(r) : '')); return true; }
    warn(label + ' — loaded but exposes no install()/apply(); nothing to call');
    return false;
  } catch (e) { pbad(label + ' — install error: ' + (e && e.message)); return false; }
}

/* ═════════════════════════════ PARENT HELPERS ═════════════════════════════ */

/* (was precious-session-boot.cjs) — volume detection + legacy migration. */
function sessionBootInline() {
  try {
    const SP = require('./sessionPaths');
    const root = SP.ensureSessionRoot();
    const onVolume = SP.isVolumeMounted();
    log('[precious-session-boot] session root = ' + root);
    log('[precious-session-boot] volume mounted at /app/nexstore = ' + (onVolume ? 'YES ✓' : 'no'));
    if (!onVolume && process.env.RAILWAY_ENVIRONMENT) {
      warn('Railway volume NOT found — mount one at /app/nexstore or sessions will not survive deploys.');
    }
    let migrated = 0;
    for (const legacy of SP.legacySessionDirs()) {
      let entries = [];
      try {
        if (!fs.existsSync(legacy) || !fs.statSync(legacy).isDirectory()) continue;
        entries = fs.readdirSync(legacy);
      } catch (e) { continue; }
      for (const entry of entries) {
        try {
          const srcDir = path.join(legacy, entry);
          if (!fs.statSync(srcDir).isDirectory()) continue;
          if (!fs.existsSync(path.join(srcDir, 'creds.json'))) continue;
          const dstDir = path.join(root, entry);
          if (fs.existsSync(path.join(dstDir, 'creds.json'))) continue;
          fs.mkdirSync(dstDir, { recursive: true });
          for (const f of fs.readdirSync(srcDir)) {
            try { fs.copyFileSync(path.join(srcDir, f), path.join(dstDir, f)); } catch (e) {}
          }
          migrated++;
          log('[precious-session-boot] migrated session ' + entry + ' from ' + path.basename(legacy) + ' into the volume ✓');
        } catch (e) {}
      }
    }
    let count = 0;
    try {
      count = fs.readdirSync(root).filter(function (n) {
        try {
          return fs.statSync(path.join(root, n)).isDirectory() &&
            !n.includes('.quarantine-') &&
            fs.existsSync(path.join(root, n, 'creds.json'));
        } catch (e) { return false; }
      }).length;
    } catch (e) {}
    log('[precious-session-boot] usable paired sessions on the volume: ' + count + (migrated ? ' (+' + migrated + ' migrated)' : ''));
    if (count === 0) {
      warn('0 paired sessions → NO WhatsApp bot child will spawn, so NO command fix can load yet.');
      warn('Pair a number (web panel / pair code). The session lands on the volume and every fix pack loads inside that child.');
    }
    return true;
  } catch (e) { bad('session boot skipped: ' + (e && e.message)); return false; }
}

/* (was precious-session-fix.cjs) — the quarantine rewrites are BAKED into the
   tree now; this is a read-only audit that warns if a destructive session
   delete ever sneaks back in. */
function sessionFixVerify() {
  try {
    const SESSIONISH = /(pairing|sessionDir|SESSION_DIR|sessionPath|AUTH_DIR|auth_info|authDir|dirPath|sessions?)/i;
    const targets = ['pair.js', 'server.js', 'index.js', 'autoload.js', 'mias/index.js', path.join('deploy', 'deploymentManager.js')];
    let suspicious = 0;
    for (const rel of targets) {
      const full = path.join(ROOT, rel);
      let src = null;
      try { src = fs.readFileSync(full, 'utf8'); } catch (_) { continue; }
      let idx = 0, fileHits = 0;
      while ((idx = src.indexOf('fs.rmSync(', idx)) !== -1) {
        const argStart = idx + 'fs.rmSync('.length;
        const argEnd = src.indexOf(',', argStart);
        if (argEnd === -1) { idx = argStart; continue; }
        const arg = src.slice(argStart, argEnd);
        idx = argEnd;
        if (SESSIONISH.test(arg) && !/quarantine/i.test(arg)) fileHits++;
      }
      if (/deleteFolderRecursive\([^)]*(session|AUTH|pairing|auth_info)[^)]*\)/i.test(src)) fileHits++;
      if (fileHits) { suspicious += fileHits; warn(rel + ': ' + fileHits + ' destructive session delete(s) found — should be quarantineDir()'); }
    }
    if (!suspicious) ok('session audit clean — no hard session deletes (quarantine-only) ✓');
    return suspicious === 0;
  } catch (e) { bad('session audit skipped: ' + (e && e.message)); return false; }
}

/* ═════════════════════════════ CHILD HELPERS ══════════════════════════════ */

/* (was fix_pack_runtime.cjs installChild) — a bad pack can never kill the socket. */
function installChildShield() {
  if (!globalThis.__MIAS_CHILD_SHIELD__) {
    globalThis.__MIAS_CHILD_SHIELD__ = true;
    process.on('uncaughtException',  (e) => log('[child-shield] uncaughtException: ' + (e && e.message)));
    process.on('unhandledRejection', (e) => log('[child-shield] unhandledRejection: ' + (e && e.message)));
  }
  log('child crash-shield REGISTERED (pid=' + process.pid + ')');
  return true;
}

/* (was precious-packs-verify.cjs) — proves in the log which packs are live. */
function scheduleVerify() {
  if (globalThis.__PACKS_VERIFY_SCHEDULED__) return false;
  globalThis.__PACKS_VERIFY_SCHEDULED__ = true;
  const report = (tag) => {
    try {
      const m = globalThis.__PRECIOUS_INSTALLED__ || {};
      const keys = Object.keys(m).filter((k) => m[k] && m[k] !== 'failed');
      const v30 = globalThis.__V30__ || {};
      console.log('[packs-verify:' + tag + '] installed: ' + (keys.join(', ') || '(none)') +
                ' | v30 build=' + (v30.build || '?') +
        ' tt-guard=' + !!v30.tt +
        ' quote-wraps=' + ((v30.quote || []).length) +
        ' | send .fixcheck in WhatsApp for the in-chat report');
    } catch (_) {}
  };
  for (const ms of [20000, 120000]) {
    try { const t = setTimeout(() => report((ms / 1000) + 's'), ms); if (t && t.unref) t.unref(); } catch (_) {}
  }
  return true;
}

/* (was precious-all-packs-boot.cjs installAll) — EVERY runtime command-fix
   pack, in winning order. Later installs win because `commands` is a Map
   keyed by name. Order: v20 (skipped — installed inline by mias/index.js with
   the marker set) → v21 → gst-picker → v23-rc → v24 → v27 → v28 → v29 →
   tt-quote. The fatal require-time v27 block is GONE. */
function installAll(ctx) {
  ctx = ctx || globalThis.__PRECIOUS__ || {};
  if (globalThis.__ALL_PACKS_BOOTED__) {
    plog('already booted this process — skipping the second pass');
    return globalThis.__ALL_PACKS_RESULT__ || {};
  }
  globalThis.__ALL_PACKS_BOOTED__ = true;
  const result = {};
  const t0 = Date.now();
  plog('════════ ALL FIX PACKS BOOT (' + MERGED_BUILD + ') ════════');

  /* 0. session root must exist before anything reads AUTH_DIR */
  try { require('./sessionPaths').ensureSessionRoot(); result.sessionRoot = true; }
  catch (e) { pbad('sessionPaths.ensureSessionRoot: ' + (e && e.message)); result.sessionRoot = false; }

  /* [v36 STEP 3] v20, v21, v24, v27, v28, v29 replaced by precious-fixes-v36.cjs
     Keeping gstPicker and v23rc, disabled conflicting older packs */
  result.v20 = false;
  result.v21 = false;
  result.gstPicker = runPack(multiRequire('./mias/precious-gst-picker.cjs'), ctx, 'precious-gst-picker', 'gstPicker');
  result.v23rc = runPack(multiRequire('./patches/precious-fixes-v23-rc.cjs'), ctx, 'precious-fixes-v23-rc', 'v23rc');
  result.v24 = false;
  result.v27 = false;
  result.v28 = false;
  result.v29 = false;
  /* v29 retired: its fixes now live in precious-fixes-v36 (inline in mias/index.js)
     and v37/v38. Its re-install timers are gone. */

  /* [v37 STEP] Unified fix pack for the seven reported regressions
     (anonymous ticks, settings silent-quoted reply, gst target resolution,
      anime GC bad-request, emoji forward, real pin, status-reply Meta-AI
     badge). Loaded LAST so its overrides always win over v36. */
  try {
    const v37 = multiRequire('./mias/precious-fixes-v37.cjs');
    if (v37.mod && typeof v37.mod === 'function') {
      try { v37.mod(globalThis.__PRECIOUS__ || ctx); result.v37 = true; plog('precious-fixes-v37: INSTALLED (anon|gst|anime|emoji|pin|status)'); }
      catch (e37) { result.v37 = false; pbad('precious-fixes-v37 error: ' + (e37 && e37.message)); }
    } else {
      result.v37 = false;
      pbad('precious-fixes-v37 missing module export');
    }
  } catch (e) { result.v37 = false; pbad('precious-fixes-v37 require failed: ' + (e && e.message)); }

  /* [v38] Status vCard opt-in (default OFF), group protections that keep
     running in private mode, persistent settings toggles, owner-only guard
     on .setting/.sudo/.cuz/.mode/.self/.public and the real .pin. Loaded
     LAST so it overrides v36/v37 where they disagree. */
  try {
    const v38 = multiRequire('./mias/precious-fixes-v38.cjs');
    if (v38.mod) {
      const fn = (typeof v38.mod === 'function') ? v38.mod : v38.mod.install;
      if (typeof fn === 'function') {
        try { const r38 = fn(globalThis.__PRECIOUS__ || ctx); result.v38 = true;
          plog('precious-fixes-v38: INSTALLED (vcard-off|protect-always|persist|owner-guard|real-pin) ' + safeJson(r38 || {})); }
        catch (e38) { result.v38 = false; pbad('precious-fixes-v38 error: ' + (e38 && e38.message)); }
      } else { result.v38 = false; pbad('precious-fixes-v38 has no install()'); }
    } else {
      result.v38 = false;
      pbad('precious-fixes-v38 failed to load: ' + (v38.err && v38.err.message));
    }
  } catch (e) { result.v38 = false; pbad('precious-fixes-v38 require failed: ' + (e && e.message)); }

  const slots = Object.keys(result).length;
  const good  = Object.values(result).filter(Boolean).length;
  const dt    = Date.now() - t0;
  plog('════════ DONE — loaded ' + good + '/' + slots + ' pack slots in ' + dt + 'ms ════════');
  globalThis.__ALL_PACKS_RESULT__ = result;
  return result;
}

/* ════════════════════════════════ PARENT ════════════════════════════════
   Called at the VERY TOP of server.js (and index.js). Runs once per process. */
function bootParent() {
  
  if (globalThis.__PRECIOUS_MASTER_PARENT__) {
    log('parent boot already done — skipping (dedup guard)');
    return globalThis.__PRECIOUS_MASTER_PARENT__;
  }
  const t0 = Date.now();
  log('════════ PARENT BOOT (' + MERGED_BUILD + ') — merged fix boot ════════');

  const result = { cleanup: false, sessionBoot: false, sessionAudit: false, audit: null };

  /* 0. Volume sweeper (was only run by `npm start` — Railway never saw it). */
  // cleanup.cjs is optional; this repo does not ship it, so skip it quietly
  // instead of printing a module-not-found warning on every boot.
  if (fs.existsSync(path.join(ROOT, 'cleanup.cjs'))) {
    try {
      const c = require('./cleanup.cjs');
      if (typeof c.runOnce === 'function') { c.runOnce(); result.cleanup = true; }
    } catch (e) { warn('cleanup skipped: ' + (e && e.message)); }
  } else {
    log('volume sweeper not part of this build (cleanup.cjs absent); skipped');
  }


  /* 2. Session boot: volume detection + legacy session migration. */
  result.sessionBoot = sessionBootInline();

  /* 3. Session audit: warn if any hard session delete sneaks back in. */
  result.sessionAudit = sessionFixVerify();

  /* 4. Real file audit: every source file is read and compiled; only genuine
        failures are printed, with the real error. No claims, just results. */
  try {
    const a = require('./lib/boot-audit.cjs').audit({ root: ROOT, label: 'BOOT' });
    result.audit = { loaded: a.loaded, failed: a.failed.length };
  } catch (e) { bad('boot audit failed to run: ' + (e && e.message)); }

  // Start creator-page reachability checks from the service parent, not only
  // after a WhatsApp session pairs. This keeps Railway diagnostics available
  // even while the bot is waiting for pairing or reconnecting.
  try { require('./mias/lib/creatorPageStatus.cjs').startCreatorPageMonitor(); }
  catch (e) { warn('creator page status: ' + (e && e.message)); }

  log('════════ PARENT BOOT DONE in ' + (Date.now() - t0) + 'ms — ' + safeJson(result) + ' ════════');
  globalThis.__PRECIOUS_MASTER_PARENT__ = result;
  return result;
}

/* ════════════════════════════════ CHILD ═════════════════════════════════
   Called at the VERY END of mias/index.js (after __PRECIOUS__ and the full
   commands map exist). */
function bootChild(ctx) {
  if (globalThis.__PRECIOUS_MASTER_CHILD__) {
    log('child boot already done — skipping (dedup guard)');
    return globalThis.__PRECIOUS_MASTER_CHILD__;
  }
  const t0 = Date.now();
  log('════════ CHILD BOOT (' + MERGED_BUILD + ') — installing ALL runtime fix packs ════════');

  const result = { shield: false, packs: null, verify: false };

  /* 1. Child crash shield. */
  try { result.shield = installChildShield(); }
  catch (e) { bad('child shield failed: ' + (e && e.message)); }

  /* 2. EVERY runtime pack, correct order (later installs win). */
  try { result.packs = installAll(ctx || globalThis.__PRECIOUS__ || {}); }
  catch (e) { bad('installAll failed: ' + (e && e.message)); }

  /* 3. Verify hook — the log PROVES the fixes took effect. */
  try { result.verify = scheduleVerify(); }
  catch (e) { bad('verify schedule skipped: ' + (e && e.message)); }

  /* 4. Heavy-task protection + creator-page diagnostics (real values only). */
  try {
    const _heavy = require('./mias/lib/heavyTaskGuard.cjs');
    _heavy.startSweeper();
    _heavy.printStabilityBanner();
    ok('heavy-task guard armed (concurrency=' + _heavy.CONCURRENCY + ')');
  } catch (e) { warn('heavy-task guard: ' + (e && e.message)); }
  try { require('./mias/lib/creatorPageStatus.cjs').startCreatorPageMonitor(); }
  catch (e) { warn('creator page status: ' + (e && e.message)); }

  const good  = result.packs ? Object.values(result.packs).filter(Boolean).length : 0;
  const slots = result.packs ? Object.keys(result.packs).length : 0;
  log('════════ CHILD BOOT DONE in ' + (Date.now() - t0) + 'ms — shield=' + result.shield +
      ' packs=' + good + '/' + slots + ' verify=' + result.verify + ' ════════');
  globalThis.__PRECIOUS_MASTER_CHILD__ = result;
  return result;
}

module.exports = { bootParent, bootChild, MERGED_BUILD };
