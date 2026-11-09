// Structures-first build order (behind SpecialContext.structuresFirst): the vision's structure list
// (PhotoAnalysis.structures: columns, arches, windows, doors, roofs, battlements, towers) is built from recipes
// (recipes.ts) at LEGO sizes before anything else; plain bricks fill what is left (the packer, after reserve()).
//
//   placeStructures   columns (stacked round bricks with a cap), arches (arch bricks with the opening carved under
//                     them) and windows (arched or square frames with glass) on the facade of the photo they were
//                     seen in, at the box's projected position, snapped to LEGO sizes. A box with count n is split into
//                     n equal parts. Arches whose box is mostly a window / door are left to that opening (it brings its
//                     own arch).
//   structureFeatures doors, roofs (and windows of front / back photos that placeStructures could not set) become
//                     PhotoFeatures so the existing door / roof / window rules build them with the box the vision gave.
//
// The 3D model only gives proportions and position: every part lands on the wall plane found in the grid, and a part
// is placed only where the wall is there (most of its cells solid, air in front), so the build stays connected.

import type { PhotoAnalysis, PhotoFeature, PhotoStructure } from '../contracts';
import { COMMON_COLORS, ColorMatcher, hexToLinear } from '../color';
import { C, PARTS } from './library';
import { IDENT, ROTY, cellsToLd, placeBody, type Part } from './geom';
import { at, carve, inGrid, isSolid, put, type Ctx } from './reserve';
import { FACES, archWindowAt, glassTint, outer, wallColour, xz, type Face } from './openings';
import { windowAt } from './wallopenings';
import { ARCH_RECIPES, COLUMN_RECIPES, type ArchRecipe, type ColumnRecipe } from './recipes';

export interface StructuresInfo {
  /** structures in the analysis (count expanded) */
  asked: number;
  columns: number;
  arches: number;
  windows: number;
  /** handed to the door / roof / window rules as features */
  features: number;
  /** recipe ids used, with how often */
  recipes: Record<string, number>;
  missed: string[];
}

export const emptyStructuresInfo = (): StructuresInfo => ({ asked: 0, columns: 0, arches: 0, windows: 0, features: 0, recipes: {}, missed: [] });

/** Facade a structure's photo looks at. 'side' (unknown left / right) and anything else: none. */
function faceOf(view: PhotoStructure['view']): Face | null {
  return view === 'front' ? FACES.pz : view === 'back' ? FACES.nz : view === 'right' ? FACES.px : view === 'left' ? FACES.nx : null;
}

interface Span { f: Face; u0: number; u1: number; y0: number; y1: number }

/**
 * Projected cell span of a (sub-)box on its facade: u along the facade (image left -> right as seen in that photo), y
 * in layers (y0 bottom). Horizontal fractions are taken across the front photo's subject box (the photos are framed
 * alike), vertical ones across its height.
 */
function spanOf(S: Ctx, a: PhotoAnalysis, s: PhotoStructure, box: [number, number, number, number]): Span | null {
  const f = faceOf(s.view);
  if (!f) return null;
  const { bb } = S;
  const [sx0, sy0, sx1, sy1] = a.subjectBox;
  const W = Math.max(1e-6, sx1 - sx0), H = Math.max(1e-6, sy1 - sy0);
  const [lo, hi] = f.n === 'z' ? [bb.x0, bb.x1 + 1] : [bb.z0, bb.z1 + 1];
  // image right = +x on the front, -x on the back, -z on the right side, +z on the left side
  const flip = f === FACES.nz || f === FACES.px;
  const fr = (fx: number) => { const t = Math.min(1, Math.max(0, (fx - sx0) / W)); return flip ? 1 - t : t; };
  const ua = lo + fr(box[0]) * (hi - lo), ub = lo + fr(box[2]) * (hi - lo);
  const Hm = bb.y1 - bb.y0 + 1;
  const yAt = (fy: number) => bb.y1 + 1 - Math.min(1, Math.max(0, (fy - sy0) / H)) * Hm;
  return { f, u0: Math.min(ua, ub), u1: Math.max(ua, ub), y0: yAt(box[3]), y1: yAt(box[1]) };
}

