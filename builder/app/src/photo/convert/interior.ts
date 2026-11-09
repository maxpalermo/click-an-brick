// Hollow interior with internal supports (structure workstream). A builder never fills a big model with bricks: the
// outer walls are `wall` studs thick, a floor and a roof close the cavity, and 2x2 support pillars on a regular
// lattice (symmetric about the mirror plane, when there is one) hold the roof plates. Cells that stay are hidden, so
// their colour is free (ANY): big interior parts merge across colour borders. Only cavities of at least `minCavity`
// cells per layer are opened, so thin bodies stay solid.

import type { VoxelGrid } from './voxelize';

const EMPTY = -2;

export interface InteriorOptions {
  /** Wall thickness in studs (in-layer Chebyshev distance to the outside of the layer). */
  wall: number;
  /** Solid plates kept under a cavity; 0 = cavities open at the bottom (the only stud-safe option, see below). */
  floor: number;
  roof: number;
  /** Pillar lattice pitch in studs (2x2 pillars every `pitch` studs, centred on `centre`). 0 = no pillars. */
  pitch: number;
  /** Cavity cells per layer region needed to open it. */
  minCavity: number;
  /** Lattice centre per axis in cell-boundary coordinates [x, z] (mirror plane or bbox centre). */
  centre: [number, number];
  /** Plate layers at the ground before the first brick band (ApproxSettings.basePlates); a cavity may stand on them. */
  base?: number;
}

/** Pillar test along one axis: 2-wide pillars every `pitch` cells, symmetric about c (boundary coords). */
function pillarAxis(i: number, c: number, pitch: number): boolean {
  const d = Math.abs(i + 0.5 - c);
  const k = Math.floor(d + 1e-9);
  const half = Math.abs(c - Math.round(c)) > 0.25; // plane through a cell centre
  const m = k % pitch;
  return m === 0 || (m === 1 && (k > 1 || half));
}

