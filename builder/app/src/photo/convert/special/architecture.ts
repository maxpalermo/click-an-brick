// Building / castle architecture (part of reserve(), buildings only):
//   roofs        — every roof-coloured top patch of the model (terracotta etc. from the analysis roof boxes / "roof"
//                  colour region; stepped tops inside a projected roof box count too), anywhere on the model: the
//                  largest clean rectangle of the patch, a pitched plane fitted to it (a lean-to against the wall
//                  along one edge, sloping away from it; else the height gradient; a gable for flat patches), rebuilt
//                  as overlapping courses of 33° (3297/3298) or 45° (3037/3038/3039) slopes in the roof colour with a
//                  ridge of double slopes on gables and a 1-stud eave overhang where there is air. The stepped voxels
//                  are carved away, the stair under the slopes is wall-coloured filler, so the slopes sit on studs.
//                  See roofs() for the rules.
//   battlements  — castle style only: on every exposed wall top (a straight run of columns with a drop of >= 2 bricks
//                  outside) merlons of 1x2 .. 2x4 bricks alternate with 1-stud crenels, 2x2 bricks on the corners. Where
//                  the model already has a parapet (ring higher than the walkway) the crenels are cut into it, else the
//                  merlons stand on the wall top. The inner edge of a parapet ring (the drop into a walkway / courtyard
//                  that comes back up to the ring) gets nothing: the walkway stays open. Machicolations: a row of
//                  inverted slopes (3660b / 3665b) under the parapet that pushes it one stud out (tallest tower at
//                  Balanced, every wall top at Detailed).
//   openings     — castle style: arched windows (twin under an arch 1x6x2 on big models) in the upper storey of every
//                  tall wall block and black 1x1x3 arrow slits beside them, on top of the openings read from the mesh
//                  (wallopenings.ts).
//   foliage      — green regions (the analysis foliage colour region / green 'other' boxes): only real volumes (crowns,
//                  bushes, vines sticking out: thick in both horizontal directions and in height) get Plant Leaves 4x3
//                  on their exposed tops and round-brick trunks (2x2 where the trunk is that thick) under them; a flat
//                  green skin on a wall or a lawn gets nothing.
// Every part sits on studs of the wall / filler under it; cells are taken with put() like the other reserve parts.

import type { Mat3 } from '../../../model/types';
import type { PhotoAnalysis, PhotoFeature } from '../contracts';
import { BRICKS } from '../bricks';
import { COMMON_COLORS, ColorMatcher, hexToLinear, type PaletteColor } from '../color';
import { C, DOUBLE45_BY_WIDTH, INV45_BY_WIDTH, PARTS, SLOPE33_BY_WIDTH, SLOPE45_BY_WIDTH, type Box } from './library';
import { DIRS, IDENT, ROTY, cellsToLd, ldToCells, placeBody, rotFor, xfBox, type Part, type V3 } from './geom';
import { at, carve, colourAt, isSolid, palindrome, put, type Ctx } from './reserve';
import { FACES, archWindowAt, type Face } from './openings';
import { nearTaken, slitAt } from './wallopenings';

/** Castle vocabulary: battlements, machicolations, arched openings, arrow slits. */
export const CASTLE = /\b(castles?|fort|fortress|citadel|medieval|crenell?at\w*|battlements?|ramparts?|bastions?|turrets?|donjon)\b/i;
export function castleStyle(a?: PhotoAnalysis): boolean {
  if (!a) return false;
  return CASTLE.test(a.category) || /\btower\b/i.test(a.category) || CASTLE.test(a.notes ?? '');
}

export interface ArchInfo {
  castle: boolean;
  roofs: number; roofSlopes: number; ridges: number;
  merlons: number; corbels: number; crenels: number;
  arches: number; slits: number; towerWindows: number;
  leaves: number; trunks: number; foliageCells: number;
  /** openings read from the mesh texture (wallopenings.ts): dark clusters seen, slits / windows placed from them */
  darkClusters: number; meshSlits: number; meshWindows: number;
  /** merlon / crenel widths in studs read from the photo; when set they replace the 2..4-stud rule of thumb */
  merlonW?: number; crenelW?: number;
}
export const emptyArchInfo = (): ArchInfo => ({ castle: false, roofs: 0, roofSlopes: 0, ridges: 0, merlons: 0, corbels: 0, crenels: 0, arches: 0, slits: 0, towerWindows: 0, leaves: 0, trunks: 0, foliageCells: 0, darkClusters: 0, meshSlits: 0, meshWindows: 0 });

const ROOF_RE = /\b(roofs?|tiles?|shingles?|thatch)\b/i;
const FOLIAGE_RE = /\b(foliage|leaf|leaves|trees?|bush(es)?|plants?|vines?|ivy|grass|hedges?|garden|shrubs?|moss)\b/i;
const TRUNK_RE = /\b(trunks?|wood|wooden|branch(es)?|bark|timber|stems?)\b/i;

interface Env {
  S: Ctx;
  a: PhotoAnalysis;
  /** top solid layer per column (x + nx * z), -1 = empty */
  T: Int32Array;
  ground: number;
  roofCodes: Set<number>;
  roofColour?: number;
  foliageCodes: Set<number>;
  foliageColour?: number;
  trunkCodes: Set<number>;
  /** the wall colour (named wall region, else the most common colour), -1 = none */
  wall: number;
}

const BRICK_BY = new Map<string, string>(BRICKS.map(([a, b, id]) => [`${a}x${b}`, id]));

function matcher(pal: PaletteColor[]) {
  const m = new ColorMatcher(pal, 'ciede2000');
  return (hex: string) => pal[m.match(...hexToLinear(hex))].code;
}
const HEX = /^#[0-9a-f]{6}$/i;
const isGreen = (hex: string) => {
  const [r, g, b] = hexToLinear(hex);
  return g > r * 1.3 && g > b * 1.1 && g > 0.02;
};

function makeEnv(S: Ctx, a: PhotoAnalysis): Env {
  const used = new Set(S.ctx.palette);
  const usedPal = COMMON_COLORS.filter((c) => used.has(c.code));
  const nearUsed = matcher(usedPal.length ? usedPal : COMMON_COLORS);
  const nearAny = matcher(COMMON_COLORS);
  const regions = a.colorRegions ?? [];
  const roofHex = [
    ...a.features.filter((f) => f.kind === 'roof' && f.color && HEX.test(f.color)).map((f) => f.color!),
    ...regions.filter((r) => ROOF_RE.test(r.name) && HEX.test(r.color)).map((r) => r.color),
  ];
  const folHex = [
    ...regions.filter((r) => FOLIAGE_RE.test(r.name) && HEX.test(r.color)).map((r) => r.color),
    ...a.features.filter((f) => f.kind === 'other' && f.color && HEX.test(f.color) && isGreen(f.color)).map((f) => f.color!),
  ];
  const trunkHex = regions.filter((r) => TRUNK_RE.test(r.name) && HEX.test(r.color)).map((r) => r.color);
  const env: Env = {
    S, a, T: new Int32Array(S.g.nx * S.g.nz), ground: S.bb.y0,
    roofCodes: new Set(roofHex.map(nearUsed)), roofColour: roofHex.length ? nearAny(roofHex[0]) : undefined,
    foliageCodes: new Set(folHex.map(nearUsed).filter((c) => c !== C.lbg && c !== C.dbg)),
    foliageColour: folHex.length ? nearAny(folHex[0]) : undefined,
    trunkCodes: new Set(trunkHex.map(nearUsed)),
    wall: -1,
  };
  // the foliage colour itself (what the colour stage snaps foliage to) counts as foliage
  if (env.foliageColour !== undefined) env.foliageCodes.add(env.foliageColour);
  for (const c of env.foliageCodes) env.roofCodes.delete(c);
  // never treat the dominant (wall) colour as roof / foliage
  const n = new Map<number, number>();
  const { cells, paletteCodes } = S.g;
  if (cells && paletteCodes) for (let i = 0; i < cells.length; i++) if (cells[i] >= 0) n.set(paletteCodes[cells[i]], (n.get(paletteCodes[cells[i]]) ?? 0) + 1);
  let wall = -1, wn = 0;
  for (const [c, k] of n) if (k > wn) { wn = k; wall = c; }
  // the wall colour: a region named like a wall, else the most common colour
  const wallRegion = regions.find((r) => /(walls?|stone|bricks?|facade|masonry)/i.test(r.name) && HEX.test(r.color));
  if (wallRegion) wall = nearUsed(wallRegion.color);
  if (!wallRegion && roofHex.length && env.roofCodes.has(wall)) wall = -1; // a grey roof on a grey-dominated model: keep it
  env.roofCodes.delete(wall); env.foliageCodes.delete(wall); env.trunkCodes.delete(wall);
  env.wall = wall;
  tops(env);
  return env;
}

function tops(E: Env) {
  const { g } = E.S;
  const { nx, ny, nz } = g;
  E.T.fill(-1);
  for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++)
    for (let y = ny - 1; y >= 0; y--) if (g.solid[at(g, x, y, z)]) { E.T[x + nx * z] = y; break; }
}

