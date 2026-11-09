// reserve(): carve regions of the voxel grid for special parts (wheels, windscreens, lights, eyes, side windows,
// facade windows / doors — see openings.ts) and place them.
// Parts come back in the GRID FRAME (see geom.ts); reserved = 1 for every cell a part occupies plus carved air
// (wheel wells / wheel-blob clearance). Every placed part's body box lies inside reserved cells, so the packer
// can never overlap it.

import type { Mat3 } from '../../../model/types';
import type { PhotoAnalysis, PhotoFeature, PhotoStructure, ReserveResult, SpecialContext } from '../contracts';
import type { VoxelGrid } from '../voxelize';
import { COMMON_COLORS, ColorMatcher, hexToLinear, type PaletteColor } from '../color';
import { C, PARTS, WHEEL_TIERS, SLOPE45_BY_WIDTH, type Box, type WheelTier } from './library';
import { ROTY, cellsToLd, cleanM, ldToCells, mulM, placeBody, rotFor, spec, xfBox, type Part, type V3 } from './geom';
import { BUILDINGS, buildingOpenings, sideWindows } from './openings';
import { architectureAfter, architectureBefore, castleStyle, emptyArchInfo, nonWallCodes, type ArchInfo } from './architecture';
import { meshOpenings } from './wallopenings';
import { emptyStructuresInfo, placeStructures, structureFeatures, type StructuresInfo } from './structures';

const VEHICLES = /\b(car|truck|bus|van|vehicle|tractor|jeep|lorry|taxi|ambulance|fire.?truck|race.?car|pickup|suv|train|locomotive|tank)\b/i;
const CREATURES = /\b(animal|bird|duck|dog|cat|fish|figure|person|robot|owl|bear|rabbit|bunny|frog|horse|cow|pig|chicken|penguin|dinosaur|toy)\b/i;

export interface ReserveInfo {
  vehicle: boolean;
  wheelTier?: string;
  wheels: number;
  windscreen?: string;
  lights: number;
  eyes: number;
  /** window frames (with glass) and doors set into walls */
  windows: number;
  doors: number;
  lengthAxis?: 'x' | 'z';
  front?: 1 | -1;
  /** buildings: roofs, battlements, arches, arrow slits, foliage (architecture.ts) */
  arch?: ArchInfo;
  /** structures-first build order (structures.ts, SpecialContext.structuresFirst) */
  structures?: StructuresInfo;
  notes: string[];
}

/** Optional extras of the structure pipeline's grid (pipeline.ts StructureGrid). */
export interface SpecialGrid extends VoxelGrid {
  cells?: Int16Array;
  paletteCodes?: number[];
  frame?: { cx: number; cz: number; y0: number };
  mirror?: { x?: number; z?: number };
}

export interface Ctx {
  g: SpecialGrid;
  ctx: SpecialContext;
  reserved: Uint8Array;
  /** cells occupied by a placed part (subset of reserved) */
  taken: Uint8Array;
  parts: Part[];
  info: ReserveInfo;
  bb: { x0: number; x1: number; y0: number; y1: number; z0: number; z1: number };
  /** largest 6-connected solid component (lazy, see inMain) */
  main?: Uint8Array;
}

/**
 * Cell belongs to the model's largest connected solid component (as it was the first time this is asked). Openings
 * only go into that body: a loose sliver of the mesh is dropped by the structure stage later, with the part in it.
 */
export function inMain(S: Ctx, x: number, y: number, z: number): boolean {
  const { g } = S;
  if (!inGrid(g, x, y, z)) return false;
  if (!S.main) {
    const N = g.nx * g.ny * g.nz;
    const lab = new Int32Array(N).fill(-1);
    let best = -1, bestN = 0, id = 0;
    const st: number[] = [];
    for (let s = 0; s < N; s++) {
      if (!g.solid[s] || lab[s] >= 0) continue;
      let n = 0;
      lab[s] = id; st.push(s);
      while (st.length) {
        const i = st.pop()!;
        n++;
        const x0 = i % g.nx, z0 = Math.floor(i / g.nx) % g.nz, y0 = Math.floor(i / (g.nx * g.nz));
        const nb = [x0 > 0 ? i - 1 : -1, x0 < g.nx - 1 ? i + 1 : -1, z0 > 0 ? i - g.nx : -1, z0 < g.nz - 1 ? i + g.nx : -1,
          y0 > 0 ? i - g.nx * g.nz : -1, y0 < g.ny - 1 ? i + g.nx * g.nz : -1];
        for (const j of nb) if (j >= 0 && g.solid[j] && lab[j] < 0) { lab[j] = id; st.push(j); }
      }
      if (n > bestN) { bestN = n; best = id; }
      id++;
    }
    S.main = new Uint8Array(N);
    for (let i = 0; i < N; i++) if (lab[i] === best) S.main[i] = 1;
  }
  return S.main[at(g, x, y, z)] === 1;
}

