// Special parts for Photo to Bricks (contract: ../contracts.ts SpecialPartsModule).
//
// reserve(grid, ctx)  -> { reserved, parts }   parts in the GRID FRAME (see geom.ts): translate them with the same
//                                               offset toBricks() applies to the packed bricks (gridToModelOffset).
// refine(grid, bricks, ctx) -> bricks          accepts bricks in the model frame (after toBricks) or in the grid
//                                               frame; the offset is detected by fitting the bricks onto grid.solid.
//
// grid must be the VoxelGrid of voxelize.ts (nx, ny, nz, solid, visible, rgb), after simplification/symmetrize.

import type { ReserveResult, SpecialContext, SpecialPartsModule } from '../contracts';
import type { Placement } from '../bricks';
import { reserveImpl, type ReserveInfo, type SpecialGrid } from './reserve';
import { refineImpl, type RefineInfo } from './refine';
import type { Part } from './geom';

export { PARTS, WHEEL_TIERS, SPECIAL_IDS } from './library';
export type { ReserveInfo, RefineInfo, SpecialGrid };

/** Last run diagnostics (research / debugging). */
export const lastRun: { reserve?: ReserveInfo; refine?: RefineInfo } = {};

/** reserve() masks per grid object, so refine() knows where the reserved parts are (the pipeline only passes the packed bricks). */
const reservedByGrid = new WeakMap<object, Uint8Array>();

export const specialParts: SpecialPartsModule = {
  reserve(grid: unknown, ctx: SpecialContext): ReserveResult {
    const r = reserveImpl(grid as SpecialGrid, ctx);
    reservedByGrid.set(grid as object, r.reserved);
    lastRun.reserve = r.info;
    return { reserved: r.reserved, parts: r.parts };
  },
  refine(grid: unknown, bricks: Part[], ctx: SpecialContext): Part[] {
    const r = refineImpl(grid as SpecialGrid, bricks, ctx, reservedByGrid.get(grid as object));
    lastRun.refine = r.info;
    return r.bricks;
  },
};

/**
 * Translation (LDU) from the grid frame to the model frame used by bricks.ts toBricks(): add it to every reserve()
 * part position. Mirrors toBricks' centring: cx/cz = rounded centre of the placements' footprint, y0 = lowest layer.
 */
export function gridToModelOffset(ps: Pick<Placement, 'x' | 'y' | 'z' | 'sx' | 'sz'>[]): [number, number, number] {
  let y0 = Infinity, x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const p of ps) {
    y0 = Math.min(y0, p.y);
    x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x + p.sx);
    z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z + p.sz);
  }
  if (!ps.length) return [0, 0, 0];
  const cx = Math.round((x0 + x1) / 2), cz = Math.round((z0 + z1) / 2);
  return [-cx * 20, y0 * 8, cz * 20];
}

/** Apply a translation to parts (e.g. reserve() parts -> model frame). */
export function translateParts(parts: Part[], t: [number, number, number]): Part[] {
  const c0 = (v: number) => (Object.is(v, -0) ? 0 : v);
  return parts.map((p) => ({ ...p, pos: [c0(p.pos[0] + t[0]), c0(p.pos[1] + t[1]), c0(p.pos[2] + t[2])] }));
}
