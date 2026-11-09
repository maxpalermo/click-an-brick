// Builder-style approximation (research: research/photo2brick/approx/report.md).
// The raw conversion copies every voxel of the AI mesh: noisy colours, 1-stud spikes, plate stair-steps and loose
// bits, which a LEGO builder would never build. These passes simplify the voxel grid BEFORE the bricks are chosen
// (shape, vertical quantisation, colours) and the placements AFTER (coalescing, loose bits), driven by a detail
// level ('simple' | 'balanced' | 'detailed') and the model size. Pure TS, allocation-light, O(voxels) per pass.

import type { DetailLevel, PhotoMode } from '../types';
import { type VoxelGrid, floodOutside, vidx } from './voxelize';
import { ColorMatcher, ciede2000, hexToLinear, linearToCielab, linearToSrgb, srgbToLinear, type PaletteColor } from './color';
import { BRICKS, PLATES, ANY, EMPTY, type PackWeights, type Placement } from './bricks';
import { ComponentFinder } from './repair';

export interface ApproxSettings {
  // ---- shape (voxel grid) ----
  /** Per-layer smoothing passes (0 = off): bumps removed, pits / grooves filled (never a real recess, VoxelGrid.recess). Thin walls are never removed. */
  smoothPasses: number;
  /**
   * Bump size: a solid voxel with at most this many solid layer neighbours (of 8) is removed when all of those
   * neighbours belong to a thick body (>= 5 neighbours each). A 1-stud wall or pillar is kept.
   */
  smoothLo: number;
  /** An empty voxel with at least this many solid layer neighbours (of 8) is filled: pit 8, 1-stud groove 6. */
  smoothHi: number;
  /** Drop 6-connected solid islands smaller than this share of the solid voxels (the largest island always stays). */
  minIslandShare: number;
  /** Vertical quantisation: 'none' | 'slope' (snap steep column tops / overhangs to brick height, plates on gentle slopes) | 'all'. */
  layerSnap: 'none' | 'slope' | 'all';
  /**
   * LEGO-build mode keeps plate precision (layerSnap 'none': real models use plates, the ground-truth IoU drops with
   * snapping), except for tall models: from this many plates high (18 bricks) one plate is under 2 % of the height,
   * so plate steps are reconstruction noise and the shape is snapped to whole bricks ('all'). 0 = never.
   */
  legoSnapPlates: number;
  /** Mirror symmetry snap (X or Z) when the shape is already this symmetric (IoU with its mirror); 0 = off. */
  symmetry: number;
  // ---- colour (visible voxels) ----
  /** Max colours in the model, chosen greedily to minimise the colour error of the visible surface. */
  colourCap: number;
  /** A colour must be the best match for at least this share of the visible surface to be used. */
  minColourShare: number;
  /** Stop adding colours when one more lowers the mean squared colour error (CIEDE2000²) by less than this. */
  minColourGain: number;
  /** Mode-filter passes: a visible voxel takes the dominant colour of its visible 26-neighbours. */
  modePasses: number;
  /** Mode filter margin: switch when the dominant neighbour colour beats the own colour by at least this many voxels. */
  modeMargin: number;
  /** Same-colour surface regions (26-connected) smaller than this many voxels take their surroundings' colour. */
  minRegion: number;
  /**
   * Brick-band vote: within each 3-plate band (brick height, from the ground layer) of a column, visible voxels take
   * the band's majority colour, so colour stripes one plate high do not force plates where a brick would do.
   */
  bandVote: boolean;
  /**
   * Brick-first colour (structure packer): just before packing, every column whose 3-plate band (from the ground
   * layer) is solid in all 3 layers takes ONE colour, the vote of its coloured cells, so colour noise between layers
   * never splits a brick into plates (unifyBands).
   */
  bandUnify: boolean;
  /**
   * Plate layers at the ground before the first brick band (0 or 1). One base plate layer bridges everything that
   * stands on the ground (a builder's base plate): loose ground bricks get stud-connected without the connectivity
   * repair turning walls into plate stacks. Brick bands (shape snap, interior, colour bands, packer) count from it.
   */
  basePlates: number;
  /**
   * Floors / slabs one brick band thick over air: 'thicken' (fill the air band under them, hidden, so two brick bands
   * interlock; thickenSlabs), 'plates' (pack them and their wall anchor zone as plate layers; packStructure) or 'none'.
   */
  slabs: 'thicken' | 'plates' | 'none';
  /** Brick-first part choice: wide plates (4x4 ... 8x16) in the packer, brick re-tiling first in the connectivity repair. */
  bigParts: boolean;
  // ---- parts ----
  /** Merge adjacent compatible parts into bigger standard parts (and 3 stacked plates into a brick). */
  coalesce: boolean;
  /** Part packing per layer: 'scan' (original row-order greedy), 'largest' (best candidates first) or 'constrained' (most constrained cell first, see bricks.ts). */
  packing: 'scan' | 'largest' | 'constrained';
  /** After the connectivity repair, delete loose groups of at most this many parts (0 = keep everything). */
  dropLoose: number;
  // ---- structure (symmetry.ts, interior.ts, bricks.ts packStructure) ----
  /** Builder structure: mirror symmetry + hollow interior + interlocking packer. false = the 2026-10-26 packers. */
  structure: boolean;
  /** Symmetrize the shape by 'union' (fill both sides) or 'majority' (neighbourhood vote). */
  symmetryShape: 'union' | 'majority';
  /** Mirror plane score needed without a vision prior (0-1; see symmetry.ts). */
  symmetryThreshold: number;
  /** Mirror the brick layout too (pack one half, centred parts on the plane), not only shape and colours. */
  mirrorLayout: boolean;
  /** Hollow interior wall thickness in studs (0 = solid). The ConvertOptions.hollow toggle forces 1. */
  hollowWall: number;
  /** Support pillar pitch in studs inside a hollow interior (0 = none). */
  pillarPitch: number;
  /** Packer local-search moves per layer cell, and the packer's time cap (ms). */
  packEffort: number;
  packBudgetMs: number;
  /** Research override of the packer's score weights (bricks.ts PACK_WEIGHTS). */
  packWeights?: Partial<PackWeights>;
}

