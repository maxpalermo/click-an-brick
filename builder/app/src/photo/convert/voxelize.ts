// Mesh -> anisotropic voxel grid in LDraw units: one voxel = 1 stud x 1 plate x 1 stud (20 x 8 x 20 LDU).
// Internal frame: x right, y UP (layer index from the bottom), z = glTF z. Converted to LDraw (-Y up) in
// bricks.ts. Ported from research/photo2brick/src/voxelize.ts, with the hot loops made allocation-free.

import type { TriangleMesh } from './mesh';
import { SRGB8_TO_LINEAR } from './color';

export const STUD = 20;
export const PLATE_H = 8;
const MAX_SAMPLES = 12;

export interface VoxelOptions {
  /** Scale, LDU per model unit. */
  scale: number;
  /**
   * Lattice phase in LDU per axis: voxel boundaries sit at bboxMin + k * cell - phase. 0 = boundaries start
   * at the bbox min. Used by LEGO-build mode (phase fit, §6B / §7).
   */
  phase: [number, number, number];
  /** Hollow shell thickness in studs (horizontal); 0 = solid. Vertical thickness = round(2.5 * t) plates. */
  hollow: number;
  /** Morphological closing radius used only for inside/outside, to tolerate small mesh holes. */
  closeHoles: number;
  /**
   * LEGO-build mode snap tolerance in LDU (0 = off, object mode): geometry within it of a lattice plane is
   * treated as lying on that plane (faces nudged inward, large triangles inset in-plane).
   */
  snap?: number;
  /** Research only: the original sampler (first 32 hits per voxel in index order), for before/after comparisons. */
  legacySampling?: boolean;
  /**
   * Keep real recesses that the hole closing would fill and drop enclosed clutter (default false; the pipeline turns it
   * on for architecture): open-to-sky depressions (a walkway behind
   * battlements, crenels, a courtyard) and dark wall recesses at least one brick tall (window / door openings).
   * See restoreRecesses.
   */
  keepRecesses?: boolean;
  /**
   * Also keep dark side recesses (window / door openings) as air: architecture only. A vehicle's dark recesses are
   * glass or wheel wells that a builder fills (the LEGO ground truths are solid there).
   */
  sideRecesses?: boolean;
  onProgress?: (fraction: number) => void;
}

export interface VoxelGrid {
  nx: number; ny: number; nz: number;
  /** 1 = solid voxel. index = x + nx * (z + nz * y). */
  solid: Uint8Array;
  /** 1 = solid and face-adjacent to the outside (needs a real colour). */
  visible: Uint8Array;
  /** Linear RGB per voxel (meaningful where visible). */
  rgb: Float32Array;
  /** LDU size of the scaled model. */
  sizeLdu: [number, number, number];
  /**
   * 1 = a real recess the hole closing would have filled (kept as air, see restoreRecesses). Shape smoothing must not
   * fill these cells again. Absent when nothing was restored.
   */
  recess?: Uint8Array;
}

export const vidx = (g: { nx: number; nz: number }, x: number, y: number, z: number) => x + g.nx * (z + g.nz * y);

/** Bounding box of the positions. */
export function bbox(P: Float32Array): { min: [number, number, number]; max: [number, number, number] } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity], max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < P.length; i += 3)
    for (let k = 0; k < 3; k++) { const v = P[i + k]; if (v < min[k]) min[k] = v; if (v > max[k]) max[k] = v; }
  return { min, max };
}

