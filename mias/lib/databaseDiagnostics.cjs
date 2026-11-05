'use strict';

const ROLE_VARIABLES = {
  settings: 'DATABASE_URL or SETTINGS_DATABASE_URL',
  session: 'SESSION_DATABASE_URL or RAILWAY_SESSION_DATABASE_URL',
  railway: 'RAILWAY_DATABASE_URL',
  redis: 'REDIS_URL',
};

const GUIDANCE = {
  SELF_SIGNED_CERT_IN_CHAIN: {
    summary: 'TLS certificate verification failed.',
    action: 'Confirm the URL targets the intended database and use its trusted certificate. If this is a self-signed Railway Postgres certificate over private Railway networking only, RAILWAY_DATABASE_SSL_VERIFY=false is a possible setting; do not disable verification for a public endpoint.',
  },
  DEPTH_ZERO_SELF_SIGNED_CERT: {
    summary: 'The database presented a self-signed TLS certificate.',
    action: 'Confirm the intended database URL and trusted CA. Only consider RAILWAY_DATABASE_SSL_VERIFY=false for a private Railway connection; keep verification enabled for public endpoints.',
  },
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: {
    summary: 'The database certificate chain could not be verified.',
    action: 'Use the database provider’s trusted URL or CA certificate. Do not disable verification for a public endpoint.',
  },
  CERT_HAS_EXPIRED: {
    summary: 'The database TLS certificate has expired.',
    action: 'Check the selected database service and ask its provider to renew the certificate; do not bypass verification.',
  },
  ENOTFOUND: {
    summary: 'DNS could not resolve the database hostname.',
    action: 'Check the host in ' + ROLE_VARIABLES.session + ' for a typo. For Railway, use the generated variable reference for the intended Postgres service in the same project and environment; do not guess the hostname.',
  },
  EAI_AGAIN: {
    summary: 'DNS lookup temporarily failed for the database hostname.',
    action: 'Retry after a short wait, then verify the host in the configured database URL and that the database service is reachable from this Railway service.',
  },
  ECONNREFUSED: {
    summary: 'The database host refused the connection.',
    action: 'Confirm the Postgres service is online and that the URL uses its current host and port.',
  },
  ETIMEDOUT: {
    summary: 'The database connection timed out.',
    action: 'Check that the database is online and that this service can reach the selected host and port; use the provider’s internal URL when both services are in Railway.',
  },
  ESOCKETTIMEDOUT: {
    summary: 'The database connection timed out.',
    action: 'Check that the database is online and that this service can reach the selected host and port.',
  },
  ECONNRESET: {
    summary: 'The database closed the connection unexpectedly.',
    action: 'Check whether the database restarted or is under load, then retry the status check.',
  },
  '28P01': {
    summary: 'PostgreSQL rejected the database login.',
    action: 'Use the generated connection variable for the intended Postgres service. If its credentials were rotated, update the Railway reference and redeploy; never paste the URL into chat.',
  },
  '3D000': {
    summary: 'The database name in the connection URL does not exist.',
    action: 'Use the generated URL for the intended Postgres service or correct the database name in the URL path.',
  },
  ERR_INVALID_URL: {
    summary: 'The database URL is malformed.',
    action: 'Use a PostgreSQL URL with a hostname and database path. In Railway, prefer the generated variable reference instead of hand-typing credentials.',
  },
  DATABASE_URL_INVALID: {
    summary: 'The database URL is malformed or is not a PostgreSQL URL.',
    action: 'Use a PostgreSQL URL with a hostname and database path. In Railway, prefer the generated variable reference for the selected database service.',
  },
  RAILWAY_DATABASE_URL_INVALID: {
    summary: 'RAILWAY_DATABASE_URL is malformed or is not a PostgreSQL URL.',
    action: 'Use the generated PostgreSQL URL reference for the intended Railway database service.',
  },
  REDIS_URL_INVALID: {
    summary: 'REDIS_URL is malformed or uses an unsupported Redis URL.',
    action: 'If Redis is needed, use the provider-generated redis:// or rediss:// URL. Redis is optional for durable bot data.',
  },
  REDIS_AUTH_OR_PING_FAILED: {
    summary: 'Redis rejected authentication or did not answer PING.',
    action: 'Check the Redis URL reference and credentials in Railway Variables. Redis is optional for durable bot data.',
  },
  REDIS_TIMEOUT: {
    summary: 'Redis did not respond before the connection timed out.',
    action: 'Check the Redis service and its URL reference. Redis is optional for durable bot data.',
  },
  REDIS_PING_FAILED: {
    summary: 'Redis connected but did not return the expected PONG.',
    action: 'Check that REDIS_URL points to a Redis service, not a PostgreSQL service.',
  },
  PG_PACKAGE_MISSING: {
    summary: 'The PostgreSQL client package is missing from the deployment.',
    action: 'Check the build/install logs and ensure the pg dependency is installed in the deployed image.',
  },
};

