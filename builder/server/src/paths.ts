import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** server/ (this file lives in server/src or server/dist). */
export const SERVER_ROOT = path.resolve(here, '..');

/** Where `npm run setup:ldraw` downloads and extracts the library (zip has an `ldraw/` top folder). */
export const LDRAW_DOWNLOAD_DIR = path.join(SERVER_ROOT, 'ldraw');

/** Root of the LDraw library (contains parts/, p/, LDConfig.ldr). Override with LDRAW_DIR. */
export const LDRAW_ROOT = process.env.LDRAW_DIR
  ? path.resolve(process.env.LDRAW_DIR)
  : path.join(LDRAW_DOWNLOAD_DIR, 'ldraw');

export const CACHE_DIR = path.join(SERVER_ROOT, 'cache');
export const CATALOG_FILE = path.join(CACHE_DIR, 'catalog.json');
export const COLORS_FILE = path.join(CACHE_DIR, 'colors.json');
export const PACKED_DIR = path.join(CACHE_DIR, 'packed');

export const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(SERVER_ROOT, 'data');
export const MODELS_DIR = path.join(DATA_DIR, 'models');

export const APP_DIST = path.resolve(SERVER_ROOT, '..', 'app', 'dist');

export const LDCONFIG_FILE = path.join(LDRAW_ROOT, 'LDConfig.ldr');

/** True when the LDraw library looks installed. */
export function libraryPresent(): boolean {
  return (
    fs.existsSync(path.join(LDRAW_ROOT, 'parts')) &&
    fs.existsSync(path.join(LDRAW_ROOT, 'p')) &&
    fs.existsSync(LDCONFIG_FILE)
  );
}

export const LIBRARY_MISSING_MESSAGE =
  'LDraw parts library not installed. Run `npm run setup:ldraw` in the repo root, then restart the server.';
