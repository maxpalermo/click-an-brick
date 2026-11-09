// Coloured voxel grid -> buildable bricks + plates (greedy, layer by layer, with stagger scoring).
// Ported from research/photo2brick/src/bricks.ts.

import type { Brick, Mat3 } from '../../model/types';
import { type VoxelGrid, STUD, PLATE_H } from './voxelize';

/** LDraw ids. Footprint a x b studs (a <= b); in LDraw default orientation the long side runs along X. */
export const PLATES: [number, number, string][] = [
  // wide plates (base layer, floors, roofs): one part where a builder would never tile 2-wide strips
  [8, 16, '92438.dat'], [8, 8, '41539.dat'], [6, 12, '3028.dat'], [6, 10, '3033.dat'], [6, 8, '3036.dat'], [6, 6, '3958.dat'],
  [4, 12, '3029.dat'], [4, 10, '3030.dat'], [4, 8, '3035.dat'], [4, 6, '3032.dat'], [4, 4, '3031.dat'],
  [2, 8, '3034.dat'], [2, 6, '3795.dat'], [2, 4, '3020.dat'], [2, 3, '3021.dat'], [2, 2, '3022.dat'],
  [1, 8, '3460.dat'], [1, 6, '3666.dat'], [1, 4, '3710.dat'], [1, 3, '3623.dat'], [1, 2, '3023b.dat'], [1, 1, '3024.dat'],
];
export const BRICKS: [number, number, string][] = [
  [2, 8, '3007.dat'], [2, 6, '2456.dat'], [2, 4, '3001.dat'], [2, 3, '3002.dat'], [2, 2, '3003.dat'],
  [1, 8, '3008.dat'], [1, 6, '3009.dat'], [1, 4, '3010.dat'], [1, 3, '3622.dat'], [1, 2, '3004.dat'], [1, 1, '3005.dat'],
];

/** 90° about LDraw Y: the part's long (X) axis runs along Z. Same matrix as engine/math.ts rotY90(1). */
const ROT_Y90: Mat3 = [0, 0, 1, 0, 1, 0, -1, 0, 0];
const IDENT: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export const EMPTY = -2;
export const ANY = -1; // hidden voxel: any colour will do

export interface Placement {
  part: string;
  x: number; z: number; sx: number; sz: number; // footprint in voxel cells
  y: number; h: number; // bottom layer, height in plates (1 or 3)
  color: number; // palette index, or ANY
  /** Pseudo-part standing for cells taken by special parts (never emitted as a brick, never re-tiled). */
  fixed?: boolean;
  /** Pseudo-parts with the same group are one rigid special part (for stud connectivity). */
  group?: number;
}

export interface MergeOptions {
  useBricks: boolean;
  /** Score weights (tuned in the spike). */
  wArea: number; wBridge: number; wStackPenalty: number;
  /**
   * 'scan' = anchor each part at the first free cell in row order (original); 'largest' = place the best-scoring
   * candidates of the whole layer first, so surfaces facing +x/+z are not forced into 1-wide strips.
   */
  packing?: 'scan' | 'largest' | 'constrained';
}
export const DEFAULT_MERGE: MergeOptions = { useBricks: true, wArea: 4, wBridge: 3, wStackPenalty: 10 };

/** cells: palette index per voxel, ANY for hidden voxels, EMPTY for air. Same indexing as VoxelGrid. */
export function mergeBricks(g: VoxelGrid, cells: Int16Array, opt: MergeOptions = DEFAULT_MERGE, onProgress?: (f: number) => void): Placement[] {
  const { nx, ny, nz } = g;
  const NL = nx * nz;
  const placements: Placement[] = [];
  const owner: Int32Array[] = Array.from({ length: ny }, () => new Int32Array(NL).fill(-1));
  let y0 = 0;
  while (y0 < ny && !cells.subarray(y0 * NL, (y0 + 1) * NL).some((c) => c !== EMPTY)) y0++;

  const layer = (y: number) => cells.subarray(y * NL, (y + 1) * NL);
  const pack = opt.packing === 'largest' ? packLayerLargest : opt.packing === 'constrained' ? packLayerConstrained : packLayer;
  const place = (p: Placement) => {
    const id = placements.push(p) - 1;
    for (let y = p.y; y < p.y + p.h; y++)
      for (let z = p.z; z < p.z + p.sz; z++) for (let x = p.x; x < p.x + p.sx; x++) owner[y][x + nx * z] = id;
  };

  for (let y = y0; y < ny; ) {
    onProgress?.((y - y0) / Math.max(1, ny - y0));
    const brickGroup = opt.useBricks && y + 2 < ny;
    if (brickGroup) {
      // cells where 3 stacked plates could be one brick: all solid, colours compatible
      const col = new Int16Array(NL).fill(EMPTY);
      const l0 = layer(y), l1 = layer(y + 1), l2 = layer(y + 2);
      for (let i = 0; i < NL; i++) col[i] = combine(combine(l0[i], l1[i]), l2[i]);
      pack(col, nx, nz, y > y0 ? owner[y - 1] : null, placements, BRICKS, (y - y0) / 3, opt, (p) => place({ ...p, y, h: 3 }));
      for (let k = 0; k < 3; k++) {
        const rest = layer(y + k).slice();
        for (let i = 0; i < NL; i++) if (owner[y + k][i] >= 0) rest[i] = EMPTY;
        pack(rest, nx, nz, y + k > y0 ? owner[y + k - 1] : null, placements, PLATES, y + k, opt, (p) => place({ ...p, y: y + k, h: 1 }));
      }
      y += 3;
    } else {
      pack(layer(y).slice(), nx, nz, y > y0 ? owner[y - 1] : null, placements, PLATES, y, opt, (p) => place({ ...p, y, h: 1 }));
      y++;
    }
  }
  return placements;
}

const MIX = -3; // incompatible
function combine(a: number, b: number): number {
  if (a === EMPTY || b === EMPTY || a === MIX || b === MIX) return EMPTY;
  if (a === ANY) return b;
  if (b === ANY || a === b) return a;
  return EMPTY;
}

