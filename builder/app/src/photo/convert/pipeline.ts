// TriangleMesh -> bricks + BOM + stats (doc §4). Pure TS, no Node/DOM APIs: runs in the Web Worker and in
// Node tests. Ported from research/photo2brick/src/pipeline.ts.

import type { Brick } from '../../model/types';
import type { BomLine, ConvertOptions, ConvertMessage, DetailLevel } from '../types';
import type { TriangleMesh } from './mesh';
import { floodOutside, voxelize, vidx, type VoxelGrid } from './voxelize';
import { ColorMatcher, type ColorMetric, type PaletteColor } from './color';
import { BRICKS, PLATES, mergeBricks, mirrorLayout, packStructure, placementFrame, toBricks, EMPTY, ANY, DEFAULT_MERGE, type BrickFrame, type Placement } from './bricks';
import { repairConnectivity, ComponentFinder, DEFAULT_REPAIR } from './repair';
import { alignYaw, centredPhase, fitPhase, scaleForStuds, MAX_STUDS } from './orient';
import { bbox } from './voxelize';
import { approxSettings, coalesce, defaultStuds, dropLooseGroups, simplifyColours, simplifyShape, thickenSlabs, unifyBands, type ApproxSettings } from './simplify';
import { detectSymmetry, symmetrize, voteColours, type MirrorPlane } from './symmetry';
import { hollowInterior } from './interior';
import type { PhotoAnalysis, SpecialContext, SpecialPartsModule } from './contracts';
import { delightColours, type DelightStats } from './delight';
import { cleanArtefacts, type ArtefactStats } from './artefacts';
import { specialParts } from './special-hook';
import { PARTS as SPECIAL_PARTS } from './special/library';
import { xfBox } from './special/geom';

export type Stage = Extract<ConvertMessage, { type: 'progress' }>['stage'];
export type ProgressFn = (stage: Stage, fraction: number) => void;

export interface PipelineOptions extends ConvertOptions {
  metric?: ColorMetric;
  despeckle?: boolean;
  repair?: boolean;
  closeHoles?: number;
  /** Research override of the detail level's approximation settings (research/photo2brick/approx.ts). */
  approx?: Partial<ApproxSettings>;
  /** De-lighting + region-snapping colour stage (delight.ts); false = plain nearest colour per voxel (research). */
  delight?: boolean;
  /** Research only: original voxel colour sampler (see VoxelOptions.legacySampling). */
  legacySampling?: boolean;
  /** Research only: list the loose groups (every stud-connected group but the largest) in the stats. */
  reportLoose?: boolean;
  /** Research only: the colour stage before the region rules of 2026-10-26 (neutral pull, hue families, ground regions). */
  delightV1?: boolean;
  /**
   * Keep real recesses through the hole closing and drop enclosed clutter (voxelize.ts restoreRecesses / removeClutter).
   * Default: architecture only (vision category); a vehicle's dark recesses and open cabins are built solid.
   */
  keepRecesses?: boolean;
  /** Research: the AI-artefact colour cleanup (artefacts.ts; default true with the structure settings). */
  artefacts?: boolean;
  /** Special-parts module override (tests / research; null = none); default = ./special when present, else a no-op. */
  special?: SpecialPartsModule | null;
  /** Catalogue part ids for SpecialContext.hasPart (the worker has no catalogue: then every id passes). */
  partIds?: string[];
  /** Research flag: build the vision's structures from recipes first (special/structures.ts), plain bricks fill the rest. */
  structuresFirst?: boolean;
}

/**
 * The grid handed to SpecialPartsModule.reserve / refine (contracts.ts VoxelGrid): the voxel grid after
 * symmetrize + hollowing, plus the colour per voxel and the transform to the final LDraw coordinates.
 */
export interface StructureGrid extends VoxelGrid {
  /** Palette index per voxel; ANY (-1) = hidden, any colour; EMPTY (-2) = air or hollow interior. */
  cells: Int16Array;
  /** LDraw colour code per palette index. */
  paletteCodes: number[];
  /** Voxel colours as sampled from the texture, before de-lighting / snapping (same layout as rgb). */
  sampledRgb?: Float32Array;
  /**
   * Grid -> LDraw: a cell box [x, x+sx) x [y, y+h) x [z, z+sz) (h in plates) is a part at LDraw
   * pos = [(x + sx/2 - frame.cx) * 20, -(y - frame.y0 + h) * 8, -(z + sz/2 - frame.cz) * 20] (top centre of the body).
   * Rotation: identity = part's long side along grid X; [0,0,1, 0,1,0, -1,0,0] = along grid Z.
   */
  frame: BrickFrame;
  /** Mirror planes applied, in cell-boundary coordinates (cell i <-> 2p - 1 - i). */
  mirror: { x?: number; z?: number };
  /** Lowest occupied layer (ground). */
  y0: number;
}

export type SizeSource = 'reference' | 'vision' | 'default' | 'user';