/** A box split into n equal parts along its width. */
function split(box: [number, number, number, number], n: number): [number, number, number, number][] {
  const out: [number, number, number, number][] = [];
  const w = (box[2] - box[0]) / n;
  for (let k = 0; k < n; k++) out.push([box[0] + k * w, box[1], box[0] + (k + 1) * w, box[3]]);
  return out;
}

const overlapShare = (a: number[], b: number[]) => {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]), h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (w <= 0 || h <= 0) return 0;
  return (w * h) / Math.max(1e-9, Math.min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1])));
};

/** The structure colour as an opaque LEGO colour used in the model (null = take the wall's). */
function colourOf(S: Ctx, hex: string | undefined): number | null {
  if (!hex || !/^#[0-9a-f]{6}$/i.test(hex)) return null;
  const used = new Set(S.ctx.palette);
  const pal = COMMON_COLORS.filter((c) => used.has(c.code) && c.code !== C.transClear);
  if (!pal.length) return null;
  return pal[new ColorMatcher(pal, 'ciede2000').match(...hexToLinear(hex))].code;
}

/** Mark a cell solid with a colour of the pipeline grid's palette (no-op without one). */
function fill(S: Ctx, x: number, y: number, z: number, code: number) {
  const { g } = S;
  if (!inGrid(g, x, y, z) || !g.cells || !g.paletteCodes) return;
  const i = at(g, x, y, z);
  if (S.reserved[i]) return;
  const k = g.paletteCodes.indexOf(code);
  if (k >= 0) g.cells[i] = k;
  g.solid[i] = 1; g.visible[i] = 1;
}

/** An AI mesh's facade is lumpy: a part may sit on wall up to this many cells behind its plane (the gap is filled). */
const DEPTH_TOL = 2;

/**
 * Wall coordinate for a patch of the facade: the plane with the most cells whose outermost wall lies on it or up to
 * DEPTH_TOL cells behind it (the outermost on a tie); null when the patch has no wall.
 */
function wallPlane(S: Ctx, f: Face, u0: number, u1: number, y0: number, y1: number): number | null {
  const os: number[] = [];
  for (let u = u0; u < u1; u++) for (let y = y0; y < y1; y++) { const o = outer(S, f, u, y); if (o !== null) os.push(o); }
  let p: number | null = null, pn = 0;
  for (const o of new Set(os)) {
    let k = 0;
    for (const q of os) { const d = (o - q) * f.s; if (d >= 0 && d <= DEPTH_TOL) k++; }
    if (k > pn || (k === pn && p !== null && (o - p) * f.s > 0)) { p = o; pn = k; }
  }
  return p;
}

/** The facade's wall at (u, y) lies on plane p or at most DEPTH_TOL cells behind it. */
function backed(S: Ctx, f: Face, u: number, y: number, p: number): boolean {
  const o = outer(S, f, u, y);
  if (o === null) return false;
  const d = (p - o) * f.s;
  return d >= 0 && d <= DEPTH_TOL;
}

/** Fill the air between plane p and the wall behind it at (u, y), so a part on p is held by filler bricks. */
function fillGap(S: Ctx, f: Face, u: number, y: number, p: number, code: number) {
  const o = outer(S, f, u, y);
  if (o === null) return;
  for (let q = p - f.s; (q - o) * f.s > 0; q -= f.s) { const [x, z] = xz(f, u, q); fill(S, x, y, z, code); }
}

const used = (info: StructuresInfo, id: string) => { info.recipes[id] = (info.recipes[id] ?? 0) + 1; };

// ------------------------------------------------------------------ columns

/**
 * A column w studs wide on face f, centred at uc, from layer yLo up to yHi (snapped to whole bricks): one round brick
 * per course set into the wall's outer layer(s), plus the recipe's cap where the top is open. Most cells must be wall
 * with air in front, the column must stand on the ground or on wall.
 */
export function column(S: Ctx, f: Face, uc: number, yLo: number, yHi: number, r: ColumnRecipe, colour: number | null): boolean {
  const { g, bb } = S;
  const courses = Math.floor((yHi - yLo) / 3);
  if (courses < 2) return false;
  for (const du of [0, 1, -1]) {
    const u0 = Math.round(uc - r.w / 2) + du;
    for (const dy of [0, 1, -1, 2, -2]) {
      const y0 = Math.max(bb.y0, Math.round(yLo) + dy), y1 = y0 + courses * 3;
      if (y1 > g.ny) continue;
      const p = wallPlane(S, f, u0, u0 + r.w, y0, y1);
      if (p === null) continue;
      const cells: [number, number, number][] = [];
      let solid = 0, open = 0, bad = false;
      for (let u = u0; u < u0 + r.w && !bad; u++) for (let y = y0; y < y1 && !bad; y++) for (let d = 0; d < r.w; d++) {
        const [x, z] = xz(f, u, p - d * f.s);
        if (!inGrid(g, x, y, z) || S.reserved[at(g, x, y, z)]) { bad = true; break; }
        cells.push([x, y, z]);
        if (d === 0 ? backed(S, f, u, y, p) : isSolid(g, x, y, z) || backed(S, f, u, y, p)) solid++;
        if (d === 0) { const [xo, zo] = xz(f, u, p + f.s); if (!isSolid(g, xo, y, zo) && !(inGrid(g, xo, y, zo) && S.reserved[at(g, xo, y, zo)])) open++; }
      }
      if (bad || solid < 0.6 * cells.length || open < 0.6 * r.w * (y1 - y0)) continue;
      // standing on the ground or on wall under at least one of its cells
      let stand = y0 <= bb.y0;
      for (let u = u0; u < u0 + r.w && !stand; u++) stand = backed(S, f, u, y0 - 1, p);
      if (!stand) continue;
      const col = colour ?? wallColour(S, cells);
      const [xa, za] = xz(f, u0, p), [xb, zb] = xz(f, u0 + r.w - 1, p - (r.w - 1) * f.s);
      const X0 = Math.min(xa, xb), X1 = Math.max(xa, xb) + 1, Z0 = Math.min(za, zb), Z1 = Math.max(za, zb) + 1;
      const ps: Part[] = [], bs: ReturnType<typeof cellsToLd>[] = [];
      for (let k = 0; k < courses; k++) {
        const box = cellsToLd(X0, y0 + 3 * k, Z0, X1, y0 + 3 * k + 3, Z1);
        ps.push({ part: r.body, color: col, pos: placeBody(PARTS[r.body], IDENT, box), rot: IDENT });
        bs.push(box);
      }
      // the cap only on an open top (air over every cell)
      let capped = false;
      if (r.cap && PARTS[r.cap] && S.ctx.hasPart(r.cap)) {
        let air = y1 < g.ny;
        for (let x = X0; x < X1 && air; x++) for (let z = Z0; z < Z1 && air; z++) air = !isSolid(g, x, y1, z) && !S.reserved[at(g, x, y1, z)];
        if (air) {
          const box = cellsToLd(X0, y1, Z0, X1, y1 + 1, Z1);
          ps.push({ part: r.cap, color: col, pos: placeBody(PARTS[r.cap], IDENT, box), rot: IDENT });
          bs.push(box);
          capped = true;
        }
      }
      if (!put(S, ps, bs)) continue;
      for (const [x, y, z] of cells) fill(S, x, y, z, col);
      for (let u = u0; u < u0 + r.w; u++) for (let y = y0 - 1; y < y1; y++) fillGap(S, f, u, y, p - (r.w - 1) * f.s, col);
      if (capped) for (let x = X0; x < X1; x++) for (let z = Z0; z < Z1; z++) fill(S, x, y1, z, col);
      return true;
    }
  }
  return false;
}

// ------------------------------------------------------------------ arches

/**
 * An arch brick on face f over an opening about `open` studs wide centred at uc, its top near layer yTop; the opening
 * under it is carved down to yLo (at least one brick, at most the box). The arch's cells must be mostly wall with air
 * in front, its legs stand on wall that stays.
 */
export function arch(S: Ctx, f: Face, uc: number, yLo: number, yTop: number, r: ArchRecipe, colour: number | null): boolean {
  const { g, bb } = S;
  const sp = PARTS[r.part];
  if (!sp) return false;
  // the photo and the AI mesh disagree on heights: a tall box (a gate, a blind arch) lets the arch drop to the top of the
  // wall that is really there, anywhere in the box's upper half
  const reach = Math.max(3, Math.round((yTop - yLo) / 2));
  const dys = Array.from({ length: reach + 4 }, (_, i) => i - reach).sort((p, q) => Math.abs(p) - Math.abs(q));
  for (const dy of dys) for (const du of [0, 1, -1]) {
    const ya = Math.round(yTop) - r.h + dy, u0 = Math.round(uc - r.span / 2) + du;
    if (ya < bb.y0 + 3 || ya + r.h > g.ny) continue;
    const p = wallPlane(S, f, u0, u0 + r.span, ya, ya + r.h);
    if (p === null) continue;
    const cells: [number, number, number][] = [];
    let solid = 0, open = 0, bad = false;
    for (let u = u0; u < u0 + r.span && !bad; u++) for (let y = ya; y < ya + r.h; y++) {
      const [x, z] = xz(f, u, p);
      const [xo, zo] = xz(f, u, p + f.s);
      if (!inGrid(g, x, y, z) || S.reserved[at(g, x, y, z)]) { bad = true; break; }
      cells.push([x, y, z]);
      if (backed(S, f, u, y, p)) solid++;
      // an AI mesh is lumpy: a few cells with wall in front are fine (the filler covers them), most must show
      if (!isSolid(g, xo, y, zo) && !(inGrid(g, xo, y, zo) && S.reserved[at(g, xo, y, zo)])) open++;
    }
    if (bad || solid < 0.6 * cells.length || open < 0.75 * cells.length) continue;
    // legs on wall
    const leg = (u: number) => { const [x, z] = xz(f, u, p); return backed(S, f, u, ya - 1, p) && !S.reserved[at(g, x, ya - 1, z)]; };
    if (!leg(u0) || !leg(u0 + r.span - 1)) continue;
    // the opening: between the legs, from the arch down to the box bottom (at least a brick; a tall blind arch is a
    // recess as tall as its box)
    const yb = Math.max(bb.y0 + 1, Math.min(ya - 3, Math.round(yLo)));
    const hole: number[] = [];
    for (let u = u0 + 1; u < u0 + r.span - 1 && !bad; u++) for (let y = yb; y < ya; y++) {
      const [x, z] = xz(f, u, p);
      if (!inGrid(g, x, y, z)) { bad = true; break; }
      // parts already set into the recess (windows of a blind arch) stay
      if (isSolid(g, x, y, z) && !S.reserved[at(g, x, y, z)]) hole.push(at(g, x, y, z));
    }
    if (bad) continue;
    const col = colour ?? wallColour(S, cells);
    const R = f.n === 'z' ? IDENT : ROTY[1];
    const [xa, za] = xz(f, u0, p), [xb, zb] = xz(f, u0 + r.span - 1, p);
    const box = cellsToLd(Math.min(xa, xb), ya, Math.min(za, zb), Math.max(xa, xb) + 1, ya + r.h, Math.max(za, zb) + 1);
    if (!put(S, [{ part: r.part, color: col, pos: placeBody(sp, R, box), rot: R }], [box])) continue;
    for (const [x, y, z] of cells) fill(S, x, y, z, col);
    for (let u = u0; u < u0 + r.span; u++) for (let y = ya; y < ya + r.h; y++) fillGap(S, f, u, y, p, col);
    // the legs stand on wall: fill the plane under them down to the opening's bottom where the wall is behind it
    for (const u of [u0, u0 + r.span - 1]) for (let y = yb; y < ya; y++) { const [x, z] = xz(f, u, p); if (backed(S, f, u, y, p)) { fill(S, x, y, z, col); fillGap(S, f, u, y, p, col); } }
    for (const i of hole) carve(S, i);
    return true;
  }
  return false;
}

// ------------------------------------------------------------------ entry points

/** Columns, arches and windows of the structure list, biggest first. Returns the windows it could not place. */
export function placeStructures(S: Ctx, a: PhotoAnalysis, castle: boolean, info: StructuresInfo): PhotoStructure[] {
  const list = (a.structures ?? []).filter((s) => s.confidence >= 0.4);
  const openings = list.filter((s) => s.kind === 'window' || s.kind === 'door');
  const area = (s: PhotoStructure) => (s.box[2] - s.box[0]) * (s.box[3] - s.box[1]);
  const left: PhotoStructure[] = [];
  for (const s of list) info.asked += Math.max(1, s.count ?? 1);
  const order: Record<string, number> = { arch: 0, column: 1, window: 2 };
  for (const s of list.filter((q) => q.kind in order).sort((p, q) => order[p.kind] - order[q.kind] || area(q) - area(p))) {
    const n = Math.max(1, Math.min(12, Math.round(s.count ?? 1)));
    const colour = colourOf(S, s.color);
    if (s.kind === 'arch' && openings.some((o) => o.view === s.view && overlapShare(o.box, s.box) > 0.5)) continue;
    for (const box of split(s.box, n)) {
      const sp = spanOf(S, a, s, box);
      if (!sp) { info.missed.push(`${s.kind}: view ${s.view}`); continue; }
      const uc = (sp.u0 + sp.u1) / 2, wid = sp.u1 - sp.u0;
      if (s.kind === 'column') {
        // LEGO size: 1 or 2 studs; square columns are plain bricks (the filler does them)
        const want = wid >= 1.6 ? 2 : 1;
        const rs = COLUMN_RECIPES.filter((r) => r.shape === (s.shape === 'square' ? 'square' : 'round') && S.ctx.hasPart(r.body))
          .sort((p, q) => Math.abs(p.w - want) - Math.abs(q.w - want));
        const r = rs.find((r) => column(S, sp.f, uc, sp.y0, sp.y1, r, colour));
        if (r) { info.columns++; used(info, r.id); } else info.missed.push(`column at u ${uc.toFixed(0)}`);
      } else if (s.kind === 'arch') {
        // LEGO size: the box is the opening; the arch whose opening (span - 2) is nearest, the taller one for a tall box,
        // then the next sizes (a recipe that does not fit the wall falls back to a smaller one)
        const tall = sp.y1 - sp.y0 >= 12;
        const rs = ARCH_RECIPES.filter((r) => S.ctx.hasPart(r.part) && PARTS[r.part])
          .sort((p, q) => Math.abs(p.span - 2 - wid) - Math.abs(q.span - 2 - wid) || (tall ? q.h - p.h : p.h - q.h));
        const r = rs.find((r) => arch(S, sp.f, uc, sp.y0, sp.y1, r, colour));
        if (r) { info.arches++; used(info, r.id); } else info.missed.push(`arch at u ${uc.toFixed(0)}`);
      } else {
        // windows: round / pointed tops are arched windows (castle style everywhere), else the square frame
        const round = s.shape === 'round' || s.shape === 'pointed' || (castle && s.shape !== 'square');
        const twin = round && wid >= 3.5;
        const h = round ? 8 : 6;
        const yc = (sp.y0 + sp.y1) / 2;
        let ok = false;
        for (const tw of twin ? [true, false] : [false]) {
          const w = tw ? 4 : 2;
          for (const dy of [0, 1, -1, 2, -2, 3, -3]) {
            for (const du of [0, 1, -1, 2, -2]) {
              const u0 = Math.round(uc - w / 2) + du, y0 = Math.round(yc - h / 2) + dy;
              ok = round ? archWindowAt(S, sp.f, u0, y0, glassTint(s.color, false), tw) : windowAt(S, sp.f, u0, y0, false);
              if (ok) break;
            }
            if (ok) break;
          }
          if (ok) { used(info, round ? (tw ? 'window-arched-twin' : 'window-arched') : 'window-1x2x2'); break; }
        }
        if (ok) info.windows++;
        else left.push({ ...s, box, count: 1 });
      }
    }
  }
  return left;
}

/**
 * Doors, roofs and the windows placeStructures could not set (front / back photos only: the PhotoFeature contract)
 * as features for the existing door / window / roof rules. They go first, so the vision's structure boxes win over
 * its older feature boxes.
 */
export function structureFeatures(a: PhotoAnalysis, leftWindows: PhotoStructure[], info: StructuresInfo): PhotoFeature[] {
  const out: PhotoFeature[] = [];
  const src = [...(a.structures ?? []).filter((s) => (s.kind === 'door' || s.kind === 'roof') && s.confidence >= 0.4), ...leftWindows];
  for (const s of src) {
    if (s.view !== 'front' && s.view !== 'back') continue;
    out.push({ kind: s.kind as PhotoFeature['kind'], view: s.view, box: s.box, mirrored: false, color: s.color, confidence: Math.min(1, s.confidence + 0.05) });
  }
  info.features += out.length;
  return out;
}
