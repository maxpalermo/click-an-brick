// Orientation, scale and lattice phase (doc §4.2, §6, §7).
// Input meshes are glTF (+Y up, right-handed; TRELLIS / SPAR3D output). The voxelizer works in that frame
// (layers counted upward); bricks.ts maps to LDraw (-Y up) at output.

import type { TriangleMesh } from './mesh';
import { bbox, STUD, PLATE_H } from './voxelize';

export const MAX_STUDS = 96;

/** LDU per model unit so the longest dimension (horizontal, or height at 20 LDU per stud) is `studs` studs. */
export function scaleForStuds(mesh: TriangleMesh, studs: number): number {
  const { min, max } = bbox(mesh.positions);
  const ext = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  if (!(ext > 0)) throw new Error('the model is empty or flat');
  return (studs * STUD) / ext;
}

/** Model size in studs (x, plates-as-studs y, z) for a scale. */
export function sizeInStuds(mesh: TriangleMesh, scale: number): [number, number, number] {
  const { min, max } = bbox(mesh.positions);
  return [0, 1, 2].map((k) => ((max[k] - min[k]) * scale) / STUD) as [number, number, number];
}

/**
 * Object mode: centre the lattice on the bbox in X/Z so the leftover is split evenly on both sides (symmetric
 * objects stay symmetric). Y phase 0 = the bottom of the model sits on a layer boundary (the ground).
 */
export function centredPhase(mesh: TriangleMesh, scale: number): [number, number, number] {
  const { min, max } = bbox(mesh.positions);
  const ph = (k: number) => {
    const e = (max[k] - min[k]) * scale;
    return (Math.ceil(e / STUD - 1e-6) * STUD - e) / 2;
  };
  return [ph(0), 0, ph(2)];
}

/**
 * LEGO-build mode, yaw: rotate the mesh about Y so the dominant vertical faces are axis-aligned. Uses an
 * area-weighted histogram of horizontal normal directions modulo 90°. Returns the applied angle (degrees)
 * or 0 when there is no clear dominant direction.
 */
export function alignYaw(mesh: TriangleMesh): number {
  const P = mesh.positions, I = mesh.indices;
  const bins = new Float64Array(90), sums = new Float64Array(90);
  let total = 0;
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const nx = uy * vz - uz * vy, nz = ux * vy - uy * vx;
    const ny = uz * vx - ux * vz;
    const len = Math.hypot(nx, ny, nz);
    if (!len) continue;
    const h2 = (nx * nx + nz * nz) / (len * len); // how vertical the face is
    const w = (len / 2) * h2 * h2;
    let ang = (Math.atan2(nz, nx) * 180) / Math.PI;
    ang = ((ang % 90) + 90) % 90;
    const bi = Math.min(89, Math.floor(ang));
    bins[bi] += w;
    sums[bi] += w * ang;
    total += w;
  }
  if (!(total > 0)) return 0;
  let best = 0, bestW = -1;
  for (let i = 0; i < 90; i++) {
    let w = 0;
    for (let d = -3; d <= 3; d++) w += bins[(i + d + 90) % 90];
    if (w > bestW) { bestW = w; best = i; }
  }
  // refine: weighted mean around the peak (circular, period 90)
  let sw = 0, sa = 0;
  for (let d = -3; d <= 3; d++) {
    const j = (best + d + 90) % 90;
    const shift = best + d < 0 ? -90 : best + d >= 90 ? 90 : 0; // unwrap around the 0/90 seam
    sw += bins[j]; sa += sums[j] + shift * bins[j];
  }
  let theta = sw ? sa / sw : best + 0.5;
  if (bestW / total < 0.25) return 0; // no dominant direction (organic shape)
  theta = ((theta % 90) + 90) % 90;
  if (theta > 45) theta -= 90;
  if (Math.abs(theta) < 0.5) return 0;
  rotateY(mesh, (-theta * Math.PI) / 180);
  return theta;
}

/** Rotate positions about the vertical axis in place (angle increases atan2(z, x)). */
export function rotateY(mesh: TriangleMesh, a: number) {
  const P = mesh.positions;
  const c = Math.cos(a), s = Math.sin(a);
  for (let i = 0; i < P.length; i += 3) {
    const x = P[i], z = P[i + 2];
    P[i] = x * c - z * s;
    P[i + 2] = x * s + z * c;
  }
}

