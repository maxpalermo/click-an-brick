// Connectivity repair: parts that are not stud-connected to the main structure get their plate-layer
// neighbourhood re-tiled (randomised trials) so that new seams bridge separate components.
// Ported from research/photo2brick/src/repair.ts. Speed-up (doc task E4): trials are scored with a local
// union-find over the existing component labels (no full recomputation); only the best trial of each region
// is verified with one full component pass, and reverted if it does not help.

import { BRICKS, PLATES, EMPTY, ANY, type Placement } from './bricks';
import type { VoxelGrid } from './voxelize';

export interface Components { label: Int32Array; size: Map<number, number>; count: number; largest: number; largestLabel: number }

/** Reusable stud-contact component finder for a grid. */
export class ComponentFinder {
  private top: Int32Array;
  private bot: Int32Array;
  private parent = new Int32Array(0);
  constructor(private g: { nx: number; ny: number; nz: number }) {
    const n = g.nx * g.ny * g.nz;
    this.top = new Int32Array(n);
    this.bot = new Int32Array(n);
  }

  run(ps: (Placement | null)[]): Components {
    const { nx, ny, nz } = this.g;
    const NL = nx * nz;
    const top = this.top.fill(-1), bot = this.bot.fill(-1);
    if (this.parent.length < ps.length) this.parent = new Int32Array(ps.length * 2);
    const parent = this.parent;
    for (let i = 0; i < ps.length; i++) parent[i] = i;
    const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    for (let id = 0; id < ps.length; id++) {
      const p = ps[id];
      if (!p) continue;
      const tOff = (p.y + p.h - 1) * NL, bOff = p.y * NL;
      for (let z = p.z; z < p.z + p.sz; z++)
        for (let x = p.x; x < p.x + p.sx; x++) { top[tOff + x + nx * z] = id; bot[bOff + x + nx * z] = id; }
    }
    // pseudo-parts of one special part (same group) are one rigid body
    const groupRoot = new Map<number, number>();
    for (let id = 0; id < ps.length; id++) {
      const g = ps[id]?.group;
      if (g === undefined) continue;
      const r = groupRoot.get(g);
      if (r === undefined) groupRoot.set(g, id);
      else { const ra = find(id), rb = find(r); if (ra !== rb) parent[ra] = rb; }
    }
    for (let y = 1; y < ny; y++) {
      const a0 = (y - 1) * NL, b0 = y * NL;
      for (let i = 0; i < NL; i++) {
        const a = top[a0 + i];
        if (a < 0) continue;
        const b = bot[b0 + i];
        if (b < 0) continue;
        const ra = find(a), rb = find(b);
        if (ra !== rb) parent[ra] = rb;
      }
    }
    const label = new Int32Array(ps.length).fill(-1);
    const size = new Map<number, number>();
    for (let i = 0; i < ps.length; i++) if (ps[i]) { const l = find(i); label[i] = l; size.set(l, (size.get(l) ?? 0) + 1); }
    let largest = 0, largestLabel = -1;
    for (const [l, s] of size) if (s > largest) { largest = s; largestLabel = l; }
    return { label, size, count: size.size, largest, largestLabel };
  }
}

const PLATE_BY_DIMS = new Map(PLATES.map(([a, b, part]) => [`${a}x${b}`, part]));