const freeSolid = (S: Ctx, x: number, y: number, z: number) => isSolid(S.g, x, y, z) && !S.reserved[at(S.g, x, y, z)];
/** Air and unreserved; above the grid counts as air (parts may rise over the model's top). */
function airCell(S: Ctx, x: number, y: number, z: number) {
  const { g } = S;
  if (x < 0 || z < 0 || y < 0 || x >= g.nx || z >= g.nz) return false;
  if (y >= g.ny) return true;
  const i = at(g, x, y, z);
  return !g.solid[i] && !S.reserved[i];
}
const takenCell = (S: Ctx, x: number, y: number, z: number) => {
  const { g } = S;
  if (x < 0 || z < 0 || y < 0 || x >= g.nx || z >= g.nz || y >= g.ny) return false;
  return S.taken[at(g, x, y, z)] === 1;
};
/** Set a voxel solid in a colour (the packer bricks it over). */
function setCell(S: Ctx, x: number, y: number, z: number, code: number): boolean {
  const { g } = S;
  const k = g.paletteCodes?.indexOf(code) ?? -1;
  if (!g.cells || k < 0 || x < 0 || z < 0 || y < 0 || x >= g.nx || z >= g.nz || y >= g.ny) return false;
  const i = at(g, x, y, z);
  if (S.reserved[i]) return false;
  g.cells[i] = k; g.solid[i] = 1; g.visible[i] = 1;
  return true;
}
function recolour(S: Ctx, x: number, y: number, z: number, code: number) {
  const { g } = S;
  const k = g.paletteCodes?.indexOf(code) ?? -1;
  if (!g.cells || k < 0 || !isSolid(g, x, y, z)) return;
  const i = at(g, x, y, z);
  if (!S.reserved[i]) g.cells[i] = k;
}

/** A plain brick over a cell box (grid frame), long side along X unless sz > sx. */
function brick(x0: number, y0: number, z0: number, sx: number, sz: number, color: number): { p: Part; b: Box } | null {
  const id = BRICK_BY.get(`${Math.min(sx, sz)}x${Math.max(sx, sz)}`);
  if (!id) return null;
  return {
    p: { part: id, color, pos: [(x0 + sx / 2) * 20, -(y0 + 3) * 8, -(z0 + sz / 2) * 20], rot: sx >= sz ? IDENT : ROTY[1] },
    b: cellsToLd(x0, y0, z0, x0 + sx, y0 + 3, z0 + sz),
  };
}
/** A special part whose body fills a cell box, local -Z towards grid direction d. */
function oriented(id: string, d: number, cells: [number, number, number, number, number, number], color: number): { p: Part; b: Box } {
  const R: Mat3 = ROTY[rotFor([0, 0, -1], d)];
  const sp = PARTS[id];
  const pos = placeBody(sp, R, cellsToLd(...cells));
  return { p: { part: id, color, pos, rot: R }, b: xfBox(R, pos, sp.body) };
}
const rectOf = (cs: [number, number][]) => {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [x, z] of cs) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
  return { x0, x1, z0, z1 };
};

/** Colours that are never wall (roof, foliage, wood): dark cells of these are no openings. */
export function nonWallCodes(S: Ctx, a: PhotoAnalysis): Set<number> {
  if (!S.g.cells || !S.g.paletteCodes) return new Set();
  const E = makeEnv(S, a);
  return new Set([...E.roofCodes, ...E.foliageCodes, ...E.trunkCodes]);
}

/** Before the openings: roofs (every building), battlements (castle style). */
export function architectureBefore(S: Ctx, a: PhotoAnalysis, info: ArchInfo) {
  if (!S.g.cells || !S.g.paletteCodes) return;
  const E = makeEnv(S, a);
  try { roofs(E, info); } catch (e) { S.info.notes.push(`roofs: ${(e as Error).message}`); }
  tops(E);
  if (info.castle) try { battlements(E, info); } catch (e) { S.info.notes.push(`battlements: ${(e as Error).message}`); }
}

/** After the openings: arrow slits (castle style), foliage. */
export function architectureAfter(S: Ctx, a: PhotoAnalysis, info: ArchInfo) {
  if (!S.g.cells || !S.g.paletteCodes) return;
  const E = makeEnv(S, a);
  if (info.castle) try { arrowSlits(E, info); } catch (e) { S.info.notes.push(`slits: ${(e as Error).message}`); }
  try { foliage(E, info); } catch (e) { S.info.notes.push(`foliage: ${(e as Error).message}`); }
}

// ------------------------------------------------------------------ roofs

interface RoofSide {
  /** downhill grid direction */
  d: number;
  /** rows from the high edge down; each row = its columns (x, z) across the roof */
  rows: [number, number][][];
}
interface Slope { j: number; back: number; k: number; top: number }
interface Plan { sides: { side: RoofSide; slopes: Slope[]; k: number }[]; H: number; cost: number; ridge?: [number, number][][] }

function slopesFor(n: number, k: number, H: number): Slope[] {
  const out: Slope[] = [];
  for (let B = 0, j = 0; B < n - 1; j++) {
    const kj = Math.min(k, n - 1 - B);
    out.push({ j, back: B, k: kj, top: H - 3 * j });
    B += kj;
  }
  return out;
}
/** Per row: [lowest slope cell, top] and whether it needs filler under it (all rows but the eave fronts). */
function rowProfile(n: number, sl: Slope[]): { lo: number; top: number; fill: boolean }[] {
  const out: { lo: number; top: number; fill: boolean }[] = [];
  const last = sl[sl.length - 1];
  for (let r = 0; r < n; r++) {
    let lo = Infinity, top = -Infinity;
    for (const s of sl) if (r >= s.back && r <= s.back + s.k) { lo = Math.min(lo, s.top - 2); top = Math.max(top, s.top); }
    out.push({ lo, top, fill: r <= last.back });
  }
  return out;
}

/**
 * Roofs from geometry + colour. A roof patch = 4-connected columns whose top is roof-coloured (or a stepped top inside
 * an analysis roof box), steps of at most a brick between neighbours, anywhere on the model (the analysis boxes are
 * only a hint). Each patch gets the largest clean rectangle of its columns (an L-shaped patch: the rest is tried as
 * another roof), then a pitched plane is fitted:
 *   - a higher wall along one edge (>= half of that edge) = a lean-to leaning against it: the high edge at the wall,
 *     sloping away from it;
 *   - else the height gradient of the patch decides the downhill side; a flat patch can also become a gable.
 * The roof is rebuilt as overlapping courses of 33° (3297 / 3298) or 45° (3037 / 3038 / 3039) slopes in the roof
 * colour, a ridge of double slopes on a gable, and the eave course overhangs the wall by one stud where there is air.
 * The stepped mesh voxels the slopes replace are carved away; the stair under the slopes is wall-coloured filler (it
 * shows at the roof's ends like a gable wall), so every slope sits on studs.
 */
