// Windows and doors set into walls (part of reserve()):
//   vehicles  — side windows in the cabin walls (the long sides, between the belt line and the roof), the same
//               length positions on both sides
//   buildings — door + windows on the front / back facades from the analysis boxes, windows on the side walls
// Openings replace the outermost wall cells (1 deep). They only go where the wall is flat over the whole opening, the
// cells outside are air, and a solid, unreserved course runs right under (and, for windows, right over) the opening,
// so the frame's anti-studs / studs connect to the packed wall. Parts come back in the grid frame like reserve().

import type { PhotoAnalysis, PhotoFeature } from '../contracts';
import { COMMON_COLORS, ColorMatcher, hexToLinear } from '../color';
import { C, DOOR, PARTS, WINDOWS } from './library';
import { ROTY, cellsToLd, mulV, placeBody, rotFor, xfBox, type Part, type V3 } from './geom';
import { at, colourAt, heightProfile, inGrid, inMain, isSolid, put, type Axes, type Ctx } from './reserve';
import { castleStyle } from './architecture';

/** A wall facing grid direction d: the normal runs along `n` ('x' | 'z') with outward sign s; u runs along the wall. */
export interface Face { n: 'x' | 'z'; s: 1 | -1; d: number }
export const FACES: Record<'px' | 'nx' | 'pz' | 'nz', Face> = {
  px: { n: 'x', s: 1, d: 0 }, nx: { n: 'x', s: -1, d: 1 }, pz: { n: 'z', s: 1, d: 2 }, nz: { n: 'z', s: -1, d: 3 },
};
export const xz = (f: Face, u: number, p: number): [number, number] => (f.n === 'x' ? [p, u] : [u, p]);

/** Outermost solid cell along the face normal at (u, y), as a coordinate along the normal; null = none. */
export function outer(S: Ctx, f: Face, u: number, y: number): number | null {
  const { g } = S;
  const len = f.n === 'x' ? g.nx : g.nz;
  for (let k = 0; k < len; k++) {
    const p = f.s > 0 ? len - 1 - k : k;
    const [x, z] = xz(f, u, p);
    if (isSolid(g, x, y, z) || (inGrid(g, x, y, z) && S.reserved[at(g, x, y, z)])) return p;
  }
  return null;
}

/**
 * Wall coordinate p when an opening of w x h cells at (u0.., y0..) fits on face f, else null. p = the wall plane of most
 * of the opening; nothing may stick out past it, a cell may be recessed by one (it then has wall right behind it and the frame fills
 * the notch). Every cell at p is unreserved, the cells outside are air, a solid unreserved course runs under every
 * column and, with needAbove, over at least one (the frame's studs then lock into it).
 */
export function fitOpening(S: Ctx, f: Face, u0: number, w: number, y0: number, h: number, needAbove: boolean): number | null {
  const { g } = S;
  const free = (x: number, y: number, z: number) => isSolid(g, x, y, z) && !S.reserved[at(g, x, y, z)];
  if (y0 < 1 || y0 + h > g.ny) return null;
  const os: number[] = [];
  const n = new Map<number, number>();
  for (let u = u0; u < u0 + w; u++) for (let y = y0; y < y0 + h; y++) {
    const o = outer(S, f, u, y);
    if (o === null) return null;
    os.push(o);
    n.set(o, (n.get(o) ?? 0) + 1);
  }
  // p = the wall plane most of the opening lies in (the outermost one on a tie); nothing may stick out past it
  let p: number | null = null, pn = 0;
  for (const [o, k] of n) if (k > pn || (k === pn && p !== null && (o - p) * f.s > 0)) { p = o; pn = k; }
  if (p === null) return null;
  for (let u = u0, k = 0; u < u0 + w; u++) for (let y = y0; y < y0 + h; y++, k++) {
    if (os[k] !== p && os[k] !== p - f.s) return null; // sticks out, or recessed by more than one cell
    const [x, z] = xz(f, u, p);
    if (!inGrid(g, x, y, z) || S.reserved[at(g, x, y, z)]) return null;
    if (os[k] !== p) { const [xb, zb] = xz(f, u, p - f.s); if (!free(xb, y, zb)) return null; }
    const [xo, zo] = xz(f, u, p + f.s);
    if (isSolid(g, xo, y, zo) || (inGrid(g, xo, y, zo) && S.reserved[at(g, xo, y, zo)])) return null;
  }
  let above = 0;
  for (let u = u0; u < u0 + w; u++) {
    const [x, z] = xz(f, u, p);
    if (!free(x, y0 - 1, z) || !inMain(S, x, y0 - 1, z)) return null;
    if (free(x, y0 + h, z)) above++;
  }
  if (needAbove && above === 0) return null;
  return p;
}