/** The converter before the approximation work (2026-10-26): every pass off. */
export const RAW_SETTINGS: ApproxSettings = {
  smoothPasses: 0, smoothLo: 0, smoothHi: 10, minIslandShare: 0, layerSnap: 'none', legoSnapPlates: 0, symmetry: 0,
  colourCap: 99, minColourShare: 0, minColourGain: 0, modePasses: 0, modeMargin: 99, minRegion: 0, bandVote: false, bandUnify: false, basePlates: 0, slabs: 'none', bigParts: false, coalesce: false, packing: 'scan', dropLoose: 0,
  structure: false, symmetryShape: 'union', symmetryThreshold: 1, mirrorLayout: false, hollowWall: 0, pillarPitch: 0, packEffort: 0, packBudgetMs: 0,
};

/** Structure settings per level (owner priority: buildable and symmetric beats faithful to the photo). */
export const STRUCTURE_SETTINGS: Record<DetailLevel, Pick<ApproxSettings, 'structure' | 'symmetryShape' | 'symmetryThreshold' | 'mirrorLayout' | 'hollowWall' | 'pillarPitch' | 'packEffort' | 'packBudgetMs'>> = {
  simple: { structure: true, symmetryShape: 'union', symmetryThreshold: 0.7, mirrorLayout: true, hollowWall: 2, pillarPitch: 6, packEffort: 3, packBudgetMs: 150 },
  balanced: { structure: true, symmetryShape: 'union', symmetryThreshold: 0.76, mirrorLayout: true, hollowWall: 2, pillarPitch: 6, packEffort: 3, packBudgetMs: 200 },
  detailed: { structure: true, symmetryShape: 'majority', symmetryThreshold: 0.84, mirrorLayout: true, hollowWall: 1, pillarPitch: 5, packEffort: 3, packBudgetMs: 300 },
};

/**
 * Default longest side (studs) per detail level, when neither sizeStuds nor lduPerUnit is given. Elongated objects
 * (longest / middle dimension > 1.3, e.g. cars, shoes: up to 1.5x at aspect 2.3) get more studs so their thin dimension keeps enough
 * resolution. Validated in research/photo2brick/approx/report.md.
 */
export const DETAIL_STUDS: Record<DetailLevel, number> = { simple: 16, balanced: 20, detailed: 28 };

/** Size relative to 'balanced' per level (the Result screen scales a measured object size by this). */
export const DETAIL_SCALE: Record<DetailLevel, number> = {
  simple: DETAIL_STUDS.simple / DETAIL_STUDS.balanced,
  balanced: 1,
  detailed: DETAIL_STUDS.detailed / DETAIL_STUDS.balanced,
};

export function defaultStuds(detail: DetailLevel, ext: [number, number, number]): number {
  const base = DETAIL_STUDS[detail];
  const s = [ext[0], ext[1], ext[2]].sort((a, b) => a - b);
  const aspect = s[1] > 0 ? s[2] / s[1] : 1;
  const k = Math.min(1.5, Math.max(1, 1 + (aspect - 1.3) * 0.5));
  return Math.round((base * k) / 2) * 2;
}

/**
 * Settings for a detail level at a given model size (longest side in studs). Thresholds that count voxels scale
 * with the model's surface (studs²) so a "small region" means the same visual size at every scale.
 * LEGO-build mode keeps the exact lattice (no shape changes: the ground-truth IoU depends on it), keeps more
 * colours (a real model's colours are part of the build) and only cleans colour noise and parts.
 */
export function approxSettings(detail: DetailLevel, mode: PhotoMode, studs: number): ApproxSettings {
  const st = STRUCTURE_SETTINGS[detail];
  // LEGO-build mode: the real model is the ground truth, so symmetry may not add volume (majority, not union)
  return { ...levelSettings(detail, mode, studs), ...st, ...(mode === 'lego' ? { symmetryShape: 'majority' as const } : {}) };
}

