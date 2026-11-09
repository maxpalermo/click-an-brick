// Windows and arrow slits read from the mesh (part of reserve(), buildings only).
//
// The AI mesh shows openings as dark patches on the walls and / or as real recesses. Per wall direction (+x, -x, +z,
// -z) the outermost cell of every (u, y) position is looked at from outside. An opening cell is
//   - dark: luminance < 45 % of the local wall background (mean of the lit cells in a window ~3 studs x 7 plates
//     around it, so baked lighting across a face does not matter), neutral in hue, not foliage / roof / wood. The
//     luminance comes from grid.sampledRgb (the texture as sampled, when the pipeline keeps a copy before the colour
//     stage snaps grid.rgb to the palette), else grid.rgb (then only dark palette colours count); or
//   - recessed: the ray crossed a side recess of the voxelizer's recess mask (air kept because the texture behind it
//     is dark) before hitting the wall.
// Opening cells form clusters (8-connected, wall depth within 3). A cluster counts when it is compact (fills >= 45 %
// of its box), clearly darker than the ring around it (>= 1.8x, recesses exempt) and its size (studs / plates at the
// model's scale, 1 = ~32-stud model) fits:
//   arrow slit   <= 1.5 wide, 4..12 plates tall, >= 2.5x taller than wide  -> black 1x1x3 brick (14716)
//   window       1.5..3.5 wide, 4..14 plates tall                         -> castle: arched window 30044 + lattice
//                                                                            pane under an arch 1x4 (twin windows under
//                                                                            an arch 1x6x2 on big models); else a 1x2x2
//                                                                            window frame with dark glass
// Larger / longer dark areas (shadows, open courtyards, the base) are ignored; at most ~6 per face (x scale). A recess
// is closed up to the wall plane first (undone when nothing fits). Openings sit on the wall courses (bottom on a brick
// boundary from the ground), need flat wall around them (fitOpening: wall either side, a course under / over, on the
// model's main body), never double an opening already placed (analysis windows / doors), and are repeated in the
// mirror image when the model was symmetrized.

import type { PhotoAnalysis } from '../contracts';
import { C, PARTS, WINDOWS } from './library';
import { IDENT, ROTY, cellsToLd, placeBody, rotFor, xfBox, type Part } from './geom';
import { at, colourAt, inGrid, put, type Ctx } from './reserve';
import { FACES, archWindowAt, fitOpening, type Face } from './openings';
import { castleStyle, type ArchInfo } from './architecture';

export interface MeshOpeningInfo { clusters: number; slits: number; windows: number; rejected: number; recesses: number }

const xz = (f: Face, u: number, p: number): [number, number] => (f.n === 'x' ? [p, u] : [u, p]);

interface Cluster {
  f: Face; cells: [number, number][]; u0: number; u1: number; y0: number; y1: number; lum: number; ring: number;
  /** a real recess in the mesh (most cells): its air cells (x, y, z) to close before the opening part goes in */
  geo: boolean; fill: [number, number, number][];
}