export interface PipelineResult {
  bricks: Omit<Brick, 'id'>[];
  bom: BomLine[];
  grid: VoxelGrid;
  placements: Placement[];
  /** Voxels removed by the hollow interior (1 per voxel, grid indexing; empty array when nothing was hollowed). */
  hollowMask: Uint8Array;
  stats: {
    voxels: number; visibleVoxels: number; parts: number; bricks: number; plates: number;
    colours: number; distinctParts: number; lots: number;
    grid: [number, number, number];
    sizeStuds: [number, number, number]; scale: number; yawDeg: number; phase: [number, number, number];
    /**
     * Where the scale came from: 'reference' (lduPerUnit, measured from a reference brick), 'user' (sizeStuds),
     * 'vision' (LEGO mode: PhotoAnalysis.brickSize, see brickSizeScale) or 'default' (the detail level's default size).
     */
    sizeSource: SizeSource;
    /** Colour stage: de-lighting groups and their LEGO colours (absent when the stage was off). */
    colour?: DelightStats;
    /** AI-artefact colour cleanup (artefacts.ts): regions recoloured per rule. */
    artefacts?: ArtefactStats;
    /** Detail level used and the longest side it was converted at (studs). */
    detail: DetailLevel; longestStuds: number;
    /** Set when the requested size was over MAX_STUDS and the model was shrunk to it: the requested longest side (studs). */
    cappedFrom?: number;
    components: number; largestShare: number; componentsBefore: number;
    /** Structure: mirror planes applied, voxels removed by hollowing, special parts added. */
    symmetry: { axis: 'x' | 'z'; p: number; score: number; shape: number; colour: number; prior: boolean }[];
    hollowed: number; specialParts: number;
    /** Stage times; merge includes special (the special-parts module's reserve + refine). */
    ms: { orient: number; voxelize: number; colour: number; symmetry: number; merge: number; special: number; repair: number; total: number };
  };
}

/** Vision categories whose recesses are real (walkways, courtyards, window / door openings), kept as air by the voxelizer. */
const ARCHITECTURE = /\b(building|house|castle|fort|fortress|tower|church|temple|cathedral|palace|architecture|ruin|lighthouse|windmill|barn|cabin|shop|station)s?\b/i;

/** Hidden-only parts take this colour when it is in the palette. */
const HIDDEN_COLOR = 71;
/** LEGO-build mode: faces within 1 LDU of a lattice plane count as lying on it (reconstruction noise). */
const LEGO_NUDGE = 1;

