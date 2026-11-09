// lowMemLogPolicy.cjs — adaptive log filtering and periodic log clearing
// Enforces low-RAM panel requirements:
//  - In low-memory containers (or when PANEL_LOW_MEM is set), suppresses routine logs
//  - Only logs: "[CONNECTED]", "connected to WhatsApp", critical errors, and panic messages
//  - Clears retained logs periodically (every 30 mins)

const os = require('os');

function isLowMemEnv() {
  if (process.env.PANEL_LOW_MEM === '1' || process.env.LOW_MEM === '1') return true;
  if (process.env.PANEL_LOW_MEM === '0') return false;
  const total = os.totalmem ? (os.totalmem() / (1024 * 1024)) : 1024;
  return total <= 600; // <= 512MB or 600MB panel container
}

function installLogFilter(runtimeLogs = [], maxAgeMs = 30 * 60 * 1000) {
  const isLow = isLowMemEnv();
  const origLog = console.log;
  const origInfo = console.info || console.log;
  const origWarn = console.warn || console.log;
  const origError = console.error;

  const isImportantLog = (str) => {
    return /connected|mais is connected|mias is connected|pairing code|session registered|ready/i.test(str);
  };

  if (isLow) {
    console.log = function(...args) {
      const msg = args.map(a => (a && a.message) || (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
      if (isImportantLog(msg)) {
        return origLog.apply(console, args);
      }
    };
    console.info = function(...args) {
      const msg = args.map(a => (a && a.message) || (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
      if (isImportantLog(msg)) {
        return origInfo.apply(console, args);
      }
    };
    console.warn = function(...args) {
      const msg = args.map(a => (a && a.message) || (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
      if (/error|warn|fail|critical/i.test(msg)) {
        return origWarn.apply(console, args);
      }
    };
  }

  // Periodic cleaner for retained memory logs every 30 minutes
  const cleanerInterval = setInterval(() => {
    try {
      if (Array.isArray(runtimeLogs)) {
        runtimeLogs.length = 0;
      }
      if (global.gc) {
        try { global.gc(); } catch (_) {}
      }
    } catch (_) {}
  }, maxAgeMs);
  if (cleanerInterval.unref) cleanerInterval.unref();

  return { isLow, cleanerInterval };
}

module.exports = { isLowMemEnv, installLogFilter };
