// refine(): surface substitution on the packed brick list.
//   - stair-steps on sloped surfaces -> 45° / 33° slopes (rows merged into 2x2 / 2x3 / 2x4 / 3x2 / 3x4)
//   - top edges of flat tops (balanced+) -> curved slopes 2x1 / 2x2 (no studs, so only where nothing sits on top)
//   - detailed: lone 1x1 / 2x2 columns -> round bricks / plates, uncovered top plates -> tiles
// Works in grid cells: bricks are mapped back onto the voxel grid (frame offset auto-detected), substitutions are
// decided on cell occupancy, the bricks they cut are removed and their left-over cells re-packed with plain
// bricks / plates of the same colour. Mirror symmetry (ctx.mirrorX) is enforced: a substitution is only made when
// its mirror image qualifies too.

import type { Mat3 } from '../../../model/types';
import type { SpecialContext } from '../contracts';
import type { VoxelGrid } from '../voxelize';
import type { SpecialGrid } from './reserve';
import { BRICKS, PLATES } from '../bricks';
import { CURVE_BY_WIDTH, PARTS, SLOPE33_BY_WIDTH, SLOPE45_BY_WIDTH, TILE_BY_SIZE } from './library';
import { IDENT, ROTY, cellsToLd, cleanM, ldToCells, mulV, placeBody, rotFor, xfBox, type Part } from './geom';
import { palindrome } from './reserve';

export interface RefineInfo {
  offset: [number, number, number];
  frameFit: number;
  slopes45: number; slopes33: number; curves: number; tiles: number; round: number;
  removed: number; added: number;
  /** substitutions taken back because they cut the only stud contact of a part group */
  reverted: number;
}

const STD = new Map<string, { a: number; b: number; h: number }>();
for (const [a, b, id] of PLATES) STD.set(id, { a, b, h: 1 });
for (const [a, b, id] of BRICKS) STD.set(id, { a, b, h: 3 });

interface Item {
  part: Part;
  std: boolean;
  /** cell box in grid coordinates (y up): [x0, y0, z0, x1, y1, z1) */
  c: [number, number, number, number, number, number];
  removed?: boolean;
}

interface Sub {
  part: string;
  rotDir: number; // grid direction the local -Z points to
  cells: [number, number, number, number, number, number];
  color: number;
  kind: 'slope45' | 'slope33' | 'curve' | 'round' | 'tile';
}

/**
 * @param reserved cells taken by reserve() parts (they are not in `bricks` when the pipeline only passes the packed
 * bricks): treated as occupied, never substituted, never covered by tiles.
 */
