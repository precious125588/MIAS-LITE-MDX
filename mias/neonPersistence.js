import pg from "pg";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import pgConnection from "./lib/pgConnection.cjs";

const { Pool } = pg;
const { normalizePostgresConnectionString } = pgConnection;
const MIGRATIONS_DIR = fileURLToPath(new URL("./migrations/", import.meta.url));
const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
  "57P01",
  "57P02",
  "57P03",
  "53300",
]);

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export function safeDbErrorCode(error) {
  const code = String(error?.code || "").toUpperCase();
  return /^[A-Z0-9_]{2,32}$/.test(code) ? code : "UNKNOWN";
}

function isTransient(error) {
  const code = safeDbErrorCode(error);
  return code.startsWith("08") || TRANSIENT_CODES.has(code);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createNeonPool({
  connectionString = process.env.DATABASE_URL,
  PoolClass = Pool,
} = {}) {
  if (!String(connectionString || "").trim()) {
    throw codedError("DATABASE_URL_MISSING");
  }

  try {
    const parsed = new URL(String(connectionString));
    if (
      !["postgres:", "postgresql:"].includes(parsed.protocol) ||
      !parsed.hostname ||
      !parsed.pathname ||
      parsed.pathname === "/"
    ) {
      throw codedError("DATABASE_URL_INVALID");
    }
  } catch {
    throw codedError("DATABASE_URL_INVALID");
  }

  try {
    return new PoolClass({
      connectionString: normalizePostgresConnectionString(connectionString),
      max: 2,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000,
      query_timeout: 15000,
      statement_timeout: 10000,
      application_name: "mais-mdx",
      ssl: { rejectUnauthorized: true },
    });
  } catch {
    throw codedError("DATABASE_POOL_INIT_FAILED");
  }
}

/**
 * A read-only readiness probe. It never logs query parameters, connection
 * details, or database error messages.
 */
export async function assertReadOnlyConnection(
  pool,
  {
    expectedDatabase = process.env.NEON_EXPECTED_DATABASE || "neondb",
    attempts = 3,
    delay = wait,
  } = {},
) {
  let result;
  let lastError;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      result = await pool.query(
        "SELECT 1 AS ok, current_database() AS database_name",
      );
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      if (!isTransient(error) || attempt === attempts - 1) break;
      await delay(250 * 2 ** attempt);
    }
  }

  if (lastError) throw codedError(safeDbErrorCode(lastError));

  const row = result?.rows?.[0];
  if (Number(row?.ok) !== 1) throw codedError("READ_ONLY_PROBE_FAILED");
  if (row.database_name !== expectedDatabase) {
    throw codedError("DATABASE_NAME_MISMATCH");
  }

  return { ok: true, databaseName: row.database_name };
}

export async function applyMigrations(
  pool,
  { migrationsDir = MIGRATIONS_DIR } = {},
) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mias_schema_migrations (
      version text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const names = (await fs.readdir(migrationsDir))
    .filter((name) => /^\d{4}_[a-z0-9_-]+\.sql$/i.test(name))
    .sort();
  const applied = [];

  for (const name of names) {
    const version = name.slice(0, 4);
    let sql;
    try {
      sql = await fs.readFile(path.join(migrationsDir, name), "utf8");
    } catch {
      throw codedError("MIGRATION_READ_FAILED");
    }

    const checksum = createHash("sha256").update(sql).digest("hex");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext($1))",
        ["mais-mdx-schema-migrations"],
      );
      const prior = await client.query(
        "SELECT checksum FROM mias_schema_migrations WHERE version = $1",
        [version],
      );

      if (prior.rows.length) {
        if (prior.rows[0].checksum !== checksum) {
          throw codedError("MIGRATION_CHECKSUM_MISMATCH");
        }
        await client.query("COMMIT");
        continue;
      }

      await client.query(sql);
      await client.query(
        "INSERT INTO mias_schema_migrations (version, checksum) VALUES ($1, $2)",
        [version, checksum],
      );
      await client.query("COMMIT");
      applied.push(version);
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {}
      throw codedError(safeDbErrorCode(error));
    } finally {
      client.release();
    }
  }

  return applied;
}

export function derivePersistenceScope(env = process.env) {
  const configured = String(env.MIAS_DB_SCOPE || "").trim();
  const authDir = String(env.AUTH_DIR || "").trim();
  const source = configured || authDir || env.SHIELD_NAME || "mais-mdx-default";
  const stableSource = configured
    ? source
    : authDir
      ? path.resolve(authDir)
      : String(source);
  const digest = createHash("sha256").update(stableSource).digest("hex");
  return `session_${digest.slice(0, 40)}`;
}

export function canonicalJson(value) {
  function sort(value) {
    if (Array.isArray(value)) return value.map(sort);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sort(value[key])]),
    );
  }
  return JSON.stringify(sort(value));
}

export async function readBotState(pool, scope) {
  const result = await pool.query(
    "SELECT payload, revision FROM mias_bot_state WHERE scope = $1",
    [scope],
  );
  if (!result.rows.length) return null;

  const row = result.rows[0];
  if (!row.payload || typeof row.payload !== "object" || Array.isArray(row.payload)) {
    throw codedError("DATABASE_STATE_INVALID");
  }
  return { payload: row.payload, revision: Number(row.revision) };
}

export async function seedBotState(pool, scope, payload) {
  const result = await pool.query(
    `INSERT INTO mias_bot_state (scope, payload, revision)
     VALUES ($1, $2::jsonb, 1)
     ON CONFLICT (scope) DO NOTHING
     RETURNING payload, revision`,
    [scope, JSON.stringify(payload)],
  );
  if (result.rows.length) {
    return {
      payload: result.rows[0].payload,
      revision: Number(result.rows[0].revision),
      inserted: true,
    };
  }

  const existing = await readBotState(pool, scope);
  if (!existing) throw codedError("DATABASE_STATE_SEED_FAILED");
  return { ...existing, inserted: false };
}

export async function compareAndSwapBotState(
  pool,
  scope,
  expectedRevision,
  payload,
) {
  const result = await pool.query(
    `UPDATE mias_bot_state
     SET payload = $3::jsonb, revision = revision + 1, updated_at = now()
     WHERE scope = $1 AND revision = $2
     RETURNING revision`,
    [scope, expectedRevision, JSON.stringify(payload)],
  );
  return result.rows.length ? Number(result.rows[0].revision) : null;
}