export function photoToBricks(mesh: TriangleMesh, palette: PaletteColor[], o: PipelineOptions, progress: ProgressFn = () => {}): PipelineResult {
  if (!palette.length) throw new Error('empty colour palette');
  if (!mesh.indices.length) throw new Error('the model has no triangles');
  const now = () => performance.now();
  const t0 = now();

  // --- orientation + scale (glTF +Y up is kept; bricks.ts converts to LDraw -Y up) ---
  const lego = o.mode === 'lego';
  const yawDeg = lego ? alignYaw(mesh) : 0;
  const detail: DetailLevel = o.detail ?? 'balanced';
  let scale: number;
  let sizeSource: PipelineResult['stats']['sizeSource'] = 'default';
  // LEGO mode without a measured scale or an explicit size: the vision's stud / plate count (PhotoAnalysis.brickSize)
  const fromBricks = lego && !(o.lduPerUnit !== undefined && o.lduPerUnit > 0) && o.sizeStuds === undefined ? brickSizeScale(mesh, o.analysis) : null;
  const longest = scaleForStuds(mesh, 1); // LDU per unit for a 1-stud model
  let cappedFrom: number | undefined;
  if (o.lduPerUnit !== undefined && o.lduPerUnit > 0) { scale = o.lduPerUnit; sizeSource = 'reference'; }
  else if (fromBricks) {
    scale = fromBricks.scale; sizeSource = 'vision';
    // a low-confidence count of a big build: its order of magnitude is right, the exact count is not, so it is limited
    // to BRICK_SIZE_BIG_MAX without reporting a cap (cappedFrom is for real sizes over the converter's limit)
    if (fromBricks.lowConfidence && scale / longest > BRICK_SIZE_BIG_MAX) scale = longest * BRICK_SIZE_BIG_MAX;
  } else {
    if (o.sizeStuds !== undefined) sizeSource = 'user';
    const { min, max } = bbox(mesh.positions);
    const studs = o.sizeStuds ?? defaultStuds(detail, [max[0] - min[0], max[1] - min[1], max[2] - min[2]]);
    scale = scaleForStuds(mesh, Math.min(MAX_STUDS, Math.max(2, Math.round(studs))));
  }
  let longestStuds = scale / longest;
  // A measured scale (reference brick) or the vision's stud count can ask for more than the converter's limit (a big
  // build photographed next to a small brick): shrink to the limit instead of failing the whole build.
  if (longestStuds > MAX_STUDS + 1e-6) {
    cappedFrom = Math.round(longestStuds);
    scale = longest * MAX_STUDS;
    longestStuds = MAX_STUDS;
  }
  const ax: ApproxSettings = { ...approxSettings(detail, o.mode, longestStuds), ...o.approx };
  const phase = lego ? fitPhase(mesh, scale, LEGO_NUDGE) : centredPhase(mesh, scale);
  const t1 = now();

  // --- voxelize ---
  progress('voxelize', 0);
  const shell = o.hollow && !ax.structure;
  // architecture (vision category): its recesses are real (walkways behind battlements, courtyards, window openings)
  const arch = ARCHITECTURE.test(o.analysis?.category ?? ''); // with the structure packer the hollow toggle = 1-stud walls + supports
  const grid = voxelize(mesh, { scale, phase, hollow: shell ? 1 : 0, closeHoles: o.closeHoles ?? 1, snap: lego ? LEGO_NUDGE : 0, legacySampling: o.legacySampling, keepRecesses: o.keepRecesses ?? arch, sideRecesses: arch, onProgress: (f) => progress('voxelize', f) });
  // tall LEGO builds: plate steps are noise at this scale (ApproxSettings.legoSnapPlates)
  if (lego && ax.layerSnap === 'none' && ax.legoSnapPlates > 0 && solidHeight(grid) >= ax.legoSnapPlates) ax.layerSnap = 'all';
  // builder-style shape simplification (hollow shells keep their exact thickness)
  if (!shell) simplifyShape(grid, ax);
  const t2 = now();

  // --- colour ---
  progress('colour', 0);
  const { nx, ny, nz, solid, visible, rgb } = grid;
  const cells = new Int16Array(nx * ny * nz).fill(EMPTY);
  let colourStats: DelightStats | undefined;
  // LEGO builds without vision colour regions keep the per-voxel match: their bricks are already flat colours, and the
  // automatic de-lighting lowered the ground-truth colour agreement there (research/photo2brick/colour/report.md)
  const delight = o.delight ?? (!lego || !!o.analysis?.colorRegions?.length);
  // The texture as sampled, before colours are snapped: special parts read dark wall openings (windows, slits) from it.
  const sampledRgb = grid.rgb.slice();
  if (delight) {
    // de-light baked shading and snap to the vision colour regions (without them: merge lightness-only clusters)
    for (let i = 0; i < cells.length; i++) if (solid[i]) cells[i] = visible[i] ? 0 : ANY;
    colourStats = delightColours(grid, cells, palette, { analysis: o.analysis, v1: o.delightV1 });
  } else {
    const matcher = new ColorMatcher(palette, o.metric ?? 'ciede2000');
    for (let i = 0; i < cells.length; i++) {
      if (!solid[i]) continue;
      cells[i] = visible[i] ? matcher.match(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]) : ANY;
    }
  }
  progress('colour', 0.6);
  if (o.despeckle !== false) despeckle(grid, cells);
  // --- mirror symmetry (structure): shape, colours and sampled rgb, before the colour passes so they see a
  // symmetric surface; one more vote afterwards removes tie-break leftovers
  const tS = now();
  const planes: MirrorPlane[] = [];
  if (ax.structure) {
    const det = detectSymmetry(grid, cells, { detail, analysis: o.analysis, threshold: ax.symmetryThreshold });
    for (const m of det.accepted) { symmetrize(grid, cells, m, ax.symmetryShape); planes.push(m); }
  }
  let symMs = now() - tS;
  progress('colour', 0.8);
  simplifyColours(grid, cells, palette, ax);
  const tV = now();
  for (const m of planes) voteColours(grid, cells, m);
  symMs += now() - tV;
  // AI-mesh artefacts: painted foliage / dark holes on walls, stray and misplaced colours (artefacts.ts)
  const artefacts = ax.structure && o.artefacts !== false ? cleanArtefacts(grid, cells, palette, o.analysis, colourStats) : undefined;
  progress('colour', 1);
  const t3 = now();

  // --- hollow interior + supports (structure) ---
  let hollowed = 0;
  let hollowMask: Uint8Array = new Uint8Array(0);
  if (ax.structure) {
    const wall = o.hollow ? 1 : ax.hollowWall;
    if (wall > 0) {
      const b = solidBox(grid);
      const px = planes.find((m) => m.axis === 0)?.p ?? Math.round((b.x0 + b.x1 + 1) / 2);
      const pz = planes.find((m) => m.axis === 2)?.p ?? Math.round((b.z0 + b.z1 + 1) / 2);
      const h = hollowInterior(grid, cells, { wall, floor: 0, roof: ax.basePlates ? 6 : 3, pitch: ax.pillarPitch, minCavity: 4, centre: [px, pz], base: ax.basePlates });
      hollowed = h.removed;
      hollowMask = h.mask;
    }
  }

  // --- merge ---
  progress('merge', 0);
  const codes = palette.map((p) => p.code);
  const fallback = codes.includes(HIDDEN_COLOR) ? HIDDEN_COLOR : codes[0];
  const sb = solidBox(grid);
  // brick-first colour: one colour per solid 3-plate band of a column, so layer colour noise never forces plates
  if (ax.bandUnify && o.allowBricks !== false) unifyBands(grid, cells, sb.y0 + ax.basePlates);
  if (ax.structure && ax.slabs === 'thicken' && o.allowBricks !== false) thickenSlabs(grid, cells, sb.y0 + ax.basePlates);
  const frame: BrickFrame = { cx: Math.round((sb.x0 + sb.x1 + 1) / 2), cz: Math.round((sb.z0 + sb.z1 + 1) / 2), y0: sb.y0 };
  const layoutPlane = ax.mirrorLayout ? planes[0] ?? null : null;
  const special = o.special === undefined ? specialParts : o.special;
  const partIds = o.partIds ? new Set(o.partIds) : null;
  let fixed: Placement[] = [];
  let reservedParts: Omit<Brick, 'id'>[] = [];
  let refineParts: Omit<Brick, 'id'>[] = [];
  let droppedSpecial = 0;
  let specialMs = 0;
  let merged: Placement[];
  if (ax.structure) {
    const sgrid: StructureGrid = {
      ...grid, cells, paletteCodes: codes, frame, y0: sb.y0, sampledRgb,
      mirror: { x: planes.find((m) => m.axis === 0)?.p, z: planes.find((m) => m.axis === 2)?.p },
    };
    const used = new Set<number>();
    for (let i = 0; i < cells.length; i++) if (cells[i] >= 0) used.add(codes[cells[i]]);
    const ctx: SpecialContext & { mirrorZ?: number } = {
      mode: o.mode, detail, analysis: o.analysis, mirrorX: sgrid.mirror.x, mirrorZ: sgrid.mirror.z,
      palette: [...used], hasPart: (id: string) => (partIds ? partIds.has(id) : true), structuresFirst: o.structuresFirst,
    };
    if (special) {
      const tR = now();
      const r = special.reserve(sgrid, ctx);
      specialMs += now() - tR;
      reservedParts = r.parts;
      fixed = fixedFromMask(grid, r.reserved, 0);
      for (const f of fixed) cells[vidx(grid, f.x, f.y, f.z)] = EMPTY;
    }
    const po = { useBricks: o.allowBricks !== false, effort: ax.packEffort, budgetMs: ax.packBudgetMs, weights: ax.packWeights, base: ax.basePlates, slabPlates: ax.slabs === 'plates', widePlates: ax.bigParts };
    // special parts need not be symmetric: cells whose mirror is taken (or of another colour) are packed afterwards
    // without the mirror, so a mirrored part never lands in a reserved cell
    let packCells = cells, extra: Int16Array | null = null;
    if (layoutPlane) {
      const p2 = Math.round(layoutPlane.p * 2);
      const { nx, nz } = grid;
      for (let i = 0; i < cells.length; i++) {
        if (cells[i] === EMPTY) continue;
        const x = i % nx, z = Math.floor(i / nx) % nz;
        const X = layoutPlane.axis === 0 ? p2 - 1 - x : x, Z = layoutPlane.axis === 2 ? p2 - 1 - z : z;
        const j = X >= 0 && X < nx && Z >= 0 && Z < nz ? i + (X - x) + nx * (Z - z) : -1;
        const a = cells[i], b = j >= 0 ? cells[j] : EMPTY;
        if (b !== EMPTY && (a === b || a === ANY || b === ANY)) continue;
        if (!extra) { extra = new Int16Array(cells.length).fill(EMPTY); packCells = cells.slice(); }
        extra[i] = a;
        packCells[i] = EMPTY;
      }
    }
    merged = packStructure(grid, packCells, { ...po, mirror: layoutPlane, fixed }, (f) => progress('merge', f));
    if (extra) {
      const support = merged.map((p) => ({ ...p, fixed: true }));
      merged = [...merged, ...packStructure(grid, extra, { ...po, budgetMs: ax.packBudgetMs / 4, mirror: null, fixed: support }).slice(support.length)];
    }
    // plate stacks -> bricks (keeps the symmetry); side-by-side joins only without a mirrored layout
    if (ax.coalesce) merged = coalesce(grid, merged, !layoutPlane);
    if (special) {
      // refine swaps surface bricks for slopes / tiles / ...: the cells of the bricks it removed become fixed
      const structural = merged.filter((p) => !p.fixed);
      const before = toBricks(structural, codes, fallback, frame);
      const tF = now();
      const after = special.refine(sgrid, before, ctx);
      specialMs += now() - tF;
      const kept = new Set(after);
      const removedCells = new Uint8Array(cells.length);
      const keep: Placement[] = [];
      structural.forEach((p, k) => {
        if (kept.has(before[k])) { keep.push(p); return; }
        for (let y = p.y; y < p.y + p.h; y++) for (let z = p.z; z < p.z + p.sz; z++) for (let x = p.x; x < p.x + p.sx; x++) removedCells[vidx(grid, x, y, z)] = 1;
      });
      const inBefore = new Set(before);
      refineParts = after.filter((b) => !inBefore.has(b));
      let nextGroup = 0;
      for (const f of fixed) nextGroup = Math.max(nextGroup, (f.group ?? 0) + 1);
      fixed = [...fixed, ...fixedFromMask(grid, removedCells, nextGroup)];
      merged = [...fixed, ...keep];
    }
  } else {
    merged = mergeBricks(grid, cells, { ...DEFAULT_MERGE, useBricks: o.allowBricks !== false, packing: ax.packing }, (f) => progress('merge', f));
    if (ax.coalesce) merged = coalesce(grid, merged);
  }
  progress('merge', 1);
  const t4 = now();

  // --- connectivity repair (special parts take part as fixed, rigid pseudo-parts) ---
  progress('repair', 0);
  let placements = merged;
  let compBefore: number, compAfter: number, share: number;
  if (o.repair !== false && merged.length > 1) {
    const r = repairConnectivity(grid, cells, merged, { ...DEFAULT_REPAIR, bricksFirst: ax.bigParts }, (f) => progress('repair', f));
    placements = r.placements;
    compBefore = r.before.count;
    compAfter = r.after.count;
    share = r.after.largest / Math.max(1, placements.length);
  } else {
    const c = new ComponentFinder(grid).run(merged);
    compBefore = compAfter = c.count;
    share = c.largest / Math.max(1, merged.length);
  }
  if (ax.coalesce && placements !== merged) placements = coalesce(grid, placements, !layoutPlane);
  if (layoutPlane && placements !== merged) {
    // the repair re-tiles without the mirror: restore the symmetric layout when that keeps the connectivity
    const mo = { useBricks: o.allowBricks !== false, effort: ax.packEffort, budgetMs: ax.packBudgetMs / 4, weights: ax.packWeights, base: ax.basePlates, slabPlates: ax.slabs === 'plates', widePlates: ax.bigParts };
    const finder = new ComponentFinder(grid);
    let best: { ps: Placement[]; count: number } | null = null;
    for (const side of ['low', 'high'] as const) {
      const ps = mirrorLayout(grid, cells, placements, layoutPlane, mo, side);
      const count = finder.run(ps).count;
      if (!best || count < best.count || (count === best.count && ps.length < best.ps.length)) best = { ps, count };
    }
    if (best!.count <= compAfter) {
      placements = ax.coalesce ? coalesce(grid, best!.ps, false) : best!.ps;
      const cc = finder.run(placements);
      compAfter = cc.count;
      share = cc.largest / Math.max(1, placements.length);
    }
  }
  if (ax.dropLoose > 0 && compAfter > 1) {
    placements = dropLooseGroups(grid, placements, ax.dropLoose);
    const c = new ComponentFinder(grid).run(placements);
    compAfter = c.count;
    share = c.largest / Math.max(1, placements.length);
  }
  progress('repair', 1);
  let loose: { parts: number; box: number[]; sample: string[] }[] | undefined;
  if (o.reportLoose && compAfter > 1) {
    const c = new ComponentFinder(grid).run(placements);
    const by = new Map<number, Placement[]>();
    placements.forEach((p, i) => { if (c.label[i] !== c.largestLabel) { const l = c.label[i]; if (!by.has(l)) by.set(l, []); by.get(l)!.push(p); } });
    loose = [...by.values()].map((ps) => ({
      parts: ps.length,
      box: [Math.min(...ps.map((p) => p.x)), Math.min(...ps.map((p) => p.y)), Math.min(...ps.map((p) => p.z)), Math.max(...ps.map((p) => p.x + p.sx)), Math.max(...ps.map((p) => p.y + p.h)), Math.max(...ps.map((p) => p.z + p.sz))],
      sample: [...new Set(ps.map((p) => `${p.part}${p.fixed ? '*' : ''}`))].slice(0, 6),
    }));
  }
  if (ax.structure) colourExposed(grid, placements, hollowMask);
  const structural = placements.filter((p) => !p.fixed);
  let bricks: Omit<Brick, 'id'>[];
  if (ax.structure) {
    // keep the frame (special parts were placed in it), then rest the model on y = 0 by its lowest part: a dropped
    // ground layer lifts everything, a wheel reaching below the lowest brick lifts the bricks
    bricks = [...toBricks(structural, codes, fallback, frame), ...reservedParts, ...refineParts];
    // the repair / loose-group dropping after refine can take away the bricks a slope or curve stood on: such special
    // parts would float, so they go too (repeated: a part may have stood on a removed one)
    const nb = bricks.length;
    bricks = dropUnsupportedSpecial(bricks);
    droppedSpecial = nb - bricks.length;
    let bottom = -Infinity;
    for (const b of bricks) bottom = Math.max(bottom, partBottom(b));
    if (Number.isFinite(bottom) && Math.abs(bottom) > 1e-6) bricks = bricks.map((b) => ({ ...b, pos: [b.pos[0], b.pos[1] - bottom, b.pos[2]] }));
  } else bricks = toBricks(structural, codes, fallback, placementFrame(structural));
  const t5 = now();

  const bomMap = new Map<string, BomLine>();
  for (const b of bricks) {
    const k = `${b.part}|${b.color}`;
    const line = bomMap.get(k);
    if (line) line.count++;
    else bomMap.set(k, { part: b.part, color: b.color, count: 1 });
  }
  const bom = [...bomMap.values()].sort((a, b) => b.count - a.count || a.part.localeCompare(b.part) || a.color - b.color);
  let voxels = 0, vis = 0;
  for (let i = 0; i < solid.length; i++) { voxels += solid[i]; vis += visible[i]; }
  const nb = structural.filter((p) => p.h === 3).length;
  return {
    bricks, bom, grid, placements: structural, hollowMask,
    stats: {
      voxels, visibleVoxels: vis, parts: bricks.length, bricks: nb, plates: structural.length - nb,
      colours: new Set(bricks.map((b) => b.color)).size,
      distinctParts: new Set(bricks.map((b) => b.part)).size, lots: bom.length,
      grid: [nx, ny, nz],
      sizeStuds: [grid.sizeLdu[0] / 20, grid.sizeLdu[1] / 8, grid.sizeLdu[2] / 20],
      scale, yawDeg, phase, sizeSource, ...(colourStats ? { colour: colourStats } : {}), ...(artefacts ? { artefacts } : {}), detail, longestStuds,
      ...(cappedFrom !== undefined ? { cappedFrom } : {}),
      components: compAfter, largestShare: share, componentsBefore: compBefore, ...(loose ? { loose } : {}),
      symmetry: planes.map((m) => ({ axis: m.axis === 0 ? 'x' as const : 'z' as const, p: m.p, score: m.score, shape: m.shape, colour: m.colour, prior: m.prior })),
      hollowed, specialParts: reservedParts.length + refineParts.length - droppedSpecial,
      ms: { orient: t1 - t0, voxelize: t2 - t1, colour: t3 - t2, symmetry: symMs, merge: t4 - t3, special: specialMs, repair: t5 - t4, total: t5 - t0 },
    },
  };
}

