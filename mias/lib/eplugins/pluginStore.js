/**
 * The external plugin table, after Levanter's lib/db/plugins.js (Sequelize model
 * `Plugin` with name, url and session; setPlugin / getPlugin / delPlugin).
 * Copyright (c) lyfe00011, MIT License (see LICENSE-LEVANTER.txt).
 *
 * MIAS adds `scope` (one bot per AUTH_DIR, as for every other MIAS table) and
 * `source` (a copy of the plugin code, so a plugin still loads when its gist is
 * gone or unreachable on a later deploy).
 *
 * Storage:
 *   - PostgreSQL (DATABASE_URL): table mias_eplugins, migration 0003.
 *   - JSON fallback (no database / STORAGE_MODE=json): eplugins.json on the volume.
 */
import fs from "node:fs";
import path from "node:path";

export const EPLUGIN_TABLE = "mias_eplugins";
const JSON_VERSION = 1;

function cleanName(name) {
  const v = String(name ?? "").trim();
  if (!v) throw new Error("plugin name is empty");
  return v;
}

function rowOut(r) {
  return {
    name: r.name,
    url: r.url,
    session: r.session,
    source: r.source ?? "",
    installedAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at ?? null,
  };
}

/**
 * @param {object} opts
 * @param {() => {pool?: object|null, scope: string, jsonFile?: string|null}} opts.resolve
 *   Called on every operation so the store follows the live database connection.
 */
export function createPluginStore({ resolve }) {
  function target() {
    const r = resolve() || {};
    if (r.pool) return { mode: "pg", pool: r.pool, scope: String(r.scope || "default") };
    if (r.jsonFile) return { mode: "json", file: r.jsonFile, scope: String(r.scope || "default") };
    throw new Error("external plugin storage is not available (no database and no JSON file)");
  }

  function readJson(file) {
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      return Array.isArray(data?.rows) ? data.rows : [];
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
  }

  function writeJson(file, rows) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: JSON_VERSION, rows }, null, 2));
    fs.renameSync(tmp, file);
  }

  return {
    /** setPlugin(name, url, session, source?) — insert or update, like Levanter. */
    async setPlugin(name, url, session = "0", source = "") {
      const n = cleanName(name);
      const u = String(url ?? "");
      if (!u) throw new Error("plugin url is empty");
      const t = target();
      const sess = String(session);
      const src = String(source ?? "");
      if (t.mode === "pg") {
        await t.pool.query(
          `INSERT INTO ${EPLUGIN_TABLE} (scope, session, name, url, source)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (scope, session, name) DO UPDATE SET
             url = EXCLUDED.url,
             source = CASE WHEN EXCLUDED.source = '' THEN ${EPLUGIN_TABLE}.source ELSE EXCLUDED.source END,
             updated_at = now()`,
          [t.scope, sess, n, u, src],
        );
        return true;
      }
      const rows = readJson(t.file);
      const now = new Date().toISOString();
      const i = rows.findIndex((r) => r.scope === t.scope && r.session === sess && r.name === n);
      if (i >= 0) {
        rows[i] = { ...rows[i], url: u, source: src || rows[i].source || "", updated_at: now };
      } else {
        rows.push({ scope: t.scope, session: sess, name: n, url: u, source: src, created_at: now, updated_at: now });
      }
      writeJson(t.file, rows);
      return true;
    },

    /**
     * getPlugin(session, name?) — one row for a name (or null), or every row for the
     * session in install order (an empty array when there are none).
     */
    async getPlugin(session = "0", name) {
      const t = target();
      const sess = String(session);
      if (t.mode === "pg") {
        if (name !== undefined && name !== null && String(name) !== "") {
          const { rows } = await t.pool.query(
            `SELECT name, url, session, source, created_at FROM ${EPLUGIN_TABLE}
             WHERE scope = $1 AND session = $2 AND name = $3`,
            [t.scope, sess, cleanName(name)],
          );
          return rows[0] ? rowOut(rows[0]) : null;
        }
        const { rows } = await t.pool.query(
          `SELECT name, url, session, source, created_at FROM ${EPLUGIN_TABLE}
           WHERE scope = $1 AND session = $2 ORDER BY created_at, name`,
          [t.scope, sess],
        );
        return rows.map(rowOut);
      }
      const mine = readJson(t.file)
        .filter((r) => r.scope === t.scope && r.session === sess)
        .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || a.name.localeCompare(b.name));
      if (name !== undefined && name !== null && String(name) !== "") {
        const hit = mine.find((r) => r.name === cleanName(name));
        return hit ? rowOut(hit) : null;
      }
      return mine.map(rowOut);
    },

    /** delPlugin(name, session) — true when a row was removed. */
    async delPlugin(name, session = "0") {
      const n = cleanName(name);
      const t = target();
      const sess = String(session);
      if (t.mode === "pg") {
        const res = await t.pool.query(
          `DELETE FROM ${EPLUGIN_TABLE} WHERE scope = $1 AND session = $2 AND name = $3`,
          [t.scope, sess, n],
        );
        return res.rowCount > 0;
      }
      const rows = readJson(t.file);
      const kept = rows.filter((r) => !(r.scope === t.scope && r.session === sess && r.name === n));
      if (kept.length === rows.length) return false;
      writeJson(t.file, kept);
      return true;
    },

    /** Removes every row for a session; returns how many were removed. */
    async delAllPlugins(session = "0") {
      const t = target();
      const sess = String(session);
      if (t.mode === "pg") {
        const res = await t.pool.query(
          `DELETE FROM ${EPLUGIN_TABLE} WHERE scope = $1 AND session = $2`,
          [t.scope, sess],
        );
        return res.rowCount;
      }
      const rows = readJson(t.file);
      const kept = rows.filter((r) => !(r.scope === t.scope && r.session === sess));
      writeJson(t.file, kept);
      return rows.length - kept.length;
    },
  };
}