function levelSettings(detail: DetailLevel, mode: PhotoMode, studs: number): Omit<ApproxSettings, keyof (typeof STRUCTURE_SETTINGS)['simple']> {
  const area = Math.max(0.25, (studs / 24) ** 2);
  const lego = mode === 'lego';
  switch (detail) {
    case 'simple':
      return {
        smoothPasses: lego ? 0 : 2, smoothLo: 2, smoothHi: 6, minIslandShare: lego ? 0 : 0.02,
        layerSnap: lego ? 'none' : 'all', legoSnapPlates: 54, symmetry: 0,
        colourCap: lego ? 6 : studs <= 20 ? 4 : 6, minColourShare: lego ? 0.004 : 0.005, minColourGain: lego ? 3 : 6, modePasses: 2, modeMargin: 1,
        minRegion: Math.max(4, Math.round(12 * area)), bandVote: true, bandUnify: true, basePlates: 1, slabs: 'thicken', bigParts: true, coalesce: true, packing: 'constrained', dropLoose: lego ? 2 : 6,
      };
    case 'detailed':
      return {
        smoothPasses: lego ? 0 : 1, smoothLo: 1, smoothHi: 8, minIslandShare: lego ? 0 : 0.002,
        layerSnap: 'none', legoSnapPlates: 0, symmetry: 0,
        colourCap: 12, minColourShare: 0.002, minColourGain: 1, modePasses: 1, modeMargin: 3,
        minRegion: Math.max(2, Math.round(3 * area)), bandVote: false, bandUnify: true, basePlates: 0, slabs: 'none', bigParts: true, coalesce: true, packing: 'constrained', dropLoose: lego ? 0 : 1,
      };
    default:
      return {
        smoothPasses: lego ? 0 : 1, smoothLo: 2, smoothHi: 7, minIslandShare: lego ? 0 : 0.01,
        layerSnap: lego ? 'none' : 'all', legoSnapPlates: 54, symmetry: 0,
        colourCap: lego ? 10 : studs <= 20 ? 6 : 8, minColourShare: lego ? 0.002 : 0.004, minColourGain: lego ? 1 : 3, modePasses: 2, modeMargin: 2,
        minRegion: Math.max(3, Math.round(6 * area)), bandVote: true, bandUnify: true, basePlates: 1, slabs: 'thicken', bigParts: true, coalesce: true, packing: 'constrained', dropLoose: lego ? 2 : 3,
      };
  }
}

// =====================================================================================================  shape

/** Simplify the solid occupancy in place, then recompute `visible` and fill colours of new voxels. */
export function simplifyShape(g: VoxelGrid, s: ApproxSettings): void {
  const { nx, ny, nz, solid } = g;
  const before = solid.slice();
  let changed = false;
  for (let p = 0; p < s.smoothPasses; p++) changed = smoothLayers(g, s.smoothLo, s.smoothHi) || changed;
  if (s.smoothPasses > 0) changed = columnCleanup(g) || changed;
  if (s.symmetry > 0) changed = symmetrize(g, s.symmetry) || changed;
  if (s.layerSnap !== 'none') changed = snapLayers(g, s.layerSnap, s.basePlates) || changed;
  if (s.minIslandShare > 0) changed = dropIslands(g, s.minIslandShare) || changed;
  if (!changed) return;
  // inside / outside and visibility over the new solid
  const outside = floodOutside(solid, nx, ny, nz);
  const NL = nx * nz;
  const vis = g.visible;
  vis.fill(0);
  for (let y = 0, i = 0; y < ny; y++)
    for (let z = 0; z < nz; z++)
      for (let x = 0; x < nx; x++, i++) {
        if (!solid[i]) continue;
        if (x === 0 || y === 0 || z === 0 || x === nx - 1 || y === ny - 1 || z === nz - 1 ||
          outside[i - 1] || outside[i + 1] || outside[i - nx] || outside[i + nx] || outside[i - NL] || outside[i + NL]) vis[i] = 1;
      }
  // colours for voxels that were not solid before: nearest previously solid colour (BFS)
  const rgb = g.rgb;
  const done = new Uint8Array(solid.length);
  let queue: number[] = [];
  for (let i = 0; i < solid.length; i++) if (solid[i] && before[i]) { done[i] = 1; queue.push(i); }
  while (queue.length) {
    const next: number[] = [];
    for (const i of queue) {
      const x = i % nx, z = Math.floor(i / nx) % nz, y = Math.floor(i / NL);
      const nb = [x > 0 ? i - 1 : -1, x < nx - 1 ? i + 1 : -1, z > 0 ? i - nx : -1, z < nz - 1 ? i + nx : -1, y > 0 ? i - NL : -1, y < ny - 1 ? i + NL : -1];
      for (const j of nb) {
        if (j < 0 || !solid[j] || done[j]) continue;
        rgb[j * 3] = rgb[i * 3]; rgb[j * 3 + 1] = rgb[i * 3 + 1]; rgb[j * 3 + 2] = rgb[i * 3 + 2];
        done[j] = 1; next.push(j);
      }
    }
    queue = next;
  }
}

/**
 * One pass of per-layer smoothing (horizontal only: one plate is already thin, a 3D kernel would delete every
 * plate-thick roof; vertical noise is handled by columnCleanup and snapLayers). Counts are solid layer neighbours
 * of 8: isolated 0, line end 1, 1-stud wall 2, convex corner 3, straight edge 5, interior 8.
 */
