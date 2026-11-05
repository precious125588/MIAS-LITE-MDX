/**
 * MAIS MDX — STRICT BOOT / FAIL-LOUD GUARD
 * =========================================
 * Purpose: never again boot "successfully", pair to WhatsApp, and leave you
 * guessing why a file or a fix pack did nothing. If anything fails to load,
 * the process prints EXACTLY what broke (file, require chain, reason, stack)
 * and exits with code 1.
 *
 * Load it as the VERY FIRST line of index.js:
 *     require('./strict-boot.cjs');
 *
 * Escape hatch: set MAIS_STRICT=0 to downgrade every fatal to a loud warning
 * (old lenient behaviour) without editing code.
 */

"use strict";

if (globalThis.__MAIS_STRICT_BOOT__) {
  module.exports = globalThis.__MAIS_STRICT_BOOT__;
} else {
  const path = require("path");
  const Module = require("module");

  const STRICT = process.env.MAIS_STRICT !== "0";
  const loadStack = [];        // active require chain
  const failures = [];         // { label, reason, detail }
  const loaded = [];           // successfully loaded project files

  const line = (c) => c.repeat(72);

  function fmtBlock(title, fields) {
    const out = [];
    out.push("");
    out.push(line("="));
    out.push("  " + title);
    out.push(line("="));
    for (const [k, v] of fields) {
      if (v === undefined || v === null || v === "") continue;
      out.push("  " + (k + ":").padEnd(16) + String(v).split("\n").join("\n" + " ".repeat(18)));
    }
    out.push(line("="));
    out.push("");
    return out.join("\n");
  }

  function explain(err, request, parent) {
    const code = err && err.code;
    if (code === "MODULE_NOT_FOUND") {
      const missing = (String(err.message).match(/Cannot find module '([^']+)'/) || [])[1] || request;
      return `The file/package "${missing}" does not exist at the path it is required from.\n` +
             `Fix: correct the require path (check ./ vs ../ depth) or run "npm install ${missing.startsWith(".") ? "" : missing}".`;
    }
    if (code === "ERR_REQUIRE_ESM") {
      return `"${request}" is an ES module but is being loaded with require().\n` +
             `Fix: use await import('${request}') or rename the caller to .mjs.`;
    }
    if (err instanceof SyntaxError) {
      return `"${request}" has a syntax error and could not be parsed.`;
    }
    return `"${request}" threw while loading: ${err && err.message}`;
  }

  function fatal(title, fields) {
    const block = fmtBlock(title, fields);
    if (STRICT) {
      process.stderr.write(block);
      process.stderr.write(
        "  BOOT ABORTED. Nothing was paired. Fix the above, then start again.\n" +
        "  (Set MAIS_STRICT=0 to boot anyway and only warn.)\n\n"
      );
      process.exit(1);
    } else {
      process.stderr.write(block.replace("=".repeat(72), "=".repeat(72)));
      process.stderr.write("  MAIS_STRICT=0 -> continuing anyway (degraded).\n\n");
    }
  }

  // ── 1. Instrument every require so failures name the exact chain ────────────
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    const from = parent && parent.filename ? parent.filename : "<entry>";
    loadStack.push(`${request}  (required by ${path.basename(from)})`);
    try {
      const mod = origLoad.apply(this, arguments);
      if (/^[./]/.test(request)) loaded.push(request);
      loadStack.pop();
      return mod;
    } catch (err) {
      const chain = loadStack.slice().reverse().join("\n-> ");
      loadStack.pop();
      failures.push({ label: request, reason: err && err.message });
      fatal("FILE FAILED TO LOAD — " + request, [
        ["What broke", request],
        ["Required by", from],
        ["Reason", explain(err, request, parent)],
        ["Require chain", chain],
        ["Stack", err && err.stack ? String(err.stack).split("\n").slice(0, 8).join("\n") : "n/a"],
      ]);
      throw err;
    }
  };

  // ── 2. Boot-critical require: use for fix packs / handlers ──────────────────
  function requireStrict(request, label) {
    try {
      return require(/* strict */ request);
    } catch (err) {
      fatal("REQUIRED COMPONENT MISSING — " + (label || request), [
        ["Component", label || request],
        ["Module", request],
        ["Reason", explain(err, request)],
        ["Stack", err && err.stack ? String(err.stack).split("\n").slice(0, 8).join("\n") : "n/a"],
      ]);
      return null;
    }
  }

  // ── 3. Fix packs that "install" at runtime must not fail silently ───────────
  // Wrap any step that used to be swallowed by an empty catch.
  function step(label, fn) {
    try {
      const r = fn();
      if (r && typeof r.then === "function") {
        return r.catch((err) => {
          fatal("FIX/STEP FAILED — " + label, [
            ["Step", label],
            ["Reason", err && err.message],
            ["Stack", err && err.stack ? String(err.stack).split("\n").slice(0, 8).join("\n") : "n/a"],
          ]);
        });
      }
      return r;
    } catch (err) {
      fatal("FIX/STEP FAILED — " + label, [
        ["Step", label],
        ["Reason", err && err.message],
        ["Stack", err && err.stack ? String(err.stack).split("\n").slice(0, 8).join("\n") : "n/a"],
      ]);
      return null;
    }
  }

  // ── 4. Catch the "X failed to load / N failed" log lines the code prints ────
  // Many modules log a failure and keep going. In strict mode that is fatal.
  const FATAL_LOG_PATTERNS = [
    /failed to load/i,
    /install failed/i,
    /not loaded correctly/i,
    /handlers not loaded/i,
    /\b([1-9]\d*)\s+failed\b/i,
    /parent boot FAILED/i,
  ];
  const IGNORE_LOG_PATTERNS = [
    /download failed/i, /send failed/i, /upload failed/i, /reject failed/i,
    /block failed/i, /reply failed/i, /quarantine failed/i, /migration failed/i,
    /0 failed/i,
  ];
  function watchConsole(name) {
    const orig = console[name].bind(console);
    console[name] = function (...args) {
      orig(...args);
      let text;
      try { text = args.map((a) => (typeof a === "string" ? a : (a && a.message) || "")).join(" "); }
      catch { return; }
      if (!text) return;
      if (IGNORE_LOG_PATTERNS.some((r) => r.test(text))) return;
      if (FATAL_LOG_PATTERNS.some((r) => r.test(text))) {
        fatal("A FIX / FILE DID NOT LOAD", [
          ["Reported by", "console." + name],
          ["Message", text.slice(0, 500)],
          ["Meaning", "Something the bot needs was skipped. It used to continue silently and look 'connected' while that feature was dead."],
          ["Where", new Error("trace").stack.split("\n").slice(2, 7).join("\n")],
        ]);
      }
    };
  }
  ["log", "warn", "error"].forEach(watchConsole);

  // ── 5. Absolutely nothing dies quietly ─────────────────────────────────────
  process.on("uncaughtException", (err) => {
    fatal("UNCAUGHT CRASH", [
      ["Reason", err && err.message],
      ["Type", err && err.name],
      ["Stack", err && err.stack],
    ]);
  });
  process.on("unhandledRejection", (err) => {
    fatal("UNHANDLED PROMISE REJECTION", [
      ["Reason", (err && err.message) || String(err)],
      ["Stack", err && err.stack],
    ]);
  });

  // ── 6. Boot manifest you can print right before pairing starts ─────────────
  function assertBootClean(labelsRequired) {
    const missing = (labelsRequired || []).filter((f) => {
      try { require.resolve(path.resolve(process.cwd(), f)); return false; } catch { return true; }
    });
    if (missing.length) {
      fatal("REQUIRED FILES MISSING FROM THE REPO", [
        ["Missing", missing.join("\n")],
        ["Meaning", "These files are required for the bot to work. Pairing is pointless without them."],
      ]);
    }
    if (failures.length) {
      fatal("BOOT FINISHED WITH FAILED MODULES", [
        ["Count", failures.length],
        ["Failures", failures.map((f) => `${f.label} -> ${f.reason}`).join("\n")],
      ]);
    }
    process.stdout.write(
      `[STRICT-BOOT] ok — ${loaded.length} local modules loaded, 0 failed` +
      (STRICT ? " (strict mode ON)\n" : " (strict mode OFF)\n")
    );
  }

  const api = { STRICT, requireStrict, step, fatal, assertBootClean, failures, loaded };
  globalThis.__MAIS_STRICT_BOOT__ = api;
  module.exports = api;
  process.stdout.write(
    `[STRICT-BOOT] armed — ${STRICT ? "any missing file or failed fix will CRASH with a full report" : "warn-only (MAIS_STRICT=0)"}\n`
  );
}