export function meshOpenings(S: Ctx, a: PhotoAnalysis, arch: ArchInfo | undefined, excluded: Set<number>): MeshOpeningInfo {
  const out: MeshOpeningInfo = { clusters: 0, slits: 0, windows: 0, rejected: 0, recesses: 0 };
  const { g, bb } = S;
  // the texture as sampled (before the colour stage snapped it to the palette) when the pipeline keeps it
  const rgb = (g as { sampledRgb?: Float32Array }).sampledRgb ?? g.rgb;
  if (!rgb) return out;
  const castle = castleStyle(a);
  const scale = Math.max(1, (bb.x1 - bb.x0 + bb.z1 - bb.z0 + 2) / 56);
  const lumAt = (i: number) => 0.2126 * rgb[i * 3] + 0.7152 * rgb[i * 3 + 1] + 0.0722 * rgb[i * 3 + 2];
  const neutral = (i: number) => {
    const r = rgb[i * 3], gg = rgb[i * 3 + 1], b = rgb[i * 3 + 2];
    const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b);
    return mx < 0.02 || (mx - mn) / mx < 0.5;
  };
  // the wall colour: most common colour of the visible cells
  const cnt = new Map<number, number>();
  for (let i = 0; i < g.solid.length; i++) if (g.solid[i] && g.visible[i] && g.cells && g.cells[i] >= 0) { const c = g.paletteCodes![g.cells[i]]; cnt.set(c, (cnt.get(c) ?? 0) + 1); }
  let wall = -1, wn = 0;
  for (const [c, n] of cnt) if (n > wn) { wn = n; wall = c; }
  // the base (dark ground plates) and the first course over it are no wall: openings start above
  const yMin = bb.y0 + Math.max(6, Math.round(6 * scale));
  const clusters: Cluster[] = [];
  const recess = (g as { recess?: Uint8Array }).recess;
  // top solid layer per column: a recess cell with wall above it is a side recess (window / slit), not a walkway
  const colTop = new Int32Array(g.nx * g.nz).fill(-1);
  for (let z = 0; z < g.nz; z++) for (let x = 0; x < g.nx; x++) for (let y = g.ny - 1; y >= 0; y--) if (g.solid[at(g, x, y, z)]) { colTop[x + g.nx * z] = y; break; }
  for (const f of [FACES.px, FACES.nx, FACES.pz, FACES.nz]) {
    const U = f.n === 'x' ? g.nz : g.nx, L = f.n === 'x' ? g.nx : g.nz;
    // outermost cell per (u, y); R = 1 when the ray crossed a side recess first (front = its outermost cell)
    const P = new Int32Array(U * g.ny).fill(-1);
    const R = new Uint8Array(U * g.ny);
    const F = new Int32Array(U * g.ny).fill(-1);
    const lum = new Float32Array(U * g.ny).fill(-1);
    for (let y = yMin; y < g.ny; y++) for (let u = 0; u < U; u++) {
      let front = -1;
      for (let k = 0; k < L; k++) {
        const p = f.s > 0 ? L - 1 - k : k;
        const [x, z] = xz(f, u, p);
        const i = at(g, x, y, z);
        if (!g.solid[i]) {
          if (recess && recess[i] && !S.reserved[i] && y < colTop[x + g.nx * z]) { if (front < 0) front = p; }
          else if (front >= 0) front = -1; // air again: not one recess
          continue;
        }
        P[u + U * y] = p;
        if (front >= 0 && Math.abs(front - p) <= 3) { R[u + U * y] = 1; F[u + U * y] = front; }
        if (S.reserved[i]) break;
        const l = lumAt(i);
        if (l < 0.002 && !g.visible[i]) break; // no texture sample (cells added by the structure stage)
        lum[u + U * y] = l;
        const c = colourAt(S, x, y, z);
        // dark cells must not be foliage / roof / wood (dark greens and browns) and be neutral
        if (excluded.has(c) || !neutral(i)) lum[u + U * y] = -2;
        break;
      }
    }
    // local background: mean luminance of the lit cells in a window around (baked lighting differs across a face)
    const ru = Math.round(3 * scale), ry = Math.round(7 * scale);
    const W1 = U + 1;
    const sum = new Float64Array(W1 * (g.ny + 1)), num = new Int32Array(W1 * (g.ny + 1));
    for (let y = 0; y < g.ny; y++) for (let u = 0; u < U; u++) {
      const l = lum[u + U * y], ok = l >= 0 ? 1 : 0;
      const k = u + 1 + W1 * (y + 1);
      sum[k] = (ok ? l : 0) + sum[k - 1] + sum[k - W1] - sum[k - W1 - 1];
      num[k] = ok + num[k - 1] + num[k - W1] - num[k - W1 - 1];
    }
    const bg = (u: number, y: number) => {
      const a0 = Math.max(0, u - ru), a1 = Math.min(U - 1, u + ru), b0 = Math.max(0, y - ry), b1 = Math.min(g.ny - 1, y + ry);
      const q = (A: Float64Array | Int32Array) => A[a1 + 1 + W1 * (b1 + 1)] - A[a0 + W1 * (b1 + 1)] - A[a1 + 1 + W1 * b0] + A[a0 + W1 * b0];
      const n = q(num);
      return n >= 8 ? q(sum) / n : -1;
    };
    const dark = (u: number, y: number) => u >= 0 && u < U && y >= yMin && y < g.ny && (R[u + U * y] === 1 || (lum[u + U * y] >= 0 && lum[u + U * y] < 0.45 * bg(u, y)));
    const seen = new Uint8Array(U * g.ny);
    for (let y = yMin; y < g.ny; y++) for (let u = 0; u < U; u++) {
      if (seen[u + U * y] || !dark(u, y)) continue;
      const cells: [number, number][] = [];
      const st: [number, number][] = [[u, y]];
      seen[u + U * y] = 1;
      while (st.length) {
        const [cu, cy] = st.pop()!;
        cells.push([cu, cy]);
        for (let dy = -1; dy <= 1; dy++) for (let du = -1; du <= 1; du++) {
          const nu = cu + du, ny = cy + dy;
          if (!dark(nu, ny) || seen[nu + U * ny]) continue;
          if (Math.abs(P[nu + U * ny] - P[cu + U * cy]) > 3) continue;
          seen[nu + U * ny] = 1;
          st.push([nu, ny]);
        }
      }
      if (cells.length < 3) continue;
      let u0 = Infinity, u1 = -Infinity, y0 = Infinity, y1 = -Infinity, sl = 0, nr = 0;
      const fill: [number, number, number][] = [];
      for (const [cu, cy] of cells) {
        u0 = Math.min(u0, cu); u1 = Math.max(u1, cu); y0 = Math.min(y0, cy); y1 = Math.max(y1, cy);
        const k = cu + U * cy;
        sl += R[k] ? 0 : Math.max(0, lum[k]);
        if (R[k]) { nr++; for (let p = F[k]; p !== P[k]; p -= f.s) { const [x, z] = xz(f, cu, p); fill.push([x, cy, z]); } }
      }
      // ring: the cells right around the box
      let rs = 0, rn = 0;
      const ringP = new Map<number, number>();
      for (let cy = y0 - 1; cy <= y1 + 1; cy++) for (let cu = u0 - 1; cu <= u1 + 1; cu++) {
        if (cu >= u0 && cu <= u1 && cy >= y0 && cy <= y1) continue;
        if (cu < 0 || cu >= U || cy < 0 || cy >= g.ny) continue;
        const l = lum[cu + U * cy];
        if (l >= 0) { rs += l; rn++; }
        const pp = P[cu + U * cy];
        if (pp >= 0) ringP.set(pp, (ringP.get(pp) ?? 0) + 1);
      }
      // the wall plane around the cluster: cells of the cluster set deeper (a recess the mesh has) are closed up to it
      let plane = -1, pn = 0;
      for (const [pp, n] of ringP) if (n > pn) { pn = n; plane = pp; }
      if (plane >= 0) for (const [cu, cy] of cells) {
        const k = cu + U * cy;
        if (R[k] || P[k] < 0) continue;
        for (let pp = plane; (pp - P[k]) * f.s > 0 && Math.abs(pp - P[k]) <= 3; pp -= f.s) { const [x, z] = xz(f, cu, pp); fill.push([x, cy, z]); }
      }
      clusters.push({ f, cells, u0, u1, y0, y1, lum: sl / cells.length, ring: rn ? rs / rn : 0, geo: nr >= 0.5 * cells.length, fill });
    }
  }
  out.clusters = clusters.length;
  // classify
  type Cand = { c: Cluster; kind: 'slit' | 'window'; uc: number; yc: number; score: number };
  const cands: Cand[] = [];
  for (const c of clusters) {
    const w = (c.u1 - c.u0 + 1) / scale, h = (c.y1 - c.y0 + 1) / scale;
    const fill = c.cells.length / ((c.u1 - c.u0 + 1) * (c.y1 - c.y0 + 1));
    const contrast = c.ring / Math.max(1e-4, c.lum);
    if (fill < 0.45 || (!c.geo && contrast < 1.8) || h < 4) { if (c.cells.length >= 4) out.rejected++; continue; }
    const uc = (c.u0 + c.u1 + 1) / 2, yc = (c.y0 + c.y1 + 1) / 2;
    if (w <= 1.5 && h >= 2.5 * w && h <= 12) cands.push({ c, kind: 'slit', uc, yc, score: contrast * c.cells.length });
    else if (w > 1.5 && w <= 3.5 && h <= 14 && h >= 0.9 * w) cands.push({ c, kind: 'window', uc, yc, score: contrast * c.cells.length * 1.5 });
    else out.rejected++;
  }
  // most convincing first; at most ~6 per face at 32 studs (more on bigger models)
  cands.sort((p, q) => q.score - p.score);
  const perFace = new Map<Face, number>();
  const cap = Math.round(6 * scale);
  const mx = S.ctx.mirrorX, mz = (S.ctx as { mirrorZ?: number }).mirrorZ;
  const course = (y: number) => bb.y0 + Math.round((y - bb.y0) / 3) * 3;
  for (const cd of cands) {
    const { f } = cd.c;
    if ((perFace.get(f) ?? 0) >= cap) continue;
    // an opening already there (analysis window / door, an earlier cluster): don't double it
    if (nearTaken(S, f, cd.c.u0 - 1, cd.c.u1 + 1, cd.c.y0 - 2, cd.c.y1 + 2)) continue;
    // a real recess: close it with wall first (the opening part then sits in the wall plane), undo when nothing fits
    const undo = cd.c.fill.length ? closeRecess(S, cd.c.fill, wall) : null;
    const placed = cd.kind === 'slit' ? slitNear(S, f, Math.floor(cd.uc), cd.yc, course) : windowNear(S, f, cd.uc, cd.yc, castle, course, castle && scale >= 1.5);
    if (!placed) {
      if (undo) undo();
      continue;
    }
    if (cd.c.fill.length) out.recesses++;
    perFace.set(f, (perFace.get(f) ?? 0) + 1);
    if (cd.kind === 'slit') out.slits++; else out.windows++;
    // mirror images
    for (const [g2, u2] of mirrorImages(f, placed.u0, placed.w, mx, mz)) {
      if (nearTaken(S, g2, u2 - 1, u2 + placed.w, placed.y0 - 1, placed.y0 + placed.h)) continue;
      const ok = cd.kind === 'slit' ? slitAt(S, g2, u2, placed.y0) : windowAt(S, g2, u2, placed.y0, castle, placed.w === 4);
      if (ok) { if (cd.kind === 'slit') out.slits++; else out.windows++; }
    }
  }
  if (arch) { arch.slits += out.slits; arch.meshSlits += out.slits; arch.meshWindows += out.windows; arch.darkClusters += out.clusters; }
  return out;
}