function smoothLayers(g: VoxelGrid, bump: number, fill: number): boolean {
  const { nx, ny, nz, solid } = g;
  const keep = g.recess; // real recesses (voxelize.ts restoreRecesses) are never filled
  const NL = nx * nz;
  const n8 = new Uint8Array(NL);
  const out = solid.slice();
  let changed = false;
  for (let y = 0; y < ny; y++) {
    const o = y * NL;
    for (let z = 0; z < nz; z++)
      for (let x = 0; x < nx; x++) {
        let c = 0;
        for (let dz = -1; dz <= 1; dz++) {
          const Z = z + dz;
          if (Z < 0 || Z >= nz) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const X = x + dx;
            if ((dx || dz) && X >= 0 && X < nx) c += solid[o + X + nx * Z];
          }
        }
        n8[x + nx * z] = c;
      }
    for (let z = 0; z < nz; z++)
      for (let x = 0; x < nx; x++) {
        const c = x + nx * z, i = o + c, n = n8[c];
        if (!solid[i]) {
          if (n >= fill && !(keep && keep[i])) { out[i] = 1; changed = true; }
          continue;
        }
        if (n > bump) continue;
        // a bump: every solid neighbour is part of a thick body; dust: no neighbour at all and nothing above / below
        let thick = n > 0;
        for (let dz = -1; dz <= 1 && thick; dz++)
          for (let dx = -1; dx <= 1; dx++) {
            const X = x + dx, Z = z + dz;
            if ((!dx && !dz) || X < 0 || Z < 0 || X >= nx || Z >= nz) continue;
            if (solid[o + X + nx * Z] && n8[X + nx * Z] < 5) { thick = false; break; }
          }
        const dust = n === 0 && !(y > 0 && solid[i - NL]) && !(y < ny - 1 && solid[i + NL]);
        if (thick || dust) { out[i] = 0; changed = true; }
      }
  }
  solid.set(out);
  return changed;
}

/** Vertical noise: fill 1-plate gaps inside a column; remove 1-plate slivers that stick out sideways alone. */
function columnCleanup(g: VoxelGrid): boolean {
  const { nx, ny, nz, solid } = g;
  const keep = g.recess;
  const NL = nx * nz;
  let changed = false;
  for (let y = 1; y < ny - 1; y++)
    for (let z = 0; z < nz; z++)
      for (let x = 0; x < nx; x++) {
        const i = y * NL + x + nx * z;
        const up = solid[i + NL], dn = solid[i - NL];
        if (!solid[i] && up && dn) { if (!(keep && keep[i])) { solid[i] = 1; changed = true; } continue; }
        if (solid[i] && !up && !dn) {
          // a lone plate: keep it if it is part of a plate-thick slab or a thin wall (>= 2 of its 8 layer neighbours)
          let n = 0;
          for (let dz = -1; dz <= 1; dz++)
            for (let dx = -1; dx <= 1; dx++) {
              if (!dx && !dz) continue;
              const X = x + dx, Z = z + dz;
              if (X >= 0 && Z >= 0 && X < nx && Z < nz) n += solid[y * NL + X + nx * Z];
            }
          if (n < 2) { solid[i] = 0; changed = true; }
        }
      }
  return changed;
}

/** Snap solid runs in each column to brick height (3 plates) from the model's ground layer. */
function snapLayers(g: VoxelGrid, mode: 'slope' | 'all', base = 0): boolean {
  const { nx, ny, nz, solid } = g;
  const NL = nx * nz;
  let y0 = 0;
  outer: for (; y0 < ny; y0++) for (let i = 0; i < NL; i++) if (solid[y0 * NL + i]) break outer;
  if (y0 >= ny) return false;
  // bands start above the base plate layers; a run starting on the ground keeps its base
  const o = y0 + base;
  // (a run that would start just above the base is grounded: nothing floats one plate over the ground)
  const snap = (v: number) => { if (v <= y0) return y0; const r = o + Math.round((v - o) / 3) * 3; return r; };
  // top height per column (exclusive), for the slope test
  const top = new Int32Array(NL).fill(-1);
  for (let c = 0; c < NL; c++) for (let y = ny - 1; y >= 0; y--) if (solid[y * NL + c]) { top[c] = y + 1; break; }
  const out = solid.slice();
  let changed = false;
  for (let z = 0; z < nz; z++)
    for (let x = 0; x < nx; x++) {
      const c = x + nx * z;
      if (top[c] < 0) continue;
      let steep = mode === 'all';
      if (!steep) {
        // gentle = every solid 4-neighbour column top is within 2 plates; the column then keeps plate precision
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const X = x + dx, Z = z + dz;
          const t = X >= 0 && Z >= 0 && X < nx && Z < nz ? top[X + nx * Z] : -1;
          if (t < 0 || Math.abs(t - top[c]) >= 3) { steep = true; break; }
        }
      }
      for (let y = 0; y < ny; ) {
        if (!solid[y * NL + c]) { y++; continue; }
        let b = y;
        while (b < ny && solid[b * NL + c]) b++;
        const isTop = b === top[c];
        const a2 = snap(y);
        const b2 = isTop && !steep ? b : snap(b);
        if (b2 > a2 && (a2 !== y || b2 !== b)) {
          for (let k = Math.min(y, a2); k < Math.max(b, b2); k++) {
            if (k < 0 || k >= ny) continue;
            const v = k >= a2 && k < b2 ? 1 : 0;
            if (out[k * NL + c] !== v) { out[k * NL + c] = v; changed = true; }
          }
        }
        y = b;
      }
    }
  solid.set(out);
  return changed;
}

