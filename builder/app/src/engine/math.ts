// Small math helpers for LDraw transforms (row-major 3x3 + position) and grid snapping.
import * as THREE from 'three';
import type { Mat3, Vec3 } from '../model/types';

/** Remove float noise and -0 from matrix / vector entries. */
export function clean(v: number): number {
  return Math.round(v * 1e6) / 1e6 || 0;
}

/** LDraw type-1 transform → Matrix4 (p' = R·p + pos). */
export function mat4From(rot: Mat3, pos: Vec3, out = new THREE.Matrix4()): THREE.Matrix4 {
  return out.set(
    rot[0], rot[1], rot[2], pos[0],
    rot[3], rot[4], rot[5], pos[1],
    rot[6], rot[7], rot[8], pos[2],
    0, 0, 0, 1,
  );
}

export function mulMat3(a: Mat3, b: Mat3): Mat3 {
  const r = new Array<number>(9);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      r[i * 3 + j] = clean(a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j]);
    }
  }
  return r as Mat3;
}

/** 90° rotation around the LDraw vertical (Y) axis. */
export function rotY90(dir: 1 | -1): Mat3 {
  return [0, 0, dir, 0, 1, 0, -dir, 0, 0];
}

export function applyMat3(m: Mat3, v: Vec3): Vec3 {
  return [
    clean(m[0] * v[0] + m[1] * v[1] + m[2] * v[2]),
    clean(m[3] * v[0] + m[4] * v[1] + m[5] * v[2]),
    clean(m[6] * v[0] + m[7] * v[1] + m[8] * v[2]),
  ];
}

/** AABB overlap with a tolerance (touching boxes do not overlap). */
export function boxesOverlap(a: THREE.Box3, b: THREE.Box3, eps = 0.5): boolean {
  return (
    Math.min(a.max.x, b.max.x) - Math.max(a.min.x, b.min.x) > eps &&
    Math.min(a.max.y, b.max.y) - Math.max(a.min.y, b.min.y) > eps &&
    Math.min(a.max.z, b.max.z) - Math.max(a.min.z, b.min.z) > eps
  );
}

/**
 * Snap a part origin along one horizontal axis so the footprint is centred on `v`
 * and its min edge lands on the 20 LDU stud grid. Result is always on the 10 LDU grid.
 */
export function snapAxis(v: number, min: number, max: number): number {
  const minR = Math.round(min / 10) * 10;
  const pos = v - (min + max) / 2;
  const edge = Math.round((pos + minR) / 20) * 20;
  return clean(edge - minR);
}

/** Shift needed to bring a box's min edge (rounded to 10) onto the 20 LDU grid. */
export function gridShift(min: number): number {
  const minR = Math.round(min / 10) * 10;
  return clean(Math.round(minR / 20) * 20 - minR);
}

/** LDraw-space box → three.js world box (root group is rotated π around X: y→-y, z→-z). */
export function ldToThreeBox(b: THREE.Box3, out = new THREE.Box3()): THREE.Box3 {
  out.min.set(b.min.x, -b.max.y, -b.max.z);
  out.max.set(b.max.x, -b.min.y, -b.min.z);
  return out;
}

/** three.js world point → LDraw space. */
export function toLDraw(v: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set(v.x, -v.y, -v.z);
}

/** Rotation around the LDraw vertical (Y) axis by `deg` degrees (same sense as rotY90(1) for +90). */
export function rotYDeg(deg: number): Mat3 {
  const t = (deg * Math.PI) / 180;
  const c = clean(Math.cos(t));
  const s = clean(Math.sin(t));
  return [c, 0, s, 0, 1, 0, -s, 0, c];
}

/** Every entry is 0 or ±1 (a 90°-multiple orientation). */
export function isAxisAligned(r: Mat3): boolean {
  return r.every((v) => Math.abs(v) < 1e-5 || Math.abs(Math.abs(v) - 1) < 1e-5);
}

/** Pure rotation around the vertical axis (no tilt). */
export function isYRotation(r: Mat3): boolean {
  return Math.abs(r[4] - 1) < 1e-5 && [r[1], r[3], r[5], r[7]].every((v) => Math.abs(v) < 1e-5);
}

/** Heading (degrees, CCW seen from above) of a Y rotation matrix. */
export function headingDeg(r: Mat3): number {
  return (Math.atan2(-r[2], r[0]) * 180) / Math.PI;
}

/** Oriented footprint in the horizontal plane (LDraw x/z), half extents along axes u and v. */
export interface Obb { cx: number; cz: number; ux: number; uz: number; vx: number; vz: number; hx: number; hz: number }

/** Collision shape: world AABB (always) + an oriented footprint for non-90° Y rotations. */
export interface Solid { box: THREE.Box3; obb: Obb | null }

export function solidOf(local: THREE.Box3, rot: Mat3, pos: Vec3): Solid {
  const box = local.clone().applyMatrix4(mat4From(rot, pos, new THREE.Matrix4()));
  if (isAxisAligned(rot) || !isYRotation(rot)) return { box, obb: null };
  const c = local.getCenter(new THREE.Vector3());
  const h = local.getSize(new THREE.Vector3()).multiplyScalar(0.5);
  return {
    box,
    obb: {
      cx: rot[0] * c.x + rot[1] * c.y + rot[2] * c.z + pos[0],
      cz: rot[6] * c.x + rot[7] * c.y + rot[8] * c.z + pos[2],
      ux: rot[0], uz: rot[6], vx: rot[2], vz: rot[8], hx: h.x, hz: h.z,
    },
  };
}

function obbOfBox(b: THREE.Box3): Obb {
  return {
    cx: (b.min.x + b.max.x) / 2, cz: (b.min.z + b.max.z) / 2, ux: 1, uz: 0, vx: 0, vz: 1,
    hx: (b.max.x - b.min.x) / 2, hz: (b.max.z - b.min.z) / 2,
  };
}

/** Overlap test: AABB fast path; 2D SAT on the footprints when either one is rotated off-grid. */
export function solidsOverlap(a: Solid, b: Solid, eps = 0.5): boolean {
  if (!boxesOverlap(a.box, b.box, eps)) return false; // also covers the vertical interval
  if (!a.obb && !b.obb) return true;
  const A = a.obb ?? obbOfBox(a.box);
  const B = b.obb ?? obbOfBox(b.box);
  const dx = B.cx - A.cx;
  const dz = B.cz - A.cz;
  const axes: Array<[number, number]> = [[A.ux, A.uz], [A.vx, A.vz], [B.ux, B.uz], [B.vx, B.vz]];
  for (const [nx, nz] of axes) {
    const ra = A.hx * Math.abs(A.ux * nx + A.uz * nz) + A.hz * Math.abs(A.vx * nx + A.vz * nz);
    const rb = B.hx * Math.abs(B.ux * nx + B.uz * nz) + B.hz * Math.abs(B.vx * nx + B.vz * nz);
    if (Math.abs(dx * nx + dz * nz) >= ra + rb - eps) return false; // separating axis
  }
  return true;
}

/**
 * Re-derive a pure vertical-axis rotation from its heading (rounded to 0.001°) so repeated
 * products don't drift (0.999999…) and 90° multiples come out exactly 0 / ±1. Other matrices pass through.
 */
export function normRot(r: Mat3): Mat3 {
  if (!isYRotation(r)) return r;
  return rotYDeg(-Math.round(headingDeg(r) * 1000) / 1000);
}
