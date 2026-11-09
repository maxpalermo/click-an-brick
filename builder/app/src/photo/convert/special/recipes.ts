// Structure recipes for the structures-first build order (structures.ts): which LEGO parts build a column, an arch,
// a window... and at what LEGO sizes. Seeded from the parts the converter already knows (library.ts, every id measured)
// and ranked by the recipe book mined from the LDraw Official Model Repository castle / house models
// (research/structures/out/recipe-book.json, see research/structures/README.md). A recipe whose parts are missing
// from the catalogue (SpecialContext.hasPart) is skipped, so the list order is the preference order.

export interface ColumnRecipe {
  id: string;
  /** Footprint in studs (square). */
  w: 1 | 2;
  shape: 'round' | 'square';
  /** One part per brick course (3 plates), stacked. */
  body: string;
  /** Optional 1-plate cap on an exposed column top. */
  cap?: string;
}

export interface ArchRecipe {
  id: string;
  part: string;
  /** Total width in studs (legs included) and height in plates; the opening is span - 2 wide. */
  span: number;
  h: number;
}

export const COLUMN_RECIPES: ColumnRecipe[] = [
  { id: 'column-round-1', w: 1, shape: 'round', body: '3062b.dat', cap: '6141.dat' },
  { id: 'column-round-2', w: 2, shape: 'round', body: '3941.dat', cap: '4032b.dat' },
];

/**
 * Most-used first within a span (recipe book: 1x6 / 1x6x2 and 1x4 / 1x4x2 dominate, 1x3 on 1x1 bricks is the castle
 * favourite for small openings; 1x8x2 and 1x12x3 for gates and blind arches).
 */
export const ARCH_RECIPES: ArchRecipe[] = [
  { id: 'arch-1x6x2', part: '3307.dat', span: 6, h: 6 },
  { id: 'arch-1x4', part: '3659.dat', span: 4, h: 3 },
  { id: 'arch-1x6', part: '3455.dat', span: 6, h: 3 },
  { id: 'arch-1x4x2', part: '6182.dat', span: 4, h: 6 },
  { id: 'arch-1x3', part: '4490.dat', span: 3, h: 3 },
  { id: 'arch-1x8x2', part: '16577.dat', span: 8, h: 6 },
  { id: 'arch-1x12x3', part: '6108.dat', span: 12, h: 9 },
];

/** LEGO sizes a structure snaps to (plan doc "Usual LEGO size"), in studs / plates. */
export const LEGO_SIZES = {
  /** a column is 1 or 2 studs wide and at least 2 bricks tall */
  column: { w: [1, 2], minPlates: 6 },
  /** an arch opening is 2 or 4 studs wide */
  arch: { open: [2, 4] },
  /** windows 2 studs wide (4 = a twin), 6 / 8 / 9 plates tall */
  window: { w: [2, 4] },
} as const;