export function reserveImpl(g: SpecialGrid, ctx: SpecialContext): ReserveResult & { info: ReserveInfo } {
  const N = g.nx * g.ny * g.nz;
  const S: Ctx = {
    g, ctx, reserved: new Uint8Array(N), taken: new Uint8Array(N), parts: [],
    info: { vehicle: false, wheels: 0, lights: 0, eyes: 0, windows: 0, doors: 0, notes: [] },
    bb: solidBox(g),
  };
  if (S.bb.x1 < S.bb.x0) return { reserved: S.reserved, parts: [], info: S.info };
  const a = ctx.analysis;
  const cat = a?.category ?? '';
  const wantsWheels = VEHICLES.test(cat) || (a?.features ?? []).some((f) => f.kind === 'wheel' && f.confidence >= 0.5);
  if (wantsWheels && ctx.mode === 'object' || wantsWheels && ctx.mode === 'lego') {
    S.info.vehicle = true;
    try { vehicle(S, a); } catch (e) { S.info.notes.push(`vehicle: ${(e as Error).message}`); }
  }
  if (!S.info.vehicle && ctx.structuresFirst && a?.structures?.length) {
    // structures-first (structures.ts): the vision's structures are built from recipes; doors, roofs and leftover
    // windows reach the existing rules as features, ahead of the older feature boxes
    const castle = castleStyle(a) || a.structures.some((s) => s.kind === 'battlements' || s.kind === 'tower');
    const arch = S.info.arch = { ...emptyArchInfo(), castle };
    const st = S.info.structures = emptyStructuresInfo();
    let left: PhotoStructure[] = [];
    let a2: PhotoAnalysis = a;
    try {
      a2 = { ...a, features: [...structureFeatures(a, [], st), ...a.features] };
      architectureBefore(S, a2, arch);
    } catch (e) { S.info.notes.push(`architecture: ${(e as Error).message}`); }
    try { left = placeStructures(S, a, castle, st); } catch (e) { S.info.notes.push(`structures: ${(e as Error).message}`); }
    const extra = structureFeatures({ ...a, structures: [] }, left, st);
    const a3: PhotoAnalysis = { ...a2, features: [...a2.features.filter((f) => f.kind !== 'window'), ...extra, ...a2.features.filter((f) => f.kind === 'window')] };
    try { buildingOpenings(S, a3); } catch (e) { S.info.notes.push(`openings: ${(e as Error).message}`); }
    try { meshOpenings(S, a3, arch, nonWallCodes(S, a3)); } catch (e) { S.info.notes.push(`mesh openings: ${(e as Error).message}`); }
    try { architectureAfter(S, a3, arch); } catch (e) { S.info.notes.push(`architecture: ${(e as Error).message}`); }
  } else if (!S.info.vehicle && BUILDINGS.test(cat) && a) {
    const arch = S.info.arch = { ...emptyArchInfo(), castle: castleStyle(a) };
    try { architectureBefore(S, a, arch); } catch (e) { S.info.notes.push(`architecture: ${(e as Error).message}`); }
    try { buildingOpenings(S, a); } catch (e) { S.info.notes.push(`openings: ${(e as Error).message}`); }
    try { meshOpenings(S, a, arch, nonWallCodes(S, a)); } catch (e) { S.info.notes.push(`mesh openings: ${(e as Error).message}`); }
    try { architectureAfter(S, a, arch); } catch (e) { S.info.notes.push(`architecture: ${(e as Error).message}`); }
  }
  if (CREATURES.test(cat) && a) {
    try { eyes(S, a); } catch (e) { S.info.notes.push(`eyes: ${(e as Error).message}`); }
  }
  // grid frame -> model frame when the pipeline gave us its LDraw transform (pipeline.ts StructureGrid.frame)
  const f = g.frame;
  const parts = f ? S.parts.map((p) => ({ ...p, pos: [c0(p.pos[0] - f.cx * 20), c0(p.pos[1] + f.y0 * 8), c0(p.pos[2] + f.cz * 20)] as V3 })) : S.parts;
  return { reserved: S.reserved, parts, info: S.info };
}
const c0 = (v: number) => { const r = Math.round(v * 1000) / 1000; return Object.is(r, -0) ? 0 : r; };

/** Carve a cell to air: with the pipeline's colour grid the cell is emptied directly (so connectivity repair does
 * not treat the air as a rigid special part), otherwise it is reserved. */
export function carve(S: Ctx, i: number) {
  if (S.g.cells) { S.g.cells[i] = -2; S.g.solid[i] = 0; } else S.reserved[i] = 1;
}

// ------------------------------------------------------------------ helpers

function solidBox(g: VoxelGrid) {
  const b = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity, z0: Infinity, z1: -Infinity };
  const { nx, ny, nz, solid } = g;
  for (let y = 0, i = 0; y < ny; y++) for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++, i++) {
    if (!solid[i]) continue;
    if (x < b.x0) b.x0 = x; if (x > b.x1) b.x1 = x;
    if (y < b.y0) b.y0 = y; if (y > b.y1) b.y1 = y;
    if (z < b.z0) b.z0 = z; if (z > b.z1) b.z1 = z;
  }
  return b;
}

export const inGrid = (g: VoxelGrid, x: number, y: number, z: number) => x >= 0 && y >= 0 && z >= 0 && x < g.nx && y < g.ny && z < g.nz;
export const at = (g: VoxelGrid, x: number, y: number, z: number) => x + g.nx * (z + g.nz * y);
export const isSolid = (g: VoxelGrid, x: number, y: number, z: number) => inGrid(g, x, y, z) && g.solid[at(g, x, y, z)] === 1;

function take(S: Ctx, b: Box) {
  const [x0, y0, z0, x1, y1, z1] = ldToCells(b);
  for (let y = y0; y < y1; y++) for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) {
    if (!inGrid(S.g, x, y, z)) continue;
    const i = at(S.g, x, y, z);
    S.taken[i] = 1; S.reserved[i] = 1;
  }
}

/**
 * Place parts atomically. boxes = body boxes; boxes sharing a group id (e.g. a rim and its tyre) may overlap each
 * other, all others must not share a cell with each other or with parts placed earlier. False = nothing placed.
 */
export function put(S: Ctx, ps: Part[], boxes: Box[], groups?: number[]): boolean {
  const own = new Map<number, number>(); // cell -> group within this call
  for (let k = 0; k < boxes.length; k++) {
    const grp = groups?.[k] ?? -1 - k;
    const [x0, y0, z0, x1, y1, z1] = ldToCells(boxes[k]);
    for (let y = y0; y < y1; y++) for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) {
      if (!inGrid(S.g, x, y, z)) continue;
      const i = at(S.g, x, y, z);
      if (S.taken[i]) return false;
      const o = own.get(i);
      if (o !== undefined && o !== grp) return false;
      own.set(i, grp);
    }
  }
  for (const b of boxes) take(S, b);
  for (const p of ps) S.parts.push({ ...p, rot: cleanM(p.rot) });
  return true;
}