/**
 * Most-constrained-first packing: repeatedly take the free cell with the fewest free, colour-compatible 4-neighbours
 * (outline corners and staircase ends first) and cover it with the best part in any position over it. Candidates
 * that would strand a neighbour (no free neighbour left = a forced 1x1) are penalised.
 */
function packLayerConstrained(
  cells: Int16Array, nx: number, nz: number, below: Int32Array | null, all: Placement[],
  parts: [number, number, string][], parity: number, opt: MergeOptions,
  emit: (p: Omit<Placement, 'y' | 'h'>) => void,
) {
  const NL = nx * nz;
  const preferX = parity % 2 === 0;
  const covered = new Uint8Array(NL);
  const ok = (i: number) => !covered[i] && cells[i] !== EMPTY;
  const linked = (i: number, j: number) => { const a = cells[i], b = cells[j]; return a === ANY || b === ANY || a === b; };
  const deg = new Int8Array(NL).fill(-1);
  const degree = (i: number) => {
    const x = i % nx, z = (i - x) / nx;
    let n = 0;
    if (x > 0 && ok(i - 1) && linked(i, i - 1)) n++;
    if (x < nx - 1 && ok(i + 1) && linked(i, i + 1)) n++;
    if (z > 0 && ok(i - nx) && linked(i, i - nx)) n++;
    if (z < nz - 1 && ok(i + nx) && linked(i, i + nx)) n++;
    return n;
  };
  let left = 0;
  for (let i = 0; i < NL; i++) if (cells[i] !== EMPTY) { deg[i] = degree(i); left++; }
  const owners: number[] = [];
  const inCand = (x: number, z: number, c: { x: number; z: number; sx: number; sz: number }) => x >= c.x && x < c.x + c.sx && z >= c.z && z < c.z + c.sz;
  while (left > 0) {
    let seed = -1, best = 9;
    for (let i = 0; i < NL; i++) if (deg[i] >= 0 && !covered[i] && deg[i] < best) { best = deg[i]; seed = i; if (best === 0) break; }
    const x0 = seed % nx, z0 = (seed - x0) / nx;
    let pick: Omit<Placement, 'y' | 'h'> | null = null, pickScore = -Infinity;
    for (const [a, b, part] of parts)
      for (let rot = 0; rot < (a === b ? 1 : 2); rot++) {
        const sx = rot ? a : b, sz = rot ? b : a;
        for (let oz = 0; oz < sz; oz++)
          for (let ox = 0; ox < sx; ox++) {
            const x = x0 - ox, z = z0 - oz;
            if (x < 0 || z < 0 || x + sx > nx || z + sz > nz) continue;
            let color = ANY, good = true;
            owners.length = 0;
            for (let dz = 0; dz < sz && good; dz++)
              for (let dx = 0; dx < sx; dx++) {
                const i = x + dx + nx * (z + dz);
                if (!ok(i)) { good = false; break; }
                const c = cells[i];
                if (c !== ANY) { if (color === ANY) color = c; else if (c !== color) { good = false; break; } }
                if (below) { const o = below[i]; if (o >= 0 && !owners.includes(o)) owners.push(o); }
              }
            if (!good) continue;
            let score = opt.wArea * sx * sz + opt.wBridge * Math.min(owners.length, 4);
            if (owners.length === 1) {
              const o = all[owners[0]];
              if (o.x === x && o.z === z && o.sx === sx && o.sz === sz) score -= opt.wStackPenalty;
            }
            if ((sx >= sz) === preferX) score += 1;
            // stranded neighbours: free cells next to the candidate that would have no free compatible neighbour left
            const cand = { x, z, sx, sz };
            let stranded = 0;
            const check = (X: number, Z: number) => {
              if (X < 0 || Z < 0 || X >= nx || Z >= nz) return;
              const j = X + nx * Z;
              if (!ok(j)) return;
              for (const [ddx, ddz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                const U = X + ddx, V = Z + ddz;
                if (U < 0 || V < 0 || U >= nx || V >= nz || inCand(U, V, cand)) continue;
                const k = U + nx * V;
                if (ok(k) && linked(j, k)) return;
              }
              stranded++;
            };
            for (let dx = 0; dx < sx; dx++) { check(x + dx, z - 1); check(x + dx, z + sz); }
            for (let dz = 0; dz < sz; dz++) { check(x - 1, z + dz); check(x + sx, z + dz); }
            score -= 6 * stranded;
            if (score > pickScore) { pickScore = score; pick = { part, x, z, sx, sz, color }; }
          }
      }
    const p = pick!; // 1x1 always fits
    for (let dz = 0; dz < p.sz; dz++) for (let dx = 0; dx < p.sx; dx++) { covered[p.x + dx + nx * (p.z + dz)] = 1; left--; }
    // update degrees around the part
    for (let z = Math.max(0, p.z - 1); z <= Math.min(nz - 1, p.z + p.sz); z++)
      for (let x = Math.max(0, p.x - 1); x <= Math.min(nx - 1, p.x + p.sx); x++) {
        const i = x + nx * z;
        if (deg[i] >= 0 && !covered[i]) deg[i] = degree(i);
      }
    emit(p);
  }
}

/** Largest-first packing: score every fitting candidate in the layer, place them best-first, fill leftovers by scan. */
function packLayerLargest(
  cells: Int16Array, nx: number, nz: number, below: Int32Array | null, all: Placement[],
  parts: [number, number, string][], parity: number, opt: MergeOptions,
  emit: (p: Omit<Placement, 'y' | 'h'>) => void,
) {
  const preferX = parity % 2 === 0;
  const cand: { x: number; z: number; sx: number; sz: number; part: string; color: number; score: number }[] = [];
  const owners: number[] = [];
  let any = false;
  for (let i = 0; i < cells.length; i++) if (cells[i] !== EMPTY) { any = true; break; }
  if (!any) return;
  for (const [a, b, part] of parts) {
    if (a * b <= 2) continue; // 1x1 / 1x2 only as leftovers
    for (let rot = 0; rot < (a === b ? 1 : 2); rot++) {
      const sx = rot ? a : b, sz = rot ? b : a;
      for (let z = 0; z + sz <= nz; z++)
        for (let x = 0; x + sx <= nx; x++) {
          let color = ANY, ok = true;
          owners.length = 0;
          for (let dz = 0; dz < sz && ok; dz++)
            for (let dx = 0; dx < sx; dx++) {
              const i = x + dx + nx * (z + dz);
              const c = cells[i];
              if (c === EMPTY) { ok = false; break; }
              if (c !== ANY) { if (color === ANY) color = c; else if (c !== color) { ok = false; break; } }
              if (below) { const o = below[i]; if (o >= 0 && !owners.includes(o)) owners.push(o); }
            }
          if (!ok) continue;
          let score = opt.wArea * sx * sz + opt.wBridge * Math.min(owners.length, 4);
          if (owners.length === 1) {
            const o = all[owners[0]];
            if (o.x === x && o.z === z && o.sx === sx && o.sz === sz) score -= opt.wStackPenalty;
          }
          if ((sx >= sz) === preferX) score += 1;
          cand.push({ x, z, sx, sz, part, color, score });
        }
    }
  }
  cand.sort((p, q) => q.score - p.score || p.z - q.z || p.x - q.x);
  const covered = new Uint8Array(nx * nz);
  for (const c of cand) {
    let free = true;
    for (let dz = 0; dz < c.sz && free; dz++)
      for (let dx = 0; dx < c.sx; dx++) if (covered[c.x + dx + nx * (c.z + dz)]) { free = false; break; }
    if (!free) continue;
    for (let dz = 0; dz < c.sz; dz++) for (let dx = 0; dx < c.sx; dx++) covered[c.x + dx + nx * (c.z + dz)] = 1;
    emit({ part: c.part, x: c.x, z: c.z, sx: c.sx, sz: c.sz, color: c.color });
  }
  const rest = cells.slice();
  for (let i = 0; i < rest.length; i++) if (covered[i]) rest[i] = EMPTY;
  packLayer(rest, nx, nz, below, all, parts, parity, opt, emit);
}

function packLayer(
  cells: Int16Array, nx: number, nz: number, below: Int32Array | null, all: Placement[],
  parts: [number, number, string][], parity: number, opt: MergeOptions,
  emit: (p: Omit<Placement, 'y' | 'h'>) => void,
) {
  const covered = new Uint8Array(nx * nz);
  const preferX = parity % 2 === 0;
  const owners: number[] = [];
  for (let z = 0; z < nz; z++)
    for (let x = 0; x < nx; x++) {
      const i0 = x + nx * z;
      if (covered[i0] || cells[i0] === EMPTY) continue;
      let best: Omit<Placement, 'y' | 'h'> | null = null, bestScore = -Infinity;
      for (const [a, b, part] of parts)
        for (let rot = 0; rot < (a === b ? 1 : 2); rot++) {
          const sx = rot ? a : b, sz = rot ? b : a;
          if (x + sx > nx || z + sz > nz) continue;
          let color = ANY, ok = true;
          owners.length = 0;
          for (let dz = 0; dz < sz && ok; dz++)
            for (let dx = 0; dx < sx; dx++) {
              const i = x + dx + nx * (z + dz);
              const c = cells[i];
              if (covered[i] || c === EMPTY) { ok = false; break; }
              if (c !== ANY) { if (color === ANY) color = c; else if (c !== color) { ok = false; break; } }
              if (below) { const o = below[i]; if (o >= 0 && !owners.includes(o)) owners.push(o); }
            }
          if (!ok) continue;
          let score = opt.wArea * sx * sz + opt.wBridge * Math.min(owners.length, 4);
          if (owners.length === 1) {
            const o = all[owners[0]];
            if (o.x === x && o.z === z && o.sx === sx && o.sz === sz) score -= opt.wStackPenalty; // stacked seam
          }
          if ((sx >= sz) === preferX) score += 1;
          if (score > bestScore) { bestScore = score; best = { part, x, z, sx, sz, color }; }
        }
      const p = best!; // 1x1 always fits
      for (let dz = 0; dz < p.sz; dz++) for (let dx = 0; dx < p.sx; dx++) covered[x + dx + nx * (z + dz)] = 1;
      emit(p);
    }
}

/** Grid cell -> LDraw frame: LDraw x = (cellX - cx) * 20, z = -(cellZ - cz) * 20, bottom of layer y0 at LDraw y = 0. */
export interface BrickFrame { cx: number; cz: number; y0: number }

/** The frame toBricks uses by default: centred on the placements' footprint bbox (rounded to whole studs), bottom at 0. */
export function placementFrame(ps: Placement[]): BrickFrame {
  let y0 = Infinity, x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const p of ps) {
    y0 = Math.min(y0, p.y);
    x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x + p.sx);
    z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z + p.sz);
  }
  return { cx: Math.round((x0 + x1) / 2), cz: Math.round((z0 + z1) / 2), y0 };
}

