// Contracts between the three Photo-to-Bricks workstreams (PM-owned; change only via the PM).
//   structure  (symmetry.ts, bricks.ts, pipeline.ts)  — owns the pipeline and calls the hooks below
//   special    (special/**)                           — implements SpecialPartsModule
//   vision     (server/src/photo/vision.ts + API)     — produces PhotoAnalysis
//
// Pipeline order:
//   voxelize → colour → simplify → symmetrize (structure)
//   → special.reserve(...)   carve out regions for special parts, return those parts
//   → pack remaining voxels into bricks/plates (structure)
//   → special.refine(...)    swap surface bricks for slopes / curves / tiles / round parts
//   → connectivity repair (structure, must treat special parts as solid)

import type { Brick } from '../../model/types';
import type { DetailLevel, PhotoMode } from '../types';

/** Vision AI result for the photo(s). Coordinates are fractions of the FRONT image (0–1, origin top-left). */
export interface PhotoAnalysis {
  /** e.g. 'car', 'truck', 'house', 'animal', 'figure', 'mug', 'shoe', 'plant', 'other'. */
  category: string;
  /** Symmetry a builder would use. 'left-right' = mirror across the vertical plane facing the camera. */
  symmetry: 'left-right' | 'front-back' | 'both' | 'radial' | 'none';
  /** Where the subject is in the front photo. */
  subjectBox: [number, number, number, number];
  features: PhotoFeature[];
  /** Up to 6 dominant real-world colours, most important first, as #RRGGBB. */
  palette: string[];
  /** For LEGO-build photos: the model is already made of bricks; hints like "uses 2x4 bricks, studs on top". */
  isBrickBuilt: boolean;
  /**
   * LEGO-build photos only: real size estimated by counting studs / brick courses in the photo.
   * The converter uses it as the target size when the user did not mark a reference brick.
   */
  brickSize?: { studsWide: number; studsDeep: number; plates: number; confidence: number };
  /**
   * Named colour regions a builder would use (e.g. body "#7FB6C9", roof "#F2E6B1", tyres "#1B1B1B").
   * The converter snaps sampled colours to these (then to the nearest LEGO colour) to remove baked-in lighting.
   */
  colorRegions?: Array<{ name: string; color: string; share: number }>;
  /**
   * Architectural structures a LEGO designer would build from a recipe (columns, arches, towers…), not from filler.
   * Buildings / castles only for now. Absent on older analyses.
   */
  structures?: PhotoStructure[];
  notes?: string;
}

export type StructureKind =
  | 'wall' | 'column' | 'arch' | 'window' | 'door' | 'tower' | 'battlements' | 'roof' | 'stairs' | 'balcony' | 'fence';

export interface PhotoStructure {
  kind: StructureKind;
  /** Photo the box refers to. 'side' = a SIDE photo of unknown direction. */
  view: 'front' | 'back' | 'right' | 'left' | 'side';
  /** Bounding box in that image, fractions [x0, y0, x1, y1] (origin top-left). */
  box: [number, number, number, number];
  /**
   * Shape detail: column/tower 'round' | 'square'; arch/window/door top 'round' | 'pointed' | 'square';
   * roof 'gable' | 'hip' | 'cone' | 'pyramid' | 'flat'.
   */
  shape?: string;
  /** Repeats inside the box (e.g. 4 columns in a colonnade, 6 merlons, 3 windows in a row). Default 1. */
  count?: number;
  /** Real colour as #RRGGBB. */
  color?: string;
  confidence: number;
}

export type FeatureKind =
  | 'wheel' | 'windscreen' | 'window' | 'headlight' | 'taillight' | 'grille' | 'bumper'
  | 'door' | 'roof' | 'eye' | 'mouth' | 'ear' | 'leg' | 'arm' | 'handle' | 'spout' | 'text-or-logo' | 'other';

export interface PhotoFeature {
  kind: FeatureKind;
  /** Which photo the box refers to. */
  view: 'front' | 'back';
  /** Bounding box in that image, fractions [x0, y0, x1, y1]. */
  box: [number, number, number, number];
  /** Feature appears mirrored on the other side (e.g. left+right wheels) even if only one is visible. */
  mirrored: boolean;
  /** Real colour as #RRGGBB, if relevant (windows: tint). */
  color?: string;
  confidence: number;
}

/** The voxel grid as the pipeline holds it after colouring (read app/src/photo/convert/voxelize.ts for the concrete type). */
export type VoxelGrid = unknown;

export interface SpecialContext {
  mode: PhotoMode;
  detail: DetailLevel;
  analysis?: PhotoAnalysis;
  /** Mirror plane in grid X index space (cell boundary, may be .5), when the model was symmetrized. */
  mirrorX?: number;
  /** Mirror plane in grid Z index space (front-back symmetry, common for side-on cars and mugs). */
  mirrorZ?: number;
  /** Available LDraw colour codes (palette after simplification). */
  palette: number[];
  /** True when a part id exists in the catalog (only use parts that render). */
  hasPart(id: string): boolean;
  /** Build the analysis' structures from recipes first (special/structures.ts); research flag, off by default. */
  structuresFirst?: boolean;
}

export interface ReserveResult {
  /** One byte per grid cell: 1 = taken by a special part, structure must not pack it. Same indexing as the grid. */
  reserved: Uint8Array;
  parts: Omit<Brick, 'id'>[];
}

export interface SpecialPartsModule {
  reserve(grid: VoxelGrid, ctx: SpecialContext): ReserveResult;
  refine(grid: VoxelGrid, bricks: Omit<Brick, 'id'>[], ctx: SpecialContext): Omit<Brick, 'id'>[];
}