/** World box of an opening's cells (grid frame). */
export function openingBox(f: Face, u0: number, w: number, y0: number, h: number, p: number) {
  const [xa, za] = xz(f, u0, p), [xb, zb] = xz(f, u0 + w - 1, p);
  return cellsToLd(Math.min(xa, xb), y0, Math.min(za, zb), Math.max(xa, xb) + 1, y0 + h, Math.max(za, zb) + 1);
}

/** Window (2 wide, frame + glass, glass towards the outside) at a fitted spot. */
export function windowParts(f: Face, u0: number, y0: number, p: number, win: { h: number; frame: string; glass: string; glassAt?: V3 }, frameCol: number, glassCol: number) {
  const R = ROTY[rotFor([0, 0, -1], f.d)]; // glass sits on the frame's -Z side: face it outwards
  const pos = placeBody(PARTS[win.frame], R, openingBox(f, u0, 2, y0, win.h, p));
  const o = win.glassAt ? mulV(R, win.glassAt) : [0, 0, 0];
  const gp: V3 = [pos[0] + o[0], pos[1] + o[1], pos[2] + o[2]];
  const ps: Part[] = [{ part: win.frame, color: frameCol, pos, rot: R }, { part: win.glass, color: glassCol, pos: gp, rot: R }];
  const bs = [xfBox(R, pos, PARTS[win.frame].body), xfBox(R, gp, PARTS[win.glass].body)];
  return { ps, bs, groups: [0, 0] };
}

/** Castle style: the arched window 1x2x2.667 (30044) with the lattice pane (30046) at frame-local (0, 24, 0). */
const ARCH_WINDOW = { h: 8, frame: '30044.dat', glass: '30046.dat', glassAt: [0, 24, 0] as V3 };

/**
 * Castle style: an arched window (30044 + lattice pane, wall-coloured frame) with an arch 1x4 over it at (u0, y0) on
 * face f, when the wall is flat there (1 stud of wall either side, a course under and over). True = placed.
 */
export function archWindowAt(S: Ctx, f: Face, u0: number, y0: number, tint: number, twin = false): boolean {
  const win = ARCH_WINDOW;
  if (!S.ctx.hasPart(win.frame) || !S.ctx.hasPart(win.glass)) return false;
  // twin (big models): two arched windows side by side under an arch 1x6x2 — one bold opening instead of two tiny ones
  const w = twin && S.ctx.hasPart('3307.dat') ? 4 : 2;
  const archH = w === 4 ? 6 : 3;
  const pw = fitOpening(S, f, u0 - 1, w + 2, y0, win.h + archH, true);
  const p = fitOpening(S, f, u0, w, y0, win.h, true);
  if (pw === null || p !== pw) return false;
  const frameCol = wallColour(S, openingCells(f, u0, w, y0, win.h, p));
  const ps: Part[] = [], bs: ReturnType<typeof windowParts>['bs'] = [], gs: number[] = [];
  for (let k = 0; k < w; k += 2) {
    const r = windowParts(f, u0 + k, y0, p, win, frameCol, tint);
    ps.push(...r.ps); bs.push(...r.bs); gs.push(k, k);
  }
  if (!put(S, ps, bs, gs)) return false;
  S.info.windows += w / 2;
  archOver(S, f, u0, w, y0 + win.h, p, w === 4 ? '3307.dat' : '3659.dat');
  return true;
}