export function voxelize(mesh: TriangleMesh, opt: VoxelOptions): VoxelGrid {
  const P = mesh.positions;
  const { min, max } = bbox(P);
  const ext = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const s = opt.scale;
  const cell = [STUD, PLATE_H, STUD];
  const pad = 1 + opt.closeHoles;
  const phase = opt.phase.map((p, k) => ((p % cell[k]) + cell[k]) % cell[k]);
  const dims = [0, 1, 2].map((k) => Math.max(1, Math.ceil((ext[k] * s + phase[k]) / cell[k] - 1e-6)) + 2 * pad);
  const [nx, ny, nz] = dims;
  const N = nx * ny * nz;
  if (N > 64e6) throw new Error('model too large for the voxel grid');
  // vertex -> LDU, with padding so voxel (pad, pad, pad) starts at the bbox min (minus the phase)
  const L = new Float32Array(P.length);
  for (let i = 0; i < P.length; i += 3)
    for (let k = 0; k < 3; k++) L[i + k] = (P[i + k] - min[k]) * s + phase[k] + pad * cell[k];

  const surface = new Uint8Array(N);
  const acc = new Float32Array(N * 4); // r,g,b,weight
  /**
   * Triangle hits per voxel. Past MAX_SAMPLES a hit is sampled with probability MAX_SAMPLES / n and weighted by
   * n / MAX_SAMPLES, so dense meshes cost ~MAX_SAMPLES * ln(n / MAX_SAMPLES) samples per voxel and the colour is not
   * biased towards the triangles that come first in the index buffer (inner faces of some AI meshes did that at
   * small sizes).
   */
  const nHits = new Uint32Array(N);

  const I = mesh.indices, C = mesh.colors, UV = mesh.uvs;
  const nt = I.length / 3;
  const snap = opt.snap ?? 0;
  const legacy = opt.legacySampling === true;
  const nudge = snap > 0 ? snap : 0.05;
  const HX = STUD / 2 - 0.01, HY = PLATE_H / 2 - 0.01, HZ = STUD / 2 - 0.01;
  const tri = new Float64Array(9);
  const bary = new Float64Array(4);
  const step = Math.max(1, Math.floor(nt / 50));
  for (let t = 0; t < nt; t++) {
    if (opt.onProgress && t % step === 0) opt.onProgress(t / nt);
    const ia = I[t * 3], ib = I[t * 3 + 1], ic = I[t * 3 + 2];
    let ax = L[ia * 3], ay = L[ia * 3 + 1], az = L[ia * 3 + 2];
    let bx = L[ib * 3], by = L[ib * 3 + 1], bz = L[ib * 3 + 2];
    let cx = L[ic * 3], cy = L[ic * 3 + 1], cz = L[ic * 3 + 2];
    // Nudge the triangle against its (CCW = outward) normal: a face lying exactly on a lattice plane lands in
    // the voxel on its inner side instead of in both neighbours; boxes are shrunk by 0.01 LDU so edges lying on
    // lattice lines do not touch the outer voxels.
    const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
    const n0 = uy * vz - uz * vy, n1 = uz * vx - ux * vz, n2 = ux * vy - uy * vx;
    const len = Math.hypot(n0, n1, n2); // = 2 * area
    if (len > 0) {
      const k = nudge / len, d0 = k * n0, d1 = k * n1, d2 = k * n2;
      ax -= d0; bx -= d0; cx -= d0; ay -= d1; by -= d1; cy -= d1; az -= d2; bz -= d2; cz -= d2;
    }
    let centroidOnly = false;
    if (snap > 0) {
      // LEGO-build mode: geometry within `snap` LDU of a lattice plane snaps to it. Large triangles are inset
      // in-plane by `snap` (homothety about the incentre), small ones only mark the voxel of their centroid.
      const la = Math.hypot(cx - bx, cy - by, cz - bz), lb = Math.hypot(ax - cx, ay - cy, az - cz), lc = Math.hypot(bx - ax, by - ay, bz - az);
      const per = la + lb + lc;
      const r = per > 0 ? len / per : 0; // inradius = 2 * area / perimeter
      if (r >= 2 * snap) {
        const k = (r - snap) / r;
        const qx = (ax * la + bx * lb + cx * lc) / per, qy = (ay * la + by * lb + cy * lc) / per, qz = (az * la + bz * lb + cz * lc) / per;
        ax = qx + k * (ax - qx); ay = qy + k * (ay - qy); az = qz + k * (az - qz);
        bx = qx + k * (bx - qx); by = qy + k * (by - qy); bz = qz + k * (bz - qz);
        cx = qx + k * (cx - qx); cy = qy + k * (cy - qy); cz = qz + k * (cz - qz);
      } else centroidOnly = true;
    }
    tri[0] = ax; tri[1] = ay; tri[2] = az; tri[3] = bx; tri[4] = by; tri[5] = bz; tri[6] = cx; tri[7] = cy; tri[8] = cz;
    let x0: number, x1: number, y0: number, y1: number, z0: number, z1: number;
    if (centroidOnly) {
      x0 = x1 = Math.min(nx - 1, Math.max(0, Math.floor((ax + bx + cx) / 3 / STUD)));
      y0 = y1 = Math.min(ny - 1, Math.max(0, Math.floor((ay + by + cy) / 3 / PLATE_H)));
      z0 = z1 = Math.min(nz - 1, Math.max(0, Math.floor((az + bz + cz) / 3 / STUD)));
    } else {
      x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx) / STUD)); x1 = Math.min(nx - 1, Math.floor(Math.max(ax, bx, cx) / STUD));
      y0 = Math.max(0, Math.floor(Math.min(ay, by, cy) / PLATE_H)); y1 = Math.min(ny - 1, Math.floor(Math.max(ay, by, cy) / PLATE_H));
      z0 = Math.max(0, Math.floor(Math.min(az, bz, cz) / STUD)); z1 = Math.min(nz - 1, Math.floor(Math.max(az, bz, cz) / STUD));
    }
    const mat = mesh.materials[mesh.triMaterial[t]];
    const f = mat.baseColorFactor, T = mat.texture;
    const single = x0 === x1 && y0 === y1 && z0 === z1;
    for (let y = y0; y <= y1; y++)
      for (let z = z0; z <= z1; z++)
        for (let x = x0; x <= x1; x++) {
          const px = (x + 0.5) * STUD, py = (y + 0.5) * PLATE_H, pz = (z + 0.5) * STUD;
          // a triangle whose bbox lies inside one voxel always overlaps it
          if (!single && !triBoxOverlap(px, py, pz, HX, HY, HZ, tri)) continue;
          const i = x + nx * (z + nz * y);
          surface[i] = 1;
          const hits = ++nHits[i];
          let mult = 1;
          if (legacy) { if (hits > 32) continue; } else if (hits > MAX_SAMPLES) {
            // deterministic hash of (triangle, voxel) -> [0, 1)
            let h = Math.imul(t ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(i, 0xc2b2ae35);
            h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12;
            if ((h >>> 0) / 4294967296 >= MAX_SAMPLES / hits) continue;
            mult = hits / MAX_SAMPLES;
          }
          closestBary(px, py, pz, tri, bary);
          const u = bary[0], v = bary[1], w = bary[2];
          let r = f[0], g = f[1], b = f[2];
          if (C) {
            r *= C[ia * 4] * u + C[ib * 4] * v + C[ic * 4] * w;
            g *= C[ia * 4 + 1] * u + C[ib * 4 + 1] * v + C[ic * 4 + 1] * w;
            b *= C[ia * 4 + 2] * u + C[ib * 4 + 2] * v + C[ic * 4 + 2] * w;
          }
          if (T && UV) {
            let ss = UV[ia * 2] * u + UV[ib * 2] * v + UV[ic * 2] * w;
            let tt = UV[ia * 2 + 1] * u + UV[ib * 2 + 1] * v + UV[ic * 2 + 1] * w;
            ss -= Math.floor(ss); tt -= Math.floor(tt); // REPEAT wrap
            const tx = Math.min(T.width - 1, Math.floor(ss * T.width)), ty = Math.min(T.height - 1, Math.floor(tt * T.height));
            const o = (ty * T.width + tx) * 4;
            r *= SRGB8_TO_LINEAR[T.data[o]]; g *= SRGB8_TO_LINEAR[T.data[o + 1]]; b *= SRGB8_TO_LINEAR[T.data[o + 2]];
          }
          const wt = mult / (1 + Math.sqrt(bary[3]));
          acc[i * 4] += r * wt; acc[i * 4 + 1] += g * wt; acc[i * 4 + 2] += b * wt; acc[i * 4 + 3] += wt;
        }
  }

  // inside/outside: flood the outside on a dilated surface, then dilate the outside back (= closing)
  let barrier: Uint8Array = surface;
  for (let r = 0; r < opt.closeHoles; r++) barrier = dilate(barrier, nx, ny, nz, 1, 1, 1);
  let outside: Uint8Array = floodOutside(barrier, nx, ny, nz);
  for (let r = 0; r < opt.closeHoles; r++) outside = dilate(outside, nx, ny, nz, 1, 1, 1);
  const solid = new Uint8Array(N);
  for (let i = 0; i < N; i++) solid[i] = surface[i] || !outside[i] ? 1 : 0;
  let recess = opt.closeHoles > 0 && opt.keepRecesses === true ? restoreRecesses(surface, solid, acc, nx, ny, nz, opt.sideRecesses === true) : null;
  if (opt.keepRecesses === true) recess = removeClutter(solid, nx, ny, nz, recess);
  // true outside = flood over the final solid (cavities sealed by closing stay inside)
  outside = floodOutside(solid, nx, ny, nz);

  if (opt.hollow > 0) {
    const t = opt.hollow;
    const near = dilate(outside, nx, ny, nz, t, Math.round(2.5 * t), t);
    for (let i = 0; i < N; i++) if (!near[i]) solid[i] = 0;
  }

  const visible = new Uint8Array(N);
  const NL = nx * nz;
  for (let y = 0, i = 0; y < ny; y++)
    for (let z = 0; z < nz; z++)
      for (let x = 0; x < nx; x++, i++) {
        if (!solid[i]) continue;
        if (x === 0 || y === 0 || z === 0 || x === nx - 1 || y === ny - 1 || z === nz - 1 ||
          outside[i - 1] || outside[i + 1] || outside[i - nx] || outside[i + nx] || outside[i - NL] || outside[i + NL]) visible[i] = 1;
      }

  // colour: average samples; voxels without samples (closing fill) take the nearest sampled colour (BFS)
  const rgb = new Float32Array(N * 3);
  const done = new Uint8Array(N);
  let queue: number[] = [];
  for (let i = 0; i < N; i++)
    if (solid[i] && acc[i * 4 + 3] > 0) {
      const w = acc[i * 4 + 3];
      rgb[i * 3] = acc[i * 4] / w; rgb[i * 3 + 1] = acc[i * 4 + 1] / w; rgb[i * 3 + 2] = acc[i * 4 + 2] / w;
      done[i] = 1; queue.push(i);
    }
  while (queue.length) {
    const next: number[] = [];
    for (const i of queue) {
      const x = i % nx, z = Math.floor(i / nx) % nz, y = Math.floor(i / NL);
      for (let k = 0; k < 6; k++) {
        const [dx, dy, dz] = N6[k];
        const X = x + dx, Y = y + dy, Z = z + dz;
        if (X < 0 || Y < 0 || Z < 0 || X >= nx || Y >= ny || Z >= nz) continue;
        const j = X + nx * (Z + nz * Y);
        if (!solid[j] || done[j]) continue;
        rgb[j * 3] = rgb[i * 3]; rgb[j * 3 + 1] = rgb[i * 3 + 1]; rgb[j * 3 + 2] = rgb[i * 3 + 2];
        done[j] = 1; next.push(j);
      }
    }
    queue = next;
  }
  opt.onProgress?.(1);
  return { nx, ny, nz, solid, visible, rgb, sizeLdu: [ext[0] * s, ext[1] * s, ext[2] * s], ...(recess ? { recess } : {}) };
}