function roofs(E: Env, info: ArchInfo) {
  const { S, T, a } = E;
  const { g } = S;
  const { nx, nz } = g;
  if (!E.roofCodes.size) return;
  // 1 at ~32 studs, 2 at ~64 (footprint size): thresholds that count cells grow with it
  const scale = Math.max(1, (S.bb.x1 - S.bb.x0 + S.bb.z1 - S.bb.z0 + 2) / 56);
  const minCells = Math.round(5 * scale * scale);
  const boxes = a.features.filter((f) => f.kind === 'roof' && f.confidence >= 0.4);
  const H = S.bb.y1 - S.bb.y0 + 1;
  const [, sy0, , sy1] = a.subjectBox;
  const yOf = (fy: number) => S.bb.y1 + 1 - ((fy - sy0) / Math.max(1e-6, sy1 - sy0)) * H;
  // sloped top surfaces inside a projected roof box count as roof even when the colour stage made them wall-coloured
  const hint = new Uint8Array(nx * nz);
  {
    const [sx0, , sx1] = a.subjectBox;
    const W = S.bb.x1 - S.bb.x0 + 1;
    for (const f of boxes) {
      let fx0 = (f.box[0] - sx0) / Math.max(1e-6, sx1 - sx0), fx1 = (f.box[2] - sx0) / Math.max(1e-6, sx1 - sx0);
      if (f.view === 'back') [fx0, fx1] = [1 - fx1, 1 - fx0];
      const xa = Math.floor(S.bb.x0 + fx0 * W) - 2, xb = Math.ceil(S.bb.x0 + fx1 * W) + 2;
      const ya = yOf(f.box[3]) - 4, yb = yOf(f.box[1]) + 4;
      for (let z = 0; z < nz; z++) for (let x = Math.max(0, xa); x <= Math.min(nx - 1, xb); x++) {
        const t = T[x + nx * z];
        if (t < ya || t > yb || t < E.ground + 6) continue;
        const c = colourAt(S, x, t, z);
        if (E.foliageCodes.has(c) || E.trunkCodes.has(c)) continue;
        // stepped: a neighbour 1..4 plates lower on one side and one 1..4 plates higher (or a wall) on the other
        let down = false, up = false;
        for (let d = 0; d < 4; d++) {
          const X = x + DIRS[d][0], Z = z + DIRS[d][1];
          const tn = X < 0 || Z < 0 || X >= nx || Z >= nz ? -1 : T[X + nx * Z];
          const o = d ^ 1, Xo = x + DIRS[o][0], Zo = z + DIRS[o][1];
          const to = Xo < 0 || Zo < 0 || Xo >= nx || Zo >= nz ? -1 : T[Xo + nx * Zo];
          if (tn >= t - 4 && tn <= t - 1 && to >= t + 1) { down = true; up = true; }
        }
        if (down && up) hint[x + nx * z] = 1;
      }
    }
  }
  const roofCol = (x: number, z: number) => E.roofCodes.has(colourAt(S, x, T[x + nx * z], z));
  const roofish = (x: number, z: number) => {
    const t = T[x + nx * z];
    if (t < E.ground + 6) return false;
    if (S.reserved[at(g, x, t, z)]) return false;
    return hint[x + nx * z] === 1 || roofCol(x, z);
  };
  const seen = new Uint8Array(nx * nz);
  // a roof patch mostly overgrown (foliage in the top courses of its own columns) is a hedge / tree, not a roof
  const foliageNear = (x: number, z: number) => {
    const t = T[x + nx * z];
    for (let y = Math.max(0, t - 3); y <= t && t >= 0; y++) if (isSolid(g, x, y, z) && E.foliageCodes.has(colourAt(S, x, y, z))) return true;
    return false;
  };
  const comps: [number, number][][] = [];
  const small: [number, number][][] = [];
  for (let s = 0; s < nx * nz; s++) {
    if (seen[s] || !roofish(s % nx, Math.floor(s / nx))) continue;
    const comp: [number, number][] = [];
    const st = [s]; seen[s] = 1;
    while (st.length) {
      const i = st.pop()!;
      const x = i % nx, z = Math.floor(i / nx);
      comp.push([x, z]);
      for (const [dx, dz] of DIRS) {
        const X = x + dx, Z = z + dz;
        if (X < 0 || Z < 0 || X >= nx || Z >= nz) continue;
        const j = X + nx * Z;
        // one roof = one continuous surface: a step of more than a brick starts another roof
        if (!seen[j] && roofish(X, Z) && Math.abs(T[j] - T[i]) <= 3) { seen[j] = 1; st.push(j); }
      }
    }
    // mostly roof-coloured (a hint-only patch must have some roof colour or be inside a roof box: it is by construction)
    if (comp.length >= minCells) comps.push(comp);
    else if (comp.length >= 2) small.push(comp);
  }
  comps.sort((p, q) => q.length - p.length);
  // roof-coloured specks too small for a roof (a few studs of a stepped mesh roof): wall colour, no orange stubs
  if (E.wall >= 0) for (const c of small) for (const [x, z] of c) {
    if (!roofCol(x, z)) continue;
    const t = T[x + nx * z];
    for (let y = t; y >= t - 3 && y >= 0; y--) if (isSolid(g, x, y, z) && E.roofCodes.has(colourAt(S, x, y, z))) recolour(S, x, y, z, E.wall);
  }
  for (const comp0 of comps) {
    if (comp0.filter(([x, z]) => foliageNear(x, z)).length > 0.5 * comp0.length) { S.info.notes.push(`roof patch ${JSON.stringify(rectOf(comp0))}: foliage`); continue; }
    let comp = comp0;
    // an L / T-shaped patch: the biggest rectangle first, the rest again (at most 3 roofs per patch)
    for (let round = 0; round < 3 && comp.length >= minCells; round++) {
      const meanTop = Math.round(comp.reduce((q, [x, z]) => q + T[x + nx * z], 0) / comp.length);
      const rr = bestRect(E, comp);
      if (!rr) { S.info.notes.push(`roof at ${meanTop}: no rectangle`); break; }
      const sub0 = comp.filter(([x, z]) => x >= rr.x0 && x <= rr.x1 && z >= rr.z0 && z <= rr.z1);
      // the roof's upper rows can be wall-coloured in the mesh: grow the rectangle over rows at roof height when a
      // wall stands right behind them (the lean-to then reaches the wall it leans on); else the patch as it is
      const r0 = { ...rr };
      let sub = sub0.concat(growToWall(E, rr, sub0, Math.round(2 * scale)));
      if (sub.length < minCells) { S.info.notes.push(`roof at ${meanTop}: rectangle ${JSON.stringify(rr)} too small`); break; }
      let plan = bestRoof(E, sub, rr, scale);
      if (!plan && sub.length > sub0.length) { Object.assign(rr, r0); sub = sub0; plan = bestRoof(E, sub, rr, scale); }
      if (!plan) { S.info.notes.push(`roof at ${meanTop}: no slope plan fits ${JSON.stringify(rr)}`); break; }
      buildRoof(E, plan, sub, info);
      S.info.notes.push(`roof ${rr.x0}-${rr.x1}x${rr.z0}-${rr.z1} at ${meanTop}: ${plan.ridge ? 'gable' : 'lean-to'} down ${plan.sides.map((q) => 'xXzZ'[q.side.d]).join('/')} ${plan.sides[0].k === 1 ? '45' : '33'}° ${plan.sides[0].side.rows.length} rows`);
      comp = comp.filter(([x, z]) => !(x >= rr.x0 && x <= rr.x1 && z >= rr.z0 && z <= rr.z1));
    }
    // roof-coloured stubs left beside a built roof, or a small patch no roof fits on: wall colour (no stray studded
    // orange stacks); a big patch that got no roof keeps its colour (it still reads as the roof)
    if ((comp !== comp0 || comp.length < 4 * minCells) && E.wall >= 0) for (const [x, z] of comp) {
      const t = T[x + nx * z];
      for (let y = t; y >= t - 3 && y >= 0; y--) if (isSolid(g, x, y, z) && E.roofCodes.has(colourAt(S, x, y, z))) recolour(S, x, y, z, E.wall);
    }
  }
}

/** Rows beside rect r (grown in place) whose columns sit at roof height and end at a higher wall: their cells. */
function growToWall(E: Env, r: Rect, comp: [number, number][], maxRows: number): [number, number][] {
  const { S, T } = E;
  const { nx, nz } = S.g;
  const tops = comp.map(([x, z]) => T[x + nx * z]);
  const hi = Math.max(...tops), lo = Math.min(...tops);
  const added: [number, number][] = [];
  for (let d = 0; d < 4; d++) {
    const rowAt = (k: number): [number, number][] => {
      const out: [number, number][] = [];
      if (d === 0) for (let z = r.z0; z <= r.z1; z++) out.push([r.x1 + k, z]);
      if (d === 1) for (let z = r.z0; z <= r.z1; z++) out.push([r.x0 - k, z]);
      if (d === 2) for (let x = r.x0; x <= r.x1; x++) out.push([x, r.z1 + k]);
      if (d === 3) for (let x = r.x0; x <= r.x1; x++) out.push([x, r.z0 - k]);
      return out;
    };
    const inside = (c: [number, number]) => c[0] >= 0 && c[1] >= 0 && c[0] < nx && c[1] < nz;
    const share = (row: [number, number][], ok: (t: number) => boolean) => row.filter((c) => inside(c) && ok(T[c[0] + nx * c[1]]) && !takenCell(S, c[0], T[c[0] + nx * c[1]], c[1])).length / row.length;
    let k = 1;
    const rows: [number, number][][] = [];
    let wallAt = -1;
    for (; k <= maxRows + 1; k++) {
      const row = rowAt(k);
      if (share(row, (t) => t > hi + 6) >= 0.6) { wallAt = k; break; } // the wall (clearly higher than the roof)
      if (k > maxRows || share(row, (t) => t >= lo - 1 && t <= hi + 4) < 0.7) break;
      rows.push(row);
    }
    if (wallAt < 0 || !rows.length) continue;
    for (const row of rows) added.push(...row);
    if (d === 0) r.x1 += rows.length; else if (d === 1) r.x0 -= rows.length; else if (d === 2) r.z1 += rows.length; else r.z0 -= rows.length;
  }
  return added;
}

/** Split a roof row into slope widths: palindromic without 1-wide pieces when possible, else the fewest pieces. */
function splitWidth(U: number, widths: number[]): number[] {
  const big = palindrome(U, widths.filter((w) => w > 1));
  if (big.length) return big;
  const pal = palindrome(U, widths);
  const greedy: number[] = [];
  for (let left = U; left > 0; ) { const w = widths.find((q) => q <= left)!; greedy.push(w); left -= w; }
  return pal.length && pal.length <= greedy.length ? pal : greedy;
}

type Rect = { x0: number; x1: number; z0: number; z1: number };

/**
 * The roof rectangle of a patch: the rectangle (both sides >= 2) covering the most patch columns, where a few
 * non-patch columns may be inside when they are no higher than the patch (holes, a lower ledge) but never a wall
 * poking through (higher than the patch top + 1).
 */
