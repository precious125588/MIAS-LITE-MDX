'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { normalizePostgresConnectionString } = require('../mias/lib/pgConnection.cjs');

const BATCH_SIZE = 200;
const TABLES = [
  {
    name: 'mias_session_auth',
    required: true,
    columns: ['session_id', 'file_name', 'content', 'updated_at'],
    orderBy: 'session_id, file_name',
    conflict: `ON CONFLICT (session_id, file_name) DO UPDATE
      SET content = EXCLUDED.content, updated_at = EXCLUDED.updated_at
      WHERE EXCLUDED.updated_at > mias_session_auth.updated_at`,
  },
  {
    name: 'mias_session_registry',
    required: false,
    columns: ['jid', 'number', 'source', 'status', 'telegram_user_id', 'metadata', 'updated_at'],
    orderBy: 'jid',
    conflict: `ON CONFLICT (jid) DO UPDATE SET
      number = EXCLUDED.number, source = EXCLUDED.source, status = EXCLUDED.status,
      telegram_user_id = EXCLUDED.telegram_user_id, metadata = EXCLUDED.metadata,
      updated_at = EXCLUDED.updated_at
      WHERE EXCLUDED.updated_at > mias_session_registry.updated_at`,
  },
  {
    name: 'mias_bot_selections',
    required: false,
    columns: ['number', 'bot_id', 'bot_name', 'chosen_at', 'source', 'chosen_by', 'locked', 'deployed', 'deployed_at', 'updated_at'],
    orderBy: 'number',
    conflict: `ON CONFLICT (number) DO UPDATE SET
      bot_id = EXCLUDED.bot_id, bot_name = EXCLUDED.bot_name, chosen_at = EXCLUDED.chosen_at,
      source = EXCLUDED.source, chosen_by = EXCLUDED.chosen_by, locked = EXCLUDED.locked,
      deployed = EXCLUDED.deployed, deployed_at = EXCLUDED.deployed_at,
      updated_at = EXCLUDED.updated_at
      WHERE EXCLUDED.updated_at > mias_bot_selections.updated_at`,
  },
];

function sameDatabase(left, right) {
  try {
    const a = new URL(left);
    const b = new URL(right);
    return a.protocol === b.protocol &&
      a.hostname.toLowerCase() === b.hostname.toLowerCase() &&
      a.port === b.port &&
      a.pathname.replace(/\/+$/, '') === b.pathname.replace(/\/+$/, '');
  } catch {
    return left === right;
  }
}

async function tableExists(client, tableName) {
  const result = await client.query('SELECT to_regclass($1) AS table_name', [`public.${tableName}`]);
  return Boolean(result.rows[0]?.table_name);
}

async function countRows(client, tableName) {
  if (!await tableExists(client, tableName)) return null;
  const result = await client.query(`SELECT count(*)::bigint AS count FROM public.${tableName}`);
  return Number(result.rows[0].count);
}

function makeInsert(table, rows) {
  const values = [];
  const placeholders = rows.map((row, rowIndex) => {
    const base = rowIndex * table.columns.length;
    for (const column of table.columns) values.push(row[column]);
    return `(${table.columns.map((_, columnIndex) => `$${base + columnIndex + 1}`).join(', ')})`;
  });

  return {
    text: `INSERT INTO public.${table.name} (${table.columns.join(', ')})
      VALUES ${placeholders.join(', ')} ${table.conflict}`,
    values,
  };
}

async function migrateTable(source, destination, table, apply) {
  const sourceCount = await countRows(source, table.name);
  if (sourceCount === null) {
    if (table.required) {
      const error = new Error('Required source session-auth table is missing');
      error.code = 'SOURCE_SESSION_TABLE_MISSING';
      throw error;
    }
    return { table: table.name, sourceRows: 0, mergedRows: 0, skipped: true };
  }

  if (!apply) return { table: table.name, sourceRows: sourceCount, mergedRows: 0, skipped: false };

  let offset = 0;
  let mergedRows = 0;
  while (offset < sourceCount) {
    const result = await source.query(
      `SELECT ${table.columns.join(', ')} FROM public.${table.name}
       ORDER BY ${table.orderBy} LIMIT $1 OFFSET $2`,
      [BATCH_SIZE, offset],
    );
    if (!result.rows.length) break;
    const insert = makeInsert(table, result.rows);
    const written = await destination.query(insert.text, insert.values);
    mergedRows += written.rowCount || 0;
    offset += result.rows.length;
  }

  return { table: table.name, sourceRows: sourceCount, mergedRows, skipped: false };
}