/** Clutter: per layer at most this many cells, in all at most this many voxels. */
const CLUTTER_CELLS = 4, CLUTTER_VOXELS = 60;

/**
 * Clutter inside an enclosure (AI-mesh debris on a walkway behind battlements, in a courtyard or a sealed room): a
 * thin object whose every layer is a small in-layer component (<= CLUTTER_CELLS, 8-connected) with only enclosed air
 * around it (solid further on along both directions of both axes) would become a forest of 1x1 bricks. Such cells are
 * flagged per layer, grouped in 3D, and groups of at most CLUTTER_VOXELS go. Merlons, mullions and other silhouette
 * details have open air on one side and stay. The removed cells join the recess mask (they must stay air).
 */
function removeClutter(solid: Uint8Array, nx: number, ny: number, nz: number, recess: Uint8Array | null): Uint8Array | null {
  const NL = nx * nz, N = solid.length;
  const flag = new Uint8Array(N);
  const rowLo = new Int32Array(nz), rowHi = new Int32Array(nz), colLo = new Int32Array(nx), colHi = new Int32Array(nx);
  const label = new Int32Array(NL);
  const members: number[] = [];
  let anyFlag = false;
  for (let y = 0; y < ny; y++) {
    const o = y * NL;
    rowLo.fill(nx); rowHi.fill(-1); colLo.fill(nz); colHi.fill(-1);
    let any = false;
    for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) if (solid[o + x + nx * z]) {
      any = true;
      if (x < rowLo[z]) rowLo[z] = x;
      if (x > rowHi[z]) rowHi[z] = x;
      if (z < colLo[x]) colLo[x] = z;
      if (z > colHi[x]) colHi[x] = z;
    }
    if (!any) continue;
    label.fill(-1);
    for (let s = 0; s < NL; s++) {
      if (!solid[o + s] || label[s] >= 0) continue;
      members.length = 0; members.push(s); label[s] = s;
      let open = false;
      for (let h = 0; h < members.length; h++) {
        const c = members[h], x = c % nx, z = (c - x) / nx;
        for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dz) continue;
          const X = x + dx, Z = z + dz;
          if (X < 0 || Z < 0 || X >= nx || Z >= nz) { open = true; continue; }
          const j = X + nx * Z;
          if (solid[o + j]) { if (label[j] < 0 && members.length <= CLUTTER_CELLS) { label[j] = s; members.push(j); } continue; }
          if (dx && dz) continue;
          // enclosed air: solid on both sides along both axes (the component itself counts on its own side)
          if (!(rowLo[Z] < X && X < rowHi[Z] && colLo[X] < Z && Z < colHi[X])) open = true;
        }
        if (members.length > CLUTTER_CELLS) break;
      }
      if (open || members.length > CLUTTER_CELLS) continue;
      for (const c of members) flag[o + c] = 1;
      anyFlag = true;
    }
  }
  if (!anyFlag) return recess;
  // 3D groups of flagged cells (6-connected); small ones are removed
  const seen = new Uint8Array(N);
  let out = recess;
  for (let s = 0; s < N; s++) {
    if (!flag[s] || seen[s]) continue;
    members.length = 0; members.push(s); seen[s] = 1;
    for (let h = 0; h < members.length; h++) {
      const i = members[h], x = i % nx, z = Math.floor(i / nx) % nz, y = Math.floor(i / NL);
      for (const j of [x > 0 ? i - 1 : -1, x < nx - 1 ? i + 1 : -1, z > 0 ? i - nx : -1, z < nz - 1 ? i + nx : -1, y > 0 ? i - NL : -1, y < ny - 1 ? i + NL : -1])
        if (j >= 0 && flag[j] && !seen[j]) { seen[j] = 1; members.push(j); }
    }
    if (members.length > CLUTTER_VOXELS) continue;
    if (!out) out = new Uint8Array(N);
    for (const i of members) { solid[i] = 0; out[i] = 1; }
  }
  return out;
}