/** Mirror symmetry about the X or Z mid-plane of the solid bbox, when the shape is already nearly symmetric. */
function symmetrize(g: VoxelGrid, minIou: number): boolean {
  const { nx, ny, nz, solid } = g;
  let x0 = nx, x1 = -1, z0 = nz, z1 = -1;
  for (let y = 0, i = 0; y < ny; y++) for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++, i++)
    if (solid[i]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z; }
  if (x1 < 0) return false;
  const mirror = (axis: 0 | 2) => (x: number, z: number): [number, number] => (axis === 0 ? [x0 + x1 - x, z] : [x, z0 + z1 - z]);
  let best: { axis: 0 | 2; iou: number } | null = null;
  for (const axis of [0, 2] as const) {
    const m = mirror(axis);
    let inter = 0, uni = 0;
    for (let y = 0; y < ny; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
      const [X, Z] = m(x, z);
      const a = solid[vidx(g, x, y, z)], b = solid[vidx(g, X, y, Z)];
      inter += a & b; uni += a | b;
    }
    const iou = uni ? inter / uni : 0;
    if (!best || iou > best.iou) best = { axis, iou };
  }
  if (!best || best.iou < minIou || best.iou === 1) return false;
  const m = mirror(best.axis);
  const out = solid.slice();
  for (let y = 0; y < ny; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
    const [X, Z] = m(x, z);
    out[vidx(g, x, y, z)] = solid[vidx(g, x, y, z)] | solid[vidx(g, X, y, Z)];
  }
  solid.set(out);
  return true;
}

/** Remove 6-connected solid islands below `share` of all solid voxels (never the largest one). */
function dropIslands(g: VoxelGrid, share: number): boolean {
  const { nx, ny, nz, solid } = g;
  const N = solid.length, NL = nx * nz;
  const label = new Int32Array(N).fill(-1);
  const sizes: number[] = [];
  let stack = new Int32Array(4096);
  let total = 0;
  for (let s = 0; s < N; s++) {
    if (!solid[s] || label[s] >= 0) continue;
    const id = sizes.length;
    let n = 0, sp = 0;
    label[s] = id; stack[sp++] = s;
    while (sp) {
      const i = stack[--sp];
      n++;
      const x = i % nx, z = Math.floor(i / nx) % nz, y = Math.floor(i / NL);
      const nb = [x > 0 ? i - 1 : -1, x < nx - 1 ? i + 1 : -1, z > 0 ? i - nx : -1, z < nz - 1 ? i + nx : -1, y > 0 ? i - NL : -1, y < ny - 1 ? i + NL : -1];
      for (const j of nb) {
        if (j < 0 || !solid[j] || label[j] >= 0) continue;
        label[j] = id;
        if (sp === stack.length) { const s2 = new Int32Array(stack.length * 2); s2.set(stack); stack = s2; }
        stack[sp++] = j;
      }
    }
    sizes.push(n);
    total += n;
  }
  if (sizes.length < 2) return false;
  let largest = 0;
  for (let k = 1; k < sizes.length; k++) if (sizes[k] > sizes[largest]) largest = k;
  const min = share * total;
  let changed = false;
  for (let i = 0; i < N; i++) {
    const l = label[i];
    if (l >= 0 && l !== largest && sizes[l] < min) { solid[i] = 0; changed = true; }
  }
  return changed;
}

// =====================================================================================================  colour

/** Simplify the palette indices of visible voxels in place (hidden voxels are ANY and stay so). */
export function simplifyColours(g: VoxelGrid, cells: Int16Array, palette: PaletteColor[], s: ApproxSettings): void {
  capColours(g, cells, palette, s.colourCap, s.minColourShare, s.minColourGain);
  for (let p = 0; p < s.modePasses; p++) if (!modeFilter(g, cells, s.modeMargin)) break;
  if (s.bandVote) bandVote(g, cells, s.basePlates);
  if (s.minRegion > 1) for (let p = 0; p < 3; p++) if (!mergeRegions(g, cells, s.minRegion)) break;
}

/**
 * Choose up to `cap` palette colours greedily so that the mean squared CIEDE2000 error of the visible surface is smallest
 * (first the best single colour, then the colour that lowers the error most, ...); stop when the gain drops below
 * `minGain` or the new colour would be the best match for less than `minShare` of the surface. Visible voxels are
 * then re-matched among the chosen colours. Works on a 6-bit-per-channel histogram, so it is cheap.
 */
