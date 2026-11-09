// Colour science for brick colour matching: sRGB <-> linear, OKLab, CIELAB + CIEDE2000, and the
// curated palette of common solid LEGO colours (ported from research/photo2brick/src/color.ts).

import type { BrickColor } from '../../model/types';

export const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
export const linearToSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

/** 8-bit sRGB -> linear lookup (texture sampling hot path). */
export const SRGB8_TO_LINEAR = (() => {
  const t = new Float32Array(256);
  for (let i = 0; i < 256; i++) t[i] = srgbToLinear(i / 255);
  return t;
})();

export type Lab = [number, number, number];

/** Linear RGB (0..1) -> OKLab. */
export function linearToOklab(r: number, g: number, b: number): Lab {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** Linear RGB (0..1) -> CIELAB (D65). */
export function linearToCielab(r: number, g: number, b: number): Lab {
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  const fx = f(x), fy = f(y), fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIEDE2000 colour difference (Sharma et al. 2005). */
export function ciede2000(l1: Lab, l2: Lab): number {
  const [L1, a1, b1] = l1, [L2, a2, b2] = l2;
  const rad = Math.PI / 180;
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2);
  const Cb = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1, a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  const h = (b: number, a: number) => { if (b === 0 && a === 0) return 0; const t = Math.atan2(b, a) / rad; return t < 0 ? t + 360 : t; };
  const h1p = h(b1, a1p), h2p = h(b2, a2p);
  const dLp = L2 - L1, dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) { dhp = h2p - h1p; if (dhp > 180) dhp -= 360; else if (dhp < -180) dhp += 360; }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * rad);
  const Lbp = (L1 + L2) / 2, Cbp = (C1p + C2p) / 2;
  let hbp = h1p + h2p;
  if (C1p * C2p !== 0) { if (Math.abs(h1p - h2p) > 180) hbp += h1p + h2p < 360 ? 360 : -360; hbp /= 2; }
  const T = 1 - 0.17 * Math.cos((hbp - 30) * rad) + 0.24 * Math.cos(2 * hbp * rad) + 0.32 * Math.cos((3 * hbp + 6) * rad) - 0.2 * Math.cos((4 * hbp - 63) * rad);
  const dTheta = 30 * Math.exp(-(((hbp - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lbp - 50) ** 2) / Math.sqrt(20 + (Lbp - 50) ** 2);
  const Sc = 1 + 0.045 * Cbp, Sh = 1 + 0.015 * Cbp * T;
  const Rt = -Math.sin(2 * dTheta * rad) * Rc;
  return Math.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh));
}

export interface PaletteColor { code: number; name: string; hex: string }

/**
 * Solid colours widely available in basic bricks AND plates today (BrickLink / Pick a Brick), as LDraw
 * codes with their LDConfig values (used when the provided colour list lacks them). Doc §4.7.
 */
export const COMMON_COLORS: PaletteColor[] = [
  { code: 0, name: 'Black', hex: '#1B2A34' }, { code: 1, name: 'Blue', hex: '#1E5AA8' },
  { code: 2, name: 'Green', hex: '#00852B' }, { code: 4, name: 'Red', hex: '#B40000' },
  { code: 14, name: 'Yellow', hex: '#FAC80A' }, { code: 15, name: 'White', hex: '#F4F4F4' },
  { code: 19, name: 'Tan', hex: '#D7BA8C' }, { code: 25, name: 'Orange', hex: '#D67923' },
  { code: 27, name: 'Lime', hex: '#A5CA18' }, { code: 28, name: 'Dark Tan', hex: '#897D62' },
  { code: 70, name: 'Reddish Brown', hex: '#5F3109' }, { code: 71, name: 'Light Bluish Grey', hex: '#969696' },
  { code: 72, name: 'Dark Bluish Grey', hex: '#646464' }, { code: 73, name: 'Medium Blue', hex: '#7396C8' },
  { code: 78, name: 'Light Nougat', hex: '#FFC995' }, { code: 84, name: 'Medium Nougat', hex: '#AA7D55' },
  { code: 191, name: 'Bright Light Orange', hex: '#FCAC00' }, { code: 212, name: 'Bright Light Blue', hex: '#9DC3F7' },
  { code: 226, name: 'Bright Light Yellow', hex: '#FFEC6C' }, { code: 272, name: 'Dark Blue', hex: '#19325A' },
  { code: 288, name: 'Dark Green', hex: '#00451A' }, { code: 308, name: 'Dark Brown', hex: '#352100' },
  { code: 320, name: 'Dark Red', hex: '#720012' }, { code: 321, name: 'Dark Azure', hex: '#469BC3' },
  { code: 322, name: 'Medium Azure', hex: '#68C3E2' }, { code: 326, name: 'Yellowish Green', hex: '#E2F99A' },
  { code: 378, name: 'Sand Green', hex: '#708E7C' }, { code: 379, name: 'Sand Blue', hex: '#70819A' },
  { code: 29, name: 'Bright Pink', hex: '#FF9ECD' }, { code: 5, name: 'Dark Pink', hex: '#D3359D' },
  { code: 26, name: 'Magenta', hex: '#901F76' }, { code: 30, name: 'Medium Lavender', hex: '#A06EB9' },
  { code: 31, name: 'Lavender', hex: '#CDA4DE' }, { code: 92, name: 'Nougat', hex: '#BB805A' },
];
export const COMMON_COLOR_CODES = COMMON_COLORS.map((c) => c.code);

