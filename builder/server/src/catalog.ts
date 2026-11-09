// Builds CatalogPart[] (from ldraw/parts/*.dat headers) and BrickColor[] (from LDConfig.ldr).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { BrickColor, CatalogPart } from './types.js';
import { CACHE_DIR, CATALOG_FILE, COLORS_FILE, LDCONFIG_FILE, LDRAW_ROOT } from './paths.js';

export type { BrickColor, CatalogPart };

const HEADER_BYTES = 8192;
const EXCLUDED_PREFIXES = ['~', '=', '_', '|'];
const EXCLUDED_CATEGORIES = new Set(['sticker', 'sticker shortcut', 'obsolete', 'moved']);

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

export const collapseSpaces = (s: string) => s.replace(/\s+/g, ' ').trim();

interface Header {
  description: string;
  org: string;
  category: string | null;
  keywords: string[];
}

/** Parse the meta header of an LDraw file (stops at the first non-comment line). */
export function parseHeader(text: string): Header {
  const lines = text.split(/\r?\n/);
  let description = '';
  let org = '';
  let category: string | null = null;
  const keywords: string[] = [];
  let first = true;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (!line.startsWith('0')) break; // geometry starts → header over
    const body = line.replace(/^0\s*/, '');
    if (first) {
      description = body;
      first = false;
      continue;
    }
    if (body.startsWith('!LDRAW_ORG')) org = body.slice(10).trim();
    else if (body.startsWith('!CATEGORY')) category = collapseSpaces(body.slice(9));
    else if (body.startsWith('!KEYWORDS')) {
      for (const k of body.slice(9).split(',')) {
        const kw = collapseSpaces(k);
        if (kw) keywords.push(kw);
      }
    }
  }
  return { description, org, category, keywords };
}

/** Returns a CatalogPart, or null if the file should not be offered in the catalog. */
export function toCatalogPart(id: string, h: Header): CatalogPart | null {
  const desc = h.description;
  if (!desc) return null;
  if (EXCLUDED_PREFIXES.some((p) => desc.startsWith(p))) return null;
  if (/\bmoved to\b/i.test(desc)) return null;
  if (/alias|physical_colou?r/i.test(h.org)) return null;
  if (/^sticker\b/i.test(desc)) return null;

  const name = collapseSpaces(desc);
  const category = h.category ?? name.replace(/^[~=_|]+/, '').split(' ')[0] ?? 'Other';
  if (EXCLUDED_CATEGORIES.has(category.toLowerCase())) return null;
  return { id, name, category: category || 'Other', keywords: h.keywords };
}

async function readHead(file: string): Promise<string> {
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(HEADER_BYTES);
    const { bytesRead } = await fh.read(buf, 0, HEADER_BYTES, 0);
    return buf.toString('utf8', 0, bytesRead);
  } finally {
    await fh.close();
  }
}

export async function buildCatalog(ldrawRoot = LDRAW_ROOT): Promise<CatalogPart[]> {
  const partsDir = path.join(ldrawRoot, 'parts');
  const entries = await fsp.readdir(partsDir, { withFileTypes: true });
  const files = entries.filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.dat')).map((e) => e.name);

  const out: CatalogPart[] = [];
  const CONCURRENCY = 64;
  let next = 0;
  async function worker() {
    while (next < files.length) {
      const name = files[next++];
      try {
        const head = await readHead(path.join(partsDir, name));
        const part = toCatalogPart(name.toLowerCase(), parseHeader(head));
        if (part) out.push(part);
      } catch (err) {
        console.warn(`[catalog] skipping ${name}: ${(err as Error).message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  out.sort((a, b) => collator.compare(a.category, b.category) || collator.compare(a.name, b.name) || collator.compare(a.id, b.id));
  return out;
}

const MATERIAL_KEYWORDS: Record<string, BrickColor['material']> = {
  CHROME: 'chrome',
  METAL: 'metal',
  MATTE_METALLIC: 'metal',
  PEARLESCENT: 'pearl',
  RUBBER: 'rubber',
};

/** Parse `0 !COLOUR` lines of LDConfig.ldr. */
export function parseColors(text: string): BrickColor[] {
  const colors: BrickColor[] = [];
  const pendingEdges: Array<[BrickColor, number]> = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!/^0\s+!COLOUR\s/.test(line)) continue;
    const t = line.split(/\s+/).slice(2);
    const name = (t[0] ?? '').replace(/_/g, ' ');
    let code = NaN;
    let hex = '';
    let edge = '';
    let edgeCode: number | null = null;
    let alpha = 255;
    let material: BrickColor['material'] | undefined;
    for (let i = 1; i < t.length; i++) {
      const k = t[i].toUpperCase();
      if (k === 'CODE') code = parseInt(t[++i], 10);
      else if (k === 'VALUE') hex = t[++i];
      else if (k === 'EDGE') {
        const v = t[++i];
        if (v?.startsWith('#')) edge = v;
        else edgeCode = parseInt(v, 10);
      } else if (k === 'ALPHA') alpha = parseInt(t[++i], 10);
      else if (k === 'LUMINANCE') i++;
      else if (k in MATERIAL_KEYWORDS) material = MATERIAL_KEYWORDS[k];
      else if (k === 'MATERIAL') {
        const m = (t[i + 1] ?? '').toUpperCase();
        if (m === 'GLITTER') material = 'glitter';
        else if (m === 'SPECKLE') material = 'speckle';
        break; // remaining tokens are material parameters
      }
    }
    if (!Number.isFinite(code) || !/^#[0-9a-fA-F]{6}$/.test(hex)) continue;
    if (!Number.isFinite(alpha)) alpha = 255;
    const c: BrickColor = {
      code,
      name,
      hex: hex.toUpperCase(),
      edge: edge.toUpperCase(),
      alpha,
      material: material ?? (alpha < 255 ? 'transparent' : 'solid'),
    };
    if (!edge && edgeCode !== null) pendingEdges.push([c, edgeCode]);
    colors.push(c);
  }
  for (const [c, ec] of pendingEdges) c.edge = colors.find((x) => x.code === ec)?.hex ?? '#333333';
  for (const c of colors) if (!c.edge) c.edge = '#333333';
  return colors;
}

export async function buildColors(file = LDCONFIG_FILE): Promise<BrickColor[]> {
  return parseColors(await fsp.readFile(file, 'utf8'));
}

/** Build both caches and write them to server/cache/. */
export async function writeCaches(): Promise<{ parts: number; colors: number }> {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const [catalog, colors] = await Promise.all([buildCatalog(), buildColors()]);
  await fsp.writeFile(CATALOG_FILE, JSON.stringify(catalog));
  await fsp.writeFile(COLORS_FILE, JSON.stringify(colors));
  return { parts: catalog.length, colors: colors.length };
}