function capColours(g: VoxelGrid, cells: Int16Array, palette: PaletteColor[], cap: number, minShare: number, minGain: number) {
  if (cap >= palette.length && minShare <= 0 && minGain <= 0) return;
  const { rgb, visible } = g;
  const q = (v: number) => Math.min(63, Math.max(0, Math.round(linearToSrgb(v) * 63)));
  const hist = new Map<number, number>();
  let total = 0;
  for (let i = 0; i < cells.length; i++) {
    if (!visible[i] || cells[i] < 0) continue;
    const key = (q(rgb[i * 3]) << 12) | (q(rgb[i * 3 + 1]) << 6) | q(rgb[i * 3 + 2]);
    hist.set(key, (hist.get(key) ?? 0) + 1);
    total++;
  }
  if (!total) return;
  const keys = [...hist.keys()], weight = keys.map((k) => hist.get(k)!);
  const P = palette.length, K = keys.length;
  const pal = palette.map((p) => linearToCielab(...hexToLinear(p.hex)));
  const dist = new Float32Array(K * P);
  for (let k = 0; k < K; k++) {
    const key = keys[k];
    const lab = linearToCielab(srgbToLinear((key >> 12) / 63), srgbToLinear(((key >> 6) & 63) / 63), srgbToLinear((key & 63) / 63));
    for (let p = 0; p < P; p++) dist[k * P + p] = ciede2000(lab, pal[p]) ** 2;
  }
  const chosen: number[] = [];
  const best = new Float32Array(K).fill(Infinity);
  let err = Infinity;
  while (chosen.length < Math.min(cap, P)) {
    let pick = -1, pickErr = err;
    for (let p = 0; p < P; p++) {
      if (chosen.includes(p)) continue;
      let e = 0, won = 0;
      for (let k = 0; k < K; k++) {
        const d = dist[k * P + p];
        if (d < best[k]) { e += d * weight[k]; won += weight[k]; } else e += best[k] * weight[k];
        // (dist holds squared CIEDE2000: a small but very different area, like a beak, outweighs shading noise)
      }
      e /= total;
      if (chosen.length && won / total < minShare) continue;
      if (e < pickErr) { pickErr = e; pick = p; }
    }
    if (pick < 0 || (chosen.length && err - pickErr < minGain)) break;
    chosen.push(pick);
    for (let k = 0; k < K; k++) best[k] = Math.min(best[k], dist[k * P + pick]);
    err = pickErr;
  }
  const sub = new ColorMatcher(chosen.map((c) => palette[c]));
  for (let i = 0; i < cells.length; i++) {
    if (!visible[i] || cells[i] < 0) continue;
    cells[i] = chosen[sub.match(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2])];
  }
}

function bandVote(g: VoxelGrid, cells: Int16Array, base = 0) {
  const { nx, ny, nz, solid, visible } = g;
  const NL = nx * nz;
  let y0 = 0;
  outer: for (; y0 < ny; y0++) for (let i = 0; i < NL; i++) if (solid[y0 * NL + i]) break outer;
  for (let y = y0 + base; y + 2 < ny; y += 3)
    for (let c = 0; c < NL; c++) {
      const i0 = y * NL + c, i1 = i0 + NL, i2 = i1 + NL;
      const a = visible[i0] ? cells[i0] : -1, b = visible[i1] ? cells[i1] : -1, d = visible[i2] ? cells[i2] : -1;
      // majority of the three when two agree (the third, if visible, follows)
      const m = a >= 0 && (a === b || a === d) ? a : b >= 0 && b === d ? b : -1;
      if (m < 0) continue;
      if (a >= 0) cells[i0] = m;
      if (b >= 0) cells[i1] = m;
      if (d >= 0) cells[i2] = m;
    }
}

/**
 * One colour per brick band of a column (see ApproxSettings.bandUnify): where the 3 layers of a band (counted from
 * `y0`) are all solid (not EMPTY), the coloured cells take the band's majority colour; ties go to the colour that is
 * more common in the whole model (the material, not the shading accent). Hidden cells (ANY) stay ANY. Deterministic per
 * column, so a mirror-symmetric input stays symmetric.
 */
export function unifyBands(g: { nx: number; ny: number; nz: number }, cells: Int16Array, y0: number): number {
  const { nx, ny, nz } = g;
  const NL = nx * nz;
  const freq = new Map<number, number>();
  for (let i = 0; i < cells.length; i++) if (cells[i] >= 0) freq.set(cells[i], (freq.get(cells[i]) ?? 0) + 1);
  let changed = 0;
  for (let y = y0; y + 2 < ny; y += 3)
    for (let c = 0; c < NL; c++) {
      const i0 = y * NL + c, i1 = i0 + NL, i2 = i1 + NL;
      const a = cells[i0], b = cells[i1], d = cells[i2];
      if (a === EMPTY || b === EMPTY || d === EMPTY) continue;
      const cs = [a, b, d].filter((v) => v >= 0);
      if (cs.length < 2 || (cs[0] === cs[1] && (cs.length === 2 || cs[1] === cs[2]))) continue;
      let best = -1, bn = 0, bf = 0;
      for (const v of cs) {
        let n = 0;
        for (const w of cs) if (w === v) n++;
        const f = freq.get(v) ?? 0;
        if (n > bn || (n === bn && f > bf)) { best = v; bn = n; bf = f; }
      }
      for (const i of [i0, i1, i2]) if (cells[i] >= 0 && cells[i] !== best) { cells[i] = best; changed++; }
    }
  return changed;
}

/**
 * Floors one brick band thick over air (a reconstructed shell's floor or terrace): bricks there would only touch each
 * other sideways. Where such a band column is more than one stud from any supported cell of its band, the band below
 * it (all air in that column) is filled as hidden cells (ANY), so the floor becomes two bands whose bricks interlock in
 * running bond and anchor on the walls. Returns the number of cells filled.
 */
