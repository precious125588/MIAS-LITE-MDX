'use strict';

function sessionDigits(value) {
  return String(value || '').split('@')[0].split(':')[0].replace(/\D/g, '');
}

function parseDiscardSessions(value) {
  return new Set(String(value || '')
    .split(/[,|\s]+/)
    .map(sessionDigits)
    .filter(Boolean));
}

function matchesSession(value, digits) {
  return Boolean(digits) && sessionDigits(value) === digits;
}

function isSessionIdentity(value) {
  return /^\+?\d+(?::\d+)?(?:@s\.whatsapp\.net)?(?:\.quarantine-[\w.-]+)?$/i.test(String(value || '').trim());
}

function shouldPruneSession(value, envSessionDigits, discardSet = new Set(), purgeAll = false) {
  const raw = String(value || '').trim();
  const digits = sessionDigits(raw);
  if (!digits || !isSessionIdentity(raw)) return false;
  if (envSessionDigits) return digits !== envSessionDigits;
  return Boolean(purgeAll || discardSet.has(digits));
}

module.exports = { sessionDigits, parseDiscardSessions, matchesSession, isSessionIdentity, shouldPruneSession };