function bestRect(E: Env, comp: [number, number][]): Rect | null {
  const { S, T } = E;
  const { nx } = S.g;
  const r = rectOf(comp);
  const W = r.x1 - r.x0 + 1, D = r.z1 - r.z0 + 1;
  const tops = comp.map(([x, z]) => T[x + nx * z]);
  const hi = Math.max(...tops), lo = Math.min(...tops);
  const inC = new Uint8Array(W * D), bad = new Uint8Array(W * D), soft = new Uint8Array(W * D);
  for (const [x, z] of comp) inC[x - r.x0 + W * (z - r.z0)] = 1;
  for (let z = r.z0; z <= r.z1; z++) for (let x = r.x0; x <= r.x1; x++) {
    const k = x - r.x0 + W * (z - r.z0);
    if (inC[k]) continue;
    const t = T[x + nx * z];
    if (t > hi + 1 || takenCell(S, x, t, z)) bad[k] = 1;
    else if (t >= lo - 9) soft[k] = 1; // a hole / lower cell the roof can cover (filler under it)
    else bad[k] = 1;
  }
  // prefix sums
  const P = (a: Uint8Array) => {
    const p = new Int32Array((W + 1) * (D + 1));
    for (let z = 0; z < D; z++) for (let x = 0; x < W; x++) p[x + 1 + (W + 1) * (z + 1)] = a[x + W * z] + p[x + (W + 1) * (z + 1)] + p[x + 1 + (W + 1) * z] - p[x + (W + 1) * z];
    return p;
  };
  const pc = P(inC), pb = P(bad), ps = P(soft);
  const sum = (p: Int32Array, x0: number, z0: number, x1: number, z1: number) => p[x1 + 1 + (W + 1) * (z1 + 1)] - p[x0 + (W + 1) * (z1 + 1)] - p[x1 + 1 + (W + 1) * z0] + p[x0 + (W + 1) * z0];
  let best: Rect | null = null, bs = 0;
  for (let z0 = 0; z0 < D; z0++) for (let z1 = z0 + 1; z1 < D; z1++) for (let x0 = 0; x0 < W; x0++) for (let x1 = x0 + 1; x1 < W; x1++) {
    if (sum(pb, x0, z0, x1, z1)) continue;
    const area = (x1 - x0 + 1) * (z1 - z0 + 1);
    const c = sum(pc, x0, z0, x1, z1), s = sum(ps, x0, z0, x1, z1);
    if (s > 0.15 * area) continue;
    const score = c - 1.5 * s;
    if (score > bs) { bs = score; best = { x0: x0 + r.x0, x1: x1 + r.x0, z0: z0 + r.z0, z1: z1 + r.z0 }; }
  }
  return best;
}

/**
 * Which way a roof rectangle slopes. walls[d] = share of the rect edge on side d with a wall (top > the patch top + 2)
 * right outside it; grad = least-squares height gradient (plates per stud) along x / z.
 */
function roofShape(E: Env, comp: [number, number][], r: Rect) {
  const { S, T } = E;
  const { nx, nz } = S.g;
  const tops = comp.map(([x, z]) => T[x + nx * z]);
  const hi = Math.max(...tops);
  const walls = [0, 0, 0, 0];
  for (let d = 0; d < 4; d++) {
    const cells: [number, number][] = [];
    if (d === 0) for (let z = r.z0; z <= r.z1; z++) cells.push([r.x1 + 1, z]);
    if (d === 1) for (let z = r.z0; z <= r.z1; z++) cells.push([r.x0 - 1, z]);
    if (d === 2) for (let x = r.x0; x <= r.x1; x++) cells.push([x, r.z1 + 1]);
    if (d === 3) for (let x = r.x0; x <= r.x1; x++) cells.push([x, r.z0 - 1]);
    let n = 0;
    for (const [x, z] of cells) {
      // the wall may stand a stud further out (a gap the slope's back row bridges)
      for (let k = 0; k < 2; k++) {
        const X = x + DIRS[d][0] * k, Z = z + DIRS[d][1] * k;
        if (X < 0 || Z < 0 || X >= nx || Z >= nz) break;
        if (T[X + nx * Z] > hi + 2) { n++; break; }
      }
    }
    walls[d] = n / cells.length;
  }
  // least squares t = c + gx x + gz z
  const m = comp.length;
  let sx = 0, sz = 0, st = 0;
  for (const [x, z] of comp) { sx += x; sz += z; st += T[x + nx * z]; }
  sx /= m; sz /= m; st /= m;
  let xx = 0, zz = 0, xz = 0, xt = 0, zt = 0;
  for (const [x, z] of comp) { const dx = x - sx, dz = z - sz, dt = T[x + nx * z] - st; xx += dx * dx; zz += dz * dz; xz += dx * dz; xt += dx * dt; zt += dz * dt; }
  const det = xx * zz - xz * xz;
  const gx = Math.abs(det) > 1e-9 ? (xt * zz - zt * xz) / det : 0, gz = Math.abs(det) > 1e-9 ? (zt * xx - xt * xz) / det : 0;
  return { walls, gx, gz, hi };
}

function bestRoof(E: Env, comp: [number, number][], r0: Rect, scale: number): Plan | null {
  const { S, T } = E;
  const { nx, nz } = S.g;
  const inComp = new Set(comp.map(([x, z]) => x + nx * z));
  const maxTop = Math.max(...comp.map(([x, z]) => T[x + nx * z]));
  const shape = roofShape(E, comp, r0);
  // downhill candidates: away from a wall the roof leans against, else along the gradient (all four + gable when flat)
  const wallSides = [0, 1, 2, 3].filter((d) => shape.walls[d] >= 0.5);
  const lens = [r0.x1 - r0.x0 + 1, r0.z1 - r0.z0 + 1];
  let leanDirs: number[];
  let gables = false;
  if (wallSides.length) leanDirs = wallSides.map((w) => w ^ 1).filter((d) => !wallSides.includes(d));
  else leanDirs = [];
  if (!leanDirs.length) {
    const rx = Math.abs(shape.gx) * (lens[0] - 1), rz = Math.abs(shape.gz) * (lens[1] - 1);
    if (Math.max(rx, rz) >= 2) leanDirs = rx >= rz ? [shape.gx < 0 ? 0 : 1] : [shape.gz < 0 ? 2 : 3];
    else { leanDirs = [0, 1, 2, 3]; gables = !wallSides.length; }
  }
  /** rows of rect r for downhill direction d, from the high edge (row indexes from .. to) */
  const rowsFor = (r: Rect, d: number, from: number, to: number): [number, number][][] => {
    const rows: [number, number][][] = [];
    const alongX = d < 2;
    const lo = alongX ? r.x0 : r.z0, hi = alongX ? r.x1 : r.z1;
    const step = d === 0 || d === 2 ? 1 : -1;
    const start = step > 0 ? lo + from : hi - from, end = step > 0 ? lo + to : hi - to;
    for (let w = start; step > 0 ? w <= end : w >= end; w += step) {
      const row: [number, number][] = [];
      if (alongX) for (let z = r.z0; z <= r.z1; z++) row.push([w, z]);
      else for (let x = r.x0; x <= r.x1; x++) row.push([x, w]);
      rows.push(row);
    }
    return rows;
  };
  const maxFill = Math.round(6 * scale);
  const evalSide = (side: RoofSide, k: number, Hh: number, eave: boolean) => {
    const n = side.rows.length;
    if (n < 2) return null;
    const sl = slopesFor(n, k, Hh);
    const prof = rowProfile(n, sl);
    let cost = 0;
    for (let i = 0; i < n; i++) for (const [x, z] of side.rows[i]) {
      if (x < 0 || z < 0 || x >= nx || z >= nz) return null;
      const t = T[x + nx * z];
      const p = prof[i];
      if (p.lo < E.ground + 1) return null;
      for (let y = p.lo; y <= p.top; y++) if (takenCell(S, x, y, z)) return null;
      if (eave && i === n - 1) {
        // the overhang: air where the eave slope goes, a drop under it
        if (t >= p.lo) return null;
        continue;
      }
      if (!inComp.has(x + nx * z)) {
        if (t > p.top + 1) return null; // a wall pokes through
        if (p.fill && p.lo - 1 - t > maxFill) return null;
        cost += 1;
        continue;
      }
      if (p.fill && p.lo - 1 - t > maxFill) return null; // would add a tall filler column
      cost += Math.abs(t - p.top);
    }
    // a roof that needs 1-wide slopes reads worse than one of the other pitch: small penalty
    const table = k === 1 ? SLOPE45_BY_WIDTH : SLOPE33_BY_WIDTH;
    const ws = [4, 3, 2, 1].filter((w) => table[w] && S.ctx.hasPart(table[w]));
    if (splitWidth(side.rows[0].length, ws).includes(1)) cost += 0.4 * side.rows[0].length * n;
    return { side, slopes: sl, k, cost };
  };
  let best: Plan | null = null;
  const consider = (p: Plan | null) => { if (p && (!best || p.cost < best.cost)) best = p; };
  const ks = [1, 2].filter((k) => [1, 2, 3, 4].some((w) => S.ctx.hasPart((k === 1 ? SLOPE45_BY_WIDTH : SLOPE33_BY_WIDTH)[w] ?? '')));
  const grow = (r: Rect, d: number): Rect => (d === 0 ? { ...r, x1: r.x1 + 1 } : d === 1 ? { ...r, x0: r.x0 - 1 } : d === 2 ? { ...r, z1: r.z1 + 1 } : { ...r, z0: r.z0 - 1 });
  for (let Hh = maxTop - 3; Hh <= maxTop + 2; Hh++) for (const k of ks) {
    // lean-to: the high edge against the wall, with / without the eave overhang
    for (const d of leanDirs) for (const eave of [true, false]) {
      const r = eave ? grow(r0, d) : r0;
      const len = d < 2 ? r.x1 - r.x0 + 1 : r.z1 - r.z0 + 1;
      const s = evalSide({ d, rows: rowsFor(r, d, 0, len - 1) }, k, Hh, eave);
      // overhanging eaves read as a roof (not a stepped top): prefer them
      if (s) consider({ sides: [s], H: Hh, cost: s.cost / comp.length - (eave ? 0.35 : 0) + (k === 1 ? 0.1 : 0) });
    }
    // gable: ridge between rows m and m+1 along x or z, each pitch >= 2 rows
    if (gables) for (const axis of [0, 2]) {
      const len = axis === 0 ? r0.x1 - r0.x0 + 1 : r0.z1 - r0.z0 + 1;
      if (len < 4) continue;
      for (let m = 1; m <= len - 3; m++) {
        const a1 = evalSide({ d: axis + 1, rows: rowsFor(r0, axis + 1, len - 1 - m, len - 1) }, k, Hh, false); // rows m..0, downhill -axis
        const a2 = evalSide({ d: axis, rows: rowsFor(r0, axis, m + 1, len - 1) }, k, Hh, false); // rows m+1.., downhill +axis
        if (!a1 || !a2) continue;
        const ridge = [a1.side.rows[0], a2.side.rows[0]];
        // gables only when they fit clearly better than a lean-to
        consider({ sides: [a1, a2], H: Hh, cost: (a1.cost + a2.cost) / comp.length + 0.3, ridge });
      }
    }
  }
  const b = best as Plan | null;
  if (!b || b.cost > 4) return null;
  return b;
}