function paletteColours(ctx: SpecialContext): PaletteColor[] {
  const set = new Set(ctx.palette);
  const pal = COMMON_COLORS.filter((c) => set.has(c.code));
  return pal.length ? pal : COMMON_COLORS;
}
export function colourAt(S: Ctx, x: number, y: number, z: number): number {
  const ci = S.g.cells?.[at(S.g, x, y, z)];
  if (ci !== undefined && ci >= 0 && S.g.paletteCodes?.[ci] !== undefined) return S.g.paletteCodes[ci];
  const pal = paletteColours(S.ctx);
  const m = new ColorMatcher(pal, 'ciede2000');
  const i = at(S.g, x, y, z);
  return pal[m.match(S.g.rgb[i * 3], S.g.rgb[i * 3 + 1], S.g.rgb[i * 3 + 2])].code;
}
/** Nearest transparent colour for a feature tint. */
function transFor(hex: string | undefined, fallback: number): number {
  if (!hex || !/^#[0-9a-f]{6}$/i.test(hex)) return fallback;
  const [r, g, b] = hexToLinear(hex);
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  if (r > 0.25 && r > g * 2 && r > b * 2) return C.transRed;
  if (r > 0.3 && g > 0.2 && b < g * 0.5) return lum > 0.5 ? C.transYellow : C.transOrange;
  if (lum < 0.04) return C.transBlack;
  if (b > r * 1.3 && b > 0.08) return C.transLightBlue;
  return C.transClear;
}

// ------------------------------------------------------------------ vehicles

/** Axis helper: width axis 'x' or 'z'; (w, l) <-> (x, z). */
export interface Axes {
  width: 'x' | 'z';
  w0: number; w1: number; l0: number; l1: number;
  /** cell mirror across the width centre plane */
  mw: (w: number) => number;
  /** mirror plane in LDU along the width axis (grid coordinate * 20) */
  planeLdu: number;
  xz: (w: number, l: number) => [number, number];
  /** grid direction index of +width / +length */
  dW: number; dL: number;
  /** LDraw world point from (width LDU, y-up LDU, length LDU) in grid units */
  ld: (wL: number, yUp: number, lL: number) => V3;
}

function axesFor(S: Ctx): Axes {
  const { bb, ctx } = S;
  const ex = bb.x1 - bb.x0 + 1, ez = bb.z1 - bb.z0 + 1;
  const mz = (ctx as { mirrorZ?: number }).mirrorZ;
  // a vehicle is longer than wide: when one horizontal extent is clearly the longer one it is the length, whatever
  // mirror plane the symmetry stage found (a front-back symmetric body like a 2CV can be mirrored across its length)
  const clear = Math.max(ex, ez) >= 1.25 * Math.min(ex, ez);
  const width: 'x' | 'z' = clear ? (ex < ez ? 'x' : 'z')
    : ctx.mirrorX !== undefined && (mz === undefined || ex <= ez) ? 'x' : mz !== undefined ? 'z' : ex <= ez ? 'x' : 'z';
  const [w0, w1, l0, l1] = width === 'x' ? [bb.x0, bb.x1, bb.z0, bb.z1] : [bb.z0, bb.z1, bb.x0, bb.x1];
  // mirror plane (cell-boundary coordinate): the symmetry plane across the width when there is one, else the centre
  const plane = width === 'x' && ctx.mirrorX !== undefined ? ctx.mirrorX : width === 'z' && mz !== undefined ? mz : (w0 + w1 + 1) / 2;
  const c2 = 2 * plane - 1;
  return {
    width, w0, w1, l0, l1,
    mw: (w) => c2 - w,
    planeLdu: plane * 20,
    xz: (w, l) => (width === 'x' ? [w, l] : [l, w]),
    dW: width === 'x' ? 0 : 2, dL: width === 'x' ? 2 : 0,
    ld: (wL, yUp, lL) => (width === 'x' ? [wL, -yUp, -lL] : [lL, -yUp, -wL]),
  };
}

function vehicle(S: Ctx, a?: PhotoAnalysis) {
  const A = axesFor(S);
  S.info.lengthAxis = A.width === 'x' ? 'z' : 'x';
  const { g, bb } = S;
  const lenStuds = A.l1 - A.l0 + 1, widStuds = A.w1 - A.w0 + 1;
  if (lenStuds < 6 || widStuds < 3) { S.info.notes.push('too small for wheels'); return; }

  // ---- body bottom: first layer whose footprint is at least 45% of the widest layer ----
  const count: number[] = [];
  for (let y = bb.y0; y <= bb.y1; y++) {
    let n = 0;
    for (let z = bb.z0; z <= bb.z1; z++) for (let x = bb.x0; x <= bb.x1; x++) n += g.solid[at(g, x, y, z)];
    count.push(n);
  }
  const maxN = Math.max(...count);
  let yb = bb.y0;
  while (yb < bb.y1 && count[yb - bb.y0] < 0.45 * maxN) yb++;
  if (yb - bb.y0 > (bb.y1 - bb.y0) / 2) yb = bb.y0; // nonsense: no clear body bottom

  // ---- wheel blobs below the body bottom: clusters along the length axis ----
  const occ = new Uint8Array(lenStuds);
  for (let y = bb.y0; y < yb; y++) for (let l = A.l0; l <= A.l1; l++) for (let w = A.w0; w <= A.w1; w++) {
    const [x, z] = A.xz(w, l);
    if (isSolid(g, x, y, z)) occ[l - A.l0] = 1;
  }
  const runs: [number, number][] = [];
  for (let i = 0; i < lenStuds; ) {
    if (!occ[i]) { i++; continue; }
    let j = i;
    while (j + 1 < lenStuds && occ[j + 1]) j++;
    runs.push([A.l0 + i, A.l0 + j]);
    i = j + 1;
  }
  let centres: number[] = []; // cell-boundary coordinates along the length (LDU / 20)
  let chord = 0;
  const blobH = (yb - bb.y0) * 8;
  if (runs.length >= 2 && blobH > 0) {
    const two = [...runs].sort((p, q) => q[1] - q[0] - (p[1] - p[0])).slice(0, 2).sort((p, q) => p[0] - q[0]);
    centres = two.map(([p, q]) => (p + q + 1) / 2);
    chord = Math.max(...two.map(([p, q]) => (q - p + 1) * 20));
  }

  // ---- tier: wheel diameter from the blob chord (circle cut at blob height) or from the length ----
  let est: number;
  if (chord > 0) {
    const h = Math.max(8, blobH);
    est = Math.min(2 * ((chord * chord) / 4 + h * h) / (2 * h), 0.3 * lenStuds * 20);
  } else est = 0.17 * lenStuds * 20;
  const heightLdu = (bb.y1 - bb.y0 + 1) * 8;
  est = Math.min(est, 0.6 * heightLdu);
  const fits = (t: WheelTier) => S.ctx.hasPart(t.rim) && S.ctx.hasPart(t.tyre) && widStuds >= minWidth(t) && t.dia <= lenStuds * 20 * 0.42;
  const tiers = WHEEL_TIERS.filter(fits);
  if (!tiers.length) { S.info.notes.push('no wheel tier fits'); return; }
  let pickI = 0;
  tiers.forEach((t, k) => { if (t.dia <= est * 1.15) pickI = k; });
  const centres0 = centres;
  /** Place both axles with one tier; all or nothing (a car with two wheels is worse than smaller wheels). */
  const fitted = new Map<WheelTier, number>();
  const tryTier = (tier: WheelTier, partial = false): boolean => {
    const R = tier.dia / 2;
    let cs = centres0;
    if (cs.length !== 2) {
      const m = R / 20 + 0.6;
      cs = [A.l0 + Math.max(m, 0.2 * lenStuds), A.l1 + 1 - Math.max(m, 0.2 * lenStuds)];
    }
    cs = cs.map((c) => Math.round(c));
    if ((cs[1] - cs[0]) * 20 < tier.dia + 20) { S.info.notes.push(`${tier.name}: wheels would collide`); return false; }
    // vertical placement: wheel bottom on the ground (lowest layer)
    const ground = bb.y0 * 8;
    const off = tier.mount === 'pin' ? 6 : 10; // axle below the holder top
    let top = Math.round((ground + R + off) / 8);
    if (top * 8 - off - R < ground - 2) top++;
    const axleY = top * 8 - off;
    const snap = { n: S.parts.length, taken: S.taken.slice(), reserved: S.reserved.slice() };
    // per wheel: outer column = outermost body column over the wheel's length span
    let placed = 0;
    for (const lc of cs) {
      const la = Math.floor(lc - R / 20), lb = Math.ceil(lc + R / 20) - 1;
      let wo = -Infinity;
      for (let l = la; l <= lb; l++) for (let y = bb.y0; y <= bb.y1; y++) for (let w = A.w0; w <= A.w1; w++) {
        const [x, z] = A.xz(w, l);
        if (isSolid(g, x, y, z)) { wo = Math.max(wo, w, A.mw(w)); }
      }
      if (!Number.isFinite(wo)) continue;
      if (wheelPair(S, A, tier, wo, lc, axleY)) placed += 2;
    }
    fitted.set(tier, placed);
    if (placed === 4 || (partial && placed > 0)) { S.info.wheelTier = tier.name; S.info.wheels = placed; return true; }
    S.parts.length = snap.n; S.taken.set(snap.taken); S.reserved.set(snap.reserved);
    S.info.notes.push(`${tier.name}: ${placed} wheels fitted`);
    return false;
  };
  // the estimated tier first, then smaller ones, then larger ones
  const order = [...tiers.slice(0, pickI + 1).reverse(), ...tiers.slice(pickI + 1)];
  if (!order.some((t) => tryTier(t))) {
    // no tier fits both axles: the tier that fitted most (one axle beats none)
    const best = order.reduce((b, t) => ((fitted.get(t) ?? 0) > (fitted.get(b) ?? 0) ? t : b), order[0]);
    if (!(fitted.get(best) ?? 0) || !tryTier(best, true)) { S.info.notes.push('no wheel fitted'); return; }
  }

  // ---- clearance: blob voxels below the body that no wheel uses become air ----
  for (let y = bb.y0; y < yb; y++) for (let z = bb.z0; z <= bb.z1; z++) for (let x = bb.x0; x <= bb.x1; x++) {
    const i = at(g, x, y, z);
    if (g.solid[i] && !S.taken[i]) carve(S, i);
  }

  // ---- wheel arches: body cells in a tyre's own columns right in front of / behind it (up to its top) become air;
  // they would be slivers standing on nothing beside the tyre ----
  for (const p of S.parts) {
    if (PARTS[p.part]?.kind !== 'tyre') continue;
    const [x0, y0, z0, x1, y1, z1] = ldToCells(xfBox(p.rot, p.pos, PARTS[p.part].body));
    const ex = A.width === 'z' ? 1 : 0, ez = A.width === 'x' ? 1 : 0; // grow along the length axis
    for (let y = Math.max(0, y0); y < y1; y++) for (let z = z0 - ez; z < z1 + ez; z++) for (let x = x0 - ex; x < x1 + ex; x++) {
      if (!inGrid(g, x, y, z)) continue;
      const i = at(g, x, y, z);
      if (g.solid[i] && !S.reserved[i]) carve(S, i);
    }
  }

  // ---- front / back, windscreen, lights ----
  const front = frontDir(S, A);
  S.info.front = front;
  try { windscreen(S, A, front, a); } catch (e) { S.info.notes.push(`windscreen: ${(e as Error).message}`); }
  try { lights(S, A, front, a); } catch (e) { S.info.notes.push(`lights: ${(e as Error).message}`); }
  try { sideWindows(S, A, yb, a); } catch (e) { S.info.notes.push(`side windows: ${(e as Error).message}`); }
}

function minWidth(t: WheelTier): number {
  return t.name === 'S' || t.name === 'M' ? 4 : t.name === 'XXL' ? 8 : 6;
}

/** Place the left + right wheel assemblies for one axle. wo = outermost body column on the + side. */
function wheelPair(S: Ctx, A: Axes, t: WheelTier, wo: number, lc: number, axleY: number): boolean {
  const L = lc * 20; // length coordinate of the axle (LDU)
  const ps: Part[] = [], boxes: Box[] = [], groups: number[] = [];
  let grp = 0;
  const add = (p: Part, b: Box | null, g = grp++) => { ps.push(p); if (b) { boxes.push(b); groups.push(g); } };
  const rotAxis = (local: V3, dir: number): Mat3 => ROTY[rotFor(local, dir)];
  // cells between the two wheel columns (S / L / XL use column wo for the wheel)
  const between = Math.round((2 * (wo * 20 - A.planeLdu)) / 20);
  if (S.info.notes.length < 30 && (t.mount === 'pin' ? between < 2 || between === 3 : between < (t.name === 'XXL' ? 6 : 4))) S.info.notes.push(`${t.name} axle at ${lc}: ${between} cells between the wheels`);
  const two = t.mount === 'pin' && between === 2; // one 4600 with pins on both sides
  if (t.mount === 'pin' && between < 2) return false;
  if (t.mount === 'pin' && between === 3) return false; // two 4488 would overlap, 4600 cannot be centred
  // odd body width (mirror plane through a cell centre): one Technic brick on the centre column, one long axle across
  const odd = t.mount === 'axle' && between % 2 === 1 && t.name !== 'XXL';
  if (t.mount === 'axle' && !odd && between < (t.name === 'XXL' ? 6 : 4)) return false;
  if (odd && between < 3) return false;
  const oddAxle = odd ? AXLES.find(([, half]) => half >= (wo * 20 + 10 - A.planeLdu) - 2 && half <= (wo * 20 + 10 - A.planeLdu) + 12) : undefined;
  if (odd && (!oddAxle || !S.ctx.hasPart(oddAxle[0]))) return false;
  const wheel = (wC: number, dir: number, rimOut: 1 | -1, tyreOut: 1 | -1) => {
    const R = rotAxis([0, 0, rimOut], dir), Rt = rotAxis([0, 0, tyreOut], dir);
    const c = A.ld(wC, axleY, L);
    const tz = mulZ(R, t.tyreZ);
    const tc: V3 = [c[0] + tz[0], c[1], c[2] + tz[2]];
    const g = grp++;
    add({ part: t.rim, color: C.lbg, pos: c, rot: R }, xfBox(R, c, PARTS[t.rim].body), g);
    add({ part: t.tyre, color: C.black, pos: tc, rot: Rt }, xfBox(Rt, tc, PARTS[t.tyre].body), g);
  };
  for (const sgn of [1, -1] as const) {
    const dir = sgn > 0 ? A.dW : A.dW + 1;
    const out = (w: number) => (sgn > 0 ? w : 2 * A.planeLdu - w);
    if (t.mount === 'pin') {
      // S: holder in columns wo-2..wo-1, wheel centred on column wo (models/car.ldr: wheel 30 LDU from holder centre)
      // M: same holder, 6014b hub against the holder edge -> rim origin 40 LDU out, tyre 8 LDU past column wo
      const hc = (wo - 1) * 20;
      const wC = t.name === 'S' ? hc + 30 : hc + 40;
      if (!two || sgn > 0) {
        const holder = two ? '4600.dat' : '4488.dat';
        if (!S.ctx.hasPart(holder)) return false;
        const Rh = rotAxis([1, 0, 0], dir); // 4488 pin (local +X) points outwards
        const target = boxFromCentre(A, two ? A.planeLdu : out(hc), L, 40, 40, axleY + 6 - 8, axleY + 6);
        const hp = placeBody(PARTS[holder], Rh, target);
        add({ part: holder, color: C.dbg, pos: hp, rot: Rh }, xfBox(Rh, hp, PARTS[holder].body));
      }
      if (t.name === 'S') wheel(out(wC), dir, -1, -1); // rim +Z inwards, as in LDraw models/car.ldr
      else wheel(out(wC), dir, 1, 1); // 6014b hub (-Z) against the holder
    } else {
      if (odd) {
        // centre brick + axle once; bushes fill the columns between the brick and the wheel (the axle runs through them)
        const Rb = rotAxis([0, 0, 1], dir);
        if (sgn > 0) {
          const bp = placeBody(PARTS['3700.dat'], Rb, boxFromCentre(A, A.planeLdu, L, 20, 40, axleY + 10 - 24, axleY + 10));
          add({ part: '3700.dat', color: C.dbg, pos: bp, rot: Rb }, xfBox(Rb, bp, PARTS['3700.dat'].body));
          add({ part: oddAxle![0], color: C.black, pos: A.ld(A.planeLdu, axleY, L), rot: rotAxis([1, 0, 0], dir) }, null);
        }
        for (let w = Math.ceil(A.planeLdu / 20); w < wo; w++) {
          const bush = A.ld(out((w + 0.5) * 20), axleY, L);
          add({ part: '3713.dat', color: C.lbg, pos: bush, rot: Rb }, xfBox(Rb, bush, PARTS['3713.dat'].body));
        }
        wheel(out((wo + 0.5) * 20), dir, 1, t.name === 'XL' ? -1 : 1);
        continue;
      }
      // Technic brick 1x2 with its hole across the car, axle through brick + wheel, bush on the inside
      const brickCol = t.name === 'XXL' ? wo - 2 : wo - 1;
      const bc = (brickCol + 0.5) * 20;
      const Rb = rotAxis([0, 0, 1], dir);
      const bp = placeBody(PARTS['3700.dat'], Rb, boxFromCentre(A, out(bc), L, 20, 40, axleY + 10 - 24, axleY + 10));
      add({ part: '3700.dat', color: C.dbg, pos: bp, rot: Rb }, xfBox(Rb, bp, PARTS['3700.dat'].body));
      const bush = A.ld(out(bc - 20), axleY, L);
      add({ part: '3713.dat', color: C.lbg, pos: bush, rot: Rb }, xfBox(Rb, bush, PARTS['3713.dat'].body));
      const axle = t.name === 'XXL' ? '3705.dat' : '4519.dat';
      const Ra = rotAxis([1, 0, 0], dir);
      add({ part: axle, color: C.black, pos: A.ld(out(t.name === 'XXL' ? bc + 9.5 : bc), axleY, L), rot: Ra }, null);
      if (t.name === 'XXL') wheel(out(bc + 30), dir, 1, 1); // 56904 hub (-Z) against the brick
      else if (t.name === 'XL') wheel(out(bc + 20), dir, 1, -1); // 2346 offset tread (-Z) outwards
      else wheel(out(bc + 20), dir, 1, 1);
    }
  }
  if (put(S, ps, boxes, groups)) return true;
  if (S.info.notes.length < 30) S.info.notes.push(`${t.name} axle at ${lc}: blocked (between ${between})`);
  return false;
}

/** Technic axles by half length (LDU), for the one-axle-across mount of odd-width bodies. */
const AXLES: [string, number][] = [['4519.dat', 29.5], ['3705.dat', 39.5], ['32073.dat', 49.5], ['3706.dat', 59.5], ['44294.dat', 69.5], ['3707.dat', 79.5]];

const mulZ = (R: Mat3, z: number): V3 => [R[2] * z, R[5] * z, R[8] * z];

/** World box centred at (width wC, length lC) LDU with sizes along width / length, spanning y-up [yLo, yHi]. */
function boxFromCentre(A: Axes, wC: number, lC: number, sizeW: number, sizeL: number, yLo: number, yHi: number): Box {
  const p = A.ld(wC - sizeW / 2, yLo, lC - sizeL / 2), q = A.ld(wC + sizeW / 2, yHi, lC + sizeL / 2);
  return [Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.min(p[2], q[2]), Math.max(p[0], q[0]), Math.max(p[1], q[1]), Math.max(p[2], q[2])];
}

/** Top layer (y index) per length position, over the central half of the width. -1 = empty. */
export function heightProfile(S: Ctx, A: Axes): number[] {
  const { g, bb } = S;
  const out: number[] = [];
  const wq0 = Math.round(A.w0 + (A.w1 - A.w0) * 0.25), wq1 = Math.round(A.w0 + (A.w1 - A.w0) * 0.75);
  for (let l = A.l0; l <= A.l1; l++) {
    let h = -1;
    for (let w = wq0; w <= wq1; w++) for (let y = bb.y1; y > h; y--) {
      const [x, z] = A.xz(w, l);
      if (isSolid(g, x, y, z)) { h = y; break; }
    }
    out.push(h);
  }
  return out;
}

/** +1 when the front (hood) is at the high end of the length axis, -1 at the low end. */
function frontDir(S: Ctx, A: Axes): 1 | -1 {
  const H = heightProfile(S, A);
  const top = Math.max(...H);
  const cab = H.map((h) => h >= top - 2);
  const c0 = cab.indexOf(true), c1 = cab.lastIndexOf(true);
  const rear = c0, frontLen = H.length - 1 - c1;
  return frontLen >= rear ? 1 : -1;
}

function windscreen(S: Ctx, A: Axes, front: 1 | -1, a?: PhotoAnalysis) {
  const feat = a?.features.find((f) => f.kind === 'windscreen');
  if (a && !feat && !a.features.some((f) => f.kind === 'window')) { S.info.notes.push('no windscreen in analysis'); return; }
  const colour = transFor(feat?.color, C.transClear);
  const H = heightProfile(S, A);
  const top = Math.max(...H);
  // cabin front face: the roof position (height within 2 of the top) furthest towards the front
  const order = H.map((_, i) => i);
  if (front < 0) order.reverse();
  let cf = -1;
  for (const i of order) if (H[i] >= top - 2) cf = i;
  if (cf < 0) return;
  const hoodI = cf + front * 2 >= 0 && cf + front * 2 < H.length ? cf + front * 2 : cf + front;
  if (hoodI < 0 || hoodI >= H.length || H[hoodI] < 0) { S.info.notes.push('no hood in front of the cabin'); return; }
  const hood = H[hoodI];
  const rise = H[cf] - hood; // plates of cabin above the hood
  const lCab = A.l0 + cf;
  const yB = hood + 1; // windscreen bottom layer (sits on the hood)
  // cabin width (symmetric, cells) at mid windscreen height
  let wMax = -Infinity;
  for (let w = A.w0; w <= A.w1; w++) { const [x, z] = A.xz(w, lCab); if (isSolid(S.g, x, yB + 2, z)) wMax = Math.max(wMax, w, A.mw(w)); }
  if (!Number.isFinite(wMax)) return;
  const cabinW = Math.round(2 * (wMax + 1 - A.planeLdu / 20));
  const dirFront = front > 0 ? A.dL : A.dL + 1;
  if (!tryWithBack(S, A, front, lCab, yB, rise, cabinW, colour, dirFront))
    S.info.notes.push(`windscreen did not fit (cabin ${cabinW} wide, ${rise} plates above the hood)`);
}

/** Windscreen with its studded back row on the cabin column `lCab` and sloped row(s) towards the front. */
function tryWithBack(S: Ctx, A: Axes, front: 1 | -1, lCab: number, yB: number, rise: number, cabinW: number, colour: number, dirFront: number): boolean {
  const R = ROTY[rotFor([0, 0, -1], dirFront)];
  const cands: [string, number, number, number][] = [['4176.dat', 6, 2, 6], ['3823.dat', 4, 2, 6], ['2437.dat', 4, 3, 4]];
  for (const [id, width, depth, plates] of cands) {
    if (!S.ctx.hasPart(id) || width > cabinW - 2 || (cabinW - width) % 2 !== 0 || rise < plates) continue;
    const l1 = lCab + front * (depth - 1);
    const lLo = Math.min(lCab, l1), lHi = Math.max(lCab, l1) + 1;
    const target = boxW(A, A.planeLdu - width * 10, A.planeLdu + width * 10, yB * 8, (yB + plates) * 8, lLo * 20, lHi * 20);
    const pos = placeBody(PARTS[id], R, target);
    if (!heldFromBelow(S, xfBox(R, pos, PARTS[id].body))) continue;
    if (put(S, [{ part: id, color: colour, pos, rot: R }], [xfBox(R, pos, PARTS[id].body)])) { S.info.windscreen = id; return true; }
  }
  // odd cabin width: two stepped rows of transparent 45° slopes (palindromic widths), 3 plates each
  const width = cabinW - 2;
  // a sliver of glass on a roof edge is worse than none: at least 2 studs and 40 % of the body width
  if (width < Math.max(2, Math.round(0.4 * (A.w1 - A.w0 + 1))) || rise < 3) return false;
  const pieces = palindrome(width, [4, 3, 2, 1]);
  const rows = rise >= 6 ? 2 : 1;
  const ps: Part[] = [], bs: Box[] = [];
  for (let r = 0; r < rows; r++) {
    const lFront = lCab + front * (1 - r), lBack = lFront - front;
    const lLo = Math.min(lFront, lBack), lHi = Math.max(lFront, lBack) + 1;
    let w = A.planeLdu - width * 10;
    for (const pw of pieces) {
      const id = SLOPE45_BY_WIDTH[pw];
      const target = boxW(A, w, w + pw * 20, (yB + 3 * r) * 8, (yB + 3 * r + 3) * 8, lLo * 20, lHi * 20);
      const Rr = ROTY[rotFor([0, 0, -1], dirFront)];
      // a slope of width pw along the width axis: rotation keeps local X along the width axis
      const pos = placeBody(PARTS[id], Rr, target);
      // the lower row stands on the hood (the upper row on the lower one's studded row)
      if (r === 0 && !heldFromBelow(S, xfBox(Rr, pos, PARTS[id].body))) return false;
      ps.push({ part: id, color: colour, pos, rot: Rr });
      bs.push(xfBox(Rr, pos, PARTS[id].body));
      w += pw * 20;
    }
  }
  if (!put(S, ps, bs)) return false;
  S.info.windscreen = `${ps.length} x trans slope`;
  return true;
}

/** Some solid, unreserved cell right under a world box (the part's anti-studs grip it). */
function heldFromBelow(S: Ctx, b: Box): boolean {
  const [x0, y0, z0, x1, , z1] = ldToCells(b);
  for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) if (isSolid(S.g, x, y0 - 1, z) && !S.reserved[at(S.g, x, y0 - 1, z)]) return true;
  return false;
}