/** Removes the interior in place (solid + cells). Returns the number of voxels removed and of pillar voxels kept. */
export function hollowInterior(g: VoxelGrid, cells: Int16Array, o: InteriorOptions): { removed: number; pillars: number; mask: Uint8Array } {
  const { nx, ny, nz, solid } = g;
  const NL = nx * nz;
  if (o.wall <= 0) return { removed: 0, pillars: 0, mask: new Uint8Array(0) };
  // vertical runs: solid cells above / below in the same column (capped)
  const cap = Math.max(o.floor, o.roof) + 1;
  const up = new Uint8Array(solid.length), dn = new Uint8Array(solid.length);
  for (let c = 0; c < NL; c++) {
    let run = 0;
    for (let y = 0; y < ny; y++) { const i = y * NL + c; if (solid[i]) { dn[i] = Math.min(cap, run); run++; } else run = 0; }
    run = 0;
    for (let y = ny - 1; y >= 0; y--) { const i = y * NL + c; if (solid[i]) { up[i] = Math.min(cap, run); run++; } else run = 0; }
  }
  const dist = new Int32Array(NL);
  const deep = new Uint8Array(NL);
  const label = new Int32Array(NL);
  const stack: number[] = [];
  const px = new Uint8Array(nx), pz = new Uint8Array(nz);
  if (o.pitch > 0) {
    for (let x = 0; x < nx; x++) px[x] = pillarAxis(x, o.centre[0], o.pitch) ? 1 : 0;
    for (let z = 0; z < nz; z++) pz[z] = pillarAxis(z, o.centre[1], o.pitch) ? 1 : 0;
  }
  // ground layer: cavities are aligned to brick bands (3 plates) counted from it, so walls stay whole bricks
  let y0 = 0;
  outer: for (; y0 < ny; y0++) for (let c = 0; c < NL; c++) if (solid[y0 * NL + c]) break outer;
  const yb = y0 + (o.base ?? 0); // first brick band
  const deep3 = new Uint8Array(solid.length);
  const raw = new Uint8Array(solid.length); // deep before the 2x2 opening
  const far = new Uint8Array(solid.length); // in-layer distance to the outside > wall
  for (let y = 0; y < ny; y++) {
    const off = y * NL;
    // in-layer Chebyshev distance to the nearest empty cell (2-pass chamfer)
    for (let z = 0; z < nz; z++)
      for (let x = 0; x < nx; x++) {
        const c = x + nx * z;
        if (!solid[off + c]) { dist[c] = 0; continue; }
        let d = 1;
        if (x > 0 && z > 0) d = 1 + Math.min(dist[c - 1], dist[c - nx], dist[c - nx - 1], x < nx - 1 ? dist[c - nx + 1] : 0);
        dist[c] = d;
      }
    for (let z = nz - 1; z >= 0; z--)
      for (let x = nx - 1; x >= 0; x--) {
        const c = x + nx * z;
        if (!dist[c]) continue;
        if (x === nx - 1 || z === nz - 1) { dist[c] = 1; continue; }
        dist[c] = Math.min(dist[c], 1 + Math.min(dist[c + 1], dist[c + nx], dist[c + nx + 1], x > 0 ? dist[c + nx - 1] : 0));
      }
    for (let c = 0; c < NL; c++) far[off + c] = dist[c] > o.wall ? 1 : 0;
  }
  for (let y = 0; y < ny; y++) {
    const off = y * NL;
    // deep = far from the outside in this layer AND in the `roof` layers above (a sloped top must not leave a
    // cavity behind a 1-plate step: the roof is a real slab)
    for (let c = 0; c < NL; c++) {
      const i = off + c;
      let d = solid[i] && up[i] >= o.roof && dn[i] >= o.floor ? 1 : 0;
      for (let k = 0; k <= o.roof && d; k++) if (y + k >= ny || !far[i + k * NL]) d = 0;
      deep[c] = d;
      raw[i] = d;
    }
    // opening with a 2x2 block: no 1-stud slivers of cavity (they would force 1-wide parts around them)
    for (let z = 0; z < nz; z++)
      for (let x = 0; x < nx; x++) {
        const c = x + nx * z;
        if (!deep[c]) continue;
        let ok = false;
        for (let dz = -1; dz <= 0 && !ok; dz++)
          for (let dx = -1; dx <= 0 && !ok; dx++) {
            const X = x + dx, Z = z + dz;
            if (X < 0 || Z < 0 || X + 1 >= nx || Z + 1 >= nz) continue;
            const k = X + nx * Z;
            ok = !!(deep[k] && deep[k + 1] && deep[k + nx] && deep[k + nx + 1]);
          }
        if (ok) deep3[off + c] = 1;
      }
  }
  // band alignment: a column cell is cavity only when its whole 3-plate band is
  for (let y = yb; y + 2 < ny; y += 3)
    for (let c = 0; c < NL; c++) {
      const i = y * NL + c;
      const all = deep3[i] && deep3[i + NL] && deep3[i + 2 * NL];
      if (!all) deep3[i] = deep3[i + NL] = deep3[i + 2 * NL] = 0;
    }
  for (let y = 0; y < ny; y++) if (y < yb || y >= yb + 3 * Math.floor((ny - yb) / 3)) for (let c = 0; c < NL; c++) deep3[y * NL + c] = 0;
  // a deep band sandwiched between cavity bands (left solid by the opening / band rules) would float: open it too
  for (let y = yb + 3; y + 5 < ny; y += 3)
    for (let c = 0; c < NL; c++) {
      const i = y * NL + c;
      if (deep3[i] || !raw[i] || !raw[i + NL] || !raw[i + 2 * NL]) continue;
      if (deep3[i - NL] && deep3[i + 3 * NL]) deep3[i] = deep3[i + NL] = deep3[i + 2 * NL] = 1;
    }
  // open at the bottom: a cavity never sits on a kept floor (a floor part under a cavity would only touch the walls
  // sideways, without studs, and fall off); it starts on air / the ground or on the cavity band below
  if (o.floor <= 0)
    for (let y = yb; y + 2 < ny; y += 3)
      for (let c = 0; c < NL; c++) {
        const i = y * NL + c;
        // (the base plate layer is a wide, stud-connected slab under walls and cavity alike: a cavity may stand on it)
        if (deep3[i] && y > 0 && solid[i - NL] && !deep3[i - NL] && !(y === yb && yb > y0)) deep3[i] = deep3[i + NL] = deep3[i + 2 * NL] = 0;
      }
  let removed = 0, pillars = 0;
  for (let y = 0; y < ny; y++) {
    const off = y * NL;
    let any = false;
    for (let c = 0; c < NL; c++) { deep[c] = deep3[off + c]; if (deep[c]) any = true; }
    if (!any) continue;
    // open only regions of at least minCavity cells
    label.fill(-1);
    for (let s = 0; s < NL; s++) {
      if (!deep[s] || label[s] >= 0) continue;
      const members: number[] = [s];
      label[s] = s;
      stack.length = 0; stack.push(s);
      while (stack.length) {
        const c = stack.pop()!;
        const x = c % nx, z = (c - x) / nx;
        for (const n of [x > 0 ? c - 1 : -1, x < nx - 1 ? c + 1 : -1, z > 0 ? c - nx : -1, z < nz - 1 ? c + nx : -1]) {
          if (n < 0 || !deep[n] || label[n] >= 0) continue;
          label[n] = s; members.push(n); stack.push(n);
        }
      }
      if (members.length < o.minCavity) continue;
      for (const c of members) {
        const x = c % nx, z = (c - x) / nx;
        if (o.pitch > 0 && px[x] && pz[z]) { pillars++; continue; }
        solid[off + c] = 0;
        cells[off + c] = EMPTY;
        raw[off + c] = 2;
        removed++;
      }
    }
  }
  for (let i = 0; i < raw.length; i++) raw[i] = raw[i] === 2 ? 1 : 0;
  return { removed, pillars, mask: raw };
}