function buildRoof(E: Env, plan: Plan, comp: [number, number][], info: ArchInfo) {
  const { S, T } = E;
  const { g } = S;
  const { nx } = g;
  const colour = E.roofColour ?? colourAt(S, comp[0][0], T[comp[0][0] + nx * comp[0][1]], comp[0][1]);
  const fillCol = E.wall >= 0 ? E.wall : colour;
  // 1. reshape the voxels into the stair: carve everything from the lowest slope cell up, fill up to under it
  for (const { side, slopes } of plan.sides) {
    const prof = rowProfile(side.rows.length, slopes);
    side.rows.forEach((row, i) => {
      const p = prof[i];
      for (const [x, z] of row) {
        const t = T[x + nx * z];
        for (let y = p.lo; y <= Math.max(t, p.top); y++) if (y < g.ny && isSolid(g, x, y, z) && !S.reserved[at(g, x, y, z)]) carve(S, at(g, x, y, z));
        if (p.fill) for (let y = Math.max(E.ground, t + 1); y <= p.lo - 1; y++) setCell(S, x, y, z, fillCol);
        // the stair under the slopes is wall (a gable end wall), old roof voxels under it too
        for (let y = p.lo - 1; y >= p.lo - 9 && y >= 0; y--) if (isSolid(g, x, y, z) && E.roofCodes.has(colourAt(S, x, y, z))) recolour(S, x, y, z, fillCol);
      }
    });
  }
  // 2. slopes, widest first, palindromic across the roof
  let n = 0;
  for (const { side, slopes } of plan.sides) {
    const across = side.rows[0];
    const U = across.length;
    for (const s of slopes) {
      const table = s.k === 1 ? SLOPE45_BY_WIDTH : SLOPE33_BY_WIDTH;
      const widths = [4, 3, 2, 1].filter((w) => table[w] && S.ctx.hasPart(table[w]));
      const pieces = splitWidth(U, widths);
      let u = 0;
      for (const w of pieces) {
        const cells: [number, number][] = [];
        for (let q = s.back; q <= s.back + s.k; q++) for (let c = u; c < u + w; c++) cells.push(side.rows[q][c]);
        const rr = rectOf(cells);
        const o = oriented(table[w], side.d, [rr.x0, s.top - 2, rr.z0, rr.x1 + 1, s.top + 1, rr.z1 + 1], colour);
        if (put(S, [o.p], [o.b])) n++;
        u += w;
      }
    }
  }
  // 3. ridge of double slopes over the two top rows of a gable
  if (plan.ridge) {
    const [r1, r2] = plan.ridge;
    const widths = [4, 2, 1].filter((w) => S.ctx.hasPart(DOUBLE45_BY_WIDTH[w]));
    const along = r1.length;
    let u = 0;
    for (const w of palindrome(along, widths)) {
      const cells: [number, number][] = [...r1.slice(u, u + w), ...r2.slice(u, u + w)];
      const rr = rectOf(cells);
      const y0 = plan.H + 1;
      let ok = true;
      for (const [x, z] of cells) for (let y = y0; y < y0 + 3; y++) if (!airCell(S, x, y, z)) ok = false;
      if (ok) {
        // ridge along u: local X along u (rotation 0 when the rows run along x)
        const alongX = r1[0][1] === r1[r1.length - 1][1];
        const R: Mat3 = alongX ? IDENT : ROTY[1];
        const sp = PARTS[DOUBLE45_BY_WIDTH[w]];
        const pos = placeBody(sp, R, cellsToLd(rr.x0, y0, rr.z0, rr.x1 + 1, y0 + 3, rr.z1 + 1));
        if (put(S, [{ part: sp.id, color: colour, pos, rot: R }], [xfBox(R, pos, sp.body)])) { info.ridges++; n++; }
      }
      u += w;
    }
  }
  if (n) { info.roofs++; info.roofSlopes += n; }
  tops(E);
}

// ------------------------------------------------------------------ battlements

interface Run {
  d: number;
  cells: [number, number][];
  t: number;
  /** level the merlons stand on */
  b: number;
  /** ring thickness (parapet case) */
  th: number;
  parapet: boolean;
  corbel: boolean;
  ok: boolean[];
}