/**
 * Placements -> app bricks in LDraw coordinates (-Y up). LDraw origin of these parts = top centre of the body
 * (studs above it at y < 0). The model is centred on X/Z with every footprint edge on the editor's 20 LDU
 * stud grid, and its bottom at y = 0. glTF (x, y, z) maps to LDraw (x, -y, -z), which the editor (root group
 * rotated π about X) shows in the original glTF orientation; glTF front (+Z) faces LDraw -Z (LDraw front).
 */
export function toBricks(ps: Placement[], paletteCodes: number[], fallbackCode: number, frame?: BrickFrame): Omit<Brick, 'id'>[] {
  ps = ps.filter((p) => !p.fixed);
  if (!ps.length) return [];
  const { cx, cz, y0 } = frame ?? placementFrame(ps);
  const c0 = (v: number) => (Object.is(v, -0) ? 0 : v);
  return ps.map((p) => ({
    part: p.part,
    color: p.color >= 0 ? paletteCodes[p.color] : fallbackCode,
    pos: [c0((p.x + p.sx / 2 - cx) * STUD), c0(-(p.y - y0 + p.h) * PLATE_H), c0(-(p.z + p.sz / 2 - cz) * STUD)],
    rot: p.sx >= p.sz ? IDENT : ROT_Y90,
  }));
}