/**
 * An arch brick over an opening (u0 .. u0+w-1 on face f, wall plane p): the arch is w + 2 wide, its legs stand on the
 * wall either side of the opening, its cells are flat wall at p (replaced by the arch) with air outside. True = placed.
 */
export function archOver(S: Ctx, f: Face, u0: number, w: number, y0: number, p: number, id: string): boolean {
  const sp = PARTS[id];
  if (!sp || !S.ctx.hasPart(id) || sp.sx !== w + 2) return false;
  const { g } = S;
  const cells: [number, number, number][] = [];
  for (let u = u0 - 1; u <= u0 + w; u++) for (let y = y0; y < y0 + sp.h; y++) {
    if (outer(S, f, u, y) !== p) return false;
    const [x, z] = xz(f, u, p);
    if (!isSolid(g, x, y, z) || S.reserved[at(g, x, y, z)]) return false;
    const [xo, zo] = xz(f, u, p + f.s);
    if (inGrid(g, xo, y, zo) && (g.solid[at(g, xo, y, zo)] || S.reserved[at(g, xo, y, zo)])) return false;
    cells.push([x, y, z]);
  }
  for (const u of [u0 - 1, u0 + w]) {
    const [x, z] = xz(f, u, p);
    if (!isSolid(g, x, y0 - 1, z)) return false;
  }
  const R = f.n === 'z' ? ROTY[0] : ROTY[1];
  const pos = placeBody(sp, R, openingBox(f, u0 - 1, w + 2, y0, sp.h, p));
  if (!put(S, [{ part: id, color: wallColour(S, cells), pos, rot: R }], [xfBox(R, pos, sp.body)])) return false;
  if (S.info.arch) S.info.arch.arches++;
  return true;
}

/** Opaque colour nearest a hex (door leaf). */
export function opaqueFor(hex: string | undefined, fallback: number): number {
  if (!hex || !/^#[0-9a-f]{6}$/i.test(hex)) return fallback;
  const m = new ColorMatcher(COMMON_COLORS, 'ciede2000');
  return COMMON_COLORS[m.match(...hexToLinear(hex))].code;
}

/**
 * Glass tint from the analysis colour: Trans-Light Blue for bluish glass, Trans-Black for dark glass (and, on
 * vehicles, for a saturated tint, which is the interior seen through the glass), else Trans-Clear.
 */
export function glassTint(hex: string | undefined, vehicle: boolean): number {
  if (!hex || !/^#[0-9a-f]{6}$/i.test(hex)) return vehicle ? C.transBlack : C.transClear;
  const [r, g, b] = hexToLinear(hex);
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const sat = mx > 0 ? (mx - mn) / mx : 0;
  if (b > r * 1.15 && b >= g * 0.95 && lum > 0.08) return C.transLightBlue;
  if (lum < 0.08) return C.transBlack;
  if (sat < 0.35) return C.transClear;
  return vehicle ? C.transBlack : C.transClear;
}

/** Most common colour of a set of grid cells. */
export function wallColour(S: Ctx, cells: [number, number, number][]): number {
  const n = new Map<number, number>();
  for (const [x, y, z] of cells) { const c = colourAt(S, x, y, z); n.set(c, (n.get(c) ?? 0) + 1); }
  let best: number = C.white, bn = 0;
  for (const [c, k] of n) if (k > bn) { bn = k; best = c; }
  return best;
}
export function openingCells(f: Face, u0: number, w: number, y0: number, h: number, p: number): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let u = u0; u < u0 + w; u++) for (let y = y0; y < y0 + h; y++) { const [x, z] = xz(f, u, p); out.push([x, y, z]); }
  return out;
}