function battlements(E: Env, info: ArchInfo) {
  const { S, T } = E;
  const { g } = S;
  const { nx, nz } = g;
  const detail = S.ctx.detail;
  const Tn = (x: number, z: number) => (x < 0 || z < 0 || x >= nx || z >= nz ? -1 : T[x + nx * z]);
  const wallTop = (x: number, z: number) => {
    const t = Tn(x, z);
    if (t < E.ground + 9) return false;
    if (S.reserved[at(g, x, t, z)]) return false;
    const c = colourAt(S, x, t, z);
    return !E.roofCodes.has(c) && !E.foliageCodes.has(c);
  };
  // the inner edge of a parapet ring: the drop towards d is a walkway / courtyard when the top comes back up to the
  // ring height a few studs further on (merlons stand on the outer edge only, the walkway stays open)
  const reach = Math.round(10 * Math.max(1, (S.bb.x1 - S.bb.x0 + S.bb.z1 - S.bb.z0 + 2) / 56));
  const walkwaySide = (x: number, z: number, d: number, t: number) => {
    for (let k = 2; k <= reach; k++) {
      const tk = Tn(x + DIRS[d][0] * k, z + DIRS[d][1] * k);
      if (tk < 0) return false;
      if (tk >= t - 2) return true;
    }
    return false;
  };
  // drop bits per column
  const mask = new Uint8Array(nx * nz);
  let globalTop = -1;
  for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
    if (!wallTop(x, z)) continue;
    const t = T[x + nx * z];
    for (let d = 0; d < 4; d++) if (t - Tn(x + DIRS[d][0], z + DIRS[d][1]) >= 6 && !walkwaySide(x, z, d, t)) mask[x + nx * z] |= 1 << d;
    if (mask[x + nx * z]) globalTop = Math.max(globalTop, t);
  }
  if (globalTop < 0) return;
  const wantCorbel = detail !== 'simple' && S.ctx.hasPart(INV45_BY_WIDTH[1]);
  // ---- runs: straight lines of edge columns with the same drop direction and about the same top ----
  const runs: Run[] = [];
  for (let d = 0; d < 4; d++) {
    const [dx] = DIRS[d];
    const lines = dx ? nx : nz, len = dx ? nz : nx;
    for (let w = 0; w < lines; w++) {
      let cur: [number, number][] = [];
      const flush = () => { if (cur.length >= 3) runs.push(makeRun(d, cur)); cur = []; };
      for (let u = 0; u < len; u++) {
        const x = dx ? w : u, z = dx ? u : w;
        if (!(mask[x + nx * z] & (1 << d))) { flush(); continue; }
        if (cur.length) { const [px, pz] = cur[cur.length - 1]; if (Math.abs(T[px + nx * pz] - T[x + nx * z]) > 2) flush(); }
        cur.push([x, z]);
      }
      flush();
    }
  }
  // runs meeting at a corner share their level (one tower top = one parapet height): the level most of their cells
  // agree on wins
  {
    const parent = runs.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    const owner = new Map<number, number>();
    runs.forEach((r, i) => r.cells.forEach(([x, z]) => {
      const k = x + nx * z, o = owner.get(k);
      if (o !== undefined && Math.abs(runs[o].t - r.t) <= 2) parent[find(i)] = find(o);
      owner.set(k, i);
    }));
    const votes = new Map<number, Map<string, number>>();
    runs.forEach((r, i) => {
      const g = find(i), key = `${r.parapet ? 1 : 0}|${r.b}`;
      const m = votes.get(g) ?? new Map<string, number>();
      m.set(key, (m.get(key) ?? 0) + r.cells.length);
      votes.set(g, m);
    });
    runs.forEach((r, i) => {
      let best = '', bn = -1;
      for (const [k, n] of votes.get(find(i))!) if (n > bn) { bn = n; best = k; }
      const [par, b] = best.split('|').map(Number);
      if (par === (r.parapet ? 1 : 0) && b === r.b) return;
      runs[i] = makeRun(r.d, r.cells, { parapet: par === 1, b });
    });
  }
  function makeRun(d: number, cells: [number, number][], force?: { parapet: boolean; b: number }): Run {
    const [dx, dz] = DIRS[d];
    const cnt = new Map<number, number>();
    for (const [x, z] of cells) cnt.set(T[x + nx * z], (cnt.get(T[x + nx * z]) ?? 0) + 1);
    let t = -1, tn = 0;
    for (const [h, k] of cnt) if (k > tn || (k === tn && h > t)) { t = h; tn = k; }
    // parapet: the walkway (<= t - 3) within 3 columns inwards
    const ths = new Map<number, number>();
    for (const [x, z] of cells) {
      let th = 0;
      for (let k = 1; k <= 3; k++) {
        const ti = Tn(x - k * dx, z - k * dz);
        if (ti < 0) break;
        if (ti <= t - 3) { th = k; break; }
      }
      ths.set(th, (ths.get(th) ?? 0) + 1);
    }
    let th = 0, thn = 0;
    for (const [v, k] of ths) if (k > thn) { th = v; thn = k; }
    const parapet = force ? force.parapet : th > 0;
    if (parapet && !th) th = 1;
    const b = force ? force.b : parapet ? t - 3 : t;
    const run: Run = { d, cells, t, b, th: parapet ? th : 1, parapet, corbel: false, ok: cells.map(() => true) };
    // ring cells must be wall up to the parapet top in the parapet case, and wall at b in any case
    run.ok = cells.map(([x, z]) => {
      for (let y = b; y <= (parapet ? b + 3 : b); y++) if (!freeSolid(S, x, y, z)) return false;
      return true;
    });
    // machicolations: the tallest tower (Balanced) or every wall top (Detailed)
    if (wantCorbel && (detail === 'detailed' || t >= globalTop - 6)) {
      const feas = cells.map(([x, z], i) => {
        if (!run.ok[i]) return false;
        for (let y = b - 3; y <= b; y++) if (!freeSolid(S, x, y, z)) return false;
        for (let y = b - 2; y <= b + 3; y++) if (!airCell(S, x + dx, y, z + dz)) return false;
        return true;
      });
      if (feas.filter(Boolean).length >= 0.7 * cells.length) { run.corbel = true; run.ok = feas; }
    }
    return run;
  }
  if (!runs.length) return;
  /** The wall colour of a run: most common colour of its columns over the 3 bricks under the top (not roof / foliage). */
  const wallCols = new Map<Run, number>();
  const wallCol = (run: Run): number => {
    const c0 = wallCols.get(run);
    if (c0 !== undefined) return c0;
    const n = new Map<number, number>();
    for (const [x, z] of run.cells) for (let y = run.b - 9; y <= run.b; y++) {
      if (!isSolid(g, x, y, z)) continue;
      const c = colourAt(S, x, y, z);
      if (E.roofCodes.has(c) || E.foliageCodes.has(c) || E.trunkCodes.has(c)) continue;
      n.set(c, (n.get(c) ?? 0) + 1);
    }
    let best = colourAt(S, run.cells[0][0], run.b, run.cells[0][1]), bn = 0;
    for (const [c, k] of n) if (k > bn) { bn = k; best = c; }
    wallCols.set(run, best);
    return best;
  };
  const corner = (x: number, z: number, d: number) => {
    const m = mask[x + nx * z];
    return d < 2 ? (m & 12) !== 0 : (m & 3) !== 0;
  };
  // ---- 1. machicolations: inverted slopes 2 wide where two neighbours are free, else 1 wide ----
  for (const run of runs) {
    if (!run.corbel) continue;
    const [dx, dz] = DIRS[run.d];
    const colour = wallCol(run);
    for (let i = 0; i < run.cells.length; ) {
      if (!run.ok[i]) { i++; continue; }
      const w = i + 1 < run.cells.length && run.ok[i + 1] && S.ctx.hasPart(INV45_BY_WIDTH[2]) ? 2 : 1;
      const cs: [number, number][] = [];
      for (let k = 0; k < w; k++) { const [x, z] = run.cells[i + k]; cs.push([x, z], [x + dx, z + dz]); }
      const rr = rectOf(cs);
      const o = oriented(INV45_BY_WIDTH[w], run.d, [rr.x0, run.b - 2, rr.z0, rr.x1 + 1, run.b + 1, rr.z1 + 1], colour);
      if (put(S, [o.p], [o.b])) { info.corbels++; i += w; continue; }
      if (w === 2) {
        const [x, z] = run.cells[i];
        const r1 = rectOf([[x, z], [x + dx, z + dz]]);
        const o1 = oriented(INV45_BY_WIDTH[1], run.d, [r1.x0, run.b - 2, r1.z0, r1.x1 + 1, run.b + 1, r1.z1 + 1], colour);
        if (put(S, [o1.p], [o1.b])) info.corbels++;
      }
      i++;
    }
  }
  // ---- 2. corners: a 2x2 brick (over the overhang when the parapet is pushed out) ----
  const cornerDone = new Set<number>();
  const byCell = new Map<number, Run[]>();
  for (const run of runs) run.cells.forEach(([x, z], i) => { if (run.ok[i]) { const k = x + nx * z; byCell.set(k, [...(byCell.get(k) ?? []), run]); } });
  for (const [k, rs] of byCell) {
    const r1 = rs.find((r) => r.d < 2), r2 = rs.find((r) => r.d >= 2);
    if (!r1 || !r2 || r1.b !== r2.b) continue;
    const x = k % nx, z = Math.floor(k / nx);
    const s = r1.corbel && r2.corbel ? 1 : -1;
    const [d1x] = DIRS[r1.d], [, d2z] = DIRS[r2.d];
    const xs = [x, x + s * d1x], zs = [z, z + s * d2z];
    const x0 = Math.min(...xs), z0 = Math.min(...zs);
    let ok = true;
    for (let y = r1.b + 1; y <= r1.b + 3; y++) for (let cx = x0; cx < x0 + 2; cx++) for (let cz = z0; cz < z0 + 2; cz++) {
      if (takenCell(S, cx, y, cz)) ok = false;
      if (!(cx === x && cz === z) && !airCell(S, cx, y, cz) && !freeSolid(S, cx, y, cz)) ok = false;
    }
    const colour = wallCol(r1);
    const br = brick(x0, r1.b + 1, z0, 2, 2, colour);
    if (ok && br && put(S, [br.p], [br.b])) { cornerDone.add(k); info.merlons++; }
  }
  // ---- 3. merlons and crenels along the runs ----
  for (const run of runs) {
    const [dx, dz] = DIRS[run.d];
    const n = run.cells.length;
    const role: ('C' | 'X' | 'G' | 'M')[] = run.cells.map(([x, z], i) => (cornerDone.has(x + nx * z) ? 'C' : !run.ok[i] || corner(x, z, run.d) ? 'X' : 'G'));
    // segments between corners / unusable cells: G M M G M M ... G
    for (let i = 0; i < n; ) {
      if (role[i] !== 'G') { i++; continue; }
      let j = i;
      while (j + 1 < n && role[j + 1] === 'G') j++;
      const m = j - i + 1;
      // a rhythm read from the photo (merlon / crenel widths) wins over the rule of thumb; spare cells widen the end crenels
      if (info.merlonW) {
        const w = info.merlonW, gp = info.crenelW ?? 1;
        const kk = Math.floor((m - gp) / (w + gp));
        if (kk >= 1) {
          let p = i + gp + Math.floor((m - (kk * w + (kk + 1) * gp)) / 2);
          for (let q = 0; q < kk; q++) { for (let r = 0; r < w; r++) role[p + r] = 'M'; placeMerlon(run, p, w); p += w + gp; }
          i = j + 1;
          continue;
        }
      }
      // merlons 2..4 studs long (no 1x1 merlons), 1-stud crenels between and at both ends
      let k = Math.max(0, Math.round((m - 1) / 3));
      while (k > 0 && (m - (k + 1)) / k > 4) k++;
      while (k > 0 && (m - (k + 1)) / k < 2) k--;
      if (k === 0) {
        // a short stretch: one merlon in the middle when it is at least 2 long, else leave the wall as it is
        if (m >= 4 && m - 2 <= 4) { for (let q = i + 1; q < j; q++) role[q] = 'M'; placeMerlon(run, i + 1, m - 2); }
        else for (let q = i; q <= j; q++) role[q] = 'X';
        i = j + 1;
        continue;
      }
      if (k > 0) {
        const mc = m - (k + 1);
        const lens = new Array(k).fill(Math.floor(mc / k));
        let extra = mc - lens.reduce((p, q) => p + q, 0);
        // extras to the middle merlons, symmetric where possible
        for (let q = 0; extra > 0; q++) { const c = Math.floor((k - 1) / 2) + (q % 2 ? -Math.ceil(q / 2) : Math.ceil(q / 2)); lens[Math.max(0, Math.min(k - 1, c))]++; extra--; }
        let p = i + 1;
        for (const L of lens) { for (let q = 0; q < L; q++) role[p + q] = 'M'; role[p] = 'M'; p += L + 1; }
        // merlon starts: mark lengths
        let s2 = i + 1;
        for (const L of lens) { placeMerlon(run, s2, L); s2 += L + 1; }
      }
      i = j + 1;
    }
    // crenels: cut the parapet (or wall-top bumps) down to b at the gaps
    for (let i = 0; i < n; i++) {
      if (role[i] !== 'G') continue;
      const [x, z] = run.cells[i];
      let cut = false;
      for (let k = 0; k < run.th; k++) {
        const X = x - k * dx, Z = z - k * dz;
        const tt = Tn(X, Z);
        for (let y = run.b + 1; y <= tt; y++) if (freeSolid(S, X, y, Z)) { carve(S, at(g, X, y, Z)); cut = true; }
      }
      if (cut || !run.parapet) info.crenels++;
    }
    void dz;
  }
  function placeMerlon(run: Run, i0: number, L: number) {
    const [dx, dz] = DIRS[run.d];
    const cs: [number, number][] = [];
    for (let q = i0; q < i0 + L; q++) {
      const [x, z] = run.cells[q];
      if (run.corbel) cs.push([x, z], [x + dx, z + dz]);
      else { cs.push([x, z]); if (run.th >= 2) cs.push([x - dx, z - dz]); }
    }
    const rr = rectOf(cs);
    for (const [x, z] of cs) for (let y = run.b + 1; y <= run.b + 3; y++) {
      if (takenCell(S, x, y, z)) return;
      if (!airCell(S, x, y, z) && !freeSolid(S, x, y, z)) return;
    }
    const colour = wallCol(run);
    const br = brick(rr.x0, run.b + 1, rr.z0, rr.x1 - rr.x0 + 1, rr.z1 - rr.z0 + 1, colour);
    if (br && put(S, [br.p], [br.b])) info.merlons++;
  }
}

