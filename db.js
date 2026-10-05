/**
 * db.js — Dual-driver database abstraction.
 *
 * Uses PostgreSQL (via `pg`) when the DATABASE_URL environment variable is
 * set, otherwise falls back to the local better-sqlite3 file database.
 * The rest of the app (server.js, seed.js) stays driver-agnostic by using
 * this small promise-based API:
 *
 *   await db.init()              — connect + create schema if needed
 *   await db.get(sql, params)    — first row, or undefined
 *   await db.all(sql, params)    — array of rows
 *   await db.run(sql, params)    — { lastID, changes }
 *                                  (INSERTs get `RETURNING id` on pg)
 *   await db.count(sql, params)  — numeric COUNT result
 *   await db.exec(sql)           — multi-statement (schema files)
 *   await db.close()
 *
 * Queries are written with `?` placeholders; they are automatically
 * rewritten to $1, $2, ... for PostgreSQL.
 *
 * db.NOW is the SQL expression for "current timestamp":
 *   SQLite     -> datetime('now','localtime')
 *   PostgreSQL -> CURRENT_TIMESTAMP
 */
const path = require('path');
const fs = require('fs');

const isPg = !!process.env.DATABASE_URL;

// Rewrite `?` placeholders to $1, $2, ... for PostgreSQL.
function toPg(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => '$' + (++i));
}

let pool = null;   // pg.Pool (PostgreSQL mode)
let sqlite = null; // better-sqlite3 Database (SQLite mode)

const NOW = isPg ? 'CURRENT_TIMESTAMP' : "datetime('now','localtime')";

async function init() {
  if (isPg) {
    const { Pool } = require('pg');
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      // Supabase (and most managed Postgres) requires SSL.
      ssl: { rejectUnauthorized: false },
    });
    // Verify connectivity early so misconfigured DATABASE_URL fails fast.
    await pool.query('SELECT 1');
    const schema = fs.readFileSync(path.join(__dirname, 'schema.pg.sql'), 'utf8');
    await pool.query(schema);
  } else {
    const Database = require('better-sqlite3');
    const DB_PATH = path.join(__dirname, 'data', 'app.db');
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    sqlite = new Database(DB_PATH);
    sqlite.pragma('journal_mode = WAL');
    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    sqlite.exec(schema);
  }
}

async function get(sql, params = []) {
  if (isPg) {
    const r = await pool.query(toPg(sql), params);
    return r.rows[0];
  }
  return sqlite.prepare(sql).get(...params);
}

async function all(sql, params = []) {
  if (isPg) {
    const r = await pool.query(toPg(sql), params);
    return r.rows;
  }
  return sqlite.prepare(sql).all(...params);
}

async function run(sql, params = [], opts = {}) {
  if (isPg) {
    let q = sql.trim();
    // Capture the new row's id for INSERT statements (unless the target
    // table has no `id` column — e.g. roles — or RETURNING is explicit).
    if (/^insert\b/i.test(q) && !/returning\b/i.test(q) && !opts.noReturning) q += ' RETURNING id';
    const r = await pool.query(toPg(q), params);
    return {
      lastID: r.rows[0] ? Number(r.rows[0].id) : undefined,
      changes: r.rowCount,
    };
  }
  const info = sqlite.prepare(sql).run(...params);
  return {
    lastID: info.lastInsertRowid ? Number(info.lastInsertRowid) : undefined,
    changes: info.changes,
  };
}

// Numeric COUNT(*) helper — pg returns COUNT as a string, so coerce it.
async function count(sql, params = []) {
  const row = await get(sql, params);
  if (!row) return 0;
  return Number(Object.values(row)[0]);
}

async function exec(sql) {
  if (isPg) {
    await pool.query(sql);
    return;
  }
  sqlite.exec(sql);
}

async function close() {
  if (pool) {
    await pool.end();
    pool = null;
  }
  if (sqlite) {
    sqlite.close();
    sqlite = null;
  }
}

module.exports = { isPg, init, get, all, run, count, exec, close, NOW };