/** Set recess air cells solid in the wall colour; returns the undo. */
function closeRecess(S: Ctx, cells: [number, number, number][], wall: number): () => void {
  const { g } = S;
  const k = g.paletteCodes?.indexOf(wall) ?? -1;
  const done: [number, number, number][] = [];
  const gc = g.cells;
  if (!gc || k < 0) return () => {};
  for (const [x, y, z] of cells) {
    const i = at(g, x, y, z);
    if (g.solid[i] || S.reserved[i]) continue;
    done.push([i, gc[i], g.visible[i]]);
    g.solid[i] = 1; gc[i] = k; g.visible[i] = 1;
  }
  return () => { for (const [i, c, v] of done) { g.solid[i] = 0; gc[i] = c; g.visible[i] = v; } };
}

function mirrorImages(f: Face, u0: number, w: number, mx?: number, mz?: number): [Face, number][] {
  const out: [Face, number][] = [];
  if (f.n === 'z') {
    if (mx !== undefined) out.push([f, 2 * mx - u0 - w]);
    if (mz !== undefined) out.push([f.s > 0 ? FACES.nz : FACES.pz, u0]);
  } else {
    if (mz !== undefined) out.push([f, 2 * mz - u0 - w]);
    if (mx !== undefined) out.push([f.s > 0 ? FACES.nx : FACES.px, u0]);
  }
  return out;
}