/** Mulberry32 PRNG (deterministic runs). */
function rng(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export interface RepairOptions { trials: number; maxPasses: number; wArea: number; /** Try brick re-tiling of a loose brick's band before plates (default true). */ bricksFirst?: boolean }
export const DEFAULT_REPAIR: RepairOptions = { trials: 16, maxPasses: 5, wArea: 4 };

export function repairConnectivity(
  g: VoxelGrid, cells: Int16Array, input: Placement[], opt: RepairOptions = DEFAULT_REPAIR, onProgress?: (f: number) => void,
): { placements: Placement[]; before: Components; after: Components } {
  const { nx, ny, nz } = g;
  const NL = nx * nz;
  const ps: (Placement | null)[] = input.slice();
  const rand = rng(12345);
  const finder = new ComponentFinder(g);
  const owner = new Int32Array(ny * NL).fill(-1);
  const stamp = (id: number, v: number) => {
    const p = ps[id]!;
    for (let y = p.y; y < p.y + p.h; y++) for (let z = p.z; z < p.z + p.sz; z++) for (let x = p.x; x < p.x + p.sx; x++) owner[y * NL + x + nx * z] = v;
  };
  ps.forEach((_, id) => stamp(id, id));

  let comp = finder.run(ps);
  const before = comp;
  // component label per part id; parts created after the last full pass inherit their source's label
  let labelOf: number[] = Array.from(comp.label);
  const labelAt = (id: number) => (id < labelOf.length ? labelOf[id] : -1);

  for (let pass = 0; pass < opt.maxPasses && comp.count > 1; pass++) {
    const passStart = comp.count;
    const n = ps.length; // parts added in this pass are not revisited until the next pass
    for (let id = 0; id < n; id++) {
      onProgress?.((pass + id / n) / opt.maxPasses);
      const p = ps[id];
      if (!p || p.fixed || labelAt(id) === comp.largestLabel) continue;
      // brick first: re-tile the brick band around a loose brick with bricks (new stagger), so the repair does not
      // turn walls into plate stacks; the plate re-tiling below is the fallback
      if (p.h === 3 && opt.bricksFirst !== false) {
        let done = false;
        for (const r of [1, 2]) {
          const y = p.y;
          const regionIds: number[] = [];
          for (let z = p.z - r; z < p.z + p.sz + r; z++)
            for (let x = p.x - r; x < p.x + p.sx + r; x++) {
              if (x < 0 || z < 0 || x >= nx || z >= nz) continue;
              const o = owner[y * NL + x + nx * z];
              if (o < 0) continue;
              const q = ps[o]!;
              if (q.fixed || q.h !== 3 || q.y !== y || regionIds.includes(o)) continue;
              regionIds.push(o);
            }
          if (regionIds.length < 2) continue;
          const removed = regionIds.map((k) => ps[k]!);
          const removedLabels = regionIds.map(labelAt);
          const region = new Int16Array(NL).fill(EMPTY);
          for (const q of removed) for (let z = q.z; z < q.z + q.sz; z++) for (let x = q.x; x < q.x + q.sx; x++) region[x + nx * z] = q.color;
          for (const k of regionIds) { stamp(k, -1); ps[k] = null; }
          const removedPerLabel = new Map<number, number>();
          for (const l of removedLabels) removedPerLabel.set(l, (removedPerLabel.get(l) ?? 0) + 1);
          let vanished = 0;
          for (const [l, k] of removedPerLabel) if ((comp.size.get(l) ?? 0) <= k) vanished++;
          const sizeOf = (l: number) => (comp.size.get(l) ?? 0) - (removedPerLabel.get(l) ?? 0);
          const estimate = (tiles: Placement[]) => estimateScore(tiles, y, 3, nx, ny, NL, owner, labelAt, comp.count - vanished, sizeOf, comp.largestLabel);
          let best: Placement[] | null = null;
          let bestEst = estimate(removed);
          for (let t = 0; t < opt.trials; t++) {
            const tiles = tileRegion(region, removed, nx, y, 3, BRICKS, owner, ny, NL, labelAt, rand, opt.wArea);
            const e = estimate(tiles);
            if (e < bestEst) { best = tiles; bestEst = e; }
          }
          const restore = () => regionIds.forEach((k, j) => { ps[k] = removed[j]; stamp(k, k); });
          if (!best) { restore(); continue; }
          const added: number[] = [];
          for (const t of best) { ps.push(t); labelOf.push(-1); stamp(ps.length - 1, ps.length - 1); added.push(ps.length - 1); }
          const c = finder.run(ps);
          if (c.count < comp.count || (c.count === comp.count && c.largest > comp.largest)) {
            comp = c;
            labelOf = Array.from(c.label);
            done = true;
            break;
          }
          for (const a of added) { stamp(a, -1); ps[a] = null; }
          restore();
        }
        if (done || !ps[id]) continue;
      }
      const layers = p.h === 1 ? [p.y] : [p.y, p.y + 1, p.y + 2];
      for (const y of layers) {
        // bricks touching the region are tentatively split into 3 plates so seams can move
        const exploded: { id: number; brick: Placement; extra: number[] }[] = [];
        const explode = (o: number) => {
          const b = ps[o]!;
          const part = PLATE_BY_DIMS.get(`${Math.min(b.sx, b.sz)}x${Math.max(b.sx, b.sz)}`)!;
          ps[o] = { ...b, h: 1, part };
          const extra = [1, 2].map((k) => { ps.push({ ...b, y: b.y + k, h: 1, part }); labelOf.push(labelAt(o)); return ps.length - 1; });
          stamp(o, o); extra.forEach((e) => stamp(e, e));
          exploded.push({ id: o, brick: b, extra });
        };
        const undoExplode = () => {
          for (const e of exploded.reverse()) {
            for (const x of [e.id, ...e.extra]) { if (ps[x]) stamp(x, -1); ps[x] = null; }
            ps[e.id] = e.brick; stamp(e.id, e.id);
          }
        };
        const regionIds: number[] = [];
        for (let z = p.z - 1; z <= p.z + p.sz; z++)
          for (let x = p.x - 1; x <= p.x + p.sx; x++) {
            if (x < 0 || z < 0 || x >= nx || z >= nz) continue;
            let o = owner[y * NL + x + nx * z];
            if (o < 0 || ps[o]!.fixed) continue;
            if (ps[o]!.h === 3) { explode(o); o = owner[y * NL + x + nx * z]; }
            if (!regionIds.includes(o)) regionIds.push(o);
          }
        if (regionIds.length < 2) { undoExplode(); continue; }
        const removed = regionIds.map((r) => ps[r]!);
        const removedLabels = regionIds.map(labelAt);
        const region = new Int16Array(NL).fill(EMPTY);
        for (const r of removed) for (let z = r.z; z < r.z + r.sz; z++) for (let x = r.x; x < r.x + r.sx; x++) region[x + nx * z] = cells[y * NL + x + nx * z];
        for (const r of regionIds) { stamp(r, -1); ps[r] = null; }

        // labels that disappear entirely when the region is removed
        const removedPerLabel = new Map<number, number>();
        for (const l of removedLabels) removedPerLabel.set(l, (removedPerLabel.get(l) ?? 0) + 1);
        let vanished = 0;
        for (const [l, k] of removedPerLabel) if ((comp.size.get(l) ?? 0) <= k) vanished++;
        const sizeOf = (l: number) => (comp.size.get(l) ?? 0) - (removedPerLabel.get(l) ?? 0);
        const estimate = (tiles: Placement[]) => estimateScore(tiles, y, 1, nx, ny, NL, owner, labelAt, comp.count - vanished, sizeOf, comp.largestLabel);

        let best: Placement[] | null = null;
        let bestEst = estimate(removed);
        for (let t = 0; t < opt.trials; t++) {
          const tiles = tileRegion(region, removed, nx, y, 1, PLATES, owner, ny, NL, labelAt, rand, opt.wArea);
          const e = estimate(tiles);
          if (e < bestEst) { best = tiles; bestEst = e; }
        }
        const restore = () => {
          regionIds.forEach((r, k) => { ps[r] = removed[k]; stamp(r, r); });
          undoExplode();
        };
        if (!best) { restore(); continue; }
        const added: number[] = [];
        for (const tPart of best) { ps.push(tPart); labelOf.push(-1); stamp(ps.length - 1, ps.length - 1); added.push(ps.length - 1); }
        const c = finder.run(ps);
        if (c.count < comp.count || (c.count === comp.count && c.largest > comp.largest)) {
          comp = c;
          labelOf = Array.from(c.label);
        } else {
          for (const a of added) { stamp(a, -1); ps[a] = null; }
          restore();
        }
      }
    }
    if (comp.count >= passStart) break;
  }
  const placements = ps.filter((p): p is Placement => !!p);
  return { placements, before, after: finder.run(placements) };
}


function tileRegion(
  region: Int16Array, removed: Placement[], nx: number, y: number, h: number, parts: [number, number, string][], owner: Int32Array, ny: number, NL: number,
  labelAt: (id: number) => number, rand: () => number, wArea: number,
): Placement[] {
  const out: Placement[] = [];
  const covered = new Uint8Array(region.length);
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const r of removed) { x0 = Math.min(x0, r.x); x1 = Math.max(x1, r.x + r.sx); z0 = Math.min(z0, r.z); z1 = Math.max(z1, r.z + r.sz); }
  const labels: number[] = [];
  for (let z = z0; z < z1; z++)
    for (let x = x0; x < x1; x++) {
      const i0 = x + nx * z;
      if (covered[i0] || region[i0] === EMPTY) continue;
      let best: Placement | null = null, bestScore = -Infinity;
      for (const [a, b, part] of parts)
        for (let rot = 0; rot < (a === b ? 1 : 2); rot++) {
          const sx = rot ? a : b, sz = rot ? b : a;
          let color = ANY, ok = true;
          labels.length = 0;
          for (let dz = 0; dz < sz && ok; dz++)
            for (let dx = 0; dx < sx; dx++) {
              const X = x + dx, Z = z + dz;
              if (X >= nx || Z * nx >= region.length) { ok = false; break; }
              const i = X + nx * Z, c = region[i];
              if (covered[i] || c === EMPTY) { ok = false; break; }
              if (c !== ANY) { if (color === ANY) color = c; else if (c !== color) { ok = false; break; } }
              if (y > 0) { const o = owner[(y - 1) * NL + i]; if (o >= 0) { const l = labelAt(o); if (!labels.includes(l)) labels.push(l); } }
              if (y + h < ny) { const o = owner[(y + h) * NL + i]; if (o >= 0) { const l = labelAt(o); if (!labels.includes(l)) labels.push(l); } }
            }
          if (!ok) continue;
          const score = wArea * sx * sz + 12 * labels.length + 6 * rand();
          if (score > bestScore) { bestScore = score; best = { part, x, z, sx, sz, y, h, color }; }
        }
      const p = best!;
      for (let dz = 0; dz < p.sz; dz++) for (let dx = 0; dx < p.sx; dx++) covered[x + dx + nx * (z + dz)] = 1;
      out.push(p);
    }
  return out;
}
/**
 * Score of replacing the region with `tiles` (lower is better): component count first, then the size of the
 * main component as tie-break. Assumes the remaining components do not split (verified by the caller).
 */