export { BRICK_SIZE_MIN_CONFIDENCE, BRICK_SIZE_BIG_PLATES, BRICK_SIZE_BIG_STUDS, BRICK_SIZE_BIG_MIN_CONFIDENCE, BRICK_SIZE_BIG_MAX, brickSizeUsable } from './sizeRules';
import { BRICK_SIZE_BIG_MAX, brickSizeUsable } from './sizeRules';

/**
 * LEGO-build mode: LDU per mesh unit so the model matches the vision's stud / plate count (PhotoAnalysis.brickSize).
 * Three estimates: shorter footprint side, longer footprint side (studs, matched by rank since a photo cannot say
 * which side is "wide") and height (plates). The two that agree best are used (the third is usually the one the AI
 * mesh or the count got wrong: a base plate merged into the ground, a protruding bumper), each snapped so its
 * dimension is a whole number of studs / plates, then combined by geometric mean. A big build's low-confidence count
 * (brickSizeUsable 'big', lowConfidence) uses the largest estimate instead. null without a usable brickSize. The mesh must already be yaw-aligned (alignYaw).
 */
export function brickSizeScale(mesh: TriangleMesh, analysis: PhotoAnalysis | undefined): { scale: number; lowConfidence: boolean } | null {
  const bs = analysis?.brickSize;
  const usable = brickSizeUsable(bs);
  if (!bs || !usable) return null;
  const { min, max } = bbox(mesh.positions);
  const ex = max[0] - min[0], ey = max[1] - min[1], ez = max[2] - min[2];
  if (!(ex > 0 && ey > 0 && ez > 0)) return null;
  const fLo = Math.min(bs.studsWide, bs.studsDeep), fHi = Math.max(bs.studsWide, bs.studsDeep);
  const cand = [
    { ldu: fLo * 20, ext: Math.min(ex, ez), cell: 20 },
    { ldu: fHi * 20, ext: Math.max(ex, ez), cell: 20 },
    { ldu: bs.plates * 8, ext: ey, cell: 8 },
  ].filter((c) => c.ldu > 0).map((c) => ({ ...c, s: c.ldu / c.ext }));
  if (!cand.length) return null;
  let use = cand;
  // a rough count of a big build is short rather than long (hidden depth, merged courses; the owner's castle: 32 x 32
  // studs counted, ~55 x 45 real, 170 plates right): the largest estimate
  if (usable === 'big') use = [cand.reduce((a, c) => (c.s > a.s ? c : a))];
  else if (cand.length === 3) {
    const l = cand.map((c) => Math.log(c.s));
    const pairs: [number, number][] = [[0, 1], [0, 2], [1, 2]];
    let bp = pairs[0], bd = Infinity;
    for (const p of pairs) { const d = Math.abs(l[p[0]] - l[p[1]]); if (d < bd) { bd = d; bp = p; } }
    use = [cand[bp[0]], cand[bp[1]]];
  }
  // lattice snap: each used dimension a whole number of cells at the common scale, then the geometric mean
  const s0 = Math.exp(use.reduce((a, c) => a + Math.log(c.s), 0) / use.length);
  const snapped = use.map((c) => (Math.max(1, Math.round((c.ext * s0) / c.cell)) * c.cell) / c.ext);
  return { scale: Math.exp(snapped.reduce((a, s) => a + Math.log(s), 0) / snapped.length), lowConfidence: usable === 'big' };
}

