// Cheap nearest-LEGO-colour matcher for the live camera preview (UX A). The real converter uses its
// own CIEDE2000 matcher; for a 10 Hz preview OKLab distance + a 15-bit LUT is plenty.
import type { BrickColor } from '../../model/types';

/** Common solid colours in basic bricks and plates (same list as the converter spike). */
const COMMON_CODES = [
  0, 1, 2, 4, 14, 15, 19, 25, 27, 28, 70, 71, 72, 73, 78, 84, 191, 212, 226, 272, 288, 308, 320, 321, 322,
  326, 378, 379, 29, 5, 26, 30, 31, 92,
];

/** Fallback hex values when /api/colors is unavailable (LDConfig approximations). */
const FALLBACK_HEX: Record<number, string> = {
  0: '#1B2A34', 1: '#0055BF', 2: '#237841', 4: '#C91A09', 5: '#C870A0', 14: '#F2CD37', 15: '#FFFFFF',
  19: '#E4CD9E', 25: '#FE8A18', 26: '#923978', 27: '#BBE90B', 28: '#958A73', 29: '#E4ADC8', 30: '#AC78BA',
  31: '#E1D5ED', 70: '#582A12', 71: '#A0A5A9', 72: '#6C6E68', 73: '#5A93DB', 78: '#F6D7B3', 84: '#AA7D55',
  92: '#D09168', 191: '#F8BB3D', 212: '#9FC3E9', 226: '#FFF03A', 272: '#0A3463', 288: '#184632',
  308: '#352100', 320: '#720E0F', 321: '#078BC9', 322: '#36AEBF', 326: '#DFEEA5', 378: '#A0BCAC', 379: '#6074A1',
};

export interface LiveColor {
  code: number;
  hex: string;
  r: number;
  g: number;
  b: number;
}

const toLin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
function oklab(r8: number, g8: number, b8: number): [number, number, number] {
  const r = toLin(r8 / 255), g = toLin(g8 / 255), b = toLin(b8 / 255);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

export class LiveMatcher {
  readonly colors: LiveColor[];
  private labs: Float64Array;
  private lut = new Int16Array(1 << 15).fill(-1);

  constructor(all: BrickColor[]) {
    const byCode = new Map(all.map((c) => [c.code, c]));
    this.colors = COMMON_CODES.map((code) => {
      const c = byCode.get(code);
      const hex = c && c.alpha >= 255 ? c.hex : FALLBACK_HEX[code];
      const n = parseInt(hex.slice(1), 16);
      return { code, hex, r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
    });
    this.labs = new Float64Array(this.colors.length * 3);
    this.colors.forEach((c, i) => this.labs.set(oklab(c.r, c.g, c.b), i * 3));
  }

  /** sRGB bytes in → index into `colors`. */
  match(r: number, g: number, b: number): number {
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    const hit = this.lut[key];
    if (hit >= 0) return hit;
    const [L, A, B] = oklab((r & 0xf8) + 4, (g & 0xf8) + 4, (b & 0xf8) + 4);
    let best = 0, bestD = Infinity;
    for (let i = 0; i < this.colors.length; i++) {
      const dl = L - this.labs[i * 3], da = A - this.labs[i * 3 + 1], db = B - this.labs[i * 3 + 2];
      const d = dl * dl * 1.4 + da * da + db * db;
      if (d < bestD) { bestD = d; best = i; }
    }
    this.lut[key] = best;
    return best;
  }
}

/** Lighten / darken a hex colour by `amt` (-1..1), for stud highlights. */
export function shade(c: LiveColor, amt: number): string {
  const f = (v: number) => Math.round(amt >= 0 ? v + (255 - v) * amt : v * (1 + amt));
  return `rgb(${f(c.r)},${f(c.g)},${f(c.b)})`;
}
