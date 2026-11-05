'use strict';

// Storage switch. JSON files are the default. PostgreSQL (Neon / Railway) and
// Redis are not contacted unless STORAGE_MODE=postgres is set explicitly.
// That code is kept, only switched off, so it can be re-enabled later.
function storageMode(env = process.env) {
  const raw = String((env && env.STORAGE_MODE) || '').trim().toLowerCase();
  return raw === 'postgres' ? 'postgres' : 'json';
}

function isJsonOnly(env = process.env) {
  return storageMode(env) === 'json';
}

module.exports = { storageMode, isJsonOnly };