function boxW(A: Axes, wLo: number, wHi: number, yLo: number, yHi: number, lLo: number, lHi: number): Box {
  const p = A.ld(wLo, yLo, lLo), q = A.ld(wHi, yHi, lHi);
  return [Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.min(p[2], q[2]), Math.max(p[0], q[0]), Math.max(p[1], q[1]), Math.max(p[2], q[2])];
}

/** Split n into a palindromic sequence of allowed widths (largest outer pieces first). */
export function palindrome(n: number, allowed: number[]): number[] {
  if (n <= 0) return [];
  if (allowed.includes(n) && n <= Math.max(...allowed)) return [n];
  for (const w of allowed) if (2 * w <= n) {
    const mid = palindrome(n - 2 * w, allowed);
    if (n - 2 * w === 0 || mid.length) return [w, ...mid, w];
  }
  return allowed.includes(1) ? new Array(n).fill(1) : [];
}

/**
 * Headlights (front, trans clear / yellow) and tail lights (back, trans red): headlight brick + 1x1 round plate,
 * a mirrored pair centred on the face: their distance from the mirror plane is taken from the analysis boxes (light
 * centre relative to the face span = grille / bumper / lights of that view), their height from the box height.
 */
function lights(S: Ctx, A: Axes, front: 1 | -1, a?: PhotoAnalysis) {
  if (!S.ctx.hasPart('4070.dat') || !S.ctx.hasPart('6141.dat')) return;
  const head = a?.features.find((f) => f.kind === 'headlight');
  const tail = a?.features.find((f) => f.kind === 'taillight');
  const want: [1 | -1, number, LightAim][] = [];
  // vehicles get head- and tail lights by default (real sets always have them); analysis only tints / places them
  want.push([front, transFor(head?.color, C.transClear), lightAim(S, a, 'headlight')]);
  if (!a?.isBrickBuilt || tail) want.push([(-front) as 1 | -1, C.transRed, lightAim(S, a, 'taillight')]);
  for (const [end, colour, aim] of want) {
    const dir = end > 0 ? A.dL : A.dL + 1;
    if (lightPair(S, A, end, dir, aim, colour)) S.info.lights += 2;
  }
}

