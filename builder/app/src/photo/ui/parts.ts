// Footprints of the basic bricks/plates the converter emits (doc §4 step 9), for the 2D preview and
// readable part names. Unknown parts fall back to 1x1 plates.
import type { Brick } from '../../model/types';

/** [length (studs, along X when unrotated), width (studs), height (LDU)] */
const DIMS: Record<string, [number, number, number]> = {
  '3005': [1, 1, 24], '3004': [2, 1, 24], '3622': [3, 1, 24], '3010': [4, 1, 24], '3009': [6, 1, 24], '3008': [8, 1, 24],
  '3003': [2, 2, 24], '3002': [3, 2, 24], '3001': [4, 2, 24], '2456': [6, 2, 24], '3007': [8, 2, 24],
  '3024': [1, 1, 8], '3023': [2, 1, 8], '3623': [3, 1, 8], '3710': [4, 1, 8], '3666': [6, 1, 8], '3460': [8, 1, 8],
  '3022': [2, 2, 8], '3021': [3, 2, 8], '3020': [4, 2, 8], '3795': [6, 2, 8], '3034': [8, 2, 8], '3832': [10, 2, 8],
  '3031': [4, 4, 8], '3032': [6, 4, 8], '3035': [8, 4, 8], '3958': [6, 6, 8], '3036': [8, 6, 8],
};

const key = (part: string) => part.toLowerCase().replace(/\.dat$/, '').replace(/[a-z]+$/, '');

export function partDims(part: string): [number, number, number] {
  return DIMS[key(part)] ?? [1, 1, 8];
}

export function partLabel(part: string): string {
  const d = DIMS[key(part)];
  if (!d) return part.replace(/\.dat$/i, '');
  return `${d[2] === 24 ? 'Brick' : 'Plate'} ${d[1]} × ${d[0]}`;
}

type B = Pick<Brick, 'part' | 'pos' | 'rot'>;

/** Axis-aligned box in LDU: x/z extents and y (−Y up: y0 = top, y1 = bottom). */
export function brickBox(b: B) {
  const [L, W, H] = partDims(b.part);
  const turned = Math.abs(b.rot[0]) < 0.5; // 90° about Y: long axis on Z
  const hx = ((turned ? W : L) * 20) / 2;
  const hz = ((turned ? L : W) * 20) / 2;
  return { x0: b.pos[0] - hx, x1: b.pos[0] + hx, z0: b.pos[2] - hz, z1: b.pos[2] + hz, y0: b.pos[1], y1: b.pos[1] + H };
}

/** Model extent in studs (x, z) and bricks/plates (y in LDU). */
export function modelExtent(bricks: B[]) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const b of bricks) {
    const r = brickBox(b);
    x0 = Math.min(x0, r.x0); x1 = Math.max(x1, r.x1);
    z0 = Math.min(z0, r.z0); z1 = Math.max(z1, r.z1);
    y0 = Math.min(y0, r.y0); y1 = Math.max(y1, r.y1);
  }
  if (!bricks.length) return { w: 0, d: 0, hLdu: 0 };
  return { w: Math.round((x1 - x0) / 20), d: Math.round((z1 - z0) / 20), hLdu: y1 - y0 };
}
