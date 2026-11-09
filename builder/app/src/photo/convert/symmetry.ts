// Mirror symmetry for Photo to Bricks (structure workstream, contracts.ts). A real LEGO set is symmetric where the
// object is: the AI mesh never is exactly. detectSymmetry() finds the dominant mirror plane(s) on the coloured voxel
// grid (planes across X and Z through every candidate centre, cell centres and cell boundaries, scored on shape +
// colour agreement, with the vision analysis as a prior); symmetrize() then makes shape and colours exactly
// symmetric. Because one voxel = one stud, every candidate plane lies on the stud grid: a plane on a cell boundary
// (integer p) = even model width, through a stud; a plane through a cell centre (p = k + 0.5) = odd width.
// Pure TS, O(voxels) per candidate.

import type { DetailLevel } from '../types';
import type { PhotoAnalysis } from './contracts';
import { type VoxelGrid, floodOutside } from './voxelize';

const EMPTY = -2, ANY = -1; // same values as bricks.ts (not imported to keep this module dependency-free)

/** Mirror plane: axis 0 = X (mirror x), 2 = Z. `p` is in cell-boundary coordinates: cell i maps to 2p - 1 - i. */
export interface MirrorPlane {
  axis: 0 | 2;
  p: number;
  /** Shape IoU of the solid with its mirror image (0-1). */
  shape: number;
  /** Share of mirrored visible voxel pairs with the same colour (0-1, NaN if none). */
  colour: number;
  /** Combined score used against the threshold. */
  score: number;
  /** True when the vision analysis asked for this axis. */
  prior: boolean;
}

export interface SymmetryOptions {
  detail: DetailLevel;
  analysis?: PhotoAnalysis;
  /** Score needed without a prior (default per detail level). */
  threshold?: number;
}

/** Score thresholds without a vision prior, per detail level (owner priority: symmetric beats faithful). */
export const SYMMETRY_THRESHOLD: Record<DetailLevel, number> = { simple: 0.7, balanced: 0.76, detailed: 0.84 };
/** Threshold when the vision analysis says the object is symmetric across that axis. */
const PRIOR_THRESHOLD = 0.5;
/**
 * Bonus for a plane on a stud boundary (even width): the centre line can then take any centred even-length part,
 * while a plane through a stud row (odd width) needs 1-wide or 3-long parts there. (env override for research)
 */
const EVEN_BIAS = 0.01;
/** Threshold when the vision analysis says 'none'. */
const NONE_THRESHOLD = 0.9;

const mirrorIndex = (g: VoxelGrid, i: number, axis: 0 | 2, p2: number): number => {
  const { nx, nz } = g;
  const x = i % nx, z = Math.floor(i / nx) % nz, y = Math.floor(i / (nx * nz));
  if (axis === 0) { const X = p2 - 1 - x; return X < 0 || X >= nx ? -1 : X + nx * (z + nz * y); }
  const Z = p2 - 1 - z;
  return Z < 0 || Z >= nz ? -1 : x + nx * (Z + nz * y);
};

/** Score one candidate plane (p2 = 2p, an integer). */
function scorePlane(g: VoxelGrid, cells: Int16Array, solidList: Int32Array, axis: 0 | 2, p2: number) {
  const { solid, visible } = g;
  let inter = 0, agree = 0, compared = 0;
  for (let k = 0; k < solidList.length; k++) {
    const i = solidList[k];
    const j = mirrorIndex(g, i, axis, p2);
    if (j < 0 || !solid[j]) continue;
    inter++;
    if (visible[i] && visible[j] && cells[i] >= 0 && cells[j] >= 0) { compared++; if (cells[i] === cells[j]) agree++; }
  }
  const n = solidList.length;
  const shape = n ? inter / (2 * n - inter) : 0;
  const colour = compared ? agree / compared : NaN;
  return { shape, colour, score: Number.isFinite(colour) ? 0.75 * shape + 0.25 * colour : shape };
}