// ------------------------------------------------------------------ arrow slits

/**
 * Castle openings by design rule (on top of the openings read from the mesh): every tall wall block (columns of about
 * the same top, >= 9 bricks over the ground) gets, on each face at least 5 studs wide, an arched window in the middle
 * of its upper storey (the belfry of a tower), and arrow slits (black 1x1x3) beside it on wide faces / at Detailed, or
 * one slit in the middle where no window fits. Spots already holding an opening are skipped; the totals are capped so
 * the walls are not riddled with holes.
 */
function arrowSlits(E: Env, info: ArchInfo) {
  const { S, T } = E;
  const { g } = S;
  const { nx, nz } = g;
  if (S.ctx.detail === 'simple') return;
  const scale = Math.max(1, (S.bb.x1 - S.bb.x0 + S.bb.z1 - S.bb.z0 + 2) / 56);
  const capWin = Math.round(3 + 2 * scale), capSlit = Math.round(4 + 4 * scale);
  let wins = info.towerWindows + info.meshWindows, slits = info.slits;
  // wall blocks: 4-connected columns whose tops differ by <= 3 plates, tall enough
  const minTop = E.ground + Math.round(27 * Math.min(scale, 1.5));
  const seen = new Uint8Array(nx * nz);
  const blocks: { cells: [number, number][]; top: number }[] = [];
  for (let s0 = 0; s0 < nx * nz; s0++) {
    if (seen[s0] || T[s0] < minTop) continue;
    const cells: [number, number][] = [];
    const st = [s0]; seen[s0] = 1;
    while (st.length) {
      const i = st.pop()!;
      const x = i % nx, z = Math.floor(i / nx);
      cells.push([x, z]);
      for (const [dx, dz] of DIRS) {
        const X = x + dx, Z = z + dz;
        if (X < 0 || Z < 0 || X >= nx || Z >= nz) continue;
        const j = X + nx * Z;
        if (!seen[j] && T[j] >= minTop && Math.abs(T[j] - T[i]) <= 3) { seen[j] = 1; st.push(j); }
      }
    }
    if (cells.length >= 9 * scale * scale) blocks.push({ cells, top: Math.max(...cells.map(([x, z]) => T[x + nx * z])) });
  }
  blocks.sort((p, q) => q.top - p.top);
  const hasSlit = S.ctx.hasPart('14716.dat');
  for (const [bi, bl] of blocks.slice(0, 5).entries()) {
    const r = rectOf(bl.cells);
    const top = bl.top;
    const wide = (u0: number, u1: number) => u1 - u0 + 1 >= Math.round(8 * scale);
    for (const f of [FACES.px, FACES.nx, FACES.pz, FACES.nz] as Face[]) {
      const u0 = f.n === 'x' ? r.z0 : r.x0, u1 = f.n === 'x' ? r.z1 : r.x1;
      const span = u1 - u0 + 1;
      if (span < 5) continue;
      const mid = Math.floor((u0 + u1 + 1) / 2) - 1;
      const twin = scale >= 1.5 && span >= 8;
      // the upper storey: from ~5 bricks under the block top downwards
      const yHi = top - Math.round(14 * scale), yLo = top - Math.round(30 * scale);
      let winY = -1;
      if (wins < capWin) {
        for (let y0 = yHi; y0 >= yLo && winY < 0; y0--) for (const du of [0, -1, 1]) {
          if (winY >= 0 || (y0 - E.ground) % 3 !== 0) continue;
          const u = twin ? mid + du - 1 : mid + du;
          if (nearTaken(S, f, u - 2, u + (twin ? 5 : 3), y0 - 3, y0 + 14)) continue;
          if (archWindowAt(S, f, u, y0, C.transBlack, twin)) { winY = y0; info.towerWindows++; wins++; }
        }
      }
      if (!hasSlit || slits >= capSlit) continue;
      const us = winY < 0 ? [Math.floor((u0 + u1) / 2)]
        : S.ctx.detail === 'detailed' || wide(u0, u1) ? [u0 + Math.max(1, Math.floor(span / 5)), u1 - Math.max(1, Math.floor(span / 5))] : [];
      let placed = 0;
      // highest band first: the slits read best just under the parapet (the lower blocks: one band lower)
      for (let y0 = top - Math.round(14 * scale) - (bi ? 3 : 0); y0 >= top - Math.round(30 * scale) && placed < us.length; y0 -= 3) {
        if ((y0 - E.ground) % 3 !== 0) { y0 += 2; continue; }
        for (const u of us) {
          if (slits >= capSlit) break;
          if (nearTaken(S, f, u - 1, u + 1, y0 - 2, y0 + 10)) continue;
          if (slitAt(S, f, u, y0)) { placed++; slits++; info.slits++; }
        }
        if (placed) break;
      }
    }
  }
}

// ------------------------------------------------------------------ foliage

