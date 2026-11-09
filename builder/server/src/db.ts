// Unified storage: auth lives in <DATA_DIR>/admin.db, each user's world in
// <DATA_DIR>/users/<name>/lego.sqlite — the same files the FastAPI side uses.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const DATA_DIR = path.resolve(process.env.DATA_DIR ?? path.join(process.cwd(), 'data'));
export const USERS_DIR = path.join(DATA_DIR, 'users');
export const ADMIN_DB = path.join(DATA_DIR, 'admin.db');
export const CATALOG_DB = path.join(DATA_DIR, 'catalog.sqlite');

const USER_SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS builds (
    id TEXT PRIMARY KEY,
    user TEXT NOT NULL,
    name TEXT NOT NULL,
    ldr TEXT NOT NULL,
    parts INTEGER NOT NULL DEFAULT 0,
    thumb TEXT,
    source TEXT NOT NULL DEFAULT 'editor',
    share_id TEXT,
    photo_job_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0,
    device_id TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS shared_models (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    ldr TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0,
    device_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS part_map (ldraw_id TEXT PRIMARY KEY, part_num TEXT);
CREATE TABLE IF NOT EXISTS color_map (ldraw_id INTEGER PRIMARY KEY, color_id INTEGER);
`;

export const userDbPath = (user: string) => path.join(USERS_DIR, user, 'lego.sqlite');

export function openUserDb(user: string): DatabaseSync {
  fs.mkdirSync(path.join(USERS_DIR, user), { recursive: true });
  const db = new DatabaseSync(userDbPath(user));
  db.exec('PRAGMA journal_mode=WAL');
  db.exec(USER_SCHEMA);
  if (fs.existsSync(CATALOG_DB)) db.exec(`ATTACH DATABASE '${CATALOG_DB.replaceAll("'", "''")}' AS cat`);
  return db;
}

export function openAdminDb(): DatabaseSync {
  const db = new DatabaseSync(ADMIN_DB);
  db.exec('PRAGMA journal_mode=WAL');
  return db;
}

export function listUsers(): string[] {
  if (!fs.existsSync(USERS_DIR)) return [];
  return fs
    .readdirSync(USERS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(USERS_DIR, d.name, 'lego.sqlite')))
    .map((d) => d.name);
}

export function deviceId(db: DatabaseSync): string {
  const row = db.prepare("SELECT value FROM meta WHERE key='device_id'").get() as { value: string } | undefined;
  return row?.value ?? '';
}