/** Geodesic reach (LDU) from the closed outside into cells the closing filled: 2 studs sideways. */
const RECESS_REACH = 40;
/** Open-to-sky recesses are kept down to this many plates below the top of their column (a roof hole stays a short well). */
const RECESS_SKY_DEPTH = 30;
/** Smallest recess kept (cells, 6-connected): 2 x 2 studs one brick (3 plates) deep; smaller ones cost 1x1 parts for no form. */
const RECESS_MIN_VOXELS = 12;
/** A dark wall recess: its back is darker than this share of the model's median surface luminance. */
const RECESS_DARK = 0.5;

/**
 * The hole closing (closeHoles) seals small mesh holes so the inside / outside flood does not leak, but as a side
 * effect it fills every concavity narrower than ~3 cells: crenels, the walkway behind battlements, window recesses.
 * Cells the closing filled that the un-closed mesh leaves open to the outside are taken back as air when they are
 *  - open to the sky (no surface above in their column, at most RECESS_SKY_DEPTH plates below the column top) and
 *    reached from the closed outside (any depth straight down, RECESS_REACH LDU otherwise), or
 *  - a side recess at least one brick (3 plates) tall whose back is dark in the texture (window / door opening),
 *    reached within RECESS_REACH (architecture only: `sides`).
 * A leak through a real mesh hole into a sealed interior only opens cells within RECESS_REACH of the hole (or a short
 * well under a roof hole). Mutates `solid`; returns the mask of restored cells (null when none).
 */