/** Some part already sits in the wall near this box (u0..u1, y0..y1 on face f, outermost 2 cells). */
export function nearTaken(S: Ctx, f: Face, u0: number, u1: number, y0: number, y1: number): boolean {
  const { g } = S;
  const L = f.n === 'x' ? g.nx : g.nz;
  for (let y = y0; y <= y1; y++) for (let u = u0; u <= u1; u++) {
    // scan from outside for the first solid / taken cell
    for (let k = 0; k < L; k++) {
      const p = f.s > 0 ? L - 1 - k : k;
      const [x, z] = xz(f, u, p);
      if (!inGrid(g, x, y, z)) break;
      const i = at(g, x, y, z);
      if (S.taken[i]) return true;
      if (g.solid[i]) break;
    }
  }
  return false;
}

/** Black 1x1x3 brick set flush into the wall at (u, y0) on face f, with wall on both sides. */
export function slitAt(S: Ctx, f: Face, u: number, y0: number): boolean {
  if (!S.ctx.hasPart('14716.dat')) return false;
  const pw = fitOpening(S, f, u - 1, 3, y0, 9, true);
  const p = fitOpening(S, f, u, 1, y0, 9, true);
  if (pw === null || p !== pw) return false;
  const [x, z] = xz(f, u, p);
  const sp = PARTS['14716.dat'];
  const pos = placeBody(sp, IDENT, cellsToLd(x, y0, z, x + 1, y0 + 9, z + 1));
  return put(S, [{ part: sp.id, color: C.black, pos, rot: IDENT }], [xfBox(IDENT, pos, sp.body)]);
}
function slitNear(S: Ctx, f: Face, uc: number, yc: number, course: (y: number) => number) {
  const base = course(yc - 4.5);
  for (const dy of [0, 3, -3]) for (const du of [0, 1, -1]) {
    const y0 = base + dy;
    if (slitAt(S, f, uc + du, y0)) return { u0: uc + du, w: 1, y0, h: 9 };
  }
  return null;
}