/**
 * Best mirror plane per axis (X and Z), each with its score; `accepted` lists the planes to apply (score above the
 * threshold, or the analysis asked for the axis), best first.
 */
export function detectSymmetry(g: VoxelGrid, cells: Int16Array, o: SymmetryOptions): { best: MirrorPlane[]; accepted: MirrorPlane[] } {
  const { nx, ny, nz, solid } = g;
  let n = 0;
  for (let i = 0; i < solid.length; i++) n += solid[i];
  const solidList = new Int32Array(n);
  let x0 = nx, x1 = -1, z0 = nz, z1 = -1;
  for (let y = 0, i = 0, k = 0; y < ny; y++)
    for (let z = 0; z < nz; z++)
      for (let x = 0; x < nx; x++, i++) {
        if (!solid[i]) continue;
        solidList[k++] = i;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z;
      }
  if (!n) return { best: [], accepted: [] };
  const sym = o.analysis?.symmetry;
  const priorAxis = (axis: 0 | 2) => sym === 'both' || sym === 'radial' || (axis === 0 ? sym === 'left-right' : sym === 'front-back');
  const best: MirrorPlane[] = [];
  for (const axis of [0, 2] as const) {
    const lo = axis === 0 ? x0 : z0, hi = axis === 0 ? x1 : z1, len = axis === 0 ? nx : nz;
    const c2 = lo + hi + 1; // 2 * centre of the bbox in boundary coordinates
    const R2 = 2 * Math.max(1, Math.round(0.1 * (hi - lo + 1))); // search +-10% of the extent, in half cells
    let top: MirrorPlane | null = null;
    for (let p2 = c2 - R2; p2 <= c2 + R2; p2++) {
      // the mirrored bbox must stay inside the grid
      if (p2 - 1 - lo > len - 1 || p2 - 1 - hi < 0) continue;
      const s = scorePlane(g, cells, solidList, axis, p2);
      // prefer the bbox centre slightly on ties (fewer voxels change)
      const sc = s.score - 0.002 * Math.abs(p2 - c2) + (p2 % 2 === 0 ? EVEN_BIAS : 0);
      if (!top || sc > top.score) top = { axis, p: p2 / 2, shape: s.shape, colour: s.colour, score: sc, prior: priorAxis(axis) };
    }
    if (top) best.push(top);
  }
  const base = o.threshold ?? SYMMETRY_THRESHOLD[o.detail];
  const accepted = best
    .filter((m) => m.score >= (m.prior ? PRIOR_THRESHOLD : sym === 'none' ? NONE_THRESHOLD : base))
    .sort((a, b) => Number(b.prior) - Number(a.prior) || b.score - a.score);
  return { best, accepted };
}

export type SymmetrizeShape = 'union' | 'majority';

/**
 * Make the grid exactly symmetric about `m`: shape by union (every voxel present on either side) or majority (a
 * voxel present on one side only stays when its neighbourhood on both sides is mostly solid), then colours of mirrored
 * visible pairs by a neighbourhood vote over both sides, ties to the dominant side (front = +Z for a Z plane, the
 * side with more coloured surface for an X plane). Updates solid, visible and cells. Returns the voxels changed.
 */