const HEX = /^#[0-9a-f]{6}$/i;

/**
 * The palette the converter may use: the curated common colours that are present in `colors` as opaque
 * solids (hex taken from `colors`). Falls back to the built-in values when `colors` is empty.
 */
export function buildPalette(colors: BrickColor[], codes: number[] = COMMON_COLOR_CODES): PaletteColor[] {
  if (!colors.length) return COMMON_COLORS.filter((c) => codes.includes(c.code));
  const out: PaletteColor[] = [];
  for (const code of codes) {
    const c = colors.find((x) => x.code === code);
    if (!c || !HEX.test(c.hex)) continue;
    if ((c.alpha ?? 255) < 255) continue;
    if (c.material && c.material !== 'solid') continue;
    out.push({ code: c.code, name: c.name, hex: c.hex });
  }
  return out.length ? out : COMMON_COLORS.filter((c) => codes.includes(c.code));
}

export type ColorMetric = 'ciede2000' | 'oklab';

/** Nearest palette colour with a 6-bit-per-channel LUT (262k entries, filled lazily). */
/**
 * Palette Lab values + match lookup table per (metric, palette): the table is deterministic, so matchers built again and
 * again for the same palette (the special-parts module builds one per cell) share it instead of allocating 512 KB each.
 */
const MATCHER_CACHE = new Map<string, { labs: Lab[]; lut: Int16Array }>();
const MATCHER_CACHE_MAX = 16;

export class ColorMatcher {
  private labs: Lab[];
  private lut: Int16Array;
  constructor(readonly palette: PaletteColor[], readonly metric: ColorMetric = 'ciede2000') {
    const key = `${metric}|${palette.map((p) => p.hex).join(',')}`;
    let c = MATCHER_CACHE.get(key);
    if (!c) {
      if (MATCHER_CACHE.size >= MATCHER_CACHE_MAX) MATCHER_CACHE.delete(MATCHER_CACHE.keys().next().value!);
      c = { labs: palette.map((p) => this.toLab(...hexToLinear(p.hex))), lut: new Int16Array(1 << 18).fill(-1) };
      MATCHER_CACHE.set(key, c);
    }
    this.labs = c.labs;
    this.lut = c.lut;
  }
  private toLab(r: number, g: number, b: number): Lab {
    return this.metric === 'oklab' ? linearToOklab(r, g, b) : linearToCielab(r, g, b);
  }
  /** Linear RGB in, palette index out. */
  match(r: number, g: number, b: number): number {
    const q = (v: number) => Math.min(63, Math.max(0, Math.round(linearToSrgb(v) * 63)));
    const key = (q(r) << 12) | (q(g) << 6) | q(b);
    const hit = this.lut[key];
    if (hit >= 0) return hit;
    const lab = this.toLab(srgbToLinear(q(r) / 63), srgbToLinear(q(g) / 63), srgbToLinear(q(b) / 63));
    let best = 0, bestD = Infinity;
    for (let i = 0; i < this.labs.length; i++) {
      const t = this.labs[i];
      const d = this.metric === 'oklab' ? (lab[0] - t[0]) ** 2 + (lab[1] - t[1]) ** 2 + (lab[2] - t[2]) ** 2 : ciede2000(lab, t);
      if (d < bestD) { bestD = d; best = i; }
    }
    this.lut[key] = best;
    return best;
  }
}

export function hexToLinear(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [srgbToLinear(((n >> 16) & 255) / 255), srgbToLinear(((n >> 8) & 255) / 255), srgbToLinear((n & 255) / 255)];
}

/** OKLab -> linear RGB (0..1, unclamped). */
export function oklabToLinear(L: number, a: number, b: number): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/**
 * The LEGO colours a builder reaches for first (every basic brick and plate exists in them, cheap in bulk). The
 * de-lighting stage (delight.ts) prefers them when a region's colour is about as close to a rarer one.
 */
export const CORE_COLOR_CODES = new Set([0, 1, 2, 4, 14, 15, 19, 25, 28, 70, 71, 72, 73, 191, 212, 226, 272, 288, 320, 321, 322, 308]);