/** Mulberry32 PRNG. */
function rng(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/**
 * LEGO-build mode, stud phase (§6B automatic fit): try X/Z offsets on a 2 LDU grid, then refine each axis at 0.25 LDU and keep the one
 * whose lattice cuts the surface into the fewest cells (faces of a real build then lie on voxel boundaries
 * instead of half-filling a row of voxels). Surface samples are nudged `nudge` LDU inward (same as the voxelizer in this mode). Y phase stays 0
 * (plates count from the table).
 */
export function fitPhase(mesh: TriangleMesh, scale: number, nudge = 1, samples = 25000): [number, number, number] {
  const P = mesh.positions, I = mesh.indices;
  const { min, max } = bbox(P);
  const nt = I.length / 3;
  const area = new Float64Array(nt);
  let total = 0;
  for (let t = 0; t < nt; t++) {
    const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    area[t] = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
    total += area[t];
  }
  if (!(total > 0)) return [0, 0, 0];
  const rand = rng(777);
  const pts: number[] = [];
  const per = samples / total;
  let carry = 0;
  for (let t = 0; t < nt; t++) {
    carry += area[t] * per;
    let k = Math.floor(carry);
    carry -= k;
    if (!k) continue;
    k = Math.min(k, 4000);
    const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    for (let j = 0; j < k; j++) {
      let r1 = rand(), r2 = rand();
      if (r1 + r2 > 1) { r1 = 1 - r1; r2 = 1 - r2; }
      pts.push(
        (P[a] + ux * r1 + vx * r2 - min[0]) * scale - nudge * nx,
        (P[a + 1] + uy * r1 + vy * r2 - min[1]) * scale - nudge * ny,
        (P[a + 2] + uz * r1 + vz * r2 - min[2]) * scale - nudge * nz,
      );
    }
  }
  const nx = Math.ceil(((max[0] - min[0]) * scale) / STUD) + 3, ny = Math.ceil(((max[1] - min[1]) * scale) / PLATE_H) + 3;
  const nz = Math.ceil(((max[2] - min[2]) * scale) / STUD) + 3;
  const stamp = new Int32Array(nx * ny * nz).fill(-1);
  let run = 0;
  const cellsFor = (px: number, pz: number) => {
    let n = 0;
    for (let i = 0; i < pts.length; i += 3) {
      const ix = Math.floor((pts[i] + px) / STUD) + 1, iy = Math.floor(pts[i + 1] / PLATE_H) + 1, iz = Math.floor((pts[i + 2] + pz) / STUD) + 1;
      if (ix < 0 || iy < 0 || iz < 0 || ix >= nx || iy >= ny || iz >= nz) continue;
      const key = ix + nx * (iz + nz * iy);
      if (stamp[key] !== run) { stamp[key] = run; n++; }
    }
    run++;
    return n;
  };
  // coarse joint search on a 2 LDU grid (the plateau is ~2 x nudge wide)
  let bx = 0, bz = 0, bestN = Infinity;
  for (let px = 0; px < STUD; px += 2)
    for (let pz = 0; pz < STUD; pz += 2) {
      const n = cellsFor(px, pz);
      if (n < bestN) { bestN = n; bx = px; bz = pz; }
    }
  // per axis: 0.25 LDU scan, then take the centre of the (circular) plateau of minimal counts, so faces end
  // up as far from the cell boundaries as the data allows
  const centre = (f: (p: number) => number, fallback: number) => {
    const q = 0.25, m = STUD / q;
    const counts = Array.from({ length: m }, (_, i) => f(i * q));
    const lo = Math.min(...counts);
    let bestLen = 0, bestStart = 0;
    for (let s = 0; s < m; s++) {
      if (counts[s] !== lo || counts[(s - 1 + m) % m] === lo) continue;
      let len = 0;
      while (len < m && counts[(s + len) % m] === lo) len++;
      if (len > bestLen) { bestLen = len; bestStart = s; }
    }
    if (!bestLen || bestLen === m) return fallback; // flat: no information
    return (((bestStart + (bestLen - 1) / 2) * q) % STUD + STUD) % STUD;
  };
  const px = centre((p) => cellsFor(p, bz), bx);
  const pz = centre((p) => cellsFor(px, p), bz);
  return [px, 0, pz];
}