function restoreRecesses(surface: Uint8Array, solid: Uint8Array, acc: Float32Array, nx: number, ny: number, nz: number, sides: boolean): Uint8Array | null {
  const N = solid.length, NL = nx * nz;
  const rawOut = floodOutside(surface, nx, ny, nz);
  const cand = new Uint8Array(N);
  let any = false;
  for (let i = 0; i < N; i++) if (solid[i] && !surface[i] && rawOut[i]) { cand[i] = 1; any = true; }
  if (!any) return null;
  // sky-open: no surface above in the column; top = highest solid layer of the column (closing included)
  const sky = new Uint8Array(N);
  const top = new Int32Array(NL).fill(-1);
  for (let c = 0; c < NL; c++) {
    for (let y = ny - 1; y >= 0; y--) { const i = y * NL + c; if (surface[i]) break; sky[i] = 1; }
    for (let y = ny - 1; y >= 0; y--) if (solid[y * NL + c]) { top[c] = y; break; }
  }
  // Dial's algorithm over candidate cells: sideways 20 LDU, vertical 8, straight down between sky-open cells 0
  const COST_H = 20, COST_V = 8;
  const dist = new Int32Array(N).fill(-1);
  const buckets: number[][] = Array.from({ length: RECESS_REACH + 1 }, () => []);
  const nb = (i: number, k: number): number => {
    const x = i % nx, z = Math.floor(i / nx) % nz, y = Math.floor(i / NL);
    switch (k) {
      case 0: return x > 0 ? i - 1 : -1;
      case 1: return x < nx - 1 ? i + 1 : -1;
      case 2: return z > 0 ? i - nx : -1;
      case 3: return z < nz - 1 ? i + nx : -1;
      case 4: return y > 0 ? i - NL : -1;
      default: return y < ny - 1 ? i + NL : -1;
    }
  };
  const tentative = new Int32Array(N).fill(0x7fffffff);
  for (let i = 0; i < N; i++) {
    if (!cand[i]) continue;
    let best = 0x7fffffff;
    for (let k = 0; k < 6; k++) {
      const j = nb(i, k);
      if (j < 0 || solid[j]) continue; // a non-solid cell is the closed outside
      const c = k < 4 ? COST_H : k === 5 && sky[i] ? 0 : COST_V;
      if (c < best) best = c;
    }
    if (best <= RECESS_REACH) { tentative[i] = best; buckets[best].push(i); }
  }
  for (let d = 0; d <= RECESS_REACH; d++) {
    const b = buckets[d];
    for (let h = 0; h < b.length; h++) {
      const i = b[h];
      if (dist[i] >= 0) continue;
      dist[i] = d;
      for (let k = 0; k < 6; k++) {
        const j = nb(i, k);
        if (j < 0 || !cand[j] || dist[j] >= 0) continue;
        const c = k < 4 ? COST_H : k === 4 && sky[i] && sky[j] ? 0 : COST_V;
        const nd = d + c;
        if (nd <= RECESS_REACH && nd < tentative[j]) { tentative[j] = nd; buckets[nd].push(j); }
      }
    }
  }
  // median surface luminance (dark test), from a 64-bin histogram of the sampled colours
  const lum = (i: number) => { const w = acc[i * 4 + 3]; return w > 0 ? (0.2126 * acc[i * 4] + 0.7152 * acc[i * 4 + 1] + 0.0722 * acc[i * 4 + 2]) / w : -1; };
  const hist = new Uint32Array(64);
  let ns = 0;
  for (let i = 0; i < N; i++) if (surface[i]) { const l = lum(i); if (l >= 0) { hist[Math.min(63, Math.floor(Math.sqrt(l) * 64))]++; ns++; } }
  let median = 0;
  for (let k = 0, run = 0; k < 64; k++) { run += hist[k]; if (run * 2 >= ns) { median = ((k + 0.5) / 64) ** 2; break; } }
  const out = new Uint8Array(N);
  let restored = 0;
  // sky-open cells
  for (let i = 0; i < N; i++) {
    if (dist[i] < 0 || !sky[i]) continue;
    const c = i % NL, y = Math.floor(i / NL);
    if (top[c] - y >= RECESS_SKY_DEPTH) continue;
    out[i] = 1; restored++;
  }
  // side recesses: 6-connected components of reached, not sky-open cells; tall (>= 3 plates) and dark ones stay air
  const seen = new Uint8Array(N);
  const members: number[] = [];
  for (let s = 0; s < N && sides; s++) {
    if (dist[s] < 0 || sky[s] || seen[s]) continue;
    members.length = 0;
    seen[s] = 1; members.push(s);
    let y0 = ny, y1 = -1, lsum = 0, ln = 0;
    for (let h = 0; h < members.length; h++) {
      const i = members[h];
      const y = Math.floor(i / NL);
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (let k = 0; k < 6; k++) {
        const j = nb(i, k);
        if (j < 0) continue;
        if (surface[j]) { const l = lum(j); if (l >= 0) { lsum += l; ln++; } }
        else if (dist[j] >= 0 && !sky[j] && !seen[j]) { seen[j] = 1; members.push(j); }
      }
    }
    if (y1 - y0 + 1 < 3 || !ln || lsum / ln >= RECESS_DARK * median) continue;
    for (const i of members) { out[i] = 1; restored++; }
  }
  if (!restored) return null;
  // tiny recesses (a 1-stud nick, a plate-deep dent) are reconstruction noise and would only cost 1x1 parts: they
  // stay filled; a recess must hold at least RECESS_MIN_VOXELS cells
  seen.fill(0);
  for (let s = 0; s < N; s++) {
    if (!out[s] || seen[s]) continue;
    members.length = 0; members.push(s); seen[s] = 1;
    for (let h = 0; h < members.length; h++) for (let k = 0; k < 6; k++) { const j = nb(members[h], k); if (j >= 0 && out[j] && !seen[j]) { seen[j] = 1; members.push(j); } }
    if (members.length < RECESS_MIN_VOXELS) for (const i of members) { out[i] = 0; restored--; }
  }
  if (!restored) return null;
  for (let i = 0; i < N; i++) if (out[i]) solid[i] = 0;
  return out;
}

