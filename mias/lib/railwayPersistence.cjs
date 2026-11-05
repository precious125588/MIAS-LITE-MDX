'use strict';

const { normalizePostgresConnectionString } = require('./pgConnection.cjs');

function resolveStateDatabase({
  railwayUrl = process.env.RAILWAY_DATABASE_URL,
  neonUrl = process.env.DATABASE_URL,
  neonExpectedDatabase = process.env.NEON_EXPECTED_DATABASE || 'neondb',
} = {}) {
  const railway = String(railwayUrl || '').trim();
  if (railway) {
    return { connectionString: railway, provider: 'railway', expectedDatabase: null };
  }
  const neon = String(neonUrl || '').trim();
  if (neon) {
    return { connectionString: neon, provider: 'neon', expectedDatabase: neonExpectedDatabase };
  }
  return { connectionString: '', provider: 'json', expectedDatabase: null };
}

function railwaySslOptions(connectionString, env = process.env) {
  let urlMode = '';
  try { urlMode = new URL(String(connectionString)).searchParams.get('sslmode') || ''; } catch {}
  const mode = String(env.RAILWAY_DATABASE_SSL || urlMode || 'require').trim().toLowerCase();
  if (['disable', 'off', 'false', '0'].includes(mode)) return false;
  const verifySetting = String(env.RAILWAY_DATABASE_SSL_VERIFY ?? 'true').trim().toLowerCase();
  return {
    rejectUnauthorized: !['false', 'off', '0', 'disable'].includes(verifySetting),
  };
}

function createRailwayPool({
  connectionString = process.env.RAILWAY_DATABASE_URL,
  PoolClass,
  env = process.env,
  ...poolOptions
} = {}) {
  const source = String(connectionString || '').trim();
  let parsed;
  try { parsed = new URL(source); } catch {
    throw Object.assign(new Error('RAILWAY_DATABASE_URL_INVALID'), { code: 'RAILWAY_DATABASE_URL_INVALID' });
  }
  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol)
    || !parsed.hostname
    || !parsed.pathname
    || parsed.pathname === '/'
  ) {
    throw Object.assign(new Error('RAILWAY_DATABASE_URL_INVALID'), { code: 'RAILWAY_DATABASE_URL_INVALID' });
  }

  let Pool = PoolClass;
  if (!Pool) {
    try { ({ Pool } = require('pg')); } catch {
      throw Object.assign(new Error('PG_PACKAGE_MISSING'), { code: 'PG_PACKAGE_MISSING' });
    }
  }

  return new Pool({
    connectionString: normalizePostgresConnectionString(source),
    max: 2,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    query_timeout: 15000,
    statement_timeout: 10000,
    application_name: 'mais-mdx-railway',
    ssl: railwaySslOptions(source, env),
    ...poolOptions,
  });
}

async function assertRailwayConnection(pool) {
  let result;
  try {
    result = await pool.query('SELECT 1 AS ok, current_database() AS database_name');
  } catch (error) {
    const code = String(error?.code || '').toUpperCase();
    throw Object.assign(new Error(/^[A-Z0-9_]{2,32}$/.test(code) ? code : 'RAILWAY_DATABASE_UNAVAILABLE'), {
      code: /^[A-Z0-9_]{2,32}$/.test(code) ? code : 'RAILWAY_DATABASE_UNAVAILABLE',
    });
  }
  const row = result?.rows?.[0];
  if (Number(row?.ok) !== 1 || !row?.database_name) {
    throw Object.assign(new Error('RAILWAY_DATABASE_PROBE_FAILED'), { code: 'RAILWAY_DATABASE_PROBE_FAILED' });
  }
  return { ok: true, databaseName: String(row.database_name) };
}

module.exports = {
  assertRailwayConnection,
  createRailwayPool,
  railwaySslOptions,
  resolveStateDatabase,
};