/** A visible voxel whose colour no visible 26-neighbour shares takes the majority neighbour colour. */
function despeckle(g: VoxelGrid, cells: Int16Array) {
  const { nx, ny, nz, visible } = g;
  const out = cells.slice();
  const count = new Map<number, number>();
  for (let y = 0; y < ny; y++)
    for (let z = 0; z < nz; z++)
      for (let x = 0; x < nx; x++) {
        const i = vidx(g, x, y, z);
        if (!visible[i]) continue;
        count.clear();
        let own = 0, total = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dz = -1; dz <= 1; dz++)
            for (let dx = -1; dx <= 1; dx++) {
              if (!dx && !dy && !dz) continue;
              const X = x + dx, Y = y + dy, Z = z + dz;
              if (X < 0 || Y < 0 || Z < 0 || X >= nx || Y >= ny || Z >= nz) continue;
              const j = vidx(g, X, Y, Z);
              if (!visible[j]) continue;
              total++;
              if (cells[j] === cells[i]) own++;
              else count.set(cells[j], (count.get(cells[j]) ?? 0) + 1);
            }
        if (own > 0 || total < 3) continue;
        let best = -1, bestN = 0;
        for (const [c, n] of count) if (n > bestN) { bestN = n; best = c; }
        if (bestN * 2 >= total) out[i] = best;
      }
  cells.set(out);
}