function foliage(E: Env, info: ArchInfo) {
  const { S, a } = E;
  const { g } = S;
  const { nx, ny, nz } = g;
  if (E.foliageColour === undefined && !E.foliageCodes.size) return;
  const green = E.foliageColour ?? [...E.foliageCodes][0];
  // ---- 1. green feature boxes on the front / back: cells standing out of the facade plane become foliage ----
  const [sx0, sy0, sx1, sy1] = a.subjectBox;
  const Hm = S.bb.y1 - S.bb.y0 + 1, Wm = S.bb.x1 - S.bb.x0 + 1;
  const feats: PhotoFeature[] = a.features.filter((f) => f.kind === 'other' && f.color && HEX.test(f.color) && isGreen(f.color) && f.confidence >= 0.4);
  for (const ft of feats) {
    const f = ft.view === 'back' ? FACES.nz : FACES.pz;
    let fx0 = (ft.box[0] - sx0) / Math.max(1e-6, sx1 - sx0), fx1 = (ft.box[2] - sx0) / Math.max(1e-6, sx1 - sx0);
    if (ft.view === 'back') [fx0, fx1] = [1 - fx1, 1 - fx0];
    const xa = Math.floor(S.bb.x0 + fx0 * Wm), xb = Math.ceil(S.bb.x0 + fx1 * Wm) - 1;
    const yb = Math.ceil(S.bb.y1 + 1 - ((ft.box[1] - sy0) / Math.max(1e-6, sy1 - sy0)) * Hm), ya = Math.floor(S.bb.y1 + 1 - ((ft.box[3] - sy0) / Math.max(1e-6, sy1 - sy0)) * Hm);
    // facade plane: the most common outermost depth over the whole face
    const outer = (x: number, y: number) => {
      for (let k = 0; k < nz; k++) { const z = f.s > 0 ? nz - 1 - k : k; if (isSolid(g, x, y, z)) return z; }
      return -1;
    };
    const cnt = new Map<number, number>();
    for (let y = S.bb.y0; y <= S.bb.y1; y++) for (let x = S.bb.x0; x <= S.bb.x1; x++) { const o = outer(x, y); if (o >= 0) cnt.set(o, (cnt.get(o) ?? 0) + 1); }
    let plane = -1, pn = 0;
    for (const [o, k] of cnt) if (k > pn) { pn = k; plane = o; }
    // the wall right beside the box (columns just left / right of it): what sticks out >= 2 studs past it is a bush or
    // a tree in front of the wall; a box over a tower that simply stands proud of the facade is not
    const side = new Map<number, number>();
    for (let y = Math.max(0, ya); y <= Math.min(ny - 1, yb); y++) for (const x of [xa - 2, xa - 1, xb + 1, xb + 2]) {
      if (x < 0 || x >= nx) continue;
      const o = outer(x, y);
      if (o >= 0) side.set(o, (side.get(o) ?? 0) + 1);
    }
    let local = plane, ln = 0;
    for (const [o, k] of side) if (k > ln || (k === ln && (o - local) * f.s > 0)) { ln = k; local = o; }
    if ((local - plane) * f.s > 0) plane = local;
    for (let y = Math.max(0, ya); y <= Math.min(ny - 1, yb); y++) for (let x = Math.max(0, xa); x <= Math.min(nx - 1, xb); x++) {
      const o = outer(x, y);
      if (o < 0 || (o - plane) * f.s < 2) continue;
      for (let z = o; (z - plane) * f.s >= 1; z -= f.s) if (freeSolid(S, x, y, z)) {
        const c = colourAt(S, x, y, z);
        if (E.trunkCodes.has(c)) continue;
        recolour(S, x, y, z, green);
        info.foliageCells++;
      }
    }
  }
  // ---- 2. foliage volumes: 6-connected foliage-coloured components that are solid blobs (a crown, a bush, a vine
  // sticking out), not a flat green skin on a wall or a lawn: thickness = cells / largest axis projection >= 1.8 ----
  const isFol = (x: number, y: number, z: number) => freeSolid(S, x, y, z) && (E.foliageCodes.has(colourAt(S, x, y, z)) || colourAt(S, x, y, z) === green);
  const scale = Math.max(1, (S.bb.x1 - S.bb.x0 + S.bb.z1 - S.bb.z0 + 2) / 56);
  const lab = new Int32Array(nx * ny * nz).fill(-1);
  const vols: { cells: [number, number, number][]; y0: number }[] = [];
  let skins = 0;
  for (let y = 0; y < ny; y++) for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
    const s0 = at(g, x, y, z);
    if (lab[s0] >= 0 || !isFol(x, y, z)) continue;
    const cells: [number, number, number][] = [];
    const st: [number, number, number][] = [[x, y, z]];
    lab[s0] = vols.length + skins;
    while (st.length) {
      const c = st.pop()!;
      cells.push(c);
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        const X = c[0] + dx, Y = c[1] + dy, Z = c[2] + dz;
        if (X < 0 || Y < 0 || Z < 0 || X >= nx || Y >= ny || Z >= nz) continue;
        const j = at(g, X, Y, Z);
        if (lab[j] >= 0 || !isFol(X, Y, Z)) continue;
        lab[j] = lab[s0];
        st.push([X, Y, Z]);
      }
    }
    const pxy = new Set(cells.map(([cx, cy]) => cx + nx * cy)).size;
    const pzy = new Set(cells.map(([, cy, cz]) => cz + nz * cy)).size;
    const pxz = new Set(cells.map(([cx, , cz]) => cx + nx * cz)).size;
    // thickness in studs along each axis (volume / projection; a cell is 1 x 1 stud x 0.4 stud high): a skin on a wall
    // is 1 stud thin across, a lawn 0.4 high, a crown thicker both ways
    const thick = Math.min(cells.length / pxy, cells.length / pzy);
    const high = (0.4 * cells.length) / pxz;
    if (cells.length >= 6 * scale * scale && thick >= 1.5 && high >= 0.8 && Math.min(pxy, pzy) >= 4) vols.push({ cells, y0: Math.min(...cells.map((c) => c[1])) });
    else skins++;
  }
  if (!vols.length) { S.info.notes.push(`foliage: no volume (${skins} flat patches)`); return; }
  // ---- 3. leaves on the exposed tops (and outer sides) of the volumes ----
  if (!S.ctx.hasPart('2423.dat')) return;
  const tops: [number, number, number][] = [];
  for (const v of vols) for (const [x, y, z] of v.cells) if (airCell(S, x, y + 1, z)) tops.push([x, y, z]);
  if (!tops.length) return;
  tops.sort((p, q) => q[1] - p[1] || p[0] - q[0] || p[2] - q[2]);
  const cap = Math.max(1, Math.round(tops.length / (S.ctx.detail === 'detailed' ? 4 : 6)));
  const sp = PARTS['2423.dat'];
  // leaves point away from the model's centre (outwards)
  const cx = (S.bb.x0 + S.bb.x1 + 1) / 2, cz = (S.bb.z0 + S.bb.z1 + 1) / 2;
  let n = 0;
  const leafColours = [green, ...(S.ctx.detail !== 'simple' && green === 2 ? [288] : [])];
  for (const [x, y, z] of tops) {
    if (n >= cap) break;
    const ds = [0, 1, 2, 3].sort((p, q) => {
      const sc = (d: number) => DIRS[d][0] * (x + 0.5 - cx) + DIRS[d][1] * (z + 0.5 - cz);
      return sc(q) - sc(p);
    });
    for (const d of ds) {
      const R: Mat3 = ROTY[rotFor([0, 0, -1], d)];
      const pos: V3 = [x * 20 + 10, -(y + 2) * 8, -z * 20 - 10];
      const b = xfBox(R, pos, sp.body);
      const [x0, y0, z0, x1, y1, z1] = ldToCells(b);
      let ok = true;
      for (let yy = y0; yy < y1 && ok; yy++) for (let zz = z0; zz < z1 && ok; zz++) for (let xx = x0; xx < x1 && ok; xx++) if (!airCell(S, xx, yy, zz)) ok = false;
      if (!ok) continue;
      if (put(S, [{ part: sp.id, color: leafColours[n % leafColours.length], pos, rot: R }], [b])) { n++; info.leaves++; }
      break;
    }
  }
  // ---- 4. trunks: brown columns (>= 1 brick tall) right under a foliage volume become round bricks, 2x2 where the
  // trunk is that thick (bold), at most 2 trunks per crown ----
  if (!E.trunkCodes.size || !S.ctx.hasPart('3062b.dat')) return;
  const isTrunk = (x: number, y: number, z: number) => freeSolid(S, x, y, z) && E.trunkCodes.has(colourAt(S, x, y, z));
  for (const v of vols) {
    const foot = new Set(v.cells.map(([x, , z]) => x + nx * z));
    const near = (x: number, z: number) => { for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) if (foot.has(x + dx + nx * (z + dz))) return true; return false; };
    // candidate trunk columns: brown cells in the 3 bricks under the crown's bottom, columns under / beside the crown
    const cols = new Map<number, number>();
    for (const k of foot) for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const x = (k % nx) + dx, z = Math.floor(k / nx) + dz;
      if (x < 0 || z < 0 || x >= nx || z >= nz || cols.has(x + nx * z) || !near(x, z)) continue;
      for (let y = v.y0 + 1; y >= Math.max(0, v.y0 - 9); y--) if (isTrunk(x, y, z)) { cols.set(x + nx * z, y); break; }
    }
    let trunks = 0;
    // 2x2 first
    if (S.ctx.hasPart('3941.dat')) for (const [k, yTop] of [...cols].sort((p, q) => q[1] - p[1])) {
      if (trunks >= 2) break;
      const x = k % nx, z = Math.floor(k / nx);
      for (let y = yTop - 2; y >= 0 && trunks < 2; y -= 3) {
        let all = true;
        for (let yy = y; yy < y + 3 && all; yy++) for (const [ax, az] of [[0, 0], [1, 0], [0, 1], [1, 1]]) if (!isTrunk(x + ax, yy, z + az)) all = false;
        if (!all) break;
        const sp4 = PARTS['3941.dat'];
        const pos = placeBody(sp4, IDENT, cellsToLd(x, y, z, x + 2, y + 3, z + 2));
        if (!put(S, [{ part: sp4.id, color: colourAt(S, x, y, z), pos, rot: IDENT }], [xfBox(IDENT, pos, sp4.body)])) break;
        info.trunks++;
        if (y - 3 < 0 || !isTrunk(x, y - 1, z)) { trunks++; break; }
      }
    }
    if (trunks) continue;
    for (const [k, yTop] of [...cols].sort((p, q) => q[1] - p[1])) {
      if (trunks >= 2) break;
      const x = k % nx, z = Math.floor(k / nx);
      let placed = 0;
      for (let y = yTop - 2; y >= 0 && placed < 3; y -= 3) {
        let all = true;
        for (let yy = y; yy < y + 3; yy++) if (!isTrunk(x, yy, z)) all = false;
        if (!all) break;
        const sp3 = PARTS['3062b.dat'];
        const pos = placeBody(sp3, IDENT, cellsToLd(x, y, z, x + 1, y + 3, z + 1));
        if (!put(S, [{ part: sp3.id, color: colourAt(S, x, y, z), pos, rot: IDENT }], [xfBox(IDENT, pos, sp3.body)])) break;
        placed++; info.trunks++;
      }
      if (placed) trunks++;
    }
  }
}