export function thickenSlabs(g: { nx: number; ny: number; nz: number; solid: Uint8Array; recess?: Uint8Array }, cells: Int16Array, yb: number): number {
  const { nx, ny, nz, solid } = g;
  const keep = g.recess;
  const NL = nx * nz;
  let filled = 0;
  const full = new Uint8Array(NL), dist = new Int16Array(NL);
  const fill: number[] = [];
  for (let y = yb + 3; y + 2 < ny; y += 3) {
    for (let c = 0; c < NL; c++) full[c] = cells[y * NL + c] !== EMPTY && cells[(y + 1) * NL + c] !== EMPTY && cells[(y + 2) * NL + c] !== EMPTY ? 1 : 0;
    // in-layer (8-neighbour) distance to a supported full cell
    dist.fill(-1);
    let q: number[] = [];
    for (let c = 0; c < NL; c++) if (full[c] && cells[(y - 1) * NL + c] !== EMPTY) { dist[c] = 0; q.push(c); }
    for (let d = 0; q.length && d < 3; d++) {
      const next: number[] = [];
      for (const c of q) {
        const x = c % nx, z = (c - x) / nx;
        for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
          const X = x + dx, Z = z + dz;
          if (X < 0 || Z < 0 || X >= nx || Z >= nz) continue;
          const j = X + nx * Z;
          if (full[j] && dist[j] < 0) { dist[j] = d + 1; next.push(j); }
        }
      }
      q = next;
    }
    for (let c = 0; c < NL; c++) {
      if (!full[c] || (dist[c] >= 0 && dist[c] < 2)) continue;
      if (y + 3 < ny && cells[(y + 3) * NL + c] !== EMPTY) continue; // something stands on it: it is held from above
      let air = true;
      for (let k = 1; k <= 3 && air; k++) if (cells[(y - k) * NL + c] !== EMPTY || (keep && keep[(y - k) * NL + c])) air = false;
      if (!air) continue;
      // only hidden air (inside the walls: solid along all four horizontal rays), never a visible gap such as a
      // handle's hole or the space under an eave
      const x = c % nx, z = (c - x) / nx;
      let enclosed = true;
      for (let k = 1; k <= 3 && enclosed; k++) {
        const off = (y - k) * NL;
        const ray = (dx: number, dz: number) => { for (let X = x + dx, Z = z + dz; X >= 0 && Z >= 0 && X < nx && Z < nz; X += dx, Z += dz) if (solid[off + X + nx * Z]) return true; return false; };
        enclosed = ray(1, 0) && ray(-1, 0) && ray(0, 1) && ray(0, -1);
      }
      if (!enclosed) continue;
      fill.push(c);
    }
    // applied after the band's scan, so the result does not depend on the scan order (mirror symmetry)
    for (const c of fill) for (let k = 1; k <= 3; k++) { cells[(y - k) * NL + c] = ANY; solid[(y - k) * NL + c] = 1; filled++; }
    fill.length = 0;
  }
  return filled;
}

/** Visible 26-neighbour indices of voxel i (writes into out, returns count). */
function visibleNeighbours(g: VoxelGrid, i: number, out: Int32Array): number {
  const { nx, ny, nz, visible } = g;
  const NL = nx * nz;
  const x = i % nx, z = Math.floor(i / nx) % nz, y = Math.floor(i / NL);
  let n = 0;
  for (let dy = -1; dy <= 1; dy++) {
    const Y = y + dy;
    if (Y < 0 || Y >= ny) continue;
    for (let dz = -1; dz <= 1; dz++) {
      const Z = z + dz;
      if (Z < 0 || Z >= nz) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const X = x + dx;
        if (X < 0 || X >= nx || (!dx && !dy && !dz)) continue;
        const j = X + nx * (Z + nz * Y);
        if (visible[j]) out[n++] = j;
      }
    }
  }
  return n;
}

function modeFilter(g: VoxelGrid, cells: Int16Array, margin: number): boolean {
  const out = cells.slice();
  const nb = new Int32Array(26);
  const cnt = new Map<number, number>();
  let changed = false;
  for (let i = 0; i < cells.length; i++) {
    if (!g.visible[i] || cells[i] < 0) continue;
    const n = visibleNeighbours(g, i, nb);
    if (n < 3) continue;
    cnt.clear();
    let own = 0;
    for (let k = 0; k < n; k++) {
      const c = cells[nb[k]];
      if (c < 0) continue;
      if (c === cells[i]) own++;
      else cnt.set(c, (cnt.get(c) ?? 0) + 1);
    }
    let best = -1, bestN = 0;
    for (const [c, m] of cnt) if (m > bestN) { bestN = m; best = c; }
    if (best >= 0 && bestN >= own + margin) { out[i] = best; changed = true; }
  }
  cells.set(out);
  return changed;
}