/** Height of the solid in plates (layers from the lowest to the highest solid cell). */
function solidHeight(g: VoxelGrid): number {
  const NL = g.nx * g.nz;
  let lo = -1, hi = -1;
  for (let i = 0; i < g.solid.length; i++) if (g.solid[i]) { const y = Math.floor(i / NL); if (lo < 0) lo = y; hi = y; }
  return lo < 0 ? 0 : hi - lo + 1;
}

/** Solid bbox of the grid (inclusive cell indices) and the ground layer. */
function solidBox(g: VoxelGrid) {
  const { nx, ny, nz, solid } = g;
  let x0 = nx, x1 = -1, z0 = nz, z1 = -1, y0 = ny;
  for (let y = 0, i = 0; y < ny; y++)
    for (let z = 0; z < nz; z++)
      for (let x = 0; x < nx; x++, i++)
        if (solid[i]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z; if (y < y0) y0 = y; }
  if (x1 < 0) return { x0: 0, x1: 0, z0: 0, z1: 0, y0: 0 };
  return { x0, x1, z0, z1, y0 };
}

/** 1x1x1 fixed pseudo-parts for the cells of a mask, one group per 6-connected component (one rigid special part). */
function fixedFromMask(g: VoxelGrid, mask: Uint8Array, firstGroup: number): Placement[] {
  const { nx, ny, nz } = g;
  const NL = nx * nz;
  const label = new Int32Array(mask.length).fill(-1);
  const out: Placement[] = [];
  let group = firstGroup;
  const stack: number[] = [];
  for (let s = 0; s < mask.length; s++) {
    if (!mask[s] || label[s] >= 0) continue;
    label[s] = group; stack.push(s);
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % nx, z = Math.floor(i / nx) % nz, y = Math.floor(i / NL);
      out.push({ part: '', x, z, sx: 1, sz: 1, y, h: 1, color: ANY, fixed: true, group });
      for (const j of [x > 0 ? i - 1 : -1, x < nx - 1 ? i + 1 : -1, z > 0 ? i - nx : -1, z < nz - 1 ? i + nx : -1, y > 0 ? i - NL : -1, y < ny - 1 ? i + NL : -1])
        if (j >= 0 && mask[j] && label[j] < 0) { label[j] = group; stack.push(j); }
    }
    group++;
  }
  return out;
}

