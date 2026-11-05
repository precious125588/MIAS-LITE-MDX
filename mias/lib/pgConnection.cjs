'use strict';

const DEPRECATED_SSL_MODES = new Set(['prefer', 'require', 'verify-ca']);

/**
 * The app supplies certificate-verifying TLS explicitly to every production
 * PostgreSQL pool. Remove old libpq-style sslmode values before pg parses the
 * URL, avoiding pg-connection-string's migration warning without weakening TLS.
 */
function normalizePostgresConnectionString(connectionString) {
  const source = String(connectionString || '');
  if (!source) return source;

  try {
    const parsed = new URL(source);
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) return source;

    for (const [key, value] of parsed.searchParams.entries()) {
      if (key.toLowerCase() === 'sslmode' && DEPRECATED_SSL_MODES.has(value.toLowerCase())) {
        parsed.searchParams.delete(key);
      }
    }
    return parsed.toString();
  } catch {
    return source;
  }
}

module.exports = { normalizePostgresConnectionString };