// =====================================================================================================  structure packer
//
// Builder-style packing (structure workstream, 2026-10-26). Layer by layer like mergeBricks (bricks where 3 stacked
// plates agree, plates elsewhere), but each layer is solved as a weighted exact cover:
//   * every part has a score that depends only on the part and the layer below it: a fixed cost per part (fewer,
//     bigger parts), extra cost for 1x1 / 1x2 / 1x3 and 1-wide parts, + for every seam of the layer below that the
//     part covers (running bond), - for every edge of the part that sits on a seam below (aligned vertical seams),
//     - for stacking exactly on an identical part, + for crossing the orientation of the part below, + for bridging
//     several parts below, a big - for a part with nothing under it (except on the ground);
//   * a most-constrained-first greedy builds a layer, then ruin-and-recreate local search (remove the parts in a
//     small window, refill greedily with noise, keep it when the total score does not drop) improves it within an
//     iteration / time budget;
//   * symmetric layout: with a mirror plane, only one half of the layer is solved; parts that cross the centre line
//     must be self-symmetric (centred on the plane), every other part is mirrored. So the layout is exactly
//     symmetric and seams on the centre line are covered by centred parts in alternate layers (the scores do it).

export interface PackWeights {
  part: number; small1: number; small2: number; small3: number; thin: number;
  cover: number; align: number; stack: number; orient: number; bridge: number; unsupported: number;
  /** Per extra stud-connected group the part joins (parts below that are not yet connected to each other). */
  join: number;
  /** A part with nothing under it (or on the ground) AND nothing above it would be a loose part. */
  loose: number;
  stranded: number; noise: number;
}
export const PACK_WEIGHTS: PackWeights = {
  part: 10, small1: 24, small2: 14, small3: 6, thin: 2,
  cover: 3, align: 4, stack: 8, orient: 2, bridge: 3, unsupported: 20, join: 12, loose: 20,
  stranded: 6, noise: 5,
};

export interface StructureOptions {
  useBricks: boolean;
  /** Mirror plane for a symmetric layout (cells must already be symmetric about it). axis 0 = X, 2 = Z; p in cell-boundary coords. */
  mirror?: { axis: 0 | 2; p: number } | null;
  /** Local search moves per layer cell (0 = greedy only). */
  effort: number;
  /** Wall-clock cap for the whole packing, ms. */
  budgetMs: number;
  /** Pseudo-parts (special parts' cells, `fixed: true`) already in the grid; they lead the returned list. */
  fixed?: Placement[];
  seed?: number;
  weights?: Partial<PackWeights>;
  /** Pack thin unsupported slabs (floors) as plate layers instead of loose bricks (ApproxSettings.slabs). */
  slabPlates?: boolean;
  /** Use the wide plates (4x4 ... 8x16) too (default true). */
  widePlates?: boolean;
  /** Plate layers at the ground before the first brick band (ApproxSettings.basePlates). */
  base?: number;
}

interface Ori { a: number; b: number; su: number; sv: number; part: string }
const orientations = (parts: [number, number, string][]): Ori[] => {
  const out: Ori[] = [];
  for (const [a, b, part] of parts) {
    out.push({ a, b, su: b, sv: a, part });
    if (a !== b) out.push({ a, b, su: a, sv: b, part });
  }
  return out;
};
const BRICK_ORI = orientations(BRICKS);
const PLATE_ORI = orientations(PLATES);
/** Plates up to 2 wide only (the packer before wide plates; research ablation). */
const NARROW_PLATE_ORI = orientations(PLATES.filter(([a]) => a <= 2));

