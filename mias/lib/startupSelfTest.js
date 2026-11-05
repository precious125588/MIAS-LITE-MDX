/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║           STARTUP SELF-TEST — MAIS MDX                         ║
 * ║  Runs before accepting connections.                            ║
 * ║  Checks auth files, signal stores, session health, memory.     ║
 * ║  Reports PASS / WARNING / FAIL.                                ║
 * ║  Repairs minor issues automatically before startup.            ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

import fs from "fs";
import path from "path";
import os from "os";

// ── Run a single check ────────────────────────────────────────────────────────
function check(name, fn) {
  try {
    const result = fn();
    return { name, ...result };
  } catch (e) {
    return { name, status: "FAIL", detail: e.message };
  }
}

// ── Auth files check ──────────────────────────────────────────────────────────
function checkAuthFiles(sessionPath) {
  if (!fs.existsSync(sessionPath)) {
    fs.mkdirSync(sessionPath, { recursive: true });
    return { status: "WARNING", detail: "Auth directory created (first run)" };
  }
  const credsPath = path.join(sessionPath, "creds.json");
  if (!fs.existsSync(credsPath)) {
    return { status: "WARNING", detail: "creds.json missing — pairing required" };
  }
  try {
    const raw = fs.readFileSync(credsPath, "utf8");
    if (!raw.trim()) return { status: "FAIL", detail: "creds.json is empty" };
    JSON.parse(raw);
    return { status: "PASS", detail: "creds.json valid" };
  } catch (e) {
    return { status: "FAIL", detail: `creds.json corrupt: ${e.message}` };
  }
}

// ── Signal stores check ───────────────────────────────────────────────────────
function checkSignalStores(sessionPath) {
  if (!fs.existsSync(sessionPath)) {
    return { status: "WARNING", detail: "session dir not found" };
  }
  const files = fs.readdirSync(sessionPath);
  const storeFiles = files.filter(f =>
    f.startsWith("app-state-sync-key") || f.startsWith("sender-key") ||
    f.startsWith("session") || f.startsWith("app-state-sync-version")
  );

  const corrupt = [];
  for (const f of storeFiles) {
    try {
      const raw = fs.readFileSync(path.join(sessionPath, f), "utf8");
      if (!raw.trim()) { corrupt.push(f); continue; }
      JSON.parse(raw);
    } catch { corrupt.push(f); }
  }

  // Auto-repair: delete corrupt store files
  for (const f of corrupt) {
    try { fs.unlinkSync(path.join(sessionPath, f)); } catch {}
  }

  if (corrupt.length > 0) {
    return { status: "WARNING", detail: `Repaired ${corrupt.length} corrupt store file(s): ${corrupt.join(", ")}` };
  }
  return { status: "PASS", detail: `${storeFiles.length} store file(s) valid` };
}

// ── Memory health check ───────────────────────────────────────────────────────
function checkMemoryHealth() {
  const mem    = process.memoryUsage();
  const heapPct = Math.round((mem.heapUsed / mem.heapTotal) * 100);
  const rssMB   = Math.round(mem.rss / 1024 / 1024);
  if (heapPct > 90) {
    return { status: "FAIL", detail: `Heap at ${heapPct}% before startup — likely memory leak from previous run` };
  }
  if (heapPct > 75) {
    return { status: "WARNING", detail: `Heap at ${heapPct}% (RSS ${rssMB}MB) — monitor closely` };
  }
  return { status: "PASS", detail: `Heap ${heapPct}% (RSS ${rssMB}MB)` };
}

// ── Node.js version check ─────────────────────────────────────────────────────
function checkNodeVersion() {
  const version = parseInt(process.version.replace(/[^0-9.]/g, "").split(".")[0], 10);
  if (version < 18) return { status: "FAIL", detail: `Node.js ${process.version} — need v18+` };
  if (version < 20) return { status: "WARNING", detail: `Node.js ${process.version} — v20+ recommended` };
  return { status: "PASS", detail: `Node.js ${process.version}` };
}