const N6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const;

/** 6-connected flood from the grid boundary over cells where wall == 0. */
export function floodOutside(wall: Uint8Array, nx: number, ny: number, nz: number): Uint8Array {
  const out = new Uint8Array(wall.length);
  const NL = nx * nz;
  let stack = new Int32Array(1024), sp = 0;
  const push = (i: number) => {
    if (sp === stack.length) { const s2 = new Int32Array(stack.length * 2); s2.set(stack); stack = s2; }
    stack[sp++] = i;
  };
  for (let y = 0, i = 0; y < ny; y++)
    for (let z = 0; z < nz; z++)
      for (let x = 0; x < nx; x++, i++)
        if ((x === 0 || y === 0 || z === 0 || x === nx - 1 || y === ny - 1 || z === nz - 1) && !wall[i]) { out[i] = 1; push(i); }
  while (sp) {
    const i = stack[--sp];
    const x = i % nx, z = Math.floor(i / nx) % nz, y = Math.floor(i / NL);
    if (x > 0 && !out[i - 1] && !wall[i - 1]) { out[i - 1] = 1; push(i - 1); }
    if (x < nx - 1 && !out[i + 1] && !wall[i + 1]) { out[i + 1] = 1; push(i + 1); }
    if (z > 0 && !out[i - nx] && !wall[i - nx]) { out[i - nx] = 1; push(i - nx); }
    if (z < nz - 1 && !out[i + nx] && !wall[i + nx]) { out[i + nx] = 1; push(i + nx); }
    if (y > 0 && !out[i - NL] && !wall[i - NL]) { out[i - NL] = 1; push(i - NL); }
    if (y < ny - 1 && !out[i + NL] && !wall[i + NL]) { out[i + NL] = 1; push(i + NL); }
  }
  return out;
}