function safeErrorCode(error) {
  const raw = typeof error === 'string' ? error : error && error.code;
  const code = String(raw || '').trim().toUpperCase();
  return /^[A-Z0-9_]{2,64}$/.test(code) ? code : 'CONNECTION_FAILED';
}

function databaseDiagnostic(error, role = 'settings') {
  const code = safeErrorCode(error);
  const selectedRole = Object.prototype.hasOwnProperty.call(ROLE_VARIABLES, role) ? role : 'settings';
  const guidance = GUIDANCE[code] || {
    summary: 'The connection check failed (' + code + ').',
    action: 'Verify the configured database URL, selected service, network access, and credentials in Railway Variables. Do not share the URL or password.',
  };
  let summary = guidance.summary;
  let action = guidance.action;
  if (code === 'ENOTFOUND') {
    if (selectedRole === 'redis') {
      summary = 'DNS could not resolve the Redis hostname.';
      action = 'Check the host in REDIS_URL for a typo. For Railway, use the generated variable reference for the intended Redis service in the same project and environment; do not guess the hostname.';
    } else {
      action = 'Check the host in ' + ROLE_VARIABLES[selectedRole] + ' for a typo. For Railway, use the generated variable reference for the intended Postgres service in the same project and environment; do not guess the hostname.';
    }
  }
  if (selectedRole === 'redis') {
    const redisNetworkGuidance = {
      SELF_SIGNED_CERT_IN_CHAIN: { summary: 'Redis TLS certificate verification failed.', action: 'Use the Redis provider’s trusted certificate or CA; do not bypass verification for a public endpoint.' },
      DEPTH_ZERO_SELF_SIGNED_CERT: { summary: 'Redis presented a self-signed TLS certificate.', action: 'Use the Redis provider’s trusted certificate or CA; do not bypass verification for a public endpoint.' },
      UNABLE_TO_VERIFY_LEAF_SIGNATURE: { summary: 'The Redis certificate chain could not be verified.', action: 'Use the Redis provider’s trusted certificate or CA; do not bypass verification for a public endpoint.' },
      CERT_HAS_EXPIRED: { summary: 'The Redis TLS certificate has expired.', action: 'Ask the Redis provider to renew the certificate; do not bypass verification.' },
      EAI_AGAIN: { summary: 'DNS lookup temporarily failed for the Redis hostname.', action: 'Retry after a short wait, then verify the REDIS_URL host and that this service can reach the Redis service.' },
      ECONNREFUSED: { summary: 'The Redis host refused the connection.', action: 'Confirm the Redis service is online and that REDIS_URL uses its current host and port.' },
      ETIMEDOUT: { summary: 'The Redis connection timed out.', action: 'Check that the Redis service is online and reachable from this Railway service.' },
      ESOCKETTIMEDOUT: { summary: 'The Redis connection timed out.', action: 'Check that the Redis service is online and reachable from this Railway service.' },
      ECONNRESET: { summary: 'The Redis service closed the connection unexpectedly.', action: 'Check whether the Redis service restarted or is under load, then retry the status check.' },
    };
    if (redisNetworkGuidance[code]) {
      summary = redisNetworkGuidance[code].summary;
      action = redisNetworkGuidance[code].action;
    }
  }
  let impact = 'This status check does not expose the connection URL or database credentials.';
  if (selectedRole === 'settings') {
    impact = 'When a configured Settings DB cannot connect, MIAS cannot complete PostgreSQL persistence startup; linking WhatsApp alone will not make the bot ready.';
  } else if (selectedRole === 'session') {
    impact = 'Session database backup, restore, and registry synchronization may fail; this is separate from WhatsApp link approval.';
  } else if (selectedRole === 'railway') {
    impact = 'This is the separate Railway PostgreSQL check; it does not prove the Settings or Session DB URL is correct.';
  } else if (selectedRole === 'redis') {
    impact = 'Redis is an optional cache; this error is separate from durable PostgreSQL persistence.';
  }
  return { code, summary, action, impact };
}

module.exports = { databaseDiagnostic, safeErrorCode };