interface LightAim {
  /** light centre distance from the mirror plane as a fraction of the face half-width */
  k: number;
  /** target layer (y index) of the light's centre, if the analysis has a box */
  y?: number;
}

/** Where the analysis puts the lights of one kind: offset from the face centre and height. */
function lightAim(S: Ctx, a: PhotoAnalysis | undefined, kind: 'headlight' | 'taillight'): LightAim {
  const aim: LightAim = { k: 0.6 };
  if (!a) return aim;
  const all = a.features.filter((f) => f.kind === kind && f.confidence >= 0.3);
  if (!all.length) return aim;
  // the view with the most boxes of this kind (a 3/4 photo can show the tail lights of the other end too)
  const views = (['front', 'back'] as const).map((v) => all.filter((f) => f.view === v));
  const lights = views[0].length >= views[1].length ? views[0] : views[1];
  const view = lights[0].view;
  const span = a.features.filter((f) => f.view === view && (f.kind === kind || f.kind === 'grille' || f.kind === 'bumper'));
  const x0 = Math.min(...span.map((f) => f.box[0])), x1 = Math.max(...span.map((f) => f.box[2]));
  const mid = (x0 + x1) / 2, half = (x1 - x0) / 2;
  if (half > 1e-3 && (span.length > lights.length || lights.length === 1)) {
    const d = lights.reduce((s, f) => s + Math.abs((f.box[0] + f.box[2]) / 2 - mid) / half, 0) / lights.length;
    aim.k = Math.min(0.85, Math.max(0.25, d));
  }
  const [, sy0, , sy1] = a.subjectBox;
  const fy = (lights.reduce((s, f) => s + (f.box[1] + f.box[3]) / 2, 0) / lights.length - sy0) / Math.max(1e-6, sy1 - sy0);
  aim.y = S.bb.y1 + 1 - fy * (S.bb.y1 - S.bb.y0 + 1) - 0.5;
  return aim;
}