/** Recolour same-colour surface regions smaller than `min` voxels with their most common neighbouring colour. */
function mergeRegions(g: VoxelGrid, cells: Int16Array, min: number): boolean {
  const N = cells.length;
  const label = new Int32Array(N).fill(-1);
  const nb = new Int32Array(26);
  let changed = false;
  const members: number[] = [];
  const border = new Map<number, number>();
  for (let s = 0; s < N; s++) {
    if (!g.visible[s] || cells[s] < 0 || label[s] >= 0) continue;
    const c0 = cells[s];
    members.length = 0;
    border.clear();
    label[s] = s;
    members.push(s);
    for (let h = 0; h < members.length; h++) {
      const n = visibleNeighbours(g, members[h], nb);
      for (let k = 0; k < n; k++) {
        const j = nb[k], c = cells[j];
        if (c === c0) { if (label[j] < 0) { label[j] = s; members.push(j); } }
        else if (c >= 0) border.set(c, (border.get(c) ?? 0) + 1);
      }
      if (members.length >= min) break; // big enough: no need to finish the flood
    }
    if (members.length >= min || !border.size) continue;
    let best = -1, bestN = 0;
    for (const [c, m] of border) if (m > bestN) { bestN = m; best = c; }
    for (const i of members) cells[i] = best;
    changed = true;
  }
  return changed;
}

// =====================================================================================================  parts

const PLATE_DIMS = new Map(PLATES.map(([a, b, part]) => [`${a}x${b}`, part]));
const BRICK_DIMS = new Map(BRICKS.map(([a, b, part]) => [`${a}x${b}`, part]));
const partFor = (sx: number, sz: number, h: number) =>
  (h === 3 ? BRICK_DIMS : PLATE_DIMS).get(`${Math.min(sx, sz)}x${Math.max(sx, sz)}`);
const compat = (a: number, b: number) => (a === ANY ? b : b === ANY || a === b ? a : null);

/**
 * Merge parts into bigger standard parts without changing the covered voxels: 3 stacked plates with the same
 * footprint and compatible colours become a brick, and side-by-side parts whose union is a standard part are
 * joined. Stud contacts are a superset of the old ones, so connectivity never gets worse.
 */
export function coalesce(g: { nx: number; ny: number; nz: number }, input: Placement[], horizontal = true): Placement[] {
  const { nx, ny, nz } = g;
  const NL = nx * nz;
  const ps: (Placement | null)[] = input.map((p) => ({ ...p }));
  const owner = new Int32Array(ny * NL).fill(-1);
  const stamp = (id: number, v: number) => {
    const p = ps[id]!;
    for (let y = p.y; y < p.y + p.h; y++) for (let z = p.z; z < p.z + p.sz; z++) for (let x = p.x; x < p.x + p.sx; x++) owner[y * NL + x + nx * z] = v;
  };
  ps.forEach((_, id) => stamp(id, id));
  const at = (x: number, y: number, z: number) => (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz ? -1 : owner[y * NL + x + nx * z]);

  // vertical: plate + plate + plate -> brick
  for (let id = 0; id < ps.length; id++) {
    const p = ps[id];
    if (!p || p.h !== 1 || p.fixed) continue;
    const a = at(p.x, p.y + 1, p.z), b = at(p.x, p.y + 2, p.z);
    if (a < 0 || b < 0) continue;
    const pa = ps[a]!, pb = ps[b]!;
    if (pa.fixed || pb.fixed) continue;
    const same = (q: Placement) => q.h === 1 && q.x === p.x && q.z === p.z && q.sx === p.sx && q.sz === p.sz;
    if (!same(pa) || !same(pb)) continue;
    const c1 = compat(p.color, pa.color);
    const c = c1 === null ? null : compat(c1, pb.color);
    const part = partFor(p.sx, p.sz, 3);
    if (c === null || !part) continue;
    stamp(a, -1); stamp(b, -1); ps[a] = null; ps[b] = null;
    ps[id] = { ...p, h: 3, part, color: c };
    stamp(id, id);
  }
  // horizontal: join neighbours along x then z until nothing changes
  for (let pass = 0; pass < (horizontal ? 8 : 0); pass++) {
    let merged = 0;
    for (let id = 0; id < ps.length; id++) {
      const p = ps[id];
      if (!p || p.fixed) continue;
      for (const dir of [0, 1]) {
        const q = dir === 0 ? at(p.x + p.sx, p.y, p.z) : at(p.x, p.y, p.z + p.sz);
        if (q < 0 || q === id) continue;
        const o = ps[q]!;
        if (o.fixed || o.y !== p.y || o.h !== p.h) continue;
        if (dir === 0 ? o.z !== p.z || o.sz !== p.sz : o.x !== p.x || o.sx !== p.sx) continue;
        const sx = dir === 0 ? p.sx + o.sx : p.sx, sz = dir === 0 ? p.sz : p.sz + o.sz;
        const part = partFor(sx, sz, p.h);
        const c = compat(p.color, o.color);
        if (!part || c === null) continue;
        stamp(q, -1); ps[q] = null;
        Object.assign(p, { sx, sz, part, color: c });
        stamp(id, id);
        merged++;
        break;
      }
    }
    if (!merged) break;
  }
  return ps.filter((p): p is Placement => !!p);
}

/** Delete stud-connected groups of at most `maxParts` parts, except the largest group. */
export function dropLooseGroups(g: { nx: number; ny: number; nz: number }, ps: Placement[], maxParts: number): Placement[] {
  if (maxParts <= 0 || ps.length < 2) return ps;
  const c = new ComponentFinder(g).run(ps);
  if (c.count < 2) return ps;
  return ps.filter((_, i) => c.label[i] === c.largestLabel || (c.size.get(c.label[i]) ?? 0) > maxParts);
}

