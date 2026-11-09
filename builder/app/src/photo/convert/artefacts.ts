// AI-artefact colour cleanup (structure workstream). Image-to-3D meshes invent the sides the photo did not show: a
// foliage texture painted flat onto a wall, a dark "hole" or a brown door painted where the wall is plain, a blob of a
// colour that is nowhere in the photo. A builder would build the wall. After the colour stage, every visible
// same-colour surface region (26-connected) is checked:
//   - painted skin: the region lies flat in a vertical wall (it faces sideways, is at most 2 cells thick and does not
//     stick out of the wall around it) and is foliage-coloured, much darker than that wall, or a colour the vision did
//     not list -> it takes the wall's colour. Real foliage volumes stick out (special parts build them); real window /
//     door recesses are air (voxelize.ts restoreRecesses); door / window features the vision lists are kept.
//   - stray colour: a small region of a colour that is not one of the vision colorRegions -> its surroundings' colour.
//   - misplaced ground: a region of a ground-named region's colour (base plates) that does not reach the bottom band
//     -> its surroundings' colour.
// Pure TS, O(visible voxels).

import type { PhotoAnalysis } from './contracts';
import type { VoxelGrid } from './voxelize';
import type { DelightStats } from './delight';
import { hexToLinear, linearToOklab, type PaletteColor } from './color';

/** A painted skin is at most this share of the visible surface (a whole facade in a second colour is a design). */
const SKIN_MAX_SHARE = 0.04;
/** Stray (non-region) colour regions below this share of the visible surface are merged. */
const STRAY_MAX_SHARE = 0.015;
/** "Much darker" than the wall: OKLab lightness lower by at least this. */
const DARK_DL = 0.18;
/** Ground regions keep their colour only when they reach this bottom share of the model height. */
const GROUND_BAND = 0.15;
const FOLIAGE_NAME = /\b(foliage|leaf|leaves|ivy|vines?|plants?|trees?|bush(es)?|moss|grass|hedge|greenery)\b/i;
const GROUND_NAME = /\b(base|baseplate|ground|floor|plinth|foundation|rocks?|terrain)\b/i;

export interface ArtefactStats { skins: number; strays: number; ground: number; recoloured: number }

const DIRS: [number, number, number][] = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]];