function lightPair(S: Ctx, A: Axes, end: 1 | -1, dir: number, aim: LightAim, colour: number): boolean {
  const { g, bb } = S;
  // outer column on + side at the face
  let wo = -Infinity;
  const lFace = end > 0 ? A.l1 : A.l0;
  for (let l = lFace; Math.abs(l - lFace) <= 2; l -= end)
    for (let y = bb.y0; y <= bb.y1; y++) for (let w = A.w0; w <= A.w1; w++) {
      const [x, z] = A.xz(w, l);
      if (isSolid(g, x, y, z) && !S.reserved[at(g, x, y, z)]) wo = Math.max(wo, w, A.mw(w));
    }
  if (!Number.isFinite(wo)) { S.info.notes.push(`lights ${end}: no face`); return false; }
  // candidate columns on the + side, nearest the aimed offset first
  const plane = A.planeLdu / 20, half = wo + 1 - plane;
  const want = plane + aim.k * half;
  const cols: number[] = [];
  for (let w = Math.ceil(plane); w <= wo; w++) if (w > A.mw(w)) cols.push(w);
  cols.sort((p, q) => Math.abs(p + 0.5 - want) - Math.abs(q + 0.5 - want));
  // band tops (the brick spans y-2..y): nearest the aimed height first, else from the top of the face down
  const ys: number[] = [];
  for (let y = bb.y1; y - 2 >= bb.y0; y--) ys.push(y);
  if (aim.y !== undefined) ys.sort((p, q) => Math.abs(p - 1 - aim.y!) - Math.abs(q - 1 - aim.y!));
  let why = '';
  for (const w of cols.slice(0, 4)) for (const y of ys) {
    // front-most solid cell at (w, y) scanning the face
    let lf = -1;
    for (let l = lFace; Math.abs(l - lFace) <= 3; l -= end) {
      const [x, z] = A.xz(w, l);
      if (isSolid(g, x, y, z)) { lf = l; break; }
    }
    if (lf < 0) continue;
    const ok = (ww: number) => {
      for (let k = 0; k < 3; k++) {
        const [x, z] = A.xz(ww, lf);
        if (!isSolid(g, x, y - k, z) || S.reserved[at(g, x, y - k, z)]) return false;
        const [x2, z2] = A.xz(ww, lf + end);
        if (isSolid(g, x2, y - k, z2) || (inGrid(g, x2, y - k, z2) && S.reserved[at(g, x2, y - k, z2)])) return false;
      }
      return true;
    };
    if (!ok(w) || !ok(A.mw(w))) continue;
    // without an aimed height: only bands near the top of the face (lights sit below the hood / boot lid)
    if (aim.y === undefined) {
      let topAtFace = y;
      for (let yy = y; yy <= bb.y1; yy++) { const [x, z] = A.xz(w, lf); if (isSolid(g, x, yy, z)) topAtFace = yy; else break; }
      if (topAtFace - y > 4) continue;
    } else if (Math.abs(y - 1 - aim.y) > 6) continue;
    // the headlight brick needs a stud connection: solid (unreserved) cell right above or below it
    const held = (ww: number) => {
      const [x, z] = A.xz(ww, lf);
      return [y + 1, y - 3].some((yy) => isSolid(g, x, yy, z) && !S.reserved[at(g, x, yy, z)]);
    };
    if (!held(w) || !held(A.mw(w))) { why += `w${w}y${y}:held `; continue; }
    const ps: Part[] = [], bs: Box[] = [];
    for (const ww of [w, A.mw(w)]) {
      const [x, z] = A.xz(ww, lf);
      const body = colourAt(S, x, y, z);
      const R = ROTY[rotFor([0, 0, -1], dir)]; // headlight stud (local -Z) faces outwards
      const target = cellsToLd(x, y - 2, z, x + 1, y + 1, z + 1);
      const pos = placeBody(PARTS['4070.dat'], R, target);
      ps.push({ part: '4070.dat', color: body, pos, rot: R });
      bs.push(xfBox(R, pos, PARTS['4070.dat'].body));
      // 6141 on the side stud: offset (0, 10, -14) in brick-local coordinates, rotated so its top faces -Z
      const Rp = mulM(R, [1, 0, 0, 0, 0, -1, 0, 1, 0]);
      const o = rot(R, [0, 10, -14]);
      const pp: V3 = [pos[0] + o[0], pos[1] + o[1], pos[2] + o[2]];
      ps.push({ part: '6141.dat', color: colour, pos: pp, rot: Rp });
      bs.push(xfBox(Rp, pp, PARTS['6141.dat'].bbox));
    }
    if (put(S, ps, bs, [0, 0, 1, 1])) return true;
    why += `w${w}y${y}:put `;
  }
  if (S.info.notes.length < 20) S.info.notes.push(`lights ${end} (k ${aim.k.toFixed(2)}${aim.y !== undefined ? `, y ${aim.y.toFixed(1)}` : ''}): ${why.slice(0, 120) || 'no flat face'}`);
  return false;
}
const rot = (R: Mat3, v: V3): V3 => [R[0] * v[0] + R[1] * v[1] + R[2] * v[2], R[3] * v[0] + R[4] * v[1] + R[5] * v[2], R[6] * v[0] + R[7] * v[1] + R[8] * v[2]];