export function symmetrize(g: VoxelGrid, cells: Int16Array, m: MirrorPlane, shape: SymmetrizeShape): number {
  const { nx, ny, nz, solid, visible } = g;
  const N = solid.length, NL = nx * nz;
  const p2 = Math.round(m.p * 2);
  const axis = m.axis;
  const coord = (i: number) => (axis === 0 ? i % nx : Math.floor(i / nx) % nz);
  const dominantHigh = dominantSide(g, cells, m);
  // ---- shape
  const before = solid.slice();
  let changed = 0;
  const n6 = (i: number) => {
    const x = i % nx, z = Math.floor(i / nx) % nz, y = Math.floor(i / NL);
    return (x > 0 ? before[i - 1] : 0) + (x < nx - 1 ? before[i + 1] : 0) + (z > 0 ? before[i - nx] : 0) + (z < nz - 1 ? before[i + nx] : 0) +
      (y > 0 ? before[i - NL] : 0) + (y < ny - 1 ? before[i + NL] : 0);
  };
  for (let i = 0; i < N; i++) {
    if (2 * coord(i) + 1 >= p2) continue; // visit each pair once from the low side (cells on the plane map to themselves)
    const j = mirrorIndex(g, i, axis, p2);
    const a = before[i], b = j >= 0 ? before[j] : 0;
    if (a === b) continue;
    let v: number;
    if (shape === 'union') v = 1;
    else v = n6(i) + (j >= 0 ? n6(j) : 0) >= 7 ? 1 : 0;
    if (j < 0) { if (!v && a) { solid[i] = 0; changed++; } continue; }
    if (solid[i] !== v) { solid[i] = v; changed++; }
    if (solid[j] !== v) { solid[j] = v; changed++; }
  }
  // ---- visibility over the new shape
  const outside = floodOutside(solid, nx, ny, nz);
  for (let y = 0, i = 0; y < ny; y++)
    for (let z = 0; z < nz; z++)
      for (let x = 0; x < nx; x++, i++) {
        visible[i] = 0;
        if (!solid[i]) { cells[i] = EMPTY; continue; }
        if (x === 0 || y === 0 || z === 0 || x === nx - 1 || y === ny - 1 || z === nz - 1 ||
          outside[i - 1] || outside[i + 1] || outside[i - nx] || outside[i + nx] || outside[i - NL] || outside[i + NL]) visible[i] = 1;
      }
  // ---- colours: hidden -> ANY; newly visible / new voxels take the mirror's colour when it has one
  const old = cells.slice();
  for (let i = 0; i < N; i++) {
    if (!solid[i]) continue;
    if (!visible[i]) { cells[i] = ANY; continue; }
    if (old[i] >= 0) continue;
    const j = mirrorIndex(g, i, axis, p2);
    cells[i] = j >= 0 && old[j] >= 0 ? old[j] : ANY;
  }
  // visible voxels still without a colour: nearest coloured visible voxel (BFS over solid)
  let queue: number[] = [];
  const done = new Uint8Array(N);
  let missing = 0;
  for (let i = 0; i < N; i++) if (solid[i] && cells[i] >= 0) { done[i] = 1; queue.push(i); } else if (visible[i]) missing++;
  while (missing && queue.length) {
    const next: number[] = [];
    for (const i of queue) {
      const x = i % nx, z = Math.floor(i / nx) % nz, y = Math.floor(i / NL);
      const nb = [x > 0 ? i - 1 : -1, x < nx - 1 ? i + 1 : -1, z > 0 ? i - nx : -1, z < nz - 1 ? i + nx : -1, y > 0 ? i - NL : -1, y < ny - 1 ? i + NL : -1];
      for (const j of nb) {
        if (j < 0 || !solid[j] || done[j]) continue;
        done[j] = 1;
        if (visible[j]) { cells[j] = cells[i]; missing--; }
        next.push(j);
      }
    }
    queue = next;
  }
  // new voxels have no sampled colour yet: copy the mirror's
  const rgb = g.rgb;
  for (let i = 0; i < N; i++) {
    if (!solid[i] || before[i]) continue;
    const j = mirrorIndex(g, i, axis, p2);
    if (j >= 0) { rgb[i * 3] = rgb[j * 3]; rgb[i * 3 + 1] = rgb[j * 3 + 1]; rgb[i * 3 + 2] = rgb[j * 3 + 2]; }
  }
  changed += voteColours(g, cells, m, dominantHigh);
  return changed;
}

/** Which side of the plane wins colour ties: the front (+Z) for a Z plane, else the side with more coloured surface. */
export function dominantSide(g: VoxelGrid, cells: Int16Array, m: { axis: 0 | 2; p: number }): boolean {
  if (m.axis === 2) return true;
  const p2 = Math.round(m.p * 2);
  let lo = 0, hi = 0;
  for (let i = 0; i < cells.length; i++) {
    if (!g.visible[i] || cells[i] < 0) continue;
    const c = 2 * (i % g.nx) + 1;
    if (c < p2) lo++; else if (c > p2) hi++;
  }
  return hi > lo;
}