const windowsAvailable = (S: Ctx) => WINDOWS.filter((w) => S.ctx.hasPart(w.frame) && S.ctx.hasPart(w.glass));

/** Analysis feature: vertical centre / height as fractions of the subject box (0 = top). */
function vFrac(a: PhotoAnalysis, f: PhotoFeature) {
  const [, sy0, , sy1] = a.subjectBox;
  const H = Math.max(1e-6, sy1 - sy0);
  return { c: ((f.box[1] + f.box[3]) / 2 - sy0) / H, h: (f.box[3] - f.box[1]) / H };
}

// ------------------------------------------------------------------ vehicles

/**
 * Side windows in the cabin walls: the cabin = length positions whose top is within 2 plates of the roof; windows
 * 2 studs long with a 1-stud pillar between them, in the upper part of the body (above the belt line `yb` + 45 %
 * of the body height), at the analysis window height when there is one. Both sides get the same positions.
 */
export function sideWindows(S: Ctx, A: Axes, yb: number, a?: PhotoAnalysis) {
  const wins = windowsAvailable(S);
  if (!wins.length) return;
  const H = heightProfile(S, A);
  const top = Math.max(...H);
  const cab = H.map((h) => h >= top - 2);
  const c0 = cab.indexOf(true), c1 = cab.lastIndexOf(true);
  if (c0 < 0 || c1 - c0 + 1 < 4) { S.info.notes.push('side windows: no cabin'); return; }
  // a 1-stud pillar stays at each end of the cabin (A / C pillar): it carries the roof's corners
  const lc0 = A.l0 + c0 + 1, lc1 = A.l0 + c1 - 1;
  const feats = (a?.features ?? []).filter((f) => f.kind === 'window' && f.confidence >= 0.4);
  const ref = feats[0] ?? a?.features.find((f) => f.kind === 'windscreen');
  const tint = glassTint(ref?.color, true);
  let target: number | null = null;
  if (a && feats.length) {
    const fy = feats.reduce((s, f) => s + vFrac(a, f).c, 0) / feats.length;
    target = S.bb.y1 + 1 - fy * (S.bb.y1 - S.bb.y0 + 1);
  }
  const plus: Face = A.width === 'x' ? FACES.px : FACES.pz, minus: Face = A.width === 'x' ? FACES.nx : FACES.nz;
  const minC = yb + 0.45 * (top - yb);
  // open cabins (window openings modelled as air between the belt and the roof) are glazed first
  const glazed = glazeOpenings(S, plus, minus, lc0 - 1, lc1 + 1, Math.ceil(minC) - 2, top, tint);
  let best: { win: (typeof wins)[0]; y0: number; ls: number[]; score: number } | null = null;
  for (const win of wins) for (let y0 = yb + 1; y0 + win.h <= top; y0++) {
    const centre = y0 + win.h / 2;
    if (centre < minC) continue;
    const fits: boolean[] = [];
    for (let l = lc0; l < lc1; l++) fits.push(fitOpening(S, plus, l, 2, y0, win.h, true) !== null && fitOpening(S, minus, l, 2, y0, win.h, true) !== null);
    let pick: number[] = [];
    for (let start = 0; start < 3; start++) {
      const ls: number[] = [];
      let last = -Infinity;
      for (let i = start; i < fits.length; i++) if (fits[i] && i >= last + 3) { ls.push(lc0 + i); last = i; }
      const mid = (lc0 + lc1 + 1) / 2;
      const off = (q: number[]) => Math.abs(q.reduce((s, l) => s + l + 1, 0) / Math.max(1, q.length) - mid);
      if (ls.length > pick.length || (ls.length === pick.length && ls.length && off(ls) < off(pick))) pick = ls;
    }
    if (!pick.length) continue;
    // prefer windows with a course over them too (the frame's studs then lock the wall above in)
    const held = pick.filter((l) => fitOpening(S, plus, l, 2, y0, win.h, true) !== null && fitOpening(S, minus, l, 2, y0, win.h, true) !== null).length;
    const score = pick.length * win.h * 10 + held * 8 - (target !== null ? Math.abs(centre - target) : 0);
    if (!best || score > best.score) best = { win, y0, ls: pick, score };
  }
  if (!best) { if (!glazed) S.info.notes.push('side windows: no flat cabin wall'); return; }
  for (const l of best.ls) {
    const ps: Part[] = [], bs: ReturnType<typeof windowParts>['bs'] = [], gs: number[] = [];
    for (const [k, f] of [plus, minus].entries()) {
      const p = fitOpening(S, f, l, 2, best.y0, best.win.h, true);
      if (p === null) break;
      const col = wallColour(S, openingCells(f, l, 2, best.y0, best.win.h, p));
      const w = windowParts(f, l, best.y0, p, best.win, col, tint);
      ps.push(...w.ps); bs.push(...w.bs); gs.push(k, k);
    }
    if (ps.length === 4 && put(S, ps, bs, gs)) S.info.windows += 2;
  }
}