function estimateScore(
  tiles: Placement[], y: number, h: number, nx: number, ny: number, NL: number, owner: Int32Array,
  labelAt: (id: number) => number, baseCount: number, sizeOf: (label: number) => number, mainLabel: number,
): number {
  const parent = new Map<number, number>();
  const find = (k: number): number => {
    let r = k;
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!;
    parent.set(k, r);
    return r;
  };
  let count = baseCount + tiles.length;
  tiles.forEach((t, k) => {
    const tk = -1 - k; // tile node keys are negative, labels are >= 0
    parent.set(tk, tk);
    for (let z = t.z; z < t.z + t.sz; z++)
      for (let x = t.x; x < t.x + t.sx; x++) {
        const i = x + nx * z;
        for (const yy of [y - 1, y + h]) {
          if (yy < 0 || yy >= ny) continue;
          const o = owner[yy * NL + i];
          if (o < 0) continue;
          const l = labelAt(o);
          if (l < 0) continue;
          if (!parent.has(l)) parent.set(l, l);
          const a = find(tk), b = find(l);
          if (a !== b) { parent.set(a, b); count--; }
        }
      }
  });
  let main = sizeOf(mainLabel);
  if (parent.has(mainLabel)) {
    const root = find(mainLabel);
    main = 0;
    for (const k of [...parent.keys()]) if (find(k) === root) main += k < 0 ? 1 : sizeOf(k);
  }
  return count * 1e7 - main;
}
