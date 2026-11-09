// GLB helpers for the UI: bounding box (for the §6 scale formulas) and an IndexedDB cache keyed by
// jobId, so size/hollow tweaks re-run only the converter and never call the API again.

export interface Bounds {
  min: [number, number, number];
  max: [number, number, number];
}

type M4 = number[]; // column-major 4x4, as in glTF

const IDENT: M4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function mul(a: M4, b: M4): M4 {
  const o = new Array<number>(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  return o;
}

function trs(t = [0, 0, 0], q = [0, 0, 0, 1], s = [1, 1, 1]): M4 {
  const [x, y, z, w] = q;
  const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
  return [
    (1 - 2 * (yy + zz)) * s[0], 2 * (xy + wz) * s[0], 2 * (xz - wy) * s[0], 0,
    2 * (xy - wz) * s[1], (1 - 2 * (xx + zz)) * s[1], 2 * (yz + wx) * s[1], 0,
    2 * (xz + wy) * s[2], 2 * (yz - wx) * s[2], (1 - 2 * (xx + yy)) * s[2], 0,
    t[0], t[1], t[2], 1,
  ];
}

interface GltfJson {
  scene?: number;
  scenes?: Array<{ nodes?: number[] }>;
  nodes?: Array<{ children?: number[]; mesh?: number; matrix?: number[]; translation?: number[]; rotation?: number[]; scale?: number[] }>;
  meshes?: Array<{ primitives: Array<{ attributes: Record<string, number> }> }>;
  accessors?: Array<{ min?: number[]; max?: number[] }>;
}

/** World-space bounding box from the accessor min/max of POSITION (cheap, no geometry decode). */
export function glbBounds(buf: ArrayBuffer): Bounds | null {
  try {
    const dv = new DataView(buf);
    if (dv.getUint32(0, true) !== 0x46546c67) return null; // 'glTF'
    const len = dv.getUint32(12, true);
    if (dv.getUint32(16, true) !== 0x4e4f534a) return null; // 'JSON'
    const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, len))) as GltfJson;
    const nodes = json.nodes ?? [];
    let roots = json.scenes?.[json.scene ?? 0]?.nodes;
    if (!roots) {
      const child = new Set(nodes.flatMap((n) => n.children ?? []));
      roots = nodes.map((_, i) => i).filter((i) => !child.has(i));
    }
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    const walk = (i: number, parent: M4, depth: number) => {
      const n = nodes[i];
      if (!n || depth > 64) return;
      const local = n.matrix?.length === 16 ? n.matrix : trs(n.translation, n.rotation, n.scale);
      const world = mul(parent, local);
      if (n.mesh != null) {
        for (const p of json.meshes?.[n.mesh]?.primitives ?? []) {
          const acc = json.accessors?.[p.attributes.POSITION];
          if (!acc?.min || !acc.max) continue;
          for (let c = 0; c < 8; c++) {
            const v = [c & 1 ? acc.max[0] : acc.min[0], c & 2 ? acc.max[1] : acc.min[1], c & 4 ? acc.max[2] : acc.min[2]];
            for (let a = 0; a < 3; a++) {
              const w = world[a] * v[0] + world[4 + a] * v[1] + world[8 + a] * v[2] + world[12 + a];
              if (w < min[a]) min[a] = w;
              if (w > max[a]) max[a] = w;
            }
          }
        }
      }
      for (const ch of n.children ?? []) walk(ch, world, depth + 1);
    };
    for (const r of roots) walk(r, IDENT, 0);
    if (!Number.isFinite(min[0]) || max[0] - min[0] <= 0) return null;
    return { min, max };
  } catch {
    return null;
  }
}

// ---------------- IndexedDB cache ----------------

const DB = 'brickyard-photo';
const STORE = 'glb';
const KEEP = 4;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(db: IDBDatabase, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const r = run(db.transaction(STORE, mode).objectStore(STORE));
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

interface Entry {
  glb: ArrayBuffer;
  t: number;
}

export async function cacheGlb(jobId: string, glb: ArrayBuffer): Promise<void> {
  try {
    const db = await openDb();
    await tx(db, 'readwrite', (s) => s.put({ glb, t: Date.now() } satisfies Entry, jobId));
    // Keep only the newest few GLBs (they are 2–10 MB each).
    const keys = (await tx(db, 'readonly', (s) => s.getAllKeys())) as string[];
    if (keys.length > KEEP) {
      const all = (await tx(db, 'readonly', (s) => s.getAll())) as Entry[];
      const order = keys.map((k, i) => ({ k, t: all[i]?.t ?? 0 })).sort((a, b) => b.t - a.t);
      for (const { k } of order.slice(KEEP)) await tx(db, 'readwrite', (s) => s.delete(k));
    }
    db.close();
  } catch {
    /* private mode / quota: the in-memory copy still works for this session */
  }
}

export async function loadCachedGlb(jobId: string): Promise<ArrayBuffer | null> {
  try {
    const db = await openDb();
    const e = (await tx(db, 'readonly', (s) => s.get(jobId))) as Entry | undefined;
    db.close();
    return e?.glb ?? null;
  } catch {
    return null;
  }
}