/**
 * Glass in the window openings of an open cabin: rows 3 plates tall of air on the sill's wall plane, with a solid
 * course under them (sill) and a roof edge over them (at most a plate higher, on the same or the next plane out), the same on both sides, become trans bricks (1x4 / 1x2 without
 * centre studs) in the glass tint. Returns the number of glass bricks placed.
 */
function glazeOpenings(S: Ctx, plus: Face, minus: Face, l0: number, l1: number, yLo: number, yHi: number, tint: number): number {
  const pieces = ([[4, '3066.dat'], [2, '3065.dat']] as const).filter(([, id]) => S.ctx.hasPart(id));
  if (!pieces.length) return 0;
  const { g } = S;
  const free = (x: number, y: number, z: number) => isSolid(g, x, y, z) && !S.reserved[at(g, x, y, z)];
  const air = (x: number, y: number, z: number) => inGrid(g, x, y, z) && !g.solid[at(g, x, y, z)] && !S.reserved[at(g, x, y, z)];
  /** sill plane of face f at (l, y0) when an opening 3 plates tall fits there, else null */
  const slot = (f: Face, l: number, y0: number): number | null => {
    const p = outer(S, f, l, y0 - 1);
    if (p === null) return null;
    const [x, z] = xz(f, l, p);
    // the sill carries the glass (its studs); a lintel / roof edge right over it is not needed (it may sit one stud out)
    if (!free(x, y0 - 1, z)) return null;
    let roof = false;
    for (let y = y0 + 3; y <= y0 + 4 && !roof; y++) for (const q of [p, p + f.s]) { const [xr, zr] = xz(f, l, q); if (isSolid(g, xr, y, zr)) roof = true; }
    if (!roof) return null;
    for (let y = y0; y < y0 + 3; y++) {
      if (!air(x, y, z)) return null;
      const [xo, zo] = xz(f, l, p + f.s);
      if (inGrid(g, xo, y, zo) && (g.solid[at(g, xo, y, zo)] || S.reserved[at(g, xo, y, zo)])) return null;
    }
    return p;
  };
  let n = 0;
  for (let y0 = Math.max(1, yLo); y0 + 3 <= yHi; y0++) {
    const ps: (number | null)[][] = [];
    for (let l = l0; l <= l1; l++) ps.push([slot(plus, l, y0), slot(minus, l, y0)]);
    for (let i = 0; i < ps.length; ) {
      if (ps[i][0] === null || ps[i][1] === null) { i++; continue; }
      let j = i;
      while (j + 1 < ps.length && ps[j + 1][0] === ps[i][0] && ps[j + 1][1] === ps[i][1]) j++;
      const len = j - i + 1;
      // widest pieces first, centred in the opening (an odd cell is left open)
      const ws: number[] = [];
      let left = len - (len % 2);
      for (const [w] of pieces) while (left >= w) { ws.push(w); left -= w; }
      let u = l0 + i + Math.floor((len - ws.reduce((a, b) => a + b, 0)) / 2);
      for (const w of ws) {
        const id = pieces.find(([pw]) => pw === w)![1];
        const parts: Part[] = [], boxes: ReturnType<typeof windowParts>['bs'] = [];
        for (const [k, f] of [plus, minus].entries()) {
          const R = ROTY[rotFor([0, 0, -1], f.d)];
          const pos = placeBody(PARTS[id], R, openingBox(f, u, w, y0, 3, ps[i][k]!));
          parts.push({ part: id, color: tint, pos, rot: R });
          boxes.push(xfBox(R, pos, PARTS[id].body));
        }
        if (put(S, parts, boxes)) { n += 2; S.info.windows += 2; }
        u += w;
      }
      i = j + 1;
    }
  }
  return n;
}