export function refineImpl(g: SpecialGrid, bricks: Part[], ctx: SpecialContext, reserved?: Uint8Array): { bricks: Part[]; info: RefineInfo } {
  const { nx, ny, nz } = g;
  const N = nx * ny * nz;
  const info: RefineInfo = { offset: [0, 0, 0], frameFit: 0, slopes45: 0, slopes33: 0, curves: 0, tiles: 0, round: 0, removed: 0, added: 0, reverted: 0 };
  if (!bricks.length) return { bricks, info };

  // ---- 1. cell boxes in the bricks' own frame, then find the offset to the grid ----
  const raw: Item[] = bricks.map((p) => {
    const s = STD.get(p.part);
    if (s) {
      const v = mulV(p.rot, [s.b, 0, s.a]);
      const sx = Math.round(Math.abs(v[0])), sz = Math.round(Math.abs(v[2]));
      const x0 = Math.round(p.pos[0] / 20 - sx / 2), yt = Math.round(-p.pos[1] / 8), z0 = Math.round(-p.pos[2] / 20 - sz / 2);
      return { part: p, std: true, c: [x0, yt - s.h, z0, x0 + sx, yt, z0 + sz] };
    }
    const b = PARTS[p.part] ? xfBox(p.rot, p.pos, PARTS[p.part].body) : null;
    const c = b ? ldToCells(b) : ([0, 0, 0, 0, 0, 0] as Item['c']);
    return { part: p, std: false, c };
  });
  const fr = g.frame;
  let d = fr ? { offset: [fr.cx, fr.y0, fr.cz] as [number, number, number], fit: offsetScore(g, raw, [fr.cx, fr.y0, fr.cz]) } : findOffset(g, raw);
  if (d.fit < 0.8 && fr) d = findOffset(g, raw);
  info.offset = d.offset; info.frameFit = d.fit;
  if (d.fit < 0.8) return { bricks, info }; // could not map the bricks onto the grid: leave untouched
  const items: Item[] = raw.map((it) => {
    if (it.std) return { ...it, c: [it.c[0] + d.offset[0], it.c[1] + d.offset[1], it.c[2] + d.offset[2], it.c[3] + d.offset[0], it.c[4] + d.offset[1], it.c[5] + d.offset[2]] };
    // special parts: recompute in the grid frame (unknown parts keep an empty box)
    const p = it.part;
    if (!PARTS[p.part]) return { ...it, c: [0, 0, 0, 0, 0, 0] };
    const pos: [number, number, number] = [p.pos[0] + d.offset[0] * 20, p.pos[1] - d.offset[1] * 8, p.pos[2] - d.offset[2] * 20];
    return { ...it, c: ldToCells(xfBox(p.rot, pos, PARTS[p.part].body)) };
  });

  // ---- 2. occupancy ----
  const owner = new Int32Array(N).fill(-1);
  const inG = (x: number, y: number, z: number) => x >= 0 && y >= 0 && z >= 0 && x < nx && y < ny && z < nz;
  const I = (x: number, y: number, z: number) => x + nx * (z + nz * y);
  items.forEach((it, k) => {
    const [x0, y0, z0, x1, y1, z1] = it.c;
    for (let y = y0; y < y1; y++) for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) if (inG(x, y, z)) owner[I(x, y, z)] = k;
  });
  const res = reserved && reserved.length === N ? reserved : null;
  const occ = (x: number, y: number, z: number) => inG(x, y, z) && (owner[I(x, y, z)] >= 0 || (res !== null && res[I(x, y, z)] === 1));
  // Items outside the main stud-connected body (floating input parts the connectivity repair would re-tile) are left
  // alone: a substitution turns its cells into a fixed part, which the repair can no longer move, so it would stay
  // loose. Components: items joined by vertical cell contact; reserved cells (special parts) join as one body each.
  // The items around them are left alone too, so the repair can still re-tile across to them.
  const main = mainBody(items.map((it) => it.c), res, nx, ny, nz);
  {
    const near = new Set<number>();
    items.forEach((it, k) => {
      if (main[k]) return;
      const [x0, y0, z0, x1, y1, z1] = it.c;
      for (let y = y0 - 1; y <= y1; y++) for (let z = z0 - 1; z <= z1; z++) for (let x = x0 - 1; x <= x1; x++)
        if (inG(x, y, z) && owner[I(x, y, z)] >= 0) near.add(owner[I(x, y, z)]);
    });
    for (const k of near) main[k] = 0;
  }
  const std = (x: number, y: number, z: number) => {
    if (!inG(x, y, z)) return false;
    const k = owner[I(x, y, z)];
    return k >= 0 && items[k].std && main[k] === 1 && !(res && res[I(x, y, z)]);
  };
  const colourAt = (x: number, y: number, z: number) => items[owner[I(x, y, z)]].part.color;
  const claimed = new Uint8Array(N);

  const detail = ctx.detail;
  const cat = ctx.analysis?.category ?? '';
  const boxy = /\b(house|building|castle|tower|box|shelf|table|wall)\b/i.test(cat);
  const mirror = ctx.mirrorX;
  const mirrorZ = (ctx as { mirrorZ?: number }).mirrorZ;
  const mx = (x: number) => (mirror === undefined ? x : 2 * mirror - 1 - x);
  const mz = (z: number) => (mirrorZ === undefined ? z : 2 * mirrorZ - 1 - z);
  const DX = [1, -1, 0, 0], DZ = [0, 0, 1, -1];

  // ---- 3. candidates ----
  type Cand = { kind: 'slope45' | 'slope33' | 'curve'; x: number; z: number; t: number; dir: number };
  const key = (c: Cand) => `${c.kind}|${c.x}|${c.z}|${c.t}|${c.dir}`;
  const cands = new Map<string, Cand>();
  const allStd = (x: number, z: number, y0: number, y1: number) => { for (let y = y0; y <= y1; y++) if (!std(x, y, z)) return false; return true; };
  const noneOcc = (x: number, z: number, y0: number, y1: number) => { for (let y = y0; y <= y1; y++) if (occ(x, y, z)) return false; return true; };
  for (let t = 2; t < ny; t++) for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
    if (!std(x, t, z) || occ(x, t + 1, z)) continue; // f: top cell of a column
    for (let dir = 0; dir < 4; dir++) {
      const ax = x + DX[dir], az = z + DZ[dir]; // in front (downhill)
      const bx = x - DX[dir], bz = z - DZ[dir]; // behind
      const cx = x - 2 * DX[dir], cz = z - 2 * DZ[dir];
      if (!noneOcc(ax, az, t - 1, t)) continue; // the slope's face needs air in front of its upper 2 plates
      // 45°: f + b, 3 plates; evidence: the surface keeps rising behind (something on b's studs)
      if (allStd(x, z, t - 2, t) && allStd(bx, bz, t - 2, t) && occ(bx, t + 1, bz) && (occ(x, t - 3, z) || occ(bx, t - 3, bz)))
        cands.set(key({ kind: 'slope45', x, z, t, dir }), { kind: 'slope45', x, z, t, dir });
      // 33°: f + m (both uncovered) + b (covered), 3 plates
      if (allStd(x, z, t - 2, t) && allStd(bx, bz, t - 2, t) && allStd(cx, cz, t - 2, t) && !occ(bx, t + 1, bz) && occ(cx, t + 1, cz) &&
        (occ(x, t - 3, z) || occ(bx, t - 3, bz) || occ(cx, t - 3, cz)))
        cands.set(key({ kind: 'slope33', x, z, t, dir }), { kind: 'slope33', x, z, t, dir });
      // curve: flat top edge (f and b uncovered), 2 plates, air in front of both plates
      if (detail !== 'simple' && !boxy && allStd(x, z, t - 1, t) && allStd(bx, bz, t - 1, t) && !occ(bx, t + 1, bz) &&
        (occ(x, t - 2, z) || occ(bx, t - 2, bz)) && occ(cx, t, cz))
        cands.set(key({ kind: 'curve', x, z, t, dir }), { kind: 'curve', x, z, t, dir });
    }
  }
  /** The candidate and its mirror images (mirror X and / or Z), duplicates removed. */
  const orbit = (c: Cand): Cand[] => {
    const out = [c];
    const fx = (q: Cand): Cand => ({ ...q, x: mx(q.x), dir: q.dir === 0 ? 1 : q.dir === 1 ? 0 : q.dir });
    const fz = (q: Cand): Cand => ({ ...q, z: mz(q.z), dir: q.dir === 2 ? 3 : q.dir === 3 ? 2 : q.dir });
    if (mirror !== undefined) out.push(fx(c));
    if (mirrorZ !== undefined) for (const q of [...out]) out.push(fz(q));
    const seen = new Set<string>();
    return out.filter((q) => { const k = key(q); if (seen.has(k)) return false; seen.add(k); return true; });
  };
  const cellsOf = (c: Cand): number[][] => {
    const depth = c.kind === 'slope33' ? 3 : 2, h = c.kind === 'curve' ? 2 : 3;
    const out: number[][] = [];
    for (let k = 0; k < depth; k++) for (let y = c.t - h + 1; y <= c.t; y++) out.push([c.x - k * DX[c.dir], y, c.z - k * DZ[c.dir]]);
    return out;
  };
  const free = (c: Cand) => cellsOf(c).every(([x, y, z]) => inG(x, y, z) && !claimed[I(x, y, z)]);
  const claim = (c: Cand) => cellsOf(c).forEach(([x, y, z]) => { claimed[I(x, y, z)] = 1; });
  const accepted: Cand[] = [];
  const order: Cand['kind'][] = detail === 'simple' ? ['slope45'] : ['slope33', 'slope45', 'curve'];
  for (const kind of order) {
    const list = [...cands.values()].filter((c) => c.kind === kind).sort((p, q) => q.t - p.t || p.z - q.z || p.x - q.x || p.dir - q.dir);
    for (const c of list) {
      const orb = orbit(c);
      if (!orb.every((q) => cands.has(key(q)) && free(q))) continue;
      // the images must not overlap each other
      const seenCells = new Set<string>();
      let clash = false;
      for (const q of orb) for (const v of cellsOf(q)) { const k = v.join(','); if (seenCells.has(k)) clash = true; seenCells.add(k); }
      if (clash) continue;
      for (const q of orb) { claim(q); accepted.push(q); }
    }
  }

  // ---- 4. merge accepted cells into runs along the edge, split into available widths ----
  const subs: Sub[] = [];
  const groups = new Map<string, Cand[]>();
  for (const c of accepted) {
    const along = c.dir < 2 ? 'z' : 'x'; // run direction perpendicular to dir
    const fixed = along === 'z' ? c.x : c.z;
    const k = `${c.kind}|${c.t}|${c.dir}|${fixed}|${colourAt(c.x, c.t, c.z)}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(c);
  }
  for (const [, list] of groups) {
    const along = list[0].dir < 2 ? 'z' : 'x';
    list.sort((p, q) => (along === 'z' ? p.z - q.z : p.x - q.x));
    let i = 0;
    while (i < list.length) {
      let j = i;
      while (j + 1 < list.length && (along === 'z' ? list[j + 1].z - list[j].z : list[j + 1].x - list[j].x) === 1) j++;
      const run = list.slice(i, j + 1);
      i = j + 1;
      const kind = run[0].kind;
      const widths = kind === 'slope45' ? [4, 3, 2, 1] : kind === 'slope33' ? [4, 2, 1] : [2, 1];
      const n = run.length;
      if (detail === 'simple' && n < 2) continue; // simple: only proper rows of slopes
      let pieces: number[];
      const p0 = along === 'z' ? run[0].z : run[0].x, p1 = p0 + n - 1;
      const m = along === 'x' ? mirror : mirrorZ;
      const mm = along === 'x' ? mx : mz;
      if (m !== undefined && mm(p0) === p1) pieces = palindrome(n, widths);
      else {
        pieces = [];
        let left = n;
        while (left > 0) { const w = widths.find((ww) => ww <= left)!; pieces.push(w); left -= w; }
        if (m !== undefined && (p0 + p1) / 2 > m - 0.5) pieces.reverse(); // the high side mirrors the low side
      }
      let pos = p0;
      for (const w of pieces) {
        const c = run[0];
        const depth = kind === 'slope33' ? 3 : 2, h = kind === 'curve' ? 2 : 3;
        // footprint: front cells at (along = pos..pos+w-1), back cells offset by -dir
        const xs: number[] = [], zs: number[] = [];
        for (let a = pos; a < pos + w; a++) for (let k = 0; k < depth; k++) {
          const fx = along === 'x' ? a : c.x, fz = along === 'z' ? a : c.z;
          xs.push(fx - k * DX[c.dir]); zs.push(fz - k * DZ[c.dir]);
        }
        const cells: Sub['cells'] = [Math.min(...xs), c.t - h + 1, Math.min(...zs), Math.max(...xs) + 1, c.t + 1, Math.max(...zs) + 1];
        const id = kind === 'slope45' ? SLOPE45_BY_WIDTH[w] : kind === 'slope33' ? SLOPE33_BY_WIDTH[w] : CURVE_BY_WIDTH[w];
        // buildings: no 1-wide slopes / curves (a few bold parts read better than many small ones); the cells stay bricks
        if (id && ctx.hasPart(id) && !(boxy && w === 1)) subs.push({ part: id, rotDir: c.dir, cells, color: colourAt(c.x, c.t, c.z), kind });
        else for (const [x, y, z] of cellsOfBox(cells)) claimed[I(x, y, z)] = 0; // unavailable: give the cells back
        pos += w;
      }
    }
  }

  // ---- 5. detailed: round parts and tiles (whole-item swaps) ----
  const swaps = new Map<number, string>(); // item index -> new part id (same footprint and height)
  if (detail === 'detailed') {
    const qualifies = (k: number): string | null => {
      const it = items[k];
      if (!it.std || it.removed || !main[k]) return null;
      const [x0, y0, z0, x1, y1, z1] = it.c;
      for (let y = y0; y < y1; y++) for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) if (inG(x, y, z) && claimed[I(x, y, z)]) return null;
      const sx = x1 - x0, sz = z1 - z0, h = y1 - y0;
      // round: 1x1 / 2x2 with at least 3 of 4 sides open at every layer
      if (sx === sz && (sx === 1 || sx === 2)) {
        let open = 0;
        for (let dir = 0; dir < 4; dir++) {
          let ok = true;
          for (let y = y0; y < y1 && ok; y++) for (let a = 0; a < sx && ok; a++) {
            const x = dir === 0 ? x1 : dir === 1 ? x0 - 1 : x0 + a, z = dir === 2 ? z1 : dir === 3 ? z0 - 1 : z0 + a;
            if (occ(x, y, z)) ok = false;
          }
          if (ok) open++;
        }
        // a round part is fixed once swapped (the connectivity repair cannot re-tile it), so it must already be held:
        // a packed brick right under or over its footprint (a floating input part would stay floating)
        let held = false;
        for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) if (std(x, y0 - 1, z) || std(x, y1, z)) held = true;
        if (open >= 3 && held) {
          const id = h === 3 ? (sx === 1 ? '3062b.dat' : '3941.dat') : (sx === 1 ? '6141.dat' : '4032b.dat');
          if (ctx.hasPart(id)) return id;
        }
      }
      // tile: an uncovered plate
      if (h === 1) {
        for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) if (occ(x, y1, z)) return null;
        let below = false; // a tile must sit on studs
        for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) if (std(x, y0 - 1, z)) below = true;
        if (!below) return null;
        const id = TILE_BY_SIZE[`${Math.min(sx, sz)}x${Math.max(sx, sz)}`];
        if (id && ctx.hasPart(id)) return id;
      }
      return null;
    };
    const byBox = new Map<string, number>();
    items.forEach((it, k) => { if (it.std) byBox.set(it.c.join(','), k); });
    items.forEach((it, k) => {
      if (!it.std) return;
      const id = qualifies(k);
      if (!id) return;
      const [x0, y0, z0, x1, y1, z1] = it.c;
      const images: number[][] = [];
      if (mirror !== undefined) images.push([mx(x1 - 1), y0, z0, mx(x0) + 1, y1, z1]);
      if (mirrorZ !== undefined) for (const b of [it.c as number[], ...images]) images.push([b[0], b[1], mz(b[5] - 1), b[3], b[4], mz(b[2]) + 1]);
      for (const b of images) {
        const mk = byBox.get(b.join(','));
        if (mk === undefined || qualifies(mk) !== id) return;
      }
      swaps.set(k, id);
    });
  }

  // ---- 6. apply: remove cut items, re-pack their left-over cells, add substitutions. A substitution must not cut
  // the only stud contact of a part group (e.g. a roof plate bridging an overhang): the result is rebuilt as cell
  // boxes, and substitutions next to cells that came loose are taken back until nothing new comes loose. ----
  const evaluate = (active: Sub[]) => {
    const claimedNow = new Uint8Array(N);
    for (const s of active) for (const [x, y, z] of cellsOfBox(s.cells)) if (inG(x, y, z)) claimedNow[I(x, y, z)] = 1;
    const cutBy = new Map<number, Sub[]>();
    for (const s of active) for (const [x, y, z] of cellsOfBox(s.cells)) {
      const k = owner[I(x, y, z)];
      if (k < 0) continue;
      const l = cutBy.get(k) ?? [];
      if (!l.includes(s)) l.push(s);
      cutBy.set(k, l);
    }
    const repacked: { part: Part; c: Box6 }[] = [];
    for (const k of cutBy.keys()) {
      const it = items[k];
      const cells = cellsOfBox(it.c).filter(([x, y, z]) => inG(x, y, z) && !claimedNow[I(x, y, z)]);
      repacked.push(...repack(cells, it.part.color, it.c[4] - it.c[1] === 3));
    }
    return { cutBy, repacked };
  };
  const looseCells = (boxes: Box6[]) => {
    const main = mainBody(boxes, res, nx, ny, nz);
    const out: number[] = [];
    boxes.forEach((b, k) => { if (!main[k]) for (const [x, y, z] of cellsOfBox(b)) if (inG(x, y, z)) out.push(I(x, y, z)); });
    return out;
  };
  const looseBefore = new Set(looseCells(items.map((it) => it.c)));
  let active = subs;
  for (let iter = 0; iter < 8 && active.length; iter++) {
    const { cutBy, repacked } = evaluate(active);
    const boxes: Box6[] = [];
    items.forEach((it, k) => { if (!cutBy.has(k)) boxes.push(it.c); });
    for (const s of active) boxes.push(s.cells);
    for (const q of repacked) boxes.push(q.c);
    const fresh = looseCells(boxes).filter((c) => !looseBefore.has(c));
    if (!fresh.length) break;
    // take back the substitutions that cut an item at or right next to a newly loose cell
    const drop = new Set<Sub>();
    for (const c of fresh) {
      const x = c % nx, z = Math.floor(c / nx) % nz, y = Math.floor(c / (nx * nz));
      for (const [dx, dy, dz] of [[0, 0, 0], [0, 1, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]) {
        if (!inG(x + dx, y + dy, z + dz)) continue;
        const k = owner[I(x + dx, y + dy, z + dz)];
        if (k >= 0) for (const sb of cutBy.get(k) ?? []) drop.add(sb);
      }
    }
    if (!drop.size) break;
    active = active.filter((sb) => !drop.has(sb));
  }
  info.reverted = subs.length - active.length;

  const out: Part[] = [];
  const { cutBy, repacked } = evaluate(active);
  items.forEach((it, k) => {
    if (cutBy.has(k)) { info.removed++; return; }
    const sw = swaps.get(k);
    if (sw) {
      const kind = PARTS[sw].kind;
      if (kind === 'tile') info.tiles++; else info.round++;
      out.push({ ...it.part, part: sw });
      return;
    }
    out.push(it.part);
  });
  const toModel = (p: Part): Part => ({ ...p, pos: [p.pos[0] - d.offset[0] * 20, p.pos[1] + d.offset[1] * 8, p.pos[2] + d.offset[2] * 20] });
  for (const s of active) {
    const R: Mat3 = ROTY[rotFor([0, 0, -1], s.rotDir)];
    const target = cellsToLd(...s.cells);
    const pos = placeBody(PARTS[s.part], R, target);
    out.push(toModel({ part: s.part, color: s.color, pos, rot: cleanM(R) }));
    info.added++;
    if (s.kind === 'slope45') info.slopes45++; else if (s.kind === 'slope33') info.slopes33++; else if (s.kind === 'curve') info.curves++;
  }
  for (const q of repacked) { out.push(toModel(q.part)); info.added++; }
  return { bricks: out, info };
}

type Box6 = [number, number, number, number, number, number];

/** 1 per cell box in the largest stud-connected group (vertical cell contacts; each 6-connected reserved blob is one body). */
function mainBody(boxes: Box6[], res: Uint8Array | null, nx: number, ny: number, nz: number): Uint8Array {
  const N = nx * ny * nz, NL = nx * nz;
  const n = boxes.length;
  // node ids: boxes 0..n-1, reserved blobs n..
  const node = new Int32Array(N).fill(-1);
  boxes.forEach((c, k) => {
    for (let y = Math.max(0, c[1]); y < Math.min(ny, c[4]); y++) for (let z = Math.max(0, c[2]); z < Math.min(nz, c[5]); z++)
      for (let x = Math.max(0, c[0]); x < Math.min(nx, c[3]); x++) node[x + nx * (z + nz * y)] = k;
  });
  let next = n;
  if (res) {
    const stack: number[] = [];
    for (let s0 = 0; s0 < N; s0++) {
      if (!res[s0] || node[s0] >= n) continue;
      const id = next++;
      node[s0] = id; stack.push(s0);
      while (stack.length) {
        const i = stack.pop()!;
        const x = i % nx, z = Math.floor(i / nx) % nz, y = Math.floor(i / NL);
        for (const j of [x > 0 ? i - 1 : -1, x < nx - 1 ? i + 1 : -1, z > 0 ? i - nx : -1, z < nz - 1 ? i + nx : -1, y > 0 ? i - NL : -1, y < ny - 1 ? i + NL : -1])
          if (j >= 0 && res[j] && node[j] < n) { node[j] = id; stack.push(j); }
      }
    }
  }
  const parent = new Int32Array(next);
  for (let i = 0; i < next; i++) parent[i] = i;
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  for (let i = NL; i < N; i++) {
    const a = node[i], b = node[i - NL];
    if (a < 0 || b < 0 || a === b) continue;
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }
  const size = new Map<number, number>();
  for (let k = 0; k < n; k++) { const r = find(k); size.set(r, (size.get(r) ?? 0) + 1); }
  let best = -1, bn = -1;
  for (const [r, c] of size) if (c > bn) { bn = c; best = r; }
  const out = new Uint8Array(n);
  for (let k = 0; k < n; k++) if (find(k) === best) out[k] = 1;
  return out;
}

function cellsOfBox(c: [number, number, number, number, number, number]): number[][] {
  const out: number[][] = [];
  for (let y = c[1]; y < c[4]; y++) for (let z = c[2]; z < c[5]; z++) for (let x = c[0]; x < c[3]; x++) out.push([x, y, z]);
  return out;
}

/** Grid-frame plain part for a cell box (same convention as bricks.ts toBricks without centring). */
function plain(id: string, x0: number, y0: number, z0: number, sx: number, sz: number, h: number, color: number): Part {
  return { part: id, color, pos: [(x0 + sx / 2) * 20, -(y0 + h) * 8, -(z0 + sz / 2) * 20], rot: sx >= sz ? IDENT : ROTY[1] };
}

/** Greedy re-pack of left-over cells (bricks where 3 stacked cells of a former brick remain, else plates). */
function repack(cells: number[][], color: number, wasBrick: boolean): { part: Part; c: Box6 }[] {
  const out: { part: Part; c: Box6 }[] = [];
  const set = new Set(cells.map((c) => c.join(',')));
  const has = (x: number, y: number, z: number) => set.has(`${x},${y},${z}`);
  const del = (x: number, y: number, z: number) => set.delete(`${x},${y},${z}`);
  if (!cells.length) return out;
  const ys = cells.map((c) => c[1]);
  const yMin = Math.min(...ys), yMax = Math.max(...ys);
  const fill = (y: number, h: number, list: [number, number, string][]) => {
    const cols = cells.filter((c) => c[1] === y).map((c) => [c[0], c[2]]).sort((p, q) => p[1] - q[1] || p[0] - q[0]);
    const ok = (x: number, z: number) => { for (let k = 0; k < h; k++) if (!has(x, y + k, z)) return false; return true; };
    for (const [x, z] of cols) {
      if (!ok(x, z)) continue;
      let done = false;
      for (const [a, b, id] of list) {
        for (const [sx, sz] of a === b ? [[a, b]] : [[b, a], [a, b]]) {
          let fits = true;
          for (let dz = 0; dz < sz && fits; dz++) for (let dx = 0; dx < sx && fits; dx++) if (!ok(x + dx, z + dz)) fits = false;
          if (!fits) continue;
          for (let k = 0; k < h; k++) for (let dz = 0; dz < sz; dz++) for (let dx = 0; dx < sx; dx++) del(x + dx, y + k, z + dz);
          out.push({ part: plain(id, x, y, z, sx, sz, h, color), c: [x, y, z, x + sx, y + h, z + sz] });
          done = true;
          break;
        }
        if (done) break;
      }
    }
  };
  if (wasBrick && yMax - yMin === 2) fill(yMin, 3, BRICKS);
  for (let y = yMin; y <= yMax; y++) fill(y, 1, PLATES);
  return out;
}

function offsetScore(g: VoxelGrid, items: Item[], o: number[]): number {
  const { nx, ny, nz, solid } = g;
  let hit = 0, n = 0;
  for (const it of items) {
    if (!it.std) continue;
    const [x0, y0, z0, x1, y1, z1] = it.c;
    for (let y = y0; y < y1; y++) for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) {
      const X = x + o[0], Y = y + o[1], Z = z + o[2];
      n++;
      if (X >= 0 && Y >= 0 && Z >= 0 && X < nx && Y < ny && Z < nz && solid[X + nx * (Z + nz * Y)]) hit++;
    }
  }
  return hit / Math.max(1, n);
}

/** Integer cell offset mapping the bricks' frame onto the grid (best overlap with the solid voxels). */
function findOffset(g: VoxelGrid, items: Item[]): { offset: [number, number, number]; fit: number } {
  const { nx, ny, nz, solid } = g;
  const stds = items.filter((i) => i.std);
  if (!stds.length) return { offset: [0, 0, 0], fit: 0 };
  const lo = [Infinity, Infinity, Infinity];
  for (const it of stds) for (let k = 0; k < 3; k++) lo[k] = Math.min(lo[k], it.c[k]);
  const glo = [Infinity, Infinity, Infinity];
  for (let y = 0, i = 0; y < ny; y++) for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++, i++)
    if (solid[i]) { glo[0] = Math.min(glo[0], x); glo[1] = Math.min(glo[1], y); glo[2] = Math.min(glo[2], z); }
  // sample cells (cap the work on big models)
  const sample: number[][] = [];
  for (const it of stds) {
    const [x0, y0, z0, x1, y1, z1] = it.c;
    for (let y = y0; y < y1; y++) for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) sample.push([x, y, z]);
  }
  const step = Math.max(1, Math.floor(sample.length / 6000));
  const score = (o: number[]) => {
    let hit = 0, n = 0;
    for (let s = 0; s < sample.length; s += step) {
      const x = sample[s][0] + o[0], y = sample[s][1] + o[1], z = sample[s][2] + o[2];
      n++;
      if (x >= 0 && y >= 0 && z >= 0 && x < nx && y < ny && z < nz && solid[x + nx * (z + nz * y)]) hit++;
    }
    return hit / Math.max(1, n);
  };
  let best: [number, number, number] = [0, 0, 0], bestS = score([0, 0, 0]);
  if (bestS > 0.999) return { offset: best, fit: bestS };
  const base = [glo[0] - lo[0], glo[1] - lo[1], glo[2] - lo[2]];
  for (let dy = -2; dy <= 2; dy++) for (let dz = -3; dz <= 3; dz++) for (let dx = -3; dx <= 3; dx++) {
    const o: [number, number, number] = [base[0] + dx, base[1] + dy, base[2] + dz];
    const s = score(o);
    if (s > bestS) { bestS = s; best = o; }
  }
  return { offset: best, fit: bestS };
}