// ------------------------------------------------------------------ eyes

/** Eyes from analysis boxes: headlight brick in the head colour + black round tile on its side stud. */
function eyes(S: Ctx, a: PhotoAnalysis) {
  // one mirrored pair is enough: several eye boxes of a 3/4 photo usually are the left and right eye of one face
  const feats = a.features.filter((f) => f.kind === 'eye' && f.confidence >= 0.3).sort((p, q) => q.confidence - p.confidence);
  if (!feats.length || !S.ctx.hasPart('4070.dat')) return;
  const tileId = S.ctx.hasPart('98138.dat') ? '98138.dat' : '6141.dat';
  const { g, bb } = S;
  const [sx0, sy0, sx1, sy1] = a.subjectBox;
  const done = new Set<string>();
  for (const f of feats) {
    if (S.info.eyes >= 2) break;
    const u = (f.box[0] + f.box[2]) / 2, v = (f.box[1] + f.box[3]) / 2;
    let fx = (u - sx0) / Math.max(1e-6, sx1 - sx0);
    const fy = (v - sy0) / Math.max(1e-6, sy1 - sy0);
    if (f.view === 'back') fx = 1 - fx;
    const gx = Math.floor(bb.x0 + fx * (bb.x1 - bb.x0 + 1));
    const gy = Math.floor(bb.y1 + 1 - fy * (bb.y1 - bb.y0 + 1));
    const targets: number[] = [Math.min(bb.x1, Math.max(bb.x0, gx))];
    const mirror = S.ctx.mirrorX !== undefined ? (x: number) => 2 * S.ctx.mirrorX! - 1 - x : (x: number) => bb.x0 + bb.x1 - x;
    if (f.mirrored || a.symmetry === 'left-right' || a.symmetry === 'both') targets.push(mirror(targets[0]));
    for (const x of targets) {
      if (S.info.eyes >= 2) break;
      // eye cell: search near (x, gy) for a surface cell with an exposed face (front first, then sides)
      const hit = findEyeCell(S, x, gy, f);
      if (!hit) continue;
      const key = `${hit.x},${hit.y},${hit.z}`;
      if (done.has(key)) continue;
      const { x: cx, y: cy, z: cz, dir } = hit;
      const R = ROTY[rotFor([0, 0, -1], dir)];
      const target = cellsToLd(cx, cy - 1, cz, cx + 1, cy + 2, cz + 1);
      const pos = placeBody(PARTS['4070.dat'], R, target);
      const Rp = mulM(R, [1, 0, 0, 0, 0, -1, 0, 1, 0]);
      const o = rot(R, [0, 10, -14]);
      const pp: V3 = [pos[0] + o[0], pos[1] + o[1], pos[2] + o[2]];
      const col = colourAt(S, cx, cy, cz);
      // eye colour: the feature's tint (black or white), else black; white on very dark heads when untinted
      let eyeCol: number = C.black;
      if (f.color && /^#[0-9a-f]{6}$/i.test(f.color)) { const [r, gg, b] = hexToLinear(f.color); if (0.2126 * r + 0.7152 * gg + 0.0722 * b > 0.3) eyeCol = C.white; }
      if (eyeCol === eyeColourOf(col)) eyeCol = eyeCol === C.black ? C.white : C.black;
      if (put(S, [{ part: '4070.dat', color: col, pos, rot: R }, { part: tileId, color: eyeCol, pos: pp, rot: Rp }],
        [xfBox(R, pos, PARTS['4070.dat'].body), xfBox(Rp, pp, PARTS[tileId].bbox)], [0, 0])) {
        done.add(key);
        S.info.eyes++;
      }
    }
  }
  void g;
}

/** Black or white, whichever a body colour is closer to (so the eye never vanishes into the head). */
function eyeColourOf(code: number): number {
  const c = COMMON_COLORS.find((p) => p.code === code);
  if (!c) return -1;
  const [r, g, b] = hexToLinear(c.hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.2 ? C.black : C.white;
}

function findEyeCell(S: Ctx, x0: number, y0: number, _f: PhotoFeature): { x: number; y: number; z: number; dir: number } | null {
  const { g, bb } = S;
  let best: { x: number; y: number; z: number; dir: number } | null = null, bestD = Infinity;
  // head colour = most common colour of the top quarter of the model: eyes go on the head, not on a beak / snout
  const counts = new Map<number, number>();
  const yTop = bb.y1 - Math.max(2, Math.round((bb.y1 - bb.y0) / 4));
  for (let y = yTop; y <= bb.y1; y++) for (let z = bb.z0; z <= bb.z1; z++) for (let x = bb.x0; x <= bb.x1; x++)
    if (isSolid(g, x, y, z) && g.visible[at(g, x, y, z)]) { const c = colourAt(S, x, y, z); counts.set(c, (counts.get(c) ?? 0) + 1); }
  let head = -1, hn = 0;
  for (const [c, n] of counts) if (n > hn) { hn = n; head = c; }
  for (let dy = -2; dy <= 4; dy++) for (let dx = -2; dx <= 2; dx++) {
    const x = x0 + dx, y = y0 + dy;
    if (y - 1 < bb.y0 || y + 1 > bb.y1) continue;
    // front-most solid cell along -z (front = +z)
    for (let z = bb.z1; z >= bb.z0; z--) {
      if (!isSolid(g, x, y, z)) continue;
      // need 3 solid unreserved cells (y-1..y+1) and one exposed face direction for all 3
      let okCol = true;
      for (let k = -1; k <= 1; k++) if (!isSolid(g, x, y + k, z) || S.reserved[at(g, x, y + k, z)]) okCol = false;
      if (![y + 2, y - 2].some((yy) => isSolid(g, x, yy, z) && !S.reserved[at(g, x, yy, z)])) okCol = false; // stud connection
      if (!okCol) break;
      for (const dir of [2, 0, 1]) {
        const [ddx, ddz] = dir === 2 ? [0, 1] : dir === 0 ? [1, 0] : [-1, 0];
        let exposed = true;
        for (let k = -1; k <= 1; k++) if (isSolid(g, x + ddx, y + k, z + ddz)) exposed = false;
        if (!exposed) continue;
        const d = Math.abs(dx) + Math.abs(dy) + (dir === 2 ? 0 : 0.5) + (colourAt(S, x, y, z) === head ? 0 : 6);
        if (d < bestD) { bestD = d; best = { x, y, z, dir }; }
        break;
      }
      break;
    }
  }
  return best;
}

export { SLOPE45_BY_WIDTH };
export const _test = { spec, ldToCells };
