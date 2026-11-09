// Which SpecialPartsModule the pipeline uses (contracts.ts): the special-parts workstream in ./special.
// noopSpecialParts keeps the pipeline order (reserve -> pack -> refine -> repair) for tests and research.

import type { SpecialPartsModule } from './contracts';

export const noopSpecialParts: SpecialPartsModule = {
  reserve(grid) {
    const g = grid as { nx: number; ny: number; nz: number };
    return { reserved: new Uint8Array(g.nx * g.ny * g.nz), parts: [] };
  },
  refine(_grid, bricks) { return bricks; },
};

export { specialParts } from './special';