export function cleanArtefacts(g: VoxelGrid, cells: Int16Array, palette: PaletteColor[], analysis: PhotoAnalysis | undefined, colour: DelightStats | undefined): ArtefactStats {
  const st: ArtefactStats = { skins: 0, strays: 0, ground: 0, recoloured: 0 };
  const { nx, ny, nz, solid, visible, rgb } = g;
  const NL = nx * nz, N = cells.length;
  const lab = palette.map((p) => linearToOklab(...hexToLinear(p.hex)));
  const lin = palette.map((p) => hexToLinear(p.hex));
  const codeIdx = new Map(palette.map((p, i) => [p.code, i]));
  // palette indices of the vision regions (by name), of the foliage / ground regions
  const regionIdx = new Set<number>(), foliageIdx = new Set<number>(), groundIdx = new Set<number>();
  const hasRegions = colour?.mode === 'regions';
  for (const gr of colour?.groups ?? []) {
    if (gr.name.startsWith('extra')) continue;
    const i = codeIdx.get(gr.code);
    if (i === undefined) continue;
    regionIdx.add(i);
    if (FOLIAGE_NAME.test(gr.name)) foliageIdx.add(i);
    if (GROUND_NAME.test(gr.name)) groundIdx.add(i);
  }
  // green hue also counts as foliage (no region name needed)
  const greenish = (i: number) => { const [L, a, b] = lab[i]; const h = Math.atan2(b, a); return Math.hypot(a, b) > 0.05 && L > 0.2 && h > 1.9 && h < 2.9; };
  // solid bbox (feature boxes are fractions of it) and visible count
  let x0 = nx, x1 = -1, y0 = ny, y1 = -1, z0 = nz, z1 = -1, nVis = 0;
  for (let i = 0; i < N; i++) if (solid[i]) {
    const x = i % nx, z = Math.floor(i / nx) % nz, y = Math.floor(i / NL);
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z;
    if (visible[i] && cells[i] >= 0) nVis++;
  }
  if (!nVis) return st;
  const H = y1 - y0 + 1;
  const air = (x: number, y: number, z: number) => x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz || !solid[x + nx * (z + nz * y)];
  // door / window features: [face (+1 front = +z, -1 back), fx0, fx1, fy0, fy1] as fractions of the solid bbox
  const keep: [number, number, number, number, number][] = [];
  if (analysis?.subjectBox && analysis.features) {
    const [sx0, sy0, sx1, sy1] = analysis.subjectBox;
    for (const f of analysis.features) {
      if (f.kind !== 'door' && f.kind !== 'window') continue;
      let fx0 = (f.box[0] - sx0) / Math.max(1e-6, sx1 - sx0), fx1 = (f.box[2] - sx0) / Math.max(1e-6, sx1 - sx0);
      if (f.view === 'back') [fx0, fx1] = [1 - fx1, 1 - fx0];
      const fy0 = (f.box[1] - sy0) / Math.max(1e-6, sy1 - sy0), fy1 = (f.box[3] - sy0) / Math.max(1e-6, sy1 - sy0);
      keep.push([f.view === 'back' ? -1 : 1, fx0 - 0.04, fx1 + 0.04, fy0 - 0.04, fy1 + 0.04]);
    }
  }

  const label = new Int32Array(N).fill(-1);
  const stamp = new Int32Array(N).fill(-1);
  const members: number[] = [];
  const border = new Map<number, number>();
  const borderDir: number[] = [];
  const faces = new Int32Array(6);
  for (let s = 0; s < N; s++) {
    if (!visible[s] || cells[s] < 0 || label[s] >= 0) continue;
    const c = cells[s];
    members.length = 0; members.push(s); label[s] = s;
    border.clear(); borderDir.length = 0;
    for (let h = 0; h < members.length; h++) {
      const i = members[h], x = i % nx, z = Math.floor(i / nx) % nz, y = Math.floor(i / NL);
      for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy && !dz) continue;
        const X = x + dx, Y = y + dy, Z = z + dz;
        if (X < 0 || Y < 0 || Z < 0 || X >= nx || Y >= ny || Z >= nz) continue;
        const j = X + nx * (Z + nz * Y);
        if (!visible[j] || cells[j] < 0) continue;
        if (cells[j] === c) { if (label[j] < 0) { label[j] = s; members.push(j); } }
        else if (stamp[j] !== s) { stamp[j] = s; border.set(cells[j], (border.get(cells[j]) ?? 0) + 1); borderDir.push(j); }
      }
    }
    const share = members.length / nVis;
    if (!border.size || share > SKIN_MAX_SHARE) continue;
    let target = -1, tn = 0;
    for (const [k, n] of border) if (n > tn) { tn = n; target = k; }
    let why: 'skins' | 'strays' | 'ground' | null = null;
    // misplaced ground colour
    if (groundIdx.has(c) && !groundIdx.has(target)) {
      let low = false;
      for (const i of members) if (Math.floor(i / NL) - y0 < GROUND_BAND * H) { low = true; break; }
      if (!low) why = 'ground';
    }
    // stray colour
    if (!why && hasRegions && !regionIdx.has(c) && share < STRAY_MAX_SHARE) why = 'strays';
    // painted skin
    if (!why && !groundIdx.has(c) && (foliageIdx.has(c) || greenish(c) || lab[c][0] < lab[target][0] - DARK_DL || (hasRegions && !regionIdx.has(c)))) {
      faces.fill(0);
      for (const i of members) {
        const x = i % nx, z = Math.floor(i / nx) % nz, y = Math.floor(i / NL);
        for (let d = 0; d < 6; d++) if (air(x + DIRS[d][0], y + DIRS[d][1], z + DIRS[d][2])) faces[d]++;
      }
      let d = 0;
      for (let k = 1; k < 4; k++) if (faces[k] > faces[d]) d = k;
      const tot = faces[0] + faces[1] + faces[2] + faces[3] + faces[4] + faces[5];
      if (tot && faces[0] + faces[1] + faces[2] + faces[3] >= 0.7 * tot) {
        const ax = d < 2 ? 0 : 2, sg = d % 2 === 0 ? 1 : -1;
        const pOf = (i: number) => sg * (ax === 0 ? i % nx : Math.floor(i / nx) % nz);
        const faceD = (i: number) => { const x = i % nx, z = Math.floor(i / nx) % nz, y = Math.floor(i / NL); return air(x + DIRS[d][0], y, z + DIRS[d][2]); };
        let pMin = Infinity, pMax = -Infinity;
        for (const i of members) if (faceD(i)) { const p = pOf(i); if (p < pMin) pMin = p; if (p > pMax) pMax = p; }
        const bp: number[] = [];
        for (const j of borderDir) if (faceD(j)) bp.push(pOf(j));
        bp.sort((a, b) => a - b);
        const flat = bp.length >= 3 && pMax - pMin <= 1 && pMax <= bp[bp.length >> 1];
        let kept = false;
        if (flat && ax === 2 && keep.length) {
          let mx = 0, my = 0;
          for (const i of members) { mx += i % nx; my += Math.floor(i / NL); }
          const fx = (mx / members.length + 0.5 - x0) / (x1 - x0 + 1), fy = (y1 + 1 - (my / members.length + 0.5)) / H;
          kept = keep.some(([face, a0, a1, b0, b1]) => face === sg && fx >= a0 && fx <= a1 && fy >= b0 && fy <= b1);
        }
        if (flat && !kept) why = 'skins';
      }
    }
    if (!why) continue;
    st[why]++;
    for (const i of members) {
      cells[i] = target;
      rgb[i * 3] = lin[target][0]; rgb[i * 3 + 1] = lin[target][1]; rgb[i * 3 + 2] = lin[target][2];
    }
    st.recoloured += members.length;
  }
  return st;
}
