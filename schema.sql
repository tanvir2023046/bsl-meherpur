-- ============================================================
-- BCL Meherpur — CV Builder & Org Management System
-- SQLite schema (better-sqlite3)
-- ============================================================

PRAGMA journal_mode = WAL;

-- Users (login accounts)
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  full_name     TEXT,
  role          TEXT NOT NULL,
  unit_id       INTEGER,              -- organizational scope of this user
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (unit_id) REFERENCES units(id)
);

-- Role templates with permission JSON arrays
CREATE TABLE IF NOT EXISTS roles (
  name        TEXT PRIMARY KEY,
  label_bn    TEXT NOT NULL,
  permissions TEXT NOT NULL            -- JSON array of permission keys
);

-- Organizational units (district -> upazila/municipality -> union/ward -> village)
CREATE TABLE IF NOT EXISTS units (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name_bn    TEXT NOT NULL,
  name_en    TEXT,
  type       TEXT NOT NULL,            -- district|upazila|municipality|union|ward|village|other
  parent_id  INTEGER,
  is_active  INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (parent_id) REFERENCES units(id)
);

-- Organizational positions (posts)
CREATE TABLE IF NOT EXISTS positions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title_bn   TEXT NOT NULL,
  level      TEXT,                     -- district|upazila|municipality|union|ward|village|any
  is_active  INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- Member CVs. `data` holds the full CV as a JSON blob:
-- { personal:{...}, org:{...}, education:[...], experience:[...], activities:{...} }
CREATE TABLE IF NOT EXISTS cvs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  cv_code        TEXT UNIQUE,          -- e.g. BCL-MHR-000123
  status         TEXT NOT NULL DEFAULT 'draft',  -- draft|submitted|verified|archived
  data           TEXT NOT NULL,        -- JSON
  photo_path     TEXT,
  signature_path TEXT,
  owner_id       INTEGER,              -- member account (nullable)
  unit_id        INTEGER,              -- organizational unit this CV belongs to
  created_by     INTEGER,
  updated_by     INTEGER,
  created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (unit_id)    REFERENCES units(id),
  FOREIGN KEY (created_by) REFERENCES users(id),
  FOREIGN KEY (updated_by) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_cvs_status  ON cvs(status);
CREATE INDEX IF NOT EXISTS idx_cvs_unit    ON cvs(unit_id);
CREATE INDEX IF NOT EXISTS idx_units_parent ON units(parent_id);
CREATE INDEX IF NOT EXISTS idx_units_type   ON units(type);

-- Simple app settings (key/value)
CREATE TABLE IF NOT EXISTS app_settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
