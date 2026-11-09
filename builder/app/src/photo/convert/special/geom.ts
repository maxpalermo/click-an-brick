// Frames and placement maths shared by reserve() / refine().
//
// GRID FRAME (what reserve() returns and what refine() works in internally): LDraw axes (-Y up), LDU, with the voxel
// grid's cell (i, j, k) [x right, y UP, z] spanning X in [20i, 20i+20], Y in [-8(j+1), -8j], Z in [-20(k+1), -20k].
// This is exactly bricks.ts toBricks() WITHOUT its centring step, i.e.
//   modelPos = gridPos + [-cx * 20, y0 * 8, cz * 20]   (cx, cz, y0 as computed in toBricks)
// so the structure pipeline must translate reserve() parts with the same offset as the packed bricks
// (see gridToModelOffset() in index.ts).

import type { Brick, Mat3 } from '../../../model/types';
import { PARTS, type Box, type PartSpec } from './library';

export type Part = Omit<Brick, 'id'>;
export type V3 = [number, number, number];

export const IDENT: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
/** Rotations about LDraw Y by k quarter turns. k = 1 equals bricks.ts ROT_Y90 (local +X -> world -Z). */
export const ROTY: Mat3[] = [
  [1, 0, 0, 0, 1, 0, 0, 0, 1],
  [0, 0, 1, 0, 1, 0, -1, 0, 0],
  [-1, 0, 0, 0, 1, 0, 0, 0, -1],
  [0, 0, -1, 0, 1, 0, 1, 0, 0],
];

export const mulV = (R: Mat3, v: V3): V3 => [
  R[0] * v[0] + R[1] * v[1] + R[2] * v[2],
  R[3] * v[0] + R[4] * v[1] + R[5] * v[2],
  R[6] * v[0] + R[7] * v[1] + R[8] * v[2],
];
export const mulM = (A: Mat3, B: Mat3): Mat3 => {
  const o = new Array(9).fill(0) as Mat3;
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c];
  return o;
};
const clean = (n: number) => { const r = Math.round(n * 1000) / 1000; return Object.is(r, -0) ? 0 : r; };
export const cleanM = (m: Mat3): Mat3 => m.map(clean) as Mat3;

/** Axis-aligned box of a local box under rotation R and translation p. */
export function xfBox(R: Mat3, p: V3, b: Box): Box {
  const lo: V3 = [Infinity, Infinity, Infinity], hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < 8; i++) {
    const v = mulV(R, [i & 1 ? b[3] : b[0], i & 2 ? b[4] : b[1], i & 4 ? b[5] : b[2]]);
    for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], v[k] + p[k]); hi[k] = Math.max(hi[k], v[k] + p[k]); }
  }
  return [lo[0], lo[1], lo[2], hi[0], hi[1], hi[2]];
}

/** Grid directions: 0 +x, 1 -x, 2 +z, 3 -z (grid frame, y up). */
export const DIRS: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
/** Grid direction -> LDraw world vector (grid +z = LDraw -Z). */
export const dirToLd = (d: number): V3 => (d === 0 ? [1, 0, 0] : d === 1 ? [-1, 0, 0] : d === 2 ? [0, 0, -1] : [0, 0, 1]);
/** Quarter turn k such that ROTY[k] maps local v to the grid direction d. */
export function rotFor(local: V3, d: number): number {
  const t = dirToLd(d);
  for (let k = 0; k < 4; k++) {
    const v = mulV(ROTY[k], local);
    if (Math.abs(v[0] - t[0]) < 1e-6 && Math.abs(v[2] - t[2]) < 1e-6) return k;
  }
  throw new Error('no rotation');
}

/** Grid cell box (inclusive-exclusive, y up) -> LDraw world box in the grid frame. */
export const cellsToLd = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Box =>
  [x0 * 20, -y1 * 8, -z1 * 20, x1 * 20, -y0 * 8, -z0 * 20];

/** Cells overlapped (by more than eps LDU) by an LDraw world box: [x0,y0,z0,x1,y1,z1) in grid indices (y up). */
export function ldToCells(b: Box, eps = 0.5): [number, number, number, number, number, number] {
  return [
    Math.floor((b[0] + eps) / 20), Math.floor((-b[4] + eps) / 8), Math.floor((-b[5] + eps) / 20),
    Math.ceil((b[3] - eps) / 20), Math.ceil((-b[1] - eps) / 8), Math.ceil((-b[2] - eps) / 20),
  ];
}

/** Position that maps the spec's body box (rotated by R) onto the given world box min corner. */
export function placeBody(spec: PartSpec, R: Mat3, target: Box): V3 {
  const wb = xfBox(R, [0, 0, 0], spec.body);
  return [clean(target[0] - wb[0]), clean(target[1] - wb[1]), clean(target[2] - wb[2])];
}

export function spec(id: string): PartSpec {
  const s = PARTS[id];
  if (!s) throw new Error(`unknown special part ${id}`);
  return s;
}

/** World AABB of a placed special part (body or full bbox). */
export function partBox(p: Part, full = false): Box | null {
  const s = PARTS[p.part];
  if (!s) return null;
  return xfBox(p.rot, p.pos, full ? s.bbox : s.body);
}

export const boxesOverlap = (a: Box, b: Box, tol = 0.5) =>
  a[0] < b[3] - tol && b[0] < a[3] - tol && a[1] < b[4] - tol && b[1] < a[4] - tol && a[2] < b[5] - tol && b[2] < a[5] - tol;
