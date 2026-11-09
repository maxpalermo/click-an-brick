// "Model size" choice made on the Confirm screen, before converting (both modes), and how it becomes converter
// options. LEGO mode: Real size (exact from a marked 2x2 brick, else the AI's stud count: no size is passed and the
// converter uses PhotoAnalysis.brickSize), Medium ~32, Small ~20, Custom. Object mode: Small 16, Medium 24,
// Large 40, Custom (+ Real size once a 2x2 brick is marked).
import type { PhotoAnalysis } from '../convert/contracts';
import type { ConvertResult, PhotoMode } from '../types';
import { brickSizeUsable } from '../convert/sizeRules';
import type { Bounds } from './glb';
import { MAX_STUDS, MIN_STUDS, STUD_LDU, clampStuds, convertScale, estimateSize, type Measure, type ScaleChoice } from './scale';

export type SizePreset = 'real' | 'small' | 'medium' | 'large' | 'custom';

export interface SizeChoice {
  preset: SizePreset;
  /** Longest side in studs for 'custom' (also remembered while another preset is picked). */
  studs: number;
}

export interface PresetInfo {
  id: SizePreset;
  label: string;
  /** Longest side in studs; absent for 'real' (comes from the brick / the AI). */
  studs?: number;
}

const LEGO_PRESETS: PresetInfo[] = [
  { id: 'real', label: 'Real size' },
  { id: 'medium', label: 'Medium', studs: 32 },
  { id: 'small', label: 'Small', studs: 20 },
  { id: 'custom', label: 'Custom' },
];
const OBJECT_PRESETS: PresetInfo[] = [
  { id: 'small', label: 'Small', studs: 16 },
  { id: 'medium', label: 'Medium', studs: 24 },
  { id: 'large', label: 'Large', studs: 40 },
  { id: 'custom', label: 'Custom' },
];

/** Presets offered for a mode. Object mode gets "Real size" only once a 2x2 brick is marked. */
export function presetsFor(mode: PhotoMode, brickMarked: boolean): PresetInfo[] {
  if (mode === 'lego') return LEGO_PRESETS;
  return brickMarked ? [{ id: 'real', label: 'Real size' }, ...OBJECT_PRESETS] : OBJECT_PRESETS;
}

export function defaultSize(mode: PhotoMode, brickMarked = false): SizeChoice {
  if (mode === 'lego' || brickMarked) return { preset: 'real', studs: 32 };
  return { preset: 'medium', studs: 24 };
}

/** The choice is valid for the mode (object mode cannot keep "Real size" without a brick). */
export function fitChoice(c: SizeChoice, mode: PhotoMode, brickMarked: boolean): SizeChoice {
  if (c.preset === 'real' && mode === 'object' && !brickMarked) return { preset: 'medium', studs: c.studs };
  if (c.preset === 'large' && mode === 'lego') return { preset: 'custom', studs: 40 };
  return c;
}

/**
 * Longest side in studs the choice asks for, when it is known before the build: a stud preset / custom, or real
 * size from a marked brick. null = real size estimated by the AI (only known once the photos are analysed).
 */
export function targetStuds(c: SizeChoice, mode: PhotoMode, m: Measure): number | null {
  if (c.preset === 'custom') return clampStuds(c.studs);
  if (c.preset !== 'real') return presetsFor(mode, false).find((p) => p.id === c.preset)?.studs ?? 24;
  const e = estimateSize(m);
  if (!e.lifeSize) return null;
  return Math.max(MIN_STUDS, Math.round(Math.max(e.widthLdu, e.heightLdu) / STUD_LDU));
}

/** Sizes above this get a "may be slow on a phone" warning. */
export const PHONE_WARN_STUDS = 48;

/**
 * Rough part count for a model whose longest side is `studs` (balanced detail): parts ≈ 0.9 · n^2.05, fitted to
 * research/photo2brick/approx/report.md (16 → 218, 24 → 519, 32 → 992, 40 → 1,599). Shapes vary a lot, so a
 * range: ×0.6 (slim or hollow) to ×1.6 (bulky); above PHONE_WARN_STUDS bulky models grow faster (a solid 80-stud
 * test model made 12.7k parts), so the top of the range is ×2.2 there.
 */
export function partRange(studs: number): [number, number] {
  const n = Math.min(MAX_STUDS, Math.max(1, studs));
  const mid = 0.9 * Math.pow(n, 2.05);
  return [roundNice(mid * 0.6), roundNice(mid * (n > PHONE_WARN_STUDS ? 2.2 : 1.6))];
}

const roundNice = (v: number) => (v < 100 ? Math.round(v / 10) * 10 : v < 1000 ? Math.round(v / 50) * 50 : Math.round(v / 100) * 100);

export const fmtParts = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1).replace(/\.0$/, '')}k` : String(n));

/** Where the size of a build came from (shown on the Result screen). */
export type SizeSource = 'reference' | 'ai' | 'choice' | 'default';

export const SIZE_SOURCE_LABEL: Record<SizeSource, string> = {
  reference: 'from your 2×2 brick',
  ai: 'estimated by AI from the studs',
  choice: 'your choice',
  default: 'standard size (the AI could not count the studs)',
};

/** The converter accepts sizeStuds up to MAX_STUDS. */
const SIZE_STUDS_LIMIT = MAX_STUDS;

/**
 * Converter scale options for the choice. Real size: the measured scale from the brick (lduPerUnit), or in LEGO mode
 * without a brick no size at all, so the converter scales to the vision's stud count (PhotoAnalysis.brickSize).
 */
export function scaleForChoice(c: SizeChoice, mode: PhotoMode, m: Measure, bounds: Bounds | null): ScaleChoice {
  if (c.preset === 'real') {
    if (estimateSize(m).lifeSize || mode === 'object') return convertScale(m, bounds);
    return { options: {}, capped: false };
  }
  return studsScale(targetStuds(c, mode, m) ?? 24, bounds);
}

/** A longest side in studs as converter options (lduPerUnit above the converter's sizeStuds limit). */
export function studsScale(studs: number, bounds: Bounds | null): ScaleChoice {
  const n = clampStuds(studs);
  if (n > SIZE_STUDS_LIMIT && bounds) {
    const ext = Math.max(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]);
    if (ext > 0) return { options: { lduPerUnit: (n * STUD_LDU) / ext }, capped: studs > MAX_STUDS };
  }
  return { options: { sizeStuds: Math.min(n, SIZE_STUDS_LIMIT) }, capped: studs > MAX_STUDS };
}

/** Where the size of a converted result came from. Prefers the converter's own report (stats.sizeSource) when present. */
export function sizeSourceOf(c: SizeChoice, m: Measure, analysis: PhotoAnalysis | undefined, result?: ConvertResult): SizeSource {
  if (c.preset !== 'real') return 'choice';
  if (estimateSize(m).lifeSize) return 'reference';
  const reported = (result?.stats as { sizeSource?: string } | undefined)?.sizeSource;
  if (reported === 'vision') return 'ai';
  if (reported === 'default') return 'default';
  if (reported === 'user') return 'choice';
  return brickSizeUsable(analysis?.brickSize) ? 'ai' : 'default';
}