/** Separable box dilation with radii (rx, ry, rz). */
function dilate(m: Uint8Array, nx: number, ny: number, nz: number, rx: number, ry: number, rz: number): Uint8Array {
  const pass = (src: Uint8Array, axis: 0 | 1 | 2, r: number) => {
    if (r <= 0) return src;
    const dst = new Uint8Array(src.length);
    const n = [nx, ny, nz][axis];
    const stride = [1, nx * nz, nx][axis];
    for (let y = 0, i = 0; y < ny; y++)
      for (let z = 0; z < nz; z++)
        for (let x = 0; x < nx; x++, i++) {
          if (!src[i]) continue;
          const p = axis === 0 ? x : axis === 1 ? y : z;
          const lo = Math.max(0, p - r), hi = Math.min(n - 1, p + r);
          for (let q = lo; q <= hi; q++) dst[i + (q - p) * stride] = 1;
        }
    return dst;
  };
  return pass(pass(pass(m, 0, rx), 1, ry), 2, rz);
}

/** Closest point on triangle to p (Ericson, RTCD 5.1.5). Writes barycentrics (u,v,w) and squared distance. */
function closestBary(px: number, py: number, pz: number, t: Float64Array, out: Float64Array) {
  const ax = t[0], ay = t[1], az = t[2], bx = t[3], by = t[4], bz = t[5], cx = t[6], cy = t[7], cz = t[8];
  const abx = bx - ax, aby = by - ay, abz = bz - az, acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  let u: number, v: number, w: number;
  const fin = () => {
    const qx = ax * u + bx * v + cx * w, qy = ay * u + by * v + cy * w, qz = az * u + bz * v + cz * w;
    out[0] = u; out[1] = v; out[2] = w; out[3] = (qx - px) ** 2 + (qy - py) ** 2 + (qz - pz) ** 2;
  };
  if (d1 <= 0 && d2 <= 0) { u = 1; v = 0; w = 0; return fin(); }
  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) { u = 0; v = 1; w = 0; return fin(); }
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const k = d1 / (d1 - d3 || 1); u = 1 - k; v = k; w = 0; return fin(); }
  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) { u = 0; v = 0; w = 1; return fin(); }
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const k = d2 / (d2 - d6 || 1); u = 1 - k; v = 0; w = k; return fin(); }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const k = (d4 - d3) / (d4 - d3 + (d5 - d6) || 1); u = 0; v = 1 - k; w = k; return fin(); }
  const den = 1 / (va + vb + vc || 1);
  v = vb * den; w = vc * den; u = 1 - v - w;
  fin();
}

