// Packs an LDraw part and all of its (recursive) subfiles into one self-contained MPD text,
// in the exact format three.js' LDrawLoader (r169) understands:
//   - line 1 is `0 FILE <id>` (the loader ignores a FILE meta on the first line) followed by the
//     part's own content = the model the loader renders;
//   - each dependency follows as `0 FILE <key>` + content. On parse, the loader stores each embedded
//     file under `<key>.toLowerCase()` and later looks type-1 references up under the same key,
//     normalised as: trim, `\` → `/`, `s/…` → `parts/s/…`, `48/…` → `p/48/…`. We emit exactly that key.
// Original headers (incl. `0 !LDRAW_ORG Part/Subpart/Primitive`) are preserved; the loader uses them
// to decide which files are parts (cached as building blocks) vs primitives.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { LDRAW_ROOT, PACKED_DIR } from './paths.js';

// ---------- library index (case-insensitive lookup) ----------

let index: Map<string, string> | null = null;

function walk(dir: string, rel: string, out: Map<string, string>) {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walk(abs, r, out);
    else if (e.isFile()) out.set(r.toLowerCase(), abs);
  }
}

/** Map of lowercase library-relative path ("parts/s/3001s01.dat") → absolute path. */
export function libraryIndex(): Map<string, string> {
  if (!index) {
    const m = new Map<string, string>();
    for (const top of ['parts', 'p', 'models']) walk(path.join(LDRAW_ROOT, top), top, m);
    index = m;
  }
  return index;
}

export function resetLibraryIndex() {
  index = null;
}

/** Normalise a type-1 file reference to the cache key three's LDrawLoader will look up. */
export function loaderKey(ref: string): string {
  let f = ref.trim().replace(/\\/g, '/');
  if (f.startsWith('s/')) f = 'parts/' + f;
  else if (f.startsWith('48/')) f = 'p/' + f;
  return f.toLowerCase();
}

/** Resolve a loader key to a file in the library, mimicking LDraw search order. */
export function resolveKey(key: string): string | null {
  const idx = libraryIndex();
  const candidates = [
    `parts/${key}`,
    `p/${key}`,
    key, // already prefixed (parts/s/…, p/48/…)
    `models/${key}`,
  ];
  // Non-standard but common: "8\foo.dat" → p/8/foo.dat is covered by `p/${key}`.
  for (const c of candidates) {
    const hit = idx.get(c);
    if (hit) return hit;
  }
  return null;
}

const TYPE1 = /^\s*1\s+(?:\S+\s+){13}(.+?)\s*$/;

function normaliseContent(text: string): string[] {
  // LF only; drop trailing whitespace; never let an original line look like an MPD FILE boundary.
  return text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n|\r/)
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => !/^0\s+(FILE|NOFILE)\b/.test(l));
}

function refsOf(lines: string[]): string[] {
  const out: string[] = [];
  for (const l of lines) {
    const m = TYPE1.exec(l);
    if (m) out.push(m[1]);
  }
  return out;
}

export interface PackResult {
  text: string;
  files: number;
  missing: string[];
}

/** Pack a top-level part. Returns null if the part itself does not exist. */
export async function packPart(id: string): Promise<PackResult | null> {
  const rootFile = libraryIndex().get(`parts/${id}`);
  if (!rootFile) return null;

  const rootLines = normaliseContent(await fsp.readFile(rootFile, 'utf8'));
  const sections: string[] = [`0 FILE ${id}`, ...rootLines];
  const seen = new Set<string>([id]); // root is reachable under its own key too
  const missing: string[] = [];
  const queue: string[] = refsOf(rootLines);
  let files = 1;

  while (queue.length) {
    const ref = queue.shift()!;
    const key = loaderKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    const file = resolveKey(key);
    if (!file) {
      missing.push(key);
      continue;
    }
    const lines = normaliseContent(await fsp.readFile(file, 'utf8'));
    sections.push('', `0 FILE ${key}`, ...lines);
    files++;
    for (const r of refsOf(lines)) if (!seen.has(loaderKey(r))) queue.push(r);
  }
  if (missing.length) console.warn(`[packer] ${id}: unresolved subfiles: ${missing.join(', ')}`);
  return { text: sections.join('\n') + '\n', files, missing };
}

// ---------- caching (memory LRU + disk) ----------

export { isValidPartId } from './model-validation.js';

class Lru<V> {
  private map = new Map<string, V>();
  constructor(private max: number) {}
  get(k: string): V | undefined {
    const v = this.map.get(k);
    if (v !== undefined) {
      this.map.delete(k);
      this.map.set(k, v);
    }
    return v;
  }
  set(k: string, v: V) {
    this.map.delete(k);
    this.map.set(k, v);
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string);
  }
  clear() {
    this.map.clear();
  }
}

const memory = new Lru<string>(400);
const inflight = new Map<string, Promise<string | null>>();

/** Get the packed MPD for a (validated, lowercase) part id, or null if the part doesn't exist. */
export function getPacked(id: string): Promise<string | null> {
  const hit = memory.get(id);
  if (hit !== undefined) return Promise.resolve(hit);
  const pending = inflight.get(id);
  if (pending) return pending;

  const p = (async () => {
    const diskFile = path.join(PACKED_DIR, id.replace(/\.dat$/, '.mpd'));
    try {
      const text = await fsp.readFile(diskFile, 'utf8');
      memory.set(id, text);
      return text;
    } catch {
      /* not cached yet */
    }
    const res = await packPart(id);
    if (!res) return null;
    memory.set(id, res.text);
    try {
      await fsp.mkdir(PACKED_DIR, { recursive: true });
      const tmp = `${diskFile}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, res.text);
      await fsp.rename(tmp, diskFile);
    } catch (err) {
      console.warn(`[packer] could not write disk cache for ${id}: ${(err as Error).message}`);
    }
    return res.text;
  })().finally(() => inflight.delete(id));
  inflight.set(id, p);
  return p;
}

export function clearPackedMemory() {
  memory.clear();
}