/**
 * Colours of mirrored visible pairs that disagree take the majority colour of the two 3x3x3 neighbourhoods (both
 * sides), ties to the dominant side; the sampled rgb of each pair is made symmetric too (the winner's rgb, or the mean
 * when they agree), so later colour passes that re-match from rgb keep the symmetry. Returns the pairs recoloured.
 */
export function voteColours(g: VoxelGrid, cells: Int16Array, m: { axis: 0 | 2; p: number }, dominantHigh = dominantSide(g, cells, m)): number {
  const { nx, ny, nz, solid, visible, rgb } = g;
  const N = solid.length;
  const p2 = Math.round(m.p * 2);
  const axis = m.axis;
  const coord = (i: number) => (axis === 0 ? i % nx : Math.floor(i / nx) % nz);
  const snap = cells.slice();
  const count = new Map<number, number>();
  const tally = (i: number) => {
    const x = i % nx, z = Math.floor(i / nx) % nz, y = Math.floor(i / (nx * nz));
    for (let dy = -1; dy <= 1; dy++) {
      const Y = y + dy;
      if (Y < 0 || Y >= ny) continue;
      for (let dz = -1; dz <= 1; dz++) {
        const Z = z + dz;
        if (Z < 0 || Z >= nz) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const X = x + dx;
          if (X < 0 || X >= nx) continue;
          const k = X + nx * (Z + nz * Y);
          if (!visible[k] || snap[k] < 0) continue;
          count.set(snap[k], (count.get(snap[k]) ?? 0) + (dx || dy || dz ? 1 : 2));
        }
      }
    }
  };
  const copy = (from: number, to: number) => { rgb[to * 3] = rgb[from * 3]; rgb[to * 3 + 1] = rgb[from * 3 + 1]; rgb[to * 3 + 2] = rgb[from * 3 + 2]; };
  let changed = 0;
  for (let i = 0; i < N; i++) {
    if (!solid[i] || 2 * coord(i) + 1 >= p2) continue;
    const j = mirrorIndex(g, i, axis, p2);
    if (j < 0 || !solid[j]) continue;
    const a = snap[i], b = snap[j];
    let win: number;
    if (a === b) win = a;
    else if (a < 0 || b < 0) win = a < 0 ? b : a;
    else {
      count.clear();
      tally(i); tally(j);
      win = dominantHigh ? b : a;
      let winN = count.get(win) ?? 0;
      for (const [c, k] of count) if (k > winN) { winN = k; win = c; }
    }
    if (a !== b) changed++;
    // rgb: the side that had the winning colour (dominant side on ties), or the mean
    if (a === win && b !== win) copy(i, j);
    else if (b === win && a !== win) copy(j, i);
    else {
      for (let k = 0; k < 3; k++) { const v = (rgb[i * 3 + k] + rgb[j * 3 + k]) / 2; rgb[i * 3 + k] = v; rgb[j * 3 + k] = v; }
    }
    if (visible[i]) cells[i] = win >= 0 || !visible[j] ? win : cells[i];
    if (visible[j]) cells[j] = win >= 0 || !visible[i] ? win : cells[j];
    if (visible[i] && visible[j] && cells[i] !== cells[j]) cells[j] = cells[i];
  }
  return changed;
}

/** Mirror symmetry of a cell array about a plane (diagnostics / tests): shape IoU and colour agreement. */
export function mirrorScore(g: VoxelGrid, cells: Int16Array, m: { axis: 0 | 2; p: number }) {
  const list: number[] = [];
  for (let i = 0; i < g.solid.length; i++) if (g.solid[i]) list.push(i);
  return scorePlane(g, cells, Int32Array.from(list), m.axis, Math.round(m.p * 2));
}