/** Special part kinds that need a part right under them (or on them, except slopes / curves / tiles). */
const NEEDS_SUPPORT = new Set(['slope45', 'slope33', 'slopeInv45', 'curve', 'curveDouble', 'tile', 'roundBrick', 'roundPlate', 'roundTile', 'windscreen', 'headlightBrick', 'wheelHolder', 'technicBrick', 'windowFrame', 'doorFrame', 'slopeDouble', 'arch', 'leaves']);
const TOP_ONLY = new Set(['slope45', 'slope33', 'curve', 'tile', 'roundTile']);
const STD_DIMS = new Map<string, [number, number, number]>([...PLATES.map(([a, b, id]) => [id, [a, b, 1]] as [string, [number, number, number]]), ...BRICKS.map(([a, b, id]) => [id, [a, b, 3]] as [string, [number, number, number]])]);
/** LDraw body box [x0, y0, z0, x1, y1, z1] of a standard or special part (null when unknown). */
function bodyBox(p: Omit<Brick, 'id'>): [number, number, number, number, number, number] | null {
  const s = STD_DIMS.get(p.part);
  if (s) {
    const r = p.rot;
    const hx = Math.abs(r[0] * s[1] * 10 + r[2] * s[0] * 10), hz = Math.abs(r[6] * s[1] * 10 + r[8] * s[0] * 10);
    return [p.pos[0] - hx, p.pos[1], p.pos[2] - hz, p.pos[0] + hx, p.pos[1] + s[2] * 8, p.pos[2] + hz];
  }
  const sp = SPECIAL_PARTS[p.part];
  return sp ? xfBox(p.rot, p.pos as [number, number, number], sp.body) : null;
}
/**
 * Remove special parts that need support (NEEDS_SUPPORT) and have no part right under them (or, for the ones that may
 * hang, right over them) and are not on the ground; repeated until stable. Wheels-on-holders style pairs keep each other.
 */