/** Window 2 wide at (u0, y0): castle = arched window + arch 1x4 over it, else the 1x2x2 frame with glass. */
export function windowAt(S: Ctx, f: Face, u0: number, y0: number, castle: boolean, twin = false): boolean {
  if (castle) return archWindowAt(S, f, u0, y0, C.transBlack, twin);
  const win = WINDOWS.find((w) => w.h === 6 && S.ctx.hasPart(w.frame) && S.ctx.hasPart(w.glass));
  if (!win) return false;
  const pw = fitOpening(S, f, u0 - 1, 4, y0, win.h, true);
  const p = fitOpening(S, f, u0, 2, y0, win.h, true);
  if (pw === null || p !== pw) return false;
  const R = ROTY[rotFor([0, 0, -1], f.d)];
  const [xa, za] = xz(f, u0, p), [xb, zb] = xz(f, u0 + 1, p);
  const box = cellsToLd(Math.min(xa, xb), y0, Math.min(za, zb), Math.max(xa, xb) + 1, y0 + win.h, Math.max(za, zb) + 1);
  const pos = placeBody(PARTS[win.frame], R, box);
  const ps: Part[] = [{ part: win.frame, color: C.white, pos, rot: R }, { part: win.glass, color: C.transBlack, pos, rot: R }];
  if (!put(S, ps, [xfBox(R, pos, PARTS[win.frame].body), xfBox(R, pos, PARTS[win.glass].body)], [0, 0])) return false;
  S.info.windows++;
  return true;
}
function windowNear(S: Ctx, f: Face, uc: number, yc: number, castle: boolean, course: (y: number) => number, twin: boolean) {
  const h = castle ? 8 : 6;
  const base = course(yc - h / 2);
  for (const tw of twin ? [true, false] : [false]) {
    const w = tw ? 4 : 2;
    const u00 = Math.round(uc - w / 2);
    for (const dy of [0, 3, -3, 6]) for (const du of [0, 1, -1, 2, -2]) {
      const y0 = base + dy;
      if (windowAt(S, f, u00 + du, y0, castle, tw)) return { u0: u00 + du, w: tw && castle ? 4 : 2, y0, h };
    }
  }
  return null;
}