function prng(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

interface LayerPart { u: number; v: number; k: number; color: number; w: number; score: number }

/** One layer in layer space (u along the mirror axis). Holds the parts of the solved half (crossing parts once). */
class LayerSolver {
  W = 0; H = 0;
  cells!: Int16Array;
  below: Int32Array | null = null;
  /** 1 where the layer above the part will hold something (cells or special parts), null = unknown. */
  above: Uint8Array | null = null;
  ground = false;
  ori!: Ori[];
  p2 = Infinity; // 2 * mirror plane (cell-boundary coords), Infinity = no mirror
  belowDims!: (o: number) => [number, number, number, number]; // u, v, su, sv of a part below
  belowRoot!: (o: number) => number; // stud-connected group of a part below (so far)
  w!: PackWeights;
  rand!: () => number;
  // caches per orientation k: fit colour (-4 unknown, -3 no fit) and score (NaN unknown)
  private fitC: Int16Array[] = [];
  private scoreC: Float32Array[] = [];
  covered = new Uint8Array(0);
  own = new Int32Array(0);
  chosen: (LayerPart | null)[] = [];
  private owners: number[] = [];
  private roots: number[] = [];
  private ownerCount: number[] = [];

  reset(W: number, H: number, cells: Int16Array, below: Int32Array | null, ground: boolean, ori: Ori[], p2: number, above: Uint8Array | null = null) {
    this.W = W; this.H = H; this.cells = cells; this.below = below; this.ground = ground; this.ori = ori; this.p2 = p2; this.above = above;
    const n = W * H;
    if (this.covered.length < n) { this.covered = new Uint8Array(n); this.own = new Int32Array(n); }
    this.covered.fill(0, 0, n);
    this.own.fill(-1, 0, n);
    for (let k = 0; k < ori.length; k++) {
      if (!this.fitC[k] || this.fitC[k].length < n) { this.fitC[k] = new Int16Array(n); this.scoreC[k] = new Float32Array(n); }
      this.fitC[k].fill(-4, 0, n);
      this.scoreC[k].fill(NaN, 0, n);
    }
    this.chosen = [];
  }

  inDomain(u: number) { return 2 * u + 1 <= this.p2; }

  /** Colour of the footprint (ANY / palette index) or -3 when it does not fit (bounds, empty, mixed, mirror rule). */
  fit(k: number, u: number, v: number): number {
    const o = this.ori[k];
    if (u < 0 || v < 0 || u + o.su > this.W || v + o.sv > this.H) return -3;
    if (2 * (u + o.su) > this.p2 && 2 * u + o.su !== this.p2) return -3; // crosses the plane without being centred on it
    const idx = u + this.W * v;
    const c0 = this.fitC[k][idx];
    if (c0 !== -4) return c0;
    let color = ANY;
    const W = this.W, cells = this.cells;
    for (let dv = 0; dv < o.sv && color !== -3; dv++)
      for (let du = 0; du < o.su; du++) {
        const c = cells[u + du + W * (v + dv)];
        if (c === EMPTY) { color = -3; break; }
        if (c !== ANY) { if (color === ANY) color = c; else if (c !== color) { color = -3; break; } }
      }
    this.fitC[k][idx] = color;
    return color;
  }

  crossing(k: number, u: number) { return 2 * (u + this.ori[k].su) > this.p2; }

  /** Part score (layer-local terms only; see PACK_WEIGHTS). */
  score(k: number, u: number, v: number): number {
    const idx = u + this.W * v;
    const s0 = this.scoreC[k][idx];
    if (!Number.isNaN(s0)) return s0;
    const o = this.ori[k], w = this.w, W = this.W, H = this.H;
    const area = o.su * o.sv;
    let s = -w.part;
    if (area === 1) s -= w.small1; else if (area === 2) s -= w.small2; else if (area === 3) s -= w.small3;
    if (o.a === 1 && area >= 3) s -= w.thin;
    const below = this.below;
    if (this.above) {
      // nothing above and nothing below (or the ground): the part would only touch its neighbours sideways
      let held = false;
      for (let dv = 0; dv < o.sv && !held; dv++) for (let du = 0; du < o.su; du++) if (this.above[u + du + W * (v + dv)]) { held = true; break; }
      if (!held) {
        let sup = false;
        if (below && !this.ground) for (let dv = 0; dv < o.sv && !sup; dv++) for (let du = 0; du < o.su; du++) if (below[u + du + W * (v + dv)] >= 0) { sup = true; break; }
        if (!sup) s -= w.loose;
      }
    }
    if (below) {
      const owners = this.owners, cnt = this.ownerCount;
      owners.length = 0; cnt.length = 0;
      let supported = 0;
      for (let dv = 0; dv < o.sv; dv++)
        for (let du = 0; du < o.su; du++) {
          const i = u + du + W * (v + dv);
          const b = below[i];
          if (b >= 0) {
            supported++;
            const q = owners.indexOf(b);
            if (q < 0) { owners.push(b); cnt.push(1); } else cnt[q]++;
          }
          // seams below inside the footprint (covered = good)
          if (du + 1 < o.su) { const r = below[i + 1]; if (b >= 0 && r >= 0 && b !== r) s += w.cover; }
          if (dv + 1 < o.sv) { const r = below[i + W]; if (b >= 0 && r >= 0 && b !== r) s += w.cover; }
        }
      if (!supported && !this.ground) s -= w.unsupported;
      if (owners.length >= 2) {
        s += w.bridge * Math.min(owners.length - 1, 3);
        const roots = this.roots;
        roots.length = 0;
        for (const b of owners) { const r = this.belowRoot(b); if (!roots.includes(r)) roots.push(r); }
        s += w.join * (roots.length - 1);
      }
      if (owners.length >= 1) {
        let main = 0;
        for (let q = 1; q < owners.length; q++) if (cnt[q] > cnt[main]) main = q;
        const [bu, bv, bsu, bsv] = this.belowDims(owners[main]);
        if (owners.length === 1 && bu === u && bv === v && bsu === o.su && bsv === o.sv) s -= w.stack;
        if (o.su !== o.sv && bsu !== bsv) s += (o.su > o.sv) === (bsu > bsv) ? -w.orient : w.orient;
      }
      // edges of the part that continue a seam below (aligned vertical seam = bad)
      const cells = this.cells;
      const edge = (inside: number, outside: number) => {
        if (cells[outside] === EMPTY) return;
        const a = below[inside], b = below[outside];
        if (a >= 0 && b >= 0 && a !== b) s -= w.align;
      };
      for (let du = 0; du < o.su; du++) {
        if (v > 0) edge(u + du + W * v, u + du + W * (v - 1));
        if (v + o.sv < H) edge(u + du + W * (v + o.sv - 1), u + du + W * (v + o.sv));
      }
      for (let dv = 0; dv < o.sv; dv++) {
        if (u > 0) edge(u + W * (v + dv), u - 1 + W * (v + dv));
        if (u + o.su < W) edge(u + o.su - 1 + W * (v + dv), u + o.su + W * (v + dv));
      }
    }
    this.scoreC[k][idx] = s;
    return s;
  }

  /** Weight of a part in the half objective: centred parts count once in the full layer, mirrored ones twice. */
  weight(k: number, u: number) { return this.p2 === Infinity || !this.crossing(k, u) ? 1 : 0.5; }

  free(k: number, u: number, v: number) {
    const o = this.ori[k], W = this.W;
    for (let dv = 0; dv < o.sv; dv++)
      for (let du = 0; du < o.su; du++) {
        const uu = u + du;
        if (!this.inDomain(uu)) continue;
        if (this.covered[uu + W * (v + dv)]) return false;
      }
    return true;
  }

  private mark(id: number, val: number) {
    const p = this.chosen[id]!, o = this.ori[p.k], W = this.W;
    for (let dv = 0; dv < o.sv; dv++)
      for (let du = 0; du < o.su; du++) {
        const uu = p.u + du;
        if (!this.inDomain(uu)) continue;
        const i = uu + W * (p.v + dv);
        this.covered[i] = val >= 0 ? 1 : 0;
        this.own[i] = val;
      }
  }
  add(p: LayerPart) { const id = this.chosen.push(p) - 1; this.mark(id, id); return id; }
  remove(id: number) { this.mark(id, -1); const p = this.chosen[id]; this.chosen[id] = null; return p!; }
  restore(id: number, p: LayerPart) { this.chosen[id] = p; this.mark(id, id); }

  open(i: number) { return !this.covered[i] && this.cells[i] !== EMPTY; }
  linked(i: number, j: number) { const a = this.cells[i], b = this.cells[j]; return a === ANY || b === ANY || a === b; }

  /** Free, compatible 4-neighbours of a domain cell. */
  degree(i: number) {
    const W = this.W, H = this.H, u = i % W, v = (i - u) / W;
    let n = 0;
    if (u > 0 && this.open(i - 1) && this.linked(i, i - 1)) n++;
    if (u < W - 1 && this.inDomain(u + 1) && this.open(i + 1) && this.linked(i, i + 1)) n++;
    if (v > 0 && this.open(i - W) && this.linked(i, i - W)) n++;
    if (v < H - 1 && this.open(i + W) && this.linked(i, i + W)) n++;
    return n;
  }

  private stranded(U: number, V: number, u: number, v: number, su: number, sv: number): number {
    const W = this.W, H = this.H;
    if (U < 0 || V < 0 || U >= W || V >= H || !this.inDomain(U)) return 0;
    const j = U + W * V;
    if (!this.open(j)) return 0;
    for (let d = 0; d < 4; d++) {
      const X = U + (d === 0 ? 1 : d === 1 ? -1 : 0), Y = V + (d === 2 ? 1 : d === 3 ? -1 : 0);
      if (X < 0 || Y < 0 || X >= W || Y >= H || !this.inDomain(X)) continue;
      if (X >= u && X < u + su && Y >= v && Y < v + sv) continue;
      const q = X + W * Y;
      if (this.open(q) && this.linked(j, q)) return 0;
    }
    return 1;
  }

  /** Greedy fill of the open cells in `todo` (domain cells), most constrained first. Returns the new part ids. */
  fill(todo: number[], noise: number): number[] {
    const added: number[] = [];
    const W = this.W, w = this.w;
    let left = 0;
    for (const i of todo) if (this.open(i)) left++;
    while (left > 0) {
      let seed = -1, best = 9;
      for (const i of todo) {
        if (!this.open(i)) continue;
        const d = this.degree(i);
        if (d < best) { best = d; seed = i; if (d === 0) break; }
      }
      if (seed < 0) break;
      const u0 = seed % W, v0 = (seed - u0) / W;
      let pk = -1, pu = 0, pv = 0, pc = ANY, pScore = -Infinity;
      for (let k = 0; k < this.ori.length; k++) {
        const o = this.ori[k];
        for (let ov = 0; ov < o.sv; ov++)
          for (let ou = 0; ou < o.su; ou++) {
            const u = u0 - ou, v = v0 - ov;
            const c = this.fit(k, u, v);
            if (c === -3 || !this.free(k, u, v)) continue;
            let sc = this.weight(k, u) * this.score(k, u, v);
            if (o.su * o.sv > 1) {
              let st = 0;
              for (let du = 0; du < o.su; du++) st += this.stranded(u + du, v - 1, u, v, o.su, o.sv) + this.stranded(u + du, v + o.sv, u, v, o.su, o.sv);
              for (let dv = 0; dv < o.sv; dv++) st += this.stranded(u - 1, v + dv, u, v, o.su, o.sv) + this.stranded(u + o.su, v + dv, u, v, o.su, o.sv);
              sc -= w.stranded * st;
            }
            if (noise) sc += noise * this.rand();
            if (sc > pScore) { pScore = sc; pk = k; pu = u; pv = v; pc = c; }
          }
      }
      if (pk < 0) { this.covered[seed] = 1; left--; continue; } // cannot happen (a 1x1 always fits); no endless loop
      const o = this.ori[pk];
      for (let dv = 0; dv < o.sv; dv++) for (let du = 0; du < o.su; du++) if (this.inDomain(pu + du)) left--;
      added.push(this.add({ u: pu, v: pv, k: pk, color: pc, w: this.weight(pk, pu), score: this.score(pk, pu, pv) }));
    }
    return added;
  }

  total(ids: number[]) { let s = 0; for (const id of ids) { const p = this.chosen[id]; if (p) s += p.w * p.score; } return s; }

  /** Ruin and recreate: re-tile a small window around a random part, keep it when the score does not drop. */
  improve(iters: number, deadline: number) {
    const W = this.W, H = this.H;
    const todo: number[] = [];
    const ids: number[] = [];
    for (let it = 0; it < iters; it++) {
      if ((it & 15) === 0 && performance.now() > deadline) break;
      let pick = -1;
      for (let tries = 0; tries < 8 && pick < 0; tries++) {
        const id = Math.floor(this.rand() * this.chosen.length);
        if (this.chosen[id]) pick = id;
      }
      if (pick < 0) continue;
      const c = this.chosen[pick]!;
      const o = this.ori[c.k];
      const r = 1 + Math.floor(this.rand() * 2);
      const u0 = Math.max(0, c.u - r), u1 = Math.min(W - 1, c.u + o.su - 1 + r), v0 = Math.max(0, c.v - r), v1 = Math.min(H - 1, c.v + o.sv - 1 + r);
      ids.length = 0;
      for (let v = v0; v <= v1; v++) for (let u = u0; u <= u1; u++) {
        if (!this.inDomain(u)) continue;
        const id = this.own[u + W * v];
        if (id >= 0 && !ids.includes(id)) ids.push(id);
      }
      if (ids.length < 2) continue;
      const before = this.total(ids);
      const removed = ids.map((id) => [id, this.remove(id)] as const);
      todo.length = 0;
      for (const [, p] of removed) {
        const q = this.ori[p.k];
        for (let dv = 0; dv < q.sv; dv++) for (let du = 0; du < q.su; du++) if (this.inDomain(p.u + du)) todo.push(p.u + du + W * (p.v + dv));
      }
      const added = this.fill(todo, this.w.noise);
      if (this.total(added) >= before - 1e-6) continue;
      for (const id of added) this.remove(id);
      for (const [id, p] of removed) this.restore(id, p);
    }
    // compact
    this.chosen = this.chosen.filter((p) => p);
  }
}

/**
 * Coloured voxel cells -> placements with the structure packer. cells: palette index / ANY / EMPTY per voxel
 * (EMPTY where a special part sits; pass those cells as `fixed` pseudo-parts so the layers above see support).
 * The returned list starts with the fixed pseudo-parts.
 */
export function packStructure(g: { nx: number; ny: number; nz: number }, cells: Int16Array, opt: StructureOptions, onProgress?: (f: number) => void): Placement[] {
  const { nx, ny, nz } = g;
  const NL = nx * nz;
  const w: PackWeights = { ...PACK_WEIGHTS, ...opt.weights };
  const T = opt.mirror?.axis === 2; // layer space: u runs along the mirror axis
  const W = T ? nz : nx, H = T ? nx : nz;
  const p2 = opt.mirror ? Math.round(opt.mirror.p * 2) : Infinity;
  const toLayer = (x: number, z: number) => (T ? z + nz * x : x + nx * z);
  const fromLayer = (i: number) => (T ? Math.floor(i / nz) + nx * (i % nz) : i);
  const placements: Placement[] = (opt.fixed ?? []).map((p) => ({ ...p }));
  const owner: Int32Array[] = Array.from({ length: ny }, () => new Int32Array(NL).fill(-1));
  const stamp = (id: number) => {
    const p = placements[id];
    for (let y = p.y; y < p.y + p.h; y++) for (let z = p.z; z < p.z + p.sz; z++) for (let x = p.x; x < p.x + p.sx; x++) owner[y][toLayer(x, z)] = id;
  };
  // stud-connected groups so far (union-find over placements; fixed pseudo-parts of one group are one body)
  const parent: number[] = [];
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
  const groupFirst = new Map<number, number>();
  const connect = (id: number) => {
    parent[id] = id;
    const p = placements[id];
    if (p.group !== undefined) { const f = groupFirst.get(p.group); if (f === undefined) groupFirst.set(p.group, id); else union(id, f); }
    if (p.y > 0) {
      const below = owner[p.y - 1];
      for (let z = p.z; z < p.z + p.sz; z++) for (let x = p.x; x < p.x + p.sx; x++) { const o = below[toLayer(x, z)]; if (o >= 0 && o !== id) union(id, o); }
    }
    if (p.y + p.h < ny) {
      const above = owner[p.y + p.h];
      for (let z = p.z; z < p.z + p.sz; z++) for (let x = p.x; x < p.x + p.sx; x++) { const o = above[toLayer(x, z)]; if (o >= 0 && o !== id) union(id, o); }
    }
  };
  for (let id = 0; id < placements.length; id++) stamp(id);
  for (let id = 0; id < placements.length; id++) connect(id);
  const dims = (o: number): [number, number, number, number] => {
    const p = placements[o];
    return T ? [p.z, p.x, p.sz, p.sx] : [p.x, p.z, p.sx, p.sz];
  };
  const solver = new LayerSolver();
  solver.w = w; solver.rand = prng(opt.seed ?? 12345); solver.belowDims = dims; solver.belowRoot = find;

  const layer = (y: number) => {
    const out = new Int16Array(NL);
    const src = cells.subarray(y * NL, (y + 1) * NL);
    if (!T) out.set(src);
    else for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) out[z + nz * x] = src[x + nx * z];
    return out;
  };
  // ground = lowest layer with anything (cells or special parts)
  let y0 = 0;
  const hasAny = (y: number) => { for (let i = 0; i < NL; i++) if (cells[y * NL + i] !== EMPTY || owner[y][i] >= 0) return true; return false; };
  while (y0 < ny && !hasAny(y0)) y0++;
  let totalCells = 0;
  for (let i = y0 * NL; i < cells.length; i++) if (cells[i] !== EMPTY) totalCells++;
  const t0 = performance.now();
  let doneCells = 0;

  /**
   * Floors / thin slabs: a band of bricks with nothing under it and nothing on it can only touch its neighbours
   * sideways (no studs), so bricks there would be loose. Band cells that are unsupported, uncovered and more than one
   * stud from a supported cell (a straddling brick holds a 1-stud ledge) are left to plates, together with the band
   * cells within 2 studs of them (the anchor zone where the plate layers overlap the walls). Removes them from col.
   */
  const slabCells = (col: Int16Array, y: number, h: number) => {
    const occ = (yy: number, i: number) => yy >= 0 && yy < ny && (cells[yy * NL + fromLayer(i)] !== EMPTY || owner[yy][i] >= 0);
    const dist = new Int16Array(NL).fill(-1);
    let q: number[] = [];
    for (let i = 0; i < NL; i++) if (col[i] !== EMPTY && occ(y - 1, i)) { dist[i] = 0; q.push(i); }
    let any = false;
    for (let i = 0; i < NL && !any; i++) if (col[i] !== EMPTY && dist[i] < 0 && !occ(y + h, i)) any = true;
    if (!any) return;
    const nb = (i: number, f: (j: number) => void) => {
      const u = i % W, v = (i - u) / W;
      for (let dv = -1; dv <= 1; dv++) for (let du = -1; du <= 1; du++) {
        if (!du && !dv) continue;
        const U = u + du, V = v + dv;
        if (U >= 0 && V >= 0 && U < W && V < H) f(U + W * V);
      }
    };
    for (let d = 0; q.length; d++) {
      const next: number[] = [];
      for (const i of q) nb(i, (j) => { if (col[j] !== EMPTY && dist[j] < 0) { dist[j] = d + 1; next.push(j); } });
      q = next;
    }
    const seeds: number[] = [];
    for (let i = 0; i < NL; i++) if (col[i] !== EMPTY && (dist[i] < 0 || dist[i] >= 2) && !occ(y - 1, i) && !occ(y + h, i)) seeds.push(i);
    if (!seeds.length) return;
    const near = new Int8Array(NL).fill(-1);
    q = seeds;
    for (const i of q) near[i] = 0;
    for (let d = 0; d < 2 && q.length; d++) {
      const next: number[] = [];
      for (const i of q) nb(i, (j) => { if (col[j] !== EMPTY && near[j] < 0) { near[j] = d + 1; next.push(j); } });
      q = next;
    }
    for (let i = 0; i < NL; i++) if (near[i] >= 0) col[i] = EMPTY;
  };
  const plateOri = opt.widePlates === false ? NARROW_PLATE_ORI : PLATE_ORI;
  const solve = (lc: Int16Array, y: number, h: number, ori: Ori[]) => {
    let n = 0;
    for (let i = 0; i < NL; i++) if (lc[i] !== EMPTY) n++;
    if (!n) return;
    let above: Uint8Array | null = null;
    if (y + h < ny) {
      above = new Uint8Array(NL);
      const la = layer(y + h);
      for (let i = 0; i < NL; i++) above[i] = la[i] !== EMPTY || owner[y + h][i] >= 0 ? 1 : 0;
    }
    solver.reset(W, H, lc, y > y0 ? owner[y - 1] : null, y === y0, ori, p2, above);
    const todo: number[] = [];
    for (let i = 0; i < NL; i++) if (lc[i] !== EMPTY && solver.inDomain(i % W)) todo.push(i);
    solver.fill(todo, 0);
    doneCells += n * h;
    // budget: this layer's share of the time, never past the global cap
    const deadline = t0 + Math.min(opt.budgetMs, (opt.budgetMs * doneCells) / Math.max(1, totalCells));
    if (opt.effort > 0) solver.improve(Math.round(opt.effort * todo.length), deadline);
    for (const p of solver.chosen) {
      if (!p) continue;
      const o = ori[p.k];
      const emit = (u: number) => {
        const [x, z, sx, sz] = T ? [p.v, u, o.sv, o.su] : [u, p.v, o.su, o.sv];
        placements.push({ part: o.part, x, z, sx, sz, y, h, color: p.color });
        stamp(placements.length - 1);
        connect(placements.length - 1);
      };
      emit(p.u);
      if (p2 !== Infinity && !solver.crossing(p.k, p.u)) emit(p2 - p.u - o.su);
    }
  };

  for (let y = y0; y < ny; ) {
    onProgress?.((y - y0) / Math.max(1, ny - y0));
    if (opt.useBricks && y + 2 < ny && y >= y0 + (opt.base ?? 0)) {
      const ls = [layer(y), layer(y + 1), layer(y + 2)];
      for (let k = 0; k < 3; k++) for (let i = 0; i < NL; i++) if (owner[y + k][i] >= 0) ls[k][i] = EMPTY;
      const col = new Int16Array(NL);
      for (let i = 0; i < NL; i++) col[i] = combine(combine(ls[0][i], ls[1][i]), ls[2][i]);
      if (opt.slabPlates && y > y0) slabCells(col, y, 3);
      solve(col, y, 3, BRICK_ORI);
      for (let k = 0; k < 3; k++) {
        const rest = ls[k];
        for (let i = 0; i < NL; i++) if (owner[y + k][i] >= 0) rest[i] = EMPTY;
        solve(rest, y + k, 1, plateOri);
      }
      y += 3;
    } else {
      const l = layer(y);
      for (let i = 0; i < NL; i++) if (owner[y][i] >= 0) l[i] = EMPTY;
      solve(l, y, 1, plateOri);
      y++;
    }
  }
  return placements;
}