function dropUnsupportedSpecial(bricks: Omit<Brick, 'id'>[]): Omit<Brick, 'id'>[] {
  let list = bricks;
  for (let pass = 0; pass < 6; pass++) {
    const boxes = list.map(bodyBox);
    let ground = -Infinity;
    for (const b of boxes) if (b) ground = Math.max(ground, b[4]);
    // spatial hash of box tops / bottoms by (x, z) 20-LDU column
    const col = new Map<string, number[]>();
    boxes.forEach((B, i) => { if (!B) return; for (let x = Math.floor(B[0] / 20); x <= Math.floor((B[3] - 0.01) / 20); x++) for (let z = Math.floor(B[2] / 20); z <= Math.floor((B[5] - 0.01) / 20); z++) { const k = `${x},${z}`; const a = col.get(k); if (a) a.push(i); else col.set(k, [i]); } });
    const drop = new Set<number>();
    list.forEach((p, i) => {
      const kind = SPECIAL_PARTS[p.part]?.kind;
      if (!kind || !NEEDS_SUPPORT.has(kind)) return;
      const A = boxes[i];
      if (!A || Math.abs(A[4] - ground) < 0.6) return;
      const near = new Set<number>();
      for (let x = Math.floor(A[0] / 20); x <= Math.floor((A[3] - 0.01) / 20); x++) for (let z = Math.floor(A[2] / 20); z <= Math.floor((A[5] - 0.01) / 20); z++) for (const j of col.get(`${x},${z}`) ?? []) near.add(j);
      const touch = (B: number[], below: boolean) => (below ? Math.abs(B[1] - A[4]) < 0.6 : Math.abs(B[4] - A[1]) < 0.6) && A[0] < B[3] - 1 && B[0] < A[3] - 1 && A[2] < B[5] - 1 && B[2] < A[5] - 1;
      let ok = false;
      for (const j of near) {
        const B = boxes[j];
        if (j === i || !B) continue;
        if (touch(B, true) || (!TOP_ONLY.has(kind) && touch(B, false))) { ok = true; break; }
      }
      // a round plate / tile held by its headlight brick
      if (!ok && (kind === 'roundPlate' || kind === 'roundTile')) ok = list.some((q) => SPECIAL_PARTS[q.part]?.kind === 'headlightBrick' && Math.hypot(q.pos[0] - p.pos[0], q.pos[2] - p.pos[2]) < 20 && Math.abs(q.pos[1] - p.pos[1]) < 16);
      if (!ok) drop.add(i);
    });
    // glass and doors hang in their frame: they go when no frame holds them any more
    list.forEach((p, i) => {
      const kind = SPECIAL_PARTS[p.part]?.kind;
      if ((kind !== 'glass' && kind !== 'door') || drop.has(i)) return;
      const A = boxes[i];
      const held = A && list.some((q, j) => {
        const k = SPECIAL_PARTS[q.part]?.kind;
        const B = boxes[j];
        return j !== i && !drop.has(j) && (k === 'windowFrame' || k === 'doorFrame') && !!B
          && A[0] < B[3] + 1 && B[0] < A[3] + 1 && A[1] < B[4] + 1 && B[1] < A[4] + 1 && A[2] < B[5] + 1 && B[2] < A[5] + 1;
      });
      if (!held) drop.add(i);
    });
    if (!drop.size) break;
    list = list.filter((_, i) => !drop.has(i));
  }
  return list;
}

const STD_HEIGHT = new Map<string, number>([...PLATES.map(([, , id]) => [id, 8] as const), ...BRICKS.map(([, , id]) => [id, 24] as const)]);
/** LDraw y of a part's bottom (largest y of its body, studs excluded): standard parts by height, special parts by their measured body box. */
function partBottom(b: Omit<Brick, 'id'>): number {
  const h = STD_HEIGHT.get(b.part);
  if (h !== undefined) return b.pos[1] + h;
  const spec = SPECIAL_PARTS[b.part];
  if (!spec) return b.pos[1];
  const [x0, y0, z0, x1, y1, z1] = spec.body;
  const r = b.rot;
  let m = -Infinity;
  for (const x of [x0, x1]) for (const y of [y0, y1]) for (const z of [z0, z1]) m = Math.max(m, r[3] * x + r[4] * y + r[5] * z);
  return b.pos[1] + m;
}

/**
 * Hidden-colour (ANY) parts that show (special parts carving air, dropped loose groups, re-tiling, the open bottom of
 * a hollow interior) take the most common colour of the coloured parts around them instead of the neutral fallback;
 * fully enclosed ones keep the fallback (Light Bluish Grey).
 */
function colourExposed(g: VoxelGrid, ps: Placement[], hollowMask: Uint8Array) {
  const { nx, ny, nz } = g;
  const NL = nx * nz;
  const own = new Int32Array(nx * ny * nz).fill(-1);
  ps.forEach((p, k) => { for (let y = p.y; y < p.y + p.h; y++) for (let z = p.z; z < p.z + p.sz; z++) for (let x = p.x; x < p.x + p.sx; x++) own[y * NL + x + nx * z] = k; });
  const wall = new Uint8Array(own.length);
  // the hollow interior counts as outside: it is open at the bottom, so its walls show from below
  for (let i = 0; i < own.length; i++) wall[i] = own[i] >= 0 ? 1 : 0;
  void hollowMask;
  const outside = floodOutside(wall, nx, ny, nz);
  const count = new Map<number, number>();
  for (let pass = 0; pass < 4; pass++) ps.forEach((p, k) => {
    if (p.fixed || p.color !== ANY) return;
    let exposed = false;
    count.clear();
    for (let y = p.y; y < p.y + p.h; y++)
      for (let z = p.z; z < p.z + p.sz; z++)
        for (let x = p.x; x < p.x + p.sx; x++)
          for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
            const X = x + dx, Y = y + dy, Z = z + dz;
            if (X < 0 || Y < 0 || Z < 0 || X >= nx || Y >= ny || Z >= nz) { exposed = true; continue; }
            const j = Y * NL + X + nx * Z;
            if (outside[j]) exposed = true;
            const o = own[j];
            if (o >= 0 && o !== k && ps[o].color >= 0) count.set(ps[o].color, (count.get(ps[o].color) ?? 0) + 1);
          }
    if (!exposed || !count.size) return;
    let best = ANY, n = 0;
    for (const [c, m] of count) if (m > n) { n = m; best = c; }
    p.color = best;
  });
}