async function runMigration({ apply = false } = {}) {
  const sourceUrl = String(process.env.SESSION_DATABASE_URL || '').trim();
  const destinationUrl = String(process.env.DATABASE_URL || '').trim();

  if (!destinationUrl) {
    const error = new Error('Set DATABASE_URL to the existing settings database before migration');
    error.code = 'DATABASE_URL_MISSING';
    throw error;
  }
  if (!sourceUrl) {
    console.log('No SESSION_DATABASE_URL is set; there is no legacy session database to copy.');
    return { copied: false, reason: 'legacy_source_not_configured' };
  }
  if (sameDatabase(sourceUrl, destinationUrl)) {
    console.log('DATABASE_URL and SESSION_DATABASE_URL point to the same database; no copy is needed.');
    return { copied: false, reason: 'same_database' };
  }

  const sourcePool = new Pool({
    connectionString: normalizePostgresConnectionString(sourceUrl),
    max: 1,
    connectionTimeoutMillis: 5000,
    statement_timeout: 30000,
    ssl: { rejectUnauthorized: true },
    application_name: 'mais-session-db-migration-source',
  });
  const destinationPool = new Pool({
    connectionString: normalizePostgresConnectionString(destinationUrl),
    max: 1,
    connectionTimeoutMillis: 5000,
    statement_timeout: 30000,
    ssl: { rejectUnauthorized: true },
    application_name: 'mais-session-db-migration-target',
  });

  let sourceClient;
  let destinationClient;
  let sourceTransaction = false;
  let destinationTransaction = false;
  try {
    sourceClient = await sourcePool.connect();
    destinationClient = await destinationPool.connect();
    await sourceClient.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    sourceTransaction = true;

    if (apply) {
      await destinationClient.query('BEGIN');
      destinationTransaction = true;
      const schemaPath = path.join(__dirname, '..', 'mias', 'migrations', '0002_create_whatsapp_sessions.sql');
      await destinationClient.query(fs.readFileSync(schemaPath, 'utf8'));
    }

    const results = [];
    for (const table of TABLES) {
      results.push(await migrateTable(sourceClient, destinationClient, table, apply));
    }

    if (destinationTransaction) {
      await destinationClient.query('COMMIT');
      destinationTransaction = false;
    }
    await sourceClient.query('COMMIT');
    sourceTransaction = false;

    for (const result of results) {
      const suffix = result.skipped ? ' (table absent in source)' : '';
      console.log(`${result.table}: ${result.sourceRows} source rows${apply ? `, ${result.mergedRows} inserted/updated` : ''}${suffix}`);
    }
    console.log(apply
      ? 'Session records were merged into DATABASE_URL; source records were not deleted.'
      : 'Dry run only: no destination schema or data was changed. Re-run with --apply to merge rows.');
    return { copied: apply, results };
  } catch (error) {
    if (destinationTransaction) {
      try { await destinationClient.query('ROLLBACK'); } catch {}
    }
    if (sourceTransaction) {
      try { await sourceClient.query('ROLLBACK'); } catch {}
    }
    throw error;
  } finally {
    sourceClient?.release();
    destinationClient?.release();
    await Promise.allSettled([sourcePool.end(), destinationPool.end()]);
  }
}

if (require.main === module) {
  runMigration({ apply: process.argv.includes('--apply') }).catch((error) => {
    const code = String(error?.code || error?.name || 'UNKNOWN').replace(/[^A-Z0-9_-]/gi, '').slice(0, 80);
    console.error(`Session database migration failed (${code}). No connection strings or session contents were printed.`);
    process.exitCode = 1;
  });
}

module.exports = { runMigration, sameDatabase };