// ── Database dir check ────────────────────────────────────────────────────────
function checkDatabaseDir(dbDir) {
  if (!fs.existsSync(dbDir)) {
    try { fs.mkdirSync(dbDir, { recursive: true }); return { status: "WARNING", detail: "database dir created" }; }
    catch (e) { return { status: "FAIL", detail: `Cannot create database dir: ${e.message}` }; }
  }
  // Spot-check write access
  const testFile = path.join(dbDir, ".write_test");
  try {
    fs.writeFileSync(testFile, "1");
    fs.unlinkSync(testFile);
    return { status: "PASS", detail: "database dir writable" };
  } catch (e) {
    return { status: "FAIL", detail: `database dir not writable: ${e.message}` };
  }
}

// ── Environment check ─────────────────────────────────────────────────────────
function checkEnvironment() {
  const missing = [];
  const warnings = [];
  // Required for operation
  if (!process.env.AUTH_DIR) warnings.push("AUTH_DIR not set (using default ./auth)");
  // Non-critical
  if (!process.env.ZERO_API_KEY) warnings.push("ZERO_API_KEY not set (AI features limited)");
  if (missing.length) return { status: "FAIL",    detail: `Missing required env: ${missing.join(", ")}` };
  if (warnings.length) return { status: "WARNING", detail: warnings.join("; ") };
  return { status: "PASS", detail: "environment OK" };
}

// ── Main self-test runner ─────────────────────────────────────────────────────
export async function runStartupSelfTest(sessionPath, dbDir) {
  const _sessPath = sessionPath || process.env.AUTH_DIR || "./auth";
  const _dbDir    = dbDir || path.join(path.dirname(_sessPath), "database");

  const results = [
    check("Node Version",    () => checkNodeVersion()),
    check("Auth Files",      () => checkAuthFiles(_sessPath)),
    check("Signal Stores",   () => checkSignalStores(_sessPath)),
    check("Database Dir",    () => checkDatabaseDir(_dbDir)),
    check("Memory Health",   () => checkMemoryHealth()),
    check("Environment",     () => checkEnvironment()),
    check("Command Registry", () => {
      const a = globalThis.__MIAS_CMD_AUDIT__;
      if (!a) return { status: "WARNING", detail: "no command audit published — registry unverified" };
      const bad = (a.missingHandlers?.length || 0) + (a.unregisteredMenuCmds?.length || 0) + (a.broken?.length || 0);
      if (bad) return { status: "FAIL", detail: (a.missingHandlers?.length || 0) + " no-handler, " + (a.unregisteredMenuCmds?.length || 0) + " in-menu-but-unregistered: " + (a.unregisteredMenuCmds || []).slice(0, 8).join(", ") };
      return { status: "PASS", detail: a.total + " commands registered, " + (a.adult || 0) + " adult, 0 dead" };
    }),
  ];

  const fails    = results.filter(r => r.status === "FAIL");
  const warnings = results.filter(r => r.status === "WARNING");
  const passes   = results.filter(r => r.status === "PASS");

  const overall = fails.length > 0 ? "FAIL" : warnings.length > 0 ? "WARNING" : "PASS";

  const icon = { PASS: "✅", WARNING: "⚠️", FAIL: "❌" };
  const lines = [
    "╔══════════════════════════════════════╗",
    "║        STARTUP SELF-TEST REPORT       ║",
    "╚══════════════════════════════════════╝",
  ];
  for (const r of results) {
    lines.push(`${icon[r.status]} ${r.name.padEnd(20)} ${r.detail}`);
  }
  lines.push("─".repeat(44));
  lines.push(`${icon[overall]} Overall: ${overall} — ${passes.length} pass, ${warnings.length} warn, ${fails.length} fail`);

  console.log(lines.join("\n"));

  return { overall, results, passes: passes.length, warnings: warnings.length, fails: fails.length };
}