// ------------------------------------------------------------------ buildings

export const BUILDINGS = /\b(house|home|building|cottage|cabin|castle|tower|shop|store|church|barn|hut|garage|station|lighthouse|skyscraper|school|hotel|mill|temple|chalet|villa|bungalow)\b/i;

/**
 * Facade openings from the analysis boxes: the door (60596 + 60623) on the facade of its view at ground level,
 * windows (2 or 4 studs wide, 6 or 9 plates tall) on the facade of their view near their projected spot; windows
 * the analysis marks `mirrored` are side-wall windows and go on both side walls. Every window is repeated in the
 * mirror image(s) of the model when that spot is free.
 */
export function buildingOpenings(S: Ctx, a: PhotoAnalysis) {
  const wins = windowsAvailable(S);
  const feats = a.features.filter((f) => (f.kind === 'window' || f.kind === 'door') && f.confidence >= 0.4);
  if (!feats.length) return;
  const { bb } = S;
  const Hm = bb.y1 - bb.y0 + 1;
  const [sx0, , sx1] = a.subjectBox;
  const mirrorX = S.ctx.mirrorX, mirrorZ = (S.ctx as { mirrorZ?: number }).mirrorZ;
  const mx = (x: number) => (mirrorX === undefined ? x : 2 * mirrorX - 1 - x);
  const mz = (z: number) => (mirrorZ === undefined ? z : 2 * mirrorZ - 1 - z);
  const faceOf = (f: PhotoFeature) => (f.view === 'back' ? FACES.nz : FACES.pz);
  /** u (grid x) of a front / back box centre, projected across the model's x extent. */
  const uOf = (f: PhotoFeature) => {
    let fx = ((f.box[0] + f.box[2]) / 2 - sx0) / Math.max(1e-6, sx1 - sx0);
    if (f.view === 'back') fx = 1 - fx;
    return bb.x0 + fx * (bb.x1 - bb.x0 + 1);
  };
  const widthOf = (f: PhotoFeature) => ((f.box[2] - f.box[0]) / Math.max(1e-6, sx1 - sx0)) * (bb.x1 - bb.x0 + 1);
  const yOf = (fy: number) => bb.y1 + 1 - fy * Hm;
  const ownViews = new Set(feats.filter((f) => !f.mirrored).map((f) => f.view));

  // ---- door: the most confident one, lowest spot on its facade near its projected position. The 1x4x6 door
  // (60596 + 60623) needs 18 plates of wall; on a smaller house the door is a 1x2x3 window frame in the door colour
  // with clear glass (a glazed door), 9 plates. ----
  const castle = castleStyle(a);
  const door = feats.filter((f) => f.kind === 'door').sort((p, q) => q.confidence - p.confidence)[0];
  if (door) {
    const f = faceOf(door);
    const uc = uOf(door);
    const leaf = opaqueFor(door.color, C.reddishBrown);
    const small = wins.find((w) => w.h === 9);
    const kinds: ('big' | 'small')[] = [];
    if (S.ctx.hasPart(DOOR.frame) && S.ctx.hasPart(DOOR.door)) kinds.push('big');
    if (small) kinds.push('small');
    let done = false;
    for (const kind of kinds) {
      const w = kind === 'big' ? DOOR.w : 2, h = kind === 'big' ? DOOR.h : small!.h;
      const us = Array.from({ length: 13 }, (_, i) => Math.round(uc - w / 2) + (i % 2 ? (i + 1) / 2 : -i / 2));
      // ground level: the lowest layer the door fits at (it stands on the base / the lowest wall course)
      for (let y0 = bb.y0 + 1; y0 + h <= bb.y1 && y0 <= bb.y0 + Math.max(4, Hm / 4) && !done; y0++) {
        for (const u0 of us) {
          if (fitOpening(S, f, u0 - 1, w + 2, y0, h, false) === null) continue; // wall on both sides of the door
          const p = fitOpening(S, f, u0, w, y0, h, false);
          if (p === null) continue;
          let ok: boolean;
          if (kind === 'big') {
            const R = ROTY[rotFor([0, 0, 1], f.d)]; // the door leaf hangs on the frame's +Z side: outwards
            const pos = placeBody(PARTS[DOOR.frame], R, openingBox(f, u0, w, y0, h, p));
            const o = mulV(R, DOOR.hinge);
            const dp: V3 = [pos[0] + o[0], pos[1] + o[1], pos[2] + o[2]];
            const frameCol = castle ? wallColour(S, openingCells(f, u0, w, y0, h, p)) : C.white;
            ok = put(S, [{ part: DOOR.frame, color: frameCol, pos, rot: R }, { part: DOOR.door, color: leaf, pos: dp, rot: R }],
              [xfBox(R, pos, PARTS[DOOR.frame].body), xfBox(R, dp, PARTS[DOOR.door].body)], [0, 0]);
            if (ok && castle) archOver(S, f, u0, w, y0 + h, p, '3307.dat') || archOver(S, f, u0, w, y0 + h, p, '3455.dat');
          } else {
            const r = windowParts(f, u0, y0, p, small!, leaf, C.transClear);
            ok = put(S, r.ps, r.bs, r.groups);
            if (ok && castle) archOver(S, f, u0, w, y0 + h, p, '6182.dat') || archOver(S, f, u0, w, y0 + h, p, '3659.dat');
          }
          if (ok) { S.info.doors++; done = true; break; }
        }
      }
      if (done) break;
    }
    if (!done) S.info.notes.push('door: no flat wall at ground level');
  }
  // castle style: arched windows (30044 + lattice pane) under an arch brick
  const archWin = castle && S.ctx.hasPart(ARCH_WINDOW.frame) && S.ctx.hasPart(ARCH_WINDOW.glass);
  if (archWin) wins.splice(0, wins.length, ARCH_WINDOW);
  if (!wins.length) return;

  // ---- windows ----
  const pickWin = (hLayers: number) => wins.find((w) => w.h <= hLayers + 2) ?? wins[wins.length - 1];
  /** Try to place a window w studs wide (2 or 4 = two frames side by side) around (uc, yc) on face f. */
  const place = (f: Face, uc: number, yc: number, w: number, win: (typeof wins)[0], tint: number, radius = 4): { u0: number; y0: number } | null => {
    const cands: [number, number, number][] = [];
    for (let du = -radius; du <= radius; du++) for (let dy = -radius; dy <= radius; dy++) cands.push([du, dy, Math.abs(du) + Math.abs(dy) * 1.2]);
    cands.sort((p, q) => p[2] - q[2]);
    const u00 = Math.round(uc - w / 2), y00 = Math.round(yc - win.h / 2);
    for (const [du, dy] of cands) {
      const u0 = u00 + du, y0 = y00 + dy;
      if (tryWindow(f, u0, y0, w, win, tint)) return { u0, y0 };
    }
    return null;
  };
  const tryWindow = (f: Face, u0: number, y0: number, w: number, win: (typeof wins)[0], tint: number): boolean => {
    // keep a 1-stud wall to either side so the window is set into the wall, not into its corner
    const pw = fitOpening(S, f, u0 - 1, w + 2, y0, win.h, true);
    const p = fitOpening(S, f, u0, w, y0, win.h, true);
    if (pw === null || p !== pw) return false;
    const ps: Part[] = [], bs: ReturnType<typeof windowParts>['bs'] = [], gs: number[] = [];
    const frameCol = archWin ? wallColour(S, openingCells(f, u0, w, y0, win.h, p)) : C.white;
    for (let k = 0; k < w; k += 2) {
      const r = windowParts(f, u0 + k, y0, p, win, frameCol, tint);
      ps.push(...r.ps); bs.push(...r.bs); gs.push(k, k);
    }
    if (!put(S, ps, bs, gs)) return false;
    S.info.windows += w / 2;
    if (archWin && w === 2) archOver(S, f, u0, 2, y0 + win.h, p, '3659.dat');
    return true;
  };
  /** Mirror images of a placed window (u0..u0+w-1 on face f). */
  const images = (f: Face, u0: number, w: number): [Face, number][] => {
    const out: [Face, number][] = [];
    if (f.n === 'z') {
      if (mirrorX !== undefined) out.push([f, mx(u0 + w - 1)]);
      if (mirrorZ !== undefined) {
        const g = f.s > 0 ? FACES.nz : FACES.pz;
        if (!ownViews.has(g === FACES.pz ? 'front' : 'back')) for (const [, u] of [[f, u0], ...out] as [Face, number][]) out.push([g, u]);
      }
    } else {
      if (mirrorZ !== undefined) out.push([f, mz(u0 + w - 1)]);
      for (const [, u] of [[f, u0], ...out] as [Face, number][]) out.push([f.s > 0 ? FACES.nx : FACES.px, u]);
    }
    return out;
  };
  // windows of one storey share a sill line: box centres within 12 % of the height snap to their cluster mean
  const winFeats = feats.filter((q) => q.kind === 'window').sort((p, q) => q.confidence - p.confidence);
  const centre = new Map<PhotoFeature, number>();
  const byY = [...winFeats].sort((p, q) => vFrac(a, p).c - vFrac(a, q).c);
  for (let i = 0; i < byY.length; ) {
    let j = i;
    while (j + 1 < byY.length && vFrac(a, byY[j + 1]).c - vFrac(a, byY[j]).c < 0.12) j++;
    const grp = byY.slice(i, j + 1);
    const m = grp.reduce((s, f) => s + vFrac(a, f).c, 0) / grp.length;
    for (const f of grp) centre.set(f, m);
    i = j + 1;
  }
  const sideDone: number[] = [];
  for (const ft of winFeats) {
    const v = { ...vFrac(a, ft), c: centre.get(ft)! };
    const win = pickWin(v.h * Hm);
    const yc = yOf(v.c);
    const tint = glassTint(ft.color, false);
    const w = widthOf(ft) >= 3.2 && !archWin ? 4 : 2;
    if (ft.mirrored) {
      // side walls (+x and its mirror -x), centred along the wall
      if (sideDone.some((y) => Math.abs(y - yc) < win.h)) continue;
      const f = FACES.px;
      const uc = mirrorZ !== undefined ? mirrorZ : (bb.z0 + bb.z1 + 1) / 2;
      const r = place(f, uc, yc, w, win, tint, 5);
      if (!r) continue;
      sideDone.push(yc);
      for (const [g, u] of images(f, r.u0, w)) tryWindow(g, u, r.y0, w, win, tint);
      continue;
    }
    const f = faceOf(ft);
    const r = place(f, uOf(ft), yc, w, win, tint);
    if (!r) continue;
    // the mirror image only for symmetric features; but the opposite facade gets the image when it has no boxes of its own
    for (const [g, u] of images(f, r.u0, w)) if (g !== f) tryWindow(g, u, r.y0, w, win, tint);
  }
  void wallColour;
}

export const _openingsTest = { fitOpening, outer, FACES };