/**
 * Make a layout mirror-symmetric again after asymmetric steps (connectivity repair): keep the parts on the low side
 * of the plane and the parts centred on it, mirror the low side, and re-pack the cells left over (from parts that
 * crossed the plane off-centre) with the symmetric packer. Fixed pseudo-parts are kept as they are.
 */
export function mirrorLayout(g: { nx: number; ny: number; nz: number }, cells: Int16Array, ps: Placement[], plane: { axis: 0 | 2; p: number }, opt: Omit<StructureOptions, 'mirror' | 'fixed'>, side: 'low' | 'high' = 'low'): Placement[] {
  const { nx, nz } = g;
  const p2 = Math.round(plane.p * 2);
  const X = plane.axis === 0;
  const lo = side === 'low'
    ? (p: Placement) => 2 * (X ? p.x + p.sx : p.z + p.sz) <= p2
    : (p: Placement) => 2 * (X ? p.x : p.z) >= p2;
  const centred = (p: Placement) => (X ? 2 * p.x + p.sx : 2 * p.z + p.sz) === p2;
  const fixed = ps.filter((p) => p.fixed);
  const NL = nx * nz;
  const was = new Uint8Array(cells.length), now = new Uint8Array(cells.length);
  const mark = (arr: Uint8Array, p: Placement) => { for (let y = p.y; y < p.y + p.h; y++) for (let z = p.z; z < p.z + p.sz; z++) for (let x = p.x; x < p.x + p.sx; x++) arr[y * NL + x + nx * z] = 1; };
  const within = (p: Placement) => { for (let y = p.y; y < p.y + p.h; y++) for (let z = p.z; z < p.z + p.sz; z++) for (let x = p.x; x < p.x + p.sx; x++) if (x < 0 || z < 0 || x >= nx || z >= nz || !was[y * NL + x + nx * z]) return false; return true; };
  for (const p of ps) if (!p.fixed) mark(was, p);
  const keep: Placement[] = [];
  for (const p of ps) {
    if (p.fixed) continue;
    if (centred(p)) keep.push(p);
    else if (lo(p)) {
      keep.push(p);
      // the mirror image only where parts were before (never into special parts' cells or air)
      const q = X ? { ...p, x: p2 - p.x - p.sx } : { ...p, z: p2 - p.z - p.sz };
      if (within(q)) keep.push(q);
    }
  }
  for (const p of keep) mark(now, p);
  const rest = new Int16Array(cells.length).fill(EMPTY);
  let n = 0;
  for (let i = 0; i < cells.length; i++) if (was[i] && !now[i]) { rest[i] = cells[i] === EMPTY ? ANY : cells[i]; n++; }
  if (!n) return [...fixed, ...keep];
  const support = [...fixed, ...keep].map((p) => ({ ...p, fixed: true }));
  // the leftover is symmetric unless some mirror images were refused: then pack it without the mirror
  let symmetric = true;
  for (let i = 0; i < rest.length && symmetric; i++) {
    if (rest[i] === EMPTY) continue;
    const x = i % nx, z = Math.floor(i / nx) % nz;
    const Xm = X ? p2 - 1 - x : x, Zm = X ? z : p2 - 1 - z;
    if (Xm < 0 || Zm < 0 || Xm >= nx || Zm >= nz || rest[i + (Xm - x) + nx * (Zm - z)] === EMPTY) symmetric = false;
  }
  const packed = packStructure(g, rest, { ...opt, mirror: symmetric ? plane : null, fixed: support });
  return [...fixed, ...keep, ...packed.slice(support.length)];
}
