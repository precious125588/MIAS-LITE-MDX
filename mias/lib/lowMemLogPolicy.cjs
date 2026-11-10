// lowMemLogPolicy.cjs — Strict clean log policy and memory protection
// Enforces clean panel & bot logs:
//  - Suppresses all routine noise, debug lines, and startup spam
//  - ONLY prints: "MIAS LITE MDX is online" upon successful WhatsApp connection
//  - ONLY prints critical error logs (console.error) so issues can be diagnosed
//  - Clears retained logs periodically to keep RAM footprint minimal


let _onlineLogged = false;
let _origLog = null;
let _origInfo = null;
let _origWarn = null;
let _origError = null;

function isQuietMode() {
  if (process.env.DEBUG_LOGS === '1' || process.env.VERBOSE === '1') return false;
  return true;
}

function formatLogArgument(value) {
  if (value && typeof value === 'object' && typeof value.message === 'string') return value.message;
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function notifyOnline() {
  if (!_onlineLogged) {
    _onlineLogged = true;
    const printer = _origLog || console.log;
    printer('MIAS LITE MDX is online');
  }
}

function resetOnlineFlag() {
  _onlineLogged = false;
}

function isOnlineIndicator(str) {
  return /connected to whatsapp|mais is connected|mias is connected|\[connected\]|session registered|online & ready|connection opened/i.test(str);
}

function installLogFilter(runtimeLogs = [], maxAgeMs = 30 * 60 * 1000) {
  if (globalThis.__LOG_FILTER_INSTALLED__) {
    return { alreadyInstalled: true };
  }
  globalThis.__LOG_FILTER_INSTALLED__ = true;

  _origLog = console.log;
  _origInfo = console.info || console.log;
  _origWarn = console.warn || console.log;
  _origError = console.error;

  const quiet = isQuietMode();

  if (quiet) {
    console.log = function(...args) {
      const msg = args.map(formatLogArgument).join(' ');
      if (isOnlineIndicator(msg)) {
        notifyOnline();
      }
      // Everything else suppressed by default
    };

    console.info = function(...args) {
      const msg = args.map(formatLogArgument).join(' ');
      if (isOnlineIndicator(msg)) {
        notifyOnline();
      }
    };

    console.warn = function(...args) {
      const msg = args.map(formatLogArgument).join(' ');
      // Only permit real critical warnings through
      if (/critical|panic|fatal|unhandled/i.test(msg)) {
        return _origWarn.apply(console, args);
      }
    };

    console.error = function(...args) {
      // Errors are ALWAYS logged in full
      return _origError.apply(console, args);
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

  return { quiet, cleanerInterval, notifyOnline, resetOnlineFlag };
}

module.exports = {
  isLowMemEnv: () => true,
  isQuietMode,
  installLogFilter,
  notifyOnline,
  resetOnlineFlag,
};