/** Triangle / axis-aligned box overlap, separating axis theorem (Akenine-Moeller 2001). */
function triBoxOverlap(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, t: Float64Array): boolean {
  const v0x = t[0] - cx, v0y = t[1] - cy, v0z = t[2] - cz;
  const v1x = t[3] - cx, v1y = t[4] - cy, v1z = t[5] - cz;
  const v2x = t[6] - cx, v2y = t[7] - cy, v2z = t[8] - cz;
  if (Math.min(v0x, v1x, v2x) > hx || Math.max(v0x, v1x, v2x) < -hx) return false;
  if (Math.min(v0y, v1y, v2y) > hy || Math.max(v0y, v1y, v2y) < -hy) return false;
  if (Math.min(v0z, v1z, v2z) > hz || Math.max(v0z, v1z, v2z) < -hz) return false;
  const e0x = v1x - v0x, e0y = v1y - v0y, e0z = v1z - v0z;
  const e1x = v2x - v1x, e1y = v2y - v1y, e1z = v2z - v1z;
  const e2x = v0x - v2x, e2y = v0y - v2y, e2z = v0z - v2z;
  // 9 edge cross-product axes
  const axisTest = (ax: number, ay: number, az: number) => {
    const p0 = v0x * ax + v0y * ay + v0z * az, p1 = v1x * ax + v1y * ay + v1z * az, p2 = v2x * ax + v2y * ay + v2z * az;
    const r = hx * Math.abs(ax) + hy * Math.abs(ay) + hz * Math.abs(az);
    return !(Math.min(p0, p1, p2) > r || Math.max(p0, p1, p2) < -r);
  };
  if (!axisTest(0, -e0z, e0y) || !axisTest(0, -e1z, e1y) || !axisTest(0, -e2z, e2y)) return false;
  if (!axisTest(e0z, 0, -e0x) || !axisTest(e1z, 0, -e1x) || !axisTest(e2z, 0, -e2x)) return false;
  if (!axisTest(-e0y, e0x, 0) || !axisTest(-e1y, e1x, 0) || !axisTest(-e2y, e2x, 0)) return false;
  const nx = e0y * e1z - e0z * e1y, ny = e0z * e1x - e0x * e1z, nz = e0x * e1y - e0y * e1x;
  const d = nx * v0x + ny * v0y + nz * v0z;
  const r = hx * Math.abs(nx) + hy * Math.abs(ny) + hz * Math.abs(nz);
  return Math.abs(d) <= r;
}
